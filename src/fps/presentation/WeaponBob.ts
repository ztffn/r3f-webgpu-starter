// Procedural weapon bob: the figure-eight the viewmodel traces as the player moves.
//
// Pure and Three-free so it is testable without a renderer, per the gameplay-code rule.
// The camera deliberately does NOT bob — the motion-sickness lever — and a still view is
// also what gives the weapon parallax. Constants come from readable engine sources, and
// the three traps that shaped this file are documented on the members they bit.

/** One gait's shape. Amplitudes are peak, not peak-to-peak. */
export interface WeaponBobGait {
  /**
   * Master intensity for this gait, multiplied into every amplitude below but NOT into
   * the stride. The one knob for "too strong" — it changes how far the weapon travels
   * without touching how often, so the gait stays intact while the motion quietens.
   */
  weight: number;
  /** Lateral swing, `sin θ`. Roughly TWICE the vertical in every shipped engine. */
  lateralMetres: number;
  /** Vertical, `sin 2θ` — one dip per footfall. */
  verticalMetres: number;
  /** Forward/back surge, `sin 2θ`. */
  forwardMetres: number;
  rollDegrees: number;
  yawDegrees: number;
  /** Pitch nods at `sin 2θ`, with the vertical, not with the lateral swing. */
  pitchDegrees: number;
  /**
   * Distance covered per full cycle — one cycle is TWO footfalls.
   *
   * The single most important number here. Half-Life 2 drives its bob from distance
   * exactly as this does and never produces a shuffle, because its stride is 7.32 m; an
   * earlier version used 1.9 m at every speed, so every extra metre per second became
   * cadence instead of reach — which reads as running on tiny feet.
   */
  metresPerCycle: number;
}

export interface WeaponBobConfig {
  walk: WeaponBobGait;
  sprint: WeaponBobGait;
  /** Speeds the two gaits are quoted at; amplitude and stride interpolate between them. */
  walkSpeedMetresPerSecond: number;
  sprintSpeedMetresPerSecond: number;
  /** Floor on amplitude so a creeping player still bobs visibly. Quake III's rule. */
  minAmplitudeScale: number;
  /**
   * Cadence bounds, in FOOTFALLS per second.
   *
   * Quake III and Doom 3 get a bound structurally by holding cadence constant per gait; a
   * distance-driven phase has to impose one. It is what stops a future speed change from
   * quietly reintroducing the shuffle.
   */
  minStepsPerSecond: number;
  maxStepsPerSecond: number;
  /** Bob is cut to this fraction while fully aimed — a sight picture must hold still. */
  adsScale: number;
  /** How quickly the bob fades in and out as the player starts and stops. */
  amplitudeResponse: number;
}

/**
 * Sourced defaults.
 *
 * Amplitudes and the lateral-dominant ratio follow the engine survey; vertical-dominant
 * bob is a tutorial habit rather than an engine one. The stride pair follows Doom 3, whose
 * cadence is constant per gait so stride falls out of speed — 3.03 m walking and 3.58 m
 * running, lengthening only 18% while speed rises 57%. Most of the extra speed SHOULD
 * become cadence; the bug was that all of it did.
 */
export const DEFAULT_WEAPON_BOB: WeaponBobConfig = {
  walk: {
    weight: 1,
    lateralMetres: 0.011,
    verticalMetres: 0.005,
    forwardMetres: 0.003,
    rollDegrees: 0.9,
    yawDegrees: 1.1,
    pitchDegrees: 0.5,
    metresPerCycle: 1.9,
  },
  sprint: {
    weight: 1,
    lateralMetres: 0.025,
    verticalMetres: 0.012,
    forwardMetres: 0.007,
    rollDegrees: 2,
    yawDegrees: 2.5,
    pitchDegrees: 1.2,
    metresPerCycle: 3.6,
  },
  walkSpeedMetresPerSecond: 1.6,
  sprintSpeedMetresPerSecond: 6,
  minAmplitudeScale: 0.35,
  minStepsPerSecond: 1.5,
  maxStepsPerSecond: 3.6,
  adsScale: 0.2,
  amplitudeResponse: 6,
};

/** Frame-rate-independent exponential approach. Mirrors THREE.MathUtils.damp. */
function damp(current: number, target: number, lambda: number, dt: number): number {
  return target + (current - target) * Math.exp(-lambda * dt);
}

// Guarded, matching the shared `clamp01` in weapons/WeaponHandling.ts. Dropping the
// finite check is not a simplification: a non-finite adsProgress then returns NaN instead
// of 0, and a NaN here reaches the rig transform and blanks the weapon.
const clamp01 = (value: number): number =>
  Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

export class WeaponBobController {
  /** Metres, in the rig's own local frame. */
  offsetX = 0;
  offsetY = 0;
  offsetZ = 0;
  /** Degrees. */
  roll = 0;
  yaw = 0;
  pitch = 0;

  private bobPhase = 0;

  /** Cycles completed, wrapped to [0,1). Exposed because it is the invariant worth testing. */
  get phaseTurns(): number {
    return this.bobPhase;
  }

  private amplitude = 0;
  private config: WeaponBobConfig;

