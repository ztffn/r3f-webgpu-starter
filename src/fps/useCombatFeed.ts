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

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { GameClient } from "../net/GameClient.ts";
import { weaponByWireIndex } from "../combat/weaponDefinitions.ts";

/** Shared so a null client subscribes to something stable rather than a new closure. */
const NO_SUBSCRIPTION = (): (() => void) => () => {};

/** How many feed lines the panel shows. The mockup's chat block fits four. */
const FEED_LINES = 4;
/**
 * How long a line stays up.
 *
 * The feed is a notification, not a log: a kill from ten minutes ago sitting on
 * screen in a quiet match reads as a frozen HUD. Long enough to catch a line you
 * glanced away from, short enough that the panel is usually empty.
 */
const FEED_LINE_SECONDS = 8;

export interface FeedLine {
  /** The event's own sequence — stable, so React keys never collide. */
  readonly id: number;
  readonly kind: "kill" | "join" | "leave";
  readonly text: string;
}

export interface LocalDeath {
  /** Who did it, already resolved to a name. Null for a death nobody caused. */
  readonly killerName: string | null;
  /**
   * Wall-clock milliseconds at which the server said the respawn lands, or
   * null when the room has respawn disabled — a countdown to a moment that
   * will never come must not render as one.
   */
  readonly respawnAtMs: number | null;
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
    known: ReadonlyMap<number, string>;
    lines: readonly FeedLine[];
    seeded: boolean;
  }>({ known: new Map(), lines: [], seeded: false });

  useEffect(() => {
    if (roster === null) return;
    setMembership((previous) => {
      // A MAP rather than a set of ids: the leaver is by definition absent from
      // the new roster, so their name has to come from the one they left.
      const now = new Map(roster.map((entry) => [entry.id, entry.name]));
      if (!previous.seeded) return { known: now, lines: [], seeded: true };
      const lines: FeedLine[] = [];
      for (const entry of roster) {
        if (!previous.known.has(entry.id)) {
          lines.push({ id: -entry.id * 2, kind: "join", text: `${entry.name} joined` });
        }
      }
      for (const [id, name] of previous.known) {
        if (!now.has(id)) lines.push({ id: -id * 2 - 1, kind: "leave", text: `${name} left` });
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

  // Events carry no timestamp — the wire has no reason to spend bytes on one — so
  // a line is aged from when this client first SAW it. Ids are stable, so a line
  // cannot be re-stamped by a later render and live forever.
  const firstSeen = useRef(new Map<number, number>());
  const [expiryTick, setExpiryTick] = useState(0);
  const onExpiryTick = useCallback(() => setExpiryTick((n) => n + 1), []);

  // The local death, anchored ONCE per death event. It must live outside the
  // memo below for two reasons that both bit in practice: the memo re-runs on
  // every expiry tick, and stamping `Date.now()` inside it re-anchored the
  // respawn countdown every second — the overlay oscillated in the 4–5 s band
  // and never reached zero. And the event ring is bounded (MAX_COMBAT_EVENTS),
  // so a busy room can evict the died event mid-death; the cache keeps the
  // overlay's data alive until health returns, which is the only thing that
  // clears the overlay anyway (GameHud gates on health, never on this).
  const deathAnchor = useRef<{ clientId: number; seq: number; death: LocalDeath } | null>(
    null
  );

  const localId = client?.playerId ?? 0;

  const shaped = useMemo(() => {
    if (client === null || events === null) return EMPTY_COMBAT_FEED;

    const kills: FeedLine[] = [];
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
        if (
          event.victimId === localId &&
          (deathAnchor.current === null ||
            deathAnchor.current.clientId !== localId ||
            deathAnchor.current.seq !== event.seq)
        ) {
          deathAnchor.current = {
            clientId: localId,
            seq: event.seq,
            death: {
              killerName: event.killerId === 0 ? null : nameOf(event.killerId),
              // Anchored when the packet is FIRST read rather than to a server
              // tick: the countdown only has to look right, and the authority
              // still owns the actual respawn. Zero means respawn is disabled.
              respawnAtMs:
                event.respawnSeconds > 0
                  ? Date.now() + event.respawnSeconds * 1000
                  : null,
            },
          };
        }
      } else if (event.kind === "damage") {
        damage = { seq: event.seq, bearingRadians: event.bearingRadians };
      } else {
        hit = { seq: event.seq, fatal: event.fatal };
      }
    }

    const death =
      deathAnchor.current !== null && deathAnchor.current.clientId === localId
        ? deathAnchor.current.death
        : null;

    const now = Date.now();
    const fresh: FeedLine[] = [];
    const candidates = new Set<number>();
    for (const line of [...membership.lines, ...kills]) {
      candidates.add(line.id);
      let seen = firstSeen.current.get(line.id);
      if (seen === undefined) {
        seen = now;
        firstSeen.current.set(line.id, seen);
      }
      if (now - seen < FEED_LINE_SECONDS * 1000) fresh.push(line);
    }
    // Stamps whose line has left the ring and the membership log are dropped, or
    // a long session grows one map entry per line ever seen. Only DEPARTED ids —
    // a stamp still in candidates must survive, or an expired line still sitting
    // in the bounded ring would be re-stamped fresh and resurrect. Ids never
    // recur (event seqs and connection ids both only increase), so departed
    // means gone for good.
    for (const id of firstSeen.current.keys()) {
      if (!candidates.has(id)) firstSeen.current.delete(id);
    }

    return {
      lines: fresh.slice(-FEED_LINES),
      // The overlay is cleared the moment health returns, which the CALLER
      // decides — this value carries only who and when, never aliveness.
      death,
      damage,
      hit,
    };
  }, [client, events, localId, membership.lines, nameOf, expiryTick]);

  useFeedExpiry(shaped.lines.length > 0, onExpiryTick);
  return shaped;
}

/**
 * Seconds left on a respawn, ticking, or null when alive.
 *
 * Its own hook because it is the only thing here that needs a timer: everything
 * else re-renders when a packet arrives, and a countdown has to move between
 * them. Runs only while dead.
 */
/**
 * Re-renders while any feed line is still within its lifetime.
 *
 * Its own effect because expiry is the only thing here that happens without a
 * packet arriving. It stops as soon as the feed is empty, so a quiet match pays
 * nothing.
 */
function useFeedExpiry(hasLines: boolean, tick: () => void): void {
  useEffect(() => {
    if (!hasLines) return;
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [hasLines, tick]);
}

export function useRespawnCountdown(death: LocalDeath | null): number | null {
  const [, setNow] = useState(0);
  useEffect(() => {
    // No timer when there is nothing to count to — a respawn-disabled room's
    // death carries no deadline.
    if (death === null || death.respawnAtMs === null) return;
    const timer = setInterval(() => setNow((tick) => tick + 1), 200);
    return () => clearInterval(timer);
  }, [death]);
  if (death === null || death.respawnAtMs === null) return null;
  return Math.max(0, (death.respawnAtMs - Date.now()) / 1000);
}
