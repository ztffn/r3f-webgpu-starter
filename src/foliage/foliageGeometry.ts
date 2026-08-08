// Foliage geometry: four construction variants, three geometric LODs and an impostor.
//
// THE QUESTION THIS EXISTS TO ANSWER
// "Is a big card cheaper than more triangles?" has no general answer, and the folklore
// answer ("triangles are free now") is wrong for exactly this case. A card's bill is its
// rasterised screen rectangle: two triangles that cover a quarter of the screen still
// run the alpha test over a quarter of the screen, and every fragment that fails is work
// thrown away. Four variants of the same plant, built to the same silhouette envelope,
// is the only way to find out where that trade sits on the actual target hardware.
//
//   A — broad cards      few large intersecting planes, fewest triangles, lowest
//                        alpha occupancy, most wasted fragments
//   B — trimmed clusters  more, smaller cards fitted to the crown
//   C — hybrid volume     real stem/core geometry plus small leaf-cluster cards
//   D — mostly geometry   many small cards on a dome shell using the texture's dense
//                        core, so almost nothing is alpha-rejected
//
// THE CONSTRAINT THAT OUTRANKS LOOKS
// Every LOD keeps the plant's BLOCKING FRACTION — the share of horizontal rays through
// the crown that a card stops — within a tolerance of LOD 0. Cards are removed going down
// the chain and the survivors GROW to compensate; the impostor's leaf density is solved
// from LOD 0 rather than authored. This is docs/08 §8 invariant 6 applied to vegetation: the renderer must
// never conceal less than the gameplay record says it does, and a distant LOD that
// quietly becomes more transparent hands the player who triggers it free vision of a
// target the field counts as covered. `blockingFraction` is emitted so the property can
// be asserted in a test rather than eyeballed.

import * as THREE from "three/webgpu";
import type { Species } from "./species.ts";
import { FOLIAGE_LOD_DISTANCES, packVec4 } from "./foliageConfig.ts";
import { hash3i, rng32 } from "./vegetationHash.ts";

export type CardVariant = "A" | "B" | "C" | "D";

export const CARD_VARIANTS: readonly CardVariant[] = ["A", "B", "C", "D"];

/**
 * LOD 0..n-2 are geometric; the last is a single cylindrical billboard.
 *
 * DERIVED from the distance table rather than restated, because the two are indexed
 * against each other: `chooseLod` walks `FOLIAGE_LOD_DISTANCES` and the result indexes a
 * bucket's per-LOD geometries. A fifth distance added in the config table — the natural
 * place, where every other knob in this layer lives — would otherwise index past the
 * templates array with nothing pointing at the cause.
 */
export const FOLIAGE_LOD_COUNT = FOLIAGE_LOD_DISTANCES.length;
export const FOLIAGE_IMPOSTOR_LOD = FOLIAGE_LOD_COUNT - 1;

export interface FoliageGeometryBuild {
  geometry: THREE.BufferGeometry;
  cardCount: number;
  triangleCount: number;
  /**
   * Estimated probability that a horizontal ray through the crown is blocked, 0-1.
   *
   * The concealment-envelope proxy, compared ACROSS LODs rather than read as an absolute.
   * Summed card area is the obvious metric and it is wrong: three crossed planes have
   * three cards' worth of area but roughly one card's worth of silhouette, so summing
   * says an impostor conceals a third of what it replaces when the two actually look
   * alike. This saturates instead — each card contributes its mean projected share of the
   * crown's frontal rectangle and the shares compose as independent occluders.
   */
  blockingFraction: number;
}

interface CardSpec {
  cx: number;
  cy: number;
  cz: number;
  width: number;
  height: number;
  /** Rotation about Y, radians. */
  yaw: number;
  /** Tilt toward horizontal, radians. 0 is a vertical card. */
  tilt: number;
  /**
   * How far the card's uv rectangle is pulled in from the tile's edges. 0 takes the
   * WHOLE tile, which is mostly the cluster's sparse fringe; 1 takes only its dense core.
   * Alpha occupancy therefore rises with this.
   */
  uvInset: number;
  billboard: boolean;
}

/**
 * How much of the leaf texture's alpha survives the cutoff, by uv inset.
 *
 * The texture is a round cluster that thins toward its edge, so a card at inset 0 takes
 * the WHOLE tile — sparse, mostly empty — and one at inset 1 takes only the dense core.
 * Occupancy therefore RISES with inset. Approximated with a curve rather than measured
 * per inset because the exact figure comes from `createFoliageTexture().alphaOccupancy`
 * at runtime, and this only has to rank the variants consistently while the builder
 * budgets card area.
 */
