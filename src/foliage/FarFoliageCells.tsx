// Far-ring impostor renderer: everything beyond the near cell window, 3 draw calls.
//
// One plain Mesh over an InstancedBufferGeometry PER SPECIES for the whole ring — the
// blade layer's arrangement, and the reason the plan's index-indirection idea is not a
// storage buffer here: on the WebGL2 fallback three emulates storage reads through a
// DataTexture that only refreshes on compute dispatches, so a CPU-updated buffer goes
// silently stale (verified in three 0.185's WebGLAttributeUtils). CPU compaction on a
// camera cell crossing gets the same three draw calls with zero per-frame writes.
//
// Instances come from the SAME VegetationField as the near window — determinism is the
// contract (docs/12 §3 spirit): the far ring must show the bush the near window will
// grow when the player walks there. Selection is by RADIAL DISTANCE at fill time, not
// cell membership, so the near window's shrunk-out corner cells (beyond its radial fade
// but inside its Chebyshev window) are still represented out here.
//
// NOT RAYCASTABLE and NOT FRUSTUM CULLED, both deliberate: impostors answer no gameplay
// query (trunk collision reads the field, never render geometry), and the ring encircles
// the camera so its bounds never cull.

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import * as THREE from "three/webgpu";
import type { Atmosphere } from "../df2/atmosphere.ts";
import { SUN_DIRECTION } from "../df2/config.ts";
import {
  FOLIAGE_BUILD_MS,
  FOLIAGE_FAR_FADE_METRES,
  packVec4,
} from "./foliageConfig.ts";
import type { FoliageUniforms } from "./FoliageMaterial.ts";
import {
  createFarFoliageMaterial,
  createFarFoliageUniforms,
} from "./FarFoliageMaterial.ts";
import type { ImpostorAtlases } from "./impostorAtlas.ts";
import { SPECIES } from "./species.ts";
import type { VegetationField } from "./VegetationField.ts";

export interface FarFoliageLights {
  sun: React.RefObject<THREE.DirectionalLight | null>;
  fill: React.RefObject<THREE.HemisphereLight | null>;
  ambient: React.RefObject<THREE.AmbientLight | null>;
}

export interface FarFoliageCellsProps {
  field: VegetationField;
  atlases: ImpostorAtlases;
  atmosphere: Atmosphere;
  /** The near window's shared uniforms — the ring grows in over the same fade band. */
  foliageUniforms: FoliageUniforms;
  /** Outer reach of the ring, metres. */
  farRadiusMetres: number;
  /** Live scene lights for the hand-rolled sun term; absent refs keep the defaults. */
  lights?: FarFoliageLights;
  /** Instances drawn by the ring, reported on the same throttle as the near stats. */
  onStats?: (farInstances: number) => void;
}

interface SpeciesRing {
  /** Carried on the ring so the refill can iterate values() and not allocate an entry pair. */
  speciesIndex: number;
  mesh: THREE.Mesh;
  geometry: THREE.InstancedBufferGeometry;
  instance: THREE.InstancedBufferAttribute;
  data: THREE.InstancedBufferAttribute;
  cursor: number;
}

/**
 * Write `colour × intensity` into a vec3 uniform.
 *
 * Four call sites per frame, and the intermediate needs no storage between them — a
 * scratch `THREE.Color` per light was four objects holding a value for one statement.
 */
function setLightUniform(
  target: { value: unknown },
  color: THREE.Color,
  intensity: number
): void {
  (target.value as THREE.Vector3).set(
    color.r * intensity,
    color.g * intensity,
    color.b * intensity
  );
}

/** A single camera-facing quad; corners in [-1,1]², rebuilt entirely in the shader. */
function cardGeometry(): THREE.BufferGeometry {
  const corners = [-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, 1, 1, 0, -1, 1, 0];
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(corners, 3));
  return geometry;
}

