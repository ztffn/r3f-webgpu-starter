// The local player's server-owned hit points, as a React value.
//
// The second place per-player state crosses from src/net into the render tree,
// after useRoomVisuals — same shape, same reasons. GameClient exposes the
// subscribe/getSnapshot pair, so this is one useSyncExternalStore call rather
// than an effect mirroring into local state: no seeding dance, and any number of
// readers can subscribe without displacing each other.
//
// Lives in src/fps because it imports React; src/net stays React-free.

import { useCallback, useSyncExternalStore } from "react";
import type { GameClient } from "../net/GameClient.ts";
import { clamp } from "../combat/math.ts";

/** Shared so a null client subscribes to something stable rather than a new closure. */
const NO_SUBSCRIPTION = (): (() => void) => () => {};

/**
 * Health as a 0–1 fraction, or null when nobody authoritative is reporting it.
 *
 * NULL IS NOT ZERO AND NOT FULL. Offline there is no authority to ask, and the
 * vitals panel draws an empty dashed track for null rather than implying either a
 * dead player or a healthy one — the same rule stamina, hydration and armour
 * follow, and the rule `playerStats` learned the hard way when an absent
 * measurement rendered as a confident number.
 *
 * The denominator is the room's own maximum from the welcome packet, so a server
 * configured with different hit points still reads as a correct fraction.
 */
export function usePlayerVitals(client: GameClient | null): number | null {
  const subscribe = client?.subscribeHealth ?? NO_SUBSCRIPTION;
  // Reads the raw hit points, which is a number — a primitive snapshot cannot
  // trip useSyncExternalStore's identity check the way a fresh object would.
  const getSnapshot = useCallback(() => client?.getHealth() ?? null, [client]);
  const health = useSyncExternalStore(subscribe, getSnapshot);
  // Null until the first snapshot as well as offline. Between joining and that
  // packet nobody has said what the hit points are, and reporting the field's
  // old zero-default would have read as "dead" for the whole window.
  if (client === null || health === null) return null;
  return clamp(health / client.maxHealth, 0, 1);
}
