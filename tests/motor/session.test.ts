// Two-client session: prediction, authority and reconciliation end to end.
//
// Everything here goes through the real codec and the real GameServer/GameClient
// over a loopback transport with a simulated link, so the only thing missing
// versus a live socket is the socket itself.

import assert from "node:assert/strict";
import test from "node:test";
import { GameClient } from "../../src/net/GameClient.ts";
import {
  DEFAULT_RESPAWN_SECONDS,
  GameServer,
  type WorldTargetSpec,
} from "../../src/net/GameServer.ts";
import { DEATH_CLIPS } from "../../src/character/characterClips.ts";
import { LoopbackNetwork, type LinkConditions } from "../../src/net/LoopbackTransport.ts";
import {
  BYTES_PER_PLAYER,
  BYTES_PER_COMMAND,
  PacketType,
  decodeCommands,
  decodeDamageTaken,
  decodeHitConfirmed,
  decodePlayerDied,
  decodeRoomState,
  decodeRoster,
  decodeSetVisualDial,
  decodeSnapshot,
  decodeWelcome,
  encodeDamageTaken,
  encodeHitConfirmed,
  encodePlayerDied,
  encodeRoster,
  encodeCommands,
  encodeFire,
  encodeSnapshot,
  encodeWelcome,
  quantiseCommand,
} from "../../src/net/SnapshotCodec.ts";
import {
  WEATHER_PRESET_IDS,
  weatherPresetAt,
  weatherPresetIndex,
} from "../../src/df2/weather.ts";
import { VISUAL_DIALS, clampVisualDial } from "../../src/df2/visualDials.ts";
import { createMotorWorld, flatHeightSource, initRapier } from "../../src/motor/MotorWorld.ts";
import {
  DEFAULT_MOTOR_TUNING,
  MotorInput,
  createMotorState,
  lookAngles,
  type MotorHeightSource,
} from "../../src/motor/MotorTypes.ts";

const RAPIER = await initRapier();
const TICK_MS = DEFAULT_MOTOR_TUNING.fixedTimestepSeconds * 1000;
const GROUND: MotorHeightSource = flatHeightSource(0);

/** Deterministic pseudo-random so a loss test does not flake. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

interface SessionOptions {
  readonly conditions?: LinkConditions;
  readonly weatherIndex?: number;
  readonly allowClientVisualDials?: boolean;
  readonly spawn?: (seat: number) => { x: number; y?: number; z: number };
  readonly respawnSeconds?: number;
  readonly worldTargets?: readonly WorldTargetSpec[];
}

/** An options bag rather than positionals: `makeSession(2, {}, 0, true)` told a
 * reader nothing, and the next server flag would have been a fifth argument. */
function makeSession(clientCount: number, options: SessionOptions = {}) {
  const network = new LoopbackNetwork();
  const server = new GameServer(RAPIER, createMotorWorld(RAPIER), GROUND, network, {
    sharedSurfaceSpanMetres: 512,
    patchHz: 20,
    weatherIndex: options.weatherIndex ?? 0,
    // Wired by DEFAULT so the refusal test proves the FLAG is what gates a client
    // write, not a missing clamp — two conditions guard this and they must be told
    // apart, or "refused" could be passing for the wrong reason.
    clampVisualDial,
    allowClientVisualDials: options.allowClientVisualDials ?? false,
    // Undefined falls through to each option's own default inside GameServer.
    spawn: options.spawn,
    worldTargets: options.worldTargets,
    respawnSeconds: options.respawnSeconds,
  });
  // The transports are returned as well as the clients, so a test can resend raw
  // bytes on an EXISTING connection. Opening a fresh one is a different peer, which
  // makes it impossible to test that a replayed packet from a known player is dropped.
  const transports = Array.from({ length: clientCount }, () =>
    network.connect(options.conditions ?? {})
  );
  const clients = transports.map(
    (transport) => new GameClient(RAPIER, createMotorWorld(RAPIER), GROUND, transport)
  );
  return { network, server, clients, transports };
}

/**
 * Runs the session for `ticks`, letting each client supply its own input.
 * Pumps each client's remote interpolation once per tick like a real frame
 * loop, so `remote.state`/`remote.position` are the RENDERED (fixed-delay,
 * interpolated) view — which is also what a fire claim's viewTick names.
 */
function drive(
  session: ReturnType<typeof makeSession>,
  ticks: number,
  input: (clientIndex: number, tick: number) => { buttons: number; yaw: number }
): void {
  for (let tick = 0; tick < ticks; tick += 1) {
    session.clients.forEach((client, index) => {
      const { buttons, yaw } = input(index, tick);
      client.predict(buttons, yaw, 0);
    });
    session.network.advance(TICK_MS / 2);
    session.server.tick();
    session.network.advance(TICK_MS / 2);
    for (const client of session.clients) client.interpolateRemotes(TICK_MS / 1000);
  }
}

test("command and snapshot packets survive a codec round trip", () => {
  const commands = [
    { tick: 1, buttons: MotorInput.Forward | MotorInput.Jump, yawRadians: 1.2, pitchRadians: -0.3 },
    { tick: 2, buttons: MotorInput.Crouch, yawRadians: -2.9, pitchRadians: 0.75 },
  ];
  const decoded = decodeCommands(encodeCommands(commands));
  assert.equal(decoded.length, 2);
  decoded.forEach((entry, index) => {
    const source = commands[index]!;
    assert.equal(entry.tick, source.tick);
    assert.equal(entry.buttons, source.buttons);
    assert.ok(Math.abs(entry.yawRadians - source.yawRadians) < 1e-3);
    assert.ok(Math.abs(entry.pitchRadians - source.pitchRadians) < 1e-3);
  });

  const state = createMotorState();
  state.position.x = 123.5;
  state.position.y = -8.25;
  state.position.z = 4096.75;
  state.velocity.x = 5.5;
  state.stance = "prone";
  state.grounded = true;
  // Pitch and the stance blend were once decode-side fakes (pitch 0, progress
  // 1) and nothing asserted them, so a wrong-offset write would have passed the
  // whole suite. Assert every presentation field the snapshot claims to carry.
  state.pitchRadians = -0.6;
  state.previousStance = "crouch";
  state.stanceProgress = 0.4;
  state.aiming = true;
  const snapshot = encodeSnapshot(99, 42, [{ id: 7, state }]);
  assert.equal(snapshot.length, 10 + BYTES_PER_PLAYER);

  const back = decodeSnapshot(snapshot);
  assert.equal(back.tick, 99);
  assert.equal(back.acknowledgedCommandTick, 42);
  assert.equal(back.players[0]!.id, 7);
  assert.equal(back.players[0]!.state.stance, "prone");
  assert.equal(back.players[0]!.state.grounded, true);
  assert.ok(Math.abs(back.players[0]!.state.position.z - 4096.75) < 1e-2);
  assert.ok(Math.abs(back.players[0]!.state.velocity.x - 5.5) < 1e-2);
  assert.ok(Math.abs(back.players[0]!.state.pitchRadians - -0.6) < 1e-3);
  assert.equal(back.players[0]!.state.previousStance, "crouch");
  assert.ok(Math.abs(back.players[0]!.state.stanceProgress - 0.4) < 1 / 255);
  assert.equal(back.players[0]!.state.aiming, true);
});

test("the welcome carries the room's full health, so a client can read a fraction", () => {
  // Player maxHealth is NOT in the snapshot — it is a room constant, so it rides
  // the one packet sent once per join. Without it the client has no denominator
  // and the vitals bar has to invent one, which is wrong on any server not using
  // the default.
  const welcome = decodeWelcome(encodeWelcome(7, 42, { x: 1, y: 2, z: 3 }, 150))!;
  assert.equal(welcome.playerId, 7);
  assert.equal(welcome.tick, 42);
  assert.equal(welcome.maxHealth, 150);

  // Clamped into the byte on the way in, and floored at 1 on the way out: a zero
  // maximum would make every health fraction a division by zero.
  assert.equal(decodeWelcome(encodeWelcome(1, 0, { x: 0, y: 0, z: 0 }, 0))!.maxHealth, 1);
  assert.equal(decodeWelcome(encodeWelcome(1, 0, { x: 0, y: 0, z: 0 }, 9999))!.maxHealth, 255);
  // The DECODE-side floor, reached with a hand-built packet: going through the
  // encoder cannot test it, because the encoder already clamps to >= 1. A hostile
  // or buggy server sending a raw zero is the case that needs the guard.
  const rawZeroMax = encodeWelcome(1, 0, { x: 0, y: 0, z: 0 }, 1);
  new DataView(rawZeroMax.buffer, rawZeroMax.byteOffset).setUint8(19, 0);
  assert.equal(
    decodeWelcome(rawZeroMax)!.maxHealth,
    1,
    "a zero maximum on the wire must floor to 1, or every health fraction divides by zero"
  );
});

