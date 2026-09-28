import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ControlAuth, ControlDirectory } from "@bye/platform-cloudflare";
import { handleFetch } from "../src/api.ts";
import { kernelClock } from "../src/durable-host.ts";
import { PublicGateway } from "../src/gateway.ts";
import { handleInbound } from "../src/inbound.ts";
import { sendSystemEmail, SystemMailRefused } from "../src/publishing.ts";
import { authConfig } from "../src/services.ts";
import { type Harness, inboundMessage, makeHarness, rfc822, executionContext } from "./harness.ts";

// Security regressions for shared spaces, World publishing and system mail: the organization
// binding on public links and shares, streaming body caps and storage bounds on World uploads,
// the platform sending controls on user-triggered system mail, and public media lifecycle.

(globalThis as { FixedLengthStream?: unknown }).FixedLengthStream = class extends TransformStream {
  constructor(_length: number) {
    super();
  }
};

const ctx = executionContext;

interface Account {
  readonly userId: string;
  readonly mailboxId: string;
  readonly organizationId: string;
  readonly cookie: string;
}

const signup = async (h: Harness, address: string): Promise<Account> => {
  const account = await new ControlDirectory(h.env.DIRECTORY, kernelClock).provisionPersonalAccount(
    { address, displayName: address.split("@")[0]! },
  );

  const session = await new ControlAuth(
    h.env.DIRECTORY,
    kernelClock,
    await authConfig(h.env),
  ).issueSession(account.userId, "test", true);

  return { ...account, cookie: `__Host-session=${session.token}` };
};

const request = async (
  h: Harness,
  a: Account,
  method: string,
  path: string,
  init: { json?: unknown; body?: BodyInit; headers?: Record<string, string> } = {},
) => {
  const hdrs = new Headers({ cookie: a.cookie });

  if (method !== "GET") hdrs.set("origin", h.env.APP_ORIGIN);

  if (init.json !== undefined) hdrs.set("content-type", "application/json");

  for (const [k, v] of Object.entries(init.headers ?? {})) hdrs.set(k, v);

  const requestInit: RequestInit = { method, headers: hdrs };

  if (init.json !== undefined) requestInit.body = JSON.stringify(init.json);

  if (init.body !== undefined) {
    requestInit.body = init.body;
    Object.assign(requestInit, { duplex: "half" });
  }

  const response = await handleFetch(
    new Request(`${h.env.APP_ORIGIN}${path}`, requestInit),
    h.env,
    ctx,
  );

  const text = await response.text();

  return {
    status: response.status,
    body:
      (response.headers.get("content-type") ?? "").includes("json") && text
        ? JSON.parse(text)
        : null,
  };
};

/** A chunked body (no content-length) that records how many bytes the server pulled. */
const countingStream = (total: number, chunk = 64 * 1024) => {
  const state = { pulled: 0 };
  let sent = 0;

  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= total) return controller.close();
      const n = Math.min(chunk, total - sent);
      sent += n;
      state.pulled += n;
      controller.enqueue(new Uint8Array(n).fill(0x61));
    },
  });

  return { stream, state };
};

const png = (fill: number) => {
  const bytes = new Uint8Array(64).fill(fill);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  return bytes;
};

const recipients = (h: Harness) => h.sent.map((s) => s.to);

