// Pins the two operation orderings inside WeaponRigPlacement that a rearrangement would
// silently break.
//
// Both used to live in the middle of a 400-line frame callback, where they were documented
// in comments and asserted nowhere. They are not style: getting either wrong puts the sight
// picture off the eye, which reads as a broken scope rather than as reordered code.

import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three/webgpu";
import {
  createWeaponRigPlacementFrame,
  WeaponRigPlacement,
} from "../../src/fps/presentation/WeaponRigPlacement.ts";
import type { OpticAnchor } from "../../src/fps/presentation/FirstPersonWeaponRig.ts";
import type { PosePlacement, WeaponPose } from "../../src/fps/presentation/weaponPoseStore.ts";

const place = (
  x: number,
  y: number,
  z: number,
  pitch = 0,
  yaw = 0,
  roll = 0
): PosePlacement => ({ x, y, z, pitch, yaw, roll });

const pose = (hip: PosePlacement, ads: PosePlacement, sprint = hip): WeaponPose => ({
  hip,
  sprint,
  ads,
});

/** An eye that is neither at the origin nor axis-aligned, so a dropped term cannot pass. */
function makeCamera(): THREE.Object3D {
  const camera = new THREE.Object3D();
  camera.position.set(3, 1.7, -4);
  camera.quaternion.setFromEuler(new THREE.Euler(0.21, -0.6, 0.05, "YXZ"));
  camera.updateMatrixWorld(true);
  return camera;
}

/**
 * A rig with a lens mounted off-centre, the way a real scope sits: forward of the wrist,
 * above the bore, and under a parent that is itself offset.
 */
function makeRigWithOptic(): { rig: THREE.Object3D; optic: OpticAnchor } {
  const rig = new THREE.Object3D();
  const weapon = new THREE.Object3D();
  weapon.position.set(0.02, -0.05, -0.1);
  weapon.quaternion.setFromEuler(new THREE.Euler(0, 0.03, -0.02));
  rig.add(weapon);
  const lens = new THREE.Mesh();
  lens.position.set(0.004, 0.062, -0.31);
  weapon.add(lens);
  const optic: OpticAnchor = {
    lens,
    meshes: [lens],
    // Deliberately not the mesh origin: the anchor is the glass disc's own centre, and
    // conflating the two is how a lens that is not modelled about its origin drifts.
    centre: new THREE.Vector3(0.001, -0.002, 0.004),
    radius: 0.011,
    axis: "z",
  };
  return { rig, optic };
}

/** Where the glass ends up in the world, after placement. */
function opticWorld(optic: OpticAnchor): THREE.Vector3 {
  return optic.lens.localToWorld(new THREE.Vector3().copy(optic.centre));
}

test("at full ADS the glass lands exactly on the eye", () => {
  // The alignment contract in one assertion. Zero eye relief means the optic centre and
  // the camera position are the same point; anything else and the player is looking at the
  // side of the scope.
  const camera = makeCamera();
  const { rig, optic } = makeRigWithOptic();
  const placement = new WeaponRigPlacement();
  const frame = createWeaponRigPlacementFrame();
  frame.pose = pose(place(0.1, -0.27, -0.385), place(0, 0, 0));
  frame.adsBlend = 1;
  frame.optic = optic;
  placement.apply(rig, camera, frame);
  assert.ok(
    opticWorld(optic).distanceTo(camera.position) < 1e-6,
    `glass is ${opticWorld(optic).distanceTo(camera.position).toFixed(5)} m off the eye`
  );
});

test("a tilted ADS pose still aligns the glass to the eye", () => {
  // INVARIANT 1. The tilt must precede the TRANSLATION: the rig rotates about its own
  // origin and the lens is a descendant, so tilting after the weapon has been moved onto
  // the eye swings the glass back off it. A large tilt is used because the wrong order
  // fails proportionally to the angle, and a small one would look like noise.
  //
  // Note what this does NOT assert. Moving the optic measurement to either side of the
  // tilt changes nothing — the rig's rotation cancels between `localToWorld` and
  // `worldToLocal` — and the comment that claimed otherwise was wrong for as long as it
  // existed. Mutation testing is what separated the two orderings; reading could not.
  const camera = makeCamera();
  const { rig, optic } = makeRigWithOptic();
  const placement = new WeaponRigPlacement();
  const frame = createWeaponRigPlacementFrame();
  frame.pose = pose(place(0.1, -0.27, -0.385), place(0, 0, 0, -12, 7, 9));
  frame.adsBlend = 1;
  frame.optic = optic;
  placement.apply(rig, camera, frame);
  assert.ok(
    opticWorld(optic).distanceTo(camera.position) < 1e-6,
    "a tilted ADS pose must still align the glass to the eye — the tilt was measured " +
      "after the optic, so the alignment was computed in the wrong frame"
  );
});

