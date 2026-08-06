// The client's request wrapper — specifically its two defensive rules.
//
// A 200 that is not JSON means a proxy served the SPA's index.html for an /api
// call, which CLAUDE.md calls a live crash rather than a soft failure: `safeJson`
// turns the HTML into `{}`, every `response.ok` check passes, and the page
// explodes at the first field it reads. And a 401 has to clear the stored token,
// or the app loops on a dead session. Both are behaviour no page can express.
//
// `fetch` and `localStorage` are stubbed on globalThis; nothing here touches a
// network or a browser.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

/** A minimal localStorage, because the module reads one at import time. */
class MemoryStorage {
  private readonly map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

const realFetch = globalThis.fetch;
let responder: (path: string) => Response = () => new Response("{}");

beforeEach(() => {
  (globalThis as { localStorage?: unknown }).localStorage ??= new MemoryStorage();
  globalThis.fetch = ((input: RequestInfo | URL) =>
    Promise.resolve(responder(String(input)))) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Imported lazily so the stubs above are in place first. */
async function client() {
  return await import("../../src/account/accountClient.ts");
}

describe("a 200 that is not JSON", () => {
  it("is refused rather than parsed into an empty object", async () => {
    const { accountClient, AccountError } = await client();
    responder = () =>
      new Response("<!doctype html><title>Distant Front</title>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    // `config()` is the call that found this in the first place: the page read
    // `config.providers.length` off `{}` and threw where nothing could explain it.
    await assert.rejects(
      () => accountClient.config(),
      (error: unknown) => {
        assert.ok(error instanceof AccountError);
        assert.equal(error.status, 502);
        assert.match(error.message, /game server/);
        return true;
      }
    );
  });

  it("still accepts a real JSON answer", async () => {
    const { accountClient } = await client();
    responder = () =>
      new Response(JSON.stringify({ providers: ["discord"], checkoutEnabled: false }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    const config = await accountClient.config();
    assert.deepEqual(config.providers, ["discord"]);
  });
});

describe("a 401", () => {
  it("clears the stored token so the app stops looping on a dead session", async () => {
    const { accountClient, getToken } = await client();
    // Written through storage rather than a setter: `setToken` is module-private,
    // and storage is the seam the app actually persists through.
    localStorage.setItem("df2.account.token", "stale-token");
    assert.equal(getToken(), "stale-token");
    responder = () =>
      new Response(JSON.stringify({ error: "account_not_found" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    await assert.rejects(() => accountClient.me());
    assert.equal(getToken(), null, "a dead token must not survive a 401");
  });
});