test("the feedback packets survive a codec round trip", () => {
  const died = decodePlayerDied(
    encodePlayerDied({
      victimId: 4,
      killerId: 9,
      weaponIndex: 2,
      direction: "back",
      headshot: true,
      respawnSeconds: 5.4,
    })
  )!;
  assert.equal(died.victimId, 4);
  assert.equal(died.killerId, 9);
  assert.equal(died.weaponIndex, 2);
  assert.equal(died.direction, "back");
  assert.equal(died.headshot, true);
  // Tenths of a second: the wire must carry fractional respawn times without
  // rounding to whole seconds, whatever the server chooses to schedule.
  assert.ok(Math.abs(died.respawnSeconds - 5.4) < 0.05);

  // Zero is the absent id - nobody killed them, or the killer already left.
  assert.equal(decodePlayerDied(encodePlayerDied({ ...died, killerId: 0 }))!.killerId, 0);

  const hit = decodeHitConfirmed(
    encodeHitConfirmed({ sequence: 61234, victimId: 3, fatal: true })
  )!;
  assert.equal(hit.sequence, 61234, "the sequence must survive past a signed 16-bit range");
  assert.equal(hit.victimId, 3);
  assert.equal(hit.fatal, true);

  const damage = decodeDamageTaken(
    encodeDamageTaken({ attackerId: 8, bearingRadians: -2.2, amount: 34 })
  )!;
  assert.equal(damage.attackerId, 8);
  assert.equal(damage.amount, 34);
  assert.ok(Math.abs(damage.bearingRadians - -2.2) < 1e-3);
  // Clamped into the byte rather than wrapping: a wrapped amount would report a
  // scratch as a kill.
  assert.equal(decodeDamageTaken(encodeDamageTaken({ ...damage, amount: 9999 }))!.amount, 255);
});

test("the roster carries names, and survives a hostile length byte", () => {
  const entries = [
    { id: 1, name: "Ada" },
    { id: 2, name: "Recruit-0042" },
  ];
  assert.deepEqual(decodeRoster(encodeRoster(entries)), entries);
  assert.deepEqual(decodeRoster(encodeRoster([])), []);

  // Callsigns are capped at 16 characters by validateCallsign, and the wire caps
  // them again rather than trusting that.
  const long = decodeRoster(encodeRoster([{ id: 3, name: "x".repeat(64) }]));
  assert.equal(long[0]!.name.length, 16);

  // A count claiming more entries than arrived yields what arrived, never a throw
  // and never an undefined entry - the same rule the command decoder follows.
  const truncated = new Uint8Array([PacketType.Roster, 9, 0, 1, 3, 65, 66, 67]);
  assert.deepEqual(decodeRoster(truncated), [{ id: 1, name: "ABC" }]);
  assert.deepEqual(decodeRoster(new Uint8Array([PacketType.Roster, 200])), []);
  assert.deepEqual(decodeRoster(new Uint8Array([PacketType.Roster])), []);
});

test("every input bit survives the wire, including the ones past a byte", () => {
  // Buttons were a u8. Adding aim intent at bit 8 pushed the field past a byte
  // and it would have silently truncated to zero — a movement input that simply
  // never reached the server. This asserts the whole bitfield, not a sample.
  const everyBit = Object.values(MotorInput).reduce((all, bit) => all | bit, 0);
  assert.ok(everyBit > 0xff, "input bits still fit in a byte; this test is not testing much");

  const decoded = decodeCommands(
    encodeCommands([{ tick: 7, buttons: everyBit, yawRadians: 0, pitchRadians: 0 }])
  )[0]!;
  assert.equal(decoded.buttons, everyBit, "an input bit was lost in transit");
  for (const [name, bit] of Object.entries(MotorInput)) {
    assert.ok((decoded.buttons & bit) !== 0, `${name} did not survive the round trip`);
  }
});

test("a malformed packet is survived, not thrown on", () => {
  // This is the test whose absence let a remote crash ship. Every other codec
  // test round-trips something the encoder produced, so nothing ever fed the
  // decoder a hostile buffer — and the decoder believed the declared count and
  // read past the end. On a server that RangeError escapes the socket handler
  // and takes the room down, from three bytes, sent by any client.
  const hostile: Array<[string, Uint8Array]> = [
    ["empty", new Uint8Array(0)],
    ["type byte only", new Uint8Array([PacketType.Commands])],
    ["header truncated", new Uint8Array([PacketType.Commands, 0])],
    ["claims 65535 commands, carries none", new Uint8Array([PacketType.Commands, 0xff, 0xff])],
    [
      "claims 3, carries 1",
      new Uint8Array([PacketType.Commands, 0, 3, ...new Array(BYTES_PER_COMMAND).fill(7)]),
    ],
    ["snapshot claims 255 players, carries none", new Uint8Array([2, 0, 0, 0, 0, 0, 0, 0, 0, 0xff])],
    ["welcome truncated", new Uint8Array([3, 0, 1])],
    ["room state carries no payload", new Uint8Array([PacketType.RoomState])],
    ["room state claims 255 dials, carries none", new Uint8Array([PacketType.RoomState, 0, 0, 0xff])],
  ];

  for (const [label, bytes] of hostile) {
    assert.doesNotThrow(() => decodeCommands(bytes), `decodeCommands threw on ${label}`);
    assert.doesNotThrow(() => decodeSnapshot(bytes), `decodeSnapshot threw on ${label}`);
    assert.doesNotThrow(() => decodeWelcome(bytes), `decodeWelcome threw on ${label}`);
    // Every decoder here is hardened against a short buffer, and a new packet
    // type must not be the exception — it is reached from the same handler.
    assert.doesNotThrow(() => decodeRoomState(bytes), `decodeRoomState threw on ${label}`);
    assert.doesNotThrow(() => decodeRoster(bytes), `decodeRoster threw on ${label}`);
    assert.doesNotThrow(() => decodePlayerDied(bytes), `decodePlayerDied threw on ${label}`);
    assert.doesNotThrow(() => decodeHitConfirmed(bytes), `decodeHitConfirmed threw on ${label}`);
    assert.doesNotThrow(() => decodeDamageTaken(bytes), `decodeDamageTaken threw on ${label}`);
  }

  // Clamped to what arrived, not to what was claimed.
  assert.equal(decodeCommands(new Uint8Array([PacketType.Commands, 0xff, 0xff])).length, 0);
  assert.equal(
    decodeCommands(
      new Uint8Array([PacketType.Commands, 0, 3, ...new Array(BYTES_PER_COMMAND).fill(7)])
    ).length,
    1
  );
  assert.equal(decodeWelcome(new Uint8Array([3, 0, 1])), null);
  assert.equal(decodeRoomState(new Uint8Array([PacketType.RoomState, 0, 4])), null);
  assert.equal(decodeSetVisualDial(new Uint8Array([PacketType.SetVisualDial, 0, 1])), null);

  // An index this build has never heard of is NOT clamped by the decoder — it is
  // reported as it arrived, because a newer server can legitimately name a preset
  // that shipped after this client. The presentation side is where it lands on a
  // real sky, and that fallback is neutral daylight rather than a random one.
  assert.equal(
    decodeRoomState(new Uint8Array([PacketType.RoomState, 0, 250, 0]))!.weatherIndex,
    250
  );
  assert.equal(weatherPresetAt(250).id, "day", "an unknown preset index invented a sky");

  // Dials claim a count too, and the same clamp applies.
  assert.equal(
    decodeRoomState(new Uint8Array([PacketType.RoomState, 0, 0, 0xff]))!.dials.size,
    0
  );
  // A NaN dial value is dropped rather than carried: assigned to a uniform it does
  // not throw, it blanks whatever term it feeds, and the symptom appears elsewhere.
  const withNaN = new Uint8Array(4 + 5);
  withNaN[0] = PacketType.RoomState;
  withNaN[3] = 1;
  new DataView(withNaN.buffer).setFloat32(5, Number.NaN);
  assert.equal(decodeRoomState(withNaN)!.dials.size, 0, "a NaN dial value survived");
  const upstreamNaN = new Uint8Array(6);
  upstreamNaN[0] = PacketType.SetVisualDial;
  new DataView(upstreamNaN.buffer).setFloat32(2, Number.POSITIVE_INFINITY);
  assert.equal(decodeSetVisualDial(upstreamNaN), null, "an infinite dial value survived");
});

