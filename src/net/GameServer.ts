// Authoritative room loop.
//
// Owns the only real simulation: it steps one MotorRoom at a fixed tick and
// broadcasts snapshots at its own patch rate, which is deliberately a separate
// number so §7.2's "behaviour as tick and patch rates diverge" is measurable.
//
// Transport agnostic on purpose — it is handed a ServerTransport and never
// learns whether that is WebSocket, WebTransport or an in-process loopback.
// The Node integration test drives it through the same interface a browser does.

import type RAPIER from "@dimforge/rapier3d-compat";
import { MotorRoom } from "../motor/MotorRoom.ts";
import {
  DEFAULT_MOTOR_TUNING,
  blendedStanceDimension,
  eyeHeightFor,
  lookDirection,
  type MotorHeightSource,
  type MotorTuning,
  type PlayerCommand,
} from "../motor/MotorTypes.ts";
import {
  PacketType,
  decodeCommands,
  decodeFire,
  decodeReload,
  decodeSelectWeapon,
  decodeSetVisualDial,
  encodeRoomState,
  encodeShotFired,
  encodeSnapshot,
  encodeWelcome,
  encodeWorldTargets,
  packetTypeOf,
  wrapPi,
  type RoomState,
  type SnapshotPlayer,
  type WorldTargetState,
} from "./SnapshotCodec.ts";
import type { ServerConnection, ServerTransport } from "./Transport.ts";
import { ServerWorldQuery, type CapsuleCandidate } from "./ServerWorldQuery.ts";
import { StateHistory } from "./StateHistory.ts";
import { BallisticProjectileSystem } from "../combat/BallisticProjectileSystem.ts";
import { DEFAULT_BALLISTIC_ENVIRONMENT } from "../combat/BallisticEnvironment.ts";
import {
  hitscanHorizonMetres,
  resolveHitscanShot,
} from "../combat/HitscanBallistics.ts";
import type { Damageable } from "../combat/Damageable.ts";
import type { WeaponDefinition } from "../combat/WeaponDefinition.ts";
import {
  WEAPON_DEFINITIONS,
  WEAPON_SWITCH_SECONDS,
  weaponByWireIndex,
} from "../combat/weaponDefinitions.ts";
import type { BallisticResult } from "../combat/BallisticProjectileSystem.ts";

export interface GameServerOptions {
  readonly tuning?: MotorTuning;
  readonly sharedSurfaceSpanMetres?: number;
  /** Snapshots per second. Independent of the simulation tick rate. */
  readonly patchHz?: number;
  readonly spawn?: (seat: number) => { x: number; y?: number; z: number };
  /**
   * The room's weather, as an index into the presentation side's preset table
   * (`WEATHER_PRESET_IDS` in `src/df2/weather.ts`). Opaque here on purpose: this
   * layer imports nothing from the render side, so it carries the number and
   * never learns which sky it names. Defaults to 0, the neutral daylight preset.
   */
  readonly weatherIndex?: number;
  /**
   * Clamps a dial write, or returns null to reject it — `clampVisualDial` from
   * `src/df2/visualDials.ts`. Injected rather than imported for the same reason
   * `weatherIndex` is a number: the authority layer stays free of the render side.
   *
   * THE FUNCTION, not the range table it reads, because the server clamps on the
   * way in and the presentation side clamps again on the way out. Two copies of
   * that arithmetic diverge the moment either gains a rule — step snapping, a
   * per-dial default — and the only symptom is a slider settling somewhere the
   * room never asked for.
   *
   * Its ABSENCE is also the off switch. A write is refused when there is nothing
   * to check it against, so a server that was not handed this cannot be talked
   * into setting anything: the capability has to be wired on purpose.
   */
  readonly clampVisualDial?: (id: number, value: number) => number | null;
  /**
   * Let connected clients change the room's visual dials.
   *
   * OFF BY DEFAULT, and it must stay that way: a client that can set the room's
   * fog can clear everyone's concealment, which is griefing rather than cheating
   * and is worse for being invisible. A development server opts in; a public one
   * never does. Server-side game code can call `setVisualDial` regardless — this
   * gates the CLIENT path only.
   */
  readonly allowClientVisualDials?: boolean;
  /** Hit points a player spawns with. Rides the snapshot as a u8, so 1-255. */
  readonly maxHealth?: number;
  /** Seconds a dead player stays dead. 0 disables respawn entirely. */
  readonly respawnSeconds?: number;
  /**
   * SERVER-AUTHORED world targets: destructible range figures every player in
   * the room shares. Positions are world x/z; the feet land on the server's
   * own terrain. This exists because the client-side contrast ladder
   * (`TestTargets`) is placed relative to each client's camera and cannot be
   * shared truth — a room target is placed by the room.
   */
  readonly worldTargets?: readonly WorldTargetSpec[];
  /**
   * How far a claimed shot direction may differ from the look angles the server
   * already holds for that tick, in radians.
   *
   * The shot leaves along the weapon's aimed direction after sway, recoil and
   * dispersion, none of which the server simulates — so the claim cannot simply be
   * rejected when it disagrees. Clamping it to a cone around the authoritative look
   * bounds the lie: a client can be wrong by a weapon's worth of spread and cannot
   * shoot behind itself. Full server-side weapon simulation is what would remove
   * this, and it is not built.
   */
  readonly maxAimDeviationRadians?: number;
}

