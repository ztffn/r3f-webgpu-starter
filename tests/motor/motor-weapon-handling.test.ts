// The motor-to-weapon seam.
//
// The dispersion formula and the motor are each covered on their own. What was
// never covered is the join: that a REAL motor's state, fed through the
// handling context, actually changes where rounds go. That gap is exactly how
// `grounded` stayed wrong in the running game for so long — the formula's
// airborne term was tested, the motor knew it was airborne, and nothing
// connected the two.
//
// These tests drive an actual CharacterMotor and feed its output to the real
// `calculateDispersionConeRadians`, so a regression in either the motor's
// reporting or the wiring's meaning shows up here.

import assert from "node:assert/strict";
import test from "node:test";
import { CharacterMotor } from "../../src/motor/CharacterMotor.ts";
import { createMotorWorld, flatHeightSource, initRapier } from "../../src/motor/MotorWorld.ts";
import { MotorInput, type MotorState, type PlayerCommand } from "../../src/motor/MotorTypes.ts";
import { calculateDispersionConeRadians } from "../../src/fps/weapons/WeaponHandling.ts";
import type { WeaponAccuracyDefinition } from "../../src/fps/weapons/WeaponDefinition.ts";

const RAPIER = await initRapier();

/** Shaped like the sniper entry in `weaponDefinitions.ts`. */
const ACCURACY: WeaponAccuracyDefinition = {
  mechanicalDispersionRadians: 0.00025,
  hipDispersionRadians: 0.006,
  movementDispersionRadians: 0.008,
  airborneDispersionRadians: 0.012,
};

function makeMotor() {
  const world = createMotorWorld(RAPIER);
  const motor = new CharacterMotor(RAPIER, world, flatHeightSource(0), {
    terrain: { windowCells: 64 },
  });
  world.step();
  return {
    motor,
    step(entry: PlayerCommand) {
      motor.step(entry);
      world.step();
      return motor.state;
    },
  };
}

function command(tick: number, buttons = 0): PlayerCommand {
  return { tick, buttons, yawRadians: 0, pitchRadians: 0 };
}

/** Exactly the composition `WeaponPrototype` performs from a motor pose. */
function coneFor(state: MotorState, adsProgress = 0): number {
  return calculateDispersionConeRadians(
    ACCURACY,
    adsProgress,
    0,
    state.stance,
    state.grounded,
    Math.hypot(state.velocity.x, state.velocity.z),
    0,
    1
  );
}

test("a motor that is actually airborne widens the cone", () => {
  const rig = makeMotor();
  for (let tick = 0; tick < 90; tick += 1) rig.step(command(tick));
  assert.ok(rig.motor.state.grounded, "did not settle before jumping");
  const standing = coneFor(rig.motor.state);

  let airborneCone = 0;
  let sawAirborne = false;
  for (let tick = 0; tick < 60; tick += 1) {
    const state = rig.step(command(tick, tick === 0 ? MotorInput.Jump : 0));
    if (!state.grounded) {
      sawAirborne = true;
      airborneCone = coneFor(state);
      break;
    }
  }

  assert.ok(sawAirborne, "the motor never reported leaving the ground");
  assert.ok(
    airborneCone > standing,
    `airborne cone ${airborneCone.toFixed(5)} did not exceed standing ${standing.toFixed(5)}`
  );
});

test("stance from the motor orders the cone the way handling intends", () => {
  const cones = new Map<string, number>();
  for (const [label, buttons] of [
    ["stand", 0],
    ["crouch", MotorInput.Crouch],
    ["prone", MotorInput.Prone],
  ] as const) {
    const rig = makeMotor();
    let state = rig.motor.state;
    for (let tick = 0; tick < 120; tick += 1) state = rig.step(command(tick, buttons));
    assert.equal(state.stance, label);
    // Compared at rest, so only the stance term differs.
    cones.set(label, coneFor({ ...state, velocity: { x: 0, y: 0, z: 0 } }));
  }

  assert.ok(cones.get("crouch")! < cones.get("stand")!);
  assert.ok(cones.get("prone")! < cones.get("crouch")!);
});

test("the motor's own velocity widens the cone versus standing still", () => {
  const rig = makeMotor();
  let state = rig.motor.state;
  for (let tick = 0; tick < 90; tick += 1) state = rig.step(command(tick));
  const stationary = coneFor(state);

  for (let tick = 0; tick < 120; tick += 1) state = rig.step(command(tick, MotorInput.Forward));
  assert.ok(state.grounded, "left the ground while walking flat");
  assert.ok(
    Math.hypot(state.velocity.x, state.velocity.z) > 4,
    "never reached walking speed, so this asserts nothing"
  );
  assert.ok(
    coneFor(state) > stationary,
    "walking at full speed did not widen the cone versus standing still"
  );
});
