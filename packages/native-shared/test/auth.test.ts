import { describe, expect, it } from "vitest";
import {
  base64Url,
  codeChallengeS256,
  constantTimeEqual,
  CUSTOM_SCHEME_REDIRECT,
  decodeSession,
  loopbackRedirect,
  MOBILE_CLIENT_ID,
  parseCallback,
  SecureStoreError,
  type SecureStoreErrorKind,
  type SecureSessionStore,
  SessionClient,
  sessionKey,
  sha256,
  type TokenFetch,
  utf8Encode,
} from "../src/auth/index.ts";
import { testInstance } from "./fixtures.ts";

// Desktop sign-in client (A03/X01) against a fake authorization server that follows the server
// contract: single-use codes bound to PKCE + redirect, rotating refresh tokens with reuse detection.

const ORIGIN = "https://app.bye.test";

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

class FakeAuthServer {
  codes = new Map<string, { challenge: string; redirect: string; used: boolean }>();
  families = new Map<string, { current: string; revoked: boolean }>();
  refreshCalls = 0;
  down = false;
  private n = 0;

  /** Simulates the browser leg: user approves, server issues a code for this authorize URL. */
  approve(authorizeUrl: string): string {
    const q = new URLSearchParams(authorizeUrl.split("?")[1]);
    expect(q.get("code_challenge_method")).toBe("S256");
    expect(q.get("client_id")).toBe("bye-desktop");
    const code = `code_${++this.n}_${"x".repeat(12)}`;
    this.codes.set(code, {
      challenge: q.get("code_challenge")!,
      redirect: q.get("redirect_uri")!,
      used: false,
    });
    return `${q.get("redirect_uri")}?code=${code}&state=${encodeURIComponent(q.get("state")!)}&iss=${encodeURIComponent(ORIGIN)}`;
  }

  private issue(family: string) {
    const refresh = `rt_${family}_${++this.n}_${"r".repeat(16)}`;
    this.families.get(family)!.current = refresh;
    return {
      status: 200,
      body: {
        access_token: `at_${this.n}`,
        token_type: "Bearer",
        expires_in: 900,
        refresh_token: refresh,
        scope: "read draft send",
      },
    };
  }

  readonly fetch: TokenFetch = async (url, init) => {
    if (this.down) throw new TypeError("Network request failed");
    const form = new URLSearchParams(init.body);
    const reply = (status: number, body: unknown) => ({
      status,
      text: async () => JSON.stringify(body),
    });
    if (url === `${ORIGIN}/oauth/revoke`) {
      for (const f of this.families.values()) if (f.current === form.get("token")) f.revoked = true;
      return reply(200, {});
    }
    if (url !== `${ORIGIN}/oauth/token`) return reply(404, {});
    if (form.get("grant_type") === "authorization_code") {
      const code = this.codes.get(form.get("code") ?? "");
      if (!code || code.used || code.redirect !== form.get("redirect_uri"))
        return reply(400, { error: "invalid_grant" });
      code.used = true;
      if (codeChallengeS256(form.get("code_verifier") ?? "") !== code.challenge)
        return reply(400, { error: "invalid_grant" });
      const family = `f${this.families.size + 1}`;
      this.families.set(family, { current: "", revoked: false });
      const r = this.issue(family);
      return reply(r.status, r.body);
    }
    if (form.get("grant_type") === "refresh_token") {
      this.refreshCalls++;
      const token = form.get("refresh_token") ?? "";
      const family = /^rt_(f\d+)_/.exec(token)?.[1] ?? "";
      const f = this.families.get(family);
      if (!f || f.revoked) return reply(400, { error: "invalid_grant" });
      if (f.current !== token) {
        // Replay of a rotated refresh token: revoke the whole device session (RFC 9700 §4.14.2).
        f.revoked = true;
        return reply(400, { error: "invalid_grant" });
      }
      const r = this.issue(family);
      return reply(r.status, r.body);
    }
    return reply(400, { error: "unsupported_grant_type" });
  };
}

class FakeStore implements SecureSessionStore {
  data = new Map<string, string>();
  failRead: SecureStoreErrorKind | null = null;
  failWrite: SecureStoreErrorKind | null = null;
  writes = 0;
  async read(key: string) {
    if (this.failRead) throw new SecureStoreError(this.failRead, "-25308");
    const v = this.data.get(key);
    if (v === undefined) throw new SecureStoreError("MissingCredential");
    return v;
  }
  async write(key: string, value: string) {
    this.writes++;
    if (this.failWrite) throw new SecureStoreError(this.failWrite);
    this.data.set(key, value);
  }
  async remove(key: string) {
    this.data.delete(key);
  }
}

