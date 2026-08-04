// The authority's ballistic stack, without a room: the server world query over
// capsules and terrain, the near-field hitscan walk, its parity with the shared
// projectile integrator at the horizon, the rewind ring, and the new wire
// claims. Everything here is Three-free and Rapier-free on purpose — these are
// the pieces that must agree with the client's model, so they are exercised as
// the same pure functions the client imports.

import assert from "node:assert/strict";
import test from "node:test";
import { capsuleNormalAt, terrainNormalAt } from "../../src/motor/HitQuery.ts";
import { DEFAULT_MOTOR_TUNING, type MotorHeightSource } from "../../src/motor/MotorTypes.ts";
import { ServerWorldQuery, type CapsuleCandidate } from "../../src/net/ServerWorldQuery.ts";
import { StateHistory } from "../../src/net/StateHistory.ts";
import {
  decodeFire,
  decodeReload,
  decodeSelectWeapon,
  decodeShotFired,
  decodeWorldTargets,
  encodeFire,
  encodeReload,
  encodeSelectWeapon,
  encodeShotFired,
  encodeWorldTargets,
} from "../../src/net/SnapshotCodec.ts";
import {
  flatFireElapsedSeconds,
  flatFireSpeedAt,
  hitscanHorizonMetres,
  resolveHitscanShot,
} from "../../src/combat/HitscanBallistics.ts";
import { BallisticProjectileSystem } from "../../src/combat/BallisticProjectileSystem.ts";
import { AMMUNITION_DEFINITIONS } from "../../src/combat/AmmunitionDefinition.ts";
import { HealthDamageable, type Damageable } from "../../src/combat/Damageable.ts";

const STAND = DEFAULT_MOTOR_TUNING.stances.stand;

function capsule(id: number, x: number, z = 0): CapsuleCandidate {
  return { id, feetX: x, feetY: 0, feetZ: z, radius: STAND.radius, height: STAND.height };
}

function queryOver(
  capsules: CapsuleCandidate[],
  heights: MotorHeightSource | null,
  damageables: Map<number, Damageable> = new Map()
): ServerWorldQuery {
  return new ServerWorldQuery(
    heights,
    () => capsules,
    (id) => damageables.get(id) ?? null
  );
}

test("capsule normals are radial on the wall and polar on the caps", () => {
  const side = capsuleNormalAt(-STAND.radius, 1.0, 0, 0, 0, 0, STAND.radius, STAND.height);
  assert.ok(Math.abs(side.x - -1) < 1e-9 && Math.abs(side.y) < 1e-9 && Math.abs(side.z) < 1e-9);
  const top = capsuleNormalAt(0, STAND.height, 0, 0, 0, 0, STAND.radius, STAND.height);
  assert.ok(Math.abs(top.y - 1) < 1e-9, "the crown of the head must point up");
  const length = Math.hypot(side.x, side.y, side.z);
  assert.ok(Math.abs(length - 1) < 1e-9, "normals must be unit length");
});

test("terrain normals lean against the slope and stay unit length", () => {
  const slope: MotorHeightSource = { cellSize: 1, sample: (x) => x * 0.5 };
  const normal = terrainNormalAt(slope, 10, 3);
  assert.ok(normal.x < 0, "an uphill-in-x slope must push the normal toward -x");
  assert.ok(normal.y > 0);
  assert.ok(Math.abs(normal.z) < 1e-9);
  assert.ok(Math.abs(Math.hypot(normal.x, normal.y, normal.z) - 1) < 1e-9);
});

test("the server query returns the nearest capsule with flesh identity, and honors exclusion", () => {
  const query = queryOver([capsule(1, 5), capsule(2, 9)], null);
  const hit = query.raycast({ x: 0, y: 1, z: 0 }, { x: 1, y: 0, z: 0 }, 100);
  assert.ok(hit, "a chest-height ray down a line of players missed");
  assert.equal(hit.objectId, "1");
  assert.equal(hit.kind, "target");
  assert.equal(hit.surfaceId, "flesh");
  assert.ok(Math.abs(hit.penetrationThicknessMetres - STAND.radius * 2) < 1e-9);
  assert.ok(hit.normal !== null && hit.normal.x < -0.99, "entry normal must face the shooter");

  // The shooter's own capsule is skipped for the whole flight; the ray leaves
  // from inside it, so without the exclusion this is a guaranteed self-hit.
  const fromInside = queryOver([capsule(1, 0), capsule(2, 9)], null);
  const past = fromInside.raycast({ x: 0, y: 1, z: 0 }, { x: 1, y: 0, z: 0 }, 100, "1");
  assert.ok(past, "excluding the shooter must not exclude everyone");
  assert.equal(past.objectId, "2");
});

