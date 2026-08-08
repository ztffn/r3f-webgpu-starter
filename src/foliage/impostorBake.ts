// Software rasteriser that bakes the hemi-octahedral impostor atlas offline.
//
// Renders the plant's LOD 0 card geometry from every grid view into two atlases —
// flat-colour albedo with a coverage alpha, and plant-space normal plus depth — using
// exactly the alpha test the near field applies at runtime, so the far tier's silhouette
// IS the near tier's silhouette by construction (docs/08 §8 invariant 6). Pure arithmetic
// over typed arrays: no Three.js, no canvas, no GPU, so the bake runs in Node, is
// deterministic, and its blocking-fraction audit is a unit test rather than an eyeball.
//
// The near-field material paints leaves as a flat per-species tint and bark as a flat
// colour (FoliageMaterial ignores the leaf texture's RGB — only its alpha cuts), so the
// albedo baked here is those same two flat colours; per-instance tone stays a runtime
// multiply. Lighting is NOT baked: normals are stored so the far material can apply its
// sun term against the live sun direction.

import type { MipLevel } from "./alphaMips.ts";
import { gridViewDirection, viewBasis } from "./octahedral.ts";

export interface ImpostorMeshData {
  /** Non-indexed triangle soup, plant space (y up from the ground at the base). */
  position: Float32Array;
  normal: Float32Array;
  uv: Float32Array;
  /** 1 where the leaf texture cuts alpha, 0 for solid bark. Per vertex. */
  leaf: Float32Array;
}

export interface ImpostorBakeOptions {
  mesh: ImpostorMeshData;
  /**
   * Base level of the leaf texture. Always the alpha source; when `barkTexture` is
   * present its COLOUR is sampled too (the authored-prototype mode), otherwise colour
   * comes from the flat tints below (the procedural mode).
   */
  leafTexture: MipLevel;
  /**
   * Present for authored prototypes: bark colour is sampled from it with WRAPPED uvs
   * (the packs tile their bark vertically), and leaf colour from `leafTexture`.
   * Texture bytes are sRGB and are linearised before any filtering or averaging —
   * the atlas stores linear values, like the flat-colour path always has.
   */
  barkTexture?: MipLevel;
  /** Linear 0-1. Flat colours, matching the near-field colorNode. */
  leafColor: readonly [number, number, number];
  barkColor: readonly [number, number, number];
  /** The near field's cutoff (FOLIAGE_ALPHA_CUTOFF) — the silhouette definition. */
  alphaCutoff: number;
  spritesPerSide: number;
  /** Output tile side, texels. */
  tileSize: number;
  /** Rendered at tileSize × supersample and box-reduced; edges land as fractional alpha. */
  supersample?: number;
  /**
   * The crown's frontal rectangle, for the blocking-fraction audit — the SAME rectangle
   * `blockingFractionOf` in foliageGeometry measures over, so the numbers compare.
   */
  crown?: { radiusMetres: number; baseY: number; topY: number };
}

export interface ImpostorBakeResult {
  albedo: MipLevel;
  /**
   * RGB = plant-space normal * 0.5 + 0.5; A = depth along the view, 0-1 across bounds.
   *
   * NOTHING READS THE DEPTH CHANNEL TODAY — `FarFoliageMaterial` samples `.rgb` only. It
   * is baked and kept because it is the alpha of a texture that has to exist anyway, so
   * it costs no runtime memory, and dropping it would change every committed atlas and
   * foreclose depth-offset or parallax work on the ring. Recorded here so the next reader
   * does not have to re-derive whether it is load-bearing.
   */
  normalDepth: MipLevel;
  /** Height of the framed square's centre above the plant base, metres. */
  centerY: number;
  /** Half-side of the framed square, metres. Vertices never project outside it. */
  radius: number;
  /**
   * Fraction of the crown's frontal rectangle covered per tile (alpha >= cutoff),
   * indexed j * spritesPerSide + i. NaN when no crown rectangle was supplied.
   */
  tileCoverage: Float32Array;
}

/** A texture pre-converted to linear-light floats, so filtering averages correctly. */
interface LinearTexture {
  data: Float32Array;
  width: number;
  height: number;
}

