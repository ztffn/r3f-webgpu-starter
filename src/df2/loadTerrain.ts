// Runtime loader for real extracted DF terrain assets.
//
// Reads what tools/df2-extract/prepare-terrain.mjs produced into
// /assets/terrain/<slug>/. Those files ARE committed (see README § Asset policy
// and docs/01 §3); what is never committed is retail-extracted data.
//
// Returns null when the assets aren't present, so the app can still fall back to
// synthetic terrain — which now renders grass too (syntheticMaps.ts).

import * as THREE from "three/webgpu";

/** Shape of terrain.json emitted by prepare-terrain.mjs. Exported so the Node
 * game server types the same manifest (type-only — this module is browser-only
 * at runtime). */
export interface TerrainMeta {
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
    detail?: { file: string; width: number; height: number; distinctIndices: number };
    detailColor?: { file: string; tileSize: number; tiles: number; grid: number; atlasSize: number };
    charData?: { entries: number; materials: string[]; hardTiles: number[] };
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
  /**
   * Per-texel detail-tile INDEX (0-255), NEAREST-filtered — indices must never
   * interpolate. Present only alongside detailColorAtlas.
   */
  detailIndexMap: THREE.DataTexture | null;
  /**
   * The detail_color strip repacked as a square tile atlas (prepare-terrain.mjs).
   * This is the original's close-range ground color — the colormap never carried
   * it (docs/06 §11).
   */
  detailColorAtlas: THREE.Texture | null;
  /** Atlas geometry: tiles per row/column. */
  detailGrid: number;
  /** Per-texel grass canopy height, 0-255. LINEAR-filtered — it is the envelope. */
  grassMap: THREE.DataTexture | null;
  grassSource: GrassSource;
  waterHeight: number;
  filter?: [number, number, number];
  meta: TerrainMeta;
}

interface Rgba {
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
}

/** Draw an image URL to a 2D canvas and return its raw RGBA. */
async function loadRgba(url: string): Promise<Rgba> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  // colorSpaceConversion "none": these bytes are DATA, not a picture. Elevation
  // drives the mesh and the concealment field, so the decode has to be
  // byte-exact rather than colour-managed into something that merely looks right.
  const bitmap = await createImageBitmap(await res.blob(), { colorSpaceConversion: "none" });
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

/** Take the red channel of an RGBA buffer as raw 8-bit samples. */
function redChannel({ rgba, width, height }: Rgba): { data: Uint8Array; width: number; height: number } {
  const data = new Uint8Array(width * height);
  for (let i = 0; i < data.length; i++) data[i] = rgba[i * 4];
  return { data, width, height };
}

/**
 * Decode an 8-bit greyscale PNG that is expected to be square.
 *
 * The square-ness is asserted rather than assumed. This used to return the width
 * as a single `size` and discard the height, so a non-square asset produced a
 * buffer of the wrong length with no error — and the dimensions already recorded
 * in terrain.json went unread.
 */
async function loadSquare(url: string, expect?: { width: number; height: number }) {
  const img = redChannel(await loadRgba(url));
  if (img.width !== img.height) {
    throw new Error(`${url}: expected a square map, got ${img.width}x${img.height}`);
  }
  if (expect && (expect.width !== img.width || expect.height !== img.height)) {
    throw new Error(
      `${url}: terrain.json says ${expect.width}x${expect.height}, file is ${img.width}x${img.height}`
    );
  }
  return { data: img.data, size: img.width };
}

/**
 * Stand-in canopy field derived from the colormap's greenness.
 *
 * Used only when the terrain's real `detail_elev` strip is unavailable. A
 * SUBSTITUTED strip is worse than useless: its tile indices mean nothing for this
 * map, so grass lands in arbitrary places. Greenness at least puts canopy where
 * the map visibly has grass, letting the renderer be judged on its own terms.
 * Never presented as real data — see `grassSource`.
 *
 * Exported so tools/grass-rig uses this exact function rather than its own copy.
 */
export function grassFromColormap(rgba: Uint8ClampedArray, width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height);
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

/** Colormap texture built from pixels already in hand, so the file decodes once. */
function colorTextureFromRgba({ rgba, width, height }: Rgba): THREE.DataTexture {
  // Zero-copy view over the decoded pixels; nothing else mutates them.
  const bytes = new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength);
  const tex = new THREE.DataTexture(bytes, width, height, THREE.RGBAFormat);
  // Row 0 is the map's north edge, like the heightmap. DataTexture already
  // defaults to flipY false, but say so: flipping would mirror colour vs relief.
  tex.flipY = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return tex;
}

