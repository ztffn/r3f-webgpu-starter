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

/** The loadout screen in deploy mode, carrying whatever /play asked for. */
export function loadoutStopUrl(search: string): string {
  const params = new URLSearchParams(search);
  // The stop is spent on the way out, so `loadout` never survives the round trip
  // and cannot bounce the player back here.
  params.delete("loadout");
  params.set("deploy", "1");
  return `/character?${params.toString()}`;
}

/**
 * /play with the stop spent, carrying the parameters the stop was reached with.
 *
 * Constants would have been simpler and were wrong: a dev URL that forced the
 * stop (`?scene=weapon&loadout=1`) came back as a bare `/play?loadout=0` and
 * silently launched the networked scope demo instead of the weapon scene.
 */
export function playDirectUrl(search: string): string {
  const params = new URLSearchParams(search);
  params.delete("deploy");
  params.set("loadout", "0");
  return `/play?${params.toString()}`;
}

/**
 * Does this /play URL stop at the loadout screen first?
 *
 * `?loadout=1` forces the stop and `?loadout=0` spends it. Otherwise the stop
 * happens for a URL that asks for nothing SPECIFIC — and "specific" means a
 * parameter this app actually reads, not any parameter at all. Checking for any
 * key let `?utm_source=discord` skip the funnel entirely, which is the same trap
 * the root redirect already avoided by matching a list instead of a catch-all:
 * ad platforms append those without asking.
 */
export function shouldStopAtLoadout(params: URLSearchParams): boolean {
  if (params.get("loadout") === "1") return true;
  if (params.get("loadout") === "0") return false;
  for (const key of params.keys()) {
    if (key !== "loadout" && KNOWN_LAUNCH_PARAMS.has(key)) return false;
  }
  return true;
}

/**
 * The game chunk, as the one thunk both the /play route's lazy() and the
 * loadout screen's countdown prefetch share — two inline import() calls of the
 * same module would work today, but only while nobody repoints one of them.
 */
export const loadGameApp = () => import("../game/GameApp");