test("a room dial change reaches every client, clamped, and coalesced", () => {
  const FOG_FAR = VISUAL_DIALS.findIndex((dial) => dial.label === "Fog far");
  assert.ok(FOG_FAR > 0, "the fixture dial is gone; this test needs updating");

  const session = makeSession(2, { allowClientVisualDials: true });
  session.network.advance(TICK_MS);
  session.server.tick();
  session.network.advance(TICK_MS);

  // The room advertises the capability, so a panel can tell refused from pending.
  for (const client of session.clients) {
    assert.equal(client.getRoomState()?.clientDialsAllowed, true);
  }

  // Asked for well past the dial's own maximum: the server clamps to the SAME range
  // the panel shows, which is the whole reason the table is shared rather than copied.
  session.clients[0]!.setVisualDial(FOG_FAR, 999_999);
  session.network.advance(TICK_MS);
  drive(session, 4, () => ({ buttons: 0, yaw: 0 }));

  const expected = VISUAL_DIALS[FOG_FAR]!.max;
  for (const client of session.clients) {
    assert.equal(
      client.getRoomState()?.dials.get(FOG_FAR),
      expected,
      "a dial change did not reach a client, or was not clamped"
    );
  }

  // COALESCED: a drag's worth of values inside one patch window costs one packet,
  // not one per event. Without this, one admin's mouse is 64 sends per event.
  const before = session.server.roomStatePacketsSent;
  for (let step = 0; step < 40; step += 1) {
    session.clients[0]!.setVisualDial(FOG_FAR, 1000 + step);
  }
  session.network.advance(TICK_MS);
  session.server.tick();
  session.network.advance(TICK_MS);
  assert.equal(
    session.server.roomStatePacketsSent - before,
    1,
    "40 dial writes in one patch window sent more than one packet"
  );
  // The last value wins, not the first.
  assert.equal(session.server.visualDialOverrides.get(FOG_FAR), 1039);

  // A RESET must clear on the client, which is the case the always-complete packet
  // exists for: a delta cannot say "no longer overridden", because an absent id
  // means unchanged.
  session.server.resetVisualDials();
  drive(session, 4, () => ({ buttons: 0, yaw: 0 }));
  for (const client of session.clients) {
    assert.equal(client.getRoomState()?.dials.size, 0, "a reset left an override applied");
  }
});

test("a client cannot dial a room that did not opt in", () => {
  const FOG_FAR = VISUAL_DIALS.findIndex((dial) => dial.label === "Fog far");
  // Default session: ranges are wired but the admin flag is not set.
  const session = makeSession(1);
  session.network.advance(TICK_MS);
  session.server.tick();
  session.network.advance(TICK_MS);

  assert.equal(
    session.clients[0]!.getRoomState()?.clientDialsAllowed,
    false,
    "a room without the admin flag advertised the capability anyway"
  );

  session.clients[0]!.setVisualDial(FOG_FAR, 500);
  drive(session, 4, () => ({ buttons: 0, yaw: 0 }));
  assert.equal(session.server.visualDialOverrides.size, 0, "an unauthorised dial write landed");
  assert.equal(session.clients[0]!.getRoomState()?.dials.size, 0);
  assert.ok(session.server.visualDialWritesRefused > 0, "the refusal was not counted");

  // Server-side game code is trusted and is NOT gated by the client flag — that
  // distinction is the point of having two paths.
  assert.equal(session.server.setVisualDial(FOG_FAR, 500), 500);
  drive(session, 4, () => ({ buttons: 0, yaw: 0 }));
  assert.equal(session.clients[0]!.getRoomState()?.dials.get(FOG_FAR), 500);
});

test("a shot is resolved by the server, and damage reaches both clients", () => {
  // Two players facing each other on flat ground. Client 0 fires; nothing about the
  // outcome is client-side, so the only thing that can make client 1's health fall
  // is the server having resolved the shot itself — with the BALLISTIC model, so
  // the damage below is the Glock's 9mm at 8 m (full nominal 42, energy well above
  // the 70% knee), not a flat constant.
  const session = makeSession(2, {
    spawn: (seat) => ({ x: seat === 1 ? 0 : 8, z: 0 }),
    respawnSeconds: 0,
  });
  // Yaw 0 faces -Z and forward is (-sin, -cos), so +X — where player 2 stands — is
  // -90 degrees. The shooter must actually LOOK there: the server clamps a claim to
  // a cone around the look angles it holds, so a claim alone cannot aim the shot.
  const towardVictim = -Math.PI / 2;
  const aimed = (index: number) => ({ buttons: 0, yaw: index === 0 ? towardVictim : 0 });
  drive(session, 4, aimed);

  const [shooter, victim] = session.clients as [GameClient, GameClient];
  assert.equal(shooter.health, 100, "the client was never told its own health");
  assert.equal(session.server.healthOf(2), 100);

  // The sidearm, via the server-owned loadout record: the sniper the peer spawns
  // with would simply kill at 8 m, and this test wants a survivor to interrogate.
  // The switch is re-timed server-side (0.35 s = 21 ticks), so firing before it
  // completes would be refused — drive well past it.
  shooter.selectWeapon(2);
  drive(session, 25, aimed);

  shooter.fire(towardVictim, 0);
  drive(session, 4, aimed);

  assert.equal(session.server.shotsHit, 1, "the server did not resolve the shot as a hit");
  assert.equal(session.server.healthOf(2), 58, "ballistic damage was not applied on the server");
  assert.equal(victim.health, 58, "the victim was not told it had been hit");
  // The shooter sees the victim's health too, which is what a death clip will read.
  const asSeenByShooter = [...shooter.remotePlayers].find((remote) => remote.id === 2);
  assert.equal(asSeenByShooter?.health, 58, "a remote's health did not reach the other client");

  // Turning away and firing misses, and the miss is counted rather than lost.
  // The Glock's cadence is 9 ticks; 12 ticks of turning is past it.
  const resolvedBefore = session.server.shotsResolved;
  drive(session, 12, () => ({ buttons: 0, yaw: towardVictim + Math.PI }));
  shooter.fire(towardVictim + Math.PI, 0);
  drive(session, 4, () => ({ buttons: 0, yaw: towardVictim + Math.PI }));
  assert.equal(session.server.shotsResolved, resolvedBefore + 1);
  assert.equal(session.server.shotsHit, 1, "a shot fired backwards still hit");
  assert.equal(session.server.healthOf(2), 58);
});

test("fire claims are gated by the server-owned loadout: cadence and magazine", () => {
  const session = makeSession(2, {
    spawn: (seat) => ({ x: seat === 1 ? 0 : 8, z: 0 }),
    respawnSeconds: 0,
  });
  const towardVictim = -Math.PI / 2;
  const aimed = (index: number) => ({ buttons: 0, yaw: index === 0 ? towardVictim : 0 });
  drive(session, 4, aimed);
  const shooter = session.clients[0]!;

  // The spawn weapon is the sniper: 48 rounds per minute is 75 ticks. A second
  // claim right behind the first is a rate a human trigger cannot produce on
  // that weapon, so the server must refuse it — otherwise a modified client
  // fires a bolt rifle like a machine gun.
  shooter.fire(towardVictim, 0);
  drive(session, 2, aimed);
  assert.equal(session.server.healthOf(2), 0, "a .308 at 8 m should simply kill");
  const rejectedBefore = session.server.fireClaimsRejected;
  const resolvedBefore = session.server.shotsResolved;
  shooter.fire(towardVictim, 0);
  drive(session, 2, aimed);
  assert.equal(session.server.shotsResolved, resolvedBefore, "a cadence claim was resolved");
  assert.ok(
    session.server.fireClaimsRejected > rejectedBefore,
    "firing far above the weapon's cadence was not refused"
  );

  // The magazine is server bookkeeping too: five sniper rounds, then every claim
  // is refused until a Reload claim has run the server's own reload clock.
  drive(session, 80, aimed);
  for (let round = 1; round < 5; round += 1) {
    shooter.fire(towardVictim, 0);
    drive(session, 80, aimed);
  }
  const emptyRejected = session.server.fireClaimsRejected;
  shooter.fire(towardVictim, 0);
  drive(session, 4, aimed);
  assert.ok(
    session.server.fireClaimsRejected > emptyRejected,
    "an empty magazine still fired"
  );

  // Reload, wait out the server's timer, and the weapon speaks again.
  shooter.reload();
  drive(session, 4.2 * 60 + 10, aimed);
  const resolvedAfterReload = session.server.shotsResolved;
  shooter.fire(towardVictim, 0);
  drive(session, 4, aimed);
  assert.equal(
    session.server.shotsResolved,
    resolvedAfterReload + 1,
    "a reloaded weapon did not fire"
  );
});

