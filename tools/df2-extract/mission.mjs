// mission — NovaLogic DF2 mission (.mis) and item-table (ITEMS.DEF) readers.
//
// Both formats are PLAIN TEXT with CRLF line endings and `begin <thing> / key
// value / end` blocks. ITEMS.DEF is the mission editor's own item database
// (MED.PFF); a mission refers to items by a numeric `type_id`, and the join is
// `type_id = ITEMS.DEF id - 100000`, whose `graphic` field names the .3di.
//
// SCOPE: object placement only. A mission also carries sky, fog, water and
// weather; those are deliberately NOT imported — this project has its own
// measured atmosphere presets and its rooms own their visuals (docs/08 §7.1),
// so importing a 1999 fog number would fight the thing it would land in.
//
// Coordinates: positions are 1/256 m, the same unit as .3DI geometry — the
// deliberate non-zero heights in real missions are round metres (-256 = -1 m,
// +768 = +3 m). `z` is an OFFSET from the terrain surface, not an absolute
// height (366 of Warfields' 416 items are exactly 0), so a consumer samples its
// own heightfield and adds it. `facing` is degrees; the observed range is
// 0..357 and the second value is unused here.
//
// No dependencies — Node built-ins only.

/**
 * Split on CRLF or LF and trim trailing whitespace.
 *
 * Comment lines are NOT stripped — they simply fail every `match` below, which
 * is why the parsers work on commented files without filtering them.
 */
function lines(text) {
  return text.split(/\r?\n/).map((l) => l.replace(/\s+$/, ""));
}

/**
 * Parse ITEMS.DEF into a Map of `type_id -> { name, type, graphic, ... }`.
 *
 * Every scalar key is kept, so a later pass (husks, hit points, AI class) has
 * the data without re-reading the file.
 */
export function parseItemsDef(text) {
  const byTypeId = new Map();
  let cur = null;
  for (const line of lines(text)) {
    const begin = line.match(/^begin\s+"(.*)"\s*$/);
    if (begin) {
      cur = { name: begin[1] };
      continue;
    }
    if (!cur) continue;
    if (/^end\b/.test(line)) {
      if (typeof cur.id === "number") byTypeId.set(cur.id - 100000, cur);
      cur = null;
      continue;
    }
    const kv = line.match(/^\s+([a-z_]+)\s+(.*)$/);
    if (!kv) continue;
    const [, key, raw] = kv;
    cur[key] = /^-?\d+$/.test(raw.trim()) ? Number(raw.trim()) : raw.trim();
  }
  return byTypeId;
}

/**
 * Parse a `.mis` mission into `{ name, designer, terrain, items[] }`.
 *
 * Atmosphere keys are read but NOT returned — see the scope note above.
 */
export function parseMis(text) {
  const src = lines(text);
  const out = { name: null, designer: null, terrain: null, items: [] };

  let block = null;
  let item = null;
  for (const line of src) {
    const begin = line.match(/^begin\s+(\w+)(?:\s+(\d+))?/);
    if (begin) {
      block = begin[1];
      if (block === "item") item = {};
      continue;
    }
    if (/^end\b/.test(line)) {
      if (block === "item" && item && item.typeId !== undefined) out.items.push(item);
      block = null;
      item = null;
      continue;
    }
    const kv = line.match(/^\s+(\w+)\s+(.*)$/);
    if (!kv) continue;
    const [, key, raw] = kv;
    const val = raw.trim();

    if (block === "general_information") {
      if (key === "name") out.name = val.replace(/^"|"$/g, "");
      else if (key === "designer") out.designer = val.replace(/^"|"$/g, "");
      else if (key === "terrain") out.terrain = val.replace(/\.trn$/i, "").toLowerCase();
      continue;
    }
    if (block === "item" && item) {
      if (key === "id") item.id = Number(val);
      else if (key === "type_id") item.typeId = Number(val);
      else if (key === "position") {
        const [x, y, z] = val.split(/\s+/).map(Number);
        item.pos = [x, y, z];
      } else if (key === "facing") {
        // Two angles: heading, then a tilt. In Warfields 356 items leave the
        // tilt at 0, 16 use 90 and 19 use 15 — deliberate, so it is kept.
        const [heading, tilt] = val.split(/\s+/).map(Number);
        item.facing = heading;
        item.pitch = tilt || 0;
      }
    }
  }
  return out;
}

/**
 * Join a mission against the item table into renderable placements, in METRES.
 *
 * Items whose definition has no `graphic` (markers — spawn points, waypoints —
 * and a few model-less decorations) are counted, not placed: they have no
 * geometry, and inventing one would put objects in the world the mission never
 * had.
 */
export function resolveMission(mission, itemsByTypeId) {
  const placements = [];
  const skipped = { markers: 0, noModel: 0, unknown: 0 };
  for (const it of mission.items) {
    const def = itemsByTypeId.get(it.typeId);
    if (!def) {
      skipped.unknown++;
      continue;
    }
    if (!def.graphic) {
      if (def.type === "marker") skipped.markers++;
      else skipped.noModel++;
      continue;
    }
    const [x, y, z] = it.pos ?? [0, 0, 0];
    placements.push({
      model: def.graphic.toLowerCase(),
      name: def.name,
      kind: def.type,
      /**
       * Sit on the terrain's SLOPE rather than standing plumb.
       *
       * `type vehicle` AND `axle_dist`: within the 60 vehicles those two agree
       * perfectly — all 30 with a ground movement function (veh0, carg, loco,
       * boat, herc) carry an axle distance, and all 30 without one (every
       * helicopter, every husk) lack it. An axle distance exists to work out
       * where the wheels meet the ground, so it marks what the engine put ON
       * the surface.
       *
       * The type test is load-bearing, not belt-and-braces: `axle_dist` is a
       * reused slot, and the "tree with sound" decorations all carry a uniform
       * 10. Keying on the field alone tilted 26 trees into the hillside — and
       * trees grow vertical whatever the slope.
       */
      conform: def.type === "vehicle" && def.axle_dist !== undefined,
      // 1/256 m -> m. `z` stays separate: it is an offset onto sampled ground.
      x: x / 256,
      y: y / 256,
      zOffset: z / 256,
      facing: it.facing ?? 0,
      /** Second angle (tilt). Carried through; consumers may ignore it. */
      pitch: it.pitch ?? 0,
    });
  }
  return { placements, skipped };
}
