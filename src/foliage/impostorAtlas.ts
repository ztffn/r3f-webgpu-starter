// Runtime loader for the baked hemi-octahedral impostor atlases.
//
// Fetches the manifest and per-species KTX2 atlases from public/assets/vegetation/
// impostors/ and hands them to three's KTX2Loader, which transcodes UASTC to whatever
// block format the adapter reports. The mip chains are SOLVED AT BAKE TIME and carried
// inside the files, so nothing is derived here — the previous PNG path decoded ~26 MB by
// hand and rebuilt every chain on the main thread. Resolves to null when the assets are
// absent or unreadable, so the far ring declines to exist without taking the layer down.

import * as THREE from "three/webgpu";
import { KTX2Loader } from "three/addons/loaders/KTX2Loader.js";

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
  /** Block-compressed after transcode; a plain Texture, not a DataTexture. */
  albedo: THREE.Texture;
  normalDepth: THREE.Texture;
  centerY: number;
  radius: number;
}

export interface ImpostorAtlases {
  manifest: ImpostorManifest;
  bySpecies: ReadonlyMap<string, ImpostorSpeciesAtlas>;
  dispose(): void;
}

export async function loadImpostorAtlases(
  /**
   * Needed for `detectSupport` — which block formats the adapter can actually take.
   *
   * OPTIONAL only so a caller that has no renderer still compiles; without one the
   * atlases cannot be transcoded and this resolves to null with a warning naming the
   * fix. It does not fall back to anything, because a silent fallback here would be a
   * different silhouette from the one the bake audited.
   */
  renderer?: Parameters<KTX2Loader["detectSupport"]>[0],
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

  // The transcoder is a WASM module the loader fetches once; both files are committed
  // under public/basis rather than pulled from a CDN, because a published page runs under
  // a CSP that blocks external hosts.
  if (!renderer) {
    console.warn(
      "[foliage] loadImpostorAtlases needs the renderer to detect supported texture " +
        "formats; pass it as the first argument. Impostors are unavailable without it."
    );
    return null;
  }
  const loader = new KTX2Loader().setTranscoderPath("/basis/").detectSupport(renderer);

  try {
    const entries = await Promise.all(
      Object.entries(manifest.species).map(async ([id, entry]) => {
        const [albedo, normalDepth] = await Promise.all(
          [entry.albedo, entry.normalDepth].map((name) => loader.loadAsync(`${baseUrl}/${name}`))
        );
        // Everything the old path did on the main thread — a per-byte PNG unfilter and a
        // coverage-preserving mip solve per atlas — is now bake-time work carried inside
        // the file. What arrives is already the mip chain, already GPU-compressed.
        for (const texture of [albedo, normalDepth]) {
          texture.wrapS = THREE.ClampToEdgeWrapping;
          texture.wrapT = THREE.ClampToEdgeWrapping;
          // NoColorSpace: the bake writes LINEAR values and the file is tagged linear.
          // Marking these sRGB would re-transform them and the two tiers would stop
          // matching — the same trap the PNG path documented.
          texture.colorSpace = THREE.NoColorSpace;
          // Anisotropy stays at 1: anisotropic taps walk a line in uv space, and on a
          // tiled atlas that line crosses into the neighbouring VIEW well before the
          // tile-edge clamp in the shader can stop it.
          texture.anisotropy = 1;
          texture.needsUpdate = true;
        }
        const atlas: ImpostorSpeciesAtlas = {
          albedo,
          normalDepth,
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
        loader.dispose();
      },
    };
  } catch (error) {
    loader.dispose();
    console.warn("[foliage] impostor atlases unavailable, far ring disabled:", error);
    return null;
  }
}
