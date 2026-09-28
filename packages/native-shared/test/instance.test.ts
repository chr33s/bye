import { describe, expect, it } from "vitest";
import {
  CUSTOM_SCHEME_REDIRECT,
  SecureStoreError,
  type SecureSessionStore,
  SessionClient,
  sessionKey,
  type TokenFetch,
} from "../src/auth/index.ts";
import type { KeyValueStore } from "../src/drafts.ts";
import {
  accountScope,
  addInstanceLink,
  clearInstanceState,
  distinctAuthOrigin,
  InstanceConflictError,
  InstanceRegistry,
  normalizeInstanceUrl,
  parseInstanceHandoff,
  type ProbeFetch,
  type ProbeFetchInit,
  probeInstance,
  scopedStore,
} from "../src/instance/index.ts";
import { testInstance } from "./fixtures.ts";

// spec §10 Instance selection: one build, any compatible instance. Covers URL normalization, handoff
// parsing, credential-free validation, the issuer/endpoint binding, local isolation, and the
// authentication mix-up and switching races (acceptance 1–4, 6).

describe("instance URL normalization", () => {
  const ok = (raw: string, opts = {}) => {
    const n = normalizeInstanceUrl(raw, opts);
    return n.ok ? n.url : n.reason;
  };

  it("keeps ports and base paths; drops only insignificant forms", () => {
    expect(ok("https://Mail.Example.COM/")).toBe("https://mail.example.com");
    expect(ok("https://mail.example.com:443")).toBe("https://mail.example.com");
    expect(ok("https://mail.example.com:8443/bye/")).toBe("https://mail.example.com:8443/bye");
    expect(ok("https://mail.example.com/a%2db")).toBe("https://mail.example.com/a%2Db");
    expect(ok("mail.example.com", { assumeHttps: true })).toBe("https://mail.example.com");
  });

  it("rejects insecure, credentialed, ambiguous and unsupported forms", () => {
    expect(ok("http://mail.example.com")).toBe("insecure-scheme");
    expect(ok("ftp://mail.example.com")).toBe("unsupported-scheme");
    expect(ok("mail.example.com")).toBe("malformed");
    expect(ok("https://user:pw@mail.example.com")).toBe("credentials");
    expect(ok("https://mail.example.com/?x=1")).toBe("query");
    expect(ok("https://mail.example.com/#x")).toBe("fragment");
    expect(ok("https://mail.example.com./")).toBe("invalid-host");
    expect(ok("https://bücher.example")).toBe("invalid-host");
    expect(ok("https://0x7f.1")).toBe("invalid-host");
    expect(ok("https://2130706433")).toBe("invalid-host");
    expect(ok("https://mail.example.com:0")).toBe("invalid-port");
    expect(ok("https://mail.example.com:99999")).toBe("invalid-port");
    expect(ok("https://mail.example.com/a/../b")).toBe("invalid-path");
    expect(ok("https://mail.example.com/a//b")).toBe("invalid-path");
    expect(ok("https://mail.example.com/a%2Fb")).toBe("invalid-path");
    expect(ok("https://mail.example.com/a b")).toBe("malformed");
    expect(ok("https://mail.example.com\\evil.test")).toBe("malformed");
  });

  it("refuses private-network addresses unless the policy explicitly allows them", () => {
    for (const host of [
      "localhost",
      "127.0.0.1",
      "10.1.2.3",
      "192.168.1.10",
      "172.20.0.1",
      "169.254.169.254",
      "[::1]",
      "[fd00::1]",
      "nas.local",
      "intranet",
    ])
      expect(ok(`https://${host}`), host).toBe("private-network");
    expect(ok("https://192.168.1.10", { privateNetwork: "allow" })).toBe("https://192.168.1.10");
    expect(ok("https://8.8.8.8")).toBe("https://8.8.8.8");
  });

  it("accepts plain http only for loopback hosts, and only when insecureLoopback is set", () => {
    const dev = { insecureLoopback: true };
    expect(ok("http://localhost:1337")).toBe("insecure-scheme");
    expect(ok("http://LOCALHOST:1337/", dev)).toBe("http://localhost:1337");
    expect(ok("http://127.0.0.1:80", dev)).toBe("http://127.0.0.1");
    expect(ok("http://[::1]:8787", dev)).toBe("http://[::1]:8787");
    for (const host of ["mail.example.com", "10.0.0.5", "127.0.0.2", "nas.local"])
      expect(ok(`http://${host}`, dev), host).toBe("insecure-scheme");
    // https keeps its normal private-network policy.
    expect(ok("https://localhost", dev)).toBe("private-network");
  });
});

