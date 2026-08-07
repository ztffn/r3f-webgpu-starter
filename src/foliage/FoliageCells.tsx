// Cell-window foliage renderer.
//
// THE SHAPE OF THIS, AND WHY IT IS NOT ONE BIG InstancedMesh
// A single InstancedMesh holding every bush on the map is the obvious first move and it
// is wrong for one specific reason: three computes ONE bounding sphere for the whole
// instanced mesh and frustum-culls against that. One visible plant keeps every plant
// submitted. Bucketing by spatial cell makes the bounding sphere mean something, which is
// what buys the culling back.
//
// WHY NOT BatchedMesh, WHICH DOCUMENTS PER-OBJECT CULLING AND LOD SWITCHING
// Read from three 0.185.1's own source rather than its docs: `WebGPUBackend.draw()`
// special-cases `object.isBatchedMesh` into a JAVASCRIPT LOOP issuing one
// `drawIndexed` per visible sub-object. There is no multi-draw and no indirect path on
// the WebGPU backend — the open PR for one (mrdoob/three.js#30645) is still a draft and
// its own author measured it SLOWER than plain drawIndexed on Chrome/macOS, which is this
// project's primary target. The WebGL2 fallback, ironically, does better: it uses
// `WEBGL_multi_draw` when the extension is present. So on the backend this project
// actually ships, BatchedMesh converts a batch into N draw calls, and its per-object
// culling is paid for in exactly the currency it claims to save.
//
// The one thing BatchedMesh genuinely offers — changing an instance's geometry without
// migrating it between buffers — is obtained here for free by giving a CELL a single LOD
// and swapping the geometry POINTER. Instance data never moves.
//
// Nothing is allocated per frame. Buckets are preallocated for the whole window and
// re-pointed as the camera moves, the same device Terrain.tsx uses (docs/08 §6.2).

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three/webgpu";
import {
  FOLIAGE_BUILD_MS,
  FOLIAGE_FADE_METRES,
  FOLIAGE_LOD_DISTANCES,
  FOLIAGE_LOD_HYSTERESIS,
  FOLIAGE_VIEW_RADIUS_METRES,
} from "./foliageConfig.ts";
import {
  buildFoliageGeometry,
  FOLIAGE_IMPOSTOR_LOD,
  FOLIAGE_LOD_COUNT,
  type CardVariant,
} from "./foliageGeometry.ts";
import { createFoliageMaterial, type FoliageAlphaMode, type FoliageUniforms } from "./FoliageMaterial.ts";
import type { Atmosphere } from "../df2/atmosphere.ts";
import { SPECIES } from "./species.ts";
import type { VegetationField } from "./VegetationField.ts";
import { hash3i } from "./vegetationHash.ts";
import { REFERENCE_P11 } from "../df2/config.ts";

// Seven buffers total: these five plus the two instance attributes below. WebGPU allows
// eight, and the unpacked form asked for ten — see foliageGeometry's packing note.
const SHARED_ATTRIBUTES = ["position", "normal", "uv", "aCard", "leaf"] as const;

export interface FoliageStats {
  /** Buckets submitted to the renderer this frame (before frustum culling). */
  visibleBuckets: number;
  /** Instances in those buckets. */
  visibleInstances: number;
  trianglesIfAllDrawn: number;
  cellsCached: number;
  /** Buckets still waiting on the build budget. */
  pendingBuckets: number;
}

export interface FoliageCellsProps {
  field: VegetationField;
  texture: THREE.Texture;
  uniforms: FoliageUniforms;
  /** Grade and fog. Threaded to the material because foliage is LIT (FoliageMaterial). */
  atmosphere: Atmosphere;
  variant: CardVariant;
  alphaMode: FoliageAlphaMode;
  /** Reach in METRES; the cell count follows from the field's cell size. */
  radiusMetres?: number;
  /** Reported on a throttle, never per frame — the HUD must not re-render at 120 Hz. */
  onStats?: (stats: FoliageStats) => void;
}

