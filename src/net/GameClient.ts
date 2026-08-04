// Client prediction with snapshot reconciliation.
//
// The authority model §2 settled on: predict locally, correct continuously from
// authoritative snapshots, never assume bitwise agreement. When a snapshot
// arrives the local player is rewound to the server's state at the acknowledged
// command and every unacknowledged command is replayed, so a correction costs
// the player no input.
//
// Remote players are not simulated. They are interpolated between the last two
// snapshots, which is why the client room only ever holds one motor.

import type RAPIER from "@dimforge/rapier3d-compat";
import { MotorRoom } from "../motor/MotorRoom.ts";
import {
  DEFAULT_MOTOR_TUNING,
  type MotorHeightSource,
  type MotorState,
  type MotorTuning,
  type PlayerCommand,
  type Vec3,
} from "../motor/MotorTypes.ts";
import {
  PacketType,
  decodeDamageTaken,
  decodeHitConfirmed,
  decodePlayerDied,
  decodeRoomState,
  decodeRoster,
  decodeShotFired,
  decodeSnapshot,
  decodeWelcome,
  decodeWorldTargets,
  encodeCommands,
  encodeFire,
  encodeReload,
  encodeSelectWeapon,
  encodeSetVisualDial,
  packetTypeOf,
  quantiseCommand,
  wrapPi,
  type DamageTakenEvent,
  type HitConfirmedEvent,
  type PlayerDiedEvent,
  type RoomState,
  type RosterEntry,
  type ShotFiredEvent,
  type WorldTargetState,
} from "./SnapshotCodec.ts";
import type { ClientTransport } from "./Transport.ts";
import { clamp, lerp } from "../combat/math.ts";

/**
 * One thing that happened, for presentation.
 *
 * A tagged union rather than three parallel logs: readers overwhelmingly want
 * them interleaved in the order they arrived — the feed prints deaths in
 * sequence, and a hitmarker that fired before a kill confirmation should stay
 * before it. `seq` is monotonic per client so a reader can resume from what it
 * last handled rather than draining and starving the other readers.
 */
export type CombatEvent =
  | ({ readonly kind: "died"; readonly seq: number } & PlayerDiedEvent)
  | ({ readonly kind: "hit"; readonly seq: number } & HitConfirmedEvent)
  | ({ readonly kind: "damage"; readonly seq: number } & DamageTakenEvent);

/**
 * How many combat events a client holds before dropping the oldest.
 *
 * Sized for what an unread client can afford rather than what a reader needs: a
 * hidden tab still receives every death in a 64-player room, and the feed only
 * ever shows a handful.
 */
const MAX_COMBAT_EVENTS = 64;

export interface RemotePlayer {
  readonly id: number;
  /** Interpolated presentation pose. Never authoritative. */
  readonly position: Vec3;
  /** Interpolated presentation yaw; mirrors `state.yawRadians`. */
  yawRadians: number;
  /**
   * The INTERPOLATED state this client is rendering — a fixed interval in the
   * past, blended between the two snapshots that bracket the render clock
   * (Gambetta part III). Presentation reads it directly, which is what keeps
   * pitch, stance blend and velocity as smooth as position. It is a mutable
   * copy owned by this client; the authoritative snapshots live in the buffer.
   */
  state: MotorState;
  /** Server-owned hit points. 0 is dead — this is what will drive a death clip.
   * LATEST, never interpolated: damage feedback must not lag the render clock. */
  health: number;
}

/** One authoritative snapshot of one remote, as decoded off the wire. */
interface BufferedRemoteState {
  readonly tick: number;
  readonly state: MotorState;
}

/** Snapshots retained per remote. Covers the render delay plus slew margin. */
const REMOTE_BUFFER_LENGTH = 5;
/**
 * How far in the past remotes render, in snapshot intervals. Two intervals
 * (100 ms at the default 20 Hz patch rate) is the classic choice: one interval
 * of headroom means a single late packet extrapolates; two means it still has
 * a real pair to interpolate between. Rides comfortably inside the server's
 * 250 ms rewind cap.
 */
const INTERPOLATION_DELAY_INTERVALS = 2;
/** Per-second fraction of clock error corrected by slewing instead of snapping. */
const RENDER_CLOCK_SLEW_RATE = 3;