describe("Open in Bye / QR handoff", () => {
  it("is only an add-instance request carrying one HTTPS URL", () => {
    expect(parseInstanceHandoff(addInstanceLink("https://mail.example.com/"))).toEqual({
      _tag: "AddInstance",
      url: "https://mail.example.com",
    });
    expect(parseInstanceHandoff("https://mail.example.com", { scanned: true })).toEqual({
      _tag: "AddInstance",
      url: "https://mail.example.com",
    });
    // Injected authentication payloads are refused, not ignored.
    for (const extra of ["code=abc", "state=x", "token=t", "access_token=t"])
      expect(
        parseInstanceHandoff(`${addInstanceLink("https://mail.example.com")}&${extra}`)._tag,
      ).toBe("Rejected");
    expect(parseInstanceHandoff(addInstanceLink("http://mail.example.com"))._tag).toBe("Rejected");
    expect(parseInstanceHandoff(addInstanceLink("https://u:p@mail.example.com"))._tag).toBe(
      "Rejected",
    );
    // The OAuth callback and ordinary links are not handoffs.
    expect(parseInstanceHandoff("bye://oauth/callback?code=x&state=y")._tag).toBe("NotHandoff");
    expect(parseInstanceHandoff("https://mail.example.com")._tag).toBe("NotHandoff");
  });
});

// ---- a fake network of instances ----

type Handler = (init: ProbeFetchInit) => {
  status: number;
  body?: unknown;
  text?: string;
  headers?: Record<string, string>;
  url?: string;
};

const network = (routes: Record<string, Handler>) => {
  const calls: Array<{ url: string; init: ProbeFetchInit }> = [];
  const fetch: ProbeFetch = async (url, init) => {
    calls.push({ url, init });
    const handler = routes[url];
    if (!handler) return { status: 404, text: async () => "" };
    const r = handler(init);
    const headers = new Map(Object.entries(r.headers ?? {}));
    return {
      status: r.status,
      ...(r.url ? { url: r.url } : {}),
      headers: { get: (n: string) => headers.get(n.toLowerCase()) ?? null },
      text: async () => r.text ?? JSON.stringify(r.body ?? {}),
    };
  };
  return { fetch, calls };
};

const instanceDoc = (base: string, issuer = base, extra: Record<string, unknown> = {}) => ({
  schema: "bye.instance/1",
  baseUrl: base,
  issuer,
  api: { min: 1, max: 1 },
  capabilities: ["mail", "device-session", "authorization-response-iss"],
  clients: [{ clientId: "bye-desktop", redirectUris: ["bye://oauth/callback"], loopback: true }],
  routes: { accountDeletion: `${base}/v1/account/close`, support: "https://evil.test/help" },
  ...extra,
});

const asMetadata = (issuer: string, extra: Record<string, unknown> = {}) => ({
  issuer,
  authorization_endpoint: `${issuer}/oauth/authorize`,
  token_endpoint: `${issuer}/oauth/token`,
  revocation_endpoint: `${issuer}/oauth/revoke`,
  code_challenge_methods_supported: ["S256"],
  authorization_response_iss_parameter_supported: true,
  ...extra,
});

const serve = (base: string, doc = instanceDoc(base), meta = asMetadata(doc.issuer as string)) => {
  const origin = /^https:\/\/[^/]+/.exec(doc.issuer as string)![0];
  const path = (doc.issuer as string).slice(origin.length);
  return {
    [`${base}/.well-known/bye-instance`]: () => ({ status: 200, body: doc }),
    [`${origin}/.well-known/oauth-authorization-server${path}`]: () => ({
      status: 200,
      body: meta,
    }),
  } satisfies Record<string, Handler>;
};

const probe = (url: string, fetch: ProbeFetch, extra = {}) =>
  probeInstance(url, {
    fetch,
    clientId: "bye-desktop",
    redirectUri: CUSTOM_SCHEME_REDIRECT,
    now: () => 1,
    ...extra,
  });

