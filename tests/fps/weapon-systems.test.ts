import assert from "node:assert/strict";
import test from "node:test";
import { performance } from "node:perf_hooks";
import { LocalPlayerController } from "../../src/fps/core/LocalPlayerController.ts";
import {
  LoadoutSystem,
  type LoadoutEvent,
} from "../../src/fps/weapons/LoadoutSystem.ts";
import type { WeaponCommand, WeaponDefinition } from "../../src/combat/WeaponDefinition.ts";
import { WeaponSystem, type WeaponEvent } from "../../src/fps/weapons/WeaponSystem.ts";
import type { WeaponHandlingContext } from "../../src/fps/weapons/WeaponHandling.ts";
import {
  GLOCK_DEFINITION,
  M4_DEFINITION,
  SAW_DEFINITION,
  SNIPER_DEFINITION,
  WEAPON_DEFINITIONS,
} from "../../src/combat/weaponDefinitions.ts";
import { createDevelopmentLoadout } from "../../src/fps/weapons/developmentLoadout.ts";
import {
  ammunitionFromSearch,
  DEFAULT_AMMUNITION,
} from "../../src/combat/AmmunitionDefinition.ts";
import { scopeAdjustmentActionForKey } from "../../src/fps/core/ScopeAdjustmentController.ts";
import { weaponPresentationFor } from "../../src/fps/presentation/WeaponPresentationDefinition.ts";

const weaponCommand = (
  weapon: WeaponSystem,
  command: Exclude<WeaponCommand, { type: "equipSlot" }>
) => weapon.handleCommand(command);

function drainWeapon(weapon: WeaponSystem): WeaponEvent[] {
  const events: WeaponEvent[] = [];
  weapon.drainEvents((event) => events.push(event));
  return events;
}

function drainLoadout(loadout: LoadoutSystem): LoadoutEvent[] {
  const events: LoadoutEvent[] = [];
  loadout.drainEvents((event) => events.push(event));
  return events;
}

function advanceWeapon(weapon: WeaponSystem, seconds: number, hz = 60): WeaponEvent[] {
  const events: WeaponEvent[] = [];
  let elapsed = 0;
  while (elapsed < seconds - 1e-12) {
    const dt = Math.min(1 / hz, seconds - elapsed);
    weapon.update(dt);
    weapon.drainEvents((event) => events.push(event));
    elapsed += dt;
  }
  return events;
}

const STATIONARY_STAND: WeaponHandlingContext = {
  stance: "stand",
  grounded: true,
  planarSpeedMetresPerSecond: 0,
  breathStabilization: 0,
};

function firstShot(
  definition: WeaponDefinition,
  seed: number,
  context: WeaponHandlingContext = STATIONARY_STAND,
  ads = false
): Extract<WeaponEvent, { type: "shot" }> {
  const weapon = new WeaponSystem(definition, seed);
  weapon.setHandlingContext(context);
  if (ads) {
    weapon.setAdsWanted(true);
    weapon.update(1);
    drainWeapon(weapon);
  }
  weaponCommand(weapon, { type: "triggerDown" });
  const event = drainWeapon(weapon).find(
    (candidate): candidate is Extract<WeaponEvent, { type: "shot" }> => candidate.type === "shot"
  );
  assert.ok(event);
  return event;
}

test("weapon definitions keep authored ammunition and fire modes in gameplay data", () => {
  assert.deepEqual(SNIPER_DEFINITION.fireModes, { supported: ["semi"], default: "semi" });
  assert.deepEqual(M4_DEFINITION.fireModes, {
    supported: ["semi", "burst"],
    default: "semi",
    burstSize: 3,
  });
  assert.deepEqual(GLOCK_DEFINITION.fireModes, { supported: ["semi"], default: "semi" });
  assert.deepEqual(SAW_DEFINITION.fireModes, {
    supported: ["semi", "auto"],
    default: "auto",
  });
  assert.equal(SNIPER_DEFINITION.shot.ammunition.id, "308");
  assert.equal(M4_DEFINITION.shot.ammunition.id, "556");
  assert.equal(GLOCK_DEFINITION.shot.ammunition.id, "9mm");
  assert.equal(SAW_DEFINITION.shot.ammunition.id, "556");
  assert.equal("animations" in SNIPER_DEFINITION, false);
  for (const definition of [SNIPER_DEFINITION, M4_DEFINITION, GLOCK_DEFINITION, SAW_DEFINITION]) {
    assert.ok(definition.accuracy.mechanicalDispersionRadians > 0);
    assert.ok(definition.accuracy.maxBloomRadians >= definition.accuracy.bloomPerShotRadians);
    assert.ok(definition.recoil.maxPitchRadians >= definition.recoil.pitchRadians);
    assert.ok(definition.recoil.maxYawRadians >= definition.recoil.yawRadians);
  }
});

