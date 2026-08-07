// Hemi-octahedral view mapping for the far-foliage impostor atlas.
//
// The one shared definition of "which direction does atlas tile (i,j) look from" —
// the offline baker, the Node tests and the TSL far material's JS mirror all read this
// file, so the mapping cannot drift between bake time and sample time. Three-free on
// purpose: pure arithmetic over unit vectors, testable without a renderer (docs/08 §10).
//
// The mapping is the standard hemi-octahedral parameterisation (Cigolle et al., "A Survey
// of Efficient Representations for Independent Unit Vectors"): the upper hemisphere is
// folded onto the full [-1,1]² square by a 45° rotation, which puts the HORIZON on the
// square's boundary. That suits this game exactly — the boundary tiles are the views a
// prone or standing player actually uses, and they get first-class grid coverage instead
// of being interpolation leftovers.

export type Vec3 = readonly [number, number, number];

/**
 * Encode a unit direction with y >= 0 into hemi-octahedral coordinates in [-1,1]².
 *
 * Inverse of `hemiOctDecode`. Directions below the horizon are clamped onto it by
 * ignoring the sign of y — the atlas has no views from underneath, and the nearest
 * horizon view is the fairness-preserving substitute (the silhouette stays fully drawn).
 */
export function hemiOctEncode(x: number, y: number, z: number): [number, number] {
  const denom = Math.abs(x) + Math.abs(y) + Math.abs(z);
  const px = denom > 0 ? x / denom : 0;
  const pz = denom > 0 ? z / denom : 0;
  return [px + pz, pz - px];
}

/** Decode hemi-octahedral coordinates in [-1,1]² back to a unit direction, y >= 0. */
export function hemiOctDecode(u: number, v: number): [number, number, number] {
  const px = (u - v) * 0.5;
  const pz = (u + v) * 0.5;
  const py = 1 - Math.abs(px) - Math.abs(pz);
  const length = Math.hypot(px, py, pz);
  return [px / length, py / length, pz / length];
}

/**
 * The view direction baked into grid tile (i, j) of an n-per-side atlas.
 *
 * Grid points span the square INCLUSIVE of both edges (i/(n-1), the convention the
 * reference exporters use), so the four corner tiles and every edge tile are true
 * horizon views.
 */
export function gridViewDirection(i: number, j: number, n: number): [number, number, number] {
  const u = n > 1 ? (2 * i) / (n - 1) - 1 : 0;
  const v = n > 1 ? (2 * j) / (n - 1) - 1 : 0;
  return hemiOctDecode(u, v);
}

export interface ViewBasis {
  /** Image-plane +x, world space. */
  right: Vec3;
  /** Image-plane +y, world space. */
  up: Vec3;
  /** Unit direction from the plant TOWARD the camera; depth is measured along it. */
  toCamera: Vec3;
}

/**
 * Orthonormal frame for a view direction — the contract between baker and shader.
 *
 * `right` is horizontal (world-up crossed with the view), `up` completes the frame.
 * At the exact zenith the horizontal reference degenerates; +x is the documented
 * fallback. A 12-per-side grid never lands a tile exactly on the zenith (the centre of
 * the square falls between tiles for even n), so the fallback is a guard, not a case
 * the atlas exercises.
 */
export function viewBasis(toCamera: Vec3): ViewBasis {
  const [dx, dy, dz] = toCamera;
  let rx: number;
  let ry: number;
  let rz: number;
  if (Math.abs(dy) > 0.999) {
    rx = 1;
    ry = 0;
    rz = 0;
  } else {
    // cross((0,1,0), d), normalised: horizontal, perpendicular to the view.
    rx = dz;
    ry = 0;
    rz = -dx;
    const length = Math.hypot(rx, rz);
    rx /= length;
    rz /= length;
  }
  // cross(d, right) — completes the right-handed frame; unit because d ⊥ right.
  const ux = dy * rz - dz * ry;
  const uy = dz * rx - dx * rz;
  const uz = dx * ry - dy * rx;
  return { right: [rx, ry, rz], up: [ux, uy, uz], toCamera: [dx, dy, dz] };
}

export interface ViewBlend {
  /** Grid tiles (i, j) of the three nearest baked views. */
  tiles: ReadonlyArray<readonly [number, number]>;
  /** Barycentric weights, summing to 1. */
  weights: readonly [number, number, number];
}

/**
 * The three baked views bracketing a direction, with barycentric blend weights.
 *
 * This is the JS mirror of the TSL sampling logic — the tests compare the two — and the
 * standard octahedral-impostor triangle pick: the fractional grid cell splits along its
 * diagonal into two triangles, and the weights are the barycentrics of the query point
 * inside whichever triangle holds it.
 */
export function blendViews(direction: Vec3, n: number): ViewBlend {
  const [u, v] = hemiOctEncode(direction[0], direction[1], direction[2]);
  const clamp01 = (t: number) => Math.min(1, Math.max(0, t));
  const gx = clamp01((u + 1) * 0.5) * (n - 1);
  const gy = clamp01((v + 1) * 0.5) * (n - 1);
  const i0 = Math.min(n - 2, Math.floor(gx));
  const j0 = Math.min(n - 2, Math.floor(gy));
  const fx = gx - i0;
  const fy = gy - j0;

  if (fx + fy < 1) {
    return {
      tiles: [
        [i0, j0],
        [i0 + 1, j0],
        [i0, j0 + 1],
      ],
      weights: [1 - fx - fy, fx, fy],
    };
  }
  return {
    tiles: [
      [i0 + 1, j0 + 1],
      [i0, j0 + 1],
      [i0 + 1, j0],
    ],
    weights: [fx + fy - 1, 1 - fx, 1 - fy],
  };
}
