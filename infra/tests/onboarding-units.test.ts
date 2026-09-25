// Direct tests for the onboarding HTTP surface (server.ts), health checks (health.ts) and release
// pinning (release.ts); the end-to-end service flow is in onboarding.test.ts.
import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, type KeyObject, sign as cryptoSign } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterAll, describe, expect, it, vi } from "vitest";
import { accessVerifier } from "../onboarding/access.ts";
import { runHealthChecks, withTimeout } from "../onboarding/health.ts";
import type { Fetch } from "../onboarding/oauth.ts";
import { releaseMigrations, resolveRelease } from "../onboarding/release.ts";
import { handler, signSession } from "../onboarding/server.ts";
import { OnboardingError, type OnboardingService } from "../onboarding/service.ts";

const ORIGIN = "https://onboard.test";
const SESSION = "s".repeat(43);
const SECRET = Buffer.alloc(32, 7);
/** The cookie this server issues for SESSION. */
const SIGNED = signSession(SECRET, SESSION);

describe("onboarding server", () => {
  const service = {
    status: vi.fn(async (op: string) => ({ operator: op })),
    startAuthorization: vi.fn(async (_op: string, session: string) => ({ url: session })),
    completeAuthorization: vi.fn(async () => ({ ok: false, reason: "state mismatch" })),
    review: vi.fn(async () => {
      throw new OnboardingError("not_ready", "bind an account first", "Choose an account");
    }),
    disconnect: vi.fn(async () => {
      throw new Error("secret-bearing internal detail");
    }),
  };

  const call = async (
    method: string,
    path: string,
    headers: Record<string, string> = {},
    body = "",
    operator: string | null = "op@example.com",
  ) => {
    const req = Object.assign(Readable.from(body ? [Buffer.from(body)] : []), {
      method,
      url: path,
      headers,
    }) as unknown as IncomingMessage;
    const out = { status: 0, headers: {} as Record<string, string>, body: "" };
    const res = {
      writeHead: (status: number, h: Record<string, string>) => {
        out.status = status;
        out.headers = h;
      },
      end: (chunk?: string) => {
        out.body = chunk ?? "";
      },
    } as unknown as ServerResponse;
    await handler({
      service: service as unknown as OnboardingService,
      origin: ORIGIN,
      operator: () => operator,
      sessionSecret: SECRET,
    })(req, res);
    return out;
  };
  const post = (path: string, headers: Record<string, string> = {}) =>
    call("POST", path, { origin: ORIGIN, "content-type": "application/json", ...headers }, "{}");

  it("OB01: refuses requests the access proxy has not authenticated", async () => {
    const r = await call("GET", "/api/status", {}, "", null);
    expect(r.status).toBe(401);
    expect(service.status).not.toHaveBeenCalled();
  });

  it("OB01: issues a __Host- session cookie once and binds OAuth to the presented session", async () => {
    const fresh = await call("GET", "/");
    expect(fresh.status).toBe(200);
    const cookie = fresh.headers["set-cookie"]!;
    expect(cookie).toMatch(
      /^__Host-bye-onboarding=[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=86400$/,
    );
    expect(fresh.headers["content-security-policy"]).toContain("frame-ancestors 'none'");

    const issued = cookie.split(";")[0]!.split("=")[1]!;
    const again = await post("/api/authorize", {
      cookie: `theme=dark; __Host-bye-onboarding=${issued}`,
    });
    expect(again.headers["set-cookie"]).toBeUndefined();
    // The service sees the session id, never the MAC.
    expect(JSON.parse(again.body)).toEqual({ url: issued.split(".")[0] });
  });

  it("OB01: a client-chosen (unsigned or forged) session id is replaced, never adopted", async () => {
    for (const cookie of [
      `__Host-bye-onboarding=${SESSION}`,
      `__Host-bye-onboarding=${SESSION}.${"A".repeat(43)}`,
      `__Host-bye-onboarding=${signSession(Buffer.alloc(32, 9), SESSION)}`,
    ]) {
      const r = await post("/api/authorize", { cookie });
      const session = (JSON.parse(r.body) as { url: string }).url;
      expect(session).not.toBe(SESSION);
      expect(r.headers["set-cookie"]).toContain(`__Host-bye-onboarding=${session}.`);
    }
  });

  it("OB01: CSP has no 'unsafe-inline'; the page's script and style are same-origin assets", async () => {
    const page = await call("GET", "/");
    const csp = page.headers["content-security-policy"]!;
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("style-src 'self'");
    expect(page.body).not.toMatch(/<script>|<style>|\sstyle=|\son[a-z]+=/);
    expect(page.body).toContain('<script src="/app.js"></script>');
    const js = await call("GET", "/app.js");
    expect(js.status).toBe(200);
    expect(js.headers["content-type"]).toContain("javascript");
    expect(js.body).toContain("refresh()");
    const css = await call("GET", "/app.css");
    expect(css.headers["content-type"]).toContain("text/css");
  });

  it("OB01: a malformed or look-alike cookie is not a session", async () => {
    for (const cookie of [
      "__Host-bye-onboarding=short",
      "__Host-bye-onboarding=has.dots.in.it.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      `x__Host-bye-onboarding=${SESSION}`,
    ]) {
      const r = await post("/api/authorize", { cookie });
      const session = (JSON.parse(r.body) as { url: string }).url;
      expect(session).not.toBe(SESSION);
      expect(r.headers["set-cookie"]).toContain(`__Host-bye-onboarding=${session}.`);
    }
  });

  it("OB01: state changes need a same-origin JSON request (CSRF)", async () => {
    service.startAuthorization.mockClear();
    const refused = [
      await post("/api/authorize", { origin: "https://evil.test" }),
      await post("/api/authorize", { origin: "https://onboard.test.evil.test" }),
      await call("POST", "/api/authorize", { "content-type": "application/json" }, "{}"),
      await post("/api/authorize", { "content-type": "text/plain" }),
      await post("/api/authorize", { "content-type": "application/x-www-form-urlencoded" }),
    ];
    for (const r of refused) expect(r.status).toBe(403);
    expect(service.startAuthorization).not.toHaveBeenCalled();

    const accepted = await post("/api/authorize", { cookie: `__Host-bye-onboarding=${SIGNED}` });
    expect(accepted.status).toBe(200);
    expect(service.startAuthorization).toHaveBeenCalledWith("op@example.com", SESSION);
  });

  it("OB01: unknown routes are 404, other methods 405, malformed input 400", async () => {
    expect((await call("GET", "/api/nope")).status).toBe(404);
    expect((await call("GET", "/api/authorize")).status).toBe(404);
    expect((await post("/api/nope")).status).toBe(404);
    expect((await call("PUT", "/api/status")).status).toBe(405);
    expect((await call("DELETE", "/")).status).toBe(405);
    const invalid = await call(
      "POST",
      "/api/bind",
      { origin: ORIGIN, "content-type": "application/json" },
      "{not json",
    );
    expect(invalid.status).toBe(400);
    const missing = await post("/api/bind");
    expect(missing.status).toBe(400);
    expect(JSON.parse(missing.body)).toMatchObject({ error: "accountId is required" });
  });

  it("OB01: the OAuth callback redirects home with the failure reason", async () => {
    const r = await call("GET", "/oauth/callback?state=x&code=y");
    expect(r.status).toBe(303);
    expect(r.headers.location).toBe("/?error=state%20mismatch");
  });

  it("OB06: service errors map to statuses with a next action; internal errors leak nothing", async () => {
    const notReady = await post("/api/review");
    expect(notReady.status).toBe(409);
    expect(JSON.parse(notReady.body)).toEqual({
      error: "bind an account first",
      code: "not_ready",
      nextAction: "Choose an account",
    });
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const internal = await post("/api/disconnect");
    expect(internal.status).toBe(500);
    expect(internal.body).not.toContain("secret-bearing");
    expect(log.mock.calls.flat().join(" ")).not.toContain("secret-bearing");
    log.mockRestore();
  });
});

describe("onboarding health checks", () => {
  const urls = {
    app: "https://app.test",
    site: "https://site.test",
    render: "https://render.test",
  };
  const json = (v: unknown, status = 200) =>
    new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });

  it("OB06: each discovery and isolation check names what failed", async () => {
    const fetcher: Fetch = async (url) => {
      const u = new URL(url);
      if (u.pathname === "/.well-known/bye-instance")
        return json({ schema: "bye.instance/1", baseUrl: "https://other.test" });
      if (u.pathname === "/.well-known/oauth-authorization-server")
        return json({ issuer: urls.app });
      if (u.origin === urls.render) return json({ ok: true });
      if (u.origin === urls.site) return new Response("down", { status: 502 });
      return json({}, 404);
    };
    const results = await runHealthChecks(urls, "probe", fetcher, { request: 100, async: 10 });
    const byName = Object.fromEntries(results.map((r) => [r.name, r]));
    expect(byName["instance.document"]).toMatchObject({
      ok: false,
      detail: "status 200, baseUrl https://other.test",
    });
    expect(byName["instance.oauth-metadata"]).toMatchObject({ ok: true });
    expect(byName["render.isolated"]).toMatchObject({
      ok: false,
      detail: "render host /v1/me → 200",
    });
    expect(byName["public.reachable"]).toMatchObject({ ok: false, detail: "status 502" });
    expect(byName["http.unauthenticated"]?.ok).toBe(false);
  });

  it("OB06: a hung endpoint times out instead of stalling, and redirects are not followed", async () => {
    const seen: Array<RequestInit | undefined> = [];
    const hung: Fetch = (_url, init) => {
      seen.push(init);
      return new Promise((_, reject) =>
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)),
      );
    };
    const results = await runHealthChecks(urls, "probe", hung, { request: 20, async: 10 });
    expect(results.slice(0, 4).map((r) => [r.name, r.ok, r.detail])).toEqual([
      ["instance.document", false, "timed out"],
      ["instance.oauth-metadata", false, "timed out"],
      ["render.isolated", false, "timed out"],
      ["public.reachable", false, "timed out"],
    ]);
    expect(results.every((r) => !r.ok)).toBe(true);
    expect(seen[0]?.redirect).toBe("manual");

    const wrapped = vi.fn<Fetch>(async () => new Response("ok"));
    await withTimeout(wrapped, 1000)("https://x.test", { method: "POST", redirect: "follow" });
    expect(wrapped.mock.calls[0]?.[1]).toMatchObject({ method: "POST", redirect: "manual" });
  });
});