test("weapon handling definitions reject invalid bloom and recoil capacity", () => {
  assert.throws(
    () =>
      new WeaponSystem(
        { ...M4_DEFINITION, accuracy: { ...M4_DEFINITION.accuracy, maxBloomRadians: 0 } },
        1
      ),
    /bloom recovery or capacity/
  );
  assert.throws(
    () =>
      new WeaponSystem(
        { ...M4_DEFINITION, recoil: { ...M4_DEFINITION.recoil, recoveryPerSecond: Number.NaN } },
        1
      ),
    /finite non-negative recoil/
  );
});

test("external lookups ignore inherited object keys", () => {
  // These tables are keyed straight from a URL parameter, a KeyboardEvent, and
  // a weapon id. An inherited key returns a truthy function, which used to slip
  // past the fallback and reach weapon construction as an ammunition record.
  for (const hostile of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
    assert.equal(
      ammunitionFromSearch(`?ammo=${hostile}`),
      DEFAULT_AMMUNITION,
      `?ammo=${hostile}`
    );
    assert.equal(
      scopeAdjustmentActionForKey({ code: hostile, key: hostile }),
      null,
      `key ${hostile}`
    );
    assert.equal(weaponPresentationFor(hostile).modelUrl, weaponPresentationFor("m4").modelUrl);
  }
  assert.equal(ammunitionFromSearch("?ammo=556").id, "556");
  assert.equal(scopeAdjustmentActionForKey({ code: "ArrowUp", key: "ArrowUp" }), "elevation-up");
});

test("definition validation rejects hostile authored runtime values", () => {
  const build = (patch: Partial<WeaponDefinition>) => () =>
    new WeaponSystem({ ...M4_DEFINITION, ...patch }, 1);
  const shot = (patch: Partial<WeaponDefinition["shot"]>) => ({
    shot: { ...M4_DEFINITION.shot, ...patch },
  });

  assert.throws(build(shot({ roundsPerMinute: Number.POSITIVE_INFINITY })), /firing cadence/);
  assert.throws(build(shot({ roundsPerMinute: Number.NaN })), /firing cadence/);
  assert.throws(build(shot({ range: 0 })), /shot range/);
  assert.throws(build(shot({ maxFlightSeconds: -1 })), /shot lifetime/);
  assert.throws(build(shot({ damage: Number.NaN })), /shot damage/);
  assert.throws(
    build(shot({ ammunition: { ...M4_DEFINITION.shot.ammunition, muzzleVelocityMetresPerSecond: 0 } })),
    /muzzle velocity/
  );
  assert.throws(
    build(shot({ ammunition: { ...M4_DEFINITION.shot.ammunition, penetrationMultiplier: Number.NaN } })),
    /penetration multiplier/
  );
  assert.throws(build({ ammo: { magazineSize: 0, initialReserve: 10 } }), /magazine size/);
  assert.throws(build({ ammo: { magazineSize: 30.5, initialReserve: 10 } }), /magazine size/);
  assert.throws(build({ ammo: { magazineSize: 30, initialReserve: -1 } }), /initial reserve/);
  assert.throws(build({ reload: { durationSeconds: 0 } }), /reload duration/);
  assert.throws(build({ reload: { durationSeconds: Number.NaN } }), /reload duration/);
  assert.throws(build({ ads: { enterSeconds: Number.NaN, exitSeconds: 0.1 } }), /ADS enter/);
  assert.throws(build({ ads: { enterSeconds: 0.1, exitSeconds: -0.1 } }), /ADS exit/);

  // Zero ADS durations remain legal: they mean an instant transition.
  assert.doesNotThrow(build({ ads: { enterSeconds: 0, exitSeconds: 0 } }));
  for (const definition of WEAPON_DEFINITIONS) {
    assert.doesNotThrow(() => new WeaponSystem(definition, 1));
  }
});

test("dispersion sampling is deterministic per weapon instance and shot sequence", () => {
  const left = firstShot(M4_DEFINITION, 1234);
  const replay = firstShot(M4_DEFINITION, 1234);
  const otherShooter = firstShot(M4_DEFINITION, 5678);
  assert.equal(left.dispersionPitchRadians, replay.dispersionPitchRadians);
  assert.equal(left.dispersionYawRadians, replay.dispersionYawRadians);
  assert.equal(new WeaponSystem(M4_DEFINITION, 1234).getSnapshot().instanceSeed, 1234);
  assert.notDeepEqual(
    [left.dispersionPitchRadians, left.dispersionYawRadians],
    [otherShooter.dispersionPitchRadians, otherShooter.dispersionYawRadians]
  );
  assert.ok(Math.hypot(left.dispersionPitchRadians, left.dispersionYawRadians) <= left.dispersionConeRadians);
});

