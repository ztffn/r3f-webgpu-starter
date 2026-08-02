// One tiling 3D noise texture, shared by everything in this renderer that needs noise.
//
// Gradient noise computed in a shader costs roughly eight hashes, eight gradients and a
// trilinear blend PER SAMPLE; a texture fetch costs one fetch. The consumers cannot share
// a noise VALUE — fog samples at the fragment, smoke at a ray's closest approach to a
// puff, blades at their own base — but they can share this texture and its cache.

import * as THREE from "three/webgpu";

/**
 * Texels per side. 64³ RGBA8 is 1 MB, which buys four octaves in one fetch.
 *
 * The precedent for baking rather than computing is this project's own: grassJitter.ts
 * replaced nine sine-based hashes with a single fetch and measured 99.8 ms against
 * 12.57 ms for the same sample count. The trade is that a texture cannot invent detail
 * finer than its own resolution, so very high frequencies still want arithmetic.
 */
const SIZE = 64;

/**
 * Lattice cells per axis, per channel. Each must DIVIDE `SIZE` or the noise stops
 * tiling — the wrap that makes it seamless is a modulo against the cell count.
 *
 * Four octaves in the four channels, so one fetch gives a consumer as much or as little
 * spectrum as it wants: R alone is smooth and broad, R+G+B+A summed is close to fbm.
 */
const OCTAVES = [4, 8, 16, 32];

/** Deterministic, so the bake is identical across runs and reloads. */
function hash3(x: number, y: number, z: number, salt: number): number {
  let h = x * 374761393 + y * 668265263 + z * 2147483647 + salt * 971;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

/** Quintic, so the interpolation is C2 and the lattice does not show as creases. */
const fade = (t: number): number => t * t * t * (t * (t * 6 - 15) + 10);

/**
 * Value noise, evaluated per texel against a periodic lattice.
 *
 * Baked already-interpolated rather than storing the raw lattice: the GPU's own trilinear
 * filter would otherwise be the only smoothing, which is linear and shows the lattice as
 * diamond creases. This costs bake time once and nothing at runtime.
 */
function octave(cells: number, salt: number, x: number, y: number, z: number): number {
  const fx = (x / SIZE) * cells;
  const fy = (y / SIZE) * cells;
  const fz = (z / SIZE) * cells;
  const ix = Math.floor(fx);
  const iy = Math.floor(fy);
  const iz = Math.floor(fz);
  const ux = fade(fx - ix);
  const uy = fade(fy - iy);
  const uz = fade(fz - iz);
  const w = (dx: number, dy: number, dz: number): number =>
    // Wrapped, which is what makes the texture seamless.
    hash3((ix + dx) % cells, (iy + dy) % cells, (iz + dz) % cells, salt);
  const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
  const x00 = lerp(w(0, 0, 0), w(1, 0, 0), ux);
  const x10 = lerp(w(0, 1, 0), w(1, 1, 0), ux);
  const x01 = lerp(w(0, 0, 1), w(1, 0, 1), ux);
  const x11 = lerp(w(0, 1, 1), w(1, 1, 1), ux);
  return lerp(lerp(x00, x10, uy), lerp(x01, x11, uy), uz);
}

/**
 * The shared noise texture.
 *
 * REPEAT wrapped and LINEAR filtered on every axis, because both are load-bearing: the
 * wrap is what lets a consumer scale world metres into it without bounds, and the filter
 * is what keeps the 64-texel lattice from showing as blocks at close range.
 */
export function bakeNoiseTexture(): THREE.Data3DTexture {
  const data = new Uint8Array(SIZE * SIZE * SIZE * 4);
  for (let z = 0; z < SIZE; z++) {
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const i = (z * SIZE * SIZE + y * SIZE + x) * 4;
        for (let c = 0; c < 4; c++) {
          data[i + c] = Math.round(255 * octave(OCTAVES[c], c * 17 + 3, x, y, z));
        }
      }
    }
  }
  const texture = new THREE.Data3DTexture(data, SIZE, SIZE, SIZE);
  texture.format = THREE.RGBAFormat;
  texture.type = THREE.UnsignedByteType;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.wrapR = THREE.RepeatWrapping;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

/** Metres per full wrap of the texture at a consumer's scale of 1. */
export const NOISE_PERIOD = SIZE;
