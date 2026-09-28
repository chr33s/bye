import { ControlAuth, ControlDirectory } from "@bye/platform-cloudflare";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleFetch } from "../src/api.ts";
import { kernelClock } from "../src/durable-host.ts";
import { FORWARD_HOP_HEADER, FORWARD_MAX_HOPS, handleInbound } from "../src/inbound.ts";
import { authConfig } from "../src/services.ts";
import { type Harness, inboundMessage, makeHarness, rfc822 } from "./harness.ts";

// Direct tests for behavior the gap analysis lists as implemented but untested: /v1/spaces HTTP
// routes, cache purge on unpublish, the closure-forwarding hop guard, and the read-scope refusal
// around recent searches.

(globalThis as { FixedLengthStream?: unknown }).FixedLengthStream = class extends TransformStream {
  constructor(_length: number) {
    super();
  }
};

const ctx = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
} as unknown as ExecutionContext;

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

const call = async (
  h: Harness,
  a: Account | null,
  method: string,
  path: string,
  json?: unknown,
  headers: Record<string, string> = {},
) => {
  const response = await handleFetch(
    new Request(`${h.env.APP_ORIGIN}${path}`, {
      method,
      headers: {
        ...(a ? { cookie: a.cookie } : {}),
        ...(method === "GET" ? {} : { origin: h.env.APP_ORIGIN }),
        ...(json !== undefined ? { "content-type": "application/json" } : {}),
        ...headers,
      },
      ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
    }),
    h.env,
    ctx,
  );
  const text = await response.text();
  const type = response.headers.get("content-type") ?? "";
  return {
    status: response.status,
    body: type.includes("json") && text ? JSON.parse(text) : null,
  };
};

let n = 0;
const cmdId = () => `cmd_gu_${(++n).toString(36).padStart(16, "0")}`;

