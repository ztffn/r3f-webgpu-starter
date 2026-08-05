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
import type { RoomInfo } from "../net/ColyseusProtocol.ts";
import { createMotorWorld } from "../motor/MotorWorld.ts";
import { useRapier } from "./useRapier.ts";

/**
 * `?server=` override, following the diagnostic-URL convention.
 *
 * The default is no longer a literal localhost: net play is now what a bare
 * /play runs, so the guess has to be right in every environment. The Vite dev
 * server (:3000) proxies /auth and /api to the game server but not the game
 * WebSocket, so dev targets the game server's own port on whatever host the
 * page came from — which also covers a phone on the LAN. Anywhere else, the
 * VPS serves client and Colyseus from one origin (design record §5.2/deploy),
 * so same origin is the answer.
 */
function readServerUrl(): string {
  const raw = new URLSearchParams(window.location.search).get("server");
  if (raw !== null && raw.length > 0) return raw;
  const { protocol, hostname, host, port } = window.location;
  const ws = protocol === "https:" ? "wss:" : "ws:";
  if (port === "3000" || hostname === "localhost" || hostname === "127.0.0.1") {
    return `${ws}//${hostname}:2567`;
  }
  return `${ws}//${host}`;
}

/**
 * How this client should get into a room, from the URL.
 *
 * The lobby navigates to /play with these already set, so the game does not need
 * to know the lobby exists: `&room=` for a specific room (a join code, or a
 * private game the server just created, has already been resolved to one), and
 * `&input=touch` to match in the touch queue.
 *
 * There is deliberately NO "host a private game" parameter. Hosting one is a
 * supporter capability, and a URL the client controls cannot check a capability —
 * the room is created by POST /api/private-game, which can, and the client
 * arrives here with `&room=` like any other join.
 */
function readJoinOptions(): ColyseusJoinOptions {
  const params = new URLSearchParams(window.location.search);
  const input = params.get("input");
  return {
    // Whatever session the site established. Absent is fine — the room lets an
    // unidentified client play, it just cannot credit the session to anyone.
    token: getToken(),
    roomId: params.get("room"),
    inputClass: input === "touch" ? "touch" : "desktop",
    label: params.get("label"),
  };
}

export interface NetworkedGame {
  client: GameClient | null;
  /**
   * What the room told us about itself — currently the private join code.
   *
   * Returned alongside the client rather than hung off it, because GameClient is
   * transport-agnostic and knows nothing about Colyseus rooms. The concrete
   * transport carries it and this hook is the one place that has both.
   */
  roomInfo: RoomInfo | null;
}

export function useGameClient(
  enabled: boolean,
  heightfield: Heightfield | null
): NetworkedGame {
  const rapier = useRapier(enabled);
  const [client, setClient] = useState<GameClient | null>(null);
  const [roomInfo, setRoomInfo] = useState<RoomInfo | null>(null);
  useEffect(() => {
    if (!enabled || rapier === null || heightfield === null) return;
    const transport = new ColyseusClientTransport(readServerUrl(), readJoinOptions());
    // Subscribed before the join can resolve; the transport replays a message that
    // arrived first, so the ordering cannot lose it either way.
    transport.onRoomInfo(setRoomInfo);
    const created = new GameClient(rapier, createMotorWorld(rapier), heightfield, transport);
    setClient(created);
    return () => {
      setClient(null);
      setRoomInfo(null);
      created.dispose();
    };
  }, [enabled, rapier, heightfield]);

  return { client, roomInfo };
}