const MIN_OCCUPANCY = 0.34;
const MAX_OCCUPANCY = 0.94;

function occupancyForInset(uvInset: number): number {
  return Math.min(MAX_OCCUPANCY, MIN_OCCUPANCY + (MAX_OCCUPANCY - MIN_OCCUPANCY) * uvInset);
}

function insetForOccupancy(occupancy: number): number {
  const t = (occupancy - MIN_OCCUPANCY) / (MAX_OCCUPANCY - MIN_OCCUPANCY);
  return Math.min(1, Math.max(0, t));
}

/**
 * Probability a horizontal ray through the crown is blocked by these cards.
 *
 * Each card contributes its mean projected area as a share of the crown's frontal
 * rectangle: a vertical card of width w seen from a uniformly random azimuth projects
 * `w * 2/pi` on average, and tilting it toward horizontal costs it `cos(tilt)`. Shares
 * compose as independent occluders, `1 - prod(1 - share)`, which saturates the way real
 * overlapping foliage does instead of growing without bound as cards are added.
 */
function blockingFractionOf(cards: CardSpec[], frontalArea: number): number {
  if (frontalArea <= 0) return 0;
  let transmitted = 1;
  for (const card of cards) {
    const projectionFactor = card.billboard ? 1 : 2 / Math.PI;
    const projected =
      card.width * projectionFactor * card.height * Math.cos(card.tilt) * occupancyForInset(card.uvInset);
    const share = Math.min(1, projected / frontalArea);
    transmitted *= 1 - share;
  }
  return 1 - transmitted;
}

/**
 * The blocking fraction every variant and every geometric LOD is built to.
 *
 * Without this the comparison is worthless. The experiment is "same plant, four
 * constructions, which is cheaper" — but as first authored, variant D blocked 0.27 of
 * horizontal rays against variant A's 0.52, so D was cheaper largely because it was a
 * thinner bush. Solving each variant's card size to a shared envelope makes the frame
 * times answer the question that was actually asked, and it is also the gameplay-correct
 * constraint: which card construction an artist picked must not change how much cover a
 * plant gives.
 */
const TARGET_BLOCKING = 0.55;

/** Uniform size multiplier that brings a card set to `TARGET_BLOCKING`. */
function solveSizeMultiplier(cards: CardSpec[], frontalArea: number): number {
  const scaled = (multiplier: number) =>
    blockingFractionOf(
      cards.map((card) => ({
        ...card,
        width: card.width * multiplier,
        height: card.height * multiplier,
      })),
      frontalArea
    );
  let low = 0.25;
  let high = 4;
  if (scaled(high) < TARGET_BLOCKING) return high;
  if (scaled(low) > TARGET_BLOCKING) return low;
  for (let i = 0; i < 20; i += 1) {
    const mid = (low + high) * 0.5;
    if (scaled(mid) < TARGET_BLOCKING) low = mid;
    else high = mid;
  }
  return (low + high) * 0.5;
}

/**
 * Crown extent for a species: foliage occupies [baseY, topY] with radius `radius`.
 *
 * Exported for the impostor bake, whose blocking-fraction audit must measure over the
 * SAME frontal rectangle this module solves against — a re-derived crown would let the
 * two drift apart silently.
 */
export function crownOf(species: Species): { baseY: number; topY: number; radius: number } {
  const hasTrunk = species.trunk !== null;
  return {
    baseY: hasTrunk ? species.heightMetres * 0.44 : species.heightMetres * 0.06,
    topY: species.heightMetres,
    radius: species.radiusMetres,
  };
}

/**
 * Cards at their authored proportions, before the shared-envelope solve.
 *
 * Split from `buildCardSpecs` so the solve has exactly one place to happen. It used to
 * be folded in per variant and the variants drifted apart, which is what made their
 * frame times incomparable.
 */
