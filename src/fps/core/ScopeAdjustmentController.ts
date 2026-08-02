import * as THREE from "three/webgpu";
import type { BallisticEnvironment } from "../combat/BallisticEnvironment";
import { integrateBallisticVelocity, type MutableVelocity } from "../combat/BallisticModel.ts";

export const SCOPE_ZERO_DISTANCES_METRES = [
  100, 200, 300, 400, 500, 600, 700, 800, 900, 1_000, 1_100, 1_200, 1_300,
] as const;
export const WINDAGE_CLICK_RADIANS = 0.0001; // 0.1 mrad
const MAX_WINDAGE_CLICKS = 100;
const MAX_PREDICTION_SECONDS = 15;
const ZERO_SOLVE_ITERATIONS = 28;
const INITIAL_ZERO_ELEVATION_RADIANS = 0.15;
const MAX_ZERO_ELEVATION_RADIANS = 0.75;
const ZERO_BRACKET_STEP_RADIANS = 0.05;
const WORLD_UP = new THREE.Vector3(0, 1, 0);

export interface BallisticSightProfile {
  readonly muzzleVelocityMetresPerSecond: number;
  readonly ballisticCoefficientG1: number;
}

export interface BallisticPrediction {
  readonly rangeMetres: number;
  readonly verticalOffsetMetres: number;
  readonly lateralOffsetMetres: number;
  readonly flightTimeSeconds: number;
}

export interface ScopeAdjustmentSnapshot {
  readonly zeroDistanceMetres: number;
  readonly elevationRadians: number;
  readonly elevationMilliradians: number;
  readonly windageClicks: number;
  readonly windageMilliradians: number;
}

export type ScopeAdjustmentAction =
  | "elevation-up"
  | "elevation-down"
  | "windage-left"
  | "windage-right"
  | "reset";

export const DEFAULT_SCOPE_BINDINGS: Readonly<Record<string, ScopeAdjustmentAction>> = {
  ArrowUp: "elevation-up",
  PageUp: "elevation-up",
  ArrowDown: "elevation-down",
  PageDown: "elevation-down",
  ArrowLeft: "windage-left",
  ArrowRight: "windage-right",
  Digit0: "reset",
};

const KEY_FALLBACKS: Readonly<Record<string, ScopeAdjustmentAction>> = {
  ArrowUp: "elevation-up",
  PageUp: "elevation-up",
  ArrowDown: "elevation-down",
  PageDown: "elevation-down",
  ArrowLeft: "windage-left",
  ArrowRight: "windage-right",
  "0": "reset",
};

export function scopeAdjustmentActionForKey(
  event: Pick<KeyboardEvent, "code" | "key">
): ScopeAdjustmentAction | null {
  // Own-property only. These tables are keyed straight from a KeyboardEvent, so
  // a key named "constructor" or "toString" would otherwise return a function.
  if (Object.hasOwn(DEFAULT_SCOPE_BINDINGS, event.code)) return DEFAULT_SCOPE_BINDINGS[event.code];
  if (Object.hasOwn(KEY_FALLBACKS, event.key)) return KEY_FALLBACKS[event.key];
  return null;
}

export function predictBallisticAtSightRange(
  profile: BallisticSightProfile,
  environment: BallisticEnvironment,
  rangeMetres: number,
  elevationRadians: number,
  windageRadians = 0
): BallisticPrediction {
  const cosElevation = Math.cos(elevationRadians);
  let velocityX = Math.sin(windageRadians) * cosElevation * profile.muzzleVelocityMetresPerSecond;
  let velocityY = Math.sin(elevationRadians) * profile.muzzleVelocityMetresPerSecond;
  let velocityZ = -Math.cos(windageRadians) * cosElevation * profile.muzzleVelocityMetresPerSecond;
  let positionX = 0;
  let positionY = 0;
  let positionZ = 0;
  let elapsed = 0;
  const nextVelocity: MutableVelocity = { x: 0, y: 0, z: 0 };
  const dt = environment.fixedStepSeconds;
  const maxSteps = Math.ceil(MAX_PREDICTION_SECONDS / dt);

  for (let step = 0; step < maxSteps; step += 1) {
    integrateBallisticVelocity(
      velocityX,
      velocityY,
      velocityZ,
      profile.ballisticCoefficientG1,
      environment,
      dt,
      nextVelocity
    );
    const nextX = positionX + (velocityX + nextVelocity.x) * 0.5 * dt;
    const nextY = positionY + (velocityY + nextVelocity.y) * 0.5 * dt;
    const nextZ = positionZ + (velocityZ + nextVelocity.z) * 0.5 * dt;
    const previousForward = -positionZ;
    const nextForward = -nextZ;
    if (nextForward >= rangeMetres) {
      const span = nextForward - previousForward;
      const fraction = span > Number.EPSILON ? (rangeMetres - previousForward) / span : 0;
      return {
        rangeMetres,
        verticalOffsetMetres: THREE.MathUtils.lerp(positionY, nextY, fraction),
        lateralOffsetMetres: THREE.MathUtils.lerp(positionX, nextX, fraction),
        flightTimeSeconds: elapsed + dt * fraction,
      };
    }
    positionX = nextX;
    positionY = nextY;
    positionZ = nextZ;
    velocityX = nextVelocity.x;
    velocityY = nextVelocity.y;
    velocityZ = nextVelocity.z;
    elapsed += dt;
  }
  throw new Error(`Ballistic prediction did not reach ${rangeMetres} m`);
}

