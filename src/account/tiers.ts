// Membership tiers and what each one grants.
//
// One table, because it is read by three consumers that must not disagree: the
// supporter page renders it, the entitlement check gates features on it, and the
// server grants it. A perk described on the page that no gate enforces is the
// failure this shape prevents.
//
// The hard rule encoded here: no purchasable perk may touch concealment,
// ballistics or visibility (docs/00 pillars). Every `PERKS` entry is therefore
// social, cosmetic or administrative — never a combat capability.

/** Wire identity for a tier. Append-only: stored on accounts. */
export type TierId = "guest" | "enlisted" | "supporter";

/**
 * Capability keys a feature can gate on.
 *
 * Names describe the capability, not the tier that happens to grant it today, so
 * moving a perk between tiers is a table edit rather than a search for string
 * literals across the app.
 */
export type Capability =
  | "persistentName"
  | "medals"
  | "careerStats"
  | "savedLoadouts"
  | "friends"
  | "joinPrivateGame"
  | "hostPrivateGame"
  | "foundClan"
  | "hostCommunityServer"
  | "reservedSlot"
  | "customInsignia"
  | "earlyAccessMaps"
  | "supporterMarker";

export interface Tier {
  id: TierId;
  name: string;
  /** Monthly price in minor units (cents). 0 means free. */
  priceMinor: number;
  currency: "USD";
  /** One line on what this tier is for. */
  summary: string;
  /** Everything this tier can do, including what it inherits from below. */
  capabilities: readonly Capability[];
}

const ENLISTED_CAPABILITIES = [
  "persistentName",
  "medals",
  "careerStats",
  "savedLoadouts",
  "friends",
  "joinPrivateGame",
] as const;

export const TIERS: readonly Tier[] = [
  {
    id: "guest",
    name: "Guest",
    priceMinor: 0,
    currency: "USD",
    summary: "One click into a live match. Nothing asked for, nothing kept.",
    capabilities: [],
  },
  {
    id: "enlisted",
    name: "Enlisted",
    priceMinor: 0,
    currency: "USD",
    summary: "A free account. Your name, your record and your loadouts persist.",
    capabilities: ENLISTED_CAPABILITIES,
  },
  {
    id: "supporter",
    name: "Supporter",
    priceMinor: 500,
    currency: "USD",
    summary: "Run part of this community — clans, servers, your own insignia.",
    capabilities: [
      ...ENLISTED_CAPABILITIES,
      "hostPrivateGame",
      "foundClan",
      "hostCommunityServer",
      "reservedSlot",
      "customInsignia",
      "earlyAccessMaps",
      "supporterMarker",
    ],
  },
] as const;

/** Human-readable label for each capability, used by the supporter page. */
export const CAPABILITY_LABELS: Record<Capability, string> = {
  persistentName: "A name that persists between sessions",
  medals: "Medals and ribbons on your profile",
  careerStats: "Career statistics across every match",
  savedLoadouts: "Saved weapon loadouts",
  friends: "Friends list and squad invites",
  joinPrivateGame: "Join private matches by invite code",
  hostPrivateGame: "Host private matches for your friends",
  foundClan: "Found and administer a clan",
  hostCommunityServer: "Run a community server listed in the public browser",
  reservedSlot: "A reserved slot on your own server",
  customInsignia: "Custom clan insignia and unit patch",
  earlyAccessMaps: "New maps and terrain a week before everyone else",
  supporterMarker: "Supporter marker on your profile",
};

export function tierById(id: TierId): Tier {
  const found = TIERS.find((tier) => tier.id === id);
  if (found === undefined) throw new Error(`unknown tier: ${id}`);
  return found;
}

/** Does this tier grant that capability? The single gate every feature calls. */
export function can(tier: TierId, capability: Capability): boolean {
  return tierById(tier).capabilities.includes(capability);
}

/** "$5 / month", or "Free". Formatting lives here so every surface agrees. */
export function formatPrice(tier: Tier): string {
  if (tier.priceMinor === 0) return "Free";
  const major = tier.priceMinor / 100;
  const amount = Number.isInteger(major) ? major.toFixed(0) : major.toFixed(2);
  return `$${amount}`;
}
