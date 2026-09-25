import { describe, expect, it, vi } from "vitest";
import { handlePublic, type PublicEnv, type PublicGatewayRpc, publishedKey } from "../src/index.ts";

const makeEnv = (
  objects: Record<string, string>,
  gateway: Partial<PublicGatewayRpc> = {},
  allow = true,
) => {
  const calls: Array<string> = [];
  const limited: Array<string> = [];
  const env = {
    APP_ORIGIN: "https://app.pub.test",
    PUBLISHED: {
      get: async (key: string) => (key in objects ? { body: objects[key], httpEtag: '"e"' } : null),
    },
    PUBLIC_RATE_LIMIT: {
      limit: async ({ key }: { key: string }) => (limited.push(key), { success: allow }),
    },
    CORE: {
      resolveShareLink: async (sp: string, t: string) => (
        calls.push(`share:${sp}:${t}`),
        gateway.resolveShareLink ? gateway.resolveShareLink(sp, t) : null
      ),
      subscribe: async (h: string, a: string) => (
        calls.push(`sub:${h}:${a}`),
        gateway.subscribe ? gateway.subscribe(h, a) : { ok: true }
      ),
      confirmSubscription: async (h: string, t: string) => (
        calls.push(`confirm:${h}:${t}`),
        gateway.confirmSubscription ? gateway.confirmSubscription(h, t) : { ok: true }
      ),
      unsubscribe: async (h: string, a: string, t: string) => (
        calls.push(`unsub:${h}:${a}:${t}`),
        gateway.unsubscribe ? gateway.unsubscribe(h, a, t) : { ok: true }
      ),
    },
  } as unknown as PublicEnv;
  return { env, calls, limited };
};

/** Status, body and headers: everything a client (or an enumerating attacker) can observe. */
const observable = async (res: Response) => ({
  status: res.status,
  body: await res.text(),
  headers: [...res.headers.entries()].sort(([a], [b]) => a.localeCompare(b)),
});