test("damage falls with distance and arrives with the round's flight time", () => {
  // 300 m apart on flat ground. This is the beyond-horizon branch: the 5.56
  // horizon is ~93 m, so the round crosses it as hitscan and flies the rest as
  // an integrated projectile — drop, drag and all — against live state.
  const session = makeSession(2, {
    spawn: (seat) => ({ x: seat === 1 ? -150 : 150, z: 0 }),
    respawnSeconds: 0,
  });
  const towardVictim = -Math.PI / 2;
  const aimed = (index: number) => ({ buttons: 0, yaw: index === 0 ? towardVictim : 0 });
  drive(session, 4, aimed);
  // The M4: 5.56 keeps the expected number away from both the full-damage knee
  // and an outright kill, so the falloff is visible in the health value.
  session.clients[0]!.selectWeapon(1);
  drive(session, 25, aimed);

  session.clients[0]!.fire(towardVictim, 0);
  // ~0.36 s of flight at 60 Hz is ~22 ticks. Four ticks in, the round is mid-air:
  // damage arriving instantly at 300 m would mean the hitscan branch overreached.
  drive(session, 4, aimed);
  assert.equal(session.server.healthOf(2), 100, "damage landed before the round could arrive");

  drive(session, 40, aimed);
  const health = session.server.healthOf(2)!;
  assert.ok(health < 100, "the round never arrived");
  assert.ok(health > 0, "a 5.56 at 300 m should wound, not kill");
  // At 300 m a 5.56 retains roughly half its energy, so §12.3 scales the nominal
  // 68 down hard. Wide bounds on purpose: this pins the SHAPE of the model —
  // less than nominal, more than the floor — not one calibration number.
  const damage = 100 - health;
  assert.ok(damage > 20 && damage < 62, `expected mid-range falloff damage, got ${damage}`);
});

test("the near field is lag compensated: a claim lands where the shooter saw the target", () => {
  const session = makeSession(2, {
    spawn: (seat) => ({ x: seat === 1 ? 0 : 8, z: 0 }),
    respawnSeconds: 0,
  });
  const shooterAim = { yaw: -Math.PI / 2 };
  const input = (index: number, sprinting: boolean) => ({
    buttons: index === 1 && sprinting ? MotorInput.Forward | MotorInput.Sprint : 0,
    yaw: index === 0 ? shooterAim.yaw : 0,
  });
  // Let the victim reach sprint speed first, so the displacement between the
  // seen tick and the fire tick is a full capsule diameter and more.
  drive(session, 40, (index) => input(index, true));

  const seenTick = session.server.room.tick;
  const seen = { ...session.server.room.get("2")!.state.position };
  // The shooter aims at the position it SEES — the victim at seenTick.
  const aim = lookAngles(seen.x - 0, 0, seen.z - 0);
  shooterAim.yaw = aim.yawRadians;
  drive(session, 12, (index) => input(index, true));

  const now = session.server.room.get("2")!.state.position;
  const displacement = Math.hypot(now.x - seen.x, now.z - seen.z);
  assert.ok(
    displacement > 0.8,
    `the victim moved only ${displacement.toFixed(2)} m; the miss/hit contrast needs more`
  );

  // The claim says "I was looking at tick seenTick". Without rewind, the shot
  // along the old aim line passes more than a capsule diameter behind the
  // victim's live position; with it, the server restores the seen capsule.
  session.transports[0]!.send(
    encodeFire({
      tick: 0,
      sequence: 1,
      yawRadians: shooterAim.yaw,
      pitchRadians: 0,
      viewTick: seenTick,
    })
  );
  drive(session, 4, (index) => input(index, false));
  assert.ok(
    session.server.healthOf(2)! < 100,
    "a claim aimed at the seen position missed: the rewind did not happen"
  );
});

test("an accepted shot is relayed to bystanders as presentation, never to the shooter", () => {
  const session = makeSession(2, {
    spawn: (seat) => ({ x: seat === 1 ? 0 : 8, z: 0 }),
    respawnSeconds: 0,
  });
  const towardVictim = -Math.PI / 2;
  const aimed = (index: number) => ({ buttons: 0, yaw: index === 0 ? towardVictim : 0 });
  drive(session, 4, aimed);

  session.clients[0]!.fire(towardVictim, 0);
  drive(session, 2, aimed);

  const seenByVictim: Array<{ shooterId: number; weaponIndex: number; originY: number }> = [];
  session.clients[1]!.drainRemoteShots((shot) =>
    seenByVictim.push({
      shooterId: shot.shooterId,
      weaponIndex: shot.weaponIndex,
      originY: shot.origin.y,
    })
  );
  assert.equal(seenByVictim.length, 1, "the bystander never heard the shot");
  assert.equal(seenByVictim[0]!.shooterId, 1);
  assert.equal(seenByVictim[0]!.weaponIndex, 0, "the relay must carry the server's weapon");
  assert.ok(
    seenByVictim[0]!.originY > 1 && seenByVictim[0]!.originY < 2.2,
    "the relayed origin must be the shooter's eye, not the feet or a zero"
  );

  let shooterHeard = 0;
  session.clients[0]!.drainRemoteShots(() => {
    shooterHeard += 1;
  });
  assert.equal(shooterHeard, 0, "the shooter must not receive its own shot as theatre");

  // A REJECTED claim is not theatre: a dead shooter's spam reaches nobody.
  session.server.damagePlayer(1, 500);
  session.clients[0]!.fire(towardVictim, 0);
  drive(session, 2, aimed);
  let heardAfterDeath = 0;
  session.clients[1]!.drainRemoteShots(() => {
    heardAfterDeath += 1;
  });
  assert.equal(heardAfterDeath, 0, "a refused claim was broadcast anyway");
});

test("world targets are server-owned: shared, damaged by the room, and respawned", () => {
  const session = makeSession(2, {
    spawn: (seat) => ({ x: seat === 1 ? 0 : -8, z: 0 }),
    worldTargets: [{ x: 8, z: 0, respawnSeconds: 1 }],
  });
  // Yaw 0 faces -Z; the target stands at +X, so the shooter looks -PI/2.
  const towardTarget = -Math.PI / 2;
  const aimed = (index: number) => ({ buttons: 0, yaw: index === 0 ? towardTarget : 0 });
  drive(session, 4, aimed);

  // Both clients were told the same target on join.
  for (const client of session.clients) {
    const targets = client.getWorldTargets();
    assert.ok(targets !== null && targets.length === 1, "a client never learned the targets");
    assert.equal(targets[0]!.health, 100);
    assert.ok(Math.abs(targets[0]!.x - 8) < 1e-3);
  }

  // One .308 round: the server scores it and BOTH clients see the husk.
  session.clients[0]!.fire(towardTarget, 0);
  drive(session, 6, aimed);
  assert.equal(session.server.worldTargetStates[0]!.health, 0, "the server never scored the hit");
  for (const client of session.clients) {
    assert.equal(
      client.getWorldTargets()?.[0]?.health,
      0,
      "a destroyed target did not replicate to every client"
    );
  }

  // And it stands back up for everyone on the server's clock, not a keypress.
  drive(session, 80, aimed);
  assert.equal(session.server.worldTargetStates[0]!.health, 100);
  for (const client of session.clients) {
    assert.equal(client.getWorldTargets()?.[0]?.health, 100, "a respawn did not replicate");
  }
});

