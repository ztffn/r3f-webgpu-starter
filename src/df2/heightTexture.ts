// Elevation as a GPU texture, with a mip chain that matches the terrain MESH.
//
// The grass march and the terrain mesh must not merely read the same data — they
// must RECONSTRUCT THE SAME SURFACE. The mesh rebuilds it as flat triangles over a
// decimated lattice whose spacing depends on the chunk's LOD; this texture's mips
// hold exactly that lattice, so the march can follow the surface the mesh drew.

import * as THREE from "three/webgpu";
import type { Heightfield } from "./Heightfield";

/**
 * Why POINT DECIMATION rather than the usual averaging mipmap.
 *
 * `terrainGeometry` places a vertex every `size / segments` metres and takes its
 * height from `heightfield.sample()` there. `LOD_SEGMENTS` halves per level, so mesh
 * LOD k lands on every 2^k-th grid sample and never averages. A box-filtered mip
 * would describe a THIRD surface, matching neither the mesh nor the full-resolution
 * field — replacing one disagreement with another.
 *
 * Point decimation makes mip k exactly the samples the mesh interpolates at LOD k.
 * The only residual is triangles versus bilinear over that same lattice, which is a
 * fraction of the local curvature and shrinks as the lattice refines.
 *
 * WHAT THIS FIXES. The mesh at LOD 3 has 16 m vertex spacing, so its facets deviate
 * from the full-resolution surface by of order a metre on a hillside. The march read
 * the full-resolution field and wrote hit depth there, so wherever a facet sat above
 * the marched surface the terrain won the depth test and swallowed the grass whole —
 * measured as entire hillsides returning no grass, with the canopy forced on and the
 * ray span raised to 300 m to rule both of those out, and confirmed by wireframing
 * the terrain, which made the grass reappear. Extending full-resolution terrain to
 * 1536 m also removed it, at 17.5 ms against 9 ms; that is what rules out "draw more
 * vertices" and leaves matching the mesh as the affordable fix.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO. It does not make the drawn ground agree with
 * the CPU heightfield the concealment query reads. Nothing can: the mesh is already
 * LOD'd, so what the screen shows is already LOD-dependent, and a target at 800 m is
 * already occluded by a facet a metre off the true surface. The goal here is that
 * everything the RENDERER draws agrees with itself. The renderer-to-gameplay gap is
 * then bounded by the LOD schedule (`LOD_DISTANCE_CHUNKS`), which makes that schedule
 * a fairness dial and not only a performance one.
 */
export function buildHeightTexture(heightfield: Heightfield): THREE.DataTexture {
  const { grid, period } = heightfield;

  const toHalf = (src: Float32Array): Uint16Array => {
    const out = new Uint16Array(src.length);
    for (let i = 0; i < src.length; i++) out[i] = THREE.DataUtils.toHalfFloat(src[i]);
    return out;
  };

  // HALF-FLOAT carrying METRES, built from the heightfield's own grid rather than raw
  // bytes: the grid is reconstructed to remove 8-bit terracing (smoothTerracing), so
  // uploading bytes would leave the march on a quantised surface the mesh no longer
  // draws — docs/08 §8 invariant 3. Half rather than float32 because WebGPU does not
  // guarantee float32 is filterable and this needs LINEAR; half gives ~0.1 m over this
  // map's 169 m of relief.
  const base = toHalf(grid);
  const texture = new THREE.DataTexture(
    base,
    period,
    period,
    THREE.RedFormat,
    THREE.HalfFloatType
  );

  // `period` is a power of two and every lookup wraps modulo it, so each decimated
  // level tiles exactly like the base.
  const levels: Array<{ data: Uint16Array; width: number; height: number }> = [
    { data: base, width: period, height: period },
  ];
  let size = period;
  let stride = 1;
  while (size > 1) {
    size >>= 1;
    stride <<= 1;
    const level = new Float32Array(size * size);
    for (let j = 0; j < size; j++) {
      const srcRow = j * stride * period;
      for (let i = 0; i < size; i++) level[j * size + i] = grid[srcRow + i * stride];
    }
    levels.push({ data: toHalf(level), width: size, height: size });
  }
  texture.mipmaps = levels;
  texture.generateMipmaps = false;

  // LINEAR within a level so the surface is smooth; NEAREST between levels so an
  // explicitly requested level is the one sampled rather than a blend of two. Blending
  // across that boundary would put the march back on a surface the mesh never drew,
  // which is the whole defect.
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapNearestFilter;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.needsUpdate = true;

  return texture;
}
