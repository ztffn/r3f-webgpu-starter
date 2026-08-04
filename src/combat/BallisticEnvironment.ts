import type { Vec3Like } from "./math.ts";

export interface BallisticEnvironment {
  readonly gravity: Vec3Like;
  readonly windVelocity: Vec3Like;
  readonly fixedStepSeconds: number;
  readonly maxCatchUpSeconds: number;
}

export const DEFAULT_BALLISTIC_ENVIRONMENT: BallisticEnvironment = {
  gravity: { x: 0, y: -9.80665, z: 0 },
  // A visible but ordinary crosswind for the default -Z target ladder.
  windVelocity: { x: 4, y: 0, z: 0 },
  fixedStepSeconds: 1 / 120,
  maxCatchUpSeconds: 0.25,
};

function finiteParam(query: URLSearchParams, key: string, fallback: number): number {
  const raw = query.get(key);
  if (raw === null) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function readBallisticEnvironment(search: string): BallisticEnvironment {
  const query = new URLSearchParams(search);
  return {
    gravity: { ...DEFAULT_BALLISTIC_ENVIRONMENT.gravity },
    windVelocity: {
      x: finiteParam(query, "windx", DEFAULT_BALLISTIC_ENVIRONMENT.windVelocity.x),
      y: 0,
      z: finiteParam(query, "windz", DEFAULT_BALLISTIC_ENVIRONMENT.windVelocity.z),
    },
    fixedStepSeconds: DEFAULT_BALLISTIC_ENVIRONMENT.fixedStepSeconds,
    maxCatchUpSeconds: DEFAULT_BALLISTIC_ENVIRONMENT.maxCatchUpSeconds,
  };
}
