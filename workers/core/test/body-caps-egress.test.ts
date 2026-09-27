import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ControlAuth, ControlDirectory } from "@bye/platform-cloudflare";
import { handleFetch } from "../src/api.ts";
import { kernelClock } from "../src/durable-host.ts";
import { guardedFetch } from "../src/dns.ts";
import { WEBHOOK_MAX_BYTES } from "../src/routes/webhooks.ts";
import { authConfig } from "../src/services.ts";
import { type Harness, makeHarness } from "./harness.ts";

// Streaming body caps on the unauthenticated webhooks and the vCard import, and the guarded fetch
// used for user-chosen external-identity endpoints.

(globalThis as { FixedLengthStream?: unknown }).FixedLengthStream = class extends TransformStream {
  constructor(_length: number) {
    super();
  }
};

const ctx = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
} as unknown as ExecutionContext;

/** A chunked body with no Content-Length that records how much of it was pulled. */
const chunked = (chunks: number, size = 64 * 1024) => {
  const state = { pulled: 0, cancelled: false };
  const chunk = new Uint8Array(size).fill(0x61);
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      if (state.pulled >= chunks) return c.close();
      state.pulled += 1;
      c.enqueue(chunk);
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { body, state };
};

const post = (h: Harness, path: string, body: BodyInit, headers: Record<string, string> = {}) =>
  handleFetch(
    new Request(`${h.env.APP_ORIGIN}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body,
      duplex: "half",
    } as RequestInit),
    h.env,
    ctx,
  );

describe("webhook body cap (before signature verification)", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });

  it.each(["/webhooks/billing", "/webhooks/send-events", "/webhooks/newsletter"])(
    "%s refuses an oversized chunked body with 413 and cancels the stream",
    async (path) => {
      const { body, state } = chunked(1024); // 64 MiB if fully read
      const r = await post(h, path, body);
      expect(r.status).toBe(413);
      expect(state.cancelled).toBe(true);
      expect(state.pulled * 64 * 1024).toBeLessThanOrEqual(WEBHOOK_MAX_BYTES + 64 * 1024);
    },
  );

  it("a declared Content-Length over the cap is refused before reading", async () => {
    const r = await post(h, "/webhooks/send-events", "x".repeat(WEBHOOK_MAX_BYTES + 1));
    expect(r.status).toBe(413);
  });

  it("a small unsigned body still reaches the signature check (401, not 413)", async () => {
    const r = await post(h, "/webhooks/send-events", "{}");
    expect(r.status).toBe(401);
  });
});

describe("vCard import body cap", () => {
  let h: Harness;
  let cookie: string;
  let mailboxId: string;
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2026, 8, 25, 12));
    h = makeHarness();
    const directory = new ControlDirectory(h.env.DIRECTORY, kernelClock);
    const account = await directory.provisionPersonalAccount({
      address: "ana@bye.test",
      displayName: "ana",
    });
    const auth = new ControlAuth(h.env.DIRECTORY, kernelClock, await authConfig(h.env));
    const session = await auth.issueSession(account.userId, "test", true);
    cookie = `__Host-session=${session.token}`;
    mailboxId = account.mailboxId;
  });
  afterEach(() => vi.useRealTimers());

  it("an oversized chunked upload is cancelled, not buffered, and refused with 413", async () => {
    const { body, state } = chunked(64); // 4 MiB > 1 MiB cap
    const r = await post(h, `/v1/mailboxes/${mailboxId}/contacts/import`, body, {
      cookie,
      origin: h.env.APP_ORIGIN,
      "content-type": "text/vcard",
      "idempotency-key": "import-1",
    });
    expect(r.status).toBe(413);
    expect(state.cancelled).toBe(true);
    expect(state.pulled).toBeLessThan(64);
  });
});

describe("guardedFetch (external-identity endpoints)", () => {
  const dohFor =
    (records: Record<string, ReadonlyArray<string>>) =>
    async (url: string): Promise<Response> => {
      const u = new URL(url);
      const name = u.searchParams.get("name")!;
      const type = u.searchParams.get("type") === "A" ? 1 : 28;
      const answers = (records[name] ?? [])
        .filter((ip) => (type === 1 ? !ip.includes(":") : ip.includes(":")))
        .map((data) => ({ type, data }));
      return Response.json({ Status: 0, Answer: answers });
    };

  it("refuses a public-looking host that resolves to a private address; no request is sent", async () => {
    const inner = vi.fn(async () => new Response("ok"));
    const f = guardedFetch(inner as never, 1000, dohFor({ "relay.evil.test": ["10.0.0.5"] }));
    const r = await f("https://relay.evil.test/send", { method: "POST" });
    expect(r.status).toBe(403);
    expect(inner).not.toHaveBeenCalled();
    // Metadata over IPv6 answers too.
    const g = guardedFetch(inner as never, 1000, dohFor({ "v6.evil.test": ["fd00::1"] }));
    expect((await g("https://v6.evil.test/", { method: "POST" })).status).toBe(403);
    // Lexical rules still apply (IP literal, http).
    expect((await g("https://169.254.169.254/latest", {})).status).toBe(403);
    expect((await g("http://relay.example.com/", {})).status).toBe(403);
    expect(inner).not.toHaveBeenCalled();
  });

  it("a failed lookup throws (nothing sent)", async () => {
    const inner = vi.fn(async () => new Response("ok"));
    const f = guardedFetch(inner as never, 1000, async () => new Response("", { status: 502 }));
    await expect(f("https://relay.example.com/", { method: "POST" })).rejects.toThrow();
    expect(inner).not.toHaveBeenCalled();
  });

  it("public destinations go through with redirect: manual and a deadline", async () => {
    const inner = vi.fn(
      async (_u: unknown, _i?: RequestInit) =>
        new Response(null, { status: 302, headers: { location: "http://127.0.0.1/" } }),
    );
    const f = guardedFetch(
      inner as never,
      1000,
      dohFor({ "relay.example.com": ["93.184.216.34"] }),
    );
    const r = await f("https://relay.example.com/send", { method: "POST" });
    // The redirect is surfaced to the transport (a non-2xx failure), never followed.
    expect(r.status).toBe(302);
    expect(inner).toHaveBeenCalledTimes(1);
    const init = inner.mock.calls[0]![1]!;
    expect(init.redirect).toBe("manual");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});
