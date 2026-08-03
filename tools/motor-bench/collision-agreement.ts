// Collision-representation disagreement — measurement 5 of the decision record,
// and the only open one with a gameplay failure attached to it.
//
// §6 accepts two representations of the same world: characters collide against
// Rapier, bullets against CompositeWorldQuery. They can disagree, and the
// failure that disagreement produces is a player being shot through cover they
// are standing behind. This measures the gap and proposes a tolerance.
//
// The two surfaces are not the same by construction. The bullet side solves the
// BILINEAR patch over each grid cell; Rapier's heightfield is two TRIANGLES
// over the same four corners. Those agree at the corners and along the shared
// diagonal, and differ in between by the cell's saddle term.
//
// Run: node --experimental-strip-types --experimental-specifier-resolution=node \
//        tools/motor-bench/collision-agreement.ts

import {
  HeightfieldWorldQuery,
  type HeightfieldQuerySource,
} from "../../src/fps/core/WorldQuery.ts";
import { CharacterMotor } from "../../src/motor/CharacterMotor.ts";
import { createMotorWorld, initRapier } from "../../src/motor/MotorWorld.ts";
import { MotorInput, type PlayerCommand } from "../../src/motor/MotorTypes.ts";

const RAPIER = await initRapier();

/**
 * The grid is built here rather than imported from `src/df2/Heightfield.ts`.
 * That module uses extensionless relative imports, which Vite resolves and Node
 * does not — `--experimental-specifier-resolution=node` is a no-op on Node 22.
 * Touching the terrain spike to fix that is out of scope, so this reproduces
 * `Heightfield.sample`'s wrapping bilinear formula exactly instead.
 *
 * Nothing is lost: the bullet side is the REAL `HeightfieldWorldQuery`, the
 * character side is the REAL Rapier collider, and both read this one grid. The
 * comparison being made is between those two representations, not between two
 * elevation sources.
 */
const PERIOD = 256;
const CELL = 2;
const grid = new Float32Array(PERIOD * PERIOD);
for (let j = 0; j < PERIOD; j += 1) {
  for (let i = 0; i < PERIOD; i += 1) {
    const u = (i / PERIOD) * Math.PI * 2;
    const v = (j / PERIOD) * Math.PI * 2;
    // Several wrapping octaves, quantised to 8 bits like a real extracted map.
    const raw =
      Math.sin(u * 3) * 9 +
      Math.cos(v * 2) * 11 +
      Math.sin(u * 7 + v * 5) * 4 +
      Math.cos(u * 13 - v * 11) * 1.5;
    grid[j * PERIOD + i] = Math.round(raw + 40) * 0.5;
  }
}

const halfWorld = (PERIOD * CELL) / 2;
let minHeight = Infinity;
let maxHeight = -Infinity;
for (const height of grid) {
  if (height < minHeight) minHeight = height;
  if (height > maxHeight) maxHeight = height;
}

const field: HeightfieldQuerySource = {
  cellSize: CELL,
  halfWorld,
  minHeight,
  maxHeight,
  sample(x: number, z: number): number {
    const gx = (x + halfWorld) / CELL;
    const gz = (z + halfWorld) / CELL;
    const fx0 = Math.floor(gx);
    const fz0 = Math.floor(gz);
    const i0 = ((fx0 % PERIOD) + PERIOD) % PERIOD;
    const j0 = ((fz0 % PERIOD) + PERIOD) % PERIOD;
    const i1 = i0 + 1 === PERIOD ? 0 : i0 + 1;
    const j1 = j0 + 1 === PERIOD ? 0 : j0 + 1;
    const fx = gx - fx0;
    const fz = gz - fz0;
    const r0 = j0 * PERIOD;
    const r1 = j1 * PERIOD;
    const a = grid[r0 + i0]! + (grid[r0 + i1]! - grid[r0 + i0]!) * fx;
    const b = grid[r1 + i0]! + (grid[r1 + i1]! - grid[r1 + i0]!) * fx;
    return a + (b - a) * fz;
  },
  normal(x: number, z: number, out: [number, number, number] = [0, 1, 0]) {
    const e = CELL;
    const nx = -(field.sample(x + e, z) - field.sample(x - e, z)) / (2 * e);
    const nz = -(field.sample(x, z + e) - field.sample(x, z - e)) / (2 * e);
    const inv = 1 / Math.hypot(nx, 1, nz);
    out[0] = nx * inv;
    out[1] = inv;
    out[2] = nz * inv;
    return out;
  },
};

const bullets = new HeightfieldWorldQuery(field);
const world = createMotorWorld(RAPIER);

// One motor, only to own a terrain collider identical to the one a character
// stands on. The window is large so the sampled area never leaves it.
const motor = new CharacterMotor(RAPIER, world, field, {
  terrain: { windowCells: 256 },
  spawn: { x: 0, z: 0 },
});
world.step();