interface Peer {
  readonly connection: ServerConnection;
  readonly roomId: string;
  /** Server-owned hit points. The client is TOLD this, never asked. */
  health: number;
  /** Tick this peer respawns on, or -1 when alive. */
  respawnTick: number;
  /** Highest shot sequence accepted, so a replayed fire packet cannot double-hit. */
  highestFireSequence: number;
  /** Highest weapon claim (select/reload) consumed; same dedupe idea as fire. */
  highestWeaponSequence: number;
  /**
   * SERVER-OWNED loadout. The client's WeaponSystem runs the same rules for
   * prediction and presentation, but what can actually wound somebody is this
   * record: which weapon is in hand, what its magazines hold, and the ticks
   * before which firing is a refused claim rather than a shot.
   */
  weaponIndex: number;
  readonly magazines: number[];
  readonly reserves: number[];
  /**
   * First tick each weapon may fire again — PER WEAPON, like the client's
   * per-WeaponSystem timers, or a sniper shot would lend its 75-tick cooldown
   * to the sidearm the player switches to, refusing a completely legal play.
   */
  readonly nextFireTicks: number[];
  /** Tick a weapon switch completes, or -1 when not switching. */
  switchCompleteTick: number;
  /** Tick the running reload completes, or -1 when not reloading. */
  reloadCompleteTick: number;
  /** The peer's health as a Damageable, for the shared ballistic model. */
  readonly damageable: Damageable;
  /** Commands received but not yet consumed, ordered by tick. */
  readonly queue: PlayerCommand[];
  acknowledgedTick: number;
  /**
   * Highest tick ever accepted into the queue, which is NOT the same as the
   * highest consumed. A client resends its unacknowledged tail, so a command
   * still sitting in the queue arrives again and passes an acknowledged-tick
   * check; without this it is queued twice, the queue grows until the overflow
   * guard discards real input, and the server falls behind for good.
   */
  highestQueuedTick: number;
}

export interface WorldTargetSpec {
  readonly x: number;
  readonly z: number;
  readonly radiusMetres?: number;
  readonly heightMetres?: number;
  readonly maxHealth?: number;
  /** Seconds a destroyed target stays down. 0 keeps it down forever. */
  readonly respawnSeconds?: number;
}

interface ServerTarget {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly radius: number;
  readonly height: number;
  readonly maxHealth: number;
  readonly respawnTicks: number;
  readonly name: string;
  readonly damageable: Damageable;
  health: number;
  /** Tick this target stands back up, or -1 while standing. */
  respawnTick: number;
}

const DEFAULT_PATCH_HZ = 20;
const DEFAULT_MAX_HEALTH = 100;
const DEFAULT_RESPAWN_SECONDS = 3;
/** About 11 degrees: wider than any authored cone, far short of a turn. */
const DEFAULT_MAX_AIM_DEVIATION_RADIANS = 0.2;
/** Beyond this a rifle round is not the thing that killed anybody. */
const MAX_SHOT_DISTANCE_METRES = 1200;
/**
 * How far back a fire claim's viewTick may rewind targets: 250 ms at 60 Hz.
 * Past that the shooter's picture is too stale to honor — the peeker's
 * advantage has to end somewhere, and a quarter second is the genre's answer.
 */
const MAX_REWIND_TICKS = 15;
/** Ring depth for the rewind buffer; a little past the rewind cap. */
const HISTORY_TICKS = 32;
/**
 * One tick of cadence forgiveness. The client's cadence cursor and the server's
 * tick counter quantise differently, and a legitimate shot arriving one tick
 * early must not be eaten — the cost is a sustained fire rate at most one tick
 * per shot faster than authored, which no human trigger can bank.
 */
const CADENCE_TOLERANCE_TICKS = 1;
/** Server projectile pool. Shots in flight, not shots per match. */
const SERVER_PROJECTILE_CAPACITY = 256;
/** World-target ids live far above connection ids; u16 space is shared. */
const WORLD_TARGET_ID_BASE = 40_000;
const DEFAULT_TARGET_RADIUS_METRES = 0.35;
const DEFAULT_TARGET_HEIGHT_METRES = 1.8;
const DEFAULT_TARGET_MAX_HEALTH = 100;
const DEFAULT_TARGET_RESPAWN_SECONDS = 5;

/**
 * Command buffer management. Draining exactly one command per tick is the
 * obvious implementation and it is wrong: every lost packet arrives later as a
 * resend, the queue deepens by one, and it never recovers, so the server falls
 * permanently further behind the client. These bound it.
 */
const TARGET_BUFFER_DEPTH = 2;
const MAX_COMMANDS_PER_TICK = 2;
/** Beyond this the client is unreachably far ahead; drop the oldest input. */
const MAX_QUEUED_COMMANDS = 12;

export class GameServer {
  readonly room: MotorRoom;
  readonly patchHz: number;

  /** Snapshots broadcast and command packets dropped as stale. Telemetry. */
  snapshotsSent = 0;
  staleCommandsDropped = 0;
  /** Inputs thrown away because a client's queue overflowed. Should stay at 0. */
  commandsDiscarded = 0;
  /** Packets a peer sent that could not be parsed at all. */
  malformedPacketsDropped = 0;
  /** Client dial writes refused: not allowed, unknown id, or out of range. */
  visualDialWritesRefused = 0;
  /** Shots resolved, hits landed, and claims thrown away. Telemetry. */
  shotsResolved = 0;
  shotsHit = 0;
  fireClaimsRejected = 0;
  /** Select/reload claims refused: unknown weapon, mid-switch, full magazine… */
  weaponClaimsRejected = 0;
  /** Room packets broadcast. One per patch tick at most, however fast a client talks. */
  roomStatePacketsSent = 0;

