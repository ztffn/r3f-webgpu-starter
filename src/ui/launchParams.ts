// The /play launch vocabulary — the ONE list of URL parameters the game reads,
// with each parameter's role, plus the site<->game funnel handshake and the one
// dynamic-import thunk for the game chunk. Three-free and React-free so the
// site entry chunk can carry it: routes.tsx, GameApp and the dev console's
// Launch tab all derive their lists from here instead of hand-maintaining three.

export interface LaunchParamSpec {
  readonly name: string;
  /**
   * Boolean parameters only: "default-off" is set with `=1`, "default-on" is
   * cleared with `=0`. Absent means the parameter carries a string value.
   */
  readonly flag?: "default-off" | "default-on";
  /**
   * An EXPLICIT parameter marks the URL as a documented dev URL: GameApp then
   * takes it at its word instead of applying the bare-/play networked defaults
   * (`scene=scope&motor=1&net=1`). Connection details (server, room, label) are
   * deliberately NOT explicit — they refine a session, they do not choose one,
   * so `/play?room=X` joins that room in the default networked game.
   */
  readonly explicit: boolean;
  /** Legacy `/?scene=...` URLs redirect to /play when this parameter appears. */
  readonly redirectsFromRoot: boolean;
}

export const LAUNCH_PARAMS: readonly LaunchParamSpec[] = [
  { name: "scene", explicit: true, redirectsFromRoot: true },
  { name: "motor", flag: "default-off", explicit: true, redirectsFromRoot: true },
  { name: "net", flag: "default-off", explicit: true, redirectsFromRoot: true },
  { name: "bench", flag: "default-off", explicit: true, redirectsFromRoot: true },
  { name: "debug", flag: "default-off", explicit: true, redirectsFromRoot: true },
  { name: "weather", explicit: true, redirectsFromRoot: true },
  { name: "blades", flag: "default-on", explicit: true, redirectsFromRoot: true },
  { name: "hudpreview", flag: "default-off", explicit: true, redirectsFromRoot: false },
  { name: "server", explicit: false, redirectsFromRoot: false },
  { name: "room", explicit: false, redirectsFromRoot: false },
  { name: "label", explicit: false, redirectsFromRoot: false },
  { name: "input", explicit: false, redirectsFromRoot: false },
  { name: "hud", flag: "default-on", explicit: false, redirectsFromRoot: false },
  // The funnel token (below). MUST stay explicit:false or the loadout screen's
  // own deploy URL would suppress the networked defaults it exists to reach.
  { name: "loadout", explicit: false, redirectsFromRoot: false },
  { name: "crosshair", flag: "default-on", explicit: false, redirectsFromRoot: false },
  { name: "shotdebug", flag: "default-off", explicit: false, redirectsFromRoot: false },
  { name: "impacttest", flag: "default-off", explicit: false, redirectsFromRoot: false },
  { name: "weaponanim", flag: "default-off", explicit: false, redirectsFromRoot: false },
  { name: "canopyall", flag: "default-off", explicit: false, redirectsFromRoot: false },
];

export const EXPLICIT_LAUNCH_PARAMS: readonly string[] = LAUNCH_PARAMS.filter(
  (spec) => spec.explicit
).map((spec) => spec.name);

export const ROOT_REDIRECT_PARAMS: readonly string[] = LAUNCH_PARAMS.filter(
  (spec) => spec.redirectsFromRoot
).map((spec) => spec.name);

export const KNOWN_LAUNCH_PARAMS: ReadonlySet<string> = new Set(
  LAUNCH_PARAMS.map((spec) => spec.name)
);

/** Read a boolean parameter honouring its declared default polarity. */
export function launchFlag(params: URLSearchParams, name: string): boolean {
  const spec = LAUNCH_PARAMS.find((candidate) => candidate.name === name);
  if (spec?.flag === "default-on") return params.get(name) !== "0";
  return params.get(name) === "1";
}

/** Write a boolean parameter, emitting nothing when the value is its default. */
export function setLaunchFlag(
  params: URLSearchParams,
  name: string,
  value: boolean
): void {
  const spec = LAUNCH_PARAMS.find((candidate) => candidate.name === name);
  if (spec?.flag === undefined) return;
  if (spec.flag === "default-on" && !value) params.set(name, "0");
  if (spec.flag === "default-off" && value) params.set(name, "1");
}

/* --- the funnel handshake --------------------------------------------------
 * A bare /play is the site funnel and stops at the loadout screen, which counts
 * down and comes back as /play?loadout=0. Both halves live HERE so the token's
 * mint and its spend cannot drift apart. `?loadout=1` forces the stop onto any
 * URL; any other parameter is a dev URL or a lobby join and goes straight in.
 */

/** Where the funnel stops: the loadout screen in deploy mode. */
export const LOADOUT_STOP_URL = "/character?deploy=1";
/** Where the loadout screen's deploy goes: /play with the stop spent. */
export const PLAY_DIRECT_URL = "/play?loadout=0";

export function shouldStopAtLoadout(params: URLSearchParams): boolean {
  if (params.get("loadout") === "1") return true;
  const hasOtherParams = [...params.keys()].some((key) => key !== "loadout");
  return !hasOtherParams && params.get("loadout") !== "0";
}

/**
 * The game chunk, as the one thunk both the /play route's lazy() and the
 * loadout screen's countdown prefetch share — two inline import() calls of the
 * same module would work today, but only while nobody repoints one of them.
 */
export const loadGameApp = () => import("../game/GameApp");
