// Combat events and the roster, shaped for the HUD.
//
// The third crossing from src/net into React, after useRoomVisuals and
// usePlayerVitals, and the same shape: GameClient exposes subscribe/getSnapshot
// pairs, this adapts them with useSyncExternalStore. Lives in src/fps because it
// imports React; src/net stays React-free.
//
// It derives rather than stores. Feed lines, the local player's death and the
// latest damage are all read out of the event log the client already holds, so
// there is no second copy to fall out of step with it.

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { GameClient } from "../net/GameClient.ts";
import { weaponByWireIndex } from "../combat/weaponDefinitions.ts";

/** Shared so a null client subscribes to something stable rather than a new closure. */
const NO_SUBSCRIPTION = (): (() => void) => () => {};

/** How many feed lines the panel shows. The mockup's chat block fits four. */
const FEED_LINES = 4;

export interface FeedLine {
  /** The event's own sequence — stable, so React keys never collide. */
  readonly id: number;
  readonly kind: "kill" | "join" | "leave";
  readonly text: string;
}

export interface LocalDeath {
  /** Who did it, already resolved to a name. Null for a death nobody caused. */
  readonly killerName: string | null;
  /** Wall-clock milliseconds at which the server said the respawn lands. */
  readonly respawnAtMs: number;
}

export interface CombatFeed {
  readonly lines: readonly FeedLine[];
  /** The LOCAL player's death, or null while alive. Drives the overlay. */
  readonly death: LocalDeath | null;
  /** Most recent round to land on the local player. Keyed by seq for animation. */
  readonly damage: { readonly seq: number; readonly bearingRadians: number } | null;
  /** Most recent confirmation that the local player's own round landed. */
  readonly hit: { readonly seq: number; readonly fatal: boolean } | null;
}

/**
 * The offline shape. Exported so the HUD's host can hold it as initial state
 * without inventing a second empty that might not stay in step with this one.
 */
export const EMPTY_COMBAT_FEED: CombatFeed = {
  lines: [],
  death: null,
  damage: null,
  hit: null,
};

export function useCombatFeed(client: GameClient | null): CombatFeed {
  const subscribeEvents = client?.subscribeCombatEvents ?? NO_SUBSCRIPTION;
  const events = useSyncExternalStore(
    subscribeEvents,
    () => client?.getCombatEvents() ?? null
  );
  const subscribeRoster = client?.subscribeRoster ?? NO_SUBSCRIPTION;
  const roster = useSyncExternalStore(subscribeRoster, () => client?.getRoster() ?? null);

  // Names come from the roster, so a feed line reads "Ada killed Bree" rather
  // than a pair of numbers. An id the roster has not mentioned falls back to the
  // numeric form instead of rendering "undefined".
  const nameOf = useMemo(() => {
    const names = new Map((roster ?? []).map((entry) => [entry.id, entry.name]));
    return (id: number): string => names.get(id) ?? `Player ${id}`;
  }, [roster]);

  // Joins and leaves are a DIFF of successive rosters rather than their own
  // events: the roster is already sent whole on every change, so one packet does
  // the work of three. The first roster is a baseline, or joining a running match
  // would print the whole room walking in at once.
  const [membership, setMembership] = useState<{
    known: ReadonlySet<number>;
    lines: readonly FeedLine[];
    seeded: boolean;
  }>({ known: new Set(), lines: [], seeded: false });

  useEffect(() => {
    if (roster === null) return;
    setMembership((previous) => {
      const now = new Set(roster.map((entry) => entry.id));
      if (!previous.seeded) return { known: now, lines: [], seeded: true };
      const lines: FeedLine[] = [];
      for (const entry of roster) {
        if (!previous.known.has(entry.id)) {
          lines.push({ id: -entry.id * 2, kind: "join", text: `${entry.name} joined` });
        }
      }
      for (const id of previous.known) {
        if (!now.has(id)) lines.push({ id: -id * 2 - 1, kind: "leave", text: `Player ${id} left` });
      }
      if (lines.length === 0) return { ...previous, known: now };
      return {
        known: now,
        // Negative ids for membership lines so they cannot collide with an
        // event's sequence, which is what keys the kill lines.
        lines: [...previous.lines, ...lines].slice(-FEED_LINES),
        seeded: true,
      };
    });
  }, [roster]);

  const localId = client?.playerId ?? 0;

  return useMemo(() => {
    if (client === null || events === null) return EMPTY_COMBAT_FEED;

    const kills: FeedLine[] = [];
    let death: LocalDeath | null = null;
    let damage: CombatFeed["damage"] = null;
    let hit: CombatFeed["hit"] = null;

    for (const event of events) {
      if (event.kind === "died") {
        const weapon = weaponByWireIndex(event.weaponIndex);
        kills.push({
          id: event.seq,
          kind: "kill",
          text:
            event.killerId === 0
              ? `${nameOf(event.victimId)} died`
              : `${nameOf(event.killerId)} killed ${nameOf(event.victimId)}` +
                (weapon === null ? "" : ` — ${weapon.displayName}`),
        });
        if (event.victimId === localId) {
          death = {
            killerName: event.killerId === 0 ? null : nameOf(event.killerId),
            // Anchored when the packet is read rather than to a server tick: the
            // countdown only has to look right, and the authority still owns the
            // actual respawn.
            respawnAtMs: Date.now() + event.respawnSeconds * 1000,
          };
        }
      } else if (event.kind === "damage") {
        damage = { seq: event.seq, bearingRadians: event.bearingRadians };
      } else {
        hit = { seq: event.seq, fatal: event.fatal };
      }
    }

    return {
      lines: [...membership.lines, ...kills].slice(-FEED_LINES),
      // Cleared the moment health returns, which the caller decides — a stale
      // overlay outliving a respawn is worse than none.
      death,
      damage,
      hit,
    };
  }, [client, events, localId, membership.lines, nameOf]);
}

/**
 * Seconds left on a respawn, ticking, or null when alive.
 *
 * Its own hook because it is the only thing here that needs a timer: everything
 * else re-renders when a packet arrives, and a countdown has to move between
 * them. Runs only while dead.
 */
export function useRespawnCountdown(death: LocalDeath | null): number | null {
  const [, setNow] = useState(0);
  useEffect(() => {
    if (death === null) return;
    const timer = setInterval(() => setNow((tick) => tick + 1), 200);
    return () => clearInterval(timer);
  }, [death]);
  if (death === null) return null;
  return Math.max(0, (death.respawnAtMs - Date.now()) / 1000);
}
