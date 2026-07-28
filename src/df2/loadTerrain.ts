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
    [k: string]: unknown;
  };
  assets: {
    height?: { file: string; width: number; height: number; rawMin: number; rawMax: number };
    color?: { file: string };
    detail?: { file: string; distinctIndices: number };
  };
  missing: string[];
}

export interface LoadedTerrain {
  slug: string;
  name: string;
  creator: string;
  /** Raw 8-bit elevation samples, row-major. */
  heights: Uint8Array;
  size: number;
  colorMap: THREE.Texture | null;
  waterHeight: number;
  filter?: [number, number, number];
  meta: TerrainMeta;
}

/** Decode an 8-bit greyscale PNG to raw samples via an offscreen 2D canvas. */
async function loadGreyscale(url: string): Promise<{ data: Uint8Array; size: number }> {
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

  const rgba = ctx.getImageData(0, 0, width, height).data;
  const data = new Uint8Array(width * height);
  for (let i = 0; i < data.length; i++) data[i] = rgba[i * 4]; // R channel
  return { data, size: width };
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

    return {
      slug,
      name: meta.trn.terrain_name ?? slug,
      creator: meta.trn.terrain_creator ?? "unknown",
      heights: data,
      size,
      colorMap,
      waterHeight: meta.trn.water_height ?? 0,
      filter: meta.trn.filter,
      meta,
    };
  } catch (err) {
    console.warn(`[df2] terrain "${slug}" failed to load, using synthetic:`, err);
    return null;
  }
}
