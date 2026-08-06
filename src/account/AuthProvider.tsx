// Account context: who is signed in, and the actions that change that.
//
// Holds the result of GET /api/me rather than an auth response's `user` field, so
// there is one account shape in the app (see accountClient.ts for why the auth
// package gives two). Refetches whenever the token changes, which is what makes
// "register, then be signed in" work without the caller wiring anything up.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { accountClient, onTokenChange, type Me, type ServerConfig } from "./accountClient";
import { can, type Capability } from "./tiers";

export interface AuthState {
  /** Null when signed out. A guest IS signed in — check `me.account.anonymous`. */
  me: Me | null;
  /** True until the first /api/me settles, so pages can avoid flashing signed-out. */
  loading: boolean;
  config: ServerConfig | null;
  refresh: () => Promise<void>;
  signOut: () => void;
  /** Capability check against the EFFECTIVE tier. The gate every feature uses. */
  can: (capability: Capability) => boolean;
}

const AuthContext = createContext<AuthState | null>(null);

export function useAuth(): AuthState {
  const value = useContext(AuthContext);
  if (value === null) throw new Error("useAuth must be used inside <AuthProvider>");
  return value;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [config, setConfig] = useState<ServerConfig | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (accountClient.getToken() === null) {
      setMe(null);
      setLoading(false);
      return;
    }
    try {
      setMe(await accountClient.me());
    } catch {
      // A dead token has already been cleared by the client; treat it as signed
      // out rather than surfacing an error on a page the visitor did not ask for.
      setMe(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    // Refetch on every token change, including sign-out, so one subscription
    // covers sign-in, register, upgrade and expiry.
    return onTokenChange(() => void refresh());
  }, [refresh]);

  useEffect(() => {
    // Which providers exist and whether checkout is live. Failure is not fatal:
    // the sign-in page simply offers email and guest, which always work.
    accountClient
      .config()
      .then(setConfig)
      .catch(() => setConfig({ providers: [], checkoutEnabled: false, grantEnabled: false }));
  }, []);

  const signOut = useCallback(() => accountClient.signOut(), []);

  const value = useMemo<AuthState>(
    () => ({
      me,
      loading,
      config,
      refresh,
      signOut,
      can: (capability: Capability) =>
        me === null ? false : can(me.effectiveTier, capability),
    }),
    [me, loading, config, refresh, signOut]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
