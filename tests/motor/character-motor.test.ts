// Headless motor tests. These run under plain Node with no browser globals,
// which is itself part of what they verify: if the motor ever picks up a DOM,
// camera, or Three.js runtime dependency, this file stops loading.

import assert from "node:assert/strict";
import test from "node:test";
import { CharacterMotor, type CharacterMotorOptions } from "../../src/motor/CharacterMotor.ts";
import { TerrainCollider } from "../../src/motor/TerrainCollider.ts";
import { createMotorWorld, flatHeightSource, initRapier } from "../../src/motor/MotorWorld.ts";
import {
  DEFAULT_MOTOR_TUNING,
  MotorContact,
  MotorInput,
  eyeHeightFor,
  type MotorHeightSource,
  type MotorState,
  type PlayerCommand,
} from "../../src/motor/MotorTypes.ts";

const RAPIER = await initRapier();

function command(overrides: Partial<PlayerCommand> = {}): PlayerCommand {
  return { tick: 0, buttons: 0, yawRadians: 0, pitchRadians: 0, ...overrides };
}

/**
 * A motor plus the world step it does not own. Tests drive this rather than
 * `motor.step` alone, because a motor never advances the world by itself.
 */
interface Rig {
  readonly world: ReturnType<typeof createMotorWorld>;
  readonly motor: CharacterMotor;
  step(entry: PlayerCommand): MotorState;
}

function makeMotor(
  source: MotorHeightSource = flatHeightSource(0),
  options: CharacterMotorOptions = {}
): Rig {
  const world = createMotorWorld(RAPIER);
  const motor = new CharacterMotor(RAPIER, world, source, {
    terrain: { windowCells: 32 },
    ...options,
  });
  world.step();
  return {
    world,
    motor,
    step(entry) {
      const state = motor.step(entry);
      world.step();
      return state;
    },
  };
}

/** Steps until the motor reports grounded, or fails. */
function settle(rig: Rig, ticks = 180): MotorState {
  let state = rig.motor.state;
  for (let tick = 0; tick < ticks; tick += 1) {
    state = rig.step(command({ tick }));
    if (state.grounded && tick > 4) return state;
  }
  assert.fail(`motor never became grounded within ${ticks} ticks`);
}

function run(rig: Rig, ticks: number, buttons: number, yaw = 0): MotorState {
  let state = rig.motor.state;
  for (let tick = 0; tick < ticks; tick += 1) {
    state = rig.step(command({ tick, buttons, yawRadians: yaw }));
  }
  return state;
}

test("terrain collider reproduces the source field, not its transpose", () => {
  const world = createMotorWorld(RAPIER);
  // Deliberately asymmetric in x and z: a transposed build fails immediately.
  const source: MotorHeightSource = {
    cellSize: 2,
    sample: (x, z) => 0.5 * x + 0.125 * z,
  };
  const terrain = new TerrainCollider(RAPIER, world, source, { windowCells: 16 });
  terrain.update(0, 0);
  world.step();

  for (const [x, z] of [
    [0, 0],
    [6, -4],
    [-6, 10],
    [4, 4],
  ] as const) {
    const hit = world.castRay(new RAPIER.Ray({ x, y: 60, z }, { x: 0, y: -1, z: 0 }), 200, true);
    assert.ok(hit !== null, `no terrain under ${x},${z}`);
    const surface = 60 - hit.timeOfImpact;
    assert.ok(
      Math.abs(surface - source.sample(x, z)) < 1e-3,
      `at ${x},${z} collider says ${surface}, field says ${source.sample(x, z)}`
    );
  }
});

test("subdividing the lattice narrows the gap to the bilinear surface", () => {
  // A saddle-shaped cell is the worst case for triangles-versus-bilinear: the
  // two surfaces agree at all four corners and differ most at the centre.
  const saddle: MotorHeightSource = {
    cellSize: 4,
    sample: (x, z) => Math.sin((x * Math.PI) / 8) * Math.sin((z * Math.PI) / 8) * 6,
  };

  const worstGapAt = (subdivision: number): number => {
    const world = createMotorWorld(RAPIER);
    const terrain = new TerrainCollider(RAPIER, world, saddle, {
      windowCells: 16,
      subdivision,
    });
    terrain.update(0, 0);
    world.step();

    let worst = 0;
    for (let step = 0; step < 400; step += 1) {
      const x = ((step % 20) - 10) * 1.37;
      const z = (Math.floor(step / 20) - 10) * 1.41;
      const hit = world.castRay(new RAPIER.Ray({ x, y: 60, z }, { x: 0, y: -1, z: 0 }), 200, true);
      if (hit === null) continue;
      worst = Math.max(worst, Math.abs(60 - hit.timeOfImpact - saddle.sample(x, z)));
    }
    return worst;
  };

  const coarse = worstGapAt(1);
  const fine = worstGapAt(2);
  assert.ok(coarse > 0.05, `expected a measurable gap at 1x, got ${coarse.toFixed(4)} m`);
  assert.ok(
    fine < coarse * 0.5,
    `subdivision did not help: ${coarse.toFixed(4)} m -> ${fine.toFixed(4)} m`
  );
});

