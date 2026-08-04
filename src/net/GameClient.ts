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
  decodeRoomState,
  decodeSnapshot,
  decodeWelcome,
  encodeCommands,
  encodeFire,
  encodeReload,
  encodeSelectWeapon,
  encodeSetVisualDial,
  packetTypeOf,
  quantiseCommand,
  wrapPi,
  type RoomState,
} from "./SnapshotCodec.ts";
import type { ClientTransport } from "./Transport.ts";

export interface RemotePlayer {
  readonly id: number;
  /** Interpolated presentation pose. Never authoritative. */
  readonly position: Vec3;
  /** Interpolated presentation yaw; the wire target is `state.yawRadians`. */
  yawRadians: number;
  state: MotorState;
  /** Server-owned hit points. 0 is dead — this is what will drive a death clip. */
  health: number;
}

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
  /** Own shot counter, echoed in each claim so a resend cannot fire twice. */
  private fireSequence = 0;
  /** Own weapon-claim counter, shared by select and reload for the same reason. */
  private weaponSequence = 0;
  /**
   * Server tick of the last snapshot applied — what remote players on screen
   * are currently showing, since remotes chase the latest snapshot. Sent with
   * each fire claim as the lag-compensation rewind target.
   */
  private lastSnapshotTick = 0;

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
        // What the shooter was looking at: remotes render the latest applied
        // snapshot, so its tick is the honest rewind target.
        viewTick: this.lastSnapshotTick,
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
    if (type !== PacketType.Snapshot) return;

    const snapshot = decodeSnapshot(bytes);
    this.lastSnapshotTick = snapshot.tick;
    for (const player of snapshot.players) {
      if (player.id === this.playerId) {
        this.health = player.health;
        this.reconcile(player.state, snapshot.acknowledgedCommandTick);
        continue;
      }
      const existing = this.remotes.get(player.id);
      if (existing === undefined) {
        this.remotes.set(player.id, {
          id: player.id,
          position: { ...player.state.position },
          yawRadians: player.state.yawRadians,
          state: player.state,
          health: player.health,
        });
      } else {
        existing.state = player.state;
        existing.health = player.health;
      }
    }

    const present = new Set(snapshot.players.map((player) => player.id));
    for (const id of this.remotes.keys()) {
      if (!present.has(id)) this.remotes.delete(id);
    }
  }

  /**
   * Moves remote players toward their last authoritative position. Called from
   * the render loop with the frame delta, not from the fixed tick, because it
   * is presentation.
   */
  interpolateRemotes(deltaSeconds: number, rate = 12): void {
    const blend = 1 - Math.exp(-rate * Math.max(0, deltaSeconds));
    for (const remote of this.remotes.values()) {
      remote.position.x += (remote.state.position.x - remote.position.x) * blend;
      remote.position.y += (remote.state.position.y - remote.position.y) * blend;
      remote.position.z += (remote.state.position.z - remote.position.z) * blend;
      // Wire yaw snaps at the patch rate; shortest-arc so a 350°-to-10° turn
      // does not spin the long way round.
      remote.yawRadians += wrapPi(remote.state.yawRadians - remote.yawRadians) * blend;
    }
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
    this.transport.close();
    this.room.dispose();
  }
}