  private readonly transport: ServerTransport;
  private readonly peers = new Map<number, Peer>();
  private readonly commands = new Map<string, PlayerCommand>();
  private readonly catchUp = new Map<string, PlayerCommand>();
  private readonly snapshotPlayers: SnapshotPlayer[] = [];
  private readonly ticksPerPatch: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private weather: number;
  private readonly clampDial: ((id: number, value: number) => number | null) | null;
  private readonly allowClientVisualDials: boolean;
  /** Only the dials somebody has actually moved. An untouched room holds none. */
  private readonly visualDials = new Map<number, number>();
  /**
   * Room state changed and has not been sent yet.
   *
   * ONE FLAG rather than a per-dial dirty set, because the packet always carries
   * the complete state — see the codec for why the delta was not worth the three
   * pieces of agreeing bookkeeping it needed.
   *
   * COALESCED TO THE PATCH TICK rather than sent per message: a dragged slider
   * fires an input event per pixel, so forwarding each one costs a send per client
   * per event, about 3800 a second at 64 players from one admin's mouse. Batching
   * bounds it to the patch rate however fast a client talks, which also stops a
   * hostile client using it as an amplifier.
   */
  private roomStateDirty = false;
  private readonly maxHealth: number;
  private readonly respawnTicks: number;
  private readonly maxAimDeviation: number;
  private readonly spawn: (seat: number) => { x: number; y?: number; z: number };
  private readonly heights: MotorHeightSource;
  /** Reused, so resolving a shot allocates nothing on a 64-player room's tick. */
  private readonly aimScratch = { x: 0, y: 0, z: 0 };
  /** Rewind buffer: per-tick capsules for lag-compensated near-field shots. */
  private readonly history = new StateHistory(HISTORY_TICKS);
  /**
   * Tick of the newest snapshot actually sent. A fire claim's viewTick is
   * capped here: a client cannot have SEEN a tick that was never broadcast, so
   * anything newer is a lie by construction — this closes "aim at the present
   * while claiming the past window" without needing any latency estimation.
   */
  private lastBroadcastTick = -1;
  /** Server-owned destructible world targets, by id. */
  private readonly targets = new Map<number, ServerTarget>();
  /** Target state changed and has not been sent. Same coalescing as room state. */
  private targetsDirty = false;
  /** Capsules as they are NOW, for projectiles in flight. */
  private readonly liveQuery: ServerWorldQuery;
  /**
   * Grow-only backing store and reused view for the live capsules. Refilled in
   * place per tick and per claim, so the 60 Hz history feed and every
   * projectile raycast read records instead of allocating a generator's worth
   * of fresh objects — the same reuse rule StateHistory already follows.
   */
  private readonly capsuleEntries: Array<{
    id: number;
    feetX: number;
    feetY: number;
    feetZ: number;
    radius: number;
    height: number;
    name: string | undefined;
  }> = [];
  private readonly capsuleView: CapsuleCandidate[] = [];
  /** One damageable lookup for every query this server builds. */
  private readonly damageableFor = (id: number): Damageable | null =>
    this.peers.get(id)?.damageable ?? this.targets.get(id)?.damageable ?? null;
  /** Prebuilt drain visitor: counts projectile hits without a per-tick closure. */
  private readonly countProjectileHit = (result: BallisticResult): void => {
    if (result.reports.some((report) => report.damageApplied > 0)) this.shotsHit += 1;
  };
  /** Beyond-horizon rounds in flight, on the shared ballistic model. */
  private readonly ballistics: BallisticProjectileSystem;
  private readonly ticksPerSecond: number;

