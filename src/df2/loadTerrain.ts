// Runtime loader for real extracted DF terrain assets.
//
// Reads what tools/df2-extract/prepare-terrain.mjs produced into
// /assets/terrain/<slug>/ (a git-ignored directory — extracted game assets are
// never committed, see docs/06-asset-extraction-findings.md).
//
// Returns null when the assets aren't present, so the app can fall back to
// synthetic terrain without the user having to install anything.

import * as THREE from "three/webgpu";

/** Shape of terrain.json emitted by prepare-terrain.mjs. */
interface TerrainMeta {
  source: string;
  trn: {
    terrain_name?: string;
    terrain_creator?: string;
    water_height?: number;
    filter?: [number, number, number];
    sun_slope?: number;
    detail_elev?: string;
    [k: string]: unknown;
  };
  assets: {
    height?: { file: string; width: number; height: number; rawMin: number; rawMax: number };
    color?: { file: string };
    detail?: { file: string; distinctIndices: number };
    grass?: {
      file: string;
      width: number;
      height: number;
      rawMin: number;
      rawMax: number;
      rawMean: number;
      /** True when baked from a SUBSTITUTED detail_elev strip (docs/06 §7). */
      substituted?: boolean;
    };
    detailElev?: { substituted?: boolean; referencedName?: string };
  };
  missing: string[];
}

/** How the grass canopy field was obtained — surfaced so it's never mistaken for real data. */
export type GrassSource = "real" | "substituted-strip" | "colormap-standin" | "none";

export interface LoadedTerrain {
  slug: string;
  name: string;
  creator: string;
  /** Raw 8-bit elevation samples, row-major. */
  heights: Uint8Array;
  size: number;
  colorMap: THREE.Texture | null;
  /** Per-texel grass canopy height, 0-255. NEAREST-filtered: columns are discrete. */
  grassMap: THREE.DataTexture | null;
  grassSource: GrassSource;
  waterHeight: number;
  filter?: [number, number, number];
  meta: TerrainMeta;
}

/** Draw an image URL to a 2D canvas and return its raw RGBA. */
async function loadRgba(
  url: string
): Promise<{ rgba: Uint8ClampedArray; width: number; height: number }> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  const bitmap = await createImageBitmap(await res.blob());
  const { width, height } = bitmap;

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("2D canvas unavailable");
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();

  return { rgba: ctx.getImageData(0, 0, width, height).data, width, height };
}

/** Decode an 8-bit greyscale PNG to raw samples. */
async function loadGreyscale(url: string): Promise<{ data: Uint8Array; size: number }> {
  const { rgba, width } = await loadRgba(url);
  const data = new Uint8Array(rgba.length / 4);
  for (let i = 0; i < data.length; i++) data[i] = rgba[i * 4]; // R channel
  return { data, size: width };
}

/**
 * Stand-in canopy field derived from the colormap's greenness.
 *
 * Used only when the terrain's real `detail_elev` strip is unavailable. A
 * SUBSTITUTED strip is worse than useless: its tile indices mean nothing for this
 * map, so grass lands in arbitrary places. Greenness at least puts canopy where
 * the map visibly has grass, letting the renderer be judged on its own terms.
 * Never presented as real data — see `grassSource`.
 */
function grassFromColormap(rgba: Uint8ClampedArray, size: number): Uint8Array {
  const out = new Uint8Array(size * size);
  for (let i = 0; i < out.length; i++) {
    const r = rgba[i * 4];
    const g = rgba[i * 4 + 1];
    const b = rgba[i * 4 + 2];
    // How far green dominates the other channels, normalised.
    const greenness = Math.max(0, (g - (r + b) / 2) / 64);
    // Per-column jitter keeps the canopy top ragged (docs/07 §1.3).
    const h = (i * 2654435761) >>> 0;
    const jitter = 0.74 + 0.26 * (((h >>> 8) & 255) / 255);
    out[i] = Math.max(0, Math.min(255, Math.round(255 * Math.min(1, greenness) * jitter)));
  }
  return out;
}

function makeGrassTexture(data: Uint8Array, size: number): THREE.DataTexture {
  const tex = new THREE.DataTexture(data, size, size, THREE.RedFormat, THREE.UnsignedByteType);
  // LINEAR: this texture is the canopy ENVELOPE (where grass grows and roughly
  // how tall), not the columns themselves. Per-column height and colour come
  // from the shader's cell hash, which runs at sub-metre grass-cell resolution.
  // Sampling the envelope NEAREST just stamps the 2 m terrain texel grid onto
  // the canopy as visible blocks.
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.needsUpdate = true;
  return tex;
}

export async function loadTerrain(slug: string): Promise<LoadedTerrain | null> {
  let meta: TerrainMeta;
  try {
    const res = await fetch(`assets/terrain/${slug}/terrain.json`);
    if (!res.ok) return null;
    meta = (await res.json()) as TerrainMeta;
  } catch {
    return null; // no prepared assets — caller falls back to synthetic
  }

  try {
    if (!meta.assets.height) return null;
    const { data, size } = await loadGreyscale(`assets/terrain/${slug}/${meta.assets.height.file}`);

    let colorMap: THREE.Texture | null = null;
    if (meta.assets.color) {
      colorMap = await new THREE.TextureLoader().loadAsync(
        `assets/terrain/${slug}/${meta.assets.color.file}`
      );
      // Image row 0 is the map's north edge, matching how the heightmap is
      // sampled — so don't flip, or the colormap would mirror against the relief.
      colorMap.flipY = false;
      colorMap.colorSpace = THREE.SRGBColorSpace;
      colorMap.anisotropy = 8;
      // The map tiles infinitely (docs/06 §10), so UVs run past [0,1] and the
      // colormap must repeat rather than smear its edge pixels.
      colorMap.wrapS = THREE.RepeatWrapping;
      colorMap.wrapT = THREE.RepeatWrapping;
    }

    // --- grass canopy field ------------------------------------------------
    let grassMap: THREE.DataTexture | null = null;
    let grassSource: GrassSource = "none";
    const bakedFromSubstitute =
      meta.assets.grass?.substituted ?? meta.assets.detailElev?.substituted ?? false;

    if (meta.assets.grass && !bakedFromSubstitute) {
      // Real detail_elev strip — the authentic data path.
      const g = await loadGreyscale(`assets/terrain/${slug}/${meta.assets.grass.file}`);
      grassMap = makeGrassTexture(g.data, g.size);
      grassSource = "real";
    } else if (meta.assets.color) {
      // No usable strip for this terrain; derive a labelled stand-in.
      const { rgba, width } = await loadRgba(`assets/terrain/${slug}/${meta.assets.color.file}`);
      grassMap = makeGrassTexture(grassFromColormap(rgba, width), width);
      grassSource = "colormap-standin";
      console.info(
        `[df2] "${meta.trn.terrain_name}": real detail_elev "${meta.assets.detailElev?.referencedName ?? meta.trn.detail_elev}" ` +
          `unavailable — using a colormap-derived STAND-IN canopy (not authentic grass data).`
      );
    }

    return {
      slug,
      name: meta.trn.terrain_name ?? slug,
      creator: meta.trn.terrain_creator ?? "unknown",
      heights: data,
      size,
      colorMap,
      grassMap,
      grassSource,
      waterHeight: meta.trn.water_height ?? 0,
      filter: meta.trn.filter,
      meta,
    };
  } catch (err) {
    console.warn(`[df2] terrain "${slug}" failed to load, using synthetic:`, err);
    return null;
  }
}