test("walking straight across flat ground never stalls on a lattice seam", () => {
  // Axis-aligned motion over coplanar heightfield triangles is the case that
  // exposed this: snap-to-ground resolved against a seam and returned zero
  // movement for a single tick. Six full stops per 2000 ticks at 1x lattice,
  // thirty at 2x. Turning while walking hides it, so this walks dead straight.
  const rig = makeMotor(flatHeightSource(0), { terrain: { windowCells: 64 } });
  settle(rig);

  let stalls = 0;
  for (let tick = 0; tick < 1500; tick += 1) {
    rig.step(command({ tick, buttons: MotorInput.Forward }));
    if (tick < 80) continue;
    const speed = Math.hypot(rig.motor.state.velocity.x, rig.motor.state.velocity.z);
    if (speed < 4) stalls += 1;
  }
  assert.equal(stalls, 0, `${stalls} single-tick stalls while walking flat ground`);
});

test("a steep descent is followed without going ballistic", () => {
  // The other half of the same trade: snap-to-ground is switched off on level
  // ground, so it must still engage where it is actually needed.
  const ramp: MotorHeightSource = { cellSize: 2, sample: (_x, z) => z * 1.0 };
  const rig = makeMotor(ramp, { terrain: { windowCells: 64 } });
  settle(rig);

  let airborne = 0;
  let worstFloat = 0;
  for (let tick = 0; tick < 900; tick += 1) {
    rig.step(command({ tick, buttons: MotorInput.Forward }));
    if (tick < 80) continue;
    if (!rig.motor.state.grounded) airborne += 1;
    const { x, y, z } = rig.motor.state.position;
    worstFloat = Math.max(worstFloat, y - ramp.sample(x, z));
  }
  assert.equal(airborne, 0, `left the ground for ${airborne} ticks walking down a 45 degree slope`);
  assert.ok(worstFloat < 0.4, `feet floated ${worstFloat.toFixed(3)} m above the ramp`);
});

test("falls onto flat ground and settles with feet at the surface", () => {
  const rig = makeMotor(flatHeightSource(12));
  const state = settle(rig);
  assert.ok(state.grounded);
  assert.ok(
    Math.abs(state.position.y - 12) < 0.05,
    `feet settled at ${state.position.y}, expected ~12`
  );
  assert.ok(Math.abs(state.velocity.y) < 1e-6);
  assert.equal(state.contactFlags & MotorContact.Grounded, MotorContact.Grounded);
});

test("walks forward along -Z at yaw zero and reaches the stance speed", () => {
  const rig = makeMotor();
  settle(rig);
  const start = rig.motor.state.position.z;
  const state = run(rig, 120, MotorInput.Forward);

  assert.ok(state.position.z < start - 1, `expected -Z travel, moved to ${state.position.z}`);
  assert.ok(Math.abs(state.position.x) < 0.05, `drifted in x to ${state.position.x}`);
  const speed = Math.hypot(state.velocity.x, state.velocity.z);
  assert.ok(
    Math.abs(speed - DEFAULT_MOTOR_TUNING.stances.stand.speed) < 0.3,
    `walk speed ${speed}, expected ~${DEFAULT_MOTOR_TUNING.stances.stand.speed}`
  );
});

test("yaw rotates the movement basis", () => {
  const rig = makeMotor();
  settle(rig);
  const from = { x: rig.motor.state.position.x, z: rig.motor.state.position.z };
  // Yaw +90 degrees should send "forward" along -X.
  const state = run(rig, 90, MotorInput.Forward, Math.PI / 2);
  assert.ok(state.position.x < from.x - 1, `expected -X travel, got ${state.position.x}`);
  assert.ok(Math.abs(state.position.z - from.z) < 0.2, `unexpected z drift ${state.position.z}`);
});

test("crouch and prone reduce speed and eye height", () => {
  const results = new Map<string, { speed: number; eye: number }>();
  for (const [label, buttons] of [
    ["stand", 0],
    ["crouch", MotorInput.Crouch],
    ["prone", MotorInput.Prone],
  ] as const) {
    const rig = makeMotor();
    settle(rig);
    const state = run(rig, 150, MotorInput.Forward | buttons);
    results.set(label, {
      speed: Math.hypot(state.velocity.x, state.velocity.z),
      eye: eyeHeightFor(state, DEFAULT_MOTOR_TUNING),
    });
  }

  const stand = results.get("stand")!;
  const crouch = results.get("crouch")!;
  const prone = results.get("prone")!;
  assert.ok(crouch.speed < stand.speed, `crouch ${crouch.speed} not slower than stand ${stand.speed}`);
  assert.ok(prone.speed < crouch.speed, `prone ${prone.speed} not slower than crouch ${crouch.speed}`);
  assert.ok(crouch.eye < stand.eye && prone.eye < crouch.eye);
  assert.ok(Math.abs(stand.eye - DEFAULT_MOTOR_TUNING.stances.stand.eye) < 1e-6);
});