export interface GameClientOptions {
  readonly tuning?: MotorTuning;
  /**
   * Snap rather than replay when the server disagrees by more than this. Large
   * disagreement means a teleport or a lost connection, not float drift.
   */
  readonly hardSnapMetres?: number;
  /** Commands retained for replay. Covers the worst round trip worth serving. */
  readonly commandHistory?: number;
}

const DEFAULT_HARD_SNAP_METRES = 4;
const DEFAULT_COMMAND_HISTORY = 180;

export class GameClient {
  readonly room: MotorRoom;
  /** Server-assigned id, or -1 before the welcome packet arrives. */
  playerId = -1;
  tick = 0;

  /**
   * Telemetry for §7.3. Two different quantities, and conflating them hides
   * the interesting one:
   *
   * - DRIFT is how far the client's prediction had strayed from authority when
   *   a snapshot arrived. This is the cross-runtime divergence measurement.
   * - CORRECTION is how far the player actually moved as a result, after
   *   replaying unacknowledged commands. This is what a player can feel.
   */
  /** Snapshots reconciled against. On a zero-latency link this runs with an
   * empty replay queue, so it — not `replayedCommands` — is what proves the
   * path executed at all. */
  reconciles = 0;
  corrections = 0;
  lastDriftMetres = 0;
  worstDriftMetres = 0;
  lastCorrectionMetres = 0;
  worstCorrectionMetres = 0;
  replayedCommands = 0;
  /** The transport dropped. Prediction keeps running locally; sends stay gated. */
  connectionLost = false;

  /**
   * The local player's hit points, as the server last reported them.
   *
   * NOT PREDICTED, and deliberately so. Prediction exists for things a client can
   * derive from its own inputs; whether somebody else's round arrived is not one of
   * them, and a mispredicted death is the worst correction in a shooter. This lags
   * by up to one patch and is always the truth.
   */
  health = 0;
  /**
   * Full health for this room, from the welcome packet.
   *
   * The denominator the HUD reads `health` against. Sent once per join rather
   * than per tick because it is a room constant; 100 until the welcome lands, so
   * a fraction computed in the gap is merely stale rather than infinite.
   */
  maxHealth = 100;
  /** Own shot counter, echoed in each claim so a resend cannot fire twice. */
  private fireSequence = 0;
  /** Own weapon-claim counter, shared by select and reload for the same reason. */
  private weaponSequence = 0;
  /** Server tick of the last snapshot applied. Anchor for the render clock. */
  private lastSnapshotTick = 0;
  /**
   * The remote render clock, in fractional SERVER ticks: the moment in the
   * room's past this client is currently drawing. Advanced by wall-clock time
   * each frame and slewed toward (latest snapshot − interpolation delay), so
   * remotes move at their true speed instead of chasing packets. −1 until the
   * first `interpolateRemotes` — a headless client falls back to the raw
   * snapshot tick when it fires.
   */
  private renderClock = -1;
  /** Measured gap between the last two snapshots, in server ticks. */
  private snapshotIntervalTicks = 3;
  /** Authoritative snapshot history per remote, newest last. */
  private readonly remoteBuffers = new Map<number, BufferedRemoteState[]>();

  /**
   * The room's weather and dials, or null until the server has said.
   *
   * Null rather than a default value, and that distinction is visible: a client
   * that joined with `?weather=moody` would otherwise snap to neutral daylight for
   * the packet's flight time and then back again.
   *
   * REPLACED WHOLESALE, never mutated, which is what makes it a valid snapshot for
   * `useSyncExternalStore`: identity changes exactly when the content does, so a
   * consumer can compare references and a holder cannot be surprised by the object
   * it already read changing underneath it.
   */
  private roomStateValue: RoomState | null = null;
  private readonly roomStateListeners = new Set<() => void>();
  /**
   * Other players' accepted shots, queued for presentation. Bounded: a client
   * that never drains (headless, hidden tab) must not grow a battle's worth of
   * theatre it will never play.
   */
  private readonly remoteShotQueue: ShotFiredEvent[] = [];
  /**
   * The room's world targets, or null until the server has said. Replaced
   * wholesale like room state, and for the same `useSyncExternalStore` reason.
   */
  private worldTargetsValue: readonly WorldTargetState[] | null = null;
  private readonly worldTargetListeners = new Set<() => void>();
  private readonly healthListeners = new Set<() => void>();