test("a hill occludes the capsule behind it and reports terrain", () => {
  const wall: MotorHeightSource = {
    cellSize: 1,
    sample: (x) => (x > 2 && x < 4 ? 3 : 0),
  };
  const query = queryOver([capsule(2, 8)], wall);
  const hit = query.raycast({ x: 0, y: 1, z: 0 }, { x: 1, y: 0, z: 0 }, 100);
  assert.ok(hit);
  assert.equal(hit.kind, "terrain");
  assert.ok(hit.distance > 1.5 && hit.distance < 4.5, `stopped at ${hit.distance}`);
});

test("a .50 BMG penetrates the first body and wounds the one behind; a 9mm stops", () => {
  const first = new HealthDamageable("1", 100);
  const second = new HealthDamageable("2", 100);
  const damageables = new Map<number, Damageable>([
    [1, first],
    [2, second],
  ]);
  const query = queryOver([capsule(1, 5), capsule(2, 7)], null, damageables);

  const heavy = resolveHitscanShot({
    query,
    sourceId: "shooter",
    sequence: 1,
    origin: { x: 0, y: 1, z: 0 },
    direction: { x: 1, y: 0, z: 0 },
    maxDistanceMetres: 50,
    damage: AMMUNITION_DEFINITIONS["50bmg"].baseDamage,
    ammunition: AMMUNITION_DEFINITIONS["50bmg"],
  });
  assert.equal(heavy.interactions.length, 2, "the .50 did not reach the second body");
  assert.equal(heavy.interactions[0]!.outcome, "penetrated");
  assert.equal(first.health, 0, "a .50 BMG at 5 m must be lethal");
  assert.ok(second.health < 100, "the body behind the first was untouched");

  first.reset();
  second.reset();
  const light = resolveHitscanShot({
    query,
    sourceId: "shooter",
    sequence: 2,
    origin: { x: 0, y: 1, z: 0 },
    direction: { x: 1, y: 0, z: 0 },
    maxDistanceMetres: 50,
    damage: AMMUNITION_DEFINITIONS["9mm"].baseDamage,
    ammunition: AMMUNITION_DEFINITIONS["9mm"],
  });
  assert.equal(light.interactions.length, 1, "a 9mm should stop inside a body");
  assert.equal(light.interactions[0]!.outcome, "stopped");
  assert.equal(light.continuation, null);
  assert.ok(first.health < 100, "the stopped round applied no damage");
  assert.equal(second.health, 100, "a stopped 9mm reached the second body anyway");
});

test("a steep penetrating shot wounds a body once, never twice", () => {
  // Entering through the capsule's TOP CAP, the entry normal is nearly parallel
  // to the ray, so the authored-thickness advance alone is one body diameter —
  // far short of the ~1.8 m chord. Without the geometric exit the round
  // re-enters the same body and one .308 trigger pull deals ~145 damage.
  const body = new HealthDamageable("7", 100);
  const query = queryOver([capsule(7, 0)], null, new Map([[7, body]]));
  const result = resolveHitscanShot({
    query,
    sourceId: "tower",
    sequence: 1,
    origin: { x: 0, y: 30, z: 0 },
    direction: { x: 0, y: -1, z: 0 },
    maxDistanceMetres: 50,
    damage: AMMUNITION_DEFINITIONS["308"].baseDamage,
    ammunition: AMMUNITION_DEFINITIONS["308"],
  });
  const bodyHits = result.interactions.filter((i) => i.targetId === "7");
  assert.equal(bodyHits.length, 1, "one round wounded the same body twice");
  assert.equal(100 - body.health, 100, "a .308 through the crown should apply nominal damage once");
});

