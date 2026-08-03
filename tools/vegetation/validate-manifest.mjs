#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";

const file = path.resolve(process.argv[2] ?? "public/assets/vegetation/vegetation-manifest.json");
const manifest = JSON.parse(await fs.readFile(file, "utf8"));

if (manifest.schema !== "df2.vegetation-manifest/v1") throw new Error("Unsupported manifest schema");
if (!Array.isArray(manifest.sources) || manifest.sources.length === 0) {
  throw new Error("Manifest contains no source packs");
}

const ids = new Set();
for (const source of manifest.sources) {
  if (!source.asset?.extras?.source || !source.asset?.extras?.license) {
    throw new Error(`${source.sourceFile}: source license/URL metadata is missing`);
  }
}

for (const prototype of manifest.prototypes) {
  if (ids.has(prototype.id)) throw new Error(`Duplicate prototype id: ${prototype.id}`);
  ids.add(prototype.id);
  if (!Number.isFinite(prototype.triangles) || prototype.triangles < 0) {
    throw new Error(`${prototype.id}: invalid triangle count`);
  }
  if (!prototype.collider) continue;
  if (prototype.kind === "undergrowth") {
    throw new Error(`${prototype.id}: undergrowth must not receive a bullet collider`);
  }
  const collider = prototype.collider;
  if (!Number.isFinite(collider.penetrationThicknessMetres) || collider.penetrationThicknessMetres < 0) {
    throw new Error(`${prototype.id}: invalid penetration thickness`);
  }
}

console.log(
  `Validated ${manifest.sources.length} source packs, ${manifest.prototypes.length} prototypes, ` +
    `${manifest.prototypes.filter((prototype) => prototype.collider).length} collider proposals.`
);