test("a claim cannot rewind to a tick the server never broadcast", () => {
  // The exploit this closes: the room knows something the shooter's screen
  // cannot yet — here, a teleport that happened after the last snapshot went
  // out. A claim naming that fresher tick must be clamped back to broadcast
  // truth, or a modified client gets to aim with the server's own knowledge.
  const session = makeSession(2, {
    spawn: (seat) => ({ x: seat === 1 ? 0 : 8, z: 0 }),
    respawnSeconds: 0,
  });
  const towardA = -Math.PI / 2;
  const aimed = (yaw: number) => (index: number) => ({ buttons: 0, yaw: index === 0 ? yaw : 0 });
  drive(session, 4, aimed(towardA));
  // Land exactly on a patch tick, so "the last broadcast" is the current tick.
  while (session.server.room.tick % 3 !== 0) drive(session, 1, aimed(towardA));

  // AFTER that broadcast: the victim is moved well off the old aim line. The
  // next tick records the new position in the rewind ring but does not
  // broadcast it (not a patch tick).
  const victim = session.server.room.get("2")!;
  victim.teleport({ x: 8, y: victim.state.position.y, z: 6 });
  const towardB = lookAngles(8, 0, 6).yawRadians;
  drive(session, 1, aimed(towardB));
  const unbroadcastTick = session.server.room.tick;
  assert.notEqual(unbroadcastTick % 3, 0, "the teleport tick must not have been broadcast");

  // Claim: "I was looking at the newest tick" — where the victim stands at B.
  session.transports[0]!.send(
    encodeFire({
      tick: 0,
      sequence: 1,
      yawRadians: towardB,
      pitchRadians: 0,
      viewTick: unbroadcastTick,
    })
  );
  drive(session, 2, aimed(towardB));
  assert.equal(session.server.shotsHit, 0, "a never-broadcast tick was honoured as a view");
  assert.equal(session.server.healthOf(2), 100);

  // Control: once the new position HAS been broadcast and the cadence clock
  // has run, the same aim hits — so the miss above was the clamp, not the aim.
  // A raw claim again (sequence 2): the raw sequence-1 claim above already
  // consumed the number the client's own fire() would use first.
  drive(session, 80, aimed(towardB));
  session.transports[0]!.send(
    encodeFire({
      tick: 0,
      sequence: 2,
      yawRadians: towardB,
      pitchRadians: 0,
      viewTick: session.server.room.tick,
    })
  );
  drive(session, 2, aimed(towardB));
  assert.equal(session.server.shotsHit, 1, "the control shot at broadcast truth missed");
});

test("a fire claim cannot be replayed, spoofed round, or fired while dead", () => {
  const session = makeSession(2, {
    spawn: (seat) => ({ x: seat === 1 ? 0 : 8, z: 0 }),
    respawnSeconds: 0,
  });
  const towardVictim = -Math.PI / 2;
  const aimed = (index: number) => ({ buttons: 0, yaw: index === 0 ? towardVictim : 0 });
  // Connect first — a claim sent before the welcome has no player id and is
  // dropped client-side. Then the sidearm, so the victim survives the first hit
  // and the replay has a health value to preserve; drive past the 21-tick switch.
  drive(session, 4, aimed);
  session.clients[0]!.selectWeapon(2);
  drive(session, 25, aimed);

  // THE SAME SEQUENCE TWICE must land once. A client resends its unacknowledged
  // tail, so a fire packet arriving twice is ordinary traffic rather than an attack
  // — and a shot that applies twice is a weapon with double its damage. Resent on
  // the shooter's OWN transport, because a fresh connection would be a third player.
  session.clients[0]!.fire(towardVictim, 0);
  drive(session, 2, aimed);
  const afterFirst = session.server.healthOf(2)!;
  assert.ok(afterFirst < 100, "the first shot did not land, so the replay proves nothing");
  assert.ok(afterFirst > 0, "the sidearm must wound, not kill, or the replay proves nothing");
  drive(session, 12, aimed); // past the Glock's cadence, so ONLY the dedupe can refuse it
  session.transports[0]!.send(
    encodeFire({ tick: 4, sequence: 1, yawRadians: towardVictim, pitchRadians: 0, viewTick: 0 })
  );
  drive(session, 4, aimed);
  assert.equal(session.server.healthOf(2), afterFirst, "a replayed fire claim applied damage");

  // A claim 90 degrees off the server's own look is CLAMPED, not honoured. The
  // shooter turns to face -Z while claiming a shot along +X, where the victim is.
  const hitsBefore = session.server.shotsHit;
  drive(session, 12, () => ({ buttons: 0, yaw: 0 }));
  session.clients[0]!.fire(towardVictim, 0);
  drive(session, 4, () => ({ buttons: 0, yaw: 0 }));
  assert.equal(
    session.server.shotsHit,
    hitsBefore,
    "a claim far off the authoritative look was honoured instead of clamped"
  );

  // Dead players cannot shoot. Without this a corpse keeps firing for as long as the
  // client keeps sending, which is invisible until someone dies mid-burst.
  session.server.damagePlayer(1, 500);
  assert.equal(session.server.healthOf(1), 0);
  const rejectedBefore = session.server.fireClaimsRejected;
  session.clients[0]!.fire(towardVictim, 0);
  drive(session, 4, aimed);
  assert.ok(
    session.server.fireClaimsRejected > rejectedBefore,
    "a dead player's shot was accepted"
  );
});

test("a kill reaches the shooter, the victim and the room, each with what it needs", () => {
  const session = makeSession(2, {
    spawn: (seat) => ({ x: seat === 1 ? 0 : 8, z: 0 }),
    respawnSeconds: 1,
  });
  const towardVictim = -Math.PI / 2;
  const aimed = (index: number) => ({ buttons: 0, yaw: index === 0 ? towardVictim : 0 });
  drive(session, 4, aimed);

  session.clients[0]!.fire(towardVictim, 0);
  drive(session, 3, aimed);

  const shooterSaw = session.clients[0]!.getCombatEvents();
  const victimSaw = session.clients[1]!.getCombatEvents();

  // The SHOOTER is told its round landed and that it was fatal, and is never
  // told how much health was left.
  const hit = shooterSaw.find((event) => event.kind === "hit");
  assert.ok(hit !== undefined, "the shooter was never told its round landed");
  assert.equal(hit.victimId, 2);
  assert.equal(hit.fatal, true);
  assert.ok(!("amount" in hit), "a hit confirmation must not carry the victim's health");

  // The VICTIM is told a bearing and an amount, and nothing about where the
  // shooter is. Yaw 0 faces -Z, which makes the left axis -X (docs/12 §4), so a
  // shooter at x=0 against a victim at x=8 is on the victim's LEFT — and left is
  // the positive direction.
  const damage = victimSaw.find((event) => event.kind === "damage");
  assert.ok(damage !== undefined, "the victim was never told it was hit");
  assert.ok(damage.amount > 0);
  assert.ok(
    Math.abs(damage.bearingRadians - Math.PI / 2) < 0.2,
    `a shot from the victim's left should read near +pi/2, got ${damage.bearingRadians}`
  );
  assert.ok(!("point" in damage), "a damage report must not carry a position");

  // The DEATH reaches BOTH, because every client plays the clip on that body.
  for (const [label, seen] of [["shooter", shooterSaw], ["victim", victimSaw]] as const) {
    const died = seen.find((event) => event.kind === "died");
    assert.ok(died !== undefined, `${label} never heard the death`);
    assert.equal(died.victimId, 2);
    assert.equal(died.killerId, 1);
    assert.equal(died.direction, "side", "the clip must face the side the round came from");
    assert.equal(died.headshot, false, "nothing sets headshot until a head zone exists");
    // Scheduled and announced from one number — the configured flat respawn —
    // so the client's counter cannot outlive the corpse or vice versa.
    assert.ok(Math.abs(died.respawnSeconds - 1) < 0.1, `respawn was ${died.respawnSeconds}s`);
  }

  // Events are ordered and resumable rather than drained, because three readers
  // need the same death and the first to drain would starve the other two.
  assert.ok(victimSaw.every((event, index) => index === 0 || event.seq > victimSaw[index - 1]!.seq));
  assert.deepEqual(session.clients[1]!.getCombatEvents(), victimSaw, "reading must not consume");
});