test("eye relief moves the eye back along the tilted rig, not along the world", () => {
  // Confirms the previous test is not passing because rotation is being ignored. With
  // relief on z only, the offset must appear along the RIG's forward axis after the tilt.
  const camera = makeCamera();
  const { rig, optic } = makeRigWithOptic();
  const placement = new WeaponRigPlacement();
  const frame = createWeaponRigPlacementFrame();
  frame.pose = pose(place(0.1, -0.27, -0.385), place(0, 0, -0.075, -12, 7, 9));
  frame.adsBlend = 1;
  frame.optic = optic;
  placement.apply(rig, camera, frame);
  const displacement = opticWorld(optic).sub(camera.position);
  assert.ok(
    Math.abs(displacement.length() - 0.075) < 1e-6,
    `relief should be 0.075 m, measured ${displacement.length().toFixed(5)}`
  );
  // Along the rig's own -Z, which the tilt has moved away from the camera's -Z.
  const rigForward = new THREE.Vector3(0, 0, -1).applyQuaternion(rig.quaternion);
  assert.ok(
    displacement.normalize().dot(rigForward) > 0.999,
    "relief was applied in world space rather than along the tilted rig"
  );
});

test("a weapon with no optic applies its ADS offset exactly once, MID-BLEND", () => {
  // INVARIANT 2. Position takes the hip -> sprint step ONLY; its ADS step is the lerp
  // toward an offset that already carries `pose.ads`. Routing position through the aimed
  // blend as well applies it twice.
  //
  // Half blend, and that is the entire point of this test. At `adsBlend === 1` the final
  // lerp lands exactly on `aimOffset` and OVERWRITES the double application, so a fully
  // aimed weapon is identical either way and a full-ADS assertion proves nothing. The
  // error is largest in the middle of the transition, which is also where the player
  // actually sees it: 0.25 hip + 0.75 ads instead of an even half.
  const camera = makeCamera();
  const rig = new THREE.Object3D();
  const placement = new WeaponRigPlacement();
  const frame = createWeaponRigPlacementFrame();
  const hip = place(0.1, -0.2, -0.42);
  const ads = place(0, -0.11, -0.2);
  frame.pose = pose(hip, ads);
  frame.adsBlend = 0.5;
  frame.optic = null;
  placement.apply(rig, camera, frame);

  const expected = new THREE.Vector3(
    (hip.x + ads.x) / 2,
    (hip.y + ads.y) / 2,
    (hip.z + ads.z) / 2
  )
    .applyQuaternion(camera.quaternion)
    .add(camera.position);
  assert.ok(
    rig.position.distanceTo(expected) < 1e-6,
    `expected ${expected.toArray().map((v) => v.toFixed(4))}, ` +
      `got ${rig.position.toArray().map((v) => v.toFixed(4))} — an offset blended twice ` +
      `weights ADS 0.75 instead of 0.5`
  );
});

test("and lands on the authored ADS offset at full blend", () => {
  const camera = makeCamera();
  const rig = new THREE.Object3D();
  const placement = new WeaponRigPlacement();
  const frame = createWeaponRigPlacementFrame();
  const ads = place(0, -0.11, -0.2);
  frame.pose = pose(place(0.1, -0.2, -0.42), ads);
  frame.adsBlend = 1;
  frame.optic = null;
  placement.apply(rig, camera, frame);
  const expected = new THREE.Vector3(ads.x, ads.y, ads.z)
    .applyQuaternion(camera.quaternion)
    .add(camera.position);
  assert.ok(rig.position.distanceTo(expected) < 1e-6);
});

test("at the hip the rig sits on its authored hip placement", () => {
  const camera = makeCamera();
  const rig = new THREE.Object3D();
  const placement = new WeaponRigPlacement();
  const frame = createWeaponRigPlacementFrame();
  const hip = place(0.1, -0.27, -0.385);
  frame.pose = pose(hip, place(0, 0, -0.125));
  placement.apply(rig, camera, frame);
  const expected = new THREE.Vector3(hip.x, hip.y, hip.z)
    .applyQuaternion(camera.quaternion)
    .add(camera.position);
  assert.ok(rig.position.distanceTo(expected) < 1e-6);
});

test("the sprint pose is a blend of hip and sprint, untouched by ADS at zero", () => {
  const camera = makeCamera();
  const rig = new THREE.Object3D();
  const placement = new WeaponRigPlacement();
  const frame = createWeaponRigPlacementFrame();
  frame.pose = pose(place(0, 0, 0), place(0, 0, -0.2), place(0.4, 0.2, -0.6));
  frame.sprintBlend = 0.5;
  placement.apply(rig, camera, frame);
  const expected = new THREE.Vector3(0.2, 0.1, -0.3)
    .applyQuaternion(camera.quaternion)
    .add(camera.position);
  assert.ok(
    rig.position.distanceTo(expected) < 1e-6,
    `half-blended sprint should sit halfway, got ${rig.position.toArray()}`
  );
});

test("placement is rebuilt from the camera each frame, never accumulated", () => {
  // The reason `apply` writes position and quaternion rather than adding to them. The
  // mixers have already moved the skeleton by the time this runs, and an incremental
  // transform would drift a little further every frame — slowly enough to look like an
  // animation problem rather than like a missing reset.
  const camera = makeCamera();
  const rig = new THREE.Object3D();
  const placement = new WeaponRigPlacement();
  const frame = createWeaponRigPlacementFrame();
  frame.pose = pose(place(0.1, -0.27, -0.385), place(0, 0, -0.125));
  placement.apply(rig, camera, frame);
  const first = rig.position.clone();
  for (let i = 0; i < 50; i += 1) placement.apply(rig, camera, frame);
  assert.ok(rig.position.distanceTo(first) < 1e-9, "the transform drifted across frames");
});
