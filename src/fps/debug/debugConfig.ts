export interface FpsDebugConfig {
  readonly shotTrajectory: boolean;
  readonly impactTest: boolean;
}

function parse(): FpsDebugConfig {
  if (typeof window === "undefined") return { shotTrajectory: false, impactTest: false };
  const query = new URLSearchParams(window.location.search);
  return {
    shotTrajectory: query.get("shotdebug") === "1",
    impactTest: query.get("impacttest") === "1",
  };
}

export const FPS_DEBUG: FpsDebugConfig = parse();
