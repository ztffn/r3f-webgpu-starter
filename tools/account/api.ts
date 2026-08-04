// The account HTTP API: /api/config, /api/me, /api/me/character, /api/players/:id.
//
// SERVER ONLY. Sits beside @colyseus/auth's own /auth routes rather than inside
// them — the package owns credentials and sessions, this owns everything the game
// wants to know about an account once it has one.
//
// Every authenticated route resolves the token to a LIVE account row rather than
// trusting the token's contents, and every capability check uses the effective
// tier. A request is the only thing that can be trusted here; what the client
// believes about its own tier is not evidence.

import express, { type Request, type Response, type Router } from "express";
import { auth } from "@colyseus/auth";
import { effectiveTier } from "../../src/account/accountTypes.ts";
import { validateCharacter, coerceCharacter } from "../../src/account/characters.ts";
import { TIERS, type TierId } from "../../src/account/tiers.ts";
import { accountOf, requireAccount } from "./authMiddleware.ts";
import type { AccountRepository } from "./repository.ts";

/**
 * Longest a dev tier grant may run, in days. Ten years — far beyond any test and
 * well inside the range a Date can represent.
 */
const MAX_GRANT_DAYS = 3650;

export interface ApiDeps {
  repository: AccountRepository;
  providers: string[];
  /** Whether a real payment provider is wired. Mirrors VITE_CHECKOUT. */
  checkoutEnabled: boolean;
  /**
   * `DF2_ADMIN=1`. Opens the dev-only tier grant below.
   *
   * The same switch the room-wide visual dials use, rather than a second one:
   * both answer "is this a development server somebody is driving", and two
   * variables would eventually be set inconsistently on the box that matters.
   */
  adminEnabled: boolean;
}

