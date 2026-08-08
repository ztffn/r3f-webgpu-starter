// Pins the rule that a stored tuning value must never shadow its source in silence.
//
// ADS timing is a GAMEPLAY value — `adsProgress` drives sway and pointer sensitivity, not
// just where the model sits — and it lives in `weaponDefinitions.ts`. The dev console can
// override it, and the override used to win permanently and invisibly over a later edit to
// the source. Nothing here needs Three.js or a browser; the store is deliberately plain.

import assert from "node:assert/strict";
import test from "node:test";
import { weaponPoses } from "../../src/fps/presentation/weaponPoseStore.ts";

test("an ADS override never hides a later edit to the authored value", () => {
  // The regression. One map used to hold both, a stored value won at construction, and the
  // seed declined to overwrite it — so editing the definition did nothing, permanently, on
  // the machine that had tuned that weapon. The authored side must track the source.
  weaponPoses.seedAdsTiming("shotgun", 0.2, 0.16);
  assert.equal(weaponPoses.adsIsDefault("shotgun"), true);
  assert.equal(weaponPoses.adsOverrideFor("shotgun"), null, "nothing tuned, nothing applied");

  weaponPoses.setAdsTiming("shotgun", "enterSeconds", 0.42);
  assert.equal(weaponPoses.adsIsDefault("shotgun"), false);
  assert.equal(weaponPoses.adsOverrideFor("shotgun")?.enterSeconds, 0.42);
  // The override is seeded FROM the authored value, so the field nobody touched carries over.
  assert.equal(weaponPoses.adsOverrideFor("shotgun")?.exitSeconds, 0.16);

  // Somebody edits weaponDefinitions.ts. The frame re-seeds; the authored value must move
  // even though an override is in force, or the panel cannot report what is being shadowed.
  weaponPoses.seedAdsTiming("shotgun", 0.11, 0.09);
  assert.deepEqual(
    { ...weaponPoses.adsAuthoredFor("shotgun")! },
    { enterSeconds: 0.11, exitSeconds: 0.09 }
  );
  assert.equal(weaponPoses.adsOverrideFor("shotgun")?.enterSeconds, 0.42, "override still wins");

  weaponPoses.resetAdsTiming("shotgun");
  assert.equal(weaponPoses.adsIsDefault("shotgun"), true);
  assert.equal(weaponPoses.adsOverrideFor("shotgun"), null);
  // With nothing shadowing it, what the panel shows is the edited authored value.
  assert.equal(weaponPoses.adsTimingFor("shotgun")?.enterSeconds, 0.11);
});

test("seeding the authored timing does not allocate, because it runs every frame", () => {
  weaponPoses.seedAdsTiming("knife", 0.2, 0.2);
  const first = weaponPoses.adsAuthoredFor("knife");
  weaponPoses.seedAdsTiming("knife", 0.3, 0.3);
  assert.equal(weaponPoses.adsAuthoredFor("knife"), first, "must mutate in place, not replace");
  assert.equal(first?.enterSeconds, 0.3);
});

test("tuning a weapon that has never been equipped invents nothing", () => {
  // Without an authored value there is no honest basis for an override, and inventing one
  // is the shadowing bug in its first form.
  weaponPoses.setAdsTiming("fiftycal", "enterSeconds", 0.5);
  assert.equal(weaponPoses.adsOverrideFor("fiftycal"), null);
  assert.equal(weaponPoses.adsIsDefault("fiftycal"), true);
});