describe("instance validation", () => {
  it("validates a self-hosted domain not in the build, without sending any credential", async () => {
    const net = network(serve("https://mail.selfhosted.example/bye"));
    const r = await probe("https://MAIL.selfhosted.example/bye/", net.fetch);
    expect(r._tag).toBe("Valid");
    if (r._tag !== "Valid") return;
    expect(r.instance.baseUrl).toBe("https://mail.selfhosted.example/bye");
    expect(r.instance.issuer).toBe("https://mail.selfhosted.example/bye");
    expect(r.instance.endpoints.token).toBe("https://mail.selfhosted.example/bye/oauth/token");
    // RFC 8414 §3.1: well-known inserted before the issuer's path.
    expect(net.calls[1]!.url).toBe(
      "https://mail.selfhosted.example/.well-known/oauth-authorization-server/bye",
    );
    for (const c of net.calls) {
      expect(c.init.credentials).toBe("omit");
      expect(c.init.redirect).toBe("manual");
      expect(Object.keys(c.init.headers)).toEqual(["accept"]);
    }
    // Routes on foreign origins are dropped.
    expect(r.instance.routes.support).toBeNull();
    expect(r.instance.routes.accountDeletion).toBe(
      "https://mail.selfhosted.example/bye/v1/account/close",
    );
    expect(distinctAuthOrigin(r.instance)).toBeNull();
  });

  it("stops at redirects and canonical-URL changes and presents the new destination", async () => {
    const redirected = network({
      "https://a.example/.well-known/bye-instance": () => ({
        status: 302,
        headers: { location: "https://b.example/.well-known/bye-instance" },
      }),
    });
    expect(await probe("https://a.example", redirected.fetch)).toEqual({
      _tag: "Moved",
      location: "https://b.example/.well-known/bye-instance",
    });
    expect(redirected.calls).toHaveLength(1);
    // React Native follows redirects regardless: a changed final URL still stops validation.
    const followed = network({
      "https://a.example/.well-known/bye-instance": () => ({
        status: 200,
        url: "https://b.example/.well-known/bye-instance",
        body: instanceDoc("https://b.example"),
      }),
    });
    expect((await probe("https://a.example", followed.fetch))._tag).toBe("Moved");
    // The document names a different canonical base URL.
    const moved = network({
      "https://a.example/.well-known/bye-instance": () => ({
        status: 200,
        body: instanceDoc("https://b.example"),
      }),
    });
    expect(await probe("https://a.example", moved.fetch)).toEqual({
      _tag: "Moved",
      location: "https://b.example",
    });
  });

  it("refuses unsupported, incompatible and oversized documents", async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ schema: "bye.instance/9" }, "unsupported-schema"],
      [{ api: { min: 2, max: 3 } }, "incompatible-version"],
      [{ capabilities: ["mail"] }, "missing-capability"],
      [
        { clients: [{ clientId: "bye-mobile", redirectUris: ["bye://oauth/callback"] }] },
        "client-not-registered",
      ],
      [{ issuer: "http://a.example" }, "invalid-issuer"],
    ];
    for (const [patch, reason] of cases) {
      const doc = instanceDoc("https://a.example", "https://a.example", patch);
      const net = network({
        "https://a.example/.well-known/bye-instance": () => ({ status: 200, body: doc }),
      });
      const r = await probe("https://a.example", net.fetch);
      expect(r._tag === "Invalid" && r.reason, reason).toBe(reason);
    }
    const big = network({
      "https://a.example/.well-known/bye-instance": () => ({
        status: 200,
        text: "x".repeat(70_000),
      }),
    });
    expect(await probe("https://a.example", big.fetch)).toEqual({
      _tag: "Invalid",
      reason: "response-too-large",
    });
    const hang: ProbeFetch = () => new Promise(() => undefined);
    expect((await probe("https://a.example", hang, { timeoutMs: 10 }))._tag).toBe("Unreachable");
  });

  it("verifies the exact issuer and refuses endpoints outside the issuer's origin (mix-up)", async () => {
    const base = "https://evil.example";
    // Claims the victim's issuer: the victim's real metadata names the victim, but the probe must
    // fetch it from the victim's issuer-derived location, and the key still includes evil's URL.
    const mismatch = network(
      serve(base, instanceDoc(base), asMetadata(base, { issuer: "https://victim.example" })),
    );
    expect(await probe(base, mismatch.fetch)).toEqual({
      _tag: "Invalid",
      reason: "issuer-mismatch",
    });
    // The victim's authorization endpoint combined with the attacker's token endpoint.
    const combined = network(
      serve(
        base,
        instanceDoc(base),
        asMetadata(base, { authorization_endpoint: "https://victim.example/oauth/authorize" }),
      ),
    );
    expect(await probe(base, combined.fetch)).toEqual({
      _tag: "Invalid",
      reason: "foreign-endpoint",
    });
    const noIss = network(
      serve(
        base,
        instanceDoc(base),
        asMetadata(base, { authorization_response_iss_parameter_supported: false }),
      ),
    );
    expect((await probe(base, noIss.fetch))._tag).toBe("Invalid");
    // A distinct issuer is allowed, and shown before confirmation.
    const split = network(
      serve("https://mail.example", instanceDoc("https://mail.example", "https://id.example")),
    );
    const r = await probe("https://mail.example", split.fetch);
    expect(r._tag === "Valid" && distinctAuthOrigin(r.instance)).toBe("https://id.example");
  });
});