  constructor(
    rapier: typeof RAPIER,
    world: RAPIER.World,
    heightSource: MotorHeightSource,
    transport: ServerTransport,
    options: GameServerOptions = {}
  ) {
    const tuning = options.tuning ?? DEFAULT_MOTOR_TUNING;
    this.transport = transport;
    this.patchHz = options.patchHz ?? DEFAULT_PATCH_HZ;
    this.ticksPerPatch = Math.max(
      1,
      Math.round(1 / tuning.fixedTimestepSeconds / this.patchHz)
    );
    this.room = new MotorRoom(rapier, world, heightSource, {
      tuning,
      ...(options.sharedSurfaceSpanMetres !== undefined
        ? { sharedSurfaceSpanMetres: options.sharedSurfaceSpanMetres }
        : {}),
    });
    const spawn = options.spawn ?? defaultSpawn;
    this.spawn = spawn;
    this.maxHealth = Math.max(1, Math.min(255, options.maxHealth ?? DEFAULT_MAX_HEALTH));
    this.respawnTicks = Math.round(
      (options.respawnSeconds ?? DEFAULT_RESPAWN_SECONDS) / tuning.fixedTimestepSeconds
    );
    this.maxAimDeviation =
      options.maxAimDeviationRadians ?? DEFAULT_MAX_AIM_DEVIATION_RADIANS;
    this.weather = (options.weatherIndex ?? 0) & 0xff;
    this.clampDial = options.clampVisualDial ?? null;
    this.allowClientVisualDials = options.allowClientVisualDials ?? false;
    this.ticksPerSecond = 1 / tuning.fixedTimestepSeconds;
    // Two views of the same world. The rewound query reads the history ring at
    // whatever tick `rewindTick` names while a claim resolves; the live query
    // reads the motors directly for projectiles in flight. Both damage through
    // the same per-peer Damageable, so health falls in exactly one place.
    this.heights = heightSource;
    this.liveQuery = new ServerWorldQuery(heightSource, () => this.capsuleView, this.damageableFor);
    (options.worldTargets ?? []).forEach((spec, index) => {
      const id = WORLD_TARGET_ID_BASE + index;
      this.targets.set(id, {
        id,
        x: spec.x,
        // The server's own terrain decides the feet, exactly like a spawn.
        y: heightSource.sample(spec.x, spec.z),
        z: spec.z,
        radius: spec.radiusMetres ?? DEFAULT_TARGET_RADIUS_METRES,
        height: spec.heightMetres ?? DEFAULT_TARGET_HEIGHT_METRES,
        maxHealth: targetHealth(spec),
        respawnTicks: Math.round(
          (spec.respawnSeconds ?? DEFAULT_TARGET_RESPAWN_SECONDS) / tuning.fixedTimestepSeconds
        ),
        name: `world-target-${index + 1}`,
        damageable: this.createTargetDamageable(id),
        health: targetHealth(spec),
        respawnTick: -1,
      });
    });
    // The same environment the client's local simulation uses by default. URL
    // wind overrides are ignored by networked clients for the same reason
    // `?weather=` is — see docs/12 §8.1.
    this.ballistics = new BallisticProjectileSystem(
      this.liveQuery,
      DEFAULT_BALLISTIC_ENVIRONMENT,
      // No traces and no impact-event queue: this owner is headless.
      { capacity: SERVER_PROJECTILE_CAPACITY, maxTracePoints: 2, captureImpactEvents: false }
    );

    transport.onConnection((connection) => {
      const roomId = String(connection.id);
      const motor = this.room.add(roomId, spawn(connection.id));
      this.peers.set(connection.id, {
        connection,
        roomId,
        health: this.maxHealth,
        respawnTick: -1,
        highestFireSequence: -1,
        highestWeaponSequence: -1,
        weaponIndex: 0,
        magazines: WEAPON_DEFINITIONS.map((definition) => definition.ammo.magazineSize),
        reserves: WEAPON_DEFINITIONS.map((definition) => definition.ammo.initialReserve),
        nextFireTicks: WEAPON_DEFINITIONS.map(() => 0),
        switchCompleteTick: -1,
        reloadCompleteTick: -1,
        damageable: this.createDamageable(connection.id),
        queue: [],
        acknowledgedTick: 0,
        highestQueuedTick: -1,
      });
      // The resolved feet position, not the requested spawn: the motor drops
      // the player onto the terrain, so the client must be told where they
      // actually landed or it starts its prediction off the ground.
      connection.send(
        encodeWelcome(connection.id, this.room.tick, motor.state.position, this.maxHealth)
      );
      // Right after the welcome, because the client needs the room's sky before
      // its first frame. Fog is concealment in this game, so two players in one
      // match seeing different fog ranges is a fairness bug, not a cosmetic one.
      // One packet describes the whole room: its sky and any dials that have been
      // moved, so a late joiner sees it as dialled rather than as its preset alone.
      connection.send(encodeRoomState(this.describeRoom()));
      // The room's targets, so a late joiner sees the same husks as everyone.
      if (this.targets.size > 0) {
        connection.send(encodeWorldTargets(this.describeWorldTargets()));
      }
    });

    transport.onMessage((connection, bytes) => {
      const type = packetTypeOf(bytes);
      if (type === PacketType.SetVisualDial) {
        this.receiveVisualDial(connection, bytes);
        return;
      }
      if (type === PacketType.Fire) {
        this.receiveFire(connection, bytes);
        return;
      }
      if (type === PacketType.SelectWeapon) {
        this.receiveSelectWeapon(connection, bytes);
        return;
      }
      if (type === PacketType.Reload) {
        this.receiveReload(connection, bytes);
        return;
      }
      if (type !== PacketType.Commands) return;
      const peer = this.peers.get(connection.id);
      if (peer === undefined) return;
      // The codec clamps to the buffer, but this is a socket handler: anything
      // that escapes it is an uncaught exception and a dead room for everyone.
      // Belt and braces, deliberately.
      let incoming: PlayerCommand[];
      try {
        incoming = decodeCommands(bytes);
      } catch {
        this.malformedPacketsDropped += 1;
        return;
      }
      for (const command of incoming) {
        // Redundant resends are normal — a client repeats unacknowledged
        // commands — so anything already consumed OR already queued is dropped.
        if (command.tick <= peer.highestQueuedTick) {
          this.staleCommandsDropped += 1;
          continue;
        }
        peer.highestQueuedTick = command.tick;
        peer.queue.push(command);
      }
      // Trimmed here as well as in `tick`, or a burst inside one tick window
      // allocates without limit and pays an O(n log n) sort for the privilege.
      if (peer.queue.length > MAX_QUEUED_COMMANDS) {
        this.commandsDiscarded += peer.queue.length - MAX_QUEUED_COMMANDS;
        peer.queue.splice(0, peer.queue.length - MAX_QUEUED_COMMANDS);
      }
      peer.queue.sort((left, right) => left.tick - right.tick);
    });

    transport.onDisconnection((connection) => {
      this.peers.delete(connection.id);
      this.room.remove(String(connection.id));
    });
  }

  /** The room's weather. Meaning lives in `src/df2/weather.ts`; a number here. */
  get weatherIndex(): number {
    return this.weather;
  }

  /** One place the room packet is described, so join and change cannot drift. */
  private describeRoom(): RoomState {
    return {
      weatherIndex: this.weather,
      // BOTH conditions, the same pair `receiveVisualDial` enforces. Advertising a
      // capability the intake would refuse is worse than not having it: the panel
      // would present live-looking sliders that silently do nothing.
      clientDialsAllowed: this.allowClientVisualDials && this.clampDial !== null,
      dials: this.visualDials,
    };
  }

  /**
   * Changes the room's weather and tells everyone connected.
   *
   * ON CHANGE ONLY — there is no periodic rebroadcast, so a client that loses
   * this packet keeps the old sky until it reconnects. That is the right trade
   * for something that changes a handful of times a match: the alternative is
   * paying for it every patch, forever, to say nothing happened.
   */
  setWeather(index: number): void {
    const next = index & 0xff;
    if (next === this.weather) return;
    this.weather = next;
    this.roomStateDirty = true;
  }

  /** The room's visual dial overrides. Sparse: only what has been moved. */
  get visualDialOverrides(): ReadonlyMap<number, number> {
    return this.visualDials;
  }

  /**
   * Sets one visual dial for the whole room. THE SERVER-SIDE ENTRY POINT — game
   * code, a round system or an admin console calls this directly and is trusted;
   * the client path goes through `receiveVisualDial`, which gates and then lands
   * here. Returns the clamped value, or null if the id or value was unusable.
   */
  setVisualDial(id: number, value: number): number | null {
    const clamped = this.clampDial?.(id, value) ?? null;
    if (clamped === null) return null;
    if (this.visualDials.get(id) === clamped) return clamped;
    this.visualDials.set(id, clamped);
    this.roomStateDirty = true;
    return clamped;
  }

