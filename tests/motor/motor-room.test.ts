// Room-level behaviour: many motors, one world, one step per tick.
// The room is what both sides of the network actually run, so these tests
// stand in for "does a server tick work" before any transport exists.

import assert from "node:assert/strict";
import test from "node:test";
import { MotorRoom, type RoomSnapshot } from "../../src/motor/MotorRoom.ts";
import { createMotorWorld, flatHeightSource, initRapier } from "../../src/motor/MotorWorld.ts";
import {
  MotorInput,
  type MotorHeightSource,
  type PlayerCommand,
} from "../../src/motor/MotorTypes.ts";

const RAPIER = await initRapier();

function makeRoom(source: MotorHeightSource = flatHeightSource(0), span?: number) {
  const world = createMotorWorld(RAPIER);
  return new MotorRoom(RAPIER, world, source, {
    ...(span !== undefined ? { sharedSurfaceSpanMetres: span } : {}),
  });
}

function idle(tick: number, buttons = 0): PlayerCommand {
  return { tick, buttons, yawRadians: 0, pitchRadians: 0 };
}

test("a room of one settles its player on the shared surface", () => {
  const room = makeRoom(flatHeightSource(5), 256);
  room.add("solo", { x: 0, z: 0 });
  const commands = new Map<string, PlayerCommand>();

  for (let tick = 0; tick < 120; tick += 1) {
    commands.set("solo", idle(tick));
    room.step(commands);
  }

  const state = room.get("solo")!.state;
  assert.ok(state.grounded, "player never landed on the shared surface");
  assert.ok(Math.abs(state.position.y - 5) < 0.05, `feet at ${state.position.y}, expected ~5`);
  assert.equal(room.tick, 120);
});

test("players in one room share a world and collide with each other", () => {
  const room = makeRoom(flatHeightSource(0), 256);
  room.add("a", { x: 0, z: 0 });
  room.add("b", { x: 0, z: -1.0 });
  const commands = new Map<string, PlayerCommand>();

  for (let tick = 0; tick < 60; tick += 1) {
    commands.set("a", idle(tick));
    commands.set("b", idle(tick));
    room.step(commands);
  }

  // A walks into B along -Z. B holds still. They must not occupy one spot.
  for (let tick = 0; tick < 180; tick += 1) {
    commands.set("a", idle(tick, MotorInput.Forward));
    commands.set("b", idle(tick));
    room.step(commands);
  }

  const a = room.get("a")!.state.position;
  const b = room.get("b")!.state.position;
  const gap = Math.hypot(a.x - b.x, a.z - b.z);
  assert.ok(gap > 0.4, `players interpenetrated: centres ${gap.toFixed(3)} m apart`);
});

test("a player with no command this tick still falls", () => {
  const room = makeRoom(flatHeightSource(0), 256);
  room.add("dropped", { x: 0, y: 20, z: 0 });
  const empty = new Map<string, PlayerCommand>();

  const startY = room.get("dropped")!.state.position.y;
  for (let tick = 0; tick < 60; tick += 1) room.step(empty);
  const endY = room.get("dropped")!.state.position.y;

  assert.ok(endY < startY - 1, `a command-less player did not fall: ${startY} -> ${endY}`);
});

test("an idle tick preserves the player's last look angles", () => {
  const room = makeRoom(flatHeightSource(0), 256);
  room.add("p", { x: 0, z: 0 });
  const commands = new Map<string, PlayerCommand>();

  commands.set("p", { tick: 0, buttons: 0, yawRadians: 1.25, pitchRadians: -0.4 });
  room.step(commands);
  room.step(new Map());

  const state = room.get("p")!.state;
  assert.equal(state.yawRadians, 1.25, "a dropped packet snapped the yaw");
  assert.equal(state.pitchRadians, -0.4, "a dropped packet snapped the pitch");
});

test("removing a player takes them out of the room and the world", () => {
  const room = makeRoom(flatHeightSource(0), 256);
  room.add("a", { x: 0, z: 0 });
  room.add("b", { x: 4, z: 0 });
  assert.equal(room.size, 2);

  room.remove("a");
  assert.equal(room.size, 1);
  assert.equal(room.get("a"), undefined);

  const commands = new Map<string, PlayerCommand>();
  for (let tick = 0; tick < 30; tick += 1) {
    commands.set("b", idle(tick));
    room.step(commands);
  }
  assert.ok(room.get("b")!.state.grounded, "surviving player broke after a removal");
});

test("a room snapshot is serializable and covers every player", () => {
  const room = makeRoom(flatHeightSource(3), 256);
  for (const id of ["a", "b", "c"]) room.add(id, { x: Number(id.charCodeAt(0)) % 5, z: 0 });
  const commands = new Map<string, PlayerCommand>();
  for (let tick = 0; tick < 90; tick += 1) {
    for (const id of room.playerIds) commands.set(id, idle(tick, MotorInput.Forward));
    room.step(commands);
  }

  const target: RoomSnapshot = { tick: 0, players: [] };
  room.snapshotInto(target);
  assert.equal(target.players.length, 3);
  assert.equal(target.tick, room.tick);

  const wire = JSON.parse(JSON.stringify(target)) as RoomSnapshot;
  assert.deepEqual(wire, target);
  for (const player of wire.players) {
    assert.ok(player.state.grounded, `${player.id} was not grounded in the snapshot`);
  }
});