interface Bucket {
  mesh: THREE.InstancedMesh;
  /** One geometry view per LOD, all sharing this bucket's instance attributes. */
  geometries: THREE.BufferGeometry[];
  /** `origin.xyz` + uniform scale in `w`, packed to stay inside maxVertexBuffers. */
  instance: THREE.InstancedBufferAttribute;
  seed: THREE.InstancedBufferAttribute;
  speciesIndex: number;
  /** Offset from the camera's cell; fixed for the bucket's lifetime. */
  dx: number;
  dz: number;
  /** Absolute cell indices currently held, or null before the first fill. */
  cx: number | null;
  cz: number | null;
  filled: boolean;
  lod: number;
  centreX: number;
  centreZ: number;
}

export function FoliageCells({
  field,
  texture,
  uniforms,
  atmosphere,
  variant,
  alphaMode,
  radiusMetres = FOLIAGE_VIEW_RADIUS_METRES,
  onStats,
}: FoliageCellsProps) {
  const { camera } = useThree();
  const statsAt = useRef(0);

  const state = useMemo(() => {
    const group = new THREE.Group();
    group.name = "foliage";
    const radiusCells = Math.max(1, Math.ceil(radiusMetres / field.cellSize));

    // Template geometry per (species, LOD). Built once and shared by every bucket; a
    // bucket's own geometry objects are thin views over these attribute buffers.
    const templates = SPECIES.map((species) =>
      Array.from({ length: FOLIAGE_LOD_COUNT }, (_, lod) =>
        buildFoliageGeometry(species, variant, lod)
      )
    );
    const materials = SPECIES.map(
      (species) =>
        createFoliageMaterial({ map: texture, species, alphaMode, uniforms, atmosphere }).material
    );

    // Worst case a cell can hold for one species is every placement site, which is what
    // the buffers are sized for. Fixed capacity is what makes "allocate once" possible.
    const capacity = field.placementGrid * field.placementGrid;

    const buckets: Bucket[] = [];
    for (let dz = -radiusCells; dz <= radiusCells; dz += 1) {
      for (let dx = -radiusCells; dx <= radiusCells; dx += 1) {
        for (let s = 0; s < SPECIES.length; s += 1) {
          const instance = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
          const seed = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1);
          instance.setUsage(THREE.DynamicDrawUsage);
          seed.setUsage(THREE.DynamicDrawUsage);

          const geometries = templates[s].map((template) => {
            const geometry = new THREE.BufferGeometry();
            for (const name of SHARED_ATTRIBUTES) {
              const attributeData = template.geometry.getAttribute(name);
              if (attributeData) geometry.setAttribute(name, attributeData);
            }
            geometry.setAttribute("aInstance", instance);
            geometry.setAttribute("aSeed", seed);
            geometry.boundingSphere = template.geometry.boundingSphere;
            return geometry;
          });

          const mesh = new THREE.InstancedMesh(geometries[0], materials[s], capacity);
          mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
          mesh.count = 0;
          mesh.visible = false;
          mesh.name = `foliage-${SPECIES[s].id}`;
          // Explicit, because three culls an InstancedMesh against `object.boundingSphere`
          // when one is present (Frustum.intersectsObject) — and the point of bucketing by
          // cell is that this sphere is a cell, not the map.
          mesh.boundingSphere = new THREE.Sphere();
          group.add(mesh);

          buckets.push({
            mesh,
            geometries,
            instance,
            seed,
            speciesIndex: s,
            dx,
            dz,
            cx: null,
            cz: null,
            filled: false,
            lod: 0,
            centreX: 0,
            centreZ: 0,
          });
        }
      }
    }

    return { group, buckets, templates, materials, capacity, radiusCells };
    // atmosphere in the deps: a preset switch keeps the same Atmosphere object (its
    // uniforms are live), so this does not rebuild on weather — but a rebuilt world hands
    // down a new one, and materials still carrying the old fog would fog by a dead uniform.
  }, [field, texture, uniforms, atmosphere, variant, alphaMode, radiusMetres]);

  useEffect(
    () => () => {
      for (const bucket of state.buckets) {
        bucket.mesh.dispose();
        for (const geometry of bucket.geometries) geometry.dispose();
      }
      for (const template of state.templates) {
        for (const build of template) build.geometry.dispose();
      }
      for (const material of state.materials) material.dispose();
    },
    [state]
  );

  const matrix = useMemo(() => new THREE.Matrix4(), []);
  const quaternion = useMemo(() => new THREE.Quaternion(), []);
  const position = useMemo(() => new THREE.Vector3(), []);
  const scaleVector = useMemo(() => new THREE.Vector3(), []);
  const yAxis = useMemo(() => new THREE.Vector3(0, 1, 0), []);

  useFrame((_, delta) => {
    uniforms.time.value = (uniforms.time.value as number) + delta;

    const camX = camera.position.x;
    const camZ = camera.position.z;
    const cameraCellX = field.cellIndexAt(camX);
    const cameraCellZ = field.cellIndexAt(camZ);

    // The same zoom factor the grass march uses: a scope narrows the FOV, so everything
    // subtends more of the screen without moving, and a distance-only LOD rule would drop
    // detail exactly where a sniper is looking (docs/08 §6.4).
    const projection = (camera as THREE.PerspectiveCamera).projectionMatrix.elements[5];
    const zoom = Math.max(1, projection / REFERENCE_P11);

    const reach = (state.radiusCells + 0.5) * field.cellSize;
    uniforms.fadeStart.value = Math.max(1, reach - FOLIAGE_FADE_METRES);
    uniforms.fadeEnd.value = reach;

    const deadline = performance.now() + FOLIAGE_BUILD_MS;
    let visibleBuckets = 0;
    let visibleInstances = 0;
    let triangles = 0;
    let pending = 0;

    for (const bucket of state.buckets) {
      const cx = cameraCellX + bucket.dx;
      const cz = cameraCellZ + bucket.dz;
      if (bucket.cx !== cx || bucket.cz !== cz) {
        bucket.cx = cx;
        bucket.cz = cz;
        bucket.filled = false;
        bucket.mesh.visible = false;
        bucket.centreX = field.cellOrigin(cx) + field.cellSize * 0.5;
        bucket.centreZ = field.cellOrigin(cz) + field.cellSize * 0.5;
      }

      if (!bucket.filled) {
        if (performance.now() >= deadline) {
          pending += 1;
          continue;
        }
        fill(bucket, field, matrix, position, quaternion, scaleVector, yAxis);
        bucket.filled = true;
      }

      if (bucket.mesh.count === 0) continue;

      const species = SPECIES[bucket.speciesIndex];
      const dx = bucket.centreX - camX;
      const dz = bucket.centreZ - camZ;
      const distance = Math.hypot(dx, dz) / zoom;
      const lod = chooseLod(distance, species.lodScale, bucket.lod, field.wrap(cx), field.wrap(cz));
      if (lod !== bucket.lod || bucket.mesh.geometry !== bucket.geometries[lod]) {
        bucket.lod = lod;
        bucket.mesh.geometry = bucket.geometries[lod];
      }
      bucket.mesh.visible = true;

      visibleBuckets += 1;
      visibleInstances += bucket.mesh.count;
      triangles += bucket.mesh.count * state.templates[bucket.speciesIndex][bucket.lod].triangleCount;
    }

    if (onStats) {
      const now = performance.now();
      if (now - statsAt.current > 250) {
        statsAt.current = now;
        onStats({
          visibleBuckets,
          visibleInstances,
          trianglesIfAllDrawn: triangles,
          cellsCached: field.cachedCellCount,
          pendingBuckets: pending,
        });
      }
    }
  });

  return <primitive object={state.group} />;
}

