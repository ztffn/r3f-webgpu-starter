// Resolving a verified token to a live account, for any router that needs one.
//
// SERVER ONLY. Its own module rather than a corner of api.ts because two routers
// now authenticate — the account API and the lobby's private-game route — and the
// rule that matters is worth having exactly one copy of: the token carries only
// `{ id }`, so a rename, a tier change or a deleted account must be read from the
// database on every request rather than believed from the payload.

import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { Account } from "../../src/account/accountTypes.ts";
import { accountFromToken } from "./authSettings.ts";
import type { AccountRepository } from "./repository.ts";

/** What `requireAccount` hangs on the request for the handler behind it. */
type AuthenticatedRequest = Request & { account?: Account };

/**
 * Resolve the token to a LIVE account row, or refuse.
 *
 * Chained after `auth.middleware()`, which verifies the signature and leaves the
 * payload on `req.auth`. This is the second half, and it is deliberately not
 * optional.
 */
export function requireAccount(repository: AccountRepository): RequestHandler {
  // Async, with no try/catch: Express 5 forwards a rejected handler to the error
  // handler, which is the same contract the routes already rely on.
  return async (req: Request, res: Response, next: NextFunction) => {
    const account = await accountFromToken(repository, (req as { auth?: unknown }).auth);
    if (account === null) return void res.status(401).json({ error: "account_not_found" });
    (req as AuthenticatedRequest).account = account;
    next();
  };
}

/** The account `requireAccount` resolved. Only valid behind it. */
export function accountOf(req: Request): Account {
  const account = (req as AuthenticatedRequest).account;
  if (account === undefined) throw new Error("route is missing requireAccount");
  return account;
}
