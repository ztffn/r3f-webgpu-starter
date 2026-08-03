// React lifetime for the networked GameClient.
//
// Owned by an EFFECT, never a memo: a memo result from a discarded render has
// no cleanup hook, and while a leaked MotorRoom is just WASM memory, a leaked
// Colyseus join is a ghost player everyone else can see. The transport's own
// close-during-join handling covers the HMR construct -> close -> construct
// sequence; this hook guarantees dispose() runs for every client constructed.
// Lives in src/fps because it imports React; src/net stays React-free.

import { useEffect, useState } from "react";
import type { Heightfield } from "../df2/Heightfield.ts";
import { GameClient } from "../net/GameClient.ts";
import { ColyseusClientTransport } from "../net/ColyseusTransport.ts";
import { createMotorWorld } from "../motor/MotorWorld.ts";
import { useRapier } from "./useRapier.ts";

/** `?server=` override, following the diagnostic-URL convention. */
function readServerUrl(): string {
  const raw = new URLSearchParams(window.location.search).get("server");
  return raw !== null && raw.length > 0 ? raw : "ws://localhost:2567";
}

export function useGameClient(
  enabled: boolean,
  heightfield: Heightfield | null
): GameClient | null {
  const rapier = useRapier(enabled);
  const [client, setClient] = useState<GameClient | null>(null);
  useEffect(() => {
    if (!enabled || rapier === null || heightfield === null) return;
    const transport = new ColyseusClientTransport(readServerUrl());
    const created = new GameClient(rapier, createMotorWorld(rapier), heightfield, transport);
    setClient(created);
    return () => {
      setClient(null);
      created.dispose();
    };
  }, [enabled, rapier, heightfield]);

  return client;
}
