// Deterministic, dependency-free value noise + fBm.
//
// Used to synthesize a heightfield stand-in until real DF2/TXP/EXP2 heightmaps
// are available (Phase 0). Deterministic so the terrain — and the CPU-side
// gameplay heightfield derived from it (docs/04-concealment-system-design.md) —
// are identical every run and across the client/server split a future
// multiplayer mode would need.

// Integer hash -> pseudo-random float in [0,1). 2D lattice point hash.
// `period` wraps the lattice so the field tiles seamlessly — DF terrain tiles
// infinitely (docs/06 §10), so the synthetic fallback must too.
export function hash2(ix: number, iz: number, seed: number, period: number): number {
  if (period > 0) {
    ix = ((ix % period) + period) % period;
    iz = ((iz % period) + period) % period;
  }
  let h = ix * 374761393 + iz * 668265263 + seed * 2246822519;
  h = (h ^ (h >>> 13)) * 1274126177;
  h = h ^ (h >>> 16);
  // >>> 0 forces unsigned; divide by 2^32.
  return (h >>> 0) / 4294967296;
}

function smootherstep(t: number): number {
  // Ken Perlin's quintic smootherstep: smoother interpolation, C2 continuous.
  return t * t * t * (t * (t * 6 - 15) + 10);
}

// Value noise sampled at continuous (x, z) over the integer lattice.
function valueNoise(x: number, z: number, seed: number, period: number): number {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;

  const v00 = hash2(ix, iz, seed, period);
  const v10 = hash2(ix + 1, iz, seed, period);
  const v01 = hash2(ix, iz + 1, seed, period);
  const v11 = hash2(ix + 1, iz + 1, seed, period);

  const ux = smootherstep(fx);
  const uz = smootherstep(fz);

  const a = v00 + (v10 - v00) * ux;
  const b = v01 + (v11 - v01) * ux;
  return a + (b - a) * uz; // [0,1]
}

export interface FbmOptions {
  seed?: number;
  octaves?: number;
  frequency?: number;
  lacunarity?: number;
  gain?: number;
  /**
   * Lattice period at the base frequency. When the sampled domain spans exactly
   * this many lattice units, the field tiles seamlessly. 0 disables wrapping.
   */
  period?: number;
}

// Fractal Brownian motion: sum of octaves of value noise. Returns a value in [0,1].
export function fbm(x: number, z: number, opts: FbmOptions = {}): number {
  const {
    seed = 1337,
    octaves = 6,
    frequency = 1,
    lacunarity = 2.0,
    gain = 0.5,
    period = 0,
  } = opts;

  let amp = 0.5;
  let freq = frequency;
  let per = period;
  let sum = 0;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * valueNoise(x * freq, z * freq, seed + o * 101, per);
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
    per *= lacunarity; // period scales with frequency so every octave tiles
  }
  return sum / norm; // normalized back to [0,1]
}