/** sRGB byte to linear float. Exported so the CLI baker cannot transcribe a second curve. */
export function srgbToLinear(byte: number): number {
  const c = byte / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function linearise(level: MipLevel): LinearTexture {
  const data = new Float32Array(level.data.length);
  for (let i = 0; i < level.data.length; i += 4) {
    data[i] = srgbToLinear(level.data[i]);
    data[i + 1] = srgbToLinear(level.data[i + 1]);
    data[i + 2] = srgbToLinear(level.data[i + 2]);
    data[i + 3] = level.data[i + 3] / 255;
  }
  return { data, width: level.width, height: level.height };
}

const sampleScratch: [number, number, number, number] = [0, 0, 0, 0];

function sampleBilinear(
  texture: LinearTexture,
  u: number,
  v: number,
  wrap: boolean
): [number, number, number, number] {
  if (wrap) {
    u -= Math.floor(u);
    v -= Math.floor(v);
  }
  const x = Math.min(Math.max(u * texture.width - 0.5, 0), texture.width - 1);
  const y = Math.min(Math.max(v * texture.height - 0.5, 0), texture.height - 1);
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(texture.width - 1, x0 + 1);
  const y1 = Math.min(texture.height - 1, y0 + 1);
  const fx = x - x0;
  const fy = y - y0;
  for (let c = 0; c < 4; c += 1) {
    const at = (px: number, py: number) => texture.data[(py * texture.width + px) * 4 + c];
    const top = at(x0, y0) * (1 - fx) + at(x1, y0) * fx;
    const bottom = at(x0, y1) * (1 - fx) + at(x1, y1) * fx;
    sampleScratch[c] = top * (1 - fy) + bottom * fy;
  }
  return sampleScratch;
}

/** Bakes both atlases. Rows run bottom-up: array row 0 is the plant's base (uv v = 0). */
export function bakeImpostorAtlas(options: ImpostorBakeOptions): ImpostorBakeResult {
  const { mesh, alphaCutoff } = options;
  const n = options.spritesPerSide;
  const tile = options.tileSize;
  const ss = options.supersample ?? 2;
  const vertexCount = mesh.position.length / 3;

  // Frame: a square of half-side R about (0, centerY, 0), sized so no vertex can leave
  // it from any view — |p - center| bounds every orthographic projection.
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < vertexCount; i += 1) {
    const y = mesh.position[i * 3 + 1];
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const centerY = (minY + maxY) * 0.5;
  let radius = 0;
  for (let i = 0; i < vertexCount; i += 1) {
    const x = mesh.position[i * 3];
    const y = mesh.position[i * 3 + 1] - centerY;
    const z = mesh.position[i * 3 + 2];
    const d = Math.sqrt(x * x + y * y + z * z);
    if (d > radius) radius = d;
  }
  radius *= 1.02; // a texel of slack so edge-on cards do not clip on the frame boundary

  const atlasSize = n * tile;
  const albedo = new Uint8Array(atlasSize * atlasSize * 4);
  const normalDepth = new Uint8Array(atlasSize * atlasSize * 4);
  const tileCoverage = new Float32Array(n * n).fill(Number.NaN);

  // Linearised once: filtering and tile averaging must happen in linear light, and the
  // authored textures arrive as sRGB bytes. Authored uvs WRAP — the tree pack keeps its
  // leaf uvs in v ∈ [1,2] and relies on REPEAT (the glTF sampler default); clamping them
  // here once baked every crown to nothing while the trunks looked fine.
  const shading = {
    leaf: linearise(options.leafTexture),
    bark: options.barkTexture ? linearise(options.barkTexture) : null,
    wrap: options.barkTexture !== undefined,
  };

  // Supersampled per-tile scratch plus per-vertex projection, reused across every view.
  const ssSize = tile * ss;
  const scratch: BakeScratch = {
    ssSize,
    covered: new Uint8Array(ssSize * ssSize),
    color: new Float32Array(ssSize * ssSize * 3),
    normalAcc: new Float32Array(ssSize * ssSize * 3),
    zbuf: new Float32Array(ssSize * ssSize),
    projX: new Float32Array(vertexCount),
    projY: new Float32Array(vertexCount),
    projZ: new Float32Array(vertexCount),
  };
  const { covered, color, normalAcc, zbuf, projX, projY, projZ } = scratch;

  for (let j = 0; j < n; j += 1) {
    for (let i = 0; i < n; i += 1) {
      const direction = gridViewDirection(i, j, n);
      const basis = viewBasis(direction);
      covered.fill(0);
      color.fill(0);
      normalAcc.fill(0);
      zbuf.fill(-Infinity);

      // Project every vertex into the view's image plane, in supersampled pixels.
      // Image y grows UPWARD from the plant base (row 0 = bottom), so no flip exists
      // anywhere in the chain — the shader's tile uv y is height, directly.
      const scale = ssSize / (radius * 2);
      for (let v = 0; v < vertexCount; v += 1) {
        const px = mesh.position[v * 3];
        const py = mesh.position[v * 3 + 1] - centerY;
        const pz = mesh.position[v * 3 + 2];
        projX[v] = (px * basis.right[0] + py * basis.right[1] + pz * basis.right[2] + radius) * scale;
        projY[v] = (px * basis.up[0] + py * basis.up[1] + pz * basis.up[2] + radius) * scale;
        projZ[v] = px * basis.toCamera[0] + py * basis.toCamera[1] + pz * basis.toCamera[2];
      }

      for (let t = 0; t < vertexCount; t += 3) {
        rasteriseTriangle(t, options, shading, scratch, basis.toCamera);
      }

      // Box-reduce the supersampled tile into the two atlases.
      const tileBaseX = i * tile;
      const tileBaseY = j * tile;
      let tileNx = 0;
      let tileNy = 0;
      let tileNz = 0;
      for (let ty = 0; ty < tile; ty += 1) {
        for (let tx = 0; tx < tile; tx += 1) {
          let hits = 0;
          let r = 0;
          let g = 0;
          let b = 0;
          let nx = 0;
          let ny = 0;
          let nz = 0;
          let depth = 0;
          for (let sy = 0; sy < ss; sy += 1) {
            for (let sx = 0; sx < ss; sx += 1) {
              const s = (ty * ss + sy) * ssSize + tx * ss + sx;
              if (!covered[s]) continue;
              hits += 1;
              r += color[s * 3];
              g += color[s * 3 + 1];
              b += color[s * 3 + 2];
              nx += normalAcc[s * 3];
              ny += normalAcc[s * 3 + 1];
              nz += normalAcc[s * 3 + 2];
              depth += zbuf[s];
            }
          }
          const out = ((tileBaseY + ty) * atlasSize + tileBaseX + tx) * 4;
          if (hits > 0) {
            albedo[out] = Math.round((r / hits) * 255);
            albedo[out + 1] = Math.round((g / hits) * 255);
            albedo[out + 2] = Math.round((b / hits) * 255);
            albedo[out + 3] = Math.round((hits / (ss * ss)) * 255);
            const nl = Math.hypot(nx, ny, nz) || 1;
            normalDepth[out] = Math.round((nx / nl) * 127.5 + 127.5);
            normalDepth[out + 1] = Math.round((ny / nl) * 127.5 + 127.5);
            normalDepth[out + 2] = Math.round((nz / nl) * 127.5 + 127.5);
            normalDepth[out + 3] = Math.round(Math.min(1, Math.max(0, (depth / hits / radius) * 0.5 + 0.5)) * 255);
            tileNx += nx / nl;
            tileNy += ny / nl;
            tileNz += nz / nl;
          } else {
            // Uncovered texels keep the LEAF colour at zero alpha. Bilinear filtering and
            // the alpha-weighted mip chain both read neighbours of edge texels; leaving
            // these black would pull a dark fringe into every silhouette edge — the same
            // defect alphaMips.ts documents, arriving through the filter instead.
            albedo[out] = Math.round(options.leafColor[0] * 255);
            albedo[out + 1] = Math.round(options.leafColor[1] * 255);
            albedo[out + 2] = Math.round(options.leafColor[2] * 255);
          }
        }
      }

      // Uncovered normal texels take the tile's MEAN covered normal, for the same
      // reason the albedo dilates: filtering reads them at silhouette edges. Filling
      // with straight-up was measured wrong on screen — deep mips averaged every
      // impostor's normal toward the sky, which maxed the sun term and the sky fill
      // and rendered the whole far ring a shade too bright.
      {
        const meanLength = Math.hypot(tileNx, tileNy, tileNz);
        const fx = meanLength > 1e-5 ? tileNx / meanLength : 0;
        const fy = meanLength > 1e-5 ? tileNy / meanLength : 1;
        const fz = meanLength > 1e-5 ? tileNz / meanLength : 0;
        for (let ty = 0; ty < tile; ty += 1) {
          for (let tx = 0; tx < tile; tx += 1) {
            const out = ((tileBaseY + ty) * atlasSize + tileBaseX + tx) * 4;
            if (albedo[out + 3] === 0) {
              normalDepth[out] = Math.round(fx * 127.5 + 127.5);
              normalDepth[out + 1] = Math.round(fy * 127.5 + 127.5);
              normalDepth[out + 2] = Math.round(fz * 127.5 + 127.5);
            }
          }
        }
      }

      if (options.crown) {
        tileCoverage[j * n + i] = measureTileCoverage(
          albedo,
          atlasSize,
          tileBaseX,
          tileBaseY,
          tile,
          radius,
          centerY,
          alphaCutoff,
          options.crown
        );
      }
    }
  }

  return {
    albedo: { data: albedo, width: atlasSize, height: atlasSize },
    normalDepth: { data: normalDepth, width: atlasSize, height: atlasSize },
    centerY,
    radius,
    tileCoverage,
  };
}

/**
 * The per-view scratch the rasteriser reads and writes.
 *
 * One object rather than nine positional arguments: five of them are `Float32Array` and
 * the argument order was unchecked by types, so a transposed pair would have compiled and
 * produced a subtly wrong atlas. Allocated once per bake and cleared per view.
 */
interface BakeScratch {
  projX: Float32Array;
  projY: Float32Array;
  projZ: Float32Array;
  ssSize: number;
  covered: Uint8Array;
  color: Float32Array;
  normalAcc: Float32Array;
  /**
   * Depth of the nearest surviving fragment, in view units.
   *
   * ONE buffer, not two. The depth TEST and the depth the tile average reads are the same
   * number written at the same point, so a second copy was a full supersampled
   * `Float32Array` cleared once per view to hold a duplicate. The averaging pass only
   * reads texels `covered` marks, which are exactly the texels this was written for, so
   * the differing clear values (-Infinity here, 0 there) were never observable.
   */
  zbuf: Float32Array;
}

function rasteriseTriangle(
  t: number,
  options: ImpostorBakeOptions,
  shading: { leaf: LinearTexture; bark: LinearTexture | null; wrap: boolean },
  scratch: BakeScratch,
  toCamera: readonly [number, number, number]
): void {
  const { projX, projY, projZ, ssSize, covered, color, normalAcc, zbuf } = scratch;
  const { mesh, alphaCutoff, leafColor, barkColor } = options;
  const a = t;
  const b = t + 1;
  const c = t + 2;
  const ax = projX[a];
  const ay = projY[a];
  const bx = projX[b];
  const by = projY[b];
  const cx = projX[c];
  const cy = projY[c];

  // Signed twice-area. Both windings render — the cards are double-sided.
  const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  if (Math.abs(area) < 1e-9) return;
  const invArea = 1 / area;

  const minX = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
  const maxX = Math.min(ssSize - 1, Math.ceil(Math.max(ax, bx, cx)));
  const minY = Math.max(0, Math.floor(Math.min(ay, by, cy)));
  const maxY = Math.min(ssSize - 1, Math.ceil(Math.max(ay, by, cy)));
  if (minX > maxX || minY > maxY) return;

  const isLeaf = mesh.leaf[a] > 0.5;

  for (let py = minY; py <= maxY; py += 1) {
    const sy = py + 0.5;
    for (let px = minX; px <= maxX; px += 1) {
      const sx = px + 0.5;
      const w0 = ((bx - sx) * (cy - sy) - (by - sy) * (cx - sx)) * invArea;
      const w1 = ((cx - sx) * (ay - sy) - (cy - sy) * (ax - sx)) * invArea;
      const w2 = 1 - w0 - w1;
      if (w0 < 0 || w1 < 0 || w2 < 0) continue;

      const depth = w0 * projZ[a] + w1 * projZ[b] + w2 * projZ[c];
      const s = py * ssSize + px;
      if (depth <= zbuf[s]) continue;

      const u = w0 * mesh.uv[a * 2] + w1 * mesh.uv[b * 2] + w2 * mesh.uv[c * 2];
      const v = w0 * mesh.uv[a * 2 + 1] + w1 * mesh.uv[b * 2 + 1] + w2 * mesh.uv[c * 2 + 1];
      let texelR = 0;
      let texelG = 0;
      let texelB = 0;
      if (isLeaf) {
        const texel = sampleBilinear(shading.leaf, u, v, shading.wrap);
        if (texel[3] < alphaCutoff) continue;
        texelR = texel[0];
        texelG = texel[1];
        texelB = texel[2];
      } else if (shading.bark) {
        const texel = sampleBilinear(shading.bark, u, v, true);
        texelR = texel[0];
        texelG = texel[1];
        texelB = texel[2];
      }

      let nx = w0 * mesh.normal[a * 3] + w1 * mesh.normal[b * 3] + w2 * mesh.normal[c * 3];
      let ny = w0 * mesh.normal[a * 3 + 1] + w1 * mesh.normal[b * 3 + 1] + w2 * mesh.normal[c * 3 + 1];
      let nz = w0 * mesh.normal[a * 3 + 2] + w1 * mesh.normal[b * 3 + 2] + w2 * mesh.normal[c * 3 + 2];
      // Match the lit material's negateOnBackSide: a face seen from behind lights by
      // the flipped normal, so the atlas stores the normal the runtime would have used.
      if (nx * toCamera[0] + ny * toCamera[1] + nz * toCamera[2] < 0) {
        nx = -nx;
        ny = -ny;
        nz = -nz;
      }

      zbuf[s] = depth;
      covered[s] = 1;
      if (shading.bark) {
        color[s * 3] = texelR;
        color[s * 3 + 1] = texelG;
        color[s * 3 + 2] = texelB;
      } else {
        const tint = isLeaf ? leafColor : barkColor;
        color[s * 3] = tint[0];
        color[s * 3 + 1] = tint[1];
        color[s * 3 + 2] = tint[2];
      }
      normalAcc[s * 3] = nx;
      normalAcc[s * 3 + 1] = ny;
      normalAcc[s * 3 + 2] = nz;
    }
  }
}

/**
 * Coverage of the crown's frontal rectangle in one baked tile.
 *
 * The far-tier counterpart of `blockingFractionOf`: the share of the rectangle where the
 * atlas passes the alpha test. Measured on the FINAL tile texels — after supersampling —
 * because that is what the runtime samples.
 */
function measureTileCoverage(
  albedo: Uint8Array,
  atlasSize: number,
  tileBaseX: number,
  tileBaseY: number,
  tile: number,
  radius: number,
  centerY: number,
  alphaCutoff: number,
  crown: { radiusMetres: number; baseY: number; topY: number }
): number {
  const threshold = alphaCutoff * 255;
  const toPixel = (metres: number) => ((metres + radius) / (radius * 2)) * tile;
  const x0 = Math.max(0, Math.floor(toPixel(-crown.radiusMetres)));
  const x1 = Math.min(tile - 1, Math.ceil(toPixel(crown.radiusMetres)));
  const y0 = Math.max(0, Math.floor(toPixel(crown.baseY - centerY)));
  const y1 = Math.min(tile - 1, Math.ceil(toPixel(crown.topY - centerY)));
  let passed = 0;
  let total = 0;
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      total += 1;
      if (albedo[((tileBaseY + y) * atlasSize + tileBaseX + x) * 4 + 3] >= threshold) passed += 1;
    }
  }
  return total > 0 ? passed / total : 0;
}