  /**
   * Who is in the room and what they are called. Empty until the first roster.
   *
   * Replaced wholesale, never mutated, for the same `useSyncExternalStore` reason
   * room state is: identity changes exactly when the content does.
   */
  private rosterValue: readonly RosterEntry[] = [];
  private readonly rosterListeners = new Set<() => void>();

  /**
   * Deaths, hits and damage, newest last, BOUNDED.
   *
   * A log rather than a drain, because these have more than one reader and a
   * drain gives the whole batch to whoever asks first: a death has to reach the
   * character animator, the kill feed and the death overlay, and the first of
   * those to drain would starve the other two. Each reader remembers the last
   * `seq` it handled instead.
   *
   * Replaced wholesale on change so `useSyncExternalStore` sees a new identity.
   * Events are rare — nobody dies sixty times a second — so the allocation is
   * cheaper than the bookkeeping that would avoid it.
   */
  private combatEventsValue: readonly CombatEvent[] = [];
  private readonly combatEventListeners = new Set<() => void>();
  /** Monotonic, so a reader can resume from what it last saw. Never reset. */
  private nextCombatEventSeq = 1;

  /**
   * Subscribe / getSnapshot rather than a single callback field, following
   * `CombatTelemetry`. A lone assignable handler is a trap here: room state has
   * more than one interested reader — the weather panel today, a HUD line or the
   * concealment reader tomorrow — and the second one to arrive would silently
   * unsubscribe the first, which reads as "the sky stopped changing" with no error.
   * Arrow properties so they can be passed straight to a React hook.
   */
  readonly subscribeRoomState = (listener: () => void): (() => void) => {
    this.roomStateListeners.add(listener);
    return () => this.roomStateListeners.delete(listener);
  };

  readonly getRoomState = (): RoomState | null => this.roomStateValue;

  readonly subscribeWorldTargets = (listener: () => void): (() => void) => {
    this.worldTargetListeners.add(listener);
    return () => this.worldTargetListeners.delete(listener);
  };

  /**
   * The local player's hit points, for a React reader.
   *
   * The same subscribe / getSnapshot shape as room state and world targets, and
   * for the same reason: more than one surface wants this — the vitals bar today,
   * a damage indicator and a death overlay next — and a single assignable callback
   * would let the second reader silently unsubscribe the first.
   *
   * A NUMBER rather than an object, deliberately. `useSyncExternalStore` compares
   * what getSnapshot returns; a fresh object every call is an infinite render loop,
   * and a primitive cannot be one. Listeners fire only when the value actually
   * changed, so a 20 Hz snapshot stream does not wake React 20 times a second to
   * report the same hit points.
   */
  readonly subscribeHealth = (listener: () => void): (() => void) => {
    this.healthListeners.add(listener);
    return () => this.healthListeners.delete(listener);
  };

  readonly getHealth = (): number => this.health;

  readonly getWorldTargets = (): readonly WorldTargetState[] | null =>
    this.worldTargetsValue;

  readonly subscribeRoster = (listener: () => void): (() => void) => {
    this.rosterListeners.add(listener);
    return () => this.rosterListeners.delete(listener);
  };

  readonly getRoster = (): readonly RosterEntry[] => this.rosterValue;

  /** The display name for a player id, or null when the roster has not said. */
  nameOf(playerId: number): string | null {
    return this.rosterValue.find((entry) => entry.id === playerId)?.name ?? null;
  }

  readonly subscribeCombatEvents = (listener: () => void): (() => void) => {
    this.combatEventListeners.add(listener);
    return () => this.combatEventListeners.delete(listener);
  };

  readonly getCombatEvents = (): readonly CombatEvent[] => this.combatEventsValue;

  /** Hands each queued remote shot to presentation, exactly once. */
  drainRemoteShots(visitor: (shot: ShotFiredEvent) => void): void {
    for (const shot of this.remoteShotQueue) visitor(shot);
    this.remoteShotQueue.length = 0;
  }