const post = (path: string, body: string, ip = "203.0.113.9") =>
  new Request(`https://pub.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": ip },
    body,
  });

const get = (path: string, init?: RequestInit) => new Request(`https://pub.test${path}`, init);

describe("public worker", () => {
  it("[P01] serves published posts and RSS from the public bucket only", async () => {
    const { env } = makeEnv({
      [publishedKey.post("ana", "hello-world")]: "<h1>Hello</h1>",
      [publishedKey.feed("ana")]: "<rss/>",
    });
    const post = await handlePublic(get("/@ana/hello-world"), env);
    expect(post.status).toBe(200);
    expect(await post.text()).toBe("<h1>Hello</h1>");
    expect(post.headers.get("content-security-policy")).toContain("default-src 'none'");
    const feed = await handlePublic(get("/@ana/feed.xml"), env);
    expect(feed.headers.get("content-type")).toContain("rss");
    expect((await handlePublic(get("/@ana/unpublished"), env)).status).toBe(404);
    expect((await handlePublic(get("/@ANA/../x"), env)).status).toBe(404);
  });

  it("[O05] share links resolve through the gateway, escape metadata and are never cached", async () => {
    const { env, calls } = makeEnv(
      {},
      {
        resolveShareLink: async () => ({
          subject: "<script>x</script>",
          messages: [{ from: "a@x.com", date: 0, subject: "s", html: "<p>ok</p>" }],
        }),
      },
    );
    const res = await handlePublic(get("/s/spc_1/abcdefghijklmnop1234"), env);
    const body = await res.text();
    expect(calls).toEqual(["share:spc_1:abcdefghijklmnop1234"]);
    expect(body).toContain("&lt;script&gt;");
    // Each message body sits in its own paint-contained box, so it can't draw over the page.
    expect(body).toContain('<div class="msg"><p>ok</p></div>');
    expect(body).toContain(".msg{contain:paint;overflow:hidden;position:relative}");
    expect(body).not.toContain("<script>x");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-robots-tag")).toContain("noindex");
  });

  it("[O05] revoked and malformed share tokens get the same 404; malformed ones and rate-limited requests never reach MailCore", async () => {
    const { env, calls, limited } = makeEnv({});
    const ip = { headers: { "cf-connecting-ip": "198.51.100.7" } };
    // A well-formed token is forwarded verbatim; MailCore says revoked (null) → 404.
    const revoked = await handlePublic(get("/s/spc_1/revokedtoken123456789", ip), env);
    // Malformed tokens and space ids are rejected locally, without an RPC or a rate-limit hit.
    const badToken = await handlePublic(get("/s/spc_1/bad!", ip), env);
    const badSpace = await handlePublic(get("/s/sp/abcdefghijklmnop1234", ip), env);
    expect(calls).toEqual(["share:spc_1:revokedtoken123456789"]);
    expect(limited).toEqual(["share:198.51.100.7"]);
    const [a, b, c] = await Promise.all([revoked, badToken, badSpace].map(observable));
    expect(a!.status).toBe(404);
    expect(b).toEqual(a);
    expect(c).toEqual(a);
    expect(Object.fromEntries(a!.headers)["cache-control"]).toBe("no-store");

    const throttled = makeEnv({}, {}, false);
    const res = await handlePublic(get("/s/spc_1/abcdefghijklmnop1234", ip), throttled.env);
    expect([res.status, res.headers.get("cache-control")]).toEqual([429, "no-store"]);
    expect(throttled.calls).toEqual([]);
  });

  it("[P02] subscribing gives identical responses for existing and new subscribers and forwards a normalized address", async () => {
    // MailCore distinguishes the two cases internally; the public response must not.
    const existing = new Set(["reader@example.com"]);
    const { env, calls, limited } = makeEnv(
      {},
      { subscribe: async (_h, a) => ({ ok: !existing.has(a) }) },
    );
    const known = await handlePublic(
      post("/@ana/subscribe", "email=%20Reader%40Example.com%20"),
      env,
    );
    const fresh = await handlePublic(post("/@ana/subscribe", "email=new%40example.com"), env);
    expect(calls).toEqual(["sub:ana:reader@example.com", "sub:ana:new@example.com"]);
    expect(limited).toEqual([
      "sub:203.0.113.9",
      "sub:ana:reader@example.com",
      "sub:203.0.113.9",
      "sub:ana:new@example.com",
    ]);
    const [k, f] = await Promise.all([known, fresh].map(observable));
    expect(k!.status).toBe(202);
    expect(k).toEqual(f);
    expect(k!.body).toContain("Check your email to confirm.");

    // Invalid input is refused locally; a throttled request never reaches MailCore.
    expect((await handlePublic(post("/@ana/subscribe", "email=nope"), env)).status).toBe(400);
    expect(calls).toHaveLength(2);
    const throttled = makeEnv({}, {}, false);
    expect(
      (await handlePublic(post("/@ana/subscribe", "email=r%40x.com"), throttled.env)).status,
    ).toBe(429);
    expect(throttled.calls).toEqual([]);
  });

  it("[P02] confirmation forwards the token and maps MailCore's answer; malformed tokens stay local", async () => {
    const { env, calls } = makeEnv(
      {},
      { confirmSubscription: async (_h, t) => ({ ok: t === "goodtoken12345678" }) },
    );
    const ok = await handlePublic(get("/@ana/confirm/goodtoken12345678"), env);
    expect([ok.status, ok.headers.get("cache-control")]).toEqual([200, "no-store"]);
    expect(await ok.text()).toContain("You're subscribed.");
    expect((await handlePublic(get("/@ana/confirm/expiredtoken12345"), env)).status).toBe(410);
    expect((await handlePublic(get("/@ana/confirm/short"), env)).status).toBe(404);
    expect(calls).toEqual(["confirm:ana:goodtoken12345678", "confirm:ana:expiredtoken12345"]);
  });

  it("[P02] one-click unsubscribe forwards handle, normalized address and token (form body or RFC 8058 query) and maps the result", async () => {
    const { env, calls } = makeEnv(
      {},
      { unsubscribe: async (_h, _a, t) => ({ ok: t === "tok_valid_unsub_1234" }) },
    );
    const ok = await handlePublic(
      post("/@ana/unsubscribe", "email=R%40X.com&token=tok_valid_unsub_1234"),
      env,
    );
    expect([ok.status, ok.headers.get("cache-control")]).toEqual([200, "no-store"]);
    expect(await ok.text()).toContain("You're unsubscribed.");
    // RFC 8058: mail clients POST `List-Unsubscribe=One-Click` to the header URL with its query.
    const oneClick = await handlePublic(
      post(
        "/@ana/unsubscribe?email=R%40X.com&token=tok_valid_unsub_1234",
        "List-Unsubscribe=One-Click",
      ),
      env,
    );
    expect(oneClick.status).toBe(200);
    const bad = await handlePublic(post("/@ana/unsubscribe", "email=r%40x.com&token=forged"), env);
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain("This link is invalid.");
    expect(calls).toEqual([
      "unsub:ana:r@x.com:tok_valid_unsub_1234",
      "unsub:ana:r@x.com:tok_valid_unsub_1234",
      "unsub:ana:r@x.com:forged",
    ]);
  });

  it("[P02] the footer's GET unsubscribe link shows a confirm form and never unsubscribes by itself", async () => {
    const { env, calls } = makeEnv({});
    const page = await handlePublic(
      get("/@ana/unsubscribe?email=r%40x.com&token=tok_valid_unsub_1234"),
      env,
    );
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('<form method="post" action="/@ana/unsubscribe">');
    expect(html).toContain('value="r@x.com"');
    expect(html).toContain('value="tok_valid_unsub_1234"');
    expect(calls).toEqual([]); // link scanners prefetching the URL change nothing
    expect(
      (await handlePublic(get("/@ana/unsubscribe?email=r%40x.com&token=%3Cbad%3E"), env)).status,
    ).toBe(400);
  });

  it("healthz answers 200 without touching bindings; failures become the worker's own no-store 503", async () => {
    const { env, calls, limited } = makeEnv({});
    const health = await handlePublic(get("/healthz"), env);
    expect([health.status, health.headers.get("cache-control"), await health.text()]).toEqual([
      200,
      "no-store",
      "ok",
    ]);
    expect(calls).toEqual([]);
    expect(limited).toEqual([]);

    const broken = makeEnv(
      {},
      {
        resolveShareLink: async () => {
          throw new Error("rpc down: secret detail");
        },
        subscribe: async () => {
          throw new Error("rpc down");
        },
      },
    );
    const errors: Array<string> = [];
    const spy = vi.spyOn(console, "error").mockImplementation((l) => void errors.push(String(l)));
    try {
      for (const req of [
        get("/s/spc_1/abcdefghijklmnop1234"),
        post("/@ana/subscribe", "email=a%40b.com"),
      ]) {
        const res = await handlePublic(req, broken.env);
        expect(res.status).toBe(503);
        expect(res.headers.get("cache-control")).toBe("no-store");
        expect(await res.text()).not.toContain("secret detail");
      }
      (broken.env as { PUBLISHED: unknown }).PUBLISHED = {
        get: async () => {
          throw new Error("r2 down");
        },
      };
      expect((await handlePublic(get("/@ana/post"), broken.env)).status).toBe(503);
      expect(errors.join("\n")).not.toContain("secret detail");
    } finally {
      spy.mockRestore();
    }
  });

  it("forms are read with a byte cap even without content-length; oversize posts never reach MailCore", async () => {
    const { env, calls } = makeEnv({});
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        if (pulled > 1000) controller.close();
        else
          controller.enqueue(new TextEncoder().encode(`email=a%40b.com&pad=${"x".repeat(1024)}`));
      },
    });
    const req = new Request("https://pub.test/@ana/subscribe", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: stream,
      duplex: "half",
    } as RequestInit);
    const res = await handlePublic(req, env);
    expect(res.status).toBe(413);
    expect(pulled).toBeLessThan(10);
    expect(calls).toEqual([]);
  });

  it("[P02] subscribe uses its own limiter and a per-target bucket; a throttled target is silent", async () => {
    const { env, calls, limited } = makeEnv({});
    const subLimited: Array<string> = [];
    (env as { SUBSCRIBE_RATE_LIMIT: unknown }).SUBSCRIBE_RATE_LIMIT = {
      limit: async ({ key }: { key: string }) => (
        subLimited.push(key),
        { success: !key.includes("victim") }
      ),
    };
    const a = await handlePublic(post("/@ana/subscribe", "email=victim%40x.com"), env);
    const b = await handlePublic(post("/@ana/subscribe", "email=ok%40x.com"), env);
    expect(subLimited).toEqual([
      "sub:203.0.113.9",
      "sub:ana:victim@x.com",
      "sub:203.0.113.9",
      "sub:ana:ok@x.com",
    ]);
    expect(limited).toEqual([]);
    expect(calls).toEqual(["sub:ana:ok@x.com"]);
    const [oa, ob] = await Promise.all([a, b].map(observable));
    expect(oa).toEqual(ob);
  });

  it("[P01] with the image-proxy origin bound, img-src is pinned to it", async () => {
    const { env } = makeEnv({ [publishedKey.post("ana", "p")]: "<h1>x</h1>" });
    const open = await handlePublic(get("/@ana/p"), env);
    expect(open.headers.get("content-security-policy")).toContain("img-src 'self' https: data:");
    (env as { MAIL_ORIGIN: string }).MAIL_ORIGIN = "https://mail.render.test";
    const pinned = await handlePublic(get("/@ana/p"), env);
    const csp = pinned.headers.get("content-security-policy")!;
    expect(csp).toContain("img-src 'self' https://mail.render.test data:");
    expect(csp).not.toContain(" https: ");
  });
});
