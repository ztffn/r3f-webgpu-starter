// Character validation and coercion.
//
// `validateCharacter` is called by BOTH the editor and the API, and the API calls
// it with the account's effective tier. So the assertions that matter are the
// gates: a client that re-enables a supporter-only control must still be refused,
// and the refusal has to name the field so a form can point at it.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_CHARACTER,
  SELECTABLE_PRIMARY,
  SELECTABLE_SECONDARY,
  coerceCharacter,
  validateCharacter,
  type Character,
} from "../../src/account/characters.ts";
import { WEAPON_DEFINITIONS } from "../../src/combat/weaponDefinitions.ts";

/** A valid character, which each test then breaks in exactly one way. */
function sample(overrides: Partial<Character> = {}): Character {
  return {
    appearance: { ...DEFAULT_CHARACTER.appearance, ...(overrides.appearance ?? {}) },
    loadout: { ...DEFAULT_CHARACTER.loadout, ...(overrides.loadout ?? {}) },
  };
}

const fields = (problems: { field: string }[]) => problems.map((p) => p.field);

describe("selectable weapons", () => {
  it("only name weapons the engine actually defines", () => {
    const known = new Set(WEAPON_DEFINITIONS.map((w) => w.id));
    for (const id of [...SELECTABLE_PRIMARY, ...SELECTABLE_SECONDARY]) {
      assert.ok(known.has(id), `${id} is not a defined weapon`);
    }
  });

  it("excludes the development entries", () => {
    // The distinction the lists exist for: the engine can fire `saw-test`, and a
    // player may not equip it.
    assert.ok(!SELECTABLE_PRIMARY.includes("saw-test"));
    assert.ok(!SELECTABLE_SECONDARY.includes("saw-test"));
  });

  it("ships a default that is itself selectable", () => {
    assert.ok(SELECTABLE_PRIMARY.includes(DEFAULT_CHARACTER.loadout.primary));
    assert.ok(SELECTABLE_SECONDARY.includes(DEFAULT_CHARACTER.loadout.secondary));
  });
});

describe("validateCharacter", () => {
  it("accepts the default for every tier", () => {
    for (const tier of ["guest", "enlisted", "supporter"] as const) {
      assert.deepEqual(validateCharacter(DEFAULT_CHARACTER, tier), [], tier);
    }
  });

  it("rejects a non-object outright", () => {
    for (const value of [null, undefined, 7, "character", []]) {
      assert.ok(validateCharacter(value, "supporter").length > 0, String(value));
    }
  });

  it("names every unknown appearance value", () => {
    const problems = validateCharacter(
      {
        appearance: { faction: "martian", camo: "plaid", headgear: "tophat", insignia: null },
        loadout: DEFAULT_CHARACTER.loadout,
      },
      "supporter"
    );
    assert.deepEqual(fields(problems).sort(), [
      "appearance.camo",
      "appearance.faction",
      "appearance.headgear",
    ]);
  });

  it("reports several problems at once rather than stopping at the first", () => {
    // A form should be able to show everything wrong in one pass.
    const problems = validateCharacter(
      {
        appearance: { faction: "martian", camo: "plaid", headgear: "cap", insignia: null },
        loadout: { primary: "saw-test", secondary: "nope" },
      },
      "supporter"
    );
    assert.ok(problems.length >= 4, `expected several, got ${problems.length}`);
  });

  it("gates custom insignia on the supporter capability", () => {
    const withInsignia = sample({
      appearance: { ...DEFAULT_CHARACTER.appearance, insignia: "DF2" },
    });
    assert.deepEqual(validateCharacter(withInsignia, "supporter"), []);
    assert.deepEqual(fields(validateCharacter(withInsignia, "enlisted")), [
      "appearance.insignia",
    ]);
    assert.deepEqual(fields(validateCharacter(withInsignia, "guest")), [
      "appearance.insignia",
    ]);
  });

  it("rejects a malformed insignia before it checks the tier", () => {
    // Shape first: a supporter still may not have a nine-character patch, and the
    // message must be about the format rather than about the tier.
    const problems = validateCharacter(
      sample({ appearance: { ...DEFAULT_CHARACTER.appearance, insignia: "lowercase" } }),
      "supporter"
    );
    assert.deepEqual(fields(problems), ["appearance.insignia"]);
    assert.match(problems[0]!.message, /capital letters/);
  });

  it("lets a guest change cosmetics but not persist a different loadout", () => {
    // This is the funnel: a guest may look how they like, and saving a loadout is
    // the first thing worth registering for.
    const cosmetic = sample({
      appearance: { faction: "opfor", camo: "winter", headgear: "helmet", insignia: null },
    });
    assert.deepEqual(validateCharacter(cosmetic, "guest"), []);

    const swapped = sample({ loadout: { primary: "m4", secondary: "glock-9mm" } });
    assert.deepEqual(fields(validateCharacter(swapped, "guest")), ["loadout"]);
    assert.deepEqual(validateCharacter(swapped, "enlisted"), []);
  });

  it("refuses weapons that exist but are not selectable", () => {
    const problems = validateCharacter(
      sample({ loadout: { primary: "saw-test", secondary: "glock-9mm" } }),
      "supporter"
    );
    assert.deepEqual(fields(problems), ["loadout.primary"]);
  });
});

describe("coerceCharacter", () => {
  it("returns the default for junk", () => {
    assert.deepEqual(coerceCharacter(null), DEFAULT_CHARACTER);
    assert.deepEqual(coerceCharacter({}), DEFAULT_CHARACTER);
    assert.deepEqual(coerceCharacter("nope"), DEFAULT_CHARACTER);
  });

  it("falls back PER FIELD, keeping what is still valid", () => {
    // The reason coercion exists: a later build renaming one headgear option must
    // not cost someone the camo they picked.
    const result = coerceCharacter({
      appearance: { faction: "opfor", camo: "tiger", headgear: "tophat", insignia: "AB" },
      loadout: { primary: "m4", secondary: "railgun" },
    });
    assert.equal(result.appearance.faction, "opfor");
    assert.equal(result.appearance.camo, "tiger");
    assert.equal(result.appearance.headgear, DEFAULT_CHARACTER.appearance.headgear);
    assert.equal(result.appearance.insignia, "AB");
    assert.equal(result.loadout.primary, "m4");
    assert.equal(result.loadout.secondary, DEFAULT_CHARACTER.loadout.secondary);
  });

  it("drops a malformed insignia to null rather than storing it", () => {
    assert.equal(
      coerceCharacter({ appearance: { insignia: "far too long" } }).appearance.insignia,
      null
    );
  });

  it("does NOT enforce the tier gate — that is validateCharacter's job", () => {
    // Worth pinning so nobody assumes coercion is a security boundary. It is a
    // read-path repair for stored data; the write path is what gates.
    const coerced = coerceCharacter({
      appearance: { ...DEFAULT_CHARACTER.appearance, insignia: "DF2" },
      loadout: DEFAULT_CHARACTER.loadout,
    });
    assert.equal(coerced.appearance.insignia, "DF2");
    assert.ok(validateCharacter(coerced, "enlisted").length > 0);
  });

  it("is stable when fed its own output", () => {
    const once = coerceCharacter({ appearance: { camo: "urban" } });
    assert.deepEqual(coerceCharacter(once), once);
  });
});
