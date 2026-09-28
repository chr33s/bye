import { Predicate } from "effect";
import type { JsonValue } from "../src/json.ts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  codeChallengeS256,
  CUSTOM_SCHEME_REDIRECT,
  decodeSession,
  type SecureSessionStore,
  SecureStoreError,
  SessionClient,
  type SessionState,
  type TokenFetch,
} from "../src/auth/index.ts";
import { testInstance } from "./fixtures.ts";

// DS11 (native side): the authorization code, PKCE verifier and tokens never reach logs, UI-facing
// session state, the authorize URL, or any non-secure storage. Only OS secure storage holds the
// refresh token; the access token lives in memory only.

const ORIGIN = "https://app.bye.test";

const serverAndCapture = () => {
  const seen = {
    codes: [] as Array<string>,
    verifiers: [] as Array<string>,
    access: [] as Array<string>,
    refresh: [] as Array<string>,
  };

  let challenge = "";
  let n = 0;
  let current = "";

  const reply = (status: number, body: JsonValue) => ({
    status,
    text: async () => JSON.stringify(body),
  });

  const issue = () => {
    const access = `ACCESSCANARY_${++n}_${"a".repeat(16)}`;
    current = `REFRESHCANARY_${n}_${"r".repeat(16)}`;
    seen.access.push(access);
    seen.refresh.push(current);

    return reply(200, {
      access_token: access,
      token_type: "Bearer",
      expires_in: 900,
      refresh_token: current,
      scope: "read draft send",
    });
  };

  const fetch: TokenFetch = async (url, init) => {
    const form = new URLSearchParams(init.body);

    if (url === `${ORIGIN}/oauth/revoke`) return reply(200, {});

    if (form.get("grant_type") === "authorization_code") {
      seen.verifiers.push(form.get("code_verifier") ?? "");

      return codeChallengeS256(form.get("code_verifier") ?? "") === challenge
        ? issue()
        : reply(400, { error: "invalid_grant" });
    }

    if (form.get("grant_type") === "refresh_token")
      return form.get("refresh_token") === current
        ? issue()
        : reply(400, { error: "invalid_grant" });

    return reply(400, { error: "unsupported_grant_type" });
  };

  const approve = (authorizeUrl: string) => {
    const q = new URLSearchParams(authorizeUrl.split("?")[1]);
    challenge = q.get("code_challenge")!;
    const code = `CODECANARY_${"c".repeat(20)}`;
    seen.codes.push(code);

    return `${q.get("redirect_uri")}?code=${code}&state=${encodeURIComponent(q.get("state")!)}&iss=${encodeURIComponent(ORIGIN)}`;
  };

  return { fetch, approve, seen };
};

class SecureStore implements SecureSessionStore {
  data = new Map<string, string>();
  async read(key: string) {
    const v = this.data.get(key);

    if (v === undefined) throw new SecureStoreError("MissingCredential");

    return v;
  }
  async write(key: string, value: string) {
    this.data.set(key, value);
  }
  async remove(key: string) {
    this.data.delete(key);
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  delete (globalThis as { localStorage?: unknown }).localStorage;
});

describe("DS11 native session secrets", () => {
  it("code, verifier and tokens stay out of logs, session state, the authorize URL and plain storage", async () => {
    const lines: Array<string> = [];

    for (const level of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, level).mockImplementation(
        (...args: Array<unknown>) =>
          void lines.push(
            args.map((a) => (Predicate.isString(a) ? a : JSON.stringify(a))).join(" "),
          ),
      );
    }

    // A plain (non-secure) key-value store the client must never write credentials to.
    const plain = new Map<string, string>();
    (globalThis as { localStorage?: unknown }).localStorage = {
      setItem: (k: string, v: string) => void plain.set(k, v),
      getItem: (k: string) => plain.get(k) ?? null,
      removeItem: (k: string) => void plain.delete(k),
    };

    const server = serverAndCapture();
    const store = new SecureStore();
    const opened: Array<string> = [];
    let now = Date.UTC(2026, 8, 26, 12);

    const client = new SessionClient({
      instance: testInstance(ORIGIN),
      redirectUri: CUSTOM_SCHEME_REDIRECT,
      deviceName: "Mac",
      fetch: server.fetch,
      store,
      openBrowser: async (u) => void opened.push(u),
      now: () => now,
    });

    const states: Array<SessionState> = [];
    client.subscribe((s) => states.push(s));

    await client.restore();
    const attempt = await client.beginSignIn();
    expect(await client.handleCallback(server.approve(attempt.url))).toBe(true);
    now += 20 * 60_000; // past access expiry → refresh rotates the refresh token
    await client.accessToken();
    expect(server.seen.refresh).toHaveLength(2);

    const secrets = [
      ...server.seen.codes,
      ...server.seen.verifiers,
      ...server.seen.access,
      ...server.seen.refresh,
    ];

    expect(secrets.every((s) => s.length > 0)).toBe(true);
    const logged = lines.join("\n");
    const uiState = JSON.stringify(states);
    const browser = opened.join("\n") + attempt.url;

    for (const secret of secrets) {
      expect(logged, "console").not.toContain(secret);
      expect(uiState, "session state").not.toContain(secret);
    }

    for (const secret of server.seen.verifiers)
      expect(browser, "authorize URL").not.toContain(secret);
    expect(plain.size).toBe(0);

    // Secure storage holds exactly the current refresh token — never the access token, code or verifier.
    const stored = [...store.data.values()].join("\n");
    expect(decodeSession([...store.data.values()][0]!).refreshToken).toBe(
      server.seen.refresh.at(-1),
    );

    for (const secret of [
      ...server.seen.codes,
      ...server.seen.verifiers,
      ...server.seen.access,
      server.seen.refresh[0]!,
    ])
      expect(stored).not.toContain(secret);
  });

  it("session-only mode writes nothing anywhere", async () => {
    const server = serverAndCapture();
    const store = new SecureStore();

    const client = new SessionClient({
      instance: testInstance(ORIGIN),
      redirectUri: CUSTOM_SCHEME_REDIRECT,
      deviceName: "Mac",
      fetch: server.fetch,
      store,
      openBrowser: async () => undefined,
      persist: false,
    });

    await client.restore();
    const attempt = await client.beginSignIn();
    expect(await client.handleCallback(server.approve(attempt.url))).toBe(true);
    expect(store.data.size).toBe(0);
  });
});
