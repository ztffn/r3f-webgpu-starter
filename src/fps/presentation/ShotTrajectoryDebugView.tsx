import { useEffect, useMemo, useSyncExternalStore } from "react";
import * as THREE from "three/webgpu";
import { shotDebugStore } from "../debug/ShotDebugStore";

const INITIAL_AIM_LENGTH = 25;
const NORMAL_LENGTH = 1.25;
const MAX_INTERACTION_MARKERS = 16;

function makeLine(color: THREE.ColorRepresentation): THREE.Line {
  const material = new THREE.LineBasicMaterial({
    color,
    depthTest: false,
    depthWrite: false,
    transparent: true,
    opacity: 0.95,
  });
  material.toneMapped = false;
  const line = new THREE.Line(new THREE.BufferGeometry(), material);
  line.frustumCulled = false;
  return line;
}

/** Latest resolved gameplay trace. It deliberately contains no solver logic. */
export function ShotTrajectoryDebugView() {
  const { trace } = useSyncExternalStore(
    shotDebugStore.subscribe,
    shotDebugStore.getSnapshot,
    shotDebugStore.getSnapshot
  );
  const objects = useMemo(() => {
    const group = new THREE.Group();
    group.name = "shot-trajectory-debug";
    group.renderOrder = 1_000;

    const path = makeLine("#42ddff");
    path.name = "resolved-shot-path";
    path.renderOrder = 1_000;
    group.add(path);

    const initialAim = makeLine("#ffffff");
    initialAim.name = "scope-sightline-segment";
    initialAim.renderOrder = 1_001;
    group.add(initialAim);

    const bore = makeLine("#ffd447");
    bore.name = "adjusted-bore-segment";
    bore.renderOrder = 1_001;
    group.add(bore);

    const impactMaterial = new THREE.MeshBasicMaterial({
      color: "#ff3d2e",
      depthTest: false,
      depthWrite: false,
    });
    impactMaterial.toneMapped = false;
    const impact = new THREE.Mesh(new THREE.SphereGeometry(0.09, 10, 8), impactMaterial);
    impact.name = "shot-impact";
    impact.renderOrder = 1_002;
    group.add(impact);

    const normal = makeLine("#ff3d2e");
    normal.name = "impact-normal";
    normal.renderOrder = 1_002;
    group.add(normal);

    const interactionMarkers = new THREE.InstancedMesh(
      new THREE.SphereGeometry(0.075, 8, 6),
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
    if (!trace || trace.points.length < 2) {
      group.visible = false;
      interactionMarkers.count = 0;
      return;
    }

    group.visible = true;
    path.geometry.setFromPoints([...trace.points]);

    const start = trace.points[0];
    const aimEnd = start.clone().addScaledVector(trace.sightDirection, INITIAL_AIM_LENGTH);
    initialAim.geometry.setFromPoints([start, aimEnd]);
    const boreEnd = start.clone().addScaledVector(trace.initialDirection, INITIAL_AIM_LENGTH);
    bore.geometry.setFromPoints([start, boreEnd]);

    const resolvedImpact = trace.impact;
    impact.visible = resolvedImpact !== null;
    normal.visible = resolvedImpact?.normal != null;
    if (resolvedImpact) {
      impact.position.copy(resolvedImpact.point);
      if (resolvedImpact.normal) {
        normal.geometry.setFromPoints([
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
  }, [objects, trace]);

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