  /** Drops every override, returning the room to its preset. */
  resetVisualDials(): void {
    if (this.visualDials.size === 0) return;
    this.visualDials.clear();
    this.roomStateDirty = true;
  }

  /**
   * A client asking to change a dial. Refused unless the server opted in AND was
   * handed the ranges to check against — two conditions rather than one, because
   * the consequence of getting this wrong is a player clearing everyone's fog.
   *
   * Refusals are SILENT and counted. Telling a client which packet was rejected
   * tells it what to try next, and there is nothing an honest client learns from
   * the answer: an admin panel that is out of step with the server it is talking
   * to is a development mistake, visible in this counter.
   */
  private receiveVisualDial(connection: ServerConnection, bytes: Uint8Array): void {
    if (!this.allowClientVisualDials || !this.peers.has(connection.id)) {
      this.visualDialWritesRefused += 1;
      return;
    }
    const request = decodeSetVisualDial(bytes);
    if (request === null || this.setVisualDial(request.id, request.value) === null) {
      this.visualDialWritesRefused += 1;
    }
  }

  /** A player's server-owned hit points, or null if they are not in this room. */
  healthOf(playerId: number): number | null {
    return this.peers.get(playerId)?.health ?? null;
  }

  /**
   * Applies damage on the server's authority. THE ONLY PLACE health falls — the
   * fire path lands here, and so will a grenade or a fall. Returns the health left,
   * or null for an unknown or already-dead target.
   */
  damagePlayer(playerId: number, amount: number): number | null {
    const peer = this.peers.get(playerId);
    if (peer === undefined || peer.health === 0) return null;
    peer.health = Math.max(0, peer.health - Math.max(0, Math.round(amount)));
    if (peer.health === 0 && this.respawnTicks > 0) {
      peer.respawnTick = this.room.tick + this.respawnTicks;
    }
    return peer.health;
  }

  /**
   * A client claiming it fired.
   *
   * The claim carries INTENT ONLY — a tick, a shot sequence, the direction the
   * weapon was pointing, and the snapshot tick the shooter was rendering.
   * Everything that decides the outcome is the server's: the origin is the
   * shooter's own authoritative eye, THE WEAPON is the peer's server-owned
   * loadout record, the targets are the capsules the simulation holds (rewound
   * for the near field), and terrain occlusion is the same height field the
   * motor collides with. Nothing here reads a bone and no bullet becomes a
   * Rapier body (docs/10 §10).
   *
   * HYBRID RESOLUTION. Inside the ammunition's hitscan horizon — the distance
   * where drop stays under tolerance — the shot is instant against capsules
   * rewound to the claimed viewTick: lag compensation where twitch fights
   * happen. A round still flying at the horizon hands off to the shared
   * projectile integrator against LIVE state: at range, flight time dwarfs
   * latency and holding lead is the game.
   *
   * Rejections are silent and counted, same rule as a dial write: telling a client
   * which claim was thrown away tells it what to send next.
   */
  private receiveFire(connection: ServerConnection, bytes: Uint8Array): void {
    const peer = this.peers.get(connection.id);
    const claim = decodeFire(bytes);
    if (peer === undefined || claim === null || peer.health === 0) {
      this.fireClaimsRejected += 1;
      return;
    }
    // A resend or a replayed packet must not fire twice. The sequence is the
    // shooter's own counter, so this is the same dedupe idea as the command
    // queue — but WRAP-AWARE, because the wire truncates it to u16 and a
    // long-lived peer's 65,536th shot must not brick its trigger forever.
    const fireAdvance = sequenceAdvance(peer.highestFireSequence, claim.sequence);
    if (fireAdvance === null) {
      this.fireClaimsRejected += 1;
      return;
    }
    peer.highestFireSequence += fireAdvance;

    const motor = this.room.get(peer.roomId);
    if (motor === undefined) {
      this.fireClaimsRejected += 1;
      return;
    }

    // The weapon is NOT in the claim: what fires is what the server says is in
    // hand, gated by its own switch, reload, magazine and cadence bookkeeping.
    // The client's WeaponSystem enforces the same rules, so an honest client
    // never trips these; they exist for the client that stops being honest.
    this.settleWeapon(peer);
    const definition = this.equippedDefinition(peer);
    const tick = this.room.tick;
    if (
      tick < peer.switchCompleteTick ||
      peer.reloadCompleteTick >= 0 ||
      peer.magazines[peer.weaponIndex] <= 0 ||
      tick < peer.nextFireTicks[peer.weaponIndex]
    ) {
      this.fireClaimsRejected += 1;
      return;
    }
    peer.magazines[peer.weaponIndex] -= 1;
    peer.nextFireTicks[peer.weaponIndex] =
      tick +
      Math.max(
        1,
        this.secondsToTicks(60 / definition.shot.roundsPerMinute) - CADENCE_TOLERANCE_TICKS
      );

    // CLAMPED TO THE SERVER'S OWN LOOK, not trusted. The weapon's aimed direction
    // legitimately differs from the look angles by sway, recoil and dispersion, none
    // of which is simulated here, so the claim is bounded rather than rejected.
    const yaw = clampToward(motor.state.yawRadians, claim.yawRadians, this.maxAimDeviation);
    const pitch = clampToward(
      motor.state.pitchRadians,
      claim.pitchRadians,
      this.maxAimDeviation
    );
    // The eye, from the blended stance the simulation holds — so a shot from a
    // player who is halfway into a crouch leaves where the server says their head is.
    const originY = motor.state.position.y + eyeHeightFor(motor.state, this.room.tuning);
    const aim = lookDirection(yaw, pitch, this.aimScratch);
    const origin = { x: motor.state.position.x, y: originY, z: motor.state.position.z };
    const ammunition = definition.shot.ammunition;
    const maxRange = Math.min(definition.shot.range, MAX_SHOT_DISTANCE_METRES);
    const horizon = Math.min(hitscanHorizonMetres(ammunition), maxRange);
    const sourceId = String(connection.id);

    // Everyone else gets the shot as THEATRE — the server's own origin and
    // clamped direction, so bystanders see the round the authority fired.
    // Damage never rides this; it arrives as health in a snapshot, or not at all.
    const shotEvent = encodeShotFired({
      shooterId: connection.id,
      weaponIndex: peer.weaponIndex,
      sequence: claim.sequence,
      origin,
      yawRadians: yaw,
      pitchRadians: pitch,
    });
    for (const other of this.peers.values()) {
      if (other.connection.id !== connection.id) other.connection.send(shotEvent);
    }

    // NEAR: instant, against the world the shooter was LOOKING AT. The claimed
    // viewTick is clamped into the rewind window AND to the newest tick this
    // server ever broadcast — nobody has seen a fresher world than that.
    // History the ring no longer holds falls back to live capsules inside the
    // query — worse, never wrong. The rewound query is built PER CLAIM so the
    // rewind target is an explicit input, not a field someone must remember to
    // assign first.
    this.refillLiveCapsules();
    const newestSeeable = this.lastBroadcastTick < 0 ? tick : Math.min(tick, this.lastBroadcastTick);
    const rewindTick = Math.min(
      newestSeeable,
      Math.max(claim.viewTick, tick - MAX_REWIND_TICKS)
    );
    const near = resolveHitscanShot({
      query: new ServerWorldQuery(
        this.heights,
        () => this.history.capsulesAt(rewindTick) ?? this.capsuleView,
        this.damageableFor
      ),
      sourceId,
      sequence: claim.sequence,
      origin,
      direction: aim,
      maxDistanceMetres: horizon,
      damage: definition.shot.damage,
      ammunition,
      excludeObjectId: sourceId,
    });
    this.shotsResolved += 1;
    if (near.interactions.some((i) => i.targetId !== null && i.damageApplied > 0)) {
      this.shotsHit += 1;
    }

    // FAR: still flying at the horizon — the rest of the arc belongs to the
    // shared integrator: drop, drift, energy decay, further penetrations.
    if (near.continuation !== null && near.continuation.distanceTravelledMetres < maxRange) {
      this.ballistics.spawn({
        sourceId,
        sequence: claim.sequence,
        origin: near.continuation.point,
        direction: near.continuation.direction,
        maxDistance: maxRange,
        maxFlightSeconds: definition.shot.maxFlightSeconds,
        damage: definition.shot.damage,
        ammunition,
        captureTrace: false,
        excludeObjectId: sourceId,
        initialSpeedMetresPerSecond: near.continuation.speedMetresPerSecond,
        initialDistanceMetres: near.continuation.distanceTravelledMetres,
        initialElapsedSeconds: near.continuation.elapsedSeconds,
        initialInteractionCount: near.continuation.interactionCount,
      });
    }
  }