describe("gap-analysis untested rows", () => {
  let h: Harness;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2026, 8, 25, 12));
    h = makeHarness();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("[O03/O04] /v1/spaces routes: create, list, members, comments, collections and grants", async () => {
    const ana = await signup(h, "ana@bye.test");
    const bob = await signup(h, "bob@bye.test");
    // Bob joins Ana's organization so he can be a space member.
    const org = await call(h, ana, "POST", "/v1/orgs", {
      kind: "domain",
      name: "Acme",
      seatLimit: 5,
    });
    const orgId = (org.body.orgId ?? org.body.id) as string;
    const invite = await call(h, ana, "POST", `/v1/orgs/${orgId}/invitations`, {
      address: "bob@bye.test",
      role: "member",
    });
    expect(
      (await call(h, bob, "POST", "/v1/invitations/accept", { token: invite.body.token })).status,
    ).toBe(200);

    const created = await call(h, ana, "POST", "/v1/spaces", { organizationId: orgId });
    expect(created.status).toBe(201);
    const spaceId = created.body.spaceId as string;

    // Listing shows only spaces the caller belongs to.
    const ids = async (a: Account) =>
      ((await call(h, a, "GET", "/v1/spaces")).body.items as Array<{ id: string }>).map(
        (s) => s.id,
      );
    expect(await ids(ana)).toContain(spaceId);
    expect(await ids(bob)).not.toContain(spaceId);
    expect((await call(h, bob, "GET", `/v1/spaces/${spaceId}/members`)).status).toBe(403);

    // Membership: only active organization members, and only an admin may change it.
    const stranger = await signup(h, "eve@bye.test");
    expect(
      (
        await call(h, ana, "PUT", `/v1/spaces/${spaceId}/members/${stranger.userId}`, {
          role: "member",
        })
      ).status,
    ).toBe(400);
    expect(
      (await call(h, ana, "PUT", `/v1/spaces/${spaceId}/members/${bob.userId}`, { role: "member" }))
        .status,
    ).toBe(200);
    expect(await ids(bob)).toContain(spaceId);
    const members = await call(h, bob, "GET", `/v1/spaces/${spaceId}/members`);
    expect(JSON.stringify(members.body)).toContain(bob.userId);
    expect(
      (await call(h, bob, "PUT", `/v1/spaces/${spaceId}/members/${bob.userId}`, { role: "admin" }))
        .status,
    ).not.toBe(200);

    // A shared thread to comment on and collect.
    await call(h, ana, "POST", `/v1/mailboxes/${ana.mailboxId}/commands`, {
      _tag: "SetPolicy",
      commandId: cmdId(),
      kind: "domain",
      subject: "example.net",
      policy: {
        decision: "allowed",
        destination: "imbox",
        labels: [],
        bundle: false,
        notify: false,
      },
    });
    await handleInbound(
      inboundMessage(
        "sam@example.net",
        "ana@bye.test",
        rfc822({
          from: "sam@example.net",
          to: "ana@bye.test",
          subject: "Roadmap",
          body: "plan",
          messageId: "sp1@example.net",
        }),
      ),
      h.env,
    );
    await h.drain();
    const thread = (await call(h, ana, "GET", `/v1/mailboxes/${ana.mailboxId}/views/imbox`)).body
      .items[0];
    const detail = await call(
      h,
      ana,
      "GET",
      `/v1/mailboxes/${ana.mailboxId}/threads/${thread.threadId}`,
    );
    const shared = await call(h, ana, "POST", "/v1/shared-threads", {
      spaceId,
      mailboxId: ana.mailboxId,
      threadId: thread.threadId,
      messageRefs: detail.body.deliveries.map((d: { deliveryId: string }) => d.deliveryId),
      grantees: [],
      includeFuture: false,
    });
    expect(shared.status).toBe(201);
    const sth = shared.body as string;
    await h.drain();
    expect(
      JSON.stringify((await call(h, ana, "GET", `/v1/spaces/${spaceId}/threads`)).body),
    ).toContain("Roadmap");
    expect((await call(h, ana, "GET", `/v1/spaces/${spaceId}/threads/${sth}`)).status).toBe(200);
    // Ungranted, a plain member sees nothing of it.
    expect(
      JSON.stringify((await call(h, bob, "GET", `/v1/spaces/${spaceId}/threads`)).body.items),
    ).not.toContain("Roadmap");

    // Comments.
    expect(
      (await call(h, ana, "POST", `/v1/spaces/${spaceId}/threads/${sth}/comments`, { body: "  " }))
        .status,
    ).toBe(400);
    expect(
      (
        await call(h, ana, "POST", `/v1/spaces/${spaceId}/threads/${sth}/comments`, {
          body: " looks good ",
        })
      ).status,
    ).toBe(201);
    const comments = await call(h, ana, "GET", `/v1/spaces/${spaceId}/threads/${sth}/comments`);
    expect(comments.body.items).toHaveLength(1);
    expect(JSON.stringify(comments.body.items)).toContain("looks good");

    // Collections.
    expect(
      (await call(h, ana, "POST", `/v1/spaces/${spaceId}/collections`, { name: " " })).status,
    ).toBe(400);
    const col = await call(h, ana, "POST", `/v1/spaces/${spaceId}/collections`, {
      name: "Q4",
      shareWithMembers: true,
    });
    expect(col.status).toBe(201);
    const collectionId = col.body.collectionId as string;
    expect(
      JSON.stringify((await call(h, ana, "GET", `/v1/spaces/${spaceId}/collections`)).body),
    ).toContain("Q4");
    expect(
      (
        await call(h, ana, "POST", `/v1/spaces/${spaceId}/collections/${collectionId}/threads`, {
          threadId: sth,
        })
      ).status,
    ).toBe(201);
    const timeline = await call(h, ana, "GET", `/v1/spaces/${spaceId}/collections/${collectionId}`);
    expect(timeline.status).toBe(200);
    expect(JSON.stringify(timeline.body)).toContain("Roadmap");

    // Grants: create (step-up), list, revoke (admin only).
    const grant = await call(h, ana, "POST", `/v1/spaces/${spaceId}/grants`, {
      kind: "thread",
      resourceId: sth,
      grantee: bob.userId,
    });
    expect(grant.status).toBe(201);
    const grantId = grant.body.grantId as string;
    await h.drain();
    expect(
      JSON.stringify((await call(h, bob, "GET", `/v1/spaces/${spaceId}/threads`)).body.items),
    ).toContain("Roadmap");
    const listed = await call(
      h,
      ana,
      "GET",
      `/v1/spaces/${spaceId}/grants?kind=thread&resourceId=${sth}`,
    );
    expect(JSON.stringify(listed.body.items)).toContain(grantId);
    expect(
      (await call(h, bob, "DELETE", `/v1/spaces/${spaceId}/grants/${grantId}`)).status,
    ).not.toBe(200);
    expect((await call(h, ana, "DELETE", `/v1/spaces/${spaceId}/grants/${grantId}`)).status).toBe(
      200,
    );
    const after = await call(
      h,
      ana,
      "GET",
      `/v1/spaces/${spaceId}/grants?kind=thread&resourceId=${sth}`,
    );
    expect(JSON.stringify(after.body.items)).not.toContain(grantId);

    // Removing Bob ends his access.
    expect(
      (await call(h, ana, "DELETE", `/v1/spaces/${spaceId}/members/${bob.userId}`)).status,
    ).toBe(200);
    expect(await ids(bob)).not.toContain(spaceId);
  });

  it("[P01] unpublish purges the public URLs through the Cloudflare cache-purge API", async () => {
    const purged: Array<{ url: string; files: Array<string>; auth: string | null }> = [];
    vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/purge_cache"))
        purged.push({
          url,
          files: (JSON.parse(init?.body as string) as { files: Array<string> }).files,
          auth: new Headers(init?.headers).get("authorization"),
        });
      return new Response(JSON.stringify({ success: true, result: {} }), {
        headers: { "content-type": "application/json" },
      });
    });
    Object.assign(h.env as object, {
      CF_CACHE_PURGE_TOKEN: "purge-token",
      CF_PUBLIC_ZONE_ID: "zone123",
    });
    const ana = await signup(h, "ana@bye.test");
    const draft = await call(h, ana, "POST", "/v1/world/drafts", {
      title: "Bye now",
      html: "<p>body</p>",
      text: "body",
    });
    const postId = draft.body.postId as string;
    expect((await call(h, ana, "POST", `/v1/world/posts/${postId}/publish`, {})).status).toBe(200);
    purged.length = 0;
    expect((await call(h, ana, "POST", `/v1/world/posts/${postId}/unpublish`, {})).status).toBe(
      200,
    );
    expect(purged.length).toBeGreaterThan(0);
    for (const p of purged) {
      expect(p.url).toContain("/zones/zone123/purge_cache");
      expect(p.auth).toBe("Bearer purge-token");
      expect(p.files.length).toBeLessThanOrEqual(30);
    }
    const files = purged.flatMap((p) => p.files);
    expect(files.some((f) => f.includes("/@ana/bye-now"))).toBe(true);
    expect(files.every((f) => f.startsWith("https://"))).toBe(true);
  });

  it("[§10] closure forwarding stops at the hop limit and stamps X-Bye-Loop on each hop", async () => {
    const ana = await signup(h, "ana@bye.test");
    await h.d1
      .prepare(
        "INSERT INTO address_reservations (address, user_id, reason, reserved_until, forwarding_until, forwarding_to, forwarding_verified_at, created_at) VALUES (?, ?, 'closure-hold', ?, ?, ?, ?, ?)",
      )
      .bind(
        "gone@bye.test",
        ana.userId,
        Date.now() + 86400_000,
        Date.now() + 86400_000,
        "ana@example.net",
        Date.now(),
        Date.now(),
      )
      .run();
    const raw = rfc822({
      from: "sam@example.net",
      to: "gone@bye.test",
      subject: "hi",
      body: "x",
      messageId: "loop@example.net",
    });
    const attempt = async (hops: number | null) => {
      const base = inboundMessage("sam@example.net", "gone@bye.test", raw);
      const seen: Array<{ to: string; headers: Headers | undefined }> = [];
      const rejects: Array<string> = [];
      const outcome = await handleInbound(
        {
          ...base,
          headers:
            hops === null ? new Headers() : new Headers({ [FORWARD_HOP_HEADER]: String(hops) }),
          setReject: (r: string) => void rejects.push(r),
          forward: async (to: string, headers?: Headers) => void seen.push({ to, headers }),
        } as never,
        h.env,
      );
      return { outcome, seen, rejects };
    };
    const first = await attempt(null);
    expect(first.outcome).toEqual({ _tag: "Forwarded" });
    expect(first.seen[0]?.to).toBe("ana@example.net");
    expect(first.seen[0]?.headers?.get(FORWARD_HOP_HEADER)).toBe("1");
    const last = await attempt(FORWARD_MAX_HOPS - 1);
    expect(last.seen[0]?.headers?.get(FORWARD_HOP_HEADER)).toBe(String(FORWARD_MAX_HOPS));
    const looped = await attempt(FORWARD_MAX_HOPS);
    expect(looped.outcome).toEqual({ _tag: "Rejected", reason: "forward-loop" });
    expect(looped.seen).toEqual([]);
    expect(looped.rejects[0]).toMatch(/^554 5\.4\.6/);
  });

  it("[§8] recent searches are recorded only by screen-scoped credentials; read-only tokens cannot mutate them", async () => {
    const ana = await signup(h, "ana@bye.test");
    const auth = new ControlAuth(h.env.DIRECTORY, kernelClock, await authConfig(h.env));
    const bearer = async (scopes: Array<"read" | "screen">) =>
      `Bearer ${(await auth.createApiToken(ana.userId, { kind: "agent", label: scopes.join(), scopes })).token}`;
    const ro = { authorization: await bearer(["read"]) };
    const rw = { authorization: await bearer(["read", "screen"]) };
    const recent = async () =>
      (await call(h, ana, "GET", `/v1/mailboxes/${ana.mailboxId}/searches/recent`)).body
        .items as Array<string>;

    expect(
      (
        await call(
          h,
          null,
          "GET",
          `/v1/mailboxes/${ana.mailboxId}/search?q=readonlyquery`,
          undefined,
          ro,
        )
      ).status,
    ).toBe(200);
    expect(await recent()).toEqual([]);
    // Clearing the history is a triage-level command: a read-only token is refused.
    const refused = await call(
      h,
      null,
      "POST",
      `/v1/mailboxes/${ana.mailboxId}/commands`,
      { _tag: "ClearRecentSearches", commandId: cmdId() },
      ro,
    );
    expect(refused.status).toBe(403);
    expect(refused.body.error.message).toMatch(/missing scope/);

    expect(
      (
        await call(
          h,
          null,
          "GET",
          `/v1/mailboxes/${ana.mailboxId}/search?q=screenquery`,
          undefined,
          rw,
        )
      ).status,
    ).toBe(200);
    expect(await recent()).toEqual(["screenquery"]);
    expect(
      (
        await call(
          h,
          null,
          "POST",
          `/v1/mailboxes/${ana.mailboxId}/commands`,
          {
            _tag: "ClearRecentSearches",
            commandId: cmdId(),
          },
          rw,
        )
      ).status,
    ).toBe(200);
    expect(await recent()).toEqual([]);
  });
});
