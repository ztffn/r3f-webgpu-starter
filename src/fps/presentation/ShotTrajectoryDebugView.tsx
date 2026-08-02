import { useEffect, useMemo } from "react";
import * as THREE from "three/webgpu";
import { LineGeometry } from "three/addons/lines/LineGeometry.js";
import { Line2 } from "three/addons/lines/webgpu/Line2.js";
import { shotDebugStore } from "../debug/ShotDebugStore";
import type { ShotTrace } from "../combat/ShotTrace";

const INITIAL_AIM_LENGTH = 25;
const NORMAL_LENGTH = 1.25;
const MAX_INTERACTION_MARKERS = 16;

function makeLine(color: THREE.ColorRepresentation, widthPixels: number): Line2 {
  const material = new THREE.Line2NodeMaterial({
    color,
    linewidth: widthPixels,
    depthTest: false,
    depthWrite: false,
    transparent: true,
    opacity: 0.98,
  });
  material.toneMapped = false;
  const line = new Line2(new LineGeometry(), material);
  line.frustumCulled = false;
  return line;
}

function setLinePoints(line: Line2, points: readonly THREE.Vector3[]): void {
  const positions = new Float32Array(points.length * 3);
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index];
    const offset = index * 3;
    positions[offset] = point.x;
    positions[offset + 1] = point.y;
    positions[offset + 2] = point.z;
  }
  line.geometry.setPositions(positions);
}

/** Latest resolved gameplay trace. It deliberately contains no solver logic. */
export function ShotTrajectoryDebugView() {
  const objects = useMemo(() => {
    const group = new THREE.Group();
    group.name = "shot-trajectory-debug";
    group.renderOrder = 1_000;

    // WebGPU's native line primitive is fixed to one physical pixel. Seen
    // almost end-on from the shooter, that made a valid trace effectively
    // invisible. Line2 expands in screen space and remains legible at range.
    const path = makeLine("#42ddff", 4);
    path.name = "resolved-shot-path";
    path.renderOrder = 1_000;
    group.add(path);

    const initialAim = makeLine("#ffffff", 2);
    initialAim.name = "scope-sightline-segment";
    initialAim.renderOrder = 1_001;
    group.add(initialAim);

    const bore = makeLine("#ffd447", 2);
    bore.name = "adjusted-bore-segment";
    bore.renderOrder = 1_001;
    group.add(bore);

    const impactMaterial = new THREE.MeshBasicMaterial({
      color: "#ff3d2e",
      depthTest: false,
      depthWrite: false,
    });
    impactMaterial.toneMapped = false;
    const impact = new THREE.Mesh(new THREE.SphereGeometry(0.3, 10, 8), impactMaterial);
    impact.name = "shot-impact";
    impact.renderOrder = 1_002;
    group.add(impact);

    const normal = makeLine("#ff3d2e", 3);
    normal.name = "impact-normal";
    normal.renderOrder = 1_002;
    group.add(normal);

    const interactionMarkers = new THREE.InstancedMesh(
      new THREE.SphereGeometry(0.2, 8, 6),
      new THREE.MeshBasicMaterial({ vertexColors: true, depthTest: false, depthWrite: false }),
      MAX_INTERACTION_MARKERS
    );
    interactionMarkers.name = "surface-interaction-markers";
    interactionMarkers.renderOrder = 1_003;
    interactionMarkers.frustumCulled = false;
    interactionMarkers.count = 0;
    group.add(interactionMarkers);

    const markerMatrix = new THREE.Matrix4();
    const markerColor = new THREE.Color();

    group.visible = false;
    return {
      group,
      path,
      initialAim,
      bore,
      impact,
      normal,
      interactionMarkers,
      markerMatrix,
      markerColor,
    };
  }, []);

  useEffect(() => {
    const {
      group,
      path,
      initialAim,
      bore,
      impact,
      normal,
      interactionMarkers,
      markerMatrix,
      markerColor,
    } = objects;
    const drawTrace = (trace: ShotTrace | null) => {
      if (!trace || trace.points.length < 2) {
        group.visible = false;
        interactionMarkers.count = 0;
        return;
      }

      group.visible = true;
      setLinePoints(path, trace.points);

      const start = trace.points[0];
      const aimEnd = start.clone().addScaledVector(trace.sightDirection, INITIAL_AIM_LENGTH);
      setLinePoints(initialAim, [start, aimEnd]);
      // The yellow line is the turret-adjusted mean bore, not the dispersed
      // projectile direction; drawing the latter would report random spread as
      // scope elevation and windage.
      const boreEnd = start.clone().addScaledVector(trace.boreDirection, INITIAL_AIM_LENGTH);
      setLinePoints(bore, [start, boreEnd]);

      const resolvedImpact = trace.impact;
      impact.visible = resolvedImpact !== null;
      normal.visible = resolvedImpact?.normal != null;
      if (resolvedImpact) {
        impact.position.copy(resolvedImpact.point);
        if (resolvedImpact.normal) {
          setLinePoints(normal, [
            resolvedImpact.point,
            resolvedImpact.point.clone().addScaledVector(resolvedImpact.normal, NORMAL_LENGTH),
          ]);
        }
      }

      let marker = 0;
      for (const interaction of trace.interactions) {
        if (marker >= MAX_INTERACTION_MARKERS) break;
        markerMatrix.makeTranslation(interaction.point.x, interaction.point.y, interaction.point.z);
        markerColor.set(interaction.outcome === "penetrated" ? "#ff9d2e" : "#ff3d2e");
        interactionMarkers.setMatrixAt(marker, markerMatrix);
        interactionMarkers.setColorAt(marker, markerColor);
        marker += 1;
        if (!interaction.exitPoint || marker >= MAX_INTERACTION_MARKERS) continue;
        markerMatrix.makeTranslation(
          interaction.exitPoint.x,
          interaction.exitPoint.y,
          interaction.exitPoint.z
        );
        markerColor.set("#62ff78");
        interactionMarkers.setMatrixAt(marker, markerMatrix);
        interactionMarkers.setColorAt(marker, markerColor);
        marker += 1;
      }
      interactionMarkers.count = marker;
      interactionMarkers.instanceMatrix.needsUpdate = true;
      if (interactionMarkers.instanceColor) interactionMarkers.instanceColor.needsUpdate = true;
    };

    // Debug presentation consumes the mutable gameplay boundary directly. This
    // avoids scheduling a React tree update for every resolved automatic round.
    drawTrace(shotDebugStore.getSnapshot().trace);
    return shotDebugStore.subscribe(() => drawTrace(shotDebugStore.getSnapshot().trace));
  }, [objects]);

  useEffect(() => {
    const clearTrace = (event: KeyboardEvent) => {
      if (event.code === "KeyL" && !event.repeat) shotDebugStore.clear();
    };
    addEventListener("keydown", clearTrace);
    return () => removeEventListener("keydown", clearTrace);
  }, []);

  useEffect(
    () => () => {
      objects.path.geometry.dispose();
      (objects.path.material as THREE.Material).dispose();
      objects.initialAim.geometry.dispose();
      (objects.initialAim.material as THREE.Material).dispose();
      objects.bore.geometry.dispose();
      (objects.bore.material as THREE.Material).dispose();
      objects.impact.geometry.dispose();
      (objects.impact.material as THREE.Material).dispose();
      objects.normal.geometry.dispose();
      (objects.normal.material as THREE.Material).dispose();
      objects.interactionMarkers.geometry.dispose();
      (objects.interactionMarkers.material as THREE.Material).dispose();
    },
    [objects]
  );

  return <primitive object={objects.group} />;
}
