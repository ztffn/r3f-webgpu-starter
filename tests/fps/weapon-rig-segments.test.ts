// Pins the rule that decides what the first-person rig is playing: a segment must not be
// cancelled by the one that replaced it.
//
// Driven through the real FirstPersonWeaponRig against real AnimationMixers — a synthetic
// hands/weapon pair is enough, no GLB and no renderer — because the hazard belongs to
// three's own fade semantics, and only the actual class shows whether it is handled. A
// copy of `startAction` would have passed while the shipped code still had the bug.

import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three/webgpu";
import { FirstPersonWeaponRig } from "../../src/fps/presentation/FirstPersonWeaponRig.ts";
import type { LoadedRigAsset } from "../../src/fps/presentation/fpRigAssets.ts";
import {
  handClipName,
  type WeaponPresentationDefinition,
} from "../../src/fps/presentation/WeaponPresentationDefinition.ts";

/** Authored clip lengths, in seconds. `shoot` is short, which is what opens the window. */
const LENGTHS: Record<string, number> = {
  idle: 1.4,
  weapon_up: 0.5,
  weapon_down: 0.4,
  shoot: 0.3,
  reload: 2.2,
};

/**
 * One asset whose clips each drive their OWN marker node from 0 to 1.
 *
 * Reading a marker's position is how these tests see which segment is actually playing.
 * three blends a track back to its bind value as the driving action's weight falls to
 * zero, so a cancelled segment does not merely stop — its marker returns toward 0, which
 * makes the difference between "playing" and "cancelled" unambiguous.
 */
function makeAsset(clipName: (segment: string) => string): LoadedRigAsset {
  const scene = new THREE.Object3D();
  const clips = new Map<string, THREE.AnimationClip>();
  for (const segment of SEGMENTS) {
    const marker = new THREE.Object3D();
    // Keyed on the SEGMENT, never on the clip name — hand clips are namespaced and weapon
    // clips are not, and deriving the length from the full name is how an earlier version
    // of this file gave every `weapon_up` a 1 s duration and quietly stopped testing the
    // switch path at all.
    marker.name = `marker_${segment}`;
    scene.add(marker);
    const seconds = LENGTHS[segment];
    clips.set(
      clipName(segment),
      new THREE.AnimationClip(clipName(segment), seconds, [
        new THREE.VectorKeyframeTrack(`${marker.name}.position`, [0, seconds], [0, 0, 0, 1, 0, 0]),
      ])
    );
  }
  return { scene, clips };
}

const SEGMENTS = ["idle", "weapon_up", "weapon_down", "shoot", "reload"] as const;

const DEFINITION: WeaponPresentationDefinition = {
  rigKey: "carbine",
  developmentLabel: "TEST",
  segments: {
    idle: "idle",
    draw: "weapon_up",
    holster: "weapon_down",
    fire: "shoot",
    reload: "reload",
  },
};

/** A rig with the synthetic pair equipped, plus the marker lookups the tests read. */
function mountRig() {
  const wrist = new THREE.Object3D();
  wrist.name = "R_wrist";
  const hands = makeAsset((segment) => handClipName("carbine", segment));
  hands.scene.add(wrist);
  const weapon = makeAsset((segment) => segment);

  const rig = new FirstPersonWeaponRig(hands);
  rig.equip(weapon, DEFINITION);
  // Read from the WEAPON side. The hands mixer is the one that arms the return-to-rest, so
  // watching the weapon proves both mixers were carried, not just the one being guarded.
  const marker = (segment: string) =>
    weapon.scene.getObjectByName(`marker_${segment}`)!.position.x;
  const step = (seconds: number) => {
    const dt = 1 / 60;
    for (let i = 0; i < Math.round(seconds / dt); i += 1) rig.update(dt);
  };
  // Let the draw finish and the rig settle onto its rest pose, which is where a player
  // actually is before they shoot. `weapon_up` is 0.5 s.
  step(0.8);
  return { rig, marker, step };
}

test("a reload keyed just after a shot still plays", () => {
  // The defect, at its exact trigger. `shoot` is 0.30 s; replacing it at 0.25 s means the
  // shot's own `finished` arrives AFTER the reload started, from an action that has been
  // faded out. Unguarded, that armed the return-to-rest and the reload died one frame in —
  // the player saw the weapon snap back and no reload at all.
  const { rig, marker, step } = mountRig();
  rig.play("shoot");
  step(0.25);
  rig.play("reload");
  step(0.5);
  // The reload clip is 2.2 s and linear, so half a second in it should be around 0.23.
  assert.ok(
    marker("reload") > 0.15,
    `the reload was cancelled: its marker reached ${marker("reload").toFixed(3)}, ` +
      `which is the rest pose taking over rather than the clip playing`
  );
});

test("a weapon raise survives the outgoing weapon's holster finishing under it", () => {
  // The same hazard on the switch path. The holster is 0.4 s; equipping at 0.35 s puts its
  // finish inside the new draw's fade. A weapon that appears already up, with no raise, is
  // what this looked like.
  const { rig, marker, step } = mountRig();
  rig.play("weapon_down");
  step(0.35);
  rig.play("weapon_up");
  step(0.3);
  assert.ok(
    marker("weapon_up") > 0.3,
    `the raise was cancelled: its marker reached ${marker("weapon_up").toFixed(3)}`
  );
});

test("outside the fade window the replaced action reports nothing at all", () => {
  // Bounds the guard, so it reads as covering a real 0.1 s case rather than as blanket
  // insurance: swap early enough and three disables the faded action before its clip ends.
  const { rig, marker, step } = mountRig();
  rig.play("shoot");
  step(0.1);
  rig.play("reload");
  step(0.5);
  assert.ok(marker("reload") > 0.15);
});

test("the bored fidget still settles back to the rest pose", () => {
  // The other half of the guard, and the reason it checks the ACTION rather than simply
  // ignoring every finish. The rest pose and the fidget are the SAME clip, so the action
  // that finishes IS the current one — that identity is what returns the rig to rest. A
  // stricter guard would leave the weapon holding the fidget's last frame for ever.
  const { rig, marker, step } = mountRig();
  rig.play("idle");
  step(0.7);
  const midway = marker("idle");
  assert.ok(midway > 0.2, `the fidget did not play: ${midway.toFixed(3)}`);
  // Past the 1.4 s clip, the rig should have re-entered rest — frame 0 of the same clip.
  step(1.2);
  assert.ok(
    marker("idle") < 0.05,
    `the rig never returned to rest: marker held at ${marker("idle").toFixed(3)}`
  );
});
