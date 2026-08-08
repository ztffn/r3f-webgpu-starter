// Covers the gameplay-weapon to authored-rig mapping and, more usefully, checks that
// mapping against the PREPARED assets on disk.
//
// The pure mapping tests would pass against a rig that no longer ships the clips they
// name, so the manifest tests are the ones with teeth: they fail when a re-export drops
// a segment, when a weapon loses its optic, or when the four game weapons stop covering
// all three aiming paths. Runs without a renderer — no Three.js is imported here.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  RIG_WEAPON_KEYS,
  handClipName,
  handClipNamesFor,
  weaponClipNamesFor,
  weaponPresentationFor,
} from "../../src/fps/presentation/WeaponPresentationDefinition.ts";

/** The four weapon ids the development loadout can equip. */
const GAME_WEAPON_IDS = ["prototype-sniper", "m4", "glock-9mm", "saw-test"];

interface Manifest {
  attachBone: string;
  hands: { file: string; clips: number };
  weapons: Record<
    string,
    {
      file: string;
      segments: string[];
      missingSegments: string[];
      optic: { node: string; radius: number; axis: string } | null;
      muzzleFlash: boolean;
    }
  >;
}

function loadManifest(): Manifest {
  // Prepared assets are committed (the Blender source is gitignored), so an absent
  // manifest is a real failure rather than a reason to skip: it means the runtime has
  // nothing to load.
  return JSON.parse(readFileSync("public/assets/weapons/index.json", "utf8")) as Manifest;
}

test("every game weapon maps to a rig weapon the pack actually ships", () => {
  for (const id of GAME_WEAPON_IDS) {
    const presentation = weaponPresentationFor(id);
    assert.ok(
      RIG_WEAPON_KEYS.includes(presentation.rigKey),
      `${id} maps to unknown rig key ${presentation.rigKey}`
    );
  }
});

test("the four game weapons map to four distinct rig weapons", () => {
  const keys = GAME_WEAPON_IDS.map((id) => weaponPresentationFor(id).rigKey);
  assert.equal(new Set(keys).size, keys.length, `duplicate rig keys: ${keys.join(", ")}`);
});

test("an unknown or inherited weapon id falls back to a real definition", () => {
  // "constructor" and "__proto__" resolve through the prototype chain on a plain object
  // and would yield a function rather than a definition without an own-property guard.
  for (const id of ["", "not-a-weapon", "constructor", "__proto__", "toString"]) {
    const presentation = weaponPresentationFor(id);
    assert.ok(RIG_WEAPON_KEYS.includes(presentation.rigKey), `${id} produced a non-definition`);
    assert.equal(typeof presentation.segments.idle, "string");
  }
});

test("hand clips are namespaced per weapon and weapon clips are not", () => {
  assert.equal(handClipName("sniper", "shoot"), "hand_sniper_shoot");
  const sniper = weaponPresentationFor("prototype-sniper");
  assert.ok(handClipNamesFor(sniper).every((name) => name.startsWith("hand_sniper_")));
  assert.ok(weaponClipNamesFor(sniper).every((name) => !name.startsWith("hand_")));
});

test("every segment a game weapon can play was exported for that rig weapon", () => {
  const manifest = loadManifest();
  for (const id of GAME_WEAPON_IDS) {
    const presentation = weaponPresentationFor(id);
    const prepared = manifest.weapons[presentation.rigKey];
    assert.ok(prepared, `${presentation.rigKey} is not in the prepared manifest`);
    for (const segment of weaponClipNamesFor(presentation)) {
      assert.ok(
        prepared.segments.includes(segment),
        `${id} plays "${segment}" but ${presentation.rigKey}.glb does not ship it` +
          (prepared.missingSegments.includes(segment) ? " (it is a known export gap)" : "")
      );
    }
  }
});

test("no game weapon depends on a segment the exporter dropped", () => {
  // lmg.glb ships no `reload_alt` and shotgun.glb none of its pump/shell reload clips.
  // Neither is reachable from the current mapping; this fails if one becomes reachable.
  const manifest = loadManifest();
  for (const id of GAME_WEAPON_IDS) {
    const presentation = weaponPresentationFor(id);
    const missing = manifest.weapons[presentation.rigKey].missingSegments;
    const reachable = weaponClipNamesFor(presentation).filter((name) => missing.includes(name));
    assert.deepEqual(reachable, [], `${id} reaches un-exported clip(s): ${reachable.join(", ")}`);
  }
});

test("the mapping keeps all three aiming paths represented", () => {
  // A magnified optic, an authored red dot and an iron-sight weapon each exercise a
  // different aiming path. Losing one silently removes a whole path from playtesting.
  const manifest = loadManifest();
  const optics = GAME_WEAPON_IDS.map((id) => {
    const key = weaponPresentationFor(id).rigKey;
    return { key, optic: manifest.weapons[key].optic };
  });
  const magnified = optics.filter((entry) => entry.optic && entry.optic.radius >= 2);
  const reddot = optics.filter(
    (entry) => entry.optic && entry.optic.radius > 0.5 && entry.optic.radius < 2
  );
  const irons = optics.filter((entry) => !entry.optic);
  assert.equal(magnified.length, 1, "expected exactly one magnified optic");
  assert.ok(reddot.length >= 1, "expected at least one red-dot weapon");
  assert.ok(irons.length >= 1, "expected at least one iron-sight weapon");
});

test("every optic the runtime will measure is flat on local Z", () => {
  // The lens shader treats local X/Y as the optical screen plane. A lens flat on another
  // axis samples the sight picture edge-on, and nothing else in the pipeline notices.
  const manifest = loadManifest();
  for (const [key, weapon] of Object.entries(manifest.weapons)) {
    if (!weapon.optic) continue;
    assert.equal(weapon.optic.axis, "z", `${key} lens "${weapon.optic.node}" is not Z-flat`);
  }
});

test("every weapon but the knife ships a muzzle flash mesh", () => {
  const manifest = loadManifest();
  for (const [key, weapon] of Object.entries(manifest.weapons)) {
    assert.equal(weapon.muzzleFlash, key !== "knife", `${key} muzzle flash presence is wrong`);
  }
});

test("the prepared hands carry the attach bone contract and every weapon's clips", () => {
  const manifest = loadManifest();
  assert.equal(manifest.attachBone, "R_wrist");
  // 10 weapons, each with its own segment set plus one unsplit reference clip.
  assert.ok(manifest.hands.clips >= 70, `hands shipped only ${manifest.hands.clips} clips`);
});
