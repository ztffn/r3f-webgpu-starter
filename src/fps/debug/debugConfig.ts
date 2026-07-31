export interface FpsDebugConfig {
  readonly shotTrajectory: boolean;
}

function parse(): FpsDebugConfig {
  if (typeof window === "undefined") return { shotTrajectory: false };
  const query = new URLSearchParams(window.location.search);
  return { shotTrajectory: query.get("shotdebug") === "1" };
}

export const FPS_DEBUG: FpsDebugConfig = parse();