// ---- local state ----

const memoryKv = (): KeyValueStore & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return {
    data,
    getItem: async (k) => data.get(k) ?? null,
    setItem: async (k, v) => void data.set(k, v),
    removeItem: async (k) => void data.delete(k),
  };
};

describe("instance registry and isolation", () => {
  it("saves, selects and removes without falling back to hosted", async () => {
    const reg = new InstanceRegistry(memoryKv());
    const a = testInstance("https://a.example");
    const b = testInstance("https://b.example");
    await reg.save(a, { select: true });
    await reg.save(b);
    expect((await reg.selected())?.key).toBe(a.key);
    await reg.select(b.key);
    expect((await reg.selected())?.key).toBe(b.key);
    await reg.remove(b.key);
    expect(await reg.selected()).toBeNull();
    expect((await reg.list()).map((i) => i.key)).toEqual([a.key]);
    await expect(reg.select("https://nope.example|https://nope.example")).rejects.toThrow();
  });

  it("changed credential destinations invalidate the old record; a copied issuer is refused", async () => {
    const reg = new InstanceRegistry(memoryKv());
    const a = testInstance("https://a.example");
    await reg.save(a, { select: true });
    const moved = {
      ...a,
      endpoints: { ...a.endpoints, token: "https://a.example/oauth/token2" },
    };
    expect(await reg.save(moved)).toEqual({ invalidated: [a.key] });
    const newIssuer = testInstance("https://a.example", "https://id.a.example");
    expect(await reg.save(newIssuer)).toEqual({ invalidated: [a.key] });
    expect((await reg.selected())?.key).toBe(newIssuer.key);
    // Another server claiming a saved issuer with its own endpoints.
    const impostor = {
      ...testInstance("https://evil.example", "https://id.a.example"),
      endpoints: { ...newIssuer.endpoints, token: "https://id.a.example/steal" },
    };
    await expect(reg.save(impostor)).rejects.toBeInstanceOf(InstanceConflictError);
  });

  it("account state is scoped per instance and account; clearing one leaves the other", async () => {
    const kv = memoryKv();
    const a = testInstance("https://a.example");
    const b = testInstance("https://b.example");
    // Same account ID on two servers.
    const sa = scopedStore(kv, accountScope(a.key, "usr_same"), a.key);
    const sb = scopedStore(kv, accountScope(b.key, "usr_same"), b.key);
    await sa.setItem("bye:drafts", "A");
    await sb.setItem("bye:drafts", "B");
    expect(await sa.getItem("bye:drafts")).toBe("A");
    expect(await sb.getItem("bye:drafts")).toBe("B");
    await clearInstanceState(kv, a.key);
    expect(await sa.getItem("bye:drafts")).toBeNull();
    expect(await sb.getItem("bye:drafts")).toBe("B");
  });

  it("registers a scope before writing and blocks writes during instance removal", async () => {
    const kv = memoryKv();
    const instance = testInstance("https://a.example");
    const scope = accountScope(instance.key, "usr_one");
    const old = scopedStore(kv, scope, instance.key);
    const writing = old.setItem("draft", "private");
    const clearing = clearInstanceState(kv, instance.key);
    await Promise.all([writing, clearing]);
    await old.setItem("late-draft", "private");

    expect([...kv.data.keys()].filter((key) => key.includes(instance.key))).toEqual([]);
    expect(await old.getItem("draft")).toBeNull();
  });

  it("tracks concurrent writes from separate handles so clearing removes both", async () => {
    const kv = memoryKv();
    const scope = "server#account";
    const first = scopedStore(kv, scope);
    const second = scopedStore(kv, scope);
    await Promise.all([first.setItem("draft-a", "A"), second.setItem("draft-b", "B")]);

    await scopedStore(kv, scope).clear();
    expect([...kv.data.keys()].filter((key) => key.startsWith(`bye:scope:${scope}::`))).toEqual([]);
  });

  it("drains writes in flight and refuses later writes from a cleared handle", async () => {
    const kv = memoryKv();
    let entered!: () => void;
    let release!: () => void;
    const writing = new Promise<void>((resolve) => (entered = resolve));
    const held = new Promise<void>((resolve) => (release = resolve));
    kv.setItem = async (key, value) => {
      if (key.endsWith("::draft")) {
        entered();
        await held;
      }
      kv.data.set(key, value);
    };

    const old = scopedStore(kv, "server#account");
    const pending = old.setItem("draft", "private");
    await writing;
    const clearing = scopedStore(kv, "server#account").clear();
    release();
    await Promise.all([pending, clearing]);
    await old.setItem("late-draft", "private");
    expect(
      [...kv.data.keys()].filter((key) => key.startsWith("bye:scope:server#account::")),
    ).toEqual([]);

    const fresh = scopedStore(kv, "server#account");
    await fresh.setItem("new-draft", "new session");
    expect(await fresh.getItem("new-draft")).toBe("new session");
    expect(await old.getItem("new-draft")).toBeNull();
  });
});

