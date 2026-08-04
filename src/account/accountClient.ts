// Browser-side account client: the token, the auth calls and the /api calls.
//
// Plain fetch rather than the Colyseus SDK's `client.auth`, for two reasons that
// both turned out to matter.
//
// 1. The SDK would pull the whole game SDK into the SITE bundle, which is the one
//    thing src/site/ is not allowed to do.
// 2. @colyseus/auth returns two DIFFERENT user shapes: /auth/anonymous returns
//    whatever `onRegisterAnonymously` returns (our camelCase Account), while
//    /auth/login and /auth/register return the database row (snake_case, with
//    `anonymous` as 0/1). Trusting either would mean handling both. So this module
//    ignores the `user` in every auth response and reads the canonical account from
//    GET /api/me — the token is the only thing an auth call is used for.
//
// The token is handed to the game's Colyseus client before it joins a room, which
// is why it lives here and not inside the transport.

import type { Account, Career, AwardedMedal } from "./accountTypes";
import type { Character, CharacterProblem } from "./characters";
import type { BoardSummary, Leaderboard, ServerListing } from "./lobby";
import type { TierId } from "./tiers";

const TOKEN_KEY = "df2.account.token";

export interface Me {
  account: Account;
  /** Tier with expiry already applied. Gate UI on this, never on `account.tier`. */
  effectiveTier: TierId;
  career: Career;
  medals: AwardedMedal[];
  character: Character;
}

export interface ServerConfig {
  providers: string[];
  checkoutEnabled: boolean;
}

/** Thrown by every call in this module so callers have one thing to catch. */
export class AccountError extends Error {
  readonly status: number;
  /** Field-level problems from the character endpoint, when present. */
  readonly problems: CharacterProblem[];

  constructor(message: string, status: number, problems: CharacterProblem[] = []) {
    super(message);
    this.name = "AccountError";
    this.status = status;
    this.problems = problems;
  }
}

/**
 * Human wording for the auth package's error codes.
 *
 * The API returns machine strings; a form must not. Unknown codes fall through to
 * a generic message rather than being shown raw, because `email_malformed` in a
 * red box under a text field is worse than saying nothing useful.
 */
const MESSAGES: Record<string, string> = {
  email_malformed: "That does not look like an email address.",
  email_already_in_use: "An account already uses that email.",
  invalid_credentials: "Wrong email or password.",
  password_too_short: "Passwords need at least 6 characters.",
  callsign_taken: "That callsign is taken.",
  callsign_required: "Choose a callsign.",
  not_upgradable: "That guest session has already been registered.",
  account_not_found: "This session is no longer valid. Sign in again.",
};

export function readableError(code: string): string {
  return MESSAGES[code] ?? "Something went wrong. Try again.";
}

/** Token access. Module-level so the game transport can read it before joining. */
export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    // Private browsing with storage disabled. Sign-in still works for the life of
    // the tab via the in-memory fallback below.
    return memoryToken;
  }
}

let memoryToken: string | null = null;

function setToken(token: string | null): void {
  memoryToken = token;
  try {
    if (token === null) localStorage.removeItem(TOKEN_KEY);
    else localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // Already held in memoryToken.
  }
  for (const listener of listeners) listener();
}

const listeners = new Set<() => void>();

/** Subscribe to token changes. Used by AuthProvider to refetch the account. */
export function onTokenChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  const headers = new Headers(init.headers);
  if (!headers.has("content-type") && init.body !== undefined) {
    headers.set("content-type", "application/json");
  }
  if (token !== null) headers.set("authorization", `Bearer ${token}`);

  const response = await fetch(path, { ...init, headers });
  const text = await response.text();
  const body: unknown = text === "" ? {} : safeJson(text);

  if (!response.ok) {
    const error = (body as { error?: string }).error;
    const problems = (body as { problems?: CharacterProblem[] }).problems ?? [];
    // A 401 on any call means the stored token is no longer usable. Clearing it
    // here is what stops the app looping on a dead session.
    if (response.status === 401 && path !== "/auth/login") setToken(null);
    throw new AccountError(
      error !== undefined ? readableError(error) : `Request failed (${response.status})`,
      response.status,
      problems
    );
  }
  return body as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

/** Adopt the token from an auth response, ignoring its `user` field. */
async function adoptToken(path: string, body: unknown): Promise<void> {
  const result = await request<{ token?: string }>(path, {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (typeof result.token !== "string") {
    throw new AccountError("The server did not return a session.", 500);
  }
  setToken(result.token);
}

export const accountClient = {
  getToken,

  async config(): Promise<ServerConfig> {
    return await request<ServerConfig>("/api/config");
  },

  /** Play as a guest. Creates a real row, so progress can be upgraded later. */
  async signInAnonymously(): Promise<void> {
    await adoptToken("/auth/anonymous", {});
  },

  async signIn(email: string, password: string): Promise<void> {
    await adoptToken("/auth/login", { email, password });
  },

  /**
   * Register. If a guest token is already held it is sent along, and the server
   * upgrades that account IN PLACE rather than creating a second one — which is
   * how medals, career and a saved character survive registration.
   */
  async register(email: string, password: string, callsign: string): Promise<void> {
    await adoptToken("/auth/register", { email, password, options: { callsign } });
  },

  async requestPasswordReset(email: string): Promise<void> {
    await request("/auth/forgot-password", {
      method: "POST",
      body: JSON.stringify({ email }),
    });
  },

  async me(): Promise<Me> {
    return await request<Me>("/api/me");
  },

  async setCallsign(callsign: string): Promise<string> {
    const result = await request<{ callsign: string }>("/api/me", {
      method: "PATCH",
      body: JSON.stringify({ callsign }),
    });
    return result.callsign;
  },

  async saveCharacter(character: Character): Promise<Character> {
    const result = await request<{ character: Character }>("/api/me/character", {
      method: "PUT",
      body: JSON.stringify(character),
    });
    return result.character;
  },

  /** Public rooms, optionally filtered to one input class. */
  async servers(inputClass?: string): Promise<ServerListing[]> {
    const query = inputClass === undefined ? "" : `?input=${encodeURIComponent(inputClass)}`;
    const result = await request<{ servers: ServerListing[] }>(`/api/servers${query}`);
    return result.servers;
  },

  /**
   * Turn a join code into a room id.
   *
   * The code never reaches the game — the lobby resolves it here and navigates to
   * /play with `&room=<id>`, so a code cannot end up in browser history or in a
   * shared URL where it would outlive the match.
   */
  async resolveJoinCode(code: string): Promise<string> {
    const result = await request<{ roomId: string }>("/api/join-code", {
      method: "POST",
      body: JSON.stringify({ code }),
    });
    return result.roomId;
  },

  async leaderboards(): Promise<BoardSummary[]> {
    const result = await request<{ boards: BoardSummary[] }>("/api/leaderboards");
    return result.boards;
  },

  async leaderboard(board: string): Promise<Leaderboard> {
    return await request<Leaderboard>(`/api/leaderboard/${encodeURIComponent(board)}`);
  },

  signOut(): void {
    setToken(null);
  },
};

/** Provider sign-in is a full navigation, not a fetch — the OAuth dance needs it. */
export function providerSignInUrl(provider: string): string {
  return `/auth/provider/${provider}`;
}
