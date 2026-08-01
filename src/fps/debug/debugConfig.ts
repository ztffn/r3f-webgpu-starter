export interface FpsDebugConfig {
  readonly shotTrajectory: boolean;
  readonly impactTest: boolean;
  readonly weaponAnimations: boolean;
}

function parse(): FpsDebugConfig {
  if (typeof window === "undefined") {
    return { shotTrajectory: false, impactTest: false, weaponAnimations: false };
  }
  const query = new URLSearchParams(window.location.search);
  return {
    shotTrajectory: query.get("shotdebug") === "1",
    impactTest: query.get("impacttest") === "1",
    weaponAnimations: query.get("weaponanim") === "1",
  };
}

export const FPS_DEBUG: FpsDebugConfig = parse();