const cell = field.cellSize;
console.log(
  `Collision agreement — period ${PERIOD}, cell ${cell} m, ` +
    `height range ${field.minHeight.toFixed(1)}..${field.maxHeight.toFixed(1)} m\n`
);

/** Rapier's idea of the ground under (x, z), via a downward ray. */
function rapierGround(x: number, z: number): number | null {
  const hit = world.castRay(
    new RAPIER.Ray({ x, y: field.maxHeight + 50, z }, { x: 0, y: -1, z: 0 }),
    400,
    true
  );
  return hit === null ? null : field.maxHeight + 50 - hit.timeOfImpact;
}

/** The bullet path's idea of the ground under (x, z). */
function bulletGround(x: number, z: number): number | null {
  const hit = bullets.raycast(
    { x, y: field.maxHeight + 50, z },
    { x: 0, y: -1, z: 0 },
    400
  );
  return hit === null ? null : hit.point.y;
}

// ---------------------------------------------------------------------------
// 1. Surface disagreement across the cell, and specifically at the cell centre
//    where the bilinear and triangulated surfaces are furthest apart.
// ---------------------------------------------------------------------------

interface Stats {
  label: string;
  samples: number;
  mean: number;
  p99: number;
  worst: number;
  worstAt: string;
}

function survey(label: string, points: Array<[number, number]>): Stats {
  const deltas: number[] = [];
  let worst = 0;
  let worstAt = "";
  for (const [x, z] of points) {
    const rapier = rapierGround(x, z);
    const bullet = bulletGround(x, z);
    if (rapier === null || bullet === null) continue;
    const delta = Math.abs(rapier - bullet);
    deltas.push(delta);
    if (delta > worst) {
      worst = delta;
      worstAt = `(${x.toFixed(1)}, ${z.toFixed(1)}) rapier ${rapier.toFixed(3)} bullet ${bullet.toFixed(3)}`;
    }
  }
  deltas.sort((left, right) => left - right);
  return {
    label,
    samples: deltas.length,
    mean: deltas.reduce((sum, value) => sum + value, 0) / Math.max(1, deltas.length),
    p99: deltas[Math.min(deltas.length - 1, Math.floor(deltas.length * 0.99))] ?? 0,
    worst,
    worstAt,
  };
}

const corners: Array<[number, number]> = [];
const centres: Array<[number, number]> = [];
const scattered: Array<[number, number]> = [];
let seed = 12345;
const random = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 0x100000000;
};
for (let index = 0; index < 4000; index += 1) {
  const gx = Math.floor(random() * 100) - 50;
  const gz = Math.floor(random() * 100) - 50;
  corners.push([gx * cell, gz * cell]);
  centres.push([(gx + 0.5) * cell, (gz + 0.5) * cell]);
  scattered.push([(gx + random()) * cell, (gz + random()) * cell]);
}

const rows = [
  survey("cell corners", corners),
  survey("cell centres", centres),
  survey("uniform random", scattered),
];

const header = ["where".padEnd(16), "n".padStart(6), "mean".padStart(9), "p99".padStart(9), "worst".padStart(9)];
console.log(header.join("  "));
console.log("-".repeat(header.join("  ").length));
for (const row of rows) {
  console.log(
    [
      row.label.padEnd(16),
      String(row.samples).padStart(6),
      `${row.mean.toFixed(4)} m`.padStart(9),
      `${row.p99.toFixed(4)} m`.padStart(9),
      `${row.worst.toFixed(4)} m`.padStart(9),
    ].join("  ")
  );
}
console.log(`\nworst case: ${rows[2]!.worstAt}`);

// ---------------------------------------------------------------------------
// 2. The gameplay question. A player stands where Rapier puts them; a bullet
//    resolves the ground from the bilinear surface. If the bullet's ground sits
//    ABOVE the player's feet the player is over-protected — rounds stop in
//    terrain that, to them, is not there. Below, and they are under-protected.
// ---------------------------------------------------------------------------

const idle: PlayerCommand = { tick: 0, buttons: 0, yawRadians: 0, pitchRadians: 0 };
let worstUnderProtected = 0;
let worstOverProtected = 0;
let walked = 0;

for (let tick = 0; tick < 4000; tick += 1) {
  const buttons = MotorInput.Forward;
  motor.step({
    ...idle,
    tick,
    buttons,
    yawRadians: Math.sin(tick * 0.004) * Math.PI,
  });
  world.step();
  if (!motor.state.grounded || tick < 120) continue;

  const feet = motor.state.position;
  const bullet = bulletGround(feet.x, feet.z);
  if (bullet === null) continue;
  walked += 1;
  const difference = bullet - feet.y;
  if (difference > worstOverProtected) worstOverProtected = difference;
  if (-difference > worstUnderProtected) worstUnderProtected = -difference;
}

