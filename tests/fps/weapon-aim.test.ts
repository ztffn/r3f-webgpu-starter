import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three/webgpu";
import { WeaponAimComposer } from "../../src/fps/core/WeaponAimComposer.ts";

test("weapon aim composition preserves zero offsets and normalized directions", () => {
  const composer = new WeaponAimComposer();
  const base = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.2, -0.4, 0));
  const expected = new THREE.Vector3(0, 0, -1).applyQuaternion(base).normalize();
  const composed = new THREE.Quaternion();
  const actual = new THREE.Vector3();

  composer.composeQuaternion(base, 0, 0, composed);
  composer.directionFromQuaternion(composed, actual);
  assert.ok(actual.distanceTo(expected) < 1e-12);
  assert.ok(Math.abs(actual.length() - 1) < 1e-12);
});

test("weapon aim composition applies yaw and pitch in weapon-local space", () => {
  const composer = new WeaponAimComposer();
  const actual = new THREE.Vector3();
  composer.offsetDirection({ x: 0, y: 0, z: -1 }, 0.1, 0.05, actual);

  assert.ok(actual.x < 0, "positive local yaw turns the bore left");
  assert.ok(actual.y > 0, "positive local pitch raises the bore");
  assert.ok(Math.abs(actual.length() - 1) < 1e-12);
});
