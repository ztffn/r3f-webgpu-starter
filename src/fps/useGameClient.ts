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
import {
  ColyseusClientTransport,
  type ColyseusJoinOptions,
} from "../net/ColyseusTransport.ts";
import { getToken } from "../account/accountClient.ts";
import { createMotorWorld } from "../motor/MotorWorld.ts";
import { useRapier } from "./useRapier.ts";

/** `?server=` override, following the diagnostic-URL convention. */
function readServerUrl(): string {
  const raw = new URLSearchParams(window.location.search).get("server");
  return raw !== null && raw.length > 0 ? raw : "ws://localhost:2567";
}

/**
 * How this client should get into a room, from the URL.
 *
 * The lobby navigates to /play with these already set, so the game does not need
 * to know the lobby exists: `&room=` for a specific room (a join code has already
 * been resolved to one), `&private=1` to host a new one, `&input=touch` to match
 * in the touch queue.
 */
function readJoinOptions(): ColyseusJoinOptions {
  const params = new URLSearchParams(window.location.search);
  const input = params.get("input");
  return {
    // Whatever session the site established. Absent is fine — the room lets an
    // unidentified client play, it just cannot credit the session to anyone.
    token: getToken(),
    roomId: params.get("room"),
    createPrivate: params.get("private") === "1",
    inputClass: input === "touch" ? "touch" : "desktop",
    label: params.get("label"),
  };
}

export function useGameClient(
  enabled: boolean,
  heightfield: Heightfield | null
): GameClient | null {
  const rapier = useRapier(enabled);
  const [client, setClient] = useState<GameClient | null>(null);
  useEffect(() => {
    if (!enabled || rapier === null || heightfield === null) return;
    const transport = new ColyseusClientTransport(readServerUrl(), readJoinOptions());
    const created = new GameClient(rapier, createMotorWorld(rapier), heightfield, transport);
    setClient(created);
    return () => {
      setClient(null);
      created.dispose();
    };
  }, [enabled, rapier, heightfield]);

  return client;
}