  /**
   * Appends a combat event, stamps it, and drops the oldest past the bound.
   *
   * The bound is what a client that never reads can afford to hold, not what a
   * reader is expected to keep up with: a hidden tab still receives every death
   * in the room and must not accumulate a match's worth of them.
   */
  private pushCombatEvent(event: Omit<CombatEvent, "seq">): void {
    const stamped = { ...event, seq: this.nextCombatEventSeq } as CombatEvent;
    this.nextCombatEventSeq += 1;
    const next = [...this.combatEventsValue, stamped];
    this.combatEventsValue = next.length > MAX_COMBAT_EVENTS ? next.slice(-MAX_COMBAT_EVENTS) : next;
    for (const listener of this.combatEventListeners) listener();
  }

  /** Public so a UI host can adopt the client's tuning instead of its own —
   * a client tuned differently from the server reconciles every tick. */
  readonly tuning: MotorTuning;

  private readonly transport: ClientTransport;
  private readonly hardSnapMetres: number;
  private readonly commandHistory: number;
  private readonly unacknowledged: PlayerCommand[] = [];
  private readonly remotes = new Map<number, RemotePlayer>();
  private localId: string | null = null;

  constructor(
    rapier: typeof RAPIER,
    world: RAPIER.World,
    heightSource: MotorHeightSource,
    transport: ClientTransport,
    options: GameClientOptions = {}
  ) {
    this.transport = transport;
    this.tuning = options.tuning ?? DEFAULT_MOTOR_TUNING;
    this.hardSnapMetres = options.hardSnapMetres ?? DEFAULT_HARD_SNAP_METRES;
    this.commandHistory = options.commandHistory ?? DEFAULT_COMMAND_HISTORY;
    this.room = new MotorRoom(rapier, world, heightSource, { tuning: this.tuning });

    transport.onMessage((bytes) => this.receive(bytes));
    transport.onClose(() => {
      this.connectionLost = true;
    });
  }

  get localState(): MotorState | null {
    return this.localId === null ? null : (this.room.get(this.localId)?.state ?? null);
  }

  /** Connection phase for a UI. The inputs live here, so the mapping does too. */
  get phase(): "connecting" | "playing" | "dropped" {
    if (this.connectionLost) return "dropped";
    return this.playerId < 0 ? "connecting" : "playing";
  }

  get remotePlayers(): IterableIterator<RemotePlayer> {
    return this.remotes.values();
  }

  /**
   * Runs one predicted tick from raw input and sends it. The command is
   * quantised BEFORE prediction so the client simulates exactly what the
   * server will read; skipping that makes every single tick reconcile.
   */
  predict(buttons: number, yawRadians: number, pitchRadians: number): MotorState | null {
    if (this.localId === null) return null;
    const command = quantiseCommand({
      tick: this.tick,
      buttons,
      yawRadians,
      pitchRadians,
    });
    this.tick += 1;

    this.unacknowledged.push(command);
    while (this.unacknowledged.length > this.commandHistory) this.unacknowledged.shift();

    const commands = new Map<string, PlayerCommand>([[this.localId, command]]);
    this.room.step(commands);

    if (this.transport.connected) {
      // Resending the unacknowledged tail is the loss tolerance: a dropped
      // packet costs latency, not a missing input.
      this.transport.send(encodeCommands(this.unacknowledged.slice(-12)));
    }
    return this.localState;
  }

  /**
   * Asks the server to change a room dial. An ASK, not a set: the value that lands
   * is whatever comes back in the next `VisualDials` packet, clamped by the server.
   * Nothing is applied locally here, so a refused write shows as a slider that does
   * not move rather than as a client and server that disagree.
   */
  setVisualDial(id: number, value: number): void {
    if (!this.transport.connected) return;
    this.transport.send(encodeSetVisualDial(id, value));
  }