function buildRawCardSpecs(species: Species, variant: CardVariant, lod: number): CardSpec[] {
  const crown = crownOf(species);
  const crownHeight = crown.topY - crown.baseY;
  const midY = (crown.baseY + crown.topY) * 0.5;
  const cards: CardSpec[] = [];

  // Deterministic per (species, variant, lod) so two builds of the same plant agree.
  const random = rng32(hash3i(species.heightMetres * 1000, variant.charCodeAt(0), lod, 0x43415244));

  const base: Record<CardVariant, { count: number; inset: number; sizeFactor: number }> = {
    A: { count: 3, inset: 0, sizeFactor: 1.0 },
    B: { count: 10, inset: 0.18, sizeFactor: 0.58 },
    C: { count: 8, inset: 0.24, sizeFactor: 0.52 },
    D: { count: 22, inset: 0.5, sizeFactor: 0.34 },
  };
  const plan = base[variant];

  // Card count falls with LOD. The survivors are NOT grown here — `buildCardSpecs`
  // solves the size that restores the blocking fraction, for every LOD and every variant
  // against one shared target.
  const keepFraction = [1, 0.55, 0.3][Math.min(lod, 2)];
  const count = Math.max(2, Math.round(plan.count * keepFraction));
  const sizeFactor = plan.sizeFactor;

  if (variant === "A") {
    // Crossed planes through the crown axis.
    for (let i = 0; i < count; i += 1) {
      cards.push({
        cx: 0,
        cy: midY,
        cz: 0,
        width: crown.radius * 2 * sizeFactor,
        height: crownHeight * sizeFactor,
        yaw: (Math.PI * i) / count,
        tilt: 0,
        uvInset: plan.inset,
        billboard: false,
      });
    }
    return cards;
  }

  if (variant === "D") {
    // Small cards scattered over a dome shell — radial volume from every angle, which
    // is the case crossed planes fail: seen edge-on they collapse to a strip, and this
    // camera spends its life at prone and standing eye height looking horizontally.
    for (let i = 0; i < count; i += 1) {
      const phi = random() * Math.PI * 2;
      const t = random();
      const r = crown.radius * (0.45 + 0.55 * Math.sqrt(t));
      cards.push({
        cx: Math.cos(phi) * r,
        cy: crown.baseY + crownHeight * (0.15 + 0.85 * random()),
        cz: Math.sin(phi) * r,
        width: crown.radius * 0.9 * sizeFactor,
        height: crownHeight * 0.7 * sizeFactor,
        yaw: phi + Math.PI * 0.5 + (random() - 0.5) * 0.8,
        tilt: (random() - 0.5) * 0.9,
        uvInset: plan.inset,
        billboard: false,
      });
    }
    return cards;
  }

  // B and C: clusters fitted around the crown, C's being fewer and tighter because it
  // also carries real stem geometry.
  for (let i = 0; i < count; i += 1) {
    const phi = (i / count) * Math.PI * 2 + random() * 0.5;
    const r = crown.radius * (0.3 + 0.5 * random());
    cards.push({
      cx: Math.cos(phi) * r,
      cy: crown.baseY + crownHeight * (0.2 + 0.7 * random()),
      cz: Math.sin(phi) * r,
      width: crown.radius * 1.5 * sizeFactor,
      height: crownHeight * 1.1 * sizeFactor,
      yaw: phi,
      tilt: (random() - 0.5) * 0.5,
      uvInset: plan.inset,
      billboard: false,
    });
  }
  return cards;
}

/**
 * Cards for one species, variant and LOD, normalised to the shared cover envelope.
 *
 * Two things happen here and neither is optional. The geometric LODs are scaled so every
 * variant and every level blocks the same share of horizontal rays — otherwise a
 * "cheaper" variant is only cheaper because it is a thinner bush, and a coarser LOD is
 * only cheaper because it stopped being cover. The impostor instead solves its LEAF
 * DENSITY, because a single camera-facing card already spans the crown's frontal
 * rectangle and only its alpha occupancy is free to move.
 */
function buildCardSpecs(species: Species, variant: CardVariant, lod: number): CardSpec[] {
  const crown = crownOf(species);
  const crownHeight = crown.topY - crown.baseY;
  const frontalArea = crown.radius * 2 * crownHeight;

  if (lod === FOLIAGE_IMPOSTOR_LOD) {
    const reference = buildCardSpecs(species, variant, 0);
    return [
      {
        cx: 0,
        cy: (crown.baseY + crown.topY) * 0.5,
        cz: 0,
        width: crown.radius * 2,
        height: crownHeight,
        yaw: 0,
        tilt: 0,
        uvInset: insetForOccupancy(blockingFractionOf(reference, frontalArea)),
        billboard: true,
      },
    ];
  }

  const raw = buildRawCardSpecs(species, variant, lod);
  const multiplier = solveSizeMultiplier(raw, frontalArea);
  return raw.map((card) => ({
    ...card,
    width: card.width * multiplier,
    height: card.height * multiplier,
  }));
}