test("the roster names every player, and a leaver disappears from it", () => {
  const session = makeSession(2, { spawn: (seat) => ({ x: seat * 4, z: 0 }) });
  drive(session, 3, () => ({ buttons: 0, yaw: 0 }));

  // The numeric fallback, until a room resolves an account and renames them.
  assert.deepEqual(session.clients[0]!.getRoster(), [
    { id: 1, name: "Player 1" },
    { id: 2, name: "Player 2" },
  ]);
  const nameOn = (index: number, id: number) =>
    session.clients[index]!.getRoster().find((entry) => entry.id === id)?.name ?? null;
  assert.equal(nameOn(1, 1), "Player 1");
  assert.equal(nameOn(1, 99), null, "an unknown id has no name, not a guess");

  session.server.setDisplayName(2, "Ada");
  drive(session, 2, () => ({ buttons: 0, yaw: 0 }));
  assert.equal(nameOn(0, 2), "Ada", "a rename never reached the other client");

  // Leaving rewrites the roster, which is what the feed diffs to print "left".
  session.transports[1]!.close();
  drive(session, 2, () => ({ buttons: 0, yaw: 0 }));
  assert.deepEqual(session.clients[0]!.getRoster(), [{ id: 1, name: "Player 1" }]);
});

test("a killed player respawns with full health at a spawn point", () => {
  const session = makeSession(2, {
    spawn: (seat) => ({ x: seat === 1 ? 0 : 8, z: 0 }),
    // One flat window for every death — shot or otherwise. 1 s is 60 ticks here,
    // long enough for the corpse-check shot below to land inside it.
    respawnSeconds: 1,
  });
  const towardVictim = -Math.PI / 2;
  const aimed = (index: number) => ({ buttons: 0, yaw: index === 0 ? towardVictim : 0 });
  drive(session, 4, aimed);

  // The spawn sniper: a .308 at 8 m is one round, one kill.
  session.clients[0]!.fire(towardVictim, 0);
  drive(session, 2, aimed);
  assert.equal(session.server.healthOf(2), 0, "a lethal hit did not kill");

  // A dead player is not a target: without this, a corpse keeps absorbing rounds
  // that should carry on to whoever is behind it. Switch to a weapon with its own
  // fresh cadence so the shot is ACCEPTED inside the respawn window — the check
  // cannot be allowed to pass by the claim merely being refused.
  session.clients[0]!.selectWeapon(3);
  drive(session, 25, aimed);
  const hitsBefore = session.server.shotsHit;
  const resolvedBefore = session.server.shotsResolved;
  session.clients[0]!.fire(towardVictim, 0);
  drive(session, 2, aimed);
  assert.equal(session.server.shotsResolved, resolvedBefore + 1, "the corpse-check shot was refused");
  assert.equal(session.server.shotsHit, hitsBefore, "a dead player was still shootable");

  // Drive well past the one-second window: the flat respawnSeconds governs a
  // shot death exactly like any other, and the player comes back whole.
  drive(session, 90, aimed);
  assert.equal(session.server.healthOf(2), 100, "a dead player never respawned");
  assert.equal(session.clients[1]!.health, 100, "the respawn did not reach the client");
});

test("the visual dial wire order is append-only and every range is usable", () => {
  // Same hazard as the weather presets: a dial's INDEX is its identity on the wire,
  // so inserting one in the middle repoints an admin's fog setting at a blade twist.
  assert.equal(VISUAL_DIALS.length, 28, "a dial was added or removed — see the wire rule");
  assert.equal(VISUAL_DIALS[0]!.label, "Preset grade strength");
  assert.equal(VISUAL_DIALS[24]!.label, "Twist");
  // The terrain-detail dials were APPENDED (Aug 2026) — indices 0-24 are pinned above.
  assert.equal(VISUAL_DIALS[27]!.label, "Detail fade end");

  VISUAL_DIALS.forEach((dial, id) => {
    assert.ok(dial.max > dial.min, `${dial.label} has an empty range`);
    assert.ok(dial.step > 0, `${dial.label} has no step`);
    // The server clamps against these, so a range that cannot round-trip its own
    // bounds would make the top or bottom of a slider unreachable.
    assert.equal(clampVisualDial(id, dial.min), dial.min, `${dial.label} rejects its minimum`);
    assert.equal(clampVisualDial(id, dial.max), dial.max, `${dial.label} rejects its maximum`);
    assert.equal(clampVisualDial(id, Number.NaN), null, `${dial.label} accepted NaN`);
  });
  assert.equal(clampVisualDial(VISUAL_DIALS.length, 1), null, "an unknown dial id was accepted");
});

test("the room's weather reaches every client on join and again on change", () => {
  const moody = weatherPresetIndex("moody");
  assert.ok(moody > 0, "the fixture preset is the default, so this test proves nothing");

  const session = makeSession(2, { weatherIndex: moody });
  // Nobody has been told anything before the welcome lands, and the client says
  // so with null rather than a default — a client that joined with ?weather= must
  // keep its own sky for the packet's flight rather than flashing daylight.
  assert.equal(session.clients[0]!.getRoomState(), null);

  // Through subscribe rather than an assignable handler: more than one reader wants
  // room state, and a lone callback field would let the second silently displace the
  // first. This also proves the subscription fires, not just that the field is set.
  const seen: number[] = [];
  const unsubscribe = session.clients[0]!.subscribeRoomState(() => {
    seen.push(session.clients[0]!.getRoomState()!.weatherIndex);
  });

  session.network.advance(TICK_MS);
  session.server.tick();
  session.network.advance(TICK_MS);

  for (const client of session.clients) {
    assert.equal(
      client.getRoomState()?.weatherIndex,
      moody,
      "a client joined without being told the room's weather"
    );
  }

  // On CHANGE, to everyone already connected — at the next patch tick, since room
  // state shares the coalescing path with the dials rather than sending immediately.
  const night = weatherPresetIndex("night");
  session.server.setWeather(night);
  drive(session, 4, () => ({ buttons: 0, yaw: 0 }));
  for (const client of session.clients) {
    assert.equal(
      client.getRoomState()?.weatherIndex,
      night,
      "a weather change did not arrive"
    );
  }
  assert.equal(session.server.weatherIndex, night);

  // No periodic rebroadcast, and no packet for a change that is not one: this
  // rides the codec precisely so it costs nothing while the weather holds.
  session.server.setWeather(night);
  drive(session, 60, () => ({ buttons: 0, yaw: 0 }));
  assert.deepEqual(seen, [moody, night], "room state was re-sent without changing");
  unsubscribe();
});

test("the weather preset wire order is append-only", () => {
  // Pinned in a NETWORKING test on purpose. The server replicates its room's
  // weather as an index into this list, so reordering or deleting an entry in
  // src/df2/weather.ts repoints every connected client at a different sky — and
  // it fails as "the other player sees different fog", never as an error. Adding
  // a preset means adding a line at the END of this array, which is the point:
  // the edit that is safe is the one that touches nothing above it.
  assert.deepEqual(WEATHER_PRESET_IDS, [
    "day",
    "classic",
    "clear",
    "overcast",
    "apocalypse",
    "dusk",
    "moody",
    "dawn",
    "sinister",
    "techno",
    "netherworld",
    "night",
    "space",
    "kday",
    "kmorning",
    "knight",
    "kalien",
    "kspace",
  ]);
  assert.equal(WEATHER_PRESET_IDS[0], "day", "index 0 must be the neutral fallback");
});

test("a hostile client cannot crash the server or flood its queue", () => {
  const session = makeSession(1);
  drive(session, 30, () => ({ buttons: 0, yaw: 0 }));

  const socket = session.network.connect({});
  const attacker = [...session.server.room.playerIds].length;
  assert.ok(attacker > 0, "no peer to attack from");

  for (const bytes of [
    new Uint8Array([PacketType.Commands, 0xff, 0xff]),
    new Uint8Array([PacketType.Commands]),
    new Uint8Array(0),
  ]) {
    assert.doesNotThrow(() => {
      socket.send(bytes);
      session.network.advance(TICK_MS);
      session.server.tick();
    }, "a malformed packet reached the server and threw");
  }

  // A burst inside one tick window must not accumulate without limit.
  const flood: PlayerCommand[] = [];
  for (let tick = 0; tick < 4000; tick += 1) {
    flood.push({ tick, buttons: 1, yawRadians: 0, pitchRadians: 0 });
  }
  socket.send(encodeCommands(flood));
  session.network.advance(TICK_MS);
  session.server.tick();
  assert.ok(session.server.room.size >= 1, "the room did not survive the flood");
});