  constructor(config: WeaponBobConfig = DEFAULT_WEAPON_BOB) {
    this.config = config;
  }

  setConfig(config: WeaponBobConfig): void {
    this.config = config;
  }

  reset(): void {
    this.bobPhase = 0;
    this.amplitude = 0;
    this.offsetX = 0;
    this.offsetY = 0;
    this.offsetZ = 0;
    this.roll = 0;
    this.yaw = 0;
    this.pitch = 0;
  }

  /**
   * Advance one frame.
   *
   * `grounded` zeroes the target amplitude rather than the output, so a player who jumps
   * mid-stride has the bob settle out over its own fade instead of cutting on the frame
   * their feet leave the ground.
   */
  update(
    deltaSeconds: number,
    planarSpeedMetresPerSecond: number,
    grounded: boolean,
    adsProgress = 0
  ): void {
    if (deltaSeconds <= 0) return;
    const config = this.config;
    const speed = Math.max(0, planarSpeedMetresPerSecond);

    // Gait is a function of SPEED alone, deliberately not of the sprint key. Stride length
    // is physical: moving at 5 m/s is a 5 m/s gait whichever input produced it, and Doom 3
    // only appears to key off state because its speed and its bob rate change together.
    // Driving it from the flag also cannot work — an earlier attempt to have the flag bias
    // a speed-derived gait wrote `max(g, g * blend)`, which can never exceed `g`, so the
    // input silently did nothing. Sprinting still bobs harder, via the speed it produces.
    const blended = clamp01(
      (speed - config.walkSpeedMetresPerSecond) /
        Math.max(0.01, config.sprintSpeedMetresPerSecond - config.walkSpeedMetresPerSecond)
    );

    let metresPerCycle = lerp(config.walk.metresPerCycle, config.sprint.metresPerCycle, blended);
    // Cadence clamp, applied by stretching the stride rather than by touching speed. Two
    // footfalls per cycle, so the bounds halve into cycles.
    const stepsPerSecond = (speed / Math.max(0.01, metresPerCycle)) * 2;
    if (stepsPerSecond > config.maxStepsPerSecond) {
      metresPerCycle = (speed * 2) / config.maxStepsPerSecond;
    } else if (stepsPerSecond < config.minStepsPerSecond && speed > 0.05) {
      metresPerCycle = (speed * 2) / config.minStepsPerSecond;
    }
    this.bobPhase = (this.bobPhase + (speed * deltaSeconds) / metresPerCycle) % 1;

    const reach = clamp01(speed / Math.max(0.01, config.walkSpeedMetresPerSecond));
    const aimed = lerp(1, config.adsScale, clamp01(adsProgress));
    // The floor is for a player CREEPING, not one standing still. Applying it
    // unconditionally left a stationary player bobbing at 35% for ever — Quake III never
    // hits that case because a stopped player's cycle does not advance either way.
    const moving = speed > 0.05;
    const target = grounded && moving ? Math.max(config.minAmplitudeScale, reach) * aimed : 0;
    this.amplitude = damp(this.amplitude, target, config.amplitudeResponse, deltaSeconds);

    const radians = this.bobPhase * Math.PI * 2;
    const lateralWave = Math.sin(radians);
    // UNRECTIFIED `sin 2θ`, and the distinction is not cosmetic. Rectification already
    // doubles frequency, so `|sin 2θ|` runs at FOUR times the stride rate rather than two
    // and carries a cusp at every footfall — together they read as fast, snappy, tiny
    // steps. Unrectified is also what makes a figure eight at all: `|sin|` never goes
    // negative, so the weapon would only ever rise.
    const verticalWave = Math.sin(radians * 2);
    const weight = lerp(config.walk.weight, config.sprint.weight, blended);
    const of = (walk: number, sprint: number) =>
      lerp(walk, sprint, blended) * this.amplitude * weight;

    this.offsetX = lateralWave * of(config.walk.lateralMetres, config.sprint.lateralMetres);
    this.offsetY = verticalWave * of(config.walk.verticalMetres, config.sprint.verticalMetres);
    this.offsetZ = verticalWave * of(config.walk.forwardMetres, config.sprint.forwardMetres);
    this.roll = lateralWave * of(config.walk.rollDegrees, config.sprint.rollDegrees);
    this.yaw = lateralWave * of(config.walk.yawDegrees, config.sprint.yawDegrees);
    this.pitch = verticalWave * of(config.walk.pitchDegrees, config.sprint.pitchDegrees);

    // Written straight out, never through a follow filter. Shipped engines keep the two
    // mechanisms apart — Source computes look lag FIRST and then adds bob on top, and
    // DarkPlaces puts them behind separate cvars entirely. A filter exists to manufacture
    // lag from an input you do not control, the mouse; the bob is already exactly the
    // motion you want, so filtering it can only damage it. Measured here: a follow rate of
    // 12 passed 75% of the lateral and 27% of the vertical, which does not attenuate the
    // figure so much as deform it into a squashed, skewed different one. The lag that
    // makes a filter tempting belongs to `lookLag` in the host, and lives there.
  }
}