const setup = (options: { persist?: boolean; redirectUri?: string } = {}) => {
  const server = new FakeAuthServer();
  const store = new FakeStore();
  let now = Date.UTC(2026, 8, 25, 12);
  const opened: Array<string> = [];
  const make = () =>
    new SessionClient({
      instance: testInstance(ORIGIN),
      redirectUri: options.redirectUri ?? CUSTOM_SCHEME_REDIRECT,
      deviceName: "Work Mac",
      fetch: server.fetch,
      store,
      openBrowser: async (url) => void opened.push(url),
      now: () => now,
      ...(options.persist === false ? { persist: false } : {}),
    });
  return { server, store, opened, make, advance: (ms: number) => (now += ms) };
};

const signIn = async (env: ReturnType<typeof setup>, client = env.make()) => {
  await client.restore();
  const attempt = await client.beginSignIn();
  expect(await client.handleCallback(env.server.approve(attempt.url))).toBe(true);
  return client;
};

describe("PKCE and callback validation", () => {
  it("[A03] SHA-256 and S256 match RFC 7636 Appendix B", () => {
    expect(hex(sha256(utf8Encode("abc")))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(hex(sha256(new Uint8Array(0)))).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(codeChallengeS256("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
    expect(base64Url(new Uint8Array([251, 255]))).toBe("-_8");
    expect(() => codeChallengeS256("short")).toThrow();
  });

  it("[A03] DS03: wrong state, foreign redirect, error params and tokens in the URL never authorize", async () => {
    const env = setup();
    const client = env.make();
    await client.restore();
    const attempt = await client.beginSignIn();
    const good = env.server.approve(attempt.url);
    const code = /code=([^&]+)/.exec(good)![1]!;
    expect(
      parseCallback(`bye://oauth/callback?code=${code}&state=wrong`, attempt, attempt.startedAt),
    ).toEqual({
      _tag: "Ignored",
      reason: "state-mismatch",
    });
    expect(
      parseCallback(
        `bye://evil/callback?code=${code}&state=${attempt.state}`,
        attempt,
        attempt.startedAt,
      )._tag,
    ).toBe("Ignored");
    expect(
      parseCallback(
        `http://127.0.0.1:5000/oauth/callback?code=${code}&state=${attempt.state}`,
        attempt,
        attempt.startedAt,
      )._tag,
    ).toBe("Ignored");
    expect(
      parseCallback(
        `bye://oauth/callback?state=${attempt.state}&error=access_denied&iss=${encodeURIComponent(ORIGIN)}`,
        attempt,
        attempt.startedAt,
      ),
    ).toEqual({ _tag: "Denied", error: "access_denied" });
    expect(
      parseCallback(
        `bye://oauth/callback?state=${attempt.state}&access_token=x&code=${code}&iss=${encodeURIComponent(ORIGIN)}`,
        attempt,
        attempt.startedAt,
      )._tag,
    ).toBe("Invalid");
    expect(constantTimeEqual("abc", "abd")).toBe(false);
    expect(() => loopbackRedirect(80)).toThrow();
  });

  it("[A03] DS03: a code redeemed once cannot be replayed, and a wrong verifier is rejected", async () => {
    const env = setup();
    const client = env.make();
    await client.restore();
    const attempt = await client.beginSignIn();
    const callback = env.server.approve(attempt.url);
    await client.handleCallback(callback);
    expect(client.state).toEqual({ _tag: "SignedIn", persisted: true });
    // Replaying the same callback: the attempt is single-use, and the server code is consumed.
    expect(await client.handleCallback(callback)).toBe(true);
    const code = /code=([^&]+)/.exec(callback)![1]!;
    const replay = await env.server.fetch(`${ORIGIN}/oauth/token`, {
      method: "POST",
      headers: {},
      body: `grant_type=authorization_code&code=${code}&redirect_uri=${encodeURIComponent(CUSTOM_SCHEME_REDIRECT)}&code_verifier=${attempt.verifier}`,
    });
    expect(replay.status).toBe(400);
  });

  it("[A03] DS04: cancelling is recoverable and a second attempt never resumes the first", async () => {
    const env = setup();
    const client = env.make();
    await client.restore();
    const first = await client.beginSignIn();
    const firstCallback = env.server.approve(first.url);
    client.cancelSignIn();
    expect(client.state).toEqual({ _tag: "SignedOut", reason: "cancelled" });
    const second = await client.beginSignIn();
    expect(second.state).not.toBe(first.state);
    await client.handleCallback(firstCallback);
    expect(client.state._tag).toBe("Authorizing");
    await client.handleCallback(env.server.approve(second.url));
    expect(client.state._tag).toBe("SignedIn");
    expect(env.opened).toHaveLength(2);
  });

  it("[X01] loopback redirects are supported for hosts without a claimed scheme", async () => {
    const env = setup({ redirectUri: loopbackRedirect(49152) });
    await signIn(env);
    expect(env.opened[0]).toContain(encodeURIComponent("http://127.0.0.1:49152/oauth/callback"));
  });
});

describe("device session persistence", () => {
  it("[X01] DS01/DS02: sign-in persists only a refresh credential; relaunch restores without a new ceremony", async () => {
    const env = setup();
    const first = await signIn(env);
    const access = await first.accessToken();
    expect(access).toMatch(/^at_/);
    const stored = decodeSession(env.store.data.get(sessionKey(testInstance(ORIGIN).key))!);
    expect(stored.refreshToken).toMatch(/^rt_/);
    expect(JSON.stringify(stored)).not.toContain(access!);

    // Process exit + relaunch: a new client restores from secure storage.
    const relaunched = env.make();
    expect(await relaunched.restore()).toEqual({ _tag: "SignedIn", persisted: true });
    expect(env.opened).toHaveLength(1);
    expect(await relaunched.accessToken()).toMatch(/^at_/);
  });

  it("[X01] DS07: an expired access token renews silently with rotation", async () => {
    const env = setup();
    const client = await signIn(env);
    const before = decodeSession(
      env.store.data.get(sessionKey(testInstance(ORIGIN).key))!,
    ).refreshToken;
    env.advance(16 * 60_000);
    expect(await client.accessToken()).toMatch(/^at_/);
    expect(
      decodeSession(env.store.data.get(sessionKey(testInstance(ORIGIN).key))!).refreshToken,
    ).not.toBe(before);
  });

  it("[X01] DS06: concurrent refreshes share one rotation (no self-inflicted reuse revocation)", async () => {
    const env = setup();
    const client = await signIn(env);
    env.advance(16 * 60_000);
    const results = await Promise.all([
      client.accessToken(),
      client.onUnauthorized(),
      client.accessToken(),
    ]);
    expect(new Set(results).size).toBe(1);
    expect(env.server.refreshCalls).toBe(1);
    expect(client.state._tag).toBe("SignedIn");
  });

  it("[X01] DS08: offline launch keeps the credential and recovers when the network returns", async () => {
    const env = setup();
    await signIn(env);
    env.server.down = true;
    const offline = env.make();
    expect((await offline.restore())._tag).toBe("Offline");
    expect(env.store.data.has(sessionKey(testInstance(ORIGIN).key))).toBe(true);
    env.server.down = false;
    expect(await offline.refreshNow()).toMatch(/^at_/);
    expect(offline.state._tag).toBe("SignedIn");
  });

  it("[X01] DS05: locked, denied and corrupt storage are distinct; nothing falls back to plaintext", async () => {
    const env = setup();
    await signIn(env);
    env.store.failRead = "StorageUnavailable";
    expect(await env.make().restore()).toEqual({
      _tag: "StorageError",
      kind: "StorageUnavailable",
      nativeCode: "-25308",
    });
    env.store.failRead = "StorageDenied";
    expect((await env.make().restore())._tag).toBe("StorageError");
    expect(env.store.data.has(sessionKey(testInstance(ORIGIN).key))).toBe(true);
    env.store.failRead = null;
    env.store.data.set(sessionKey(testInstance(ORIGIN).key), "{not json");
    expect(await env.make().restore()).toEqual({ _tag: "SignedOut", reason: "corrupt-credential" });
    expect(env.store.data.has(sessionKey(testInstance(ORIGIN).key))).toBe(false);
  });

  it("[X01] DS06: if the rotated credential cannot be saved the app says so instead of claiming persistence", async () => {
    const env = setup();
    const client = await signIn(env);
    env.store.failWrite = "StorageUnavailable";
    env.advance(16 * 60_000);
    expect(await client.accessToken()).toMatch(/^at_/);
    expect(client.state).toEqual({ _tag: "NotPersisted", kind: "StorageUnavailable" });
    env.store.failWrite = null;
    expect(await client.retryPersist()).toEqual({ _tag: "SignedIn", persisted: true });
  });

  it("[X01] DS09: a replayed (stale) refresh credential ends the session and clears local state", async () => {
    const env = setup();
    await signIn(env);
    const stale = env.store.data.get(sessionKey(testInstance(ORIGIN).key))!;
    const a = env.make();
    await a.restore(); // rotates
    env.store.data.set(sessionKey(testInstance(ORIGIN).key), stale); // e.g. a restored backup of the old secret
    const b = env.make();
    expect(await b.restore()).toEqual({ _tag: "SignedOut", reason: "revoked" });
    expect(env.store.data.has(sessionKey(testInstance(ORIGIN).key))).toBe(false);
    // Reuse detection revoked the whole family, including the other process's newer token.
    expect(await a.onUnauthorized()).toBeNull();
    expect(a.state).toEqual({ _tag: "SignedOut", reason: "revoked" });
  });

  it("[X01] DS09: logout revokes when reachable, otherwise stays pending and is completed on next launch", async () => {
    const env = setup();
    const client = await signIn(env);
    env.server.down = true;
    expect(await client.logout()).toBe("pending");
    expect(client.state).toEqual({ _tag: "SignedOut", reason: "logged-out", logoutPending: true });
    expect(await client.accessToken()).toBeNull();
    env.server.down = false;
    const next = env.make();
    expect(await next.restore()).toEqual({ _tag: "SignedOut", reason: "logged-out" });
    expect(env.store.data.has(sessionKey(testInstance(ORIGIN).key))).toBe(false);
    expect([...env.server.families.values()].every((f) => f.revoked)).toBe(true);

    const again = await signIn(env);
    expect(await again.logout()).toBe("revoked");
  });

  it("[X01] DS10: session-only mode never writes the credential and signs out on relaunch", async () => {
    const env = setup({ persist: false });
    const client = await signIn(env);
    expect(client.state).toEqual({ _tag: "SignedIn", persisted: false });
    expect(env.store.writes).toBe(0);
    expect(await env.make().restore()).toEqual({ _tag: "SignedOut" });
  });

  it("[X01] mobile uses the same device-session flow under its own client ID, with no cookies", async () => {
    const store = new FakeStore();
    const opened: Array<string> = [];
    const bodies: Array<URLSearchParams> = [];
    const fetch: TokenFetch = async (_url, init) => {
      const form = new URLSearchParams(init.body);
      bodies.push(form);
      return {
        status: 200,
        text: async () =>
          JSON.stringify({
            access_token: "at_m",
            token_type: "Bearer",
            expires_in: 900,
            refresh_token: `rt_m_${"r".repeat(16)}`,
            scope: "mail calendar",
          }),
      };
    };
    const client = new SessionClient({
      instance: testInstance(ORIGIN),
      clientId: MOBILE_CLIENT_ID,
      redirectUri: CUSTOM_SCHEME_REDIRECT,
      deviceName: "iPhone app",
      fetch,
      store,
      openBrowser: async (url) => void opened.push(url),
    });
    await client.restore();
    const attempt = await client.beginSignIn();
    const authorize = new URLSearchParams(opened[0]!.split("?")[1]);
    // The authorize request and the token exchange name the same registered client.
    expect(authorize.get("client_id")).toBe("bye-mobile");
    expect(authorize.get("redirect_uri")).toBe("bye://oauth/callback");
    expect(
      await client.handleCallback(
        `bye://oauth/callback?code=code_m_${"x".repeat(12)}&state=${encodeURIComponent(attempt.state)}&iss=${encodeURIComponent(ORIGIN)}`,
      ),
    ).toBe(true);
    expect(bodies[0]!.get("client_id")).toBe("bye-mobile");
    expect(client.state).toEqual({ _tag: "SignedIn", persisted: true });
    // Access token in memory only; the refresh credential is in the secure store.
    expect(await client.accessToken()).toBe("at_m");
    expect([...store.data.values()].join("")).not.toContain("at_m");
    expect([...store.data.values()].join("")).toContain("rt_m_");
  });

  it("[X01] storage is namespaced per instance (base URL + issuer)", () => {
    expect(sessionKey(testInstance("https://app.bye.test").key)).toBe(
      "email.bye.session.v2|https://app.bye.test|https://app.bye.test",
    );
    expect(sessionKey(testInstance("https://staging.bye.test").key)).not.toBe(
      sessionKey(testInstance("https://app.bye.test").key),
    );
    // Same base URL, different issuer: a different slot.
    expect(sessionKey(testInstance("https://app.bye.test", "https://id.bye.test").key)).not.toBe(
      sessionKey(testInstance("https://app.bye.test").key),
    );
    expect(() => sessionKey("http://evil.test|http://evil.test")).toThrow();
  });
});