  /**
   * A client changing weapons. The record flips after the same switch delay the
   * client's LoadoutSystem imposes; an unfinished reload is abandoned with its
   * rounds unmoved, exactly as putting the weapon away abandons it in hand.
   */
  private receiveSelectWeapon(connection: ServerConnection, bytes: Uint8Array): void {
    const peer = this.peers.get(connection.id);
    const claim = decodeSelectWeapon(bytes);
    const selectAdvance =
      peer === undefined || claim === null
        ? null
        : sequenceAdvance(peer.highestWeaponSequence, claim.sequence);
    if (peer === undefined || claim === null || selectAdvance === null) {
      this.weaponClaimsRejected += 1;
      return;
    }
    peer.highestWeaponSequence += selectAdvance;
    const definition = weaponByWireIndex(claim.weaponIndex);
    if (definition === null || claim.weaponIndex === peer.weaponIndex) {
      this.weaponClaimsRejected += 1;
      return;
    }
    // A reload that has already completed keeps its rounds before the switch.
    this.settleWeapon(peer);
    peer.weaponIndex = claim.weaponIndex;
    peer.reloadCompleteTick = -1;
    peer.switchCompleteTick = this.room.tick + this.secondsToTicks(WEAPON_SWITCH_SECONDS);
  }

  /** A client starting a reload. Rounds move when the server's timer says. */
  private receiveReload(connection: ServerConnection, bytes: Uint8Array): void {
    const peer = this.peers.get(connection.id);
    const claim = decodeReload(bytes);
    const reloadAdvance =
      peer === undefined || claim === null
        ? null
        : sequenceAdvance(peer.highestWeaponSequence, claim.sequence);
    if (peer === undefined || claim === null || reloadAdvance === null) {
      this.weaponClaimsRejected += 1;
      return;
    }
    peer.highestWeaponSequence += reloadAdvance;
    this.settleWeapon(peer);
    const definition = this.equippedDefinition(peer);
    if (
      peer.health === 0 ||
      this.room.tick < peer.switchCompleteTick ||
      peer.reloadCompleteTick >= 0 ||
      peer.magazines[peer.weaponIndex] >= definition.ammo.magazineSize ||
      peer.reserves[peer.weaponIndex] <= 0
    ) {
      this.weaponClaimsRejected += 1;
      return;
    }
    peer.reloadCompleteTick =
      this.room.tick + this.secondsToTicks(definition.reload.durationSeconds);
  }

  /** The equipped weapon's definition. The index is validated at intake. */
  private equippedDefinition(peer: Peer): WeaponDefinition {
    return WEAPON_DEFINITIONS[peer.weaponIndex] ?? WEAPON_DEFINITIONS[0];
  }

  private secondsToTicks(seconds: number): number {
    return Math.max(1, Math.round(seconds * this.ticksPerSecond));
  }

