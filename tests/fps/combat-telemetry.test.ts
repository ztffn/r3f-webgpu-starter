import assert from "node:assert/strict";
import test from "node:test";
import { Object3D, Vector3 } from "three/webgpu";
import {
  BallisticProjectileSystem,
  type BallisticResult,
} from "../../src/combat/BallisticProjectileSystem.ts";
import type { BallisticEnvironment } from "../../src/combat/BallisticEnvironment.ts";
import { HealthDamageable } from "../../src/combat/Damageable.ts";
import type { SurfaceId } from "../../src/combat/SurfaceProfile.ts";
import type { WorldHitKind, WorldQuery } from "../../src/fps/core/WorldQuery.ts";
import {
  CombatTelemetry,
  impactTelemetryKey,
  shotTelemetryKey,
  type ShotTelemetry,
} from "../../src/fps/ui/CombatTelemetry.ts";
import { AMMUNITION_DEFINITIONS } from "../../src/combat/AmmunitionDefinition.ts";

const STILL: BallisticEnvironment = {
  gravity: { x: 0, y: 0, z: 0 },
  windVelocity: { x: 0, y: 0, z: 0 },
  fixedStepSeconds: 1 / 120,
  maxCatchUpSeconds: 0.25,
};

interface Layer {
  readonly z: number;
  readonly objectId: string;
  readonly kind: WorldHitKind;
  readonly surfaceId: SurfaceId;
  readonly thicknessMetres: number;
  readonly damageable?: HealthDamageable;
}

/** Straight-ahead layered world: each plane is contacted once, nearest first. */
function layeredQuery(layers: readonly Layer[]): WorldQuery {
  const objects = new Map(
    layers.map((layer) => {
      const object = new Object3D();
      object.name = layer.objectId;
      return [layer.objectId, object];
    })
  );
  return {
    raycast(origin, direction, maxDistance) {
      if (direction.z >= 0) return null;
      let nearest: { layer: Layer; distance: number } | null = null;
      for (const layer of layers) {
        const distance = (layer.z - origin.z) / direction.z;
        if (!(distance > 1e-6) || distance > maxDistance) continue;
        if (!nearest || distance < nearest.distance) nearest = { layer, distance };
      }
      if (!nearest) return null;
      const { layer, distance } = nearest;
      return {
        distance,
        point: new Vector3(
          origin.x + direction.x * distance,
          origin.y + direction.y * distance,
          layer.z
        ),
        normal: new Vector3(0, 0, 1),
        kind: layer.kind,
        objectId: layer.objectId,
        surfaceId: layer.surfaceId,
        penetrationThicknessMetres: layer.thicknessMetres,
        damageable: layer.damageable ?? null,
        objectName: objects.get(layer.objectId)!.name,
      };
    },
  };
}

function fireThrough(layers: readonly Layer[], maxDistance = 40): ShotTelemetry {
  const system = new BallisticProjectileSystem(layeredQuery(layers), STILL, { capacity: 1 });
  const telemetry = new CombatTelemetry();
  const ammunition = AMMUNITION_DEFINITIONS["50bmg"];
  assert.equal(
    system.spawn({
      sourceId: "telemetry-rig",
      sequence: 1,
      origin: new Vector3(),
      direction: new Vector3(0, 0, -1),
      maxDistance,
      maxFlightSeconds: 1,
      damage: ammunition.baseDamage,
      ammunition,
    }),
    true
  );
  let result: BallisticResult | null = null;
  for (let frame = 0; frame < 240 && !result; frame += 1) {
    system.update(1 / 60);
    system.drainImpactEvents(() => {});
    system.drainResults((next) => {
      result = next;
    });
  }
  assert.ok(result, "the round never resolved");
  telemetry.publishShot(result);
  const published = telemetry.getSnapshot().lastShot;
  assert.ok(published);
  return published;
}

function publishMiss(telemetry: CombatTelemetry, sourceId: string, sequence: number): void {
  const system = new BallisticProjectileSystem({ raycast: () => null }, STILL, { capacity: 1 });
  assert.equal(
    system.spawn({
      sourceId,
      sequence,
      origin: new Vector3(),
      direction: new Vector3(0, 0, -1),
      maxDistance: 20,
      maxFlightSeconds: 1,
      damage: 10,
      ammunition: AMMUNITION_DEFINITIONS["556"],
    }),
    true
  );
  let published = false;
  for (let frame = 0; frame < 240 && !published; frame += 1) {
    system.update(1 / 60);
    system.drainResults((result) => {
      telemetry.publishShot(result);
      published = true;
    });
  }
  assert.ok(published);
}