/**
 * Coverage-weighted mips for the normal+depth atlas.
 *
 * Bake-time work now: it used to run in the browser on every load.
 *
 * Weighted by the ALBEDO chain's alpha at the same level, for the same reason the
 * albedo's own colours are alpha-weighted: an unweighted box average lets the empty
 * margin's fill normals dominate deep levels. Measured on screen before this existed:
 * every distant impostor's normal converged toward straight-up, which maxed both the
 * sun term and the sky fill and rendered the whole far ring a shade too bright. The
 * shader renormalises after decode, so the stored average never needs to be unit.
 */
export function weightedNormalMips(base: MipLevel, albedoLevels: MipLevel[]): MipLevel[] {
  const levels: MipLevel[] = [base];
  let current = base;
  let level = 0;
  while (current.width > 1 || current.height > 1) {
    const weights = albedoLevels[level];
    const width = Math.max(1, current.width >> 1);
    const height = Math.max(1, current.height >> 1);
    const data = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        let nx = 0;
        let ny = 0;
        let nz = 0;
        let depth = 0;
        let weight = 0;
        let plainX = 0;
        let plainY = 0;
        let plainZ = 0;
        let plainDepth = 0;
        for (let dy = 0; dy < 2; dy += 1) {
          for (let dx = 0; dx < 2; dx += 1) {
            const sx = Math.min(current.width - 1, x * 2 + dx);
            const sy = Math.min(current.height - 1, y * 2 + dy);
            const s = (sy * current.width + sx) * 4;
            const a = weights.data[s + 3];
            nx += current.data[s] * a;
            ny += current.data[s + 1] * a;
            nz += current.data[s + 2] * a;
            depth += current.data[s + 3] * a;
            weight += a;
            plainX += current.data[s];
            plainY += current.data[s + 1];
            plainZ += current.data[s + 2];
            plainDepth += current.data[s + 3];
          }
        }
        const o = (y * width + x) * 4;
        if (weight > 0) {
          data[o] = Math.round(nx / weight);
          data[o + 1] = Math.round(ny / weight);
          data[o + 2] = Math.round(nz / weight);
          data[o + 3] = Math.round(depth / weight);
        } else {
          data[o] = Math.round(plainX / 4);
          data[o + 1] = Math.round(plainY / 4);
          data[o + 2] = Math.round(plainZ / 4);
          data[o + 3] = Math.round(plainDepth / 4);
        }
      }
    }
    current = { data, width, height };
    levels.push(current);
    level += 1;
  }
  return levels;
}
