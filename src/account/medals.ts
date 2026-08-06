// The medal catalogue, and the only rule that awards one.
//
// Shared and pure: the profile page renders this table and the server evaluates
// it, so a medal cannot be described one way and awarded another. Medals come
// ONLY from play and can never be bought (design record §6) — that is the line
// that keeps the supporter tier from reading as pay-to-win, so nothing here reads
// a tier and nothing here is grantable.
//
// `earnable` is load-bearing, not decorative: it is what stops a medal being
// awarded from a statistic nothing writes yet.

import type { Career } from "./accountTypes.ts";

/** Wire identity. Append-only: these are stored on the `medals` table. */
export type MedalId =
  | "first-deployment"
  | "veteran-10"
  | "veteran-50"
  | "hours-1"
  | "hours-10"
  | "first-blood"
  | "centurion"
  | "marksman-500"
  | "marksman-1000";

export interface Medal {
  id: MedalId;
  name: string;
  /** What it is, in one line. Shown under the name. */
  description: string;
  /** How it is earned, in words, so a locked medal is worth chasing. */
  requirement: string;
  /**
   * Whether anything currently WRITES the statistic this medal reads.
   *
   * False for every combat medal: kills, deaths and longest shot are not
   * recorded until the server-authoritative damage work lands, and a medal
   * evaluated against a column that is always zero would either never fire or,
   * worse, fire wrongly the day something starts writing it half-correctly. The
   * same honesty the leaderboards use for `populated` — an unearnable medal says
   * so rather than looking like one nobody has managed.
   */
  earnable: boolean;
  /**
   * Does this career qualify?
   *
   * The server's ONLY award rule, which is why it lives beside the description
   * rather than in the repository: a medal whose requirement text and whose test
   * are in different files is a medal that will eventually claim one thing and
   * check another.
   */
  qualifies: (career: Career) => boolean;
}

const HOUR_SECONDS = 3600;

export const MEDALS: readonly Medal[] = [
  {
    id: "first-deployment",
    name: "First Deployment",
    description: "You went out once.",
    requirement: "Finish a single match.",
    earnable: true,
    qualifies: (career) => career.matches >= 1,
  },
  {
    id: "veteran-10",
    name: "Ten Deep",
    description: "Ten matches behind you.",
    requirement: "Finish 10 matches.",
    earnable: true,
    qualifies: (career) => career.matches >= 10,
  },
  {
    id: "veteran-50",
    name: "Old Hand",
    description: "Fifty matches behind you.",
    requirement: "Finish 50 matches.",
    earnable: true,
    qualifies: (career) => career.matches >= 50,
  },
  {
    id: "hours-1",
    name: "An Hour in the Grass",
    description: "One hour on the ground.",
    requirement: "Play for one hour in total.",
    earnable: true,
    qualifies: (career) => career.timePlayedSeconds >= HOUR_SECONDS,
  },
  {
    id: "hours-10",
    name: "Ten Hours Down",
    description: "Ten hours on the ground.",
    requirement: "Play for ten hours in total.",
    earnable: true,
    qualifies: (career) => career.timePlayedSeconds >= 10 * HOUR_SECONDS,
  },

  // Combat. Defined so the catalogue is honest about what the game is FOR, and
  // unearnable until feat/server-ballistics writes kills and longest shot.
  {
    id: "first-blood",
    name: "First Blood",
    description: "Your first confirmed kill.",
    requirement: "Record a kill.",
    earnable: false,
    qualifies: (career) => career.kills >= 1,
  },
  {
    id: "centurion",
    name: "Centurion",
    description: "A hundred confirmed.",
    requirement: "Record 100 kills.",
    earnable: false,
    qualifies: (career) => career.kills >= 100,
  },
  {
    id: "marksman-500",
    name: "Five Hundred",
    description: "A shot most people never take.",
    requirement: "Land a shot from 500 metres.",
    earnable: false,
    qualifies: (career) => career.longestShotMetres >= 500,
  },
  {
    id: "marksman-1000",
    name: "The Kilometre",
    description: "The shot this game exists for.",
    requirement: "Land a shot from 1000 metres.",
    earnable: false,
    qualifies: (career) => career.longestShotMetres >= 1000,
  },
];

export function medalById(id: string): Medal | undefined {
  return MEDALS.find((medal) => medal.id === id);
}

/**
 * Every medal this career has earned.
 *
 * The `earnable` guard is checked FIRST and is not redundant: a combat medal's
 * test reads a column that is currently always zero, but the day something starts
 * writing it partially — a client-reported kill, a half-finished migration — the
 * flag is what stops medals being handed out from a number nobody trusts yet.
 * Flipping a medal on is one boolean, and that is deliberately the whole change.
 */
export function earnedMedals(career: Career): MedalId[] {
  return MEDALS.filter((medal) => medal.earnable && medal.qualifies(career)).map(
    (medal) => medal.id
  );
}
