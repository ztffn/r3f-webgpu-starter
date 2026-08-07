// Runtime loader for the baked hemi-octahedral impostor atlases.
//
// Fetches the manifest and per-species PNGs from public/assets/vegetation/impostors/,
// decodes them with the project's own codec (impostorPng.ts — the canvas decode path
// premultiplies alpha and is not texel-faithful), rebuilds the coverage-preserving mip
// chain for the albedo atlas and plain box mips for the normal atlas, and wraps both in
// DataTextures. Resolves to null when the assets are absent or unreadable, so the far
// ring declines to exist without taking the foliage layer down with it.

import * as THREE from "three/webgpu";
import { buildCoveragePreservingMips, type MipLevel } from "./alphaMips.ts";
import { FOLIAGE_ALPHA_CUTOFF } from "./foliageConfig.ts";
import { decodePng } from "./impostorPng.ts";

export interface ImpostorManifestSpecies {
  albedo: string;
  normalDepth: string;
  /** Centre height of the baked frame above the plant base, metres. */
  centerY: number;
  /** Half-side of the baked frame, metres — the card's half-size at scale 1. */
  radius: number;
}

export interface ImpostorManifest {
  version: number;
  variant: string;
  spritesPerSide: number;
  tileSize: number;
  bakeAlphaCutoff: number;
  runtimeAlphaCutoff: number;
  species: Record<string, ImpostorManifestSpecies>;
}

export interface ImpostorSpeciesAtlas {
  albedo: THREE.DataTexture;
  normalDepth: THREE.DataTexture;
  centerY: number;
  radius: number;
}

export interface ImpostorAtlases {
  manifest: ImpostorManifest;
  bySpecies: ReadonlyMap<string, ImpostorSpeciesAtlas>;
  dispose(): void;
}

/**
 * Coverage-weighted mips for the normal+depth atlas.
 *
 * Weighted by the ALBEDO chain's alpha at the same level, for the same reason the
 * albedo's own colours are alpha-weighted: an unweighted box average lets the empty
 * margin's fill normals dominate deep levels. Measured on screen before this existed:
 * every distant impostor's normal converged toward straight-up, which maxed both the
 * sun term and the sky fill and rendered the whole far ring a shade too bright. The
 * shader renormalises after decode, so the stored average never needs to be unit.
 */
function weightedNormalMips(base: MipLevel, albedoLevels: MipLevel[]): MipLevel[] {
  const levels: MipLevel[] = [base];
  let current = base;
  let level = 0;
  while (current.width > 1 || current.height > 1) {
    const weights = albedoLevels[level];
    const width = Math.max(1, current.width >> 1);
    const height = Math.max(1, current.height >> 1);
    const data = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        let nx = 0;
        let ny = 0;
        let nz = 0;
        let depth = 0;
        let weight = 0;
        let plainX = 0;
        let plainY = 0;
        let plainZ = 0;
        let plainDepth = 0;
        for (let dy = 0; dy < 2; dy += 1) {
          for (let dx = 0; dx < 2; dx += 1) {
            const sx = Math.min(current.width - 1, x * 2 + dx);
            const sy = Math.min(current.height - 1, y * 2 + dy);
            const s = (sy * current.width + sx) * 4;
            const a = weights.data[s + 3];
            nx += current.data[s] * a;
            ny += current.data[s + 1] * a;
            nz += current.data[s + 2] * a;
            depth += current.data[s + 3] * a;
            weight += a;
            plainX += current.data[s];
            plainY += current.data[s + 1];
            plainZ += current.data[s + 2];
            plainDepth += current.data[s + 3];
          }
        }
        const o = (y * width + x) * 4;
        if (weight > 0) {
          data[o] = Math.round(nx / weight);
          data[o + 1] = Math.round(ny / weight);
          data[o + 2] = Math.round(nz / weight);
          data[o + 3] = Math.round(depth / weight);
        } else {
          data[o] = Math.round(plainX / 4);
          data[o + 1] = Math.round(plainY / 4);
          data[o + 2] = Math.round(plainZ / 4);
          data[o + 3] = Math.round(plainDepth / 4);
        }
      }
    }
    current = { data, width, height };
    levels.push(current);
    level += 1;
  }
  return levels;
}

function makeTexture(levels: MipLevel[]): THREE.DataTexture {
  const base = levels[0];
  const texture = new THREE.DataTexture(base.data, base.width, base.height);
  texture.format = THREE.RGBAFormat;
  texture.type = THREE.UnsignedByteType;
  // The bake writes LINEAR values (the same constants the near-field colorNode uses);
  // marking the texture sRGB would re-transform them and the tiers would stop matching.
  texture.colorSpace = THREE.NoColorSpace;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  // Anisotropy stays at 1: anisotropic taps walk a line in uv space, and on a tiled
  // atlas that line crosses into the neighbouring VIEW well before the tile-edge clamp
  // in the shader can stop it.
  texture.generateMipmaps = false;
  texture.mipmaps = levels.map((level) => ({
    data: level.data,
    width: level.width,
    height: level.height,
  })) as unknown as THREE.DataTexture["mipmaps"];
  texture.needsUpdate = true;
  return texture;
}

export async function loadImpostorAtlases(
  baseUrl = "/assets/vegetation/impostors"
): Promise<ImpostorAtlases | null> {
  let manifest: ImpostorManifest;
  try {
    const response = await fetch(`${baseUrl}/manifest.json`);
    if (!response.ok) return null;
    // Parsed defensively: a dev-proxy SPA fallback answers a missing file with 200 and
    // index.html, which must read as "absent", not as a crash inside the foliage layer.
    manifest = (await response.json()) as ImpostorManifest;
  } catch {
    return null;
  }
  if (!manifest || typeof manifest.spritesPerSide !== "number" || !manifest.species) {
    return null;
  }

  try {
    const entries = await Promise.all(
      Object.entries(manifest.species).map(async ([id, entry]) => {
        const [albedoBytes, normalBytes] = await Promise.all(
          [entry.albedo, entry.normalDepth].map(async (name) => {
            const response = await fetch(`${baseUrl}/${name}`);
            if (!response.ok) throw new Error(`missing atlas ${name}`);
            return new Uint8Array(await response.arrayBuffer());
          })
        );
        const albedo = await decodePng(albedoBytes);
        const normalDepth = await decodePng(normalBytes);
        const albedoLevels = buildCoveragePreservingMips(albedo, FOLIAGE_ALPHA_CUTOFF);
        const atlas: ImpostorSpeciesAtlas = {
          albedo: makeTexture(albedoLevels),
          normalDepth: makeTexture(weightedNormalMips(normalDepth, albedoLevels)),
          centerY: entry.centerY,
          radius: entry.radius,
        };
        return [id, atlas] as const;
      })
    );
    const bySpecies = new Map(entries);
    return {
      manifest,
      bySpecies,
      dispose() {
        for (const atlas of bySpecies.values()) {
          atlas.albedo.dispose();
          atlas.normalDepth.dispose();
        }
      },
    };
  } catch (error) {
    console.warn("[foliage] impostor atlases unavailable, far ring disabled:", error);
    return null;
  }
}