describe("shared spaces, World and system mail hardening", () => {
  let h: Harness;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2026, 8, 25, 12));
    h = makeHarness();
  });
  afterEach(() => vi.useRealTimers());

  it("[O05] a member suspended from the space's organization can no longer share, link, or keep links alive", async () => {
    const ana = await signup(h, "ana@bye.test");
    await request(h, ana, "POST", `/v1/mailboxes/${ana.mailboxId}/commands`, {
      json: {
        _tag: "SetPolicy",
        commandId: "cmd_00000000000000000001",
        kind: "domain",
        subject: "example.net",
        policy: {
          decision: "allowed",
          destination: "imbox",
          labels: [],
          bundle: false,
          notify: false,
        },
      },
    });
    await handleInbound(
      inboundMessage(
        "bob@example.net",
        "ana@bye.test",
        rfc822({
          from: "bob@example.net",
          to: "ana@bye.test",
          subject: "Launch",
          body: "org body",
          messageId: "l1@example.net",
        }),
      ),
      h.env,
    );
    await h.drain();

    const thread = (await request(h, ana, "GET", `/v1/mailboxes/${ana.mailboxId}/views/imbox`)).body
      .items[0];

    const detail = await request(
      h,
      ana,
      "GET",
      `/v1/mailboxes/${ana.mailboxId}/threads/${thread.threadId}`,
    );

    const spaceId = (
      await request(h, ana, "POST", "/v1/spaces", { json: { organizationId: ana.organizationId } })
    ).body.spaceId as string;

    const share = {
      spaceId,
      mailboxId: ana.mailboxId,
      threadId: thread.threadId,
      messageRefs: detail.body.deliveries.map((d: { deliveryId: string }) => d.deliveryId),
      grantees: [],
      includeFuture: false,
    };

    const shared = await request(h, ana, "POST", "/v1/shared-threads", { json: share });
    expect(shared.status).toBe(201);
    const sharedThreadId = shared.body as string;

    const link = await request(h, ana, "POST", "/v1/public-links", {
      json: { spaceId, threadId: sharedThreadId, includeFuture: false },
    });

    expect(link.status).toBe(201);
    const [, token] = new URL(link.body.url).pathname.split("/").slice(2);
    const gateway = new PublicGateway({} as never, h.env);
    expect(await gateway.resolveShareLink(spaceId, token!)).not.toBeNull();

    // Suspension changes only D1 memberships; the space authority still lists ana as a member.
    await h.env.DIRECTORY.prepare(
      "UPDATE memberships SET status = 'suspended' WHERE org_id = ? AND user_id = ?",
    )
      .bind(ana.organizationId, ana.userId)
      .run();

    expect(await gateway.resolveShareLink(spaceId, token!)).toBeNull();

    const again = await request(h, ana, "POST", "/v1/public-links", {
      json: { spaceId, threadId: sharedThreadId, includeFuture: false },
    });

    expect([403, 404]).toContain(again.status);
    expect(again.body?.url).toBeUndefined();
    const reshare = await request(h, ana, "POST", "/v1/shared-threads", { json: share });
    expect([403, 404]).toContain(reshare.status);

    // Reinstated: the (never revoked) link resolves again.
    await h.env.DIRECTORY.prepare(
      "UPDATE memberships SET status = 'active' WHERE org_id = ? AND user_id = ?",
    )
      .bind(ana.organizationId, ana.userId)
      .run();
    expect(await gateway.resolveShareLink(spaceId, token!)).not.toBeNull();
  });

  it("[P01] World media upload caps a chunked body while streaming and bounds stored media", async () => {
    const ana = await signup(h, "ana@bye.test");
    const { stream, state } = countingStream(20 * 1024 * 1024);

    const big = await request(h, ana, "PUT", "/v1/world/media?name=big.png", {
      body: stream,
      headers: { "content-type": "image/png" },
    });

    expect(big.status).toBe(413);
    expect(state.pulled).toBeLessThanOrEqual(10 * 1024 * 1024 + 4 * 64 * 1024);

    const ok = await request(h, ana, "PUT", "/v1/world/media?name=pic.png", {
      body: png(1),
      headers: { "content-type": "image/png" },
    });

    expect(ok.status).toBe(201);

    for (let i = 0; i < 1000; i++)
      await h.buckets.PARTS.put(`t/${ana.userId}/world-media/fill-${i}`, new Uint8Array(1));

    const full = await request(h, ana, "PUT", "/v1/world/media?name=pic.png", {
      body: png(2),
      headers: { "content-type": "image/png" },
    });

    expect(full.status).toBe(413);
  });

  it("[P02] subscriber import caps the body while streaming and the address count", async () => {
    const ana = await signup(h, "ana@bye.test");
    const { stream, state } = countingStream(4 * 1024 * 1024);

    const big = await request(h, ana, "POST", "/v1/world/subscribers/import", {
      body: stream,
      headers: { "content-type": "text/csv" },
    });

    expect(big.status).toBe(413);
    expect(state.pulled).toBeLessThanOrEqual(1024 * 1024 + 4 * 64 * 1024);

    const csv = Array.from({ length: 1001 }, (_, i) => `r${i}@example.invalid`).join("\n");

    const many = await request(h, ana, "POST", "/v1/world/subscribers/import", {
      body: csv,
      headers: { "content-type": "text/csv" },
    });

    expect(many.status).toBe(400);
    expect(h.sent).toEqual([]);
  });

  it("[P02] import confirmations obey suppression, suspension and the author's sending budget", async () => {
    const ana = await signup(h, "ana@bye.test");
    await h.env.DIRECTORY.prepare(
      "INSERT INTO suppressions (address, reason, source, created_at) VALUES ('gone@example.invalid', 'complaint', 'test', 0)",
    ).run();

    const first = await request(h, ana, "POST", "/v1/world/subscribers/import", {
      body: "email\nok@example.invalid\ngone@example.invalid\n",
      headers: { "content-type": "text/csv" },
    });

    expect(first.status).toBe(200);
    expect(recipients(h)).toEqual(["ok@example.invalid"]);
    expect(first.body.confirmationsSent).toBe(1);

    // New-account ramp: 50 recipients per day in total, one already used.
    h.sent.length = 0;
    const csv = Array.from({ length: 80 }, (_, i) => `r${i}@example.invalid`).join("\n");

    const second = await request(h, ana, "POST", "/v1/world/subscribers/import", {
      body: csv,
      headers: { "content-type": "text/csv" },
    });

    expect(second.status).toBe(200);
    expect(second.body.invited).toBe(80);
    expect(h.sent.length).toBe(49);
    expect(second.body.confirmationsSent).toBe(49);

    // A suspended sender sends nothing.
    vi.setSystemTime(Date.now() + 2 * 24 * 3600_000);
    h.sent.length = 0;
    await h.env.DIRECTORY.prepare(
      "INSERT INTO sending_suspensions (scope, key, reason, created_by, created_at) VALUES ('user', ?, 'test', 'op', 0)",
    )
      .bind(ana.userId)
      .run();

    const third = await request(h, ana, "POST", "/v1/world/subscribers/import", {
      body: "s1@example.invalid\ns2@example.invalid\n",
      headers: { "content-type": "text/csv" },
    });

    expect(third.status).toBe(200);
    expect(h.sent).toEqual([]);
  });

  it("[sysmail] user-triggered system mail is refused for suppressed recipients and suspended senders", async () => {
    const ana = await signup(h, "ana@bye.test");
    await h.env.DIRECTORY.prepare(
      "INSERT INTO suppressions (address, reason, source, created_at) VALUES ('gone@example.invalid', 'hard-bounce', 'test', 0)",
    ).run();
    const mail = (to: string) => ({ to, subject: "Invite", text: "hi" });
    await expect(sendSystemEmail(h.env, mail("gone@example.invalid"))).rejects.toBeInstanceOf(
      SystemMailRefused,
    );
    await expect(
      sendSystemEmail(h.env, mail("gone@example.invalid"), { actorUserId: ana.userId }),
    ).rejects.toBeInstanceOf(SystemMailRefused);
    await sendSystemEmail(h.env, mail("ok@example.invalid"), { actorUserId: ana.userId });
    expect(recipients(h)).toEqual(["ok@example.invalid"]);

    const used = await h.env.DIRECTORY.prepare(
      "SELECT COALESCE(SUM(sent), 0) AS n FROM sending_counters WHERE scope = 'user' AND key = ?",
    )
      .bind(ana.userId)
      .first<{ n: number }>();

    expect(Number(used?.n)).toBe(1);

    await h.env.DIRECTORY.prepare(
      "INSERT INTO sending_suspensions (scope, key, reason, created_by, created_at) VALUES ('user', ?, 'test', 'op', 0)",
    )
      .bind(ana.userId)
      .run();
    await expect(
      sendSystemEmail(h.env, mail("other@example.invalid"), { actorUserId: ana.userId }),
    ).rejects.toMatchObject({ reason: "suspended" });
    expect(recipients(h)).toEqual(["ok@example.invalid"]);
  });

  it("[P01] republishing removes superseded public media and unpublishing removes the rest", async () => {
    const ana = await signup(h, "ana@bye.test");

    const upload = async (name: string, fill: number) =>
      (
        await request(h, ana, "PUT", `/v1/world/media?name=${name}`, {
          body: png(fill),
          headers: { "content-type": "image/png" },
        })
      ).body as { contentKey: string; name: string; contentType: string };

    const media = () =>
      [...h.buckets.PUBLISHED.objects.keys()].filter((k) => k.startsWith("site/ana/media/"));

    const draft = await request(h, ana, "POST", "/v1/world/drafts", {
      json: { title: "Pics", html: "<p>x</p>", text: "x", media: [await upload("one.png", 1)] },
    });

    expect(draft.status).toBe(201);
    const postId = draft.body.postId as string;
    expect((await request(h, ana, "POST", `/v1/world/posts/${postId}/publish`)).status).toBe(200);
    expect(media()).toEqual(["site/ana/media/pics-r1-one.png"]);

    const edited = await request(h, ana, "PUT", `/v1/world/posts/${postId}`, {
      json: { title: "Pics", html: "<p>x</p>", text: "x", media: [await upload("two.png", 2)] },
    });

    expect(edited.status).toBe(200);
    expect((await request(h, ana, "POST", `/v1/world/posts/${postId}/publish`)).status).toBe(200);
    expect(media()).toEqual(["site/ana/media/pics-r2-two.png"]);

    expect((await request(h, ana, "POST", `/v1/world/posts/${postId}/unpublish`)).status).toBe(200);
    expect(media()).toEqual([]);
  });
});