test("stance, movement, grounded state, ADS, and breath produce ordered dispersion cones", () => {
  const cone = (context: WeaponHandlingContext, ads = false) =>
    firstShot(M4_DEFINITION, 42, context, ads).dispersionConeRadians;
  const stand = cone(STATIONARY_STAND);
  const crouch = cone({ ...STATIONARY_STAND, stance: "crouch" });
  const prone = cone({ ...STATIONARY_STAND, stance: "prone" });
  const moving = cone({ ...STATIONARY_STAND, planarSpeedMetresPerSecond: 5.5 });
  const sprinting = cone({ ...STATIONARY_STAND, planarSpeedMetresPerSecond: 22 });
  const airborne = cone({ ...STATIONARY_STAND, stance: "prone", grounded: false });
  const ads = cone(STATIONARY_STAND, true);
  const adsBreath = cone({ ...STATIONARY_STAND, breathStabilization: 1 }, true);

  assert.ok(stand > crouch);
  assert.ok(crouch > prone);
  assert.ok(moving > stand);
  assert.ok(sprinting > moving);
  assert.ok(airborne >= moving);
  assert.ok(ads < stand);
  assert.ok(adsBreath < ads);
  assert.ok(adsBreath > M4_DEFINITION.accuracy.mechanicalDispersionRadians);
});

test("accepted recoil affects later rounds while bloom remains bounded and recovers", () => {
  const weapon = new WeaponSystem(SAW_DEFINITION, 99);
  weapon.setHandlingContext(STATIONARY_STAND);
  weaponCommand(weapon, { type: "triggerDown" });
  const first = drainWeapon(weapon).find(
    (event): event is Extract<WeaponEvent, { type: "shot" }> => event.type === "shot"
  );
  assert.ok(first);
  assert.equal(first.recoilOffsetPitchRadians, 0);
  assert.equal(first.recoilOffsetYawRadians, 0);
  assert.ok(weapon.getSnapshot().recoilPitchRadians > 0);
  assert.ok(weapon.getSnapshot().bloomRadians > 0);

  weapon.update(60 / SAW_DEFINITION.shot.roundsPerMinute);
  const second = drainWeapon(weapon).find(
    (event): event is Extract<WeaponEvent, { type: "shot" }> => event.type === "shot"
  );
  assert.ok(second);
  assert.ok(second.recoilOffsetPitchRadians > 0);
  assert.ok(second.dispersionConeRadians > first.dispersionConeRadians);

  advanceWeapon(weapon, 2);
  weaponCommand(weapon, { type: "triggerUp" });
  const saturated = weapon.getSnapshot();
  assert.ok(saturated.bloomRadians <= SAW_DEFINITION.accuracy.maxBloomRadians);
  const recoilBeforeRecovery = saturated.recoilPitchRadians;
  const bloomBeforeRecovery = saturated.bloomRadians;
  advanceWeapon(weapon, 1);
  const recovered = weapon.getSnapshot();
  assert.ok(recovered.recoilPitchRadians < recoilBeforeRecovery);
  assert.ok(recovered.bloomRadians < bloomBeforeRecovery);
});

test("mode changes preserve cooldown, recoil, and bloom", () => {
  const weapon = new WeaponSystem(M4_DEFINITION, 7);
  weaponCommand(weapon, { type: "triggerDown" });
  weaponCommand(weapon, { type: "triggerUp" });
  drainWeapon(weapon);
  const before = weapon.getSnapshot();
  weaponCommand(weapon, { type: "selectFireMode" });
  const after = weapon.getSnapshot();
  assert.equal(after.cooldownRemainingSeconds, before.cooldownRemainingSeconds);
  assert.equal(after.recoilPitchRadians, before.recoilPitchRadians);
  assert.equal(after.recoilYawRadians, before.recoilYawRadians);
  assert.equal(after.bloomRadians, before.bloomRadians);
});

test("reload and unequipped time recover handling state instead of resetting or freezing it", () => {
  const primary = new WeaponSystem(M4_DEFINITION, 10);
  const secondary = new WeaponSystem(GLOCK_DEFINITION, 11);
  const loadout = new LoadoutSystem(
    [
      { inputSlot: 1, id: "primary", weapon: primary },
      { inputSlot: 2, id: "sidearm", weapon: secondary },
    ],
    "primary"
  );
  loadout.handleCommand({ type: "triggerDown" });
  loadout.handleCommand({ type: "triggerUp" });
  drainLoadout(loadout);
  const afterShot = primary.getSnapshot();
  loadout.handleCommand({ type: "reload" });
  loadout.update(0.1);
  const duringReload = primary.getSnapshot();
  assert.ok(duringReload.recoilPitchRadians < afterShot.recoilPitchRadians);
  assert.ok(duringReload.bloomRadians < afterShot.bloomRadians);

  loadout.handleCommand({ type: "equipSlot", slot: 2 });
  loadout.update(0.35);
  const afterUnequippedTime = primary.getSnapshot();
  assert.ok(afterUnequippedTime.recoilPitchRadians < duringReload.recoilPitchRadians);
  assert.ok(afterUnequippedTime.bloomRadians < duringReload.bloomRadians);
  assert.ok(afterUnequippedTime.recoilPitchRadians > 0, "switching must not hard-reset recoil");
});

