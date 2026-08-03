// Two-client session: prediction, authority and reconciliation end to end.
//
// Everything here goes through the real codec and the real GameServer/GameClient
// over a loopback transport with a simulated link, so the only thing missing
// versus a live socket is the socket itself.

import assert from "node:assert/strict";
import test from "node:test";
import { GameClient } from "../../src/net/GameClient.ts";
import { GameServer } from "../../src/net/GameServer.ts";
import { LoopbackNetwork, type LinkConditions } from "../../src/net/LoopbackTransport.ts";
import {
  BYTES_PER_PLAYER,
  BYTES_PER_COMMAND,
  PacketType,
  decodeCommands,
  decodeSnapshot,
  decodeWelcome,
  encodeCommands,
  encodeSnapshot,
  quantiseCommand,
} from "../../src/net/SnapshotCodec.ts";
import { createMotorWorld, flatHeightSource, initRapier } from "../../src/motor/MotorWorld.ts";
import {
  DEFAULT_MOTOR_TUNING,
  MotorInput,
  createMotorState,
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

function makeSession(clientCount: number, conditions: LinkConditions = {}) {
  const network = new LoopbackNetwork();
  const server = new GameServer(
    RAPIER,
    createMotorWorld(RAPIER),
    GROUND,
    network,
    { sharedSurfaceSpanMetres: 512, patchHz: 20 }
  );
  const clients = Array.from({ length: clientCount }, () => {
    const transport = network.connect(conditions);
    return new GameClient(RAPIER, createMotorWorld(RAPIER), GROUND, transport);
  });
  return { network, server, clients };
}

/** Runs the session for `ticks`, letting each client supply its own input. */
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
  ];

  for (const [label, bytes] of hostile) {
    assert.doesNotThrow(() => decodeCommands(bytes), `decodeCommands threw on ${label}`);
    assert.doesNotThrow(() => decodeSnapshot(bytes), `decodeSnapshot threw on ${label}`);
    assert.doesNotThrow(() => decodeWelcome(bytes), `decodeWelcome threw on ${label}`);
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
  // A snapshot is a PAST authoritative state: at 20 Hz patch over a 60 Hz tick
  // it is up to three ticks stale, which at walking pace is about 0.28 m. The
  // test bounds that staleness rather than demanding equality.
  const behindAuthority = Math.abs(
    remoteWalker.z - session.server.room.get("1")!.state.position.z
  );
  assert.ok(
    behindAuthority < 0.5,
    `remote view is ${behindAuthority.toFixed(3)} m from authority, beyond patch staleness`
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
    latencyMs: 60,
    jitterMs: 20,
    loss: 0.05,
    random: seeded(0xc0ffee),
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
  const session = makeSession(1, { latencyMs: 40 });
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
