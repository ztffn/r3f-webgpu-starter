// Tier expiry and callsign rules.
//
// `effectiveTier` decides what an account may do, so its edge cases are the ones
// worth pinning: a lapsed supporter must lose the capability, and an unparseable
// date must fail closed rather than granting forever.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CALLSIGN_MAX,
  effectiveTier,
  guestCallsign,
  validateCallsign,
} from "../../src/account/accountTypes.ts";
import { can } from "../../src/account/tiers.ts";

const NOW = new Date("2026-08-04T00:00:00.000Z");

describe("effectiveTier", () => {
  it("leaves a tier with no expiry alone", () => {
    assert.equal(effectiveTier("supporter", null, NOW), "supporter");
    assert.equal(effectiveTier("enlisted", null, NOW), "enlisted");
    assert.equal(effectiveTier("guest", null, NOW), "guest");
  });

  it("keeps a supporter whose subscription is still running", () => {
    assert.equal(effectiveTier("supporter", "2026-09-01T00:00:00.000Z", NOW), "supporter");
  });

  it("drops a lapsed supporter to enlisted, not to guest", () => {
    // Not guest: they still have an account, a name and a career. Losing the
    // paid capabilities is the consequence of lapsing; losing the account is not.
    assert.equal(effectiveTier("supporter", "2026-07-01T00:00:00.000Z", NOW), "enlisted");
  });

  it("treats an expiry exactly now as expired", () => {
    assert.equal(effectiveTier("supporter", NOW.toISOString(), NOW), "enlisted");
  });

  it("fails closed on a date it cannot parse", () => {
    // The only safe direction for something that grants capabilities.
    assert.equal(effectiveTier("supporter", "not a date", NOW), "enlisted");
  });

  it("does not promote anyone when their expiry lapses", () => {
    assert.equal(effectiveTier("guest", "2026-07-01T00:00:00.000Z", NOW), "guest");
    assert.equal(effectiveTier("enlisted", "2026-07-01T00:00:00.000Z", NOW), "enlisted");
  });

  it("composes with the capability gate the way features use it", () => {
    const lapsed = effectiveTier("supporter", "2026-07-01T00:00:00.000Z", NOW);
    assert.equal(can(lapsed, "foundClan"), false);
    assert.equal(can(lapsed, "medals"), true, "a lapsed supporter keeps their record");
  });
});

describe("validateCallsign", () => {
  it("accepts ordinary names", () => {
    for (const name of ["Ada", "Ada_Sniper", "Viper-2", "a_b-c_d", "OPERATOR"]) {
      assert.equal(validateCallsign(name), null, name);
    }
  });

  it("rejects lengths outside the bounds", () => {
    assert.equal(validateCallsign("ab")?.reason, "too_short");
    assert.equal(validateCallsign("a".repeat(CALLSIGN_MAX + 1))?.reason, "too_long");
    assert.equal(validateCallsign("a".repeat(CALLSIGN_MAX)), null);
  });

  it("rejects spaces, punctuation and non-ASCII", () => {
    // Homoglyph impersonation is the reason for the charset rule, so a Cyrillic
    // 'а' that renders identically to 'a' has to be refused.
    for (const name of ["Ada Sniper", "Ada!", "Ada.Sniper", "Аdа", "Ada—Sniper"]) {
      assert.equal(validateCallsign(name)?.reason, "charset", name);
    }
  });

  it("rejects leading, trailing and doubled hyphens", () => {
    for (const name of ["-Ada", "Ada-", "Ada--Sniper"]) {
      assert.equal(validateCallsign(name)?.reason, "charset", name);
    }
  });

  it("reserves the guest prefix and role names, case-insensitively", () => {
    assert.equal(validateCallsign("Recruit-0001")?.reason, "reserved");
    assert.equal(validateCallsign("recruit-9999")?.reason, "reserved");
    assert.equal(validateCallsign("AdminOps")?.reason, "reserved");
    assert.equal(validateCallsign("MODERATOR1")?.reason, "reserved");
  });

  it("trims before judging, so a pasted name with spaces still works", () => {
    assert.equal(validateCallsign("  Ada  "), null);
  });
});

describe("guestCallsign", () => {
  it("always produces a name the validator would reserve", () => {
    // The two rules have to agree: guests are named `Recruit-NNNN`, and no
    // registered account may take that shape.
    for (const seed of [0, 7, 999, 10000, 123456, -42]) {
      const name = guestCallsign(seed);
      assert.match(name, /^Recruit-\d{4}$/, `seed ${seed}`);
      assert.equal(validateCallsign(name)?.reason, "reserved", name);
    }
  });
});