test("a low ceiling blocks standing up and reports it", () => {
  const rig = makeMotor();
  settle(rig);
  run(rig, 30, MotorInput.Crouch);
  assert.equal(rig.motor.state.stance, "crouch");

  // Slab just above the crouched head, well below standing height.
  const ceiling = rig.world.createRigidBody(
    RAPIER.RigidBodyDesc.fixed().setTranslation(
      rig.motor.state.position.x,
      rig.motor.state.position.y + 1.3,
      rig.motor.state.position.z
    )
  );
  rig.world.createCollider(RAPIER.ColliderDesc.cuboid(3, 0.2, 3), ceiling);
  rig.world.step();

  const blockedState = run(rig, 10, 0);
  assert.equal(blockedState.stance, "crouch", "stood up through a ceiling");
  assert.equal(
    blockedState.contactFlags & MotorContact.CeilingBlocked,
    MotorContact.CeilingBlocked,
    "blocked stand-up did not set CeilingBlocked"
  );

  rig.world.removeRigidBody(ceiling);
  rig.world.step();
  const freeState = run(rig, 10, 0);
  assert.equal(freeState.stance, "stand", "did not stand once the ceiling was removed");
});

test("jump leaves the ground and lands again", () => {
  const rig = makeMotor();
  settle(rig);
  const groundY = rig.motor.state.position.y;

  let peak = groundY;
  let leftGround = false;
  for (let tick = 0; tick < 120; tick += 1) {
    // Jump held only on the first tick; the rest is ballistic.
    rig.step(command({ tick, buttons: tick === 0 ? MotorInput.Jump : 0 }));
    if (!rig.motor.state.grounded) leftGround = true;
    peak = Math.max(peak, rig.motor.state.position.y);
  }

  assert.ok(leftGround, "jump never left the ground — snap-to-ground likely ate it");
  assert.ok(peak > groundY + 0.5, `jump only reached ${(peak - groundY).toFixed(3)} m`);
  assert.ok(rig.motor.state.grounded, "never landed");
  assert.ok(Math.abs(rig.motor.state.position.y - groundY) < 0.05, "landed at the wrong height");
});

test("walks up a gentle slope and is stopped by a steep one", () => {
  const gentle: MotorHeightSource = { cellSize: 2, sample: (x) => -x * 0.25 };
  const cliff: MotorHeightSource = { cellSize: 2, sample: (x) => -x * 4 };

  const climbed = (() => {
    const rig = makeMotor(gentle);
    settle(rig);
    const from = rig.motor.state.position.y;
    // Yaw +90 walks toward -X, which is uphill for both fields.
    const state = run(rig, 180, MotorInput.Forward, Math.PI / 2);
    return state.position.y - from;
  })();

  const scaled = (() => {
    const rig = makeMotor(cliff);
    settle(rig);
    const from = rig.motor.state.position.x;
    const state = run(rig, 180, MotorInput.Forward, Math.PI / 2);
    return from - state.position.x;
  })();

  assert.ok(climbed > 1, `expected to climb the gentle slope, gained ${climbed.toFixed(2)} m`);
  assert.ok(scaled < 2, `walked ${scaled.toFixed(2)} m into a slope past the climb limit`);
});