interface MeshAccumulator {
  position: number[];
  normal: number[];
  uv: number[];
  sway: number[];
  billboard: number[];
  /**
   * In-plane corner offset from the plant's base, metres, for billboard vertices.
   *
   * Impostor vertices carry BOTH a real authored position and this offset: the shader
   * rebuilds the card to face the camera, but if that branch is ever bypassed the card
   * still draws at a fixed facing rather than collapsing to a point. A silent
   * disappearance is the worst failure mode available to a system whose job is cover.
   */
  card: number[];
  /** 1 where the leaf texture applies, 0 for solid bark/stem geometry. */
  leaf: number[];
}

function emitCard(out: MeshAccumulator, card: CardSpec, species: Species): void {
  const halfWidth = card.width * 0.5;
  const halfHeight = card.height * 0.5;
  const cosYaw = Math.cos(card.yaw);
  const sinYaw = Math.sin(card.yaw);
  const cosTilt = Math.cos(card.tilt);
  const sinTilt = Math.sin(card.tilt);

  const corners: Array<[number, number]> = [
    [-halfWidth, -halfHeight],
    [halfWidth, -halfHeight],
    [halfWidth, halfHeight],
    [-halfWidth, -halfHeight],
    [halfWidth, halfHeight],
    [-halfWidth, halfHeight],
  ];
  const uvInset = card.uvInset;
  const uvLow = uvInset * 0.5;
  const uvHigh = 1 - uvInset * 0.5;
  const uvs: Array<[number, number]> = [
    [uvLow, uvLow],
    [uvHigh, uvLow],
    [uvHigh, uvHigh],
    [uvLow, uvLow],
    [uvHigh, uvHigh],
    [uvLow, uvHigh],
  ];
  const crown = crownOf(species);
  const crownMidY = (crown.baseY + crown.topY) * 0.5;

  for (let i = 0; i < corners.length; i += 1) {
    const [lx, ly] = corners[i];
    // Tilt in the card's own plane first, then yaw into world.
    const ty = ly * cosTilt;
    const tz = ly * sinTilt;
    const x = card.cx + lx * cosYaw + tz * sinYaw;
    const y = card.cy + ty;
    const z = card.cz - lx * sinYaw + tz * cosYaw;
    out.position.push(x, y, z);

    // SPHERICAL NORMALS, pointing out of the crown centre rather than out of the card.
    // A card's true normal makes half the cluster shade black as it turns away from the
    // sun and flips hard at grazing angles; a normal borrowed from the crown's implied
    // volume gives the soft, rounded response real foliage has. Standard foliage
    // practice, and cheap: it costs one normalise at build time.
    let nx = x;
    let ny = (y - crownMidY) * 0.75;
    let nz = z;
    const length = Math.hypot(nx, ny, nz);
    if (length < 1e-5) {
      nx = 0;
      ny = 1;
      nz = 0;
    } else {
      nx /= length;
      ny /= length;
      nz /= length;
    }
    out.normal.push(nx, ny, nz);
    out.uv.push(uvs[i][0], uvs[i][1]);

    // Sway rises with height above the plant's base and is zero at the ground.
    const sway = Math.min(1, Math.max(0, y / Math.max(1e-3, species.heightMetres)));
    out.sway.push(sway * sway);
    out.billboard.push(card.billboard ? 1 : 0);
    out.card.push(lx, card.cy + ty);
    out.leaf.push(1);
  }
}

function emitTrunk(out: MeshAccumulator, species: Species, lod: number): number {
  const trunk = species.trunk;
  if (!trunk) return 0;
  const crown = crownOf(species);
  const top = Math.max(trunk.heightMetres, crown.baseY + 0.2);
  const sides = lod === 0 ? 7 : lod === 1 ? 5 : 4;
  const radius = trunk.radiusMetres;
  let triangles = 0;

  for (let i = 0; i < sides; i += 1) {
    const a0 = (i / sides) * Math.PI * 2;
    const a1 = ((i + 1) / sides) * Math.PI * 2;
    const x0 = Math.cos(a0);
    const z0 = Math.sin(a0);
    const x1 = Math.cos(a1);
    const z1 = Math.sin(a1);
    // Taper: a cylinder reads as a pipe, and the silhouette is most of what is visible
    // of a trunk at range.
    const topRadius = radius * 0.72;
    const quad: Array<[number, number, number, number, number, number]> = [
      [x0 * radius, 0, z0 * radius, x0, 0, z0],
      [x1 * radius, 0, z1 * radius, x1, 0, z1],
      [x1 * topRadius, top, z1 * topRadius, x1, 0, z1],
      [x0 * radius, 0, z0 * radius, x0, 0, z0],
      [x1 * topRadius, top, z1 * topRadius, x1, 0, z1],
      [x0 * topRadius, top, z0 * topRadius, x0, 0, z0],
    ];
    for (const [px, py, pz, nx, ny, nz] of quad) {
      out.position.push(px, py, pz);
      out.normal.push(nx, ny, nz);
      out.uv.push(0, 0);
      // The trunk does not sway. Wind that moves a bullet-stopping proxy would put the
      // render and the ballistic record in disagreement, which is the one thing this
      // whole module is arranged to prevent.
      out.sway.push(0);
      out.billboard.push(0);
      out.card.push(0, 0);
      out.leaf.push(0);
    }
    triangles += 2;
  }
  return triangles;
}