export function FarFoliageCells({
  field,
  atlases,
  atmosphere,
  foliageUniforms,
  farRadiusMetres,
  lights,
  onStats,
}: FarFoliageCellsProps) {
  const { camera, gl, scene } = useThree();

  const state = useMemo(() => {
    const group = new THREE.Group();
    group.name = "foliage-far";
    const farUniforms = createFarFoliageUniforms();
    const quad = cardGeometry();

    // Every cell whose centre could hold a qualifying instance. The per-species buffer
    // is sized for the worst case — every placement site in every ring cell taken by
    // one species — because a fill that can overflow is a fill that needs bounds checks
    // in its hot loop.
    const cellRadius = Math.ceil(farRadiusMetres / field.cellSize) + 1;
    const cellSpan = 2 * cellRadius + 1;
    const capacity = cellSpan * cellSpan * field.placementGrid * field.placementGrid;

    const rings = new Map<number, SpeciesRing>();
    for (let s = 0; s < SPECIES.length; s += 1) {
      const species = SPECIES[s];
      const atlas = atlases.bySpecies.get(species.id);
      if (!atlas) {
        console.warn(`[foliage] no impostor atlas for ${species.id}; far ring skips it`);
        continue;
      }
      const geometry = new THREE.InstancedBufferGeometry();
      geometry.setAttribute("position", quad.getAttribute("position"));
      const instance = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
      const data = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
      instance.setUsage(THREE.DynamicDrawUsage);
      data.setUsage(THREE.DynamicDrawUsage);
      geometry.setAttribute("aInstance", instance);
      geometry.setAttribute("aData", data);
      geometry.instanceCount = 0;
      // The ring surrounds the camera; a computed bounding sphere would either cull it
      // wrongly or never at all. Neutralised the same way the blade layer does it.
      geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

      const material = createFarFoliageMaterial({
        atlas,
        spritesPerSide: atlases.manifest.spritesPerSide,
        tileSize: atlases.manifest.tileSize,
        species,
        atmosphere,
        foliageUniforms,
        farUniforms,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.name = `foliage-far-${species.id}`;
      mesh.frustumCulled = false;
      mesh.raycast = () => {};
      mesh.visible = false;
      group.add(mesh);
      rings.set(s, { speciesIndex: s, mesh, geometry, instance, data, cursor: 0 });
    }

    return { group, rings, farUniforms, quad };
  }, [field, atlases, atmosphere, foliageUniforms, farRadiusMetres]);

  useEffect(
    () => () => {
      for (const ring of state.rings.values()) {
        (ring.mesh.material as THREE.Material).dispose();
        ring.geometry.dispose();
      }
      state.quad.dispose();
    },
    [state]
  );

  // Same one-time pipeline warm-up as the near window, for the same measured reason —
  // three materials here, so the pass is small, but a first-look hitch at the ring's
  // scale would be the whole vista appearing late.
  useEffect(() => {
    const renderer = gl as unknown as {
      compileAsync?: (object: THREE.Object3D, camera: THREE.Camera, scene: THREE.Scene) => Promise<unknown>;
    };
    if (typeof renderer.compileAsync !== "function") return;
    for (const ring of state.rings.values()) {
      ring.mesh.visible = true;
      ring.geometry.instanceCount = 0;
    }
    void renderer.compileAsync(state.group, camera, scene as THREE.Scene).catch(() => {
      // A failed warm-up costs a slow first look, nothing else.
    });
  }, [state, camera, gl, scene]);

  // Outer fade band: fully gone at the ring's edge, shrinking across the last stretch.
  // An effect, not the frame loop — it is a pure function of the reach prop, and the
  // reach only moves when someone drags the dial. The lights below genuinely do need the
  // frame loop, because the Lighting dials patch those objects in place.
  useEffect(() => {
    state.farUniforms.farFadeEnd.value = farRadiusMetres;
    state.farUniforms.farFadeStart.value = Math.max(1, farRadiusMetres - FOLIAGE_FAR_FADE_METRES);
  }, [state, farRadiusMetres]);

  const scratch = useMemo(
    () => ({
      cameraCellX: Number.NaN,
      cameraCellZ: Number.NaN,
      fieldVersion: field.version,
      /** Cell cursor of the in-flight refill, or null when the fill is complete. */
      job: null as null | { index: number; camX: number; camY: number; camZ: number },
      statsAt: 0,
    }),
    [field]
  );

  useFrame(() => {
    const camX = camera.position.x;
    const camY = camera.position.y;
    const camZ = camera.position.z;

    // Live lights → uniforms, every frame: the Lighting dials patch the light objects in
    // place, so copying here is what keeps the ring's sun honest. Cheap — three colours.
    if (lights) {
      const sun = lights.sun.current;
      if (sun) setLightUniform(state.farUniforms.sunColor, sun.color, sun.intensity);
      const fill = lights.fill.current;
      if (fill) {
        setLightUniform(state.farUniforms.fillSky, fill.color, fill.intensity);
        setLightUniform(state.farUniforms.fillGround, fill.groundColor, fill.intensity);
      }
      const ambient = lights.ambient.current;
      if (ambient) {
        setLightUniform(state.farUniforms.ambient, ambient.color, ambient.intensity);
      }
    }
    (state.farUniforms.sunDirection.value as THREE.Vector3)
      .set(SUN_DIRECTION[0], SUN_DIRECTION[1], SUN_DIRECTION[2])
      .normalize();

    // A crossing or a placement change restarts the refill. The old contents keep
    // drawing until the new fill COMPLETES — a stale ring for a few frames is invisible
    // at 200 m, a half-written one is a hole.
    const cellX = field.cellIndexAt(camX);
    const cellZ = field.cellIndexAt(camZ);
    if (
      cellX !== scratch.cameraCellX ||
      cellZ !== scratch.cameraCellZ ||
      field.version !== scratch.fieldVersion
    ) {
      scratch.cameraCellX = cellX;
      scratch.cameraCellZ = cellZ;
      scratch.fieldVersion = field.version;
      scratch.job = { index: 0, camX, camY, camZ };
      for (const ring of state.rings.values()) ring.cursor = 0;
    }

    if (scratch.job) {
      runFill(scratch.job, state.rings, field, foliageUniforms, farRadiusMetres, cellX, cellZ);
      if (scratch.job.index < 0) scratch.job = null;
    }

    if (onStats) {
      const now = performance.now();
      if (now - scratch.statsAt > 250) {
        scratch.statsAt = now;
        let total = 0;
        for (const ring of state.rings.values()) total += ring.geometry.instanceCount;
        onStats(total);
      }
    }
  });

  return <primitive object={state.group} />;
}

/**
 * Budgeted compaction pass: walks the ring's cells, appends qualifying instances to each
 * species' buffer, and publishes counts only when the walk finishes.
 *
 * `job.index` is the linear cell cursor; -1 marks completion.
 */
function runFill(
  job: { index: number; camX: number; camY: number; camZ: number },
  rings: Map<number, SpeciesRing>,
  field: VegetationField,
  foliageUniforms: FoliageUniforms,
  farRadiusMetres: number,
  cellX: number,
  cellZ: number
): void {
  // The near window owns these uniforms and sets them from its frame loop — which the
  // pipeline warm-up holds off for a moment at mount. Filling against the defaults
  // (1e6) would build an EMPTY ring that nothing refills until the next cell crossing,
  // so the job simply waits for real values; it re-enters every frame until then.
  if ((foliageUniforms.fadeEnd.value as number) > 1e5) return;

  const cellRadius = Math.ceil(farRadiusMetres / field.cellSize) + 1;
  const span = 2 * cellRadius + 1;
  const totalCells = span * span;
  // Instances start growing in at the near window's fade start; the slack of 1.5 cells
  // covers everything the camera can approach before the next crossing refills.
  const includeStart = (foliageUniforms.fadeStart.value as number) - field.cellSize * 1.5;
  const includeEnd = farRadiusMetres + field.cellSize * 1.5;
  // Squared bounds for the per-instance test below. `includeStart` can go negative when
  // the near window's fade start is inside 1.5 cells, and squaring that would reject
  // everything close in — clamped to 0, which passes every non-negative distance.
  const includeStartSq = includeStart > 0 ? includeStart * includeStart : 0;
  const includeEndSq = includeEnd * includeEnd;
  const cellReject = includeStart - field.cellSize; // centre distance that can hold nothing
  const deadline = performance.now() + FOLIAGE_BUILD_MS;

  while (job.index < totalCells) {
    if (performance.now() >= deadline) return;
    const step = job.index;
    job.index += 1;
    const dx = (step % span) - cellRadius;
    const dz = Math.floor(step / span) - cellRadius;
    const cx = cellX + dx;
    const cz = cellZ + dz;
    const centreX = field.cellOrigin(cx) + field.cellSize * 0.5;
    const centreZ = field.cellOrigin(cz) + field.cellSize * 0.5;
    const centreDistance = Math.hypot(centreX - job.camX, centreZ - job.camZ);
    const halfDiagonal = field.cellSize * 0.71;
    if (centreDistance - halfDiagonal > includeEnd) continue;
    if (centreDistance + halfDiagonal < cellReject) continue;

    const cell = field.cell(cx, cz);
    if (cell.count === 0) continue;
    const originX = field.cellOrigin(cx);
    const originZ = field.cellOrigin(cz);

    for (const ring of rings.values()) {
      const [start, count] = cell.speciesRanges[ring.speciesIndex] ?? [0, 0];
      const instanceArray = ring.instance.array as Float32Array;
      const dataArray = ring.data.array as Float32Array;
      for (let i = 0; i < count; i += 1) {
        const source = start + i;
        const worldX = originX + cell.offsetX[source];
        const worldY = cell.baseY[source];
        const worldZ = originZ + cell.offsetZ[source];
        // Squared, not `Math.hypot`: this is a pure range test that never needs the root,
        // and it runs once per candidate instance across the whole ring — order tens of
        // thousands per refill, against a 3 ms budget that stale ring frames are paid from.
        const ddx = worldX - job.camX;
        const ddy = worldY - job.camY;
        const ddz = worldZ - job.camZ;
        const distanceSq = ddx * ddx + ddy * ddy + ddz * ddz;
        if (distanceSq < includeStartSq || distanceSq > includeEndSq) continue;
        const rotation = cell.rotationY[source];
        packVec4(instanceArray, ring.cursor, worldX, worldY, worldZ, cell.scale[source]);
        packVec4(
          dataArray,
          ring.cursor,
          Math.cos(rotation),
          Math.sin(rotation),
          (cell.seed[source] >>> 8) / 16777216,
          0
        );
        ring.cursor += 1;
      }
    }
  }

  // Complete: publish counts and upload in one shot per species.
  for (const ring of rings.values()) {
    ring.geometry.instanceCount = ring.cursor;
    ring.mesh.visible = ring.cursor > 0;
    ring.instance.clearUpdateRanges();
    ring.data.clearUpdateRanges();
    if (ring.cursor > 0) {
      ring.instance.addUpdateRange(0, ring.cursor * 4);
      ring.data.addUpdateRange(0, ring.cursor * 4);
    }
    ring.instance.needsUpdate = true;
    ring.data.needsUpdate = true;
  }
  job.index = -1;
}
