import assert from "node:assert/strict";
import test from "node:test";
import { LoadoutSystem } from "../../src/fps/weapons/LoadoutSystem.ts";
import { WeaponSystem, type WeaponEvent } from "../../src/fps/weapons/WeaponSystem.ts";
import { SNIPER_DEFINITION } from "../../src/fps/weapons/weaponDefinitions.ts";

function drain(weapon: WeaponSystem): WeaponEvent[] {
  const events: WeaponEvent[] = [];
  weapon.drainEvents((event) => events.push(event));
  return events;
}

test("semi-auto accepts one click, consumes ammo, and enforces cadence", () => {
  const weapon = new WeaponSystem(SNIPER_DEFINITION);
  weapon.pressTrigger();
  weapon.update(1 / 60);
  assert.equal(weapon.magazine, 4);
  const firstShot = drain(weapon)[0];
  assert.equal(firstShot?.type, "shot");
  if (firstShot?.type === "shot") {
    assert.equal(firstShot.range, 2_000);
    assert.equal(firstShot.muzzleVelocityMetresPerSecond, 792.48);
    assert.equal(firstShot.ballisticCoefficientG1, 0.505);
  }

  weapon.pressTrigger();
  weapon.update(1 / 60);
  assert.equal(weapon.magazine, 4, "clicks during cooldown are discarded, not buffered");
  assert.deepEqual(drain(weapon), []);

  for (let i = 0; i < 13; i += 1) weapon.update(0.1);
  weapon.pressTrigger();
  weapon.update(0);
  assert.equal(weapon.magazine, 3);
  assert.equal(drain(weapon)[0]?.type, "shot");
});

test("dry fire and reload are explicit state transitions", () => {
  const weapon = new WeaponSystem(SNIPER_DEFINITION);
  weapon.magazine = 0;
  weapon.pressTrigger();
  weapon.update(0);
  assert.equal(drain(weapon)[0]?.type, "dry-fire");

  weapon.requestReload();
  weapon.update(0);
  assert.equal(weapon.phase, "reloading");
  const reloadStarted = drain(weapon)[0];
  assert.equal(reloadStarted?.type, "reload-started");
  if (reloadStarted?.type === "reload-started") {
    assert.equal(reloadStarted.animationSegment, 4);
  }
  for (let i = 0; i < 41; i += 1) weapon.update(0.1);
  assert.equal(weapon.phase, "reloading", "weapon remains locked through the authored clip");
  weapon.update(0.1);
  assert.equal(weapon.magazine, 5);
  assert.equal(weapon.reserve, 15);
  assert.equal(drain(weapon).at(-1)?.type, "reload-completed");
});

test("loadout switching is generic and delayed", () => {
  const primary = new WeaponSystem(SNIPER_DEFINITION);
  const secondary = new WeaponSystem({ ...SNIPER_DEFINITION, id: "secondary", displayName: "Secondary" });
  const loadout = new LoadoutSystem(
    [
      { id: "primary", weapon: primary },
      { id: "secondary", weapon: secondary },
    ],
    "primary"
  );

  assert.equal(loadout.requestEquip("secondary", 0.2), true);
  loadout.update(0.1);
  assert.equal(loadout.getSnapshot().equippedSlot, "primary");
  loadout.update(0.1);
  assert.equal(loadout.getSnapshot().equippedSlot, "secondary");
});
