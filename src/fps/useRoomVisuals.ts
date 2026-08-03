// The room's authoritative visuals, as a React value: preset, dial overrides, and
// whether this client may change them.
//
// ONE hook for the whole world-state family, not one per packet, and that is forced
// rather than tidy: GameClient's callbacks are single-consumer, so two hooks both
// wanting `onWorldState` would silently unsubscribe each other. It is also the right
// shape — the preset is the base layer and the dials override it, so a consumer that
// has one always wants the other.
//
// This is the only place world state crosses from src/net into the render tree, which
// is what keeps Colyseus invisible above the transport seam. Lives in src/fps because
// it imports React; src/net stays React-free.

import { useEffect, useState } from "react";
import type { GameClient } from "../net/GameClient.ts";
import { weatherPresetAt, type WeatherPreset } from "../df2/weather";

export interface RoomVisuals {
  /** The room's weather. The shared preset instance, so its identity is stable. */
  readonly preset: WeatherPreset;
  /** The server accepts dial changes from this client. False for an ordinary player. */
  readonly dialsAllowed: boolean;
  /** Sparse dial overrides on top of the preset. A consumer must not mutate it. */
  readonly overrides: ReadonlyMap<number, number>;
  /** Asks the server for a change. Refused writes simply never come back. */
  readonly setDial: (id: number, value: number) => void;
}

/**
 * Null when there is no networked client, or before the room has said anything —
 * the caller keeps its own weather and writes its own uniforms until then, rather
 * than flashing a default.
 */
export function useRoomVisuals(client: GameClient | null): RoomVisuals | null {
  const [visuals, setVisuals] = useState<RoomVisuals | null>(null);

  useEffect(() => {
    if (client === null) {
      setVisuals(null);
      return;
    }
    const publish = (): void => {
      const state = client.worldState;
      if (state === null) return;
      setVisuals({
        preset: weatherPresetAt(state.weatherIndex),
        dialsAllowed: state.clientDialsAllowed,
        // A NEW MAP EACH TIME, because `client.visualDials` is mutated in place:
        // handing the live map over would give React an unchanged identity on every
        // change, and nothing downstream would re-render.
        overrides: new Map(client.visualDials),
        setDial: (id, value) => client.setVisualDial(id, value),
      });
    };
    // SEED FIRST. World state is sent immediately after the welcome, so it routinely
    // arrives before this effect runs; subscribing without seeding leaves the room's
    // weather unapplied until it next changes, which for a fixed preset is forever.
    publish();
    client.onWorldState = publish;
    client.onVisualDials = publish;
    return () => {
      client.onWorldState = null;
      client.onVisualDials = null;
    };
  }, [client]);

  return visuals;
}