  /**
   * Applies a completed reload LAZILY — checked when the next claim needs the
   * magazine truth rather than scanned every tick for every peer. The rounds
   * move at the recorded completion tick either way.
   */
  private settleWeapon(peer: Peer): void {
    if (peer.reloadCompleteTick < 0 || this.room.tick < peer.reloadCompleteTick) return;
    const definition = this.equippedDefinition(peer);
    const index = peer.weaponIndex;
    const fill = Math.min(
      definition.ammo.magazineSize - peer.magazines[index],
      peer.reserves[index]
    );
    peer.magazines[index] += fill;
    peer.reserves[index] -= fill;
    peer.reloadCompleteTick = -1;
  }

  /** The peer's health as the shared model's Damageable. */
  private createDamageable(playerId: number): Damageable {
    return damageableAdapter(
      playerId,
      () => this.maxHealth,
      () => this.peers.get(playerId)?.health,
      (amount) => this.damagePlayer(playerId, amount)
    );
  }

  /** Refills the reused capsule view: live players blended to the stance the
   * simulation holds, then standing targets. Dead players are not shootable,
   * and neither is a destroyed target waiting to stand up. */
  private refillLiveCapsules(): void {
    let count = 0;
    for (const peer of this.peers.values()) {
      if (peer.health === 0) continue;
      const motor = this.room.get(peer.roomId);
      if (motor === undefined) continue;
      const entry = this.capsuleEntry(count);
      count += 1;
      entry.id = peer.connection.id;
      entry.feetX = motor.state.position.x;
      entry.feetY = motor.state.position.y;
      entry.feetZ = motor.state.position.z;
      entry.radius = blendedStanceDimension(motor.state, this.room.tuning, "radius");
      entry.height = blendedStanceDimension(motor.state, this.room.tuning, "height");
      entry.name = undefined;
    }
    for (const target of this.targets.values()) {
      if (target.health === 0) continue;
      const entry = this.capsuleEntry(count);
      count += 1;
      entry.id = target.id;
      entry.feetX = target.x;
      entry.feetY = target.y;
      entry.feetZ = target.z;
      entry.radius = target.radius;
      entry.height = target.height;
      entry.name = target.name;
    }
    this.capsuleView.length = count;
    for (let index = 0; index < count; index += 1) {
      this.capsuleView[index] = this.capsuleEntries[index];
    }
  }

  private capsuleEntry(index: number) {
    let entry = this.capsuleEntries[index];
    if (entry === undefined) {
      entry = { id: 0, feetX: 0, feetY: 0, feetZ: 0, radius: 0, height: 0, name: undefined };
      this.capsuleEntries[index] = entry;
    }
    return entry;
  }

  /** One place the target packet is described, so join and change cannot drift. */
  private describeWorldTargets(): WorldTargetState[] {
    return [...this.targets.values()].map((target) => ({
      id: target.id,
      x: target.x,
      y: target.y,
      z: target.z,
      radiusMetres: target.radius,
      heightMetres: target.height,
      health: target.health,
      maxHealth: target.maxHealth,
    }));
  }

  /** The room's targets as the wire describes them. Test and tooling surface. */
  get worldTargetStates(): readonly WorldTargetState[] {
    return this.describeWorldTargets();
  }

  /**
   * Applies damage to a world target on the server's authority — the target
   * sibling of `damagePlayer`, and like it, the ONLY place target health falls.
   */
  damageWorldTarget(targetId: number, amount: number): number | null {
    const target = this.targets.get(targetId);
    if (target === undefined || target.health === 0) return null;
    target.health = Math.max(0, target.health - Math.max(0, Math.round(amount)));
    if (target.health === 0 && target.respawnTicks > 0) {
      target.respawnTick = this.room.tick + target.respawnTicks;
    }
    this.targetsDirty = true;
    return target.health;
  }

  /** The target's health as the shared model's Damageable. */
  private createTargetDamageable(targetId: number): Damageable {
    return damageableAdapter(
      targetId,
      () => this.targets.get(targetId)?.maxHealth ?? 0,
      () => this.targets.get(targetId)?.health,
      (amount) => this.damageWorldTarget(targetId, amount)
    );
  }

  /** Puts dead players back, at a fresh spawn, with full health and full kit. */
  private respawnDue(): void {
    for (const target of this.targets.values()) {
      if (target.respawnTick < 0 || this.room.tick < target.respawnTick) continue;
      target.respawnTick = -1;
      target.health = target.maxHealth;
      this.targetsDirty = true;
    }
    for (const peer of this.peers.values()) {
      if (peer.respawnTick < 0 || this.room.tick < peer.respawnTick) continue;
      const motor = this.room.get(peer.roomId);
      peer.respawnTick = -1;
      peer.health = this.maxHealth;
      for (let index = 0; index < WEAPON_DEFINITIONS.length; index += 1) {
        peer.magazines[index] = WEAPON_DEFINITIONS[index].ammo.magazineSize;
        peer.reserves[index] = WEAPON_DEFINITIONS[index].ammo.initialReserve;
      }
      peer.nextFireTicks.fill(0);
      peer.switchCompleteTick = -1;
      peer.reloadCompleteTick = -1;
      if (motor === undefined) continue;
      const at = this.spawn(peer.connection.id);
      // The spawn point's OWN elevation, not the corpse's: dying in a hollow
      // must not respawn a player buried inside the spawn ring's hill.
      motor.teleport({ x: at.x, y: at.y ?? this.heights.sample(at.x, at.z), z: at.z });
    }
  }

