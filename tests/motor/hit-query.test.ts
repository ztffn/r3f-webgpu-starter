// Ray-versus-capsule and ray-versus-terrain, the server's shot resolution.
//
// Pure geometry, so these run without Rapier and without a room. The cases that
// matter are the ones a naive sphere hitbox gets wrong — a prone body at range, a
// shot at the feet, and a target behind a hill — because each of those failures is
// invisible in a one-player test and reads as "hit registration is broken" in play.

import assert from "node:assert/strict";
import test from "node:test";
import { capsuleRayDistance, terrainRayDistance } from "../../src/motor/HitQuery.ts";
import {
  DEFAULT_MOTOR_TUNING,
  blendedStanceDimension,
  createMotorState,
  type MotorHeightSource,
  type MotorState,
} from "../../src/motor/MotorTypes.ts";

const TUNING = DEFAULT_MOTOR_TUNING;
const STAND = TUNING.stances.stand;

/** A standing body at the origin, feet on y=0. */
function standing(x = 0, y = 0, z = 0, stance: MotorState["stance"] = "stand"): MotorState {
  const state = createMotorState();
  state.position.x = x;
  state.position.y = y;
  state.position.z = z;
  state.stance = stance;
  state.previousStance = stance;
  state.stanceProgress = 1;
  return state;
}

function flat(height: number): MotorHeightSource {
  return { cellSize: 2, sample: () => height };
}

test("a level shot at chest height hits a standing capsule", () => {
  const chest = 1.3;
  const distance = capsuleRayDistance(
    -10, chest, 0,
    1, 0, 0,
    0, 0, 0,
    STAND.radius, STAND.height
  );
  assert.ok(distance !== null, "a chest-height shot missed a standing body");
  // Enters at the near side of the capsule, one radius before the spine.
  assert.ok(
    Math.abs(distance - (10 - STAND.radius)) < 1e-6,
    `entered at ${distance?.toFixed(4)}, expected ${(10 - STAND.radius).toFixed(4)}`
  );
});

test("a shot over the head and one under the feet both miss", () => {
  const over = capsuleRayDistance(-10, STAND.height + 0.5, 0, 1, 0, 0, 0, 0, 0, STAND.radius, STAND.height);
  assert.equal(over, null, "a shot above the head connected");
  const under = capsuleRayDistance(-10, -0.5, 0, 1, 0, 0, 0, 0, 0, STAND.radius, STAND.height);
  assert.equal(under, null, "a shot below the feet connected");
});

test("the capsule caps are solid, not just the cylinder between them", () => {
  // Straight down onto the top of the head. The cylinder test alone cannot catch
  // this — the ray never leaves the spine's axis — so a cylinder-only hitbox makes
  // every shot from above pass through.
  const fromAbove = capsuleRayDistance(
    0, 10, 0,
    0, -1, 0,
    0, 0, 0,
    STAND.radius, STAND.height
  );
  assert.ok(fromAbove !== null, "a shot straight down through the head missed");
  assert.ok(Math.abs(fromAbove - (10 - STAND.height)) < 1e-6);

  // And straight up into the soles.
  const fromBelow = capsuleRayDistance(0, -5, 0, 0, 1, 0, 0, 0, 0, STAND.radius, STAND.height);
  assert.ok(fromBelow !== null, "a shot straight up into the feet missed");
});

test("a prone body is hittable low and invisible at standing chest height", () => {
  // The pillar of the game is prone concealment, so this is the case that must not
  // silently regress: a prone player has to be a genuinely smaller target, not a
  // standing capsule wearing a different label.
  const prone = TUNING.stances.prone;
  const low = capsuleRayDistance(-10, prone.height * 0.5, 0, 1, 0, 0, 0, 0, 0, prone.radius, prone.height);
  assert.ok(low !== null, "a low shot missed a prone body");

  const chest = capsuleRayDistance(-10, 1.3, 0, 1, 0, 0, 0, 0, 0, prone.radius, prone.height);
  assert.equal(chest, null, "a standing-height shot hit a prone body");
  assert.ok(prone.height < STAND.height, "prone is not shorter than standing");
});

test("a stance mid-transition is the size the simulation says, not either endpoint", () => {
  const halfway = standing(0, 0, 0, "prone");
  halfway.previousStance = "stand";
  halfway.stanceProgress = 0.5;

  const blended = (TUNING.stances.stand.height + TUNING.stances.prone.height) * 0.5;
  const radius = blendedStanceDimension(halfway, TUNING, "radius");
  const height = blendedStanceDimension(halfway, TUNING, "height");
  // Just under the blended height connects; just over it does not.
  const hit = capsuleRayDistance(-10, blended - 0.1, 0, 1, 0, 0, 0, 0, 0, radius, height);
  assert.ok(hit !== null, "a mid-transition body was not hit at its blended height");
  const miss = capsuleRayDistance(-10, blended + 0.3, 0, 1, 0, 0, 0, 0, 0, radius, height);
  assert.equal(miss, null, "a mid-transition body was hit above its blended height");
});

test("terrain stops a ray, and a ray already underground reports zero", () => {
  const ground = flat(10);
  // Angled down from above: crosses y=10 at 5 m along a 45-degree descent.
  const root2 = Math.SQRT1_2;
  const distance = terrainRayDistance(0, 15, 0, root2, -root2, 0, 100, ground);
  assert.ok(distance !== null, "a ray into the ground did not stop");
  assert.ok(
    Math.abs(distance - 5 / root2) < 0.05,
    `stopped at ${distance?.toFixed(3)}, expected about ${(5 / root2).toFixed(3)}`
  );

  assert.equal(terrainRayDistance(0, 5, 0, 1, 0, 0, 100, ground), 0, "a ray under the ground marched out of it");
  // Level, above the ground, never descends: no hit at all rather than a false one.
  assert.equal(terrainRayDistance(0, 15, 0, 1, 0, 0, 100, ground), null);
});
