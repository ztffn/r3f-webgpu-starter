// Procedural leaf-cluster texture, generated at runtime.
//
// WHY PROCEDURAL AND NOT A GLB / KTX2 ASSET
// Deliberate, and it is the same argument the synthetic fBm terrain fallback rests on
// (docs/08 §1): the repo must clone and run for someone with no art and no game data.
// It also removes the one thing that would make the card-variant experiment unreliable —
// if variant A and variant D are drawn on different hand-authored textures, the
// comparison measures the art, not the construction.
//
// The delivery-format questions the research memo raises (KTX2 vs PNG, ETC1S vs UASTC,
// one GLB per species vs geometry packs) are real, but they are questions about SHIPPING
// authored art. None of them changes the runtime contract, and answering them before
// there is any art to ship would be answering them blind. What this module does commit
// to is the part that would be expensive to retrofit: a mip chain whose alpha-test
// coverage does not thin with distance (see alphaMips.ts).

import * as THREE from "three/webgpu";
import { buildCoveragePreservingMips, alphaCoverage, type MipLevel } from "./alphaMips.ts";
import { FOLIAGE_ALPHA_CUTOFF } from "./foliageConfig.ts";
import { hash3i, rng32 } from "./vegetationHash.ts";

const TEXTURE_SIZE = 128;
const LEAF_COUNT = 34;

export interface FoliageTexture {
  texture: THREE.DataTexture;
  /**
   * Fraction of the texture's texels that pass the alpha cutoff at level 0.
   *
   * The research memo's "alpha occupancy" metric. Reported rather than assumed because
   * it is half of what decides a card variant's real cost: a card's fragment bill is its
   * screen rectangle, and the fraction of that rectangle doing no work is
   * (1 - occupancy). A variant with fewer, larger cards can lose to one with more,
   * tighter cards for exactly this reason.
   */
  alphaOccupancy: number;
  /** Coverage of each mip level under the same cutoff — should track level 0. */
  levelCoverage: number[];
}

function paintLeaves(size: number, seed: number): MipLevel {
  const data = new Uint8Array(size * size * 4);
  const random = rng32(hash3i(seed, 0, 0, 0x4c454146));

  interface Leaf {
    cx: number;
    cy: number;
    a: number;
    b: number;
    cos: number;
    sin: number;
    tone: number;
  }
  const leaves: Leaf[] = [];
  for (let i = 0; i < LEAF_COUNT; i += 1) {
    // Polar placement so the cluster is round and thins toward the edge — a square
    // spread would put full-opacity leaves in the card's corners, which is exactly the
    // silhouette that makes crossed quads read as flat rectangles edge-on.
    const angle = random() * Math.PI * 2;
    const radius = Math.sqrt(random()) * 0.46;
    const theta = random() * Math.PI * 2;
    leaves.push({
      cx: 0.5 + Math.cos(angle) * radius,
      cy: 0.5 + Math.sin(angle) * radius * 0.92,
      a: 0.085 + random() * 0.075,
      b: 0.03 + random() * 0.028,
      cos: Math.cos(theta),
      sin: Math.sin(theta),
      tone: 0.5 + random() * 0.5,
    });
  }

  const feather = 1.6 / size;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const px = (x + 0.5) / size;
      const py = (y + 0.5) / size;
      let alpha = 0;
      let tone = 0;
      for (const leaf of leaves) {
        const dx = px - leaf.cx;
        const dy = py - leaf.cy;
        const u = dx * leaf.cos + dy * leaf.sin;
        const v = -dx * leaf.sin + dy * leaf.cos;
        const along = u / leaf.a;
        if (along < -1 || along > 1) continue;
        // Pointed at both ends rather than elliptical: a true ellipse reads as a pill.
        const halfWidth = leaf.b * Math.pow(Math.max(0, 1 - along * along), 0.65);
        if (halfWidth <= 0) continue;
        const edge = (Math.abs(v) - halfWidth) / feather;
        const coverage = Math.min(1, Math.max(0, 0.5 - edge));
        if (coverage <= alpha) continue;
        alpha = coverage;
        // Darker toward the leaf's spine, so a cluster has internal contrast instead of
        // reading as one flat silhouette when it is only a few pixels across.
        tone = leaf.tone * (0.72 + 0.28 * Math.min(1, Math.abs(v) / Math.max(1e-5, halfWidth)));
      }
      const i = (y * size + x) * 4;
      const luminance = Math.round(255 * (0.35 + 0.65 * tone));
      data[i] = luminance;
      data[i + 1] = luminance;
      data[i + 2] = luminance;
      data[i + 3] = Math.round(alpha * 255);
    }
  }
  return { data, width: size, height: size };
}

/** Builds the shared leaf texture and its coverage-preserving mip chain. */
export function createFoliageTexture(seed = 1): FoliageTexture {
  const base = paintLeaves(TEXTURE_SIZE, seed);
  const levels = buildCoveragePreservingMips(base, FOLIAGE_ALPHA_CUTOFF);

  const texture = new THREE.DataTexture(base.data, base.width, base.height);
  texture.format = THREE.RGBAFormat;
  texture.type = THREE.UnsignedByteType;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  // Supplied, not generated. `generateMipmaps` would run the GPU's own box filter and
  // undo the coverage correction — the whole point of alphaMips.ts.
  texture.generateMipmaps = false;
  texture.mipmaps = levels.map((level) => ({
    data: level.data,
    width: level.width,
    height: level.height,
  })) as unknown as THREE.DataTexture["mipmaps"];
  texture.anisotropy = 4;
  texture.needsUpdate = true;

  return {
    texture,
    alphaOccupancy: alphaCoverage(base.data, FOLIAGE_ALPHA_CUTOFF),
    levelCoverage: levels.map((level) => alphaCoverage(level.data, FOLIAGE_ALPHA_CUTOFF)),
  };
}
