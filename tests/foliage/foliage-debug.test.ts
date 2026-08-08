// Pins the false-colour view mapping, which is a readout people make decisions from.
//
// A debug view that quietly colours the wrong thing is worse than no view: it produces
// confident, wrong conclusions about where cost is going. These are cheap pure-function
// checks on the mapping between a view mode and the palette slot a bucket takes.

import assert from "node:assert/strict";
import test from "node:test";
import {
  FOLIAGE_DEBUG_HINTS,
  FOLIAGE_DEBUG_MODES,
  FOLIAGE_DEBUG_UNAVAILABLE,
  FOLIAGE_LOD_IMPOSTOR_SLOT,
  FOLIAGE_TIER_NEAR_SLOT,
  foliageDebugColor,
  foliageDebugSlot,
} from "../../src/foliage/foliageDebug.ts";
import { FOLIAGE_LOD_COUNT } from "../../src/foliage/foliageGeometry.ts";
import { SPECIES } from "../../src/foliage/species.ts";

const LOD = FOLIAGE_DEBUG_MODES.indexOf("LOD");
const TIER = FOLIAGE_DEBUG_MODES.indexOf("Tier");
const SPECIES_MODE = FOLIAGE_DEBUG_MODES.indexOf("Species");
const CELLS = FOLIAGE_DEBUG_MODES.indexOf("Cells");

test("every mode has an explanation, because the labels alone were not readable", () => {
  assert.equal(FOLIAGE_DEBUG_HINTS.length, FOLIAGE_DEBUG_MODES.length);
  for (const hint of FOLIAGE_DEBUG_HINTS) assert.ok(hint.length > 0);
});

test("Normal returns no slot, so buckets keep their real material", () => {
  assert.equal(foliageDebugSlot(0, 0, 0), null);
});

test("LOD maps each level to its own slot, and the ramp covers every level", () => {
  const slots = new Set<number>();
  for (let lod = 0; lod < FOLIAGE_LOD_COUNT; lod += 1) {
    const slot = foliageDebugSlot(LOD, lod, 3);
    assert.equal(slot, lod, "LOD view colours by level, not by species");
    slots.add(slot as number);
  }
  assert.equal(slots.size, FOLIAGE_LOD_COUNT, "levels must not share a colour");
  // The last level is the in-window impostor and takes the end of the heat ramp.
  assert.equal(foliageDebugSlot(LOD, FOLIAGE_LOD_COUNT - 1, 0), FOLIAGE_LOD_IMPOSTOR_SLOT);
});

test("Tier colours the near window the same regardless of level or species", () => {
  assert.equal(foliageDebugSlot(TIER, 0, 0), FOLIAGE_TIER_NEAR_SLOT);
  assert.equal(foliageDebugSlot(TIER, 3, 6), FOLIAGE_TIER_NEAR_SLOT);
});

test("Species gives every species a distinct colour", () => {
  const seen = new Map<string, number>();
  for (let s = 0; s < SPECIES.length; s += 1) {
    const slot = foliageDebugSlot(SPECIES_MODE, 1, s);
    assert.equal(slot, s);
    const rgb = foliageDebugColor(slot as number).join(",");
    assert.ok(!seen.has(rgb), `${SPECIES[s].id} shares a colour with species ${seen.get(rgb)}`);
    seen.set(rgb, s);
  }
});

test("Cells asks for the shader-side hash rather than a palette slot", () => {
  // -1 is the sentinel for "compute it from world position", which is what lets one
  // material serve every cell and survive buckets being re-pointed.
  assert.equal(foliageDebugSlot(CELLS, 2, 4), -1);
});

test("modes with nothing behind them return no slot and are declared unavailable", () => {
  for (const mode of FOLIAGE_DEBUG_UNAVAILABLE) {
    assert.equal(
      foliageDebugSlot(mode, 0, 0),
      null,
      `${FOLIAGE_DEBUG_MODES[mode]} must not colour anything while it is unimplemented`
    );
  }
  // Collision specifically: trunk proxies are analytic and client-only, so there is
  // nothing authoritative to draw. If this ever ships, the entry leaves this list.
  assert.ok(FOLIAGE_DEBUG_UNAVAILABLE.includes(FOLIAGE_DEBUG_MODES.indexOf("Collision")));
});