/**
 * LOD for a cell, with hysteresis and a per-cell stagger.
 *
 * The stagger is the memo's advice taken literally: without it every cell at the same
 * range switches on the same frame and the pop is a visible ring sweeping the world.
 * Hashing the cell index moves each cell's boundary by up to +/-7%, which breaks the ring
 * into noise while staying deterministic — the same cell always switches at the same
 * range, so the effect does not swim as the camera moves.
 */
function chooseLod(
  distance: number,
  lodScale: number,
  currentLod: number,
  cx: number,
  cz: number
): number {
  const stagger = 1 + ((hash3i(cx, cz, 0, 0x4c4f44) / 4294967296) * 2 - 1) * 0.07;
  let lod = FOLIAGE_LOD_COUNT - 1;
  for (let i = 0; i < FOLIAGE_LOD_DISTANCES.length; i += 1) {
    const threshold = FOLIAGE_LOD_DISTANCES[i] * lodScale * stagger;
    // Widen the band in the direction that would keep the current LOD, so a cell sitting
    // on a boundary does not flip every frame as the camera breathes.
    const bias = i >= currentLod ? 1 + FOLIAGE_LOD_HYSTERESIS : 1 - FOLIAGE_LOD_HYSTERESIS;
    if (distance < threshold * bias) {
      lod = i;
      break;
    }
  }
  return Math.min(lod, FOLIAGE_IMPOSTOR_LOD);
}