describe("onboarding release pinning", () => {
  const dir = mkdtempSync(join(tmpdir(), "bye-release-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args: Array<string>) =>
    execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: "pipe" }).trim();
  git("init", "-q");
  git("config", "user.email", "release@example.com");
  git("config", "user.name", "release");
  git("config", "commit.gpgsign", "false");
  git("config", "tag.gpgsign", "false");
  writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  git("add", ".");
  git("commit", "-q", "-m", "release");
  git("tag", "v1.2.3");

  it("OB03: a clean checkout at the tag resolves to its commit and lockfile digest", () => {
    const r = resolveRelease(dir, "v1.2.3");
    expect(r).toEqual({
      ok: true,
      release: {
        dir,
        ref: {
          version: "v1.2.3",
          commit: git("rev-parse", "HEAD"),
          lockfileDigest: createHash("sha256").update("lockfileVersion: '9.0'\n").digest("hex"),
        },
      },
    });
  });

  it("OB03: refuses non-release refs, unknown tags, moved HEADs and local modifications", () => {
    expect(resolveRelease(dir, "main")).toMatchObject({ ok: false });
    expect(resolveRelease(dir, "v1.2.3; rm -rf /")).toMatchObject({ ok: false });
    expect(resolveRelease(dir, "v9.9.9")).toEqual({
      ok: false,
      reason: "release v9.9.9 is not available in the release checkout",
    });

    writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.1'\n");
    expect(resolveRelease(dir, "v1.2.3")).toEqual({
      ok: false,
      reason: "release checkout has local modifications",
    });
    git("commit", "-q", "-am", "next");
    expect(resolveRelease(dir, "v1.2.3")).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/^release checkout is not at v1\.2\.3 \([0-9a-f]{12}\)$/),
    });
  });

  it("OB03: release migrations list D1 files and Durable Object tags per host, sorted", async () => {
    const empty = mkdtempSync(join(tmpdir(), "bye-release-empty-"));
    expect(await releaseMigrations(empty)).toEqual([]);
    rmSync(empty, { recursive: true, force: true });

    const d1 = join(dir, "infra/migrations/d1");
    mkdirSync(d1, { recursive: true });
    writeFileSync(join(d1, "0002_b.sql"), "");
    writeFileSync(join(d1, "0001_a.sql"), "");
    writeFileSync(join(d1, "README.md"), "");
    expect(await releaseMigrations(dir)).toEqual(["d1:0001_a.sql", "d1:0002_b.sql"]);

    const repo = await releaseMigrations(join(import.meta.dirname, "../.."));
    expect(repo.some((m) => m.startsWith("d1:"))).toBe(true);
    expect(repo.some((m) => /^do:[A-Za-z]+:.+/.test(m))).toBe(true);
    expect(repo).toEqual([...repo].sort());
  });
});

