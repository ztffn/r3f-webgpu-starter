// In-process rate limiting for the credential and mutation routes.
//
// SERVER ONLY. Deliberately dependency-free and in-memory: this deployment is
// ONE box running one process (design record §deploy), so a Map is the whole
// store and a restart forgiving every counter is an acceptable trade. If the
// server ever scales past one process this has to move to the database — the
// limit is per-process, which is stated here so nobody assumes otherwise.

/** A fixed-window counter. Windows are cheap and their edge burst is tolerable. */
interface Window {
  count: number;
  resetAtMs: number;
}

export interface RateLimitRule {
  /** Window length in seconds. */
  readonly windowSeconds: number;
  /** Attempts allowed inside one window. */
  readonly max: number;
}

/**
 * Keyed fixed-window limiter.
 *
 * `check` both tests and consumes, because a limiter that tests without
 * consuming is a limiter every caller has to remember to tick — and the one
 * that forgets is the one that matters.
 */
export class RateLimiter {
  private readonly windows = new Map<string, Window>();
  private lastSweepMs = 0;

  /** True when the attempt is allowed; false when the caller is over the limit. */
  check(key: string, rule: RateLimitRule, nowMs: number = Date.now()): boolean {
    this.sweep(nowMs);
    const window = this.windows.get(key);
    if (window === undefined || nowMs >= window.resetAtMs) {
      this.windows.set(key, { count: 1, resetAtMs: nowMs + rule.windowSeconds * 1000 });
      return true;
    }
    if (window.count >= rule.max) return false;
    window.count += 1;
    return true;
  }

  /** Seconds until the caller's window resets, for a Retry-After header. */
  retryAfterSeconds(key: string, nowMs: number = Date.now()): number {
    const window = this.windows.get(key);
    if (window === undefined || nowMs >= window.resetAtMs) return 0;
    return Math.ceil((window.resetAtMs - nowMs) / 1000);
  }

  /** Testing seam: forget everything. */
  reset(): void {
    this.windows.clear();
    this.lastSweepMs = 0;
  }

  /**
   * Drop expired windows, at most once a minute.
   *
   * Without this the map grows one entry per distinct key forever, which for an
   * IP-keyed limiter on a public endpoint is an unbounded allocation an attacker
   * chooses the size of.
   */
  private sweep(nowMs: number): void {
    if (nowMs - this.lastSweepMs < 60_000) return;
    this.lastSweepMs = nowMs;
    for (const [key, window] of this.windows) {
      if (nowMs >= window.resetAtMs) this.windows.delete(key);
    }
  }
}

/**
 * Who is knocking, for limiting purposes.
 *
 * `req.ip` respects Express's `trust proxy`, which the game server sets when it
 * runs behind one. Falls back to the socket address, then to a single shared
 * bucket — a shared bucket is worse than per-IP but far better than no limit.
 */
export function callerKey(req: {
  ip?: string | undefined;
  socket?: { remoteAddress?: string | undefined } | undefined;
}): string {
  return req.ip ?? req.socket?.remoteAddress ?? "unknown";
}

/**
 * The credential surface. Password guessing, guest-row creation and the two
 * routes that answer "does this email exist" all live behind these.
 *
 * Numbers chosen to be invisible to a human and ruinous to a script: nobody
 * types twenty passwords a minute, and ten new guest accounts per hour per
 * address is far more than one household needs.
 */
export const AUTH_LIMITS = {
  /** Login, and anything else that compares a password. */
  login: { windowSeconds: 300, max: 20 },
  /** Registration, including guest upgrades. */
  register: { windowSeconds: 3600, max: 10 },
  /** Guest creation — one per visit, and a visit is not a per-second event. */
  anonymous: { windowSeconds: 3600, max: 10 },
  /** The email-existence surface: forgot-password and reset. */
  recovery: { windowSeconds: 3600, max: 10 },
} as const satisfies Record<string, RateLimitRule>;