function makeDetailIndexTexture(data: Uint8Array, size: number): THREE.DataTexture {
  const tex = new THREE.DataTexture(data, size, size, THREE.RedFormat, THREE.UnsignedByteType);
  // NEAREST is load-bearing: these are tile INDICES. Interpolating between
  // index 244 and index 17 yields a tile that exists but has nothing to do
  // with either neighbour.
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.needsUpdate = true;
  return tex;
}

export async function loadTerrain(slug: string): Promise<LoadedTerrain | null> {
  const base = `/assets/terrain/${slug}`;
  let meta: TerrainMeta;
  try {
    const res = await fetch(`${base}/terrain.json`);
    if (!res.ok) return null;
    // A SPA host rewrites unknown paths to index.html with status 200, so `ok` is
    // not enough to prove the file exists — without this the fallback happened
    // silently on any host with a catch-all rewrite.
    const type = res.headers.get("content-type") ?? "";
    if (!type.includes("json")) {
      console.info(`[df2] no prepared assets for "${slug}" — using synthetic terrain.`);
      return null;
    }
    meta = (await res.json()) as TerrainMeta;
  } catch {
    console.info(`[df2] no prepared assets for "${slug}" — using synthetic terrain.`);
    return null;
  }

  try {
    if (!meta.assets.height) return null;
    const { data, size } = await loadSquare(`${base}/${meta.assets.height.file}`, {
      width: meta.assets.height.width,
      height: meta.assets.height.height,
    });

    // --- colormap and canopy field ----------------------------------------
    // The stand-in canopy needs the colormap's PIXELS, so on that path the file
    // is decoded once and the texture is built from the same buffer. It used to
    // be fetched and decoded twice, once by TextureLoader and once for the bake.
    const bakedFromSubstitute =
      meta.assets.grass?.substituted ?? meta.assets.detailElev?.substituted ?? false;
    const useRealStrip = !!meta.assets.grass && !bakedFromSubstitute;

    let colorMap: THREE.Texture | null = null;
    let grassMap: THREE.DataTexture | null = null;
    let grassSource: GrassSource = "none";

    // --- close-range detail color (index map + tile atlas) ----------------
    // Both or neither: an index map without tiles has nothing to point at.
    let detailIndexMap: THREE.DataTexture | null = null;
    let detailColorAtlas: THREE.Texture | null = null;
    let detailGrid = 0;
    if (meta.assets.detail && meta.assets.detailColor) {
      const d = await loadSquare(`${base}/${meta.assets.detail.file}`);
      detailIndexMap = makeDetailIndexTexture(d.data, d.size);
      const atlas = await new THREE.TextureLoader().loadAsync(
        `${base}/${meta.assets.detailColor.file}`
      );
      atlas.flipY = false;
      atlas.colorSpace = THREE.SRGBColorSpace;
      // No mipmaps: minification would average across tile boundaries in the
      // atlas, bleeding one ground type into another. The material fades the
      // detail layer out well before aliasing gets objectionable.
      atlas.generateMipmaps = false;
      atlas.magFilter = THREE.LinearFilter;
      atlas.minFilter = THREE.LinearFilter;
      atlas.wrapS = THREE.ClampToEdgeWrapping;
      atlas.wrapT = THREE.ClampToEdgeWrapping;
      detailColorAtlas = atlas;
      detailGrid = meta.assets.detailColor.grid;
    }

    if (useRealStrip) {
      if (meta.assets.color) {
        colorMap = await new THREE.TextureLoader().loadAsync(`${base}/${meta.assets.color.file}`);
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
      // Real detail_elev strip — the authentic data path.
      const g = await loadSquare(`${base}/${meta.assets.grass!.file}`, {
        width: meta.assets.grass!.width,
        height: meta.assets.grass!.height,
      });
      grassMap = makeGrassTexture(g.data, g.size);
      grassSource = "real";
    } else if (meta.assets.color) {
      // No usable strip: derive a labelled stand-in. One decode serves both the
      // colour texture and the canopy bake.
      const pixels = await loadRgba(`${base}/${meta.assets.color.file}`);
      colorMap = colorTextureFromRgba(pixels);
      if (pixels.width !== pixels.height) {
        throw new Error(
          `colormap must be square to derive a canopy, got ${pixels.width}x${pixels.height}`
        );
      }
      grassMap = makeGrassTexture(
        grassFromColormap(pixels.rgba, pixels.width, pixels.height),
        pixels.width
      );
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
      detailIndexMap,
      detailColorAtlas,
      detailGrid,
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