test("flat handling modifiers deterministically affect spread, recoil, bloom, and sway", () => {
  const weapon = new WeaponSystem(M4_DEFINITION, 77);
  weapon.setHandlingModifiers({
    dispersionFactor: 0.5,
    recoilPitchFactor: 0.8,
    recoilYawFactor: 0.7,
    recoilRecoveryFactor: 1.2,
    bloomPerShotFactor: 0.6,
    bloomRecoveryFactor: 1.1,
    swayFactor: 0.75,
  });
  weaponCommand(weapon, { type: "triggerDown" });
  const shot = drainWeapon(weapon).find(
    (event): event is Extract<WeaponEvent, { type: "shot" }> => event.type === "shot"
  );
  assert.ok(shot);
  assert.equal(shot.recoilImpulsePitchRadians, M4_DEFINITION.recoil.pitchRadians * 0.8);
  assert.equal(Math.abs(shot.recoilImpulseYawRadians), M4_DEFINITION.recoil.yawRadians * 0.7);
  const snapshot = weapon.getSnapshot();
  assert.equal(snapshot.bloomRadians, M4_DEFINITION.accuracy.bloomPerShotRadians * 0.6);
  assert.equal(snapshot.swayFactor, 0.75);
});

test("semi-auto fires once per trigger-down edge and never repeats while held", () => {
  const weapon = new WeaponSystem(SNIPER_DEFINITION, 21);
  weaponCommand(weapon, { type: "triggerDown" });
  const firstShot = drainWeapon(weapon)[0];
  assert.equal(firstShot?.type, "shot");
  if (firstShot?.type === "shot") {
    assert.equal(firstShot.range, 2_000);
    assert.equal(firstShot.maxFlightSeconds, 3.5);
    assert.equal(firstShot.ammunition.id, "308");
  }

  assert.equal(advanceWeapon(weapon, 2).filter((event) => event.type === "shot").length, 0);
  weaponCommand(weapon, { type: "triggerUp" });
  weaponCommand(weapon, { type: "triggerDown" });
  assert.equal(drainWeapon(weapon).filter((event) => event.type === "shot").length, 1);
  assert.equal(weapon.magazine, 3);
});

test("one burst edge completes three rounds after release", () => {
  const weapon = new WeaponSystem(M4_DEFINITION, 22);
  weaponCommand(weapon, { type: "selectFireMode" });
  assert.equal(drainWeapon(weapon)[0]?.type, "fire-mode-changed");
  assert.equal(weapon.getSnapshot().fireMode, "burst");

  weaponCommand(weapon, { type: "triggerDown" });
  weaponCommand(weapon, { type: "triggerUp" });
  assert.equal(weapon.getSnapshot().burstRoundsRemaining, 2);
  assert.doesNotThrow(() => JSON.stringify(weapon.getSnapshot()));
  const events = [...drainWeapon(weapon), ...advanceWeapon(weapon, 0.5)];
  assert.equal(events.filter((event) => event.type === "shot").length, 3);
  assert.equal(weapon.magazine, 27);
  assert.equal(weapon.getSnapshot().burstRoundsRemaining, 0);
  assert.equal(advanceWeapon(weapon, 0.5).filter((event) => event.type === "shot").length, 0);
});

test("reload and fire-mode changes cancel incomplete bursts without resetting cooldown", () => {
  const reloadCancel = new WeaponSystem(M4_DEFINITION, 23);
  weaponCommand(reloadCancel, { type: "selectFireMode" });
  drainWeapon(reloadCancel);
  weaponCommand(reloadCancel, { type: "triggerDown" });
  weaponCommand(reloadCancel, { type: "reload" });
  const reloadEvents = [...drainWeapon(reloadCancel), ...advanceWeapon(reloadCancel, 0.5)];
  assert.equal(reloadEvents.filter((event) => event.type === "shot").length, 1);
  assert.equal(reloadCancel.phase, "reloading");

  const modeCancel = new WeaponSystem(M4_DEFINITION, 24);
  weaponCommand(modeCancel, { type: "selectFireMode" });
  drainWeapon(modeCancel);
  weaponCommand(modeCancel, { type: "triggerDown" });
  weaponCommand(modeCancel, { type: "triggerUp" });
  weaponCommand(modeCancel, { type: "selectFireMode" });
  weaponCommand(modeCancel, { type: "triggerDown" });
  assert.equal(modeCancel.getSnapshot().fireMode, "semi");
  assert.equal(
    [...drainWeapon(modeCancel), ...advanceWeapon(modeCancel, 0.2)].filter(
      (event) => event.type === "shot"
    ).length,
    1,
    "the first burst shot remains accepted, but mode switching cancels its remainder and preserves cooldown"
  );
});

