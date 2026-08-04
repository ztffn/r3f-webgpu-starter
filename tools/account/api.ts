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

import express, {
  type NextFunction,
  type Request,
  type Response,
  type Router,
  type RequestHandler,
} from "express";
import { auth } from "@colyseus/auth";
import { effectiveTier, type Account } from "../../src/account/accountTypes.ts";
import { validateCharacter, coerceCharacter } from "../../src/account/characters.ts";
import { TIERS } from "../../src/account/tiers.ts";
import { accountFromToken } from "./authSettings.ts";
import type { AccountRepository } from "./repository.ts";

export interface ApiDeps {
  repository: AccountRepository;
  providers: string[];
  /** Whether a real payment provider is wired. Mirrors VITE_CHECKOUT. */
  checkoutEnabled: boolean;
}

/** What `requireAccount` hangs on the request for the handler behind it. */
type AuthenticatedRequest = Request & { account?: Account };

/**
 * Resolve the token to a LIVE account row, or refuse.
 *
 * Chained after `auth.middleware()`, which verifies the signature and leaves the
 * payload on `req.auth`. This is the second half, and it is deliberately not
 * optional: the token carries only `{ id }`, so a rename, a tier change or a
 * deleted account has to be read from the database on every request rather than
 * believed from the token. Three routes were each doing this inline, which is
 * three chances for one of them to trust the payload instead.
 */
function requireAccount(repository: AccountRepository): RequestHandler {
  // Async, with no try/catch: Express 5 forwards a rejected handler to the error
  // handler, which is the same contract the routes below already rely on.
  return async (req: Request, res: Response, next: NextFunction) => {
    const account = await accountFromToken(repository, (req as { auth?: unknown }).auth);
    if (account === null) return void res.status(401).json({ error: "account_not_found" });
    (req as AuthenticatedRequest).account = account;
    next();
  };
}

/** The account `requireAccount` resolved. Only valid behind it. */
function accountOf(req: Request): Account {
  const account = (req as AuthenticatedRequest).account;
  if (account === undefined) throw new Error("route is missing requireAccount");
  return account;
}

export function createApiRouter({
  repository,
  providers,
  checkoutEnabled,
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
      tiers: TIERS.map((tier) => ({ id: tier.id, priceMinor: tier.priceMinor })),
    });
  });

  /** The caller's own account, with everything the profile page needs. */
  router.get("/me", authenticated, async (req: Request, res: Response) => {
    const account = accountOf(req);
    await repository.touch(account.id);
    res.json({
      account,
      // Resolved here so the client never has to reimplement expiry. A lapsed
      // supporter reads as "enlisted" everywhere, including in the UI that
      // decides which controls to enable.
      effectiveTier: effectiveTier(account.tier, account.tierExpiresAt, new Date()),
      career: await repository.career(account.id),
      medals: await repository.medals(account.id),
      character: await repository.character(account.id),
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

  /** Anyone's public profile. No email, no session state — see PublicProfile. */
  router.get("/players/:id", async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return void res.status(400).json({ error: "bad_id" });
    }
    const profile = await repository.publicProfile(id);
    if (profile === null) return void res.status(404).json({ error: "not_found" });
    res.json(profile);
  });

  return router;
}