test("shot and impact identity keys stay distinct across weapons", () => {
  const telemetry = new CombatTelemetry();
  // Every weapon numbers its own shots from one, so two weapons both produce a
  // sequence 1 and a bare sequence would collide as a presentation key.
  publishMiss(telemetry, "prototype-sniper", 1);
  publishMiss(telemetry, "glock-9mm", 1);
  const [latest, previous] = telemetry.getSnapshot().recentShots;
  assert.equal(latest.sequence, previous.sequence);
  assert.notEqual(shotTelemetryKey(latest), shotTelemetryKey(previous));

  const contact = {
    shotSequence: 1,
    interactionIndex: 0,
    ammunitionId: "556" as const,
    kind: "world" as const,
    objectId: "crate",
    objectName: "crate",
    targetId: null,
    damageApplied: 0,
    healthBefore: null,
    healthAfter: null,
    destroyed: false,
    surfaceId: "wood" as const,
    outcome: "stopped" as const,
    point: new Vector3(0, 0, -5),
    exitPoint: null,
    normal: new Vector3(0, 0, 1),
    effectiveThicknessMetres: 0.06,
    speedBeforeMetresPerSecond: 900,
    speedAfterMetresPerSecond: 0,
    energyBeforeJoules: 1_600,
    energyAfterJoules: 0,
  };
  telemetry.publishImpact({ ...contact, sourceId: "prototype-sniper" });
  const sniperImpact = telemetry.getSnapshot().lastImpact!;
  telemetry.publishImpact({ ...contact, sourceId: "glock-9mm" });
  const glockImpact = telemetry.getSnapshot().lastImpact!;
  assert.equal(glockImpact.sourceId, "glock-9mm");
  assert.notEqual(impactTelemetryKey(sniperImpact), impactTelemetryKey(glockImpact));
});

test("a target followed by terrain keeps target range and terminal contact apart", () => {
  const sentry = new HealthDamageable("sentry", 400);
  const shot = fireThrough([
    { z: -10, objectId: "sentry", kind: "target", surfaceId: "flesh", thicknessMetres: 0.05, damageable: sentry },
    { z: -20, objectId: "hillside", kind: "terrain", surfaceId: "stone", thicknessMetres: 4 },
  ]);

  assert.ok(shot.target, "the damaged target must be reported");
  assert.equal(shot.target.targetId, "sentry");
  assert.equal(shot.target.objectName, "sentry");
  assert.ok(
    Math.abs(shot.target.rangeMetres - 10) < 0.2,
    `the target row must show the target's own range, got ${shot.target.rangeMetres}`
  );
  assert.equal(shot.target.destroyed, false);
  assert.equal(shot.target.damageApplied, shot.totalDamageApplied);
  assert.equal(shot.target.healthAfter, sentry.health);

  assert.ok(shot.terminal, "a stopped round must report where it stopped");
  assert.equal(shot.terminal.stopped, true);
  assert.equal(shot.terminal.kind, "terrain");
  assert.equal(shot.terminal.objectName, "hillside");
  assert.equal(shot.terminal.targetId, null, "terrain must never inherit the target id");
  assert.equal(shot.terminal.surfaceId, "stone");
  assert.equal(shot.terminal.penetrationOutcome, "stopped");
  assert.ok(
    shot.terminal.metres !== null && Math.abs(shot.terminal.metres - 20) < 0.2,
    `the terminal distance must be the terrain contact, got ${shot.terminal.metres}`
  );
});

test("a target followed by expiry reports a target without claiming a stopping contact", () => {
  const sentry = new HealthDamageable("sentry", 400);
  const shot = fireThrough(
    [
      {
        z: -10,
        objectId: "sentry",
        kind: "target",
        surfaceId: "flesh",
        thicknessMetres: 0.05,
        damageable: sentry,
      },
    ],
    25
  );

  assert.equal(shot.hit, true, "penetrating a target still counts as a hit");
  assert.ok(shot.target);
  assert.equal(shot.target.targetId, "sentry");
  assert.ok(shot.target.damageApplied > 0);
  assert.ok(shot.terminal);
  assert.equal(shot.terminal.stopped, false, "the round expired past its last contact");
  assert.equal(shot.terminal.metres, null);
  assert.equal(shot.terminal.penetrationOutcome, "penetrated");
});

test("two damaged targets attribute their own damage and destruction separately", () => {
  const alpha = new HealthDamageable("alpha", 20);
  const bravo = new HealthDamageable("bravo", 600);
  const shot = fireThrough([
    { z: -10, objectId: "alpha", kind: "target", surfaceId: "flesh", thicknessMetres: 0.05, damageable: alpha },
    // Thick enough that the round stops in the second target rather than
    // passing through it as well.
    { z: -20, objectId: "bravo", kind: "target", surfaceId: "flesh", thicknessMetres: 20, damageable: bravo },
  ]);

  assert.equal(alpha.health, 0);
  assert.ok(bravo.health > 0 && bravo.health < 600);
  assert.equal(shot.damagedTargetCount, 2);
  assert.equal(shot.anyTargetDestroyed, true);
  assert.ok(shot.totalDamageApplied > 20);

  assert.ok(shot.target);
  assert.equal(shot.target.targetId, "bravo", "the row's subject is the last damaged target");
  assert.equal(
    shot.target.destroyed,
    false,
    "destroying an earlier target must not mark this one down"
  );
  assert.equal(shot.target.healthAfter, bravo.health);
  assert.ok(
    shot.target.damageApplied < shot.totalDamageApplied,
    "the last target must not absorb the whole shot's damage total"
  );
  assert.equal(shot.terminal?.targetId, "bravo");
  assert.equal(shot.terminal?.stopped, true);
});