  /**
   * Tells the server this client fired, and along which direction.
   *
   * INTENT ONLY. The origin is not sent — the server uses the eye position its own
   * simulation holds, so there is nowhere to put a spoofed one — and the direction
   * is clamped server-side against the look angles it already has. Nothing about the
   * outcome is decided here: damage arrives in a later snapshot, or not at all.
   *
   * Local impact effects and tracers stay client-side presentation and are unchanged;
   * this is only what makes another player's health fall.
   */
  fire(yawRadians: number, pitchRadians: number): void {
    if (this.localId === null || !this.transport.connected) return;
    this.fireSequence += 1;
    this.transport.send(
      encodeFire({
        tick: this.tick,
        sequence: this.fireSequence,
        yawRadians,
        pitchRadians,
        // What the shooter was looking at: the render clock's tick — remotes
        // are drawn interpolated at exactly this moment in the room's past, so
        // the server's rewind restores the world the shooter's pixels showed.
        viewTick: this.renderTick,
      })
    );
  }

  /**
   * Tells the server which weapon is now in hand. A CLAIM the server re-times
   * with its own switch delay — damage keys off the server's record, so a
   * client that skips this simply keeps firing its old gun's ballistics.
   */
  selectWeapon(weaponIndex: number): void {
    if (this.localId === null || !this.transport.connected) return;
    this.weaponSequence += 1;
    this.transport.send(
      encodeSelectWeapon({ sequence: this.weaponSequence, weaponIndex })
    );
  }

  /** Tells the server a reload started; rounds move on the server's timer. */
  reload(): void {
    if (this.localId === null || !this.transport.connected) return;
    this.weaponSequence += 1;
    this.transport.send(encodeReload(this.weaponSequence));
  }

  private receive(bytes: Uint8Array): void {
    const type = packetTypeOf(bytes);
    if (type === PacketType.Welcome) {
      const welcome = decodeWelcome(bytes);
      if (welcome === null) return;
      this.playerId = welcome.playerId;
      this.localId = String(welcome.playerId);
      this.maxHealth = welcome.maxHealth;
      this.room.add(this.localId, welcome.spawn);
      return;
    }
    if (type === PacketType.RoomState) {
      const state = decodeRoomState(bytes);
      if (state === null) return;
      this.roomStateValue = state;
      for (const listener of this.roomStateListeners) listener();
      return;
    }
    if (type === PacketType.Roster) {
      this.rosterValue = decodeRoster(bytes);
      for (const listener of this.rosterListeners) listener();
      return;
    }
    if (type === PacketType.PlayerDied) {
      const died = decodePlayerDied(bytes);
      if (died !== null) this.pushCombatEvent({ kind: "died", ...died });
      return;
    }
    if (type === PacketType.HitConfirmed) {
      const hit = decodeHitConfirmed(bytes);
      if (hit !== null) this.pushCombatEvent({ kind: "hit", ...hit });
      return;
    }
    if (type === PacketType.DamageTaken) {
      const damage = decodeDamageTaken(bytes);
      if (damage !== null) this.pushCombatEvent({ kind: "damage", ...damage });
      return;
    }
    if (type === PacketType.ShotFired) {
      const shot = decodeShotFired(bytes);
      if (shot === null) return;
      if (this.remoteShotQueue.length >= 64) this.remoteShotQueue.shift();
      this.remoteShotQueue.push(shot);
      return;
    }
    if (type === PacketType.WorldTargets) {
      this.worldTargetsValue = decodeWorldTargets(bytes);
      for (const listener of this.worldTargetListeners) listener();
      return;
    }
    if (type !== PacketType.Snapshot) return;

    const snapshot = decodeSnapshot(bytes);
    if (this.lastSnapshotTick > 0 && snapshot.tick > this.lastSnapshotTick) {
      this.snapshotIntervalTicks = clamp(snapshot.tick - this.lastSnapshotTick, 1, 12);
    }
    this.lastSnapshotTick = snapshot.tick;
    for (const player of snapshot.players) {
      if (player.id === this.playerId) {
        // Notified only on a CHANGE. Health arrives in every snapshot and changes
        // in almost none of them, so waking every reader at the patch rate would
        // be 20 wake-ups a second to report the same number.
        if (player.health !== this.health) {
          this.health = player.health;
          for (const listener of this.healthListeners) listener();
        }
        this.reconcile(player.state, snapshot.acknowledgedCommandTick);
        continue;
      }
      const existing = this.remotes.get(player.id);
      if (existing === undefined) {
        const state = cloneMotorState(player.state);
        this.remotes.set(player.id, {
          id: player.id,
          // The SAME object as the interpolated state's position — one fact,
          // two names for consumer convenience, zero per-frame syncing.
          position: state.position,
          yawRadians: state.yawRadians,
          state,
          health: player.health,
        });
      } else {
        // Health is applied NOW; the pose waits in the buffer for the render
        // clock. A hit registers immediately even though the body that took it
        // is drawn a tenth of a second in the past.
        existing.health = player.health;
      }
      const buffer = this.remoteBuffers.get(player.id) ?? [];
      const newest = buffer.at(-1);
      if (newest === undefined || snapshot.tick > newest.tick) {
        buffer.push({ tick: snapshot.tick, state: player.state });
        while (buffer.length > REMOTE_BUFFER_LENGTH) buffer.shift();
      }
      this.remoteBuffers.set(player.id, buffer);
    }

    const present = new Set(snapshot.players.map((player) => player.id));
    for (const id of this.remotes.keys()) {
      if (!present.has(id)) {
        this.remotes.delete(id);
        this.remoteBuffers.delete(id);
      }
    }
  }