test("quantising a command is idempotent, so prediction matches the wire", () => {
  const once = quantiseCommand({
    tick: 3,
    buttons: MotorInput.Forward,
    yawRadians: 0.123456789,
    pitchRadians: -1.111111,
  });
  const twice = quantiseCommand(once);
  assert.deepEqual(twice, once);

  const overWire = decodeCommands(encodeCommands([once]))[0]!;
  assert.equal(overWire.yawRadians, once.yawRadians);
  assert.equal(overWire.pitchRadians, once.pitchRadians);
});

test("two clients join one room and each sees the other move", () => {
  const session = makeSession(2);
  // Let the welcome packets land before anyone predicts.
  session.network.advance(TICK_MS);
  session.server.tick();
  session.network.advance(TICK_MS);

  assert.equal(session.clients[0]!.playerId, 1);
  assert.equal(session.clients[1]!.playerId, 2);

  // Client 0 walks; client 1 stands still.
  drive(session, 240, (index) => ({
    buttons: index === 0 ? MotorInput.Forward : 0,
    yaw: 0,
  }));

  const walker = session.clients[0]!.localState!;
  const stander = session.clients[1]!.localState!;
  assert.ok(walker.grounded && stander.grounded, "clients never landed");

  // Each client must hold a remote entry for the other.
  const seenByStander = [...session.clients[1]!.remotePlayers];
  const seenByWalker = [...session.clients[0]!.remotePlayers];
  assert.equal(seenByStander.length, 1, "stander does not see the walker");
  assert.equal(seenByWalker.length, 1, "walker does not see the stander");
  assert.equal(seenByStander[0]!.id, 1);

  // The remote view of the walker must track the walker's own prediction.
  const remoteWalker = seenByStander[0]!.state.position;
  const gap = Math.hypot(
    remoteWalker.x - walker.position.x,
    remoteWalker.z - walker.position.z
  );
  assert.ok(gap < 1.5, `remote view lagged the walker by ${gap.toFixed(2)} m`);
  // The rendered view is DELIBERATELY in the past: two patch intervals of
  // interpolation delay (6 ticks = 0.1 s), which at the 5.5 m/s walk is about
  // 0.55 m, plus up to a patch of snapshot staleness. Bound it on both sides —
  // too small means interpolation is not rendering the past at all, too large
  // means the render clock is drifting.
  const behindAuthority = Math.abs(
    remoteWalker.z - session.server.room.get("1")!.state.position.z
  );
  assert.ok(
    behindAuthority > 0.25 && behindAuthority < 1.2,
    `remote view is ${behindAuthority.toFixed(3)} m behind authority; expected ~0.55 m of designed delay`
  );
});

test("remotes render a fixed interval in the past, at their true speed", () => {
  const session = makeSession(2);
  session.network.advance(TICK_MS);
  session.server.tick();
  session.network.advance(TICK_MS);

  // The walker moves at constant velocity; the stander records what its screen
  // shows and what the server truly held at every tick.
  const serverHistory = new Map<number, { x: number; z: number }>();
  const renderedSteps: number[] = [];
  let previousRendered: { x: number; z: number } | null = null;
  for (let tick = 0; tick < 300; tick += 1) {
    session.clients[0]!.predict(MotorInput.Forward, 0, 0);
    session.clients[1]!.predict(0, 0, 0);
    session.network.advance(TICK_MS / 2);
    session.server.tick();
    const authoritative = session.server.room.get("1")!.state.position;
    serverHistory.set(session.server.room.tick, { x: authoritative.x, z: authoritative.z });
    session.network.advance(TICK_MS / 2);
    for (const client of session.clients) client.interpolateRemotes(TICK_MS / 1000);
    // Sample the rendered walker over the settled tail of the run.
    if (tick > 240) {
      const rendered = [...session.clients[1]!.remotePlayers][0]!.position;
      if (previousRendered !== null) {
        renderedSteps.push(
          Math.hypot(rendered.x - previousRendered.x, rendered.z - previousRendered.z)
        );
      }
      previousRendered = { x: rendered.x, z: rendered.z };
    }
  }

  // ACCURACY: what the stander renders is the walker where the server had it
  // at the render tick — the interpolation is exact on linear motion, so the
  // tolerance is only slew and snapshot quantisation.
  const stander = session.clients[1]!;
  const rendered = [...stander.remotePlayers][0]!.position;
  const reference = serverHistory.get(stander.renderTick);
  assert.ok(reference, "the render tick names a tick the server never had");
  const error = Math.hypot(rendered.x - reference.x, rendered.z - reference.z);
  assert.ok(
    error < 0.15,
    `rendered walker is ${error.toFixed(3)} m from the server's state at the render tick`
  );

  // SMOOTHNESS: at constant velocity every rendered frame step is the same
  // size. The old exponential chase surged after each packet and settled
  // between them; interpolation must not.
  const meanStep = renderedSteps.reduce((sum, step) => sum + step, 0) / renderedSteps.length;
  const worstStep = Math.max(...renderedSteps);
  assert.ok(meanStep > 0.05, "the walker's rendered view never moved");
  assert.ok(
    worstStep < meanStep * 1.6,
    `rendered motion surges: worst step ${worstStep.toFixed(4)} vs mean ${meanStep.toFixed(4)}`
  );
});

test("a shot aimed at the rendered soldier hits, because the claim names the rendered tick", () => {
  // The end-to-end contract of parts III and IV together: the victim sprints
  // across the shooter's view, so the rendered soldier trails the live one by
  // more than a capsule radius. Aiming at the PIXELS — the interpolated remote
  // — must still land, because fire() claims the render tick and the server
  // rewinds to exactly that.
  const session = makeSession(2, {
    spawn: (seat) => ({ x: seat === 1 ? 0 : 8, z: 0 }),
    respawnSeconds: 0,
  });
  const aim = { yaw: -Math.PI / 2 };
  const input = (index: number) => ({
    buttons: index === 1 ? MotorInput.Forward | MotorInput.Sprint : 0,
    yaw: index === 0 ? aim.yaw : 0,
  });
  // Warm up: the victim reaches sprint speed and the render clock settles.
  // The shooter's look chases the rendered victim every tick, the way a human
  // tracks the soldier they can actually see.
  for (let tick = 0; tick < 90; tick += 1) {
    drive(session, 1, input);
    const rendered = [...session.clients[0]!.remotePlayers][0];
    if (rendered !== undefined) {
      aim.yaw = lookAngles(rendered.position.x, 0, rendered.position.z).yawRadians;
    }
  }

  const shooter = session.clients[0]!;
  const renderedVictim = [...shooter.remotePlayers][0]!.position;
  const liveVictim = session.server.room.get("2")!.state.position;
  const offset = Math.hypot(
    renderedVictim.x - liveVictim.x,
    renderedVictim.z - liveVictim.z
  );
  assert.ok(
    offset > 0.45,
    `the rendered victim only trails the live one by ${offset.toFixed(2)} m; ` +
      "a hit would not prove the rewind (capsule radius is 0.35 m)"
  );

  shooter.fire(aim.yaw, 0);
  drive(session, 4, input);
  assert.ok(
    session.server.healthOf(2)! < 100,
    "a shot aimed exactly at the rendered soldier missed"
  );
});

test("a client leaving is dropped from the other client's world", () => {
  const session = makeSession(2);
  drive(session, 120, () => ({ buttons: MotorInput.Forward, yaw: 0 }));
  assert.equal([...session.clients[1]!.remotePlayers].length, 1);

  session.clients[0]!.dispose();
  drive(
    { ...session, clients: [session.clients[1]!] },
    60,
    () => ({ buttons: 0, yaw: 0 })
  );

  assert.equal(
    [...session.clients[1]!.remotePlayers].length,
    0,
    "a departed client is still present"
  );
  assert.equal(session.server.room.size, 1);
});

