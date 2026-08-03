// Clip-selection tests for the soldier's locomotion vocabulary.
//
// Pure-logic coverage: the motor movement basis resolved into character-local
// components, the 8-way sectoring including diagonals and wraparound, and the
// stance/gait/airborne mapping — the decisions that would otherwise only fail
// visibly as a soldier running the wrong way on someone else's screen.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CLIP_IDLE,
  CLIP_IDLE_CROUCH,
  CLIP_JUMP_LOOP,
  allSelectableClips,
  chooseClip,
  directionSuffix,
  localizeVelocity,
  type LocomotionSample,
} from "../../src/fps/presentation/characterClips.ts";

const RUN_AT = 3;

function sample(overrides: Partial<LocomotionSample>): LocomotionSample {
  return {
    speed: 0,
    forward: 0,
    left: 0,
    stance: "stand",
    grounded: true,
    sprinting: false,
    aiming: false,
    ...overrides,
  };
}

test("the motor basis resolves into character-local components", () => {
  // Yaw 0 faces world -Z: moving along -Z is straight ahead.
  const ahead = localizeVelocity(0, -5, 0);
  assert.ok(Math.abs(ahead.forward - 5) < 1e-9);
  assert.ok(Math.abs(ahead.left) < 1e-9);

  // Facing -Z, the character's left hand points along -X.
  const leftward = localizeVelocity(-5, 0, 0);
  assert.ok(Math.abs(leftward.left - 5) < 1e-9);
  assert.ok(Math.abs(leftward.forward) < 1e-9);

  // Quarter turn left (yaw +90°) faces -X; moving along -X is now forward.
  const turned = localizeVelocity(-5, 0, Math.PI / 2);
  assert.ok(Math.abs(turned.forward - 5) < 1e-6);
  assert.ok(Math.abs(turned.left) < 1e-6);
});

test("the eight sectors map to the pack's suffixes, including wraparound", () => {
  assert.equal(directionSuffix(1, 0), "Forward");
  assert.equal(directionSuffix(1, 1), "Forward_Left");
  assert.equal(directionSuffix(0, 1), "Left");
  assert.equal(directionSuffix(-1, 1), "Backward_Left");
  assert.equal(directionSuffix(-1, 0), "Backward");
  assert.equal(directionSuffix(-1, -1), "Backward_Right");
  assert.equal(directionSuffix(0, -1), "Right");
  assert.equal(directionSuffix(1, -1), "Forward_Right");
  // Slightly past straight back on the right side must not fall out of range.
  assert.equal(directionSuffix(-1, -0.05), "Backward");
});

test("stance, gait, and airborne mapping", () => {
  assert.equal(chooseClip(sample({}), RUN_AT), CLIP_IDLE);
  assert.equal(chooseClip(sample({ stance: "crouch" }), RUN_AT), CLIP_IDLE_CROUCH);
  // ADS raises the rifle: the aiming idles are what make aim readable at all.
  assert.equal(chooseClip(sample({ aiming: true }), RUN_AT), "Idle_Aiming");
  assert.equal(
    chooseClip(sample({ stance: "crouch", aiming: true }), RUN_AT),
    "Idle_Crouching_Aiming"
  );
  // Prone has no clips in the pack; it must fall back to the crouch set.
  assert.equal(chooseClip(sample({ stance: "prone" }), RUN_AT), CLIP_IDLE_CROUCH);
  assert.equal(
    chooseClip(sample({ stance: "prone", speed: 2, forward: 2 }), RUN_AT),
    "Walk_Crouching_Forward"
  );

  assert.equal(chooseClip(sample({ speed: 1.5, forward: 1.5 }), RUN_AT), "Walk_Forward");
  assert.equal(chooseClip(sample({ speed: 4, forward: 4 }), RUN_AT), "Run_Forward");
  assert.equal(
    chooseClip(sample({ speed: 4, forward: 0, left: -4 }), RUN_AT),
    "Run_Right"
  );
  assert.equal(
    chooseClip(sample({ speed: 7, forward: 7, sprinting: true }), RUN_AT),
    "Sprint_Forward"
  );
  // Sprinting is the resolved state bit and wins over the speed split.
  assert.equal(
    chooseClip(sample({ speed: 1, forward: 1, sprinting: true }), RUN_AT),
    "Sprint_Forward"
  );

  assert.equal(chooseClip(sample({ grounded: false, speed: 5 }), RUN_AT), CLIP_JUMP_LOOP);
});

test("every selectable clip is in the shipped manifest's vocabulary", () => {
  // The manifest ships 49 clips; the selector must not invent names outside
  // the sets it owns. Spot the full cross product is well-formed.
  const names = allSelectableClips();
  assert.equal(new Set(names).size, names.length, "duplicate selectable clip names");
  for (const name of names) {
    assert.match(
      name,
      /^(Idle|Idle_Aiming|Idle_Crouching|Idle_Crouching_Aiming|Jump_Loop|Jump_Down|(Walk|Run|Sprint|Walk_Crouching)_(Forward|Backward|Left|Right|Forward_Left|Forward_Right|Backward_Left|Backward_Right))$/
    );
  }
});