export function createApiRouter({
  repository,
  providers,
  checkoutEnabled,
  adminEnabled,
}: ApiDeps): Router {
  const router = express.Router();
  router.use(express.json({ limit: "16kb" }));

  /** Signature verified, then resolved to a live account. Both, or neither. */
  const authenticated = [auth.middleware(), requireAccount(repository)];

  /**
   * What this deployment supports. Public and unauthenticated.
   *
   * The sign-in page needs it to decide whether to offer a Discord button:
   * without this, a provider that is not configured renders as a button that
   * fails on click, which reads as the site being broken rather than the feature
   * being off.
   */
  router.get("/config", (_req: Request, res: Response) => {
    res.json({
      providers,
      checkoutEnabled,
      // So the supporter page can offer the dev grant instead of guessing from a
      // build-time flag. Off in production, where the button must not exist.
      grantEnabled: adminEnabled,
      // No `tiers` here. The table is shared code (src/account/tiers.ts) and the
      // supporter page imports it directly, so sending it was a second copy of
      // the same facts that `ServerConfig` never even declared a field for.
    });
  });

  /** The caller's own account, with everything the profile page needs. */
  router.get("/me", authenticated, async (req: Request, res: Response) => {
    const account = accountOf(req);
    // Not awaited: `last_seen_at` is bookkeeping nothing in this response reads,
    // and the page should not wait a round trip for it. Caught explicitly,
    // because an unhandled rejection takes the server down.
    void repository.touch(account.id).catch((error: unknown) => {
      console.warn(`[api] could not touch account ${account.id}:`, error);
    });
    // Three independent reads, issued together. Serial awaits cost nothing
    // measurable on local SQLite and three round trips each on the Postgres this
    // is meant to run against.
    const [career, medals, character] = await Promise.all([
      repository.career(account.id),
      repository.medals(account.id),
      repository.character(account.id),
    ]);
    res.json({
      account,
      // Resolved here so the client never has to reimplement expiry. A lapsed
      // supporter reads as "enlisted" everywhere, including in the UI that
      // decides which controls to enable.
      effectiveTier: effectiveTier(account.tier, account.tierExpiresAt, new Date()),
      career,
      medals,
      character,
    });
  });

  /** Rename. The only mutable field on an account for now. */
  router.patch("/me", authenticated, async (req: Request, res: Response) => {
    const account = accountOf(req);
    const callsign = (req.body as { callsign?: unknown }).callsign;
    if (typeof callsign !== "string") {
      return void res.status(400).json({ error: "callsign_required" });
    }
    try {
      await repository.setCallsign(account.id, callsign);
    } catch (error) {
      // Validation and uniqueness both surface as a 400 with the reason, because
      // the form needs to say which it was.
      return void res.status(400).json({ error: (error as Error).message });
    }
    const updated = await repository.findById(account.id);
    res.json({ callsign: updated?.callsign ?? callsign });
  });

  /**
   * Save appearance and loadout.
   *
   * Validated with the SAME function the editor uses to build itself, called with
   * the effective tier — so a client that re-enables a supporter-only control
   * still gets refused here. That double use is the point: one rule, two callers.
   */
  router.put("/me/character", authenticated, async (req: Request, res: Response) => {
    const account = accountOf(req);
    const tier = effectiveTier(account.tier, account.tierExpiresAt, new Date());
    const problems = validateCharacter(req.body, tier);
    if (problems.length > 0) return void res.status(400).json({ problems });
    // Coerced after validating: validation proves the fields are acceptable,
    // coercion drops anything extra the client sent so it cannot be stored.
    const character = coerceCharacter(req.body);
    await repository.saveCharacter(account.id, character);
    res.json({ character });
  });

  /**
   * Grant yourself a tier. DEVELOPMENT ONLY.
   *
   * This is the grant path the design record's §2.4 promised: the entitlement
   * model is real and the payment provider is not, so something has to be able to
   * put an account on the supporter tier in order to exercise the gates. When a
   * checkout exists it replaces this handler and no schema changes.
   *
   * Three properties, each deliberate:
   *
   * - **404, not 403, when `DF2_ADMIN` is off.** A route that answers "forbidden"
   *   tells a prober that a self-service tier grant exists on this deployment.
   *   Absent is a better answer than refused.
   * - **Medals are untouchable.** Only `setTier` is called. Medals come from play
   *   alone (§6), and the one endpoint that hands out entitlements is exactly
   *   where that line would get crossed by accident.
   * - **Expiry is REQUIRED for a paid tier.** A supporter grant with no end date
   *   is indistinguishable from a permanent one, and `effectiveTier` would have
   *   nothing to lapse — so the thing this endpoint exists to test would never be
   *   tested.
   */
  router.post("/me/tier", authenticated, async (req: Request, res: Response) => {
    if (!adminEnabled) return void res.status(404).json({ error: "not_found" });
    const account = accountOf(req);
    const body = req.body as { tier?: unknown; days?: unknown };
    const tier = body.tier;
    if (tier !== "guest" && tier !== "enlisted" && tier !== "supporter") {
      return void res.status(400).json({ error: "unknown_tier" });
    }
    const paid = TIERS.find((entry) => entry.id === tier)?.priceMinor ?? 0;
    // CLAMPED, not merely checked for finiteness. `days: 1e21` makes the sum
    // infinite and `new Date(Infinity).toISOString()` throws a RangeError, which
    // Express turns into a 500 from a route whose whole job is to be predictable.
    // A negative value is allowed through the floor deliberately — granting an
    // already-lapsed tier is a case worth being able to test.
    const requested =
      typeof body.days === "number" && Number.isFinite(body.days) ? Math.trunc(body.days) : 30;
    const days = Math.max(-MAX_GRANT_DAYS, Math.min(MAX_GRANT_DAYS, requested));
    const expiresAt =
      paid > 0 ? new Date(Date.now() + days * 86_400_000).toISOString() : null;
    await repository.setTier(account.id, tier satisfies TierId, expiresAt);
    const updated = await repository.findById(account.id);
    res.json({
      tier,
      tierExpiresAt: expiresAt,
      // Echoed back resolved, so a caller granting an already-expired tier sees
      // immediately that it did not take effect.
      effectiveTier: effectiveTier(tier, expiresAt, new Date()),
      callsign: updated?.callsign ?? account.callsign,
    });
  });

  // `GET /players/:id` used to live here and returned a bare PublicProfile that
  // no client ever called. It now lives in communityApi.ts, where it returns the
  // whole profile page — clan, wall, activity and the viewer's relationship —
  // because a profile is a hub rather than a readout. One home, one shape.

  return router;
}