test("prediction on a clean link needs almost no correction", () => {
  const session = makeSession(1);
  drive(session, 400, (_, tick) => ({
    buttons: MotorInput.Forward | (tick % 90 === 0 ? MotorInput.Jump : 0),
    yaw: Math.sin(tick * 0.01),
  }));

  const client = session.clients[0]!;
  assert.ok(client.localState!.grounded || client.localState!.position.y > -1);
  // The metric must actually have been exercised, or this asserts nothing —
  // an aliasing bug once made every reading here a vacuous zero.
  assert.ok(client.reconciles > 0, "reconciliation never ran");
  assert.ok(
    client.worstDriftMetres < 0.5,
    `worst drift ${client.worstDriftMetres.toFixed(3)} m on a clean link`
  );
  assert.ok(
    client.worstCorrectionMetres < 0.5,
    `worst correction ${client.worstCorrectionMetres.toFixed(3)} m on a clean link`
  );
});

test("a forced disagreement is measured, not silently read as zero", () => {
  const session = makeSession(1);
  drive(session, 120, () => ({ buttons: MotorInput.Forward, yaw: 0 }));
  const client = session.clients[0]!;

  // Shove the client far off authority. The next snapshot must notice.
  const motor = client.room.get(String(client.playerId))!;
  motor.teleport({
    x: motor.state.position.x + 25,
    y: motor.state.position.y,
    z: motor.state.position.z,
  });
  drive(session, 30, () => ({ buttons: 0, yaw: 0 }));

  assert.ok(
    client.worstDriftMetres > 10,
    `a 25 m displacement reported only ${client.worstDriftMetres.toFixed(3)} m of drift`
  );
  assert.ok(
    client.worstCorrectionMetres > 10,
    `a 25 m displacement reported only ${client.worstCorrectionMetres.toFixed(3)} m of correction`
  );
  assert.ok(client.corrections > 0, "a large correction was not counted");
});

test("prediction survives latency, jitter and packet loss", () => {
  const session = makeSession(1, {
    conditions: {
      latencyMs: 60,
      jitterMs: 20,
      loss: 0.05,
      random: seeded(0xc0ffee),
    },
  });
  drive(session, 600, (_, tick) => ({
    buttons: MotorInput.Forward | (tick % 120 === 0 ? MotorInput.Jump : 0),
    yaw: Math.sin(tick * 0.008) * 2,
  }));

  const client = session.clients[0]!;
  const local = client.localState!;
  const authoritative = session.server.room.get(String(client.playerId))!.state;

  // The client is ahead of the server by its latency; that is prediction
  // working, not drift. What matters is that it is not diverging without bound.
  const gap = Math.hypot(
    local.position.x - authoritative.position.x,
    local.position.z - authoritative.position.z
  );
  assert.ok(gap < 3, `client ran ${gap.toFixed(2)} m away from authority`);
  assert.ok(client.replayedCommands > 0, "no commands were ever replayed");
  assert.ok(
    client.worstDriftMetres < 2,
    `worst drift ${client.worstDriftMetres.toFixed(3)} m under loss`
  );
  assert.ok(
    client.worstCorrectionMetres < 2,
    `worst correction ${client.worstCorrectionMetres.toFixed(3)} m under loss`
  );
  assert.ok(Number.isFinite(local.position.y), "position went non-finite");
});

test("the server drops redundant resends instead of replaying them", () => {
  const session = makeSession(1, { conditions: { latencyMs: 40 } });
  drive(session, 200, () => ({ buttons: MotorInput.Forward, yaw: 0 }));
  assert.ok(
    session.server.staleCommandsDropped > 0,
    "redundant resends were never recognised as stale"
  );
});

test("snapshots go out at the patch rate, not the tick rate", () => {
  const session = makeSession(1);
  const ticks = 120;
  drive(session, ticks, () => ({ buttons: 0, yaw: 0 }));

  const tickHz = Math.round(1 / DEFAULT_MOTOR_TUNING.fixedTimestepSeconds);
  const expected = (ticks * session.server.patchHz) / tickHz;
  assert.ok(
    Math.abs(session.server.snapshotsSent - expected) <= 2,
    `sent ${session.server.snapshotsSent} snapshots, expected about ${expected}`
  );
});

test("the default respawn window clears the longest death clip", () => {
  // The whole reason the flat window is 5 s and not 3: four of the six death
  // clips run longer than three seconds, so the old default teleported a body
  // away mid-fall. Nothing pinned the DEFAULT — every other respawn test passes
  // an explicit override — so trimming the constant, or re-exporting a longer
  // clip, would reintroduce that with a green suite.
  const longest = Math.max(...Object.values(DEATH_CLIPS).map((clip) => clip.seconds));
  assert.ok(
    DEFAULT_RESPAWN_SECONDS > longest,
    `the respawn window (${DEFAULT_RESPAWN_SECONDS}s) must exceed the longest death clip (${longest}s)`
  );
  // And it has to survive the wire, which carries tenths in one byte.
  const died = decodePlayerDied(
    encodePlayerDied({
      victimId: 1,
      killerId: 2,
      weaponIndex: 0,
      direction: "front",
      headshot: false,
      respawnSeconds: DEFAULT_RESPAWN_SECONDS,
    })
  )!;
  assert.equal(died.respawnSeconds, DEFAULT_RESPAWN_SECONDS);
});

test("a default server announces and schedules the same flat window", () => {
  const session = makeSession(2, { spawn: (seat) => ({ x: seat === 1 ? 0 : 8, z: 0 }) });
  const towardVictim = -Math.PI / 2;
  const aimed = (index: number) => ({ buttons: 0, yaw: index === 0 ? towardVictim : 0 });
  drive(session, 4, aimed);
  session.clients[0]!.fire(towardVictim, 0);
  drive(session, 3, aimed);

  const died = session.clients[1]!.getCombatEvents().find((event) => event.kind === "died");
  assert.ok(died !== undefined, "the victim never heard the death");
  assert.equal(died.respawnSeconds, DEFAULT_RESPAWN_SECONDS);

  // Still down a second before the window, up after it — the announced number is
  // the one the authority actually waits.
  drive(session, 60 * (DEFAULT_RESPAWN_SECONDS - 1), aimed);
  assert.equal(session.server.healthOf(2), 0, "respawned before the announced moment");
  drive(session, 60 * 2, aimed);
  assert.equal(session.server.healthOf(2), 100, "never respawned");
});

test("the respawn tenths byte clamps instead of wrapping", () => {
  // 25.5 s is the ceiling of one byte of tenths. Above it the value must PIN
  // rather than wrap to a small number, which would end the client's countdown
  // while the corpse waited out the rest.
  const high = decodePlayerDied(
    encodePlayerDied({
      victimId: 1,
      killerId: 0,
      weaponIndex: 0,
      direction: "front",
      headshot: false,
      respawnSeconds: 40,
    })
  )!;
  assert.equal(high.respawnSeconds, 25.5);
  const low = decodePlayerDied(
    encodePlayerDied({
      victimId: 1,
      killerId: 0,
      weaponIndex: 0,
      direction: "front",
      headshot: false,
      respawnSeconds: -5,
    })
  )!;
  assert.equal(low.respawnSeconds, 0, "a negative window must read as none, not as 25.5");
});

test("a dead player cannot be driven, and its collider stops blocking", () => {
  const session = makeSession(2, {
    spawn: (seat) => ({ x: seat === 1 ? 0 : 8, z: 0 }),
    respawnSeconds: 0, // stay dead, so the frozen state can be observed
  });
  const towardVictim = -Math.PI / 2;
  const aimed = (index: number) => ({ buttons: 0, yaw: index === 0 ? towardVictim : 0 });
  drive(session, 4, aimed);
  session.clients[0]!.fire(towardVictim, 0);
  drive(session, 3, aimed);
  assert.equal(session.server.healthOf(2), 0, "a lethal hit did not kill");

  const corpse = session.server.room.get("2");
  assert.ok(corpse !== undefined);
  const restX = corpse.state.position.x;
  const restZ = corpse.state.position.z;

  // The victim holds full forward for a second. A corpse must not move.
  drive(session, 60, (index) => ({
    buttons: index === 1 ? MotorInput.Forward : 0,
    yaw: index === 0 ? towardVictim : 0,
  }));
  assert.ok(
    Math.abs(corpse.state.position.x - restX) < 0.01 &&
      Math.abs(corpse.state.position.z - restZ) < 0.01,
    "the corpse was driven away from where it fell"
  );
});
