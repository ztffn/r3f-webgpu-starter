// Deterministic, dependency-free value noise + fBm.
//
// Used to synthesize a heightfield stand-in until real DF2/TXP/EXP2 heightmaps
// are available (Phase 0). Deterministic so the terrain — and the CPU-side
// gameplay heightfield derived from it (04-concealment-system-design.md) — are
// identical every run and across the client/server split a future multiplayer
// mode would need.

// Integer hash -> pseudo-random float in [0,1). 2D lattice point hash.
function hash2(ix, iz, seed) {
  let h = ix * 374761393 + iz * 668265263 + seed * 2246822519;
  h = (h ^ (h >>> 13)) * 1274126177;
  h = h ^ (h >>> 16);
  // >>> 0 forces unsigned; divide by 2^32.
  return (h >>> 0) / 4294967296;
}

function smootherstep(t) {
  // Ken Perlin's quintic smootherstep: smoother interpolation, C2 continuous.
  return t * t * t * (t * (t * 6 - 15) + 10);
}

// Value noise sampled at continuous (x, z) over the integer lattice.
function valueNoise(x, z, seed) {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;

  const v00 = hash2(ix, iz, seed);
  const v10 = hash2(ix + 1, iz, seed);
  const v01 = hash2(ix, iz + 1, seed);
  const v11 = hash2(ix + 1, iz + 1, seed);

  const ux = smootherstep(fx);
  const uz = smootherstep(fz);

  const a = v00 + (v10 - v00) * ux;
  const b = v01 + (v11 - v01) * ux;
  return a + (b - a) * uz; // [0,1]
}

// Fractal Brownian motion: sum of octaves of value noise.
// Returns a value in [0,1].
export function fbm(x, z, {
  seed = 1337,
  octaves = 6,
  frequency = 1,
  lacunarity = 2.0,
  gain = 0.5,
} = {}) {
  let amp = 0.5;
  let freq = frequency;
  let sum = 0;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * valueNoise(x * freq, z * freq, seed + o * 101);
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm; // normalized back to [0,1]
}