describe("Cloudflare Access JWT verification (operator identity)", () => {
  const TEAM = "https://team.cloudflareaccess.com";
  const AUD = "aud-tag-123";
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" };
  const NOW = 1_800_000_000_000;
  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const jwt = (
    claims: Record<string, unknown>,
    opts: { kid?: string; alg?: string; key?: KeyObject } = {},
  ) => {
    const h = b64({ alg: opts.alg ?? "RS256", kid: opts.kid ?? "k1", typ: "JWT" });
    const p = b64({
      iss: TEAM,
      aud: [AUD],
      email: "op@example.com",
      exp: NOW / 1000 + 300,
      iat: NOW / 1000,
      ...claims,
    });
    const sig = cryptoSign("RSA-SHA256", Buffer.from(`${h}.${p}`), opts.key ?? privateKey);
    return `${h}.${p}.${Buffer.from(sig).toString("base64url")}`;
  };
  const make = () => {
    const certs = vi.fn(async (_url: string) => Response.json({ keys: [jwk] }));
    const verify = accessVerifier({
      teamDomain: "team.cloudflareaccess.com",
      audience: AUD,
      fetch: certs as unknown as Fetch,
      now: () => NOW,
    });
    return { certs, verify };
  };

  it("accepts a valid token and caches the team keys", async () => {
    const { certs, verify } = make();
    expect(await verify(jwt({}))).toBe("op@example.com");
    expect(await verify(jwt({ aud: AUD }))).toBe("op@example.com");
    expect(await verify(jwt({}))).toBe("op@example.com");
    expect(certs).toHaveBeenCalledTimes(1);
    expect(certs).toHaveBeenCalledWith(`${TEAM}/cdn-cgi/access/certs`);
  });

  it("rejects bad signatures, wrong issuer/audience, expiry, other algorithms and garbage", async () => {
    const { verify } = make();
    const valid = jwt({});
    const [h, p] = valid.split(".");
    const forgedClaims = `${h}.${b64({ iss: TEAM, aud: [AUD], email: "admin@example.com", exp: NOW / 1000 + 300 })}.${valid.split(".")[2]}`;
    for (const token of [
      jwt({}, { key: other.privateKey }),
      forgedClaims,
      `${h}.${p}.`,
      jwt({ iss: "https://evil.cloudflareaccess.com" }),
      jwt({ aud: ["another-app"] }),
      jwt({ exp: NOW / 1000 - 3600 }),
      jwt({ nbf: NOW / 1000 + 3600 }),
      jwt({ email: "" }),
      jwt({}, { alg: "HS256" }),
      jwt({}, { kid: "unknown" }),
      "not.a.jwt",
      "",
      null,
    ])
      expect(await verify(token)).toBeNull();
  });

  it("fails closed when the team keys cannot be fetched", async () => {
    const verify = accessVerifier({
      teamDomain: TEAM,
      audience: AUD,
      fetch: (async () => {
        throw new Error("offline");
      }) as unknown as Fetch,
      now: () => NOW,
    });
    expect(await verify(jwt({}))).toBeNull();
  });
});