/**
 * Builds one species' geometry for a variant and LOD.
 *
 * Non-indexed on purpose: cards share no vertices (every corner has its own uv and its
 * own spherical normal), so an index buffer would add a fetch and save nothing.
 */
export function buildFoliageGeometry(
  species: Species,
  variant: CardVariant,
  lod: number
): FoliageGeometryBuild {
  const cards = buildCardSpecs(species, variant, lod);
  const crownBounds = crownOf(species);
  const blockingFraction = blockingFractionOf(
    cards,
    crownBounds.radius * 2 * (crownBounds.topY - crownBounds.baseY)
  );
  const out: MeshAccumulator = {
    position: [],
    normal: [],
    uv: [],
    sway: [],
    billboard: [],
    card: [],
    leaf: [],
  };

  for (const card of cards) {
    emitCard(out, card, species);
  }

  // Variant C is defined by carrying real volume, so it gets a stem even on species
  // whose ballistic record has no trunk — that is the point of the variant.
  const wantsStem = variant === "C" || species.trunk !== null;
  let trunkTriangles = 0;
  if (wantsStem && lod !== FOLIAGE_IMPOSTOR_LOD) {
    if (species.trunk) {
      trunkTriangles = emitTrunk(out, species, lod);
    } else {
      trunkTriangles = emitTrunk(
        out,
        {
          ...species,
          trunk: {
            radiusMetres: species.radiusMetres * 0.08,
            heightMetres: species.heightMetres * 0.55,
            surfaceId: "wood",
            penetrationThicknessMetres: 0,
          },
        },
        lod
      );
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(out.position, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(out.normal, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(out.uv, 2));
  // PACKED INTO ONE vec4, and this is a hard WebGPU limit rather than a tidy-up.
  //
  // `maxVertexBuffers` is 8. Declared separately, this material asked for ten —
  // position, normal, uv, sway, billboard, card, leaf plus three instance attributes —
  // and EVERY foliage pipeline failed to create, so no plant was ever drawn:
  // "Vertex buffer count (10) exceeds the maximum number of vertex buffers (8)".
  // It went unseen because the environment this layer was written in has no GPU and
  // falls back to WebGL2 on SwiftShader, where the limit is higher.
  //
  // `card.xy` + `sway` + `billboard` fill one vec4; `leaf` stays its own float because
  // a fifth component will not fit. Two buffers instead of four, and the instance side
  // packs the same way (FoliageCells), which lands the total at seven.
  const cardPacked = new Float32Array(out.leaf.length * 4);
  for (let i = 0; i < out.leaf.length; i += 1) {
    packVec4(cardPacked, i, out.card[i * 2], out.card[i * 2 + 1], out.sway[i], out.billboard[i]);
  }
  geometry.setAttribute("aCard", new THREE.Float32BufferAttribute(cardPacked, 4));
  geometry.setAttribute("leaf", new THREE.Float32BufferAttribute(out.leaf, 1));
  // Computed from the crown rather than the vertices: a billboard's vertices are
  // reconstructed in the shader, so a bounds fit to the authored positions would be
  // wrong exactly where it matters. Radius covers the widest the card can swing to.
  const crown = crownOf(species);
  geometry.boundingSphere = new THREE.Sphere(
    new THREE.Vector3(0, (crown.baseY + crown.topY) * 0.5, 0),
    Math.hypot(crown.radius, (crown.topY - crown.baseY) * 0.5) * 1.15
  );

  return {
    geometry,
    cardCount: cards.length,
    triangleCount: cards.length * 2 + trunkTriangles,
    blockingFraction,
  };
}
