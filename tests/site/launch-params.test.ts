// The /play launch vocabulary and the loadout-stop handshake.
//
// Pure functions with no DOM, so they test like any Node module — and they decide
// whether every visitor's "Play now" reaches the game, which is worth more than a
// prose comment claiming an invariant. Each case below is a bug that shipped or
// was one edit away from shipping.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  EXPLICIT_LAUNCH_PARAMS,
  KNOWN_LAUNCH_PARAMS,
  LAUNCH_PARAMS,
  ROOT_REDIRECT_PARAMS,
  launchFlag,
  loadoutStopUrl,
  playDirectUrl,
  setLaunchFlag,
  shouldStopAtLoadout,
} from "../../src/ui/launchParams.ts";

const stops = (search: string) => shouldStopAtLoadout(new URLSearchParams(search));
/** The query half of a path-plus-search string these builders return. */
const searchOf = (url: string) => url.slice(url.indexOf("?"));
const paramsOf = (url: string) => new URLSearchParams(searchOf(url));

describe("the loadout stop", () => {
  it("stops a bare /play and a marketing link, not a dev URL", () => {
    assert.equal(stops(""), true, "the product funnel must stop at the loadout screen");
    // The bug this replaced: any key at all counted as a dev URL, so a link
    // shared through Discord or an ad platform skipped the funnel entirely.
    assert.equal(stops("?utm_source=discord"), true);
    assert.equal(stops("?fbclid=abc&gclid=def"), true);
    // A parameter the game actually reads means the caller asked for something
    // specific, and gets exactly that.
    assert.equal(stops("?scene=motor"), false);
    assert.equal(stops("?bench=1"), false);
    assert.equal(stops("?room=abc"), false);
  });

  it("is forced by loadout=1 and spent by loadout=0", () => {
    assert.equal(stops("?loadout=1"), true);
    assert.equal(stops("?scene=weapon&loadout=1"), true, "force must beat a dev URL");
    assert.equal(stops("?loadout=0"), false);
    assert.equal(
      stops("?loadout=0&utm_source=x"),
      false,
      "a spent stop must stay spent, or the funnel loops forever"
    );
  });

  it("carries the URL through the stop in both directions", () => {
    // A forced stop used to come back as a bare /play?loadout=0, which silently
    // launched the default networked scene instead of the one that was configured.
    const stop = loadoutStopUrl("?scene=weapon&loadout=1&dpr=0.8");
    const params = paramsOf(stop);
    assert.equal(params.get("deploy"), "1");
    assert.equal(params.get("scene"), "weapon");
    assert.equal(params.get("dpr"), "0.8");
    assert.equal(params.has("loadout"), false, "the stop token must not survive the hop");

    const back = paramsOf(playDirectUrl(searchOf(stop)));
    assert.equal(back.get("loadout"), "0", "deploying must spend the stop");
    assert.equal(back.get("scene"), "weapon", "the scene must survive the round trip");
    assert.equal(back.has("deploy"), false);
  });

  it("keeps `loadout` non-explicit, which the funnel depends on", () => {
    // If `loadout` ever became explicit, /play?loadout=0 — the URL every player
    // arrives on — would suppress the networked defaults and drop them into the
    // offline terrain spike. The comment in launchParams.ts says so; this is the
    // assertion that holds it.
    assert.equal(EXPLICIT_LAUNCH_PARAMS.includes("loadout"), false);
    assert.equal(KNOWN_LAUNCH_PARAMS.has("loadout"), true, "but the panel still owns it");
  });
});

describe("flag polarity", () => {
  it("reads and writes each parameter's declared default", () => {
    const empty = new URLSearchParams();
    // Default-off: absent is false, and only "1" turns it on.
    assert.equal(launchFlag(empty, "motor"), false);
    assert.equal(launchFlag(new URLSearchParams("?motor=1"), "motor"), true);
    // Default-on: absent is TRUE, and only "0" turns it off. Getting this
    // backwards is the §5.2 trap class — it fails silently in both directions.
    assert.equal(launchFlag(empty, "hud"), true);
    assert.equal(launchFlag(new URLSearchParams("?hud=0"), "hud"), false);
    assert.equal(launchFlag(empty, "blades"), true);
    assert.equal(launchFlag(new URLSearchParams("?blades=0"), "blades"), false);
  });

  it("emits nothing for a default and round-trips otherwise", () => {
    const out = new URLSearchParams();
    setLaunchFlag(out, "motor", false);
    setLaunchFlag(out, "hud", true);
    assert.equal(out.toString(), "", "defaults must not bloat a shared URL");

    setLaunchFlag(out, "motor", true);
    setLaunchFlag(out, "hud", false);
    assert.equal(launchFlag(out, "motor"), true);
    assert.equal(launchFlag(out, "hud"), false);
  });

  it("ignores a parameter that is not a flag", () => {
    const out = new URLSearchParams();
    setLaunchFlag(out, "server", true);
    assert.equal(out.has("server"), false, "a string parameter has no polarity to write");
  });
});

describe("the derived lists", () => {
  it("are subsets of the one vocabulary, so nothing can drift", () => {
    for (const name of [...EXPLICIT_LAUNCH_PARAMS, ...ROOT_REDIRECT_PARAMS]) {
      assert.equal(KNOWN_LAUNCH_PARAMS.has(name), true, name);
    }
    assert.equal(KNOWN_LAUNCH_PARAMS.size, LAUNCH_PARAMS.length, "no duplicate names");
  });

  it("treats connection details as refinements rather than dev URLs", () => {
    // `?room=` and `?server=` describe WHICH session, not which product mode, so
    // they must not suppress the networked defaults that make them useful.
    for (const name of ["server", "room", "label", "input"]) {
      assert.equal(EXPLICIT_LAUNCH_PARAMS.includes(name), false, name);
    }
  });
});
