import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { SPECIES } from "../../src/foliage/species.ts";

// The species table authors sizes in metres; the extraction manifest carries the
// prototype's unit-space measurements. These tests pin the contract between them:
// a prototype id that stops existing, or trunk/crown figures that drift from
// (unit x heightMetres), is a silent divergence between gameplay and art.
const manifest = JSON.parse(
  await fs.readFile("public/assets/vegetation/prototypes/prototypes-manifest.json", "utf8")
);

test("prototype manifest carries its attribution", () => {
  assert.ok(manifest.source.license, "licence missing");
  assert.ok(manifest.source.url, "source URL missing");
});

test("every species prototype reference resolves", () => {
  const ids = new Set(manifest.prototypes.map((p: { id: string }) => p.id));
  for (const species of SPECIES) {
    if (!species.prototype) continue;
    assert.ok(ids.has(species.prototype), `${species.id} references missing ${species.prototype}`);
  }
});

test("species trunk and crown figures are the manifest's units times the height", () => {
  const byId = new Map<string, { unit: { crownRadius: number; trunkRadius: number; trunkHeight: number } }>(
    manifest.prototypes.map((p: { id: string }) => [p.id, p])
  );
  for (const species of SPECIES) {
    if (!species.prototype) continue;
    const entry = byId.get(species.prototype);
    assert.ok(entry, species.id);
    const h = species.heightMetres;
    const tolerance = 0.05 * h;
    assert.ok(
      Math.abs(species.radiusMetres - entry.unit.crownRadius * h) <= tolerance,
      `${species.id} radiusMetres drifted from crown ${entry.unit.crownRadius} x ${h}`
    );
    assert.ok(species.trunk, `${species.id} prototype trees carry trunks`);
    assert.ok(
      Math.abs(species.trunk.radiusMetres - entry.unit.trunkRadius * h) <= tolerance,
      `${species.id} trunk radius drifted from ${entry.unit.trunkRadius} x ${h}`
    );
    assert.ok(
      Math.abs(species.trunk.heightMetres - entry.unit.trunkHeight * h) <= tolerance,
      `${species.id} trunk height drifted from ${entry.unit.trunkHeight} x ${h}`
    );
  }
});
