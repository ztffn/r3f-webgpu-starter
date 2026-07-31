import assert from "node:assert/strict";
import test from "node:test";
import { Bone, Quaternion, Skeleton, Vector3 } from "three/webgpu";
import { AuthoritativeAimState } from "../../src/fps/core/AuthoritativeAimState.ts";
import { CharacterAimPresentationAdapter } from "../../src/fps/presentation/CharacterAimPresentationAdapter.ts";
import { CharacterAimRig, type AimRigProfile } from "../../src/fps/presentation/CharacterAimRig.ts";

const PROFILE: AimRigProfile = {
  bones: { spine: "spine", chest: "chest", neck: "neck", head: "head" },
  yawWeights: { spine: 0.2, chest: 0.3, neck: 0.15, head: 0.35 },
  pitchWeights: { spine: 0.15, chest: 0.35, neck: 0.15, head: 0.35 },
  limits: {
    spine: { yaw: [-0.35, 0.35], pitch: [-0.25, 0.25] },
    chest: { yaw: [-0.5, 0.5], pitch: [-0.4, 0.4] },
    neck: { yaw: [-0.35, 0.35], pitch: [-0.3, 0.3] },
    head: { yaw: [-1.05, 1.05], pitch: [-0.7, 0.7] },
  },
  headAimBias: 0.8,
  damping: {
    lookHalfLife: 0,
    aimHalfLife: 0,
    weightAttackHalfLife: 0,
    weightReleaseHalfLife: 0,
  },
};

function makeRig() {
  const hips = new Bone();
  hips.name = "hips";
  const spine = new Bone();
  spine.name = "spine";
  const chest = new Bone();
  chest.name = "chest";
  const neck = new Bone();
  neck.name = "neck";
  const head = new Bone();
  head.name = "head";
  hips.add(spine);
  spine.add(chest);
  chest.add(neck);
  neck.add(head);
  return { rig: new CharacterAimRig(PROFILE, new Skeleton([hips, spine, chest, neck, head])), head };
}

test("presentation adapter converts stationary world aim into root-local radians", () => {
  const aim = new AuthoritativeAimState();
  aim.set(new Vector3(), new Vector3(1, 1, 0));
  const adapter = new CharacterAimPresentationAdapter("+Z");
  const output = adapter.update(aim, new Quaternion(), 1);
  assert.ok(Math.abs(output.yaw - Math.PI / 2) < 1e-10);
  assert.ok(Math.abs(output.pitch - Math.PI / 4) < 1e-10);

  const rootTurnedRight = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2);
  const corrected = adapter.update(aim, rootTurnedRight, 1);
  assert.ok(Math.abs(corrected.yaw) < 1e-10, "root rotation changes local yaw without changing gameplay aim");
});

test("beginFrame prevents procedural accumulation on an untracked head", () => {
  const { rig, head } = makeRig();
  rig.setRootWorldQuaternion(0, 0, 0, 1);
  rig.setLook(0.7, 0.25, 1);
  rig.setAim(0.9, 0.2, 1);

  let first = new Quaternion();
  for (let frame = 0; frame < 3_600; frame += 1) {
    rig.beginFrame();
    // This intentionally stands in for a mixer clip with no head/chest track.
    rig.update(1 / 60);
    if (frame === 0) first = head.quaternion.clone();
  }
  assert.ok(head.quaternion.angleTo(first) < 1e-10);
});

test("per-bone clamps leave residual yaw for a future root turn", () => {
  const { rig } = makeRig();
  rig.setRootWorldQuaternion(0, 0, 0, 1);
  rig.setAim(Math.PI, 0, 1);
  rig.beginFrame();
  rig.update(1 / 60);
  assert.ok(Math.abs(rig.residualYaw) > 1);
});