  /**
   * Renders remote players a fixed interval IN THE PAST, interpolated between
   * the two authoritative snapshots that bracket the render clock (Gambetta
   * part III; the same contract Source's interp implements). Called from the
   * render loop with the frame delta, not from the fixed tick, because it is
   * presentation.
   *
   * This replaces an exponential chase toward the latest snapshot, which
   * trailed a moving target by ~v·80 ms — more than a capsule radius at a
   * sprint — and, worse, meant the screen never showed a state the server
   * could name. With a render clock, "what the shooter saw" IS a server tick,
   * and `fire()` claims exactly that tick for the lag-compensation rewind.
   *
   * When the clock runs past the newest snapshot (stall, hitch) the remote
   * HOLDS at the newest state rather than extrapolating: dead reckoning is
   * wrong the moment a player changes direction, which in a shooter is
   * exactly when it matters.
   */
  interpolateRemotes(deltaSeconds: number): void {
    if (this.lastSnapshotTick <= 0) return;
    const delayTicks = this.snapshotIntervalTicks * INTERPOLATION_DELAY_INTERVALS;
    const target = this.lastSnapshotTick - delayTicks;
    if (this.renderClock < 0) this.renderClock = target;
    const dt = Math.max(0, deltaSeconds);
    this.renderClock += dt / this.tuning.fixedTimestepSeconds;
    // The clock free-runs on wall time and would drift against the server's;
    // small error slews away invisibly, hopeless error (a long hitch, a debug
    // pause) snaps rather than fast-forwarding through the backlog.
    const error = target - this.renderClock;
    if (Math.abs(error) > delayTicks * 2) {
      this.renderClock = target;
    } else {
      this.renderClock += error * Math.min(1, dt * RENDER_CLOCK_SLEW_RATE);
    }

    for (const remote of this.remotes.values()) {
      const buffer = this.remoteBuffers.get(remote.id);
      if (buffer === undefined || buffer.length === 0) continue;
      this.applyInterpolated(remote, buffer, this.renderClock);
    }
  }

  /** The server tick this client's screen is currently showing for remotes. */
  get renderTick(): number {
    return this.renderClock >= 0 ? Math.max(0, Math.round(this.renderClock)) : this.lastSnapshotTick;
  }