test("a shot that crosses the horizon still flying hands off its continuation state", () => {
  const empty = queryOver([], null);
  const ammunition = AMMUNITION_DEFINITIONS["308"];
  const horizon = hitscanHorizonMetres(ammunition);
  const result = resolveHitscanShot({
    query: empty,
    sourceId: "shooter",
    sequence: 1,
    origin: { x: 0, y: 2, z: 0 },
    direction: { x: 1, y: 0, z: 0 },
    maxDistanceMetres: horizon,
    damage: ammunition.baseDamage,
    ammunition,
  });
  assert.equal(result.interactions.length, 0);
  assert.ok(result.continuation, "an unobstructed shot must hand off at the horizon");
  const continuation = result.continuation!;
  assert.ok(Math.abs(continuation.point.x - horizon) < 1e-6);
  assert.ok(Math.abs(continuation.distanceTravelledMetres - horizon) < 1e-6);
  assert.ok(
    continuation.speedMetresPerSecond < ammunition.muzzleVelocityMetresPerSecond,
    "drag must have slowed the round by the horizon"
  );
  assert.equal(continuation.interactionCount, 0);
});

test("the closed-form near field agrees with the projectile integrator at the horizon", () => {
  // Same model, two solutions: the hitscan branch uses the exact flat-fire
  // decay, the far branch steps it at 120 Hz with gravity. If these drift
  // apart, damage jumps at the horizon and the hybrid is visible in play.
  const ammunition = AMMUNITION_DEFINITIONS["308"];
  const horizon = hitscanHorizonMetres(ammunition);
  const system = new BallisticProjectileSystem(
    { raycast: () => null },
    {
      gravity: { x: 0, y: -9.80665, z: 0 },
      windVelocity: { x: 0, y: 0, z: 0 },
      fixedStepSeconds: 1 / 120,
      maxCatchUpSeconds: 0.25,
    },
    { capacity: 1 }
  );
  assert.equal(
    system.spawn({
      sourceId: "parity",
      sequence: 1,
      origin: { x: 0, y: 100, z: 0 },
      direction: { x: 1, y: 0, z: 0 },
      maxDistance: horizon,
      maxFlightSeconds: 3.5,
      damage: ammunition.baseDamage,
      ammunition,
    }),
    true
  );
  let impactSpeed = 0;
  let flightSeconds = 0;
  let drop = 0;
  let resolved = false;
  for (let frame = 0; frame < 600 && !resolved; frame += 1) {
    system.update(1 / 60);
    system.drainResults((result) => {
      impactSpeed = result.trace.impactSpeedMetresPerSecond ?? 0;
      flightSeconds = result.trace.flightTimeSeconds;
      drop = result.trace.verticalDropMetres;
      resolved = true;
    });
  }
  assert.ok(resolved, "the parity round never completed");

  const closedFormSpeed = flatFireSpeedAt(ammunition, horizon);
  const closedFormTime = flatFireElapsedSeconds(
    ammunition,
    horizon,
    ammunition.muzzleVelocityMetresPerSecond
  );
  assert.ok(
    Math.abs(impactSpeed - closedFormSpeed) / closedFormSpeed < 0.01,
    `speed at horizon: integrator ${impactSpeed.toFixed(2)}, closed form ${closedFormSpeed.toFixed(2)}`
  );
  assert.ok(
    Math.abs(flightSeconds - closedFormTime) / closedFormTime < 0.01,
    `time to horizon: integrator ${flightSeconds.toFixed(4)}, closed form ${closedFormTime.toFixed(4)}`
  );
  // The horizon exists BECAUSE drop is negligible inside it; hold it to that.
  assert.ok(drop < 0.07, `drop inside the horizon was ${drop.toFixed(3)} m`);
});

test("the hitscan horizon scales with muzzle velocity", () => {
  const rifle = hitscanHorizonMetres(AMMUNITION_DEFINITIONS["556"]);
  const pistol = hitscanHorizonMetres(AMMUNITION_DEFINITIONS["9mm"]);
  assert.ok(rifle > 80 && rifle < 100, `5.56 horizon ${rifle.toFixed(1)} m`);
  assert.ok(pistol > 25 && pistol < 45, `9mm horizon ${pistol.toFixed(1)} m`);
  // The rule, not just the two constants: slower rounds always earn less
  // hitscan, which is what makes a future subsonic load lead-and-drop honest.
  assert.ok(pistol < rifle);
});