// ---- authentication bound to its instance ----

class Store implements SecureSessionStore {
  data = new Map<string, string>();
  async read(k: string) {
    const v = this.data.get(k);
    if (v === undefined) throw new SecureStoreError("MissingCredential");
    return v;
  }
  async write(k: string, v: string) {
    this.data.set(k, v);
  }
  async remove(k: string) {
    this.data.delete(k);
  }
}

const authServer = () => {
  const tokenCalls: Array<string> = [];
  let n = 0;
  let release: (() => void) | null = null;
  const state = { hold: false };
  const fetch: TokenFetch = async (url, init) => {
    tokenCalls.push(url);
    expect(init.redirect).toBe("error");
    if (state.hold) await new Promise<void>((r) => (release = r));
    const form = new URLSearchParams(init.body);
    if (url.endsWith("/oauth/revoke")) return { status: 200, text: async () => "{}" };
    if (
      form.get("grant_type") === "authorization_code" ||
      form.get("grant_type") === "refresh_token"
    )
      return {
        status: 200,
        text: async () =>
          JSON.stringify({
            access_token: `at_${++n}`,
            token_type: "Bearer",
            expires_in: 900,
            refresh_token: `rt_${url}_${n}_${"r".repeat(16)}`,
          }),
      };
    return { status: 400, text: async () => '{"error":"invalid_grant"}' };
  };
  return { fetch, tokenCalls, state, release: () => release?.() };
};

const callbackFor = (attemptUrl: string, iss: string | null, code = `code_${"x".repeat(12)}`) => {
  const q = new URLSearchParams(attemptUrl.split("?")[1]);
  return `bye://oauth/callback?code=${code}&state=${encodeURIComponent(q.get("state")!)}${iss === null ? "" : `&iss=${encodeURIComponent(iss)}`}`;
};

