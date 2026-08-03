// The room's authoritative visuals, as a React value: preset, dial overrides, and
// whether this client may change them.
//
// The only place room state crosses from src/net into the render tree, which is what
// keeps Colyseus invisible above the transport seam. GameClient exposes the
// subscribe/getSnapshot pair CombatTelemetry established, so this is one
// useSyncExternalStore call rather than an effect mirroring into local state — no
// seeding dance, and any number of readers can subscribe without displacing each
// other. Lives in src/fps because it imports React; src/net stays React-free.

import { useCallback, useMemo, useSyncExternalStore } from "react";
import type { GameClient } from "../net/GameClient.ts";
import { weatherPresetAt, type WeatherPreset } from "../df2/weather";

export interface RoomVisuals {
  /** The room's weather. The shared preset instance, so its identity is stable. */
  readonly preset: WeatherPreset;
  /** The server accepts dial changes from this client. False for an ordinary player. */
  readonly dialsAllowed: boolean;
  /** Sparse dial overrides on top of the preset. Never mutated, so safe to hold. */
  readonly overrides: ReadonlyMap<number, number>;
  /** Asks the server for a change. Refused writes simply never come back. */
  readonly setDial: (id: number, value: number) => void;
}

/** Shared so a null client subscribes to something stable rather than a new closure. */
const NO_SUBSCRIPTION = (): (() => void) => () => {};

/**
 * Null when there is no networked client, or before the room has said anything —
 * the caller keeps its own weather and writes its own uniforms until then, rather
 * than flashing a default.
 */
export function useRoomVisuals(client: GameClient | null): RoomVisuals | null {
  const subscribe = client?.subscribeRoomState ?? NO_SUBSCRIPTION;
  const getSnapshot = useCallback(() => client?.getRoomState() ?? null, [client]);
  const state = useSyncExternalStore(subscribe, getSnapshot);

  // Derived, so the returned identity changes exactly when the packet did — which
  // is what lets DF2Scene list this as an effect dependency without re-running per
  // frame, and what keeps the panel's memo meaningful between changes.
  return useMemo(
    () =>
      state === null || client === null
        ? null
        : {
            preset: weatherPresetAt(state.weatherIndex),
            dialsAllowed: state.clientDialsAllowed,
            overrides: state.dials,
            setDial: client.setVisualDial.bind(client),
          },
    [client, state]
  );
}