test("the rewind ring serves recorded ticks and refuses evicted ones", () => {
  const history = new StateHistory(32);
  for (let tick = 0; tick <= 40; tick += 1) {
    history.record(tick, [capsule(1, tick)]);
  }
  const recent = history.capsulesAt(40);
  assert.ok(recent !== null && Math.abs(recent[0]!.feetX - 40) < 1e-9);
  const held = history.capsulesAt(9);
  assert.ok(held !== null && Math.abs(held[0]!.feetX - 9) < 1e-9);
  // Tick 8's slot was overwritten by tick 40; a stale read must say so rather
  // than hand back the wrong tick's world.
  assert.equal(history.capsulesAt(8), null);
  assert.equal(history.capsulesAt(999), null);
});

test("fire, select and reload claims survive their codec round trips", () => {
  const fire = decodeFire(
    encodeFire({ tick: 7, sequence: 3, yawRadians: -1.2, pitchRadians: 0.4, viewTick: 123456 })
  );
  assert.ok(fire);
  assert.equal(fire.tick, 7);
  assert.equal(fire.sequence, 3);
  assert.equal(fire.viewTick, 123456);
  assert.ok(Math.abs(fire.yawRadians - -1.2) < 1e-3);
  assert.ok(Math.abs(fire.pitchRadians - 0.4) < 1e-3);

  const select = decodeSelectWeapon(encodeSelectWeapon({ sequence: 9, weaponIndex: 2 }));
  assert.ok(select);
  assert.equal(select.sequence, 9);
  assert.equal(select.weaponIndex, 2);

  const reload = decodeReload(encodeReload(11));
  assert.ok(reload);
  assert.equal(reload.sequence, 11);

  // Hostile input: short buffers decode to null, never throw.
  assert.equal(decodeFire(new Uint8Array(5)), null);
  assert.equal(decodeSelectWeapon(new Uint8Array(2)), null);
  assert.equal(decodeReload(new Uint8Array(1)), null);
});

test("shot relay and world-target packets survive their codec round trips", () => {
  const shot = decodeShotFired(
    encodeShotFired({
      shooterId: 3,
      weaponIndex: 2,
      sequence: 17,
      origin: { x: -120.5, y: 41.25, z: 998.75 },
      yawRadians: 2.4,
      pitchRadians: -0.15,
    })
  );
  assert.ok(shot);
  assert.equal(shot.shooterId, 3);
  assert.equal(shot.weaponIndex, 2);
  assert.equal(shot.sequence, 17);
  assert.ok(Math.abs(shot.origin.x - -120.5) < 1e-3);
  assert.ok(Math.abs(shot.origin.y - 41.25) < 1e-3);
  assert.ok(Math.abs(shot.yawRadians - 2.4) < 1e-3);
  assert.ok(Math.abs(shot.pitchRadians - -0.15) < 1e-3);
  assert.equal(decodeShotFired(new Uint8Array(10)), null);

  const targets = decodeWorldTargets(
    encodeWorldTargets([
      {
        id: 40_001,
        x: 8.5,
        y: 12.25,
        z: -300,
        radiusMetres: 0.35,
        heightMetres: 1.8,
        health: 42,
        maxHealth: 100,
      },
    ])
  );
  assert.equal(targets.length, 1);
  const target = targets[0]!;
  assert.equal(target.id, 40_001);
  assert.ok(Math.abs(target.x - 8.5) < 1e-3);
  assert.ok(Math.abs(target.radiusMetres - 0.35) < 0.011, "radius survives the cm quantise");
  assert.ok(Math.abs(target.heightMetres - 1.8) < 0.021, "height survives the 2 cm quantise");
  assert.equal(target.health, 42);
  assert.equal(target.maxHealth, 100);
  // A truncated buffer yields only the targets that fully arrived.
  assert.equal(decodeWorldTargets(new Uint8Array(2)).length, 0);
});