describe("sign-in bound to its instance (RFC 9207)", () => {
  const A = testInstance("https://a.example");
  const B = testInstance("https://b.example");
  let now = Date.UTC(2026, 8, 26, 12);
  const make = (instance = A, store = new Store(), server = authServer()) => ({
    store,
    server,
    session: new SessionClient({
      instance,
      redirectUri: CUSTOM_SCHEME_REDIRECT,
      deviceName: "Mac",
      fetch: server.fetch,
      store,
      openBrowser: async () => undefined,
      now: () => now,
    }),
  });

  it("A's callback delivered after switching to B is refused without any code exchange", async () => {
    const store = new Store();
    const server = authServer();
    const a = make(A, store, server);
    await a.session.restore();
    const attemptA = await a.session.beginSignIn();
    a.session.dispose(); // switch
    const b = make(B, store, server);
    await b.session.restore();
    await b.session.beginSignIn();
    expect(await b.session.handleCallback(callbackFor(attemptA.url, A.issuer))).toBe(true);
    expect(await a.session.handleCallback(callbackFor(attemptA.url, A.issuer))).toBe(true);
    expect(server.tokenCalls).toEqual([]);
    expect(b.session.state._tag).toBe("Authorizing");
    expect(store.data.size).toBe(0);
  });

  it("missing or wrong issuer, expiry and replay fail before any exchange", async () => {
    for (const iss of [null, B.issuer, "https://a.example/"]) {
      const a = make();
      await a.session.restore();
      const attempt = await a.session.beginSignIn();
      expect(await a.session.handleCallback(callbackFor(attempt.url, iss))).toBe(true);
      expect(a.session.state).toEqual({ _tag: "SignedOut", reason: "failed" });
      expect(a.server.tokenCalls).toEqual([]);
    }
    const expired = make();
    await expired.session.restore();
    const attempt = await expired.session.beginSignIn();
    now += 11 * 60_000;
    await expired.session.handleCallback(callbackFor(attempt.url, A.issuer));
    expect(expired.server.tokenCalls).toEqual([]);
    const ok = make();
    await ok.session.restore();
    const good = callbackFor((await ok.session.beginSignIn()).url, A.issuer);
    await ok.session.handleCallback(good);
    expect(ok.session.state._tag).toBe("SignedIn");
    await ok.session.handleCallback(good); // replay: no attempt any more
    expect(ok.server.tokenCalls).toEqual([A.endpoints.token]);
  });

  it("tokens go only to the validated endpoints; same account on two servers never shares a slot", async () => {
    const store = new Store();
    const a = make(A, store);
    await a.session.restore();
    await a.session.handleCallback(callbackFor((await a.session.beginSignIn()).url, A.issuer));
    const b = make(B, store);
    await b.session.restore();
    expect(b.session.state._tag).toBe("SignedOut"); // A's credential is not B's
    await b.session.handleCallback(callbackFor((await b.session.beginSignIn()).url, B.issuer));
    expect(a.server.tokenCalls.every((u) => u.startsWith("https://a.example/"))).toBe(true);
    expect(b.server.tokenCalls.every((u) => u.startsWith("https://b.example/"))).toBe(true);
    expect([...store.data.keys()].sort()).toEqual([sessionKey(A.key), sessionKey(B.key)].sort());
  });

  it("a switch during code exchange or refresh never restores the old session", async () => {
    const a = make();
    await a.session.restore();
    const cb = callbackFor((await a.session.beginSignIn()).url, A.issuer);
    a.server.state.hold = true;
    const pending = a.session.handleCallback(cb);
    await Promise.resolve();
    a.session.dispose();
    a.server.release();
    await pending;
    expect(a.store.data.size).toBe(0);
    expect(await a.session.accessToken()).toBeNull();
  });

  it("forget clears the slot even when the server is unreachable, and reports it", async () => {
    const a = make();
    await a.session.restore();
    await a.session.handleCallback(callbackFor((await a.session.beginSignIn()).url, A.issuer));
    const offline = new SessionClient({
      instance: A,
      redirectUri: CUSTOM_SCHEME_REDIRECT,
      deviceName: "Mac",
      fetch: async () => {
        throw new TypeError("Network request failed");
      },
      store: a.store,
      openBrowser: async () => undefined,
    });
    expect(await offline.forget()).toBe("unconfirmed");
    expect(a.store.data.size).toBe(0);
  });

  it("migrates a pre-instance hosted credential only into the matching instance slot", async () => {
    const store = new Store();
    const legacy = JSON.stringify({
      v: 1,
      refreshToken: `rt_legacy_${"r".repeat(16)}`,
      scope: "",
      savedAt: 1,
    });
    store.data.set("email.bye.desktop.session.v1|https://a.example", legacy);
    const b = make(B, store);
    await b.session.restore();
    expect(b.session.state._tag).toBe("SignedOut");
    const a = make(A, store);
    await a.session.restore();
    expect(a.session.state._tag).toBe("SignedIn");
    expect(store.data.has("email.bye.desktop.session.v1|https://a.example")).toBe(false);
  });
});