test("automatic fire advances every cadence boundary and stops on trigger up", () => {
  const weapon = new WeaponSystem(SAW_DEFINITION, 25);
  weaponCommand(weapon, { type: "triggerDown" });
  assert.equal(drainWeapon(weapon).filter((event) => event.type === "shot").length, 1);

  weapon.update(0.1);
  assert.equal(drainWeapon(weapon).filter((event) => event.type === "shot").length, 1);
  weapon.update(0.1);
  assert.equal(
    drainWeapon(weapon).filter((event) => event.type === "shot").length,
    2,
    "one simulation update may cross multiple authored cadence boundaries"
  );

  weaponCommand(weapon, { type: "triggerUp" });
  drainWeapon(weapon);
  assert.equal(advanceWeapon(weapon, 0.5).filter((event) => event.type === "shot").length, 0);
});

// 3,000 RPM crosses several cadence boundaries inside one update without
// approaching the 100 ms hitch clamp, and the short reload keeps the timing
// arithmetic exact.
const RAPID_CADENCE_DEFINITION: WeaponDefinition = {
  ...SAW_DEFINITION,
  id: "rapid-cadence",
  shot: { ...SAW_DEFINITION.shot, roundsPerMinute: 3_000 },
  ammo: { magazineSize: 6, initialReserve: 6 },
  reload: { durationSeconds: 0.05 },
};

test("accepted shots report the cadence offset inside the update that accepted them", () => {
  const weapon = new WeaponSystem(RAPID_CADENCE_DEFINITION, 5);
  const interval = 60 / RAPID_CADENCE_DEFINITION.shot.roundsPerMinute;
  weaponCommand(weapon, { type: "triggerDown" });
  const immediate = drainWeapon(weapon).find(
    (event): event is Extract<WeaponEvent, { type: "shot" }> => event.type === "shot"
  );
  assert.ok(immediate);
  assert.equal(
    immediate.acceptedAtOffsetSeconds,
    0,
    "a round accepted by a command belongs to the start of the next simulation step"
  );

  const delta = interval * 2.5;
  weapon.update(delta);
  const offsets = drainWeapon(weapon)
    .filter((event): event is Extract<WeaponEvent, { type: "shot" }> => event.type === "shot")
    .map((event) => event.acceptedAtOffsetSeconds);
  assert.equal(offsets.length, 2);
  for (let index = 0; index < offsets.length; index += 1) {
    assert.ok(
      Math.abs(offsets[index] - interval * (index + 1)) < 1e-12,
      `offset ${index}: ${offsets[index]}`
    );
    assert.ok(offsets[index] <= delta, "an offset can never exceed its own update delta");
  }

  // A reload consumes simulation time before firing resumes, so the first round
  // after it must not claim the start of the frame.
  const reloading = new WeaponSystem(RAPID_CADENCE_DEFINITION, 6);
  reloading.magazine = 0;
  weaponCommand(reloading, { type: "reload" });
  weaponCommand(reloading, { type: "triggerDown" });
  reloading.update(0.04);
  drainWeapon(reloading);
  reloading.update(0.05);
  const afterReload = drainWeapon(reloading).find(
    (event): event is Extract<WeaponEvent, { type: "shot" }> => event.type === "shot"
  );
  assert.ok(afterReload);
  assert.ok(
    Math.abs(afterReload.acceptedAtOffsetSeconds - 0.01) < 1e-12,
    `first round after the reload: ${afterReload.acceptedAtOffsetSeconds}`
  );
});

test("an empty automatic weapon dry-fires once per trigger press", () => {
  const weapon = new WeaponSystem(SAW_DEFINITION, 26);
  weapon.magazine = 0;
  weaponCommand(weapon, { type: "triggerDown" });
  const heldEvents = [...drainWeapon(weapon), ...advanceWeapon(weapon, 1)];
  assert.equal(heldEvents.filter((event) => event.type === "dry-fire").length, 1);

  weaponCommand(weapon, { type: "triggerUp" });
  weaponCommand(weapon, { type: "triggerDown" });
  assert.equal(drainWeapon(weapon).filter((event) => event.type === "dry-fire").length, 1);
});

test("a dry weapon still spends its whole frame on ADS, recoil, and bloom recovery", () => {
  const emptied = (holdTrigger: boolean) => {
    const weapon = new WeaponSystem(SAW_DEFINITION, 31);
    weapon.setHandlingContext(STATIONARY_STAND);
    weaponCommand(weapon, { type: "triggerDown" });
    // Empty the magazine, then keep or release the trigger and request ADS.
    weapon.magazine = 1;
    advanceWeapon(weapon, 0.2);
    assert.equal(weapon.magazine, 0);
    if (!holdTrigger) weaponCommand(weapon, { type: "triggerUp" });
    weapon.setAdsWanted(true);
    advanceWeapon(weapon, 1);
    const snapshot = weapon.getSnapshot();
    return [snapshot.adsProgress, snapshot.recoilPitchRadians, snapshot.bloomRadians];
  };

  const held = emptied(true);
  const released = emptied(false);
  assert.equal(held[0], 1, "a held trigger must not freeze ADS progress on an empty weapon");
  assert.deepEqual(
    held,
    released,
    "holding the trigger on an empty weapon must not stop continuous recovery"
  );
});