  /** Advances one simulation tick and broadcasts if this tick is a patch tick. */
  tick(): void {
    this.commands.clear();
    for (const peer of this.peers.values()) {
      if (peer.queue.length > MAX_QUEUED_COMMANDS) {
        const overflow = peer.queue.length - MAX_QUEUED_COMMANDS;
        peer.queue.splice(0, overflow);
        this.commandsDiscarded += overflow;
      }
      // One command per tick normally; a second only while catching up, so a
      // resend burst drains instead of accumulating.
      const drain = peer.queue.length > TARGET_BUFFER_DEPTH ? MAX_COMMANDS_PER_TICK : 1;
      let consumed: PlayerCommand | undefined;
      for (let index = 0; index < drain; index += 1) {
        const next = peer.queue.shift();
        if (next === undefined) break;
        // Catch-up steps run immediately so the extra input is simulated, not
        // silently dropped; only the last one rides this tick's batch.
        if (consumed !== undefined) {
          this.catchUp.set(peer.roomId, consumed);
          this.room.step(this.catchUp);
          this.catchUp.clear();
        }
        consumed = next;
      }
      if (consumed === undefined) continue;
      this.commands.set(peer.roomId, consumed);
      peer.acknowledgedTick = consumed.tick;
    }
    this.room.step(this.commands);
    // Rounds beyond the hitscan horizon fly here, against live capsules. Damage
    // lands through each peer's Damageable, so it is still `damagePlayer` that
    // moves health. The 1/120 s inner step runs twice per 60 Hz room tick.
    this.refillLiveCapsules();
    this.ballistics.update(this.room.tuning.fixedTimestepSeconds);
    this.ballistics.drainResults(this.countProjectileHit);
    this.respawnDue();
    // Refilled AFTER respawn placement, so the ring holds exactly what this
    // tick's snapshot will show — viewTick rewinds must land on rendered truth.
    this.refillLiveCapsules();
    this.history.record(this.room.tick, this.capsuleView);
    if (this.room.tick % this.ticksPerPatch === 0) this.broadcast();
  }

  start(): void {
    if (this.timer !== null) return;
    const intervalMs = this.room.tuning.fixedTimestepSeconds * 1000;
    this.timer = setInterval(() => this.tick(), intervalMs);
  }

  async stop(): Promise<void> {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    await this.transport.close();
    this.room.dispose();
  }

  private broadcast(): void {
    // BEFORE the snapshot, and outside its early return: a room change has to go
    // out even on a patch tick where no motor produced a snapshot, or an admin
    // dialling an empty room silently loses the edit.
    this.flushRoomState();
    this.flushWorldTargets();

    this.snapshotPlayers.length = 0;
    for (const peer of this.peers.values()) {
      const motor = this.room.get(peer.roomId);
      if (motor === undefined) continue;
      this.snapshotPlayers.push({
        id: peer.connection.id,
        state: motor.state,
        health: peer.health,
      });
    }
    if (this.snapshotPlayers.length === 0) return;
    this.lastBroadcastTick = this.room.tick;
    // Each client needs its own acknowledgement, so the payload is re-encoded
    // per peer. At 28 bytes a player this is cheaper than a shared buffer plus
    // a patch, and it keeps the format single-branch.
    for (const peer of this.peers.values()) {
      peer.connection.send(
        encodeSnapshot(this.room.tick, peer.acknowledgedTick, this.snapshotPlayers)
      );
      this.snapshotsSent += 1;
    }
  }

  /** Sends every target to everyone, if any changed since the last patch tick. */
  private flushWorldTargets(): void {
    if (!this.targetsDirty) return;
    this.targetsDirty = false;
    const bytes = encodeWorldTargets(this.describeWorldTargets());
    for (const peer of this.peers.values()) peer.connection.send(bytes);
  }

  /** Sends the room to everyone, if it changed since the last patch tick. */
  private flushRoomState(): void {
    if (!this.roomStateDirty) return;
    this.roomStateDirty = false;
    // Encoded ONCE and shared, unlike the snapshot, which carries a per-peer
    // acknowledgement and therefore cannot be.
    const bytes = encodeRoomState(this.describeRoom());
    for (const peer of this.peers.values()) peer.connection.send(bytes);
    this.roomStatePacketsSent += 1;
  }
}

/**
 * Moves `from` toward `to` by at most `limit` radians, the short way round.
 *
 * Shortest-arc, so a claim of 10 degrees against a look of 350 is 20 degrees apart
 * rather than 340 — the naive subtraction makes every shot near north look like a
 * spoof and clamps it backwards.
 */
function clampToward(from: number, to: number, limit: number): number {
  const delta = wrapPi(to - from);
  if (delta > limit) return from + limit;
  if (delta < -limit) return from - limit;
  return to;
}

/** The wire's 1-255 clamp for a target's authored health. */
function targetHealth(spec: WorldTargetSpec): number {
  return Math.max(1, Math.min(255, spec.maxHealth ?? DEFAULT_TARGET_MAX_HEALTH));
}

/**
 * One adapter shape for every mortal thing the server owns: lazy record lookup
 * (so it can be built before the record exists and survives it), damage routed
 * through the record's own authoritative method, applied/destroyed derived
 * from the health that method returns.
 */
function damageableAdapter(
  id: number,
  maxHealth: () => number,
  health: () => number | undefined,
  damage: (amount: number) => number | null
): Damageable {
  return {
    id: String(id),
    get maxHealth() {
      return maxHealth();
    },
    get health() {
      return health() ?? 0;
    },
    applyDamage(info) {
      const before = health() ?? 0;
      const after = damage(info.amount);
      if (after === null) return { applied: 0, health: before, destroyed: false };
      return { applied: before - after, health: after, destroyed: after === 0 };
    },
    reset() {},
  };
}

/**
 * How far a u16 wire sequence advances past the highest consumed one, or null
 * for a replay/stale claim. Forward window of half the u16 space: a counter
 * that wrapped keeps advancing, a resend lands at delta 0, an old claim in the
 * backward half is stale. `highest` itself is an unbounded number.
 */
function sequenceAdvance(highest: number, wireSequence: number): number | null {
  const delta = (wireSequence - (highest & 0xffff)) & 0xffff;
  if (delta === 0 || delta > 0x7fff) return null;
  return delta;
}

function defaultSpawn(seat: number): { x: number; z: number } {
  const angle = seat * 1.4;
  return { x: Math.cos(angle) * 6, z: Math.sin(angle) * 6 };
}