export function solveElevationZeroRadians(
  profile: BallisticSightProfile,
  environment: BallisticEnvironment,
  rangeMetres: number
): number {
  const solution = trySolveElevationZeroRadians(profile, environment, rangeMetres);
  if (solution === null) throw new Error(`Unable to solve ${rangeMetres} m scope zero`);
  return solution;
}

/** Returns null when the projectile cannot reach or cross the sightline at this range. */
export function trySolveElevationZeroRadians(
  profile: BallisticSightProfile,
  environment: BallisticEnvironment,
  rangeMetres: number
): number | null {
  const stillAir: BallisticEnvironment = {
    ...environment,
    windVelocity: { x: 0, y: 0, z: 0 },
  };
  let low = 0;
  let lowPrediction: BallisticPrediction;
  try {
    lowPrediction = predictBallisticAtSightRange(profile, stillAir, rangeMetres, low);
  } catch {
    return null;
  }
  if (lowPrediction.verticalOffsetMetres >= 0) return 0;

  let high = INITIAL_ZERO_ELEVATION_RADIANS;
  let bracketed = false;
  while (high <= MAX_ZERO_ELEVATION_RADIANS + Number.EPSILON) {
    try {
      if (predictBallisticAtSightRange(profile, stillAir, rangeMetres, high).verticalOffsetMetres >= 0) {
        bracketed = true;
        break;
      }
    } catch {
      // Increasing elevation only reduces forward velocity. Once the round can
      // no longer reach the range, no steeper zero can recover it.
      return null;
    }
    low = high;
    high += ZERO_BRACKET_STEP_RADIANS;
  }
  if (!bracketed) return null;

  for (let iteration = 0; iteration < ZERO_SOLVE_ITERATIONS; iteration += 1) {
    const middle = (low + high) * 0.5;
    const prediction = predictBallisticAtSightRange(profile, stillAir, rangeMetres, middle);
    if (prediction.verticalOffsetMetres < 0) low = middle;
    else high = middle;
  }
  return (low + high) * 0.5;
}

interface ScopeElevationPreset {
  readonly rangeMetres: number;
  readonly elevationRadians: number;
}

type Listener = () => void;

/** Mutable gameplay turret state; presentation reads its immutable snapshots. */
export class ScopeAdjustmentController {
  private readonly elevationPresets: readonly ScopeElevationPreset[];
  private readonly listeners = new Set<Listener>();
  private zeroIndex = 0;
  private windageClicks = 0;
  private snapshot: ScopeAdjustmentSnapshot;
  private readonly right = new THREE.Vector3();

  constructor(
    profile: BallisticSightProfile,
    environment: BallisticEnvironment,
    maxFlightSeconds = Infinity
  ) {
    const stillAir: BallisticEnvironment = {
      ...environment,
      windVelocity: { x: 0, y: 0, z: 0 },
    };
    this.elevationPresets = SCOPE_ZERO_DISTANCES_METRES.flatMap((rangeMetres) => {
      const elevationRadians = trySolveElevationZeroRadians(profile, environment, rangeMetres);
      if (elevationRadians === null) return [];
      const prediction = predictBallisticAtSightRange(
        profile,
        stillAir,
        rangeMetres,
        elevationRadians
      );
      return prediction.flightTimeSeconds <= maxFlightSeconds
        ? [{ rangeMetres, elevationRadians }]
        : [];
    });
    if (this.elevationPresets.length === 0) {
      this.elevationPresets = [{ rangeMetres: SCOPE_ZERO_DISTANCES_METRES[0], elevationRadians: 0 }];
    }
    this.snapshot = this.createSnapshot();
  }

  readonly subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = (): ScopeAdjustmentSnapshot => this.snapshot;

  apply(action: ScopeAdjustmentAction): boolean {
    const previousZero = this.zeroIndex;
    const previousWindage = this.windageClicks;
    if (action === "elevation-up") {
      this.zeroIndex = Math.min(this.elevationPresets.length - 1, this.zeroIndex + 1);
    } else if (action === "elevation-down") {
      this.zeroIndex = Math.max(0, this.zeroIndex - 1);
    } else if (action === "windage-left") {
      this.windageClicks = Math.max(-MAX_WINDAGE_CLICKS, this.windageClicks - 1);
    } else if (action === "windage-right") {
      this.windageClicks = Math.min(MAX_WINDAGE_CLICKS, this.windageClicks + 1);
    } else {
      this.zeroIndex = 0;
      this.windageClicks = 0;
    }
    if (previousZero === this.zeroIndex && previousWindage === this.windageClicks) return false;
    this.snapshot = this.createSnapshot();
    for (const listener of this.listeners) listener();
    return true;
  }

  applyToSightDirection(sightDirection: THREE.Vector3Like, target: THREE.Vector3): THREE.Vector3 {
    target.set(sightDirection.x, sightDirection.y, sightDirection.z).normalize();
    const windageRadians = this.windageClicks * WINDAGE_CLICK_RADIANS;
    target.applyAxisAngle(WORLD_UP, -windageRadians);
    this.right.crossVectors(target, WORLD_UP);
    if (this.right.lengthSq() > Number.EPSILON) {
      this.right.normalize();
      target.applyAxisAngle(this.right, this.elevationPresets[this.zeroIndex].elevationRadians);
    }
    return target.normalize();
  }

  private createSnapshot(): ScopeAdjustmentSnapshot {
    const preset = this.elevationPresets[this.zeroIndex];
    const elevationRadians = preset.elevationRadians;
    return {
      zeroDistanceMetres: preset.rangeMetres,
      elevationRadians,
      elevationMilliradians: elevationRadians * 1_000,
      windageClicks: this.windageClicks,
      windageMilliradians: this.windageClicks * 0.1,
    };
  }
}