test("dry automatic recovery is identical at 30, 60, and 144 Hz", () => {
  const run = (hz: number) => {
    const weapon = new WeaponSystem(SAW_DEFINITION, 32);
    weapon.setHandlingContext(STATIONARY_STAND);
    weapon.magazine = 2;
    weaponCommand(weapon, { type: "triggerDown" });
    weapon.setAdsWanted(true);
    advanceWeapon(weapon, 1, hz);
    const snapshot = weapon.getSnapshot();
    return [snapshot.adsProgress, snapshot.recoilPitchRadians, snapshot.bloomRadians].map(
      (value) => value.toFixed(12)
    );
  };
  const at30 = run(30);
  assert.deepEqual(run(60), at30);
  assert.deepEqual(run(144), at30);
});

test("reload is explicit and locks accepted shots through the proxy clip", () => {
  const weapon = new WeaponSystem(SNIPER_DEFINITION, 27);
  weapon.magazine = 0;
  weaponCommand(weapon, { type: "triggerDown" });
  assert.equal(drainWeapon(weapon)[0]?.type, "dry-fire");
  weaponCommand(weapon, { type: "triggerUp" });
  weaponCommand(weapon, { type: "reload" });
  assert.equal(weapon.phase, "reloading");
  assert.equal(drainWeapon(weapon)[0]?.type, "reload-started");

  weaponCommand(weapon, { type: "triggerDown" });
  assert.equal(advanceWeapon(weapon, 4.1).some((event) => event.type === "shot"), false);
  assert.equal(weapon.phase, "reloading");
  const completed = advanceWeapon(weapon, 0.1);
  assert.equal(weapon.magazine, 5);
  assert.equal(weapon.reserve, 15);
  assert.equal(completed.at(-1)?.type, "reload-completed");
});

test("numeric loadout switching cancels source actions and drains accepted source events", () => {
  const primary = new WeaponSystem(M4_DEFINITION, 28);
  const secondary = new WeaponSystem(SNIPER_DEFINITION, 29);
  const loadout = new LoadoutSystem(
    [
      { inputSlot: 1, id: "primary", weapon: primary },
      { inputSlot: 2, id: "secondary", weapon: secondary },
    ],
    "primary"
  );

  loadout.handleCommand({ type: "selectFireMode" });
  drainLoadout(loadout);
  loadout.handleCommand({ type: "triggerDown" });
  loadout.handleCommand({ type: "triggerUp" });
  loadout.handleCommand({ type: "reload" });
  loadout.handleCommand({ type: "equipSlot", slot: 2 });
  const switchEvents = drainLoadout(loadout);
  assert.equal(switchEvents.filter((event) => event.type === "shot").length, 1);
  assert.equal(switchEvents.filter((event) => event.type === "reload-started").length, 1);
  assert.equal(switchEvents.at(-1)?.type, "weapon-switch-started");

  loadout.update(0.35);
  const afterSwitch = drainLoadout(loadout);
  assert.equal(loadout.getSnapshot().equippedSlot, "secondary");
  assert.equal(afterSwitch.filter((event) => event.type === "weapon-equipped").length, 1);
  assert.equal(afterSwitch.some((event) => event.type === "shot"), false);
  assert.equal(afterSwitch.some((event) => event.type === "reload-completed"), false);
  assert.equal(primary.magazine, 29);
  assert.equal(primary.reserve, 120, "switching cancels rather than pausing or completing reload");
});

test("an invalid switch duration is rejected without touching switching state", () => {
  const primary = new WeaponSystem(M4_DEFINITION, 1);
  const secondary = new WeaponSystem(GLOCK_DEFINITION, 2);
  const loadout = new LoadoutSystem(
    [
      { inputSlot: 1, id: "primary", weapon: primary },
      { inputSlot: 2, id: "sidearm", weapon: secondary },
    ],
    "primary"
  );
  loadout.handleCommand({ type: "triggerDown" });
  loadout.handleCommand({ type: "triggerUp" });
  drainLoadout(loadout);
  const before = loadout.getSnapshot();

  for (const duration of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1]) {
    assert.equal(loadout.requestEquip("sidearm", duration), false, `duration ${duration}`);
    assert.deepEqual(loadout.getSnapshot(), before, `duration ${duration} mutated state`);
    assert.deepEqual(drainLoadout(loadout), [], `duration ${duration} emitted events`);
  }

  // A rejected request must leave the loadout usable, not wedged mid-switch.
  loadout.update(0.1);
  drainLoadout(loadout);
  assert.equal(loadout.requestEquip("sidearm", 0.2), true);
  loadout.update(0.2);
  assert.equal(loadout.getSnapshot().equippedSlot, "sidearm");
  assert.equal(loadout.getSnapshot().switchingTo, null);
});

