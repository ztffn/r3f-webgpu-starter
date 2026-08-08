// Integer hashing for deterministic vegetation placement.
//
// NOT a sin-based hash. `sin(x * 127.1)` is the usual shader idiom and it is what the
// grass shader uses, but it degenerates past arguments of ~50 000 in float32 and cost
// this project a real bug (docs/08 §6.4, "cell indices wrapped to [0,512)"). Placement
// runs on the CPU in float64 with integer inputs, so there is no reason to inherit that
// failure mode: this is an exact 32-bit integer mix, and it produces the same stream on
// every machine, in every browser, and on a server with no renderer present.
//
// That last property is the point. Placement has to be reproducible from
// (map seed, cell, rule version) alone if vegetation is ever to be gameplay cover for
// more than one player — see the design doc's §3. Nothing here may use Math.random.

/** 32-bit integer avalanche (Murmur3 finaliser). Exact in float64 via Math.imul. */
export function mix32(value: number): number {
  let h = value | 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Hash of three integers plus a domain salt, as a uint32. */
export function hash3i(x: number, y: number, z: number, salt = 0): number {
  let h = 0x9e3779b9 ^ (salt | 0);
  h = mix32(h + Math.imul(x | 0, 0x27d4eb2f));
  h = mix32(h + Math.imul(y | 0, 0x165667b1));
  h = mix32(h + Math.imul(z | 0, 0x1b873593));
  return h >>> 0;
}

/**
 * Deterministic PRNG (mulberry32) seeded from a uint32.
 *
 * Chosen over splitting a hash per draw because a cell needs a STREAM: how many plants,
 * where, which species, how big, which variation seed — and a stream keeps those
 * decisions independent, so changing the density rule does not reshuffle every rotation.
 */
export function rng32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