test("climbing speed falls off smoothly instead of hitting a dead stop", () => {
  // The bug this pins: recovering horizontal velocity from the solved movement
  // collapses it to zero on any rise, because the solver redirects the request
  // upward and returns almost no horizontal motion. Everything between 20 and
  // 60 degrees became impassable while the configured limit still read 65.
  //
  // A single gentle gradient does not catch it — the old test used one and
  // passed throughout — so this sweeps the range and requires the profile to
  // stay monotonic and non-zero.
  const walk = DEFAULT_MOTOR_TUNING.stances.stand.speed;
  const measured: Array<{ degrees: number; fraction: number }> = [];

  for (const degrees of [10, 20, 30, 40, 50]) {
    const gradient = Math.tan((degrees * Math.PI) / 180);
    const ramp: MotorHeightSource = { cellSize: 2, sample: (_x, z) => -z * gradient };
    const rig = makeMotor(ramp, { terrain: { windowCells: 128 } });
    settle(rig);

    const from = { y: rig.motor.state.position.y, z: rig.motor.state.position.z };
    const ticks = 240;
    for (let tick = 0; tick < ticks; tick += 1) {
      rig.step(command({ tick, buttons: MotorInput.Forward }));
    }
    const climbed = rig.motor.state.position.y - from.y;
    const travelled = Math.abs(rig.motor.state.position.z - from.z);
    const alongSlope = Math.hypot(climbed, travelled) / (ticks / 60);
    measured.push({ degrees, fraction: alongSlope / walk });

    assert.ok(climbed > 1, `${degrees} deg: climbed only ${climbed.toFixed(2)} m in 4 s`);
  }

  // A walkable slope must never cost more than the slope itself justifies.
  for (const { degrees, fraction } of measured) {
    assert.ok(
      fraction > 0.15,
      `${degrees} deg: moving at ${(fraction * 100).toFixed(0)}% of walk speed, effectively stuck`
    );
  }
  // Steeper must never be faster; that inversion was the symptom.
  for (let index = 1; index < measured.length; index += 1) {
    assert.ok(
      measured[index]!.fraction <= measured[index - 1]!.fraction + 0.02,
      `speed rose from ${measured[index - 1]!.degrees} to ${measured[index]!.degrees} deg`
    );
  }
});

test("a wall stops horizontal travel and sets WallContact", () => {
  const rig = makeMotor();
  settle(rig);
  const wall = rig.world.createRigidBody(
    RAPIER.RigidBodyDesc.fixed().setTranslation(0, rig.motor.state.position.y + 1.5, -4)
  );
  rig.world.createCollider(RAPIER.ColliderDesc.cuboid(6, 3, 0.3), wall);
  rig.world.step();

  const state = run(rig, 150, MotorInput.Forward);
  assert.ok(state.position.z > -4, `walked through the wall to z=${state.position.z}`);
  assert.equal(
    state.contactFlags & MotorContact.WallContact,
    MotorContact.WallContact,
    "pressing into a wall did not set WallContact"
  );
});

test("the terrain window re-centres without moving the surface underfoot", () => {
  const rolling: MotorHeightSource = {
    cellSize: 2,
    sample: (x, z) => Math.sin(x * 0.02) * 3 + Math.cos(z * 0.03) * 2,
  };
  const rig = makeMotor(rolling);
  settle(rig);
  const rebuildsAtStart = (rig.motor.terrain as TerrainCollider).rebuildCount;

  let worstGap = 0;
  for (let tick = 0; tick < 900; tick += 1) {
    rig.step(command({ tick, buttons: MotorInput.Forward }));
    if (!rig.motor.state.grounded) continue;
    const { x, y, z } = rig.motor.state.position;
    worstGap = Math.max(worstGap, Math.abs(y - rolling.sample(x, z)));
  }

  assert.ok(
    (rig.motor.terrain as TerrainCollider).rebuildCount > rebuildsAtStart,
    "walked far enough to re-centre but never rebuilt"
  );
  assert.ok(rig.motor.state.grounded, "lost the ground across a window rebuild");
  assert.ok(worstGap < 0.35, `feet drifted ${worstGap.toFixed(3)} m from the field`);
});

test("the same command stream replays to the same state in one runtime", () => {
  const source: MotorHeightSource = {
    cellSize: 2,
    sample: (x, z) => Math.sin(x * 0.05) * 2 + Math.cos(z * 0.04) * 1.5,
  };
  const script: PlayerCommand[] = [];
  for (let tick = 0; tick < 400; tick += 1) {
    script.push({
      tick,
      buttons:
        (tick % 7 < 4 ? MotorInput.Forward : MotorInput.Right) |
        (tick % 53 === 0 ? MotorInput.Jump : 0) |
        (tick > 200 && tick < 260 ? MotorInput.Crouch : 0),
      yawRadians: Math.sin(tick * 0.01) * 0.8,
      pitchRadians: 0,
    });
  }

  const replay = () => {
    const rig = makeMotor(source);
    for (const entry of script) rig.step(entry);
    const { position, velocity, stance } = rig.motor.state;
    return { ...position, vx: velocity.x, vy: velocity.y, vz: velocity.z, stance };
  };

  assert.deepEqual(replay(), replay());
});

test("motor state stays serializable across a JSON round trip", () => {
  const rig = makeMotor();
  settle(rig);
  run(rig, 40, MotorInput.Forward | MotorInput.Crouch);
  const wire = JSON.parse(JSON.stringify(rig.motor.state)) as MotorState;

  assert.deepEqual(wire, rig.motor.state);
  assert.equal(typeof wire.tick, "number");
  assert.ok(Number.isFinite(wire.position.x + wire.position.y + wire.position.z));
  assert.ok(eyeHeightFor(wire, DEFAULT_MOTOR_TUNING) > 0);
});