test("loadout weapons get distinct but replayable instance seeds", () => {
  const seeds = (loadout: LoadoutSystem) =>
    [1, 2, 3, 4].map((inputSlot) => {
      loadout.requestEquipInputSlot(inputSlot, 0);
      return loadout.equippedWeapon.getSnapshot().instanceSeed;
    });
  const alpha = seeds(createDevelopmentLoadout(1));
  const alphaReplay = seeds(createDevelopmentLoadout(1));
  const bravo = seeds(createDevelopmentLoadout(2));

  assert.deepEqual(alphaReplay, alpha, "one shooter seed must replay exactly");
  assert.equal(new Set(alpha).size, 4, "slots within a loadout must not share a pattern");
  for (let index = 0; index < alpha.length; index += 1) {
    assert.notEqual(bravo[index], alpha[index], `slot ${index} shares a seed across shooters`);
  }

  // Two shooters carrying the same definition must not fire one pattern.
  const alphaShot = firstShot(M4_DEFINITION, alpha[1]);
  const bravoShot = firstShot(M4_DEFINITION, bravo[1]);
  assert.notDeepEqual(
    [alphaShot.dispersionPitchRadians, alphaShot.dispersionYawRadians],
    [bravoShot.dispersionPitchRadians, bravoShot.dispersionYawRadians]
  );

  assert.throws(() => new WeaponSystem(M4_DEFINITION, Number.NaN), /integer instance seed/);
  assert.throws(() => new WeaponSystem(M4_DEFINITION, 1.5), /integer instance seed/);
});

test("development slot 4 equips the automatic SAW definition", () => {
  const loadout = createDevelopmentLoadout();
  assert.equal(loadout.requestEquipInputSlot(4, 0), true);
  assert.equal(loadout.getSnapshot().equippedSlot, "support");
  assert.equal(loadout.equippedWeapon.definition.id, SAW_DEFINITION.id);
  assert.equal(loadout.equippedWeapon.getSnapshot().fireMode, "auto");

  loadout.handleCommand({ type: "triggerDown" });
  loadout.update(0.1);
  loadout.update(0.1);
  const events = drainLoadout(loadout);
  assert.equal(events.filter((event) => event.type === "shot").length, 4);
});

test("local player preserves ordered serializable weapon commands and reset emits trigger up", () => {
  const player = new LocalPlayerController();
  const target = { weaponCommands: [] as WeaponCommand[], adsWanted: false, holdingBreath: false };
  player.triggerDown();
  player.selectFireMode();
  player.requestReload();
  player.equipSlot(3);
  player.resetInput();
  player.consumeCommands(target);
  assert.deepEqual(target.weaponCommands, [
    { type: "triggerDown" },
    { type: "selectFireMode" },
    { type: "reload" },
    { type: "equipSlot", slot: 3 },
    { type: "triggerUp" },
  ]);
  assert.doesNotThrow(() => JSON.stringify(target.weaponCommands));
});

interface EventCounts {
  shots: number;
  dryFires: number;
  reloadStarted: number;
  reloadCompleted: number;
  modeChanges: number;
}

function createCounts(): EventCounts {
  return { shots: 0, dryFires: 0, reloadStarted: 0, reloadCompleted: 0, modeChanges: 0 };
}

function countEvent(counts: EventCounts, event: LoadoutEvent): void {
  if (event.type === "shot") counts.shots += 1;
  else if (event.type === "dry-fire") counts.dryFires += 1;
  else if (event.type === "reload-started") counts.reloadStarted += 1;
  else if (event.type === "reload-completed") counts.reloadCompleted += 1;
  else if (event.type === "fire-mode-changed") counts.modeChanges += 1;
}

interface LoadResult {
  readonly counts: EventCounts;
  readonly magazines: readonly number[];
  readonly reserves: readonly number[];
  readonly directionChecksums: readonly number[];
  readonly handlingStates: readonly string[];
  readonly undrainedEvents: number;
}

