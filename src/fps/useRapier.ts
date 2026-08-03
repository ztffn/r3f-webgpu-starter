// React lifetime for the Rapier WASM module.
//
// One alive-guarded initRapier-into-state effect, shared by every component
// that needs the physics module. The underlying load is an idempotent
// singleton, so concurrent users await the same promise and pay once.
// `enabled` false keeps the hook dormant (rapier stays null) for hosts that
// only sometimes own a simulation.

import { useEffect, useState } from "react";
import type RAPIER from "@dimforge/rapier3d-compat";
import { initRapier } from "../motor/MotorWorld.ts";

export function useRapier(enabled: boolean): typeof RAPIER | null {
  const [rapier, setRapier] = useState<typeof RAPIER | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    void initRapier().then((loaded) => {
      if (alive) setRapier(loaded);
    });
    return () => {
      alive = false;
    };
  }, [enabled]);
  return rapier;
}