function fill(
  bucket: Bucket,
  field: VegetationField,
  matrix: THREE.Matrix4,
  position: THREE.Vector3,
  quaternion: THREE.Quaternion,
  scaleVector: THREE.Vector3,
  yAxis: THREE.Vector3
): void {
  const cell = field.cell(bucket.cx as number, bucket.cz as number);
  const [start, count] = cell.speciesRanges[bucket.speciesIndex] ?? [0, 0];
  const capacity = bucket.instance.count;
  const used = Math.min(count, capacity);

  const instanceArray = bucket.instance.array as Float32Array;
  const seedArray = bucket.seed.array as Float32Array;

  for (let i = 0; i < used; i += 1) {
    const source = start + i;
    const x = cell.offsetX[source];
    const y = cell.baseY[source];
    const z = cell.offsetZ[source];
    const instanceScale = cell.scale[source];

    instanceArray[i * 4] = x;
    instanceArray[i * 4 + 1] = y;
    instanceArray[i * 4 + 2] = z;
    instanceArray[i * 4 + 3] = instanceScale;
    // Seed as a float in [0,1): the shader wants a variation dial, not an integer, and
    // 24 bits of mantissa is far more variation than the eye can distinguish.
    seedArray[i] = (cell.seed[source] >>> 8) / 16777216;

    position.set(x, y, z);
    quaternion.setFromAxisAngle(yAxis, cell.rotationY[source]);
    scaleVector.setScalar(instanceScale);
    matrix.compose(position, quaternion, scaleVector);
    bucket.mesh.setMatrixAt(i, matrix);
  }

  bucket.mesh.count = used;
  bucket.mesh.position.set(
    field.cellOrigin(bucket.cx as number),
    0,
    field.cellOrigin(bucket.cz as number)
  );
  bucket.mesh.updateMatrix();
  bucket.mesh.updateMatrixWorld(true);
  bucket.mesh.instanceMatrix.needsUpdate = true;
  bucket.instance.needsUpdate = true;
  bucket.seed.needsUpdate = true;
  bucket.mesh.visible = used > 0;

  // Bounds in the mesh's own space: the cell footprint, from the lowest ground in it to
  // the tallest plant on it, padded by the widest crown. Recomputed per fill because a
  // cell's contents change completely when the bucket is re-pointed.
  const halfCell = field.cellSize * 0.5;
  const lowest = used > 0 ? cell.minY : 0;
  const highest = used > 0 ? cell.maxY : 0;
  const sphere = bucket.mesh.boundingSphere as THREE.Sphere;
  sphere.center.set(halfCell, (lowest + highest) * 0.5, halfCell);
  sphere.radius =
    Math.hypot(halfCell, (highest - lowest) * 0.5, halfCell) + cell.maxRadius;
}