function runWeaponLoad(roundsPerMinute: number, renderHz: number): LoadResult {
  const definition: WeaponDefinition = {
    ...SAW_DEFINITION,
    id: `saw-${roundsPerMinute}`,
    shot: { ...SAW_DEFINITION.shot, roundsPerMinute },
    ammo: { magazineSize: 30, initialReserve: 30 },
    reload: { durationSeconds: 0.2 },
    fireModes: { supported: ["semi", "auto"], default: "semi" },
  };
  const loadouts = Array.from({ length: 32 }, (_, index) =>
    new LoadoutSystem(
      [
        {
          inputSlot: 1,
          id: "primary",
          weapon: new WeaponSystem({ ...definition, id: `${definition.id}-${index}` }, index + 1),
        },
      ],
      "primary"
    )
  );
  const counts = createCounts();
  const directionChecksums = new Uint32Array(loadouts.length);
  const drainAll = () => {
    for (let index = 0; index < loadouts.length; index += 1) {
      loadouts[index].drainEvents((event) => {
        countEvent(counts, event);
        if (event.type !== "shot") return;
        let checksum = directionChecksums[index];
        checksum = Math.imul(checksum ^ Math.round(event.recoilOffsetPitchRadians * 1e9), 16777619);
        checksum = Math.imul(checksum ^ Math.round(event.recoilOffsetYawRadians * 1e9), 16777619);
        checksum = Math.imul(checksum ^ Math.round(event.dispersionPitchRadians * 1e9), 16777619);
        checksum = Math.imul(checksum ^ Math.round(event.dispersionYawRadians * 1e9), 16777619);
        directionChecksums[index] = checksum >>> 0;
      });
    }
  };
  const commandAll = (command: WeaponCommand) => {
    for (const loadout of loadouts) loadout.handleCommand(command);
    drainAll();
  };
  const advanceAll = (seconds: number) => {
    let elapsed = 0;
    while (elapsed < seconds - 1e-12) {
      const dt = Math.min(1 / renderHz, seconds - elapsed);
      for (const loadout of loadouts) loadout.update(dt);
      drainAll();
      elapsed += dt;
    }
  };

  const interval = 60 / roundsPerMinute;
  commandAll({ type: "selectFireMode" });
  commandAll({ type: "triggerDown" });
  advanceAll(definition.ammo.magazineSize * interval + 1e-7);
  commandAll({ type: "triggerUp" });
  commandAll({ type: "reload" });
  advanceAll(definition.reload.durationSeconds + 1e-7);
  commandAll({ type: "triggerDown" });
  advanceAll(0.5 + 1e-7);
  commandAll({ type: "triggerUp" });

  let undrainedEvents = 0;
  for (const loadout of loadouts) {
    loadout.drainEvents(() => {
      undrainedEvents += 1;
    });
  }

  return {
    counts,
    magazines: loadouts.map((loadout) => loadout.equippedWeapon.magazine),
    reserves: loadouts.map((loadout) => loadout.equippedWeapon.reserve),
    directionChecksums: [...directionChecksums],
    handlingStates: loadouts.map((loadout) => {
      const snapshot = loadout.equippedWeapon.getSnapshot();
      return [
        snapshot.recoilPitchRadians,
        snapshot.recoilYawRadians,
        snapshot.bloomRadians,
        snapshot.dispersionConeRadians,
      ]
        .map((value) => value.toFixed(12))
        .join(":");
    }),
    undrainedEvents,
  };
}

test("32 complete automatic weapon systems are deterministic at 30, 60, and 144 Hz", () => {
  const metrics: Array<{
    rpm: number;
    hz: number;
    elapsedMilliseconds: number;
    counts: EventCounts;
    directionChecksum: number;
  }> = [];

  for (const rpm of [600, 900]) {
    let reference: LoadResult | null = null;
    for (const hz of [30, 60, 144]) {
      const started = performance.now();
      const result = runWeaponLoad(rpm, hz);
      metrics.push({
        rpm,
        hz,
        elapsedMilliseconds: Number((performance.now() - started).toFixed(2)),
        counts: result.counts,
        directionChecksum: result.directionChecksums.reduce(
          (checksum, value) => (checksum + value) >>> 0,
          0
        ),
      });
      if (reference) assert.deepEqual(result, reference);
      else reference = result;

      const roundsAfterReload = 1 + Math.floor((0.5 + 1e-7) / (60 / rpm));
      assert.deepEqual(result.counts, {
        shots: 32 * (30 + roundsAfterReload),
        dryFires: 32,
        reloadStarted: 32,
        reloadCompleted: 32,
        modeChanges: 32,
      });
      assert.deepEqual(result.magazines, Array(32).fill(30 - roundsAfterReload));
      assert.deepEqual(result.reserves, Array(32).fill(0));
      assert.equal(result.undrainedEvents, 0);
      assert.ok(new Set(result.directionChecksums).size > 1, "independent seeds must diverge");
    }
  }

  console.info("weapon-system load metrics", metrics);
});

test("weapon simulation clamps hitches instead of producing an unbounded catch-up burst", () => {
  const weapon = new WeaponSystem(SAW_DEFINITION, 30);
  weaponCommand(weapon, { type: "triggerDown" });
  drainWeapon(weapon);
  weapon.update(60);
  assert.equal(drainWeapon(weapon).filter((event) => event.type === "shot").length, 1);
  const beforeInvalidDelta = weapon.getSnapshot();
  weapon.update(Number.NaN);
  assert.deepEqual(weapon.getSnapshot(), beforeInvalidDelta);
});