  private applyInterpolated(
    remote: RemotePlayer,
    buffer: readonly BufferedRemoteState[],
    atTick: number
  ): void {
    const state = remote.state;
    const first = buffer[0]!;
    const last = buffer.at(-1)!;
    let from = first;
    let to = last;
    if (atTick <= first.tick) {
      from = to = first;
    } else if (atTick >= last.tick) {
      from = to = last;
    } else {
      for (let index = buffer.length - 2; index >= 0; index -= 1) {
        if (buffer[index]!.tick <= atTick) {
          from = buffer[index]!;
          to = buffer[index + 1]!;
          break;
        }
      }
    }
    const span = to.tick - from.tick;
    const t = span > 0 ? clamp((atTick - from.tick) / span, 0, 1) : 1;

    state.position.x = lerp(from.state.position.x, to.state.position.x, t);
    state.position.y = lerp(from.state.position.y, to.state.position.y, t);
    state.position.z = lerp(from.state.position.z, to.state.position.z, t);
    state.velocity.x = lerp(from.state.velocity.x, to.state.velocity.x, t);
    state.velocity.y = lerp(from.state.velocity.y, to.state.velocity.y, t);
    state.velocity.z = lerp(from.state.velocity.z, to.state.velocity.z, t);
    // Shortest-arc, so a 350°-to-10° turn does not spin the long way round.
    state.yawRadians = from.state.yawRadians + wrapPi(to.state.yawRadians - from.state.yawRadians) * t;
    state.pitchRadians = lerp(from.state.pitchRadians, to.state.pitchRadians, t);
    if (
      from.state.stance === to.state.stance &&
      from.state.previousStance === to.state.previousStance
    ) {
      state.stance = to.state.stance;
      state.previousStance = to.state.previousStance;
      state.stanceProgress = lerp(from.state.stanceProgress, to.state.stanceProgress, t);
    } else {
      // A stance change inside the bracket has no meaningful blend between the
      // two encodings; adopt the newer pair and let its own progress animate.
      state.stance = to.state.stance;
      state.previousStance = to.state.previousStance;
      state.stanceProgress = to.state.stanceProgress;
    }
    state.grounded = to.state.grounded;
    state.sprinting = to.state.sprinting;
    state.aiming = to.state.aiming;
    state.contactFlags = to.state.contactFlags;
    state.tick = Math.round(atTick);
    // `position` aliases state.position; only the scalar needs mirroring.
    remote.yawRadians = state.yawRadians;
  }

  private reconcile(authoritative: MotorState, acknowledgedTick: number): void {
    const motor = this.localId === null ? undefined : this.room.get(this.localId);
    if (motor === undefined) return;

    // Everything the server has already consumed is settled history.
    while (this.unacknowledged.length > 0 && this.unacknowledged[0]!.tick <= acknowledgedTick) {
      this.unacknowledged.shift();
    }

    // COPY, do not alias. `motor.state.position` is mutated in place by the
    // teleport below, so holding the reference makes every after-minus-before
    // measurement read zero and the telemetry silently useless.
    const beforeX = motor.state.position.x;
    const beforeY = motor.state.position.y;
    const beforeZ = motor.state.position.z;
    const drift = Math.hypot(
      beforeX - authoritative.position.x,
      beforeY - authoritative.position.y,
      beforeZ - authoritative.position.z
    );
    this.reconciles += 1;
    this.lastDriftMetres = drift;
    this.worstDriftMetres = Math.max(this.worstDriftMetres, drift);

    motor.teleport(authoritative.position, authoritative.velocity);
    motor.state.stance = authoritative.stance;
    motor.state.previousStance = authoritative.stance;
    motor.state.grounded = authoritative.grounded;

    if (drift > this.hardSnapMetres) {
      // Too far to be float divergence. Accept the server and drop the replay.
      this.unacknowledged.length = 0;
    } else {
      const replay = new Map<string, PlayerCommand>();
      for (const command of this.unacknowledged) {
        replay.set(this.localId!, command);
        this.room.step(replay);
        this.replayedCommands += 1;
      }
    }

    const after = motor.state.position;
    this.lastCorrectionMetres = Math.hypot(
      after.x - beforeX,
      after.y - beforeY,
      after.z - beforeZ
    );
    if (this.lastCorrectionMetres > 1e-4) this.corrections += 1;
    this.worstCorrectionMetres = Math.max(
      this.worstCorrectionMetres,
      this.lastCorrectionMetres
    );
  }

  dispose(): void {
    this.roomStateListeners.clear();
    this.worldTargetListeners.clear();
    this.transport.close();
    this.room.dispose();
  }
}

/** A deep-enough copy: the nested vectors are the only reference fields. */
function cloneMotorState(state: MotorState): MotorState {
  return {
    ...state,
    position: { ...state.position },
    velocity: { ...state.velocity },
  };
}