console.log(
  `\nWalked ${walked} grounded ticks. Feet versus the bullet surface underneath:\n` +
    `  bullet ground above the feet (over-protected)  worst ${worstOverProtected.toFixed(4)} m\n` +
    `  bullet ground below the feet (under-protected) worst ${worstUnderProtected.toFixed(4)} m`
);

// ---------------------------------------------------------------------------
// 3. The failure this actually bounds: a grazing shot at someone behind a
//    ridge. Sweep shallow rays and count where the two representations
//    disagree about whether the shot is blocked.
// ---------------------------------------------------------------------------

const PRONE_EYE = 0.35;
let disagreements = 0;
let attempts = 0;
let worstMargin = 0;

for (let trial = 0; trial < 3000; trial += 1) {
  const x = (random() * 200 - 100) * cell * 0.1;
  const z = (random() * 200 - 100) * cell * 0.1;
  const angle = random() * Math.PI * 2;
  const range = 40 + random() * 120;
  const targetX = x + Math.cos(angle) * range;
  const targetZ = z + Math.sin(angle) * range;

  const shooterY = (bulletGround(x, z) ?? 0) + 1.7;
  const targetY = (bulletGround(targetX, targetZ) ?? 0) + PRONE_EYE;
  const direction = { x: targetX - x, y: targetY - shooterY, z: targetZ - z };
  const length = Math.hypot(direction.x, direction.y, direction.z);
  if (length < 1) continue;
  direction.x /= length;
  direction.y /= length;
  direction.z /= length;
  attempts += 1;

  const bulletHit = bullets.raycast({ x, y: shooterY, z }, direction, length - 0.05);
  const rapierHit = world.castRay(
    new RAPIER.Ray({ x, y: shooterY, z }, direction),
    length - 0.05,
    true
  );
  const bulletBlocked = bulletHit !== null;
  const rapierBlocked = rapierHit !== null;
  if (bulletBlocked === rapierBlocked) continue;

  disagreements += 1;
  // How much clearance separated the two answers, measured along the ray.
  const margin = Math.abs((bulletHit?.distance ?? length) - (rapierHit?.timeOfImpact ?? length));
  worstMargin = Math.max(worstMargin, margin);
}

console.log(
  `\nGrazing line-of-sight over terrain, prone target:\n` +
    `  ${attempts} shots, ${disagreements} disagreed on blocked versus clear ` +
    `(${((disagreements / Math.max(1, attempts)) * 100).toFixed(2)}%)\n` +
    `  worst separation along the ray ${worstMargin.toFixed(3)} m`
);

// ---------------------------------------------------------------------------
// 4. The mitigation. If the gap really is the bilinear-versus-triangulated
//    saddle term, then sampling the SAME bilinear field onto a finer Rapier
//    lattice must shrink it quadratically. Tested rather than asserted.
// ---------------------------------------------------------------------------

console.log("\nSubdividing the Rapier lattice against the same bilinear field:\n");
const subHeader = ["rapier cell".padEnd(13), "mean".padStart(9), "worst".padStart(9), "vs 1x".padStart(8)];
console.log(subHeader.join("  "));
console.log("-".repeat(subHeader.join("  ").length));

let baseline = 0;
for (const divisor of [1, 2, 4, 8]) {
  const subWorld = createMotorWorld(RAPIER);
  const subCell = cell / divisor;
  const span = 128;
  const n = Math.round(span / subCell) + 1;
  const heights = new Float32Array(n * n);
  for (let col = 0; col < n; col += 1) {
    const x = -span / 2 + col * subCell;
    for (let row = 0; row < n; row += 1) {
      heights[col * n + row] = field.sample(x, -span / 2 + row * subCell);
    }
  }
  subWorld.createCollider(
    RAPIER.ColliderDesc.heightfield(n - 1, n - 1, heights, { x: span, y: 1, z: span }),
    subWorld.createRigidBody(RAPIER.RigidBodyDesc.fixed())
  );
  subWorld.step();

  let total = 0;
  let worst = 0;
  let count = 0;
  for (let index = 0; index < 3000; index += 1) {
    const x = (random() - 0.5) * (span - 8);
    const z = (random() - 0.5) * (span - 8);
    const hit = subWorld.castRay(
      new RAPIER.Ray({ x, y: maxHeight + 50, z }, { x: 0, y: -1, z: 0 }),
      400,
      true
    );
    if (hit === null) continue;
    const delta = Math.abs(maxHeight + 50 - hit.timeOfImpact - field.sample(x, z));
    total += delta;
    worst = Math.max(worst, delta);
    count += 1;
  }
  const mean = total / Math.max(1, count);
  if (divisor === 1) baseline = worst;
  console.log(
    [
      `${subCell.toFixed(2)} m (${divisor}x)`.padEnd(13),
      `${mean.toFixed(4)} m`.padStart(9),
      `${worst.toFixed(4)} m`.padStart(9),
      `${(worst / baseline).toFixed(3)}`.padStart(8),
    ].join("  ")
  );
}

process.exit(0);
