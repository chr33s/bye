import { hmacHex } from "@bye/domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ControlAuth, ControlDirectory, SendingPolicy } from "@bye/platform-cloudflare";
import { handleFetch } from "../src/api.ts";
import { kernelClock } from "../src/durable-host.ts";
import { authConfig } from "../src/services.ts";
import {
  type Harness,
  makeHarness,
  inboundMessage,
  rfc822,
  enablePersonalMail,
} from "./harness.ts";
import { handleInbound } from "../src/inbound.ts";
import { binaryToBytes, mboxEntryText } from "@bye/mail-codec";
import { appendMboxPage, completeMbox, type MboxState } from "../src/workflows/export.ts";
import {
  signDownload,
  signupToken,
  verifySignupToken,
  verifyDownload,
} from "../src/routes/common.ts";
import { FanoutWorkflow } from "../src/workflows/fanout.ts";
import { renderNewsletter } from "../src/newsletter.ts";

// HTTP wiring for the control, collaboration and publishing gap routes (§2.3, §10, §11) over
// in-memory bindings, including the mailbox hooks that drive O03/O04/P01.

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
  readonly calendarId: string;
  readonly mailboxId: string;
  readonly organizationId: string;
  readonly address: string;
  readonly cookie: string;
}

const signup = async (h: Harness, address: string, steppedUp = true): Promise<Account> => {
  const account = await new ControlDirectory(h.env.DIRECTORY, kernelClock).provisionPersonalAccount(
    { address, displayName: address.split("@")[0]! },
  );
  const session = await new ControlAuth(
    h.env.DIRECTORY,
    kernelClock,
    await authConfig(h.env),
  ).issueSession(account.userId, "test", steppedUp);
  return { ...account, cookie: `__Host-session=${session.token}` };
};

const call = async (
  h: Harness,
  a: Account | null,
  method: string,
  path: string,
  json?: unknown,
) => {
  const response = await handleFetch(
    new Request(path.startsWith("http") ? path : `${h.env.APP_ORIGIN}${path}`, {
      method,
      headers: {
        ...(a ? { cookie: a.cookie } : {}),
        ...(method === "GET" ? {} : { origin: h.env.APP_ORIGIN }),
        ...(json !== undefined ? { "content-type": "application/json" } : {}),
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
    headers: response.headers,
    text,
    body: type.includes("json") && text ? JSON.parse(text) : null,
  };
};

let n = 0;
const cmdId = () => `cmd_${(++n).toString(36).padStart(20, "0")}`;

describe("control routes", () => {
  let h: Harness;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2026, 8, 25, 12));
    h = makeHarness();
  });
  afterEach(() => vi.useRealTimers());

  it("[A02] billing refuses an unknown interval instead of defaulting to annual", async () => {
    const alice = await signup(h, "alice@bye.test");
    const checkout = await call(h, alice, "POST", "/v1/billing/checkout", {
      orgId: alice.organizationId,
      plan: "plus",
      interval: "weekly",
    });
    expect(checkout.status).toBe(400);
    expect(checkout.body.error.code).toBe("bad_request");
    const change = await call(h, alice, "POST", "/v1/billing/plan", {
      orgId: alice.organizationId,
      plan: "plus",
      interval: "",
    });
    expect(change.status).toBe(400);
  });

  it("[A03] security settings: recovery codes need step-up and are shown once; sessions and tokens are listable and revocable", async () => {
    const ana = await signup(h, "ana@bye.test");
    const plain = {
      ...ana,
      cookie: `__Host-session=${(await new ControlAuth(h.env.DIRECTORY, kernelClock, await authConfig(h.env)).issueSession(ana.userId, "other", false)).token}`,
    };
    expect((await call(h, plain, "POST", "/v1/security/recovery-codes", {})).status).toBe(403);
    const codes = await call(h, ana, "POST", "/v1/security/recovery-codes", {});
    expect(codes.status).toBe(201);
    expect(codes.body.codes.length).toBeGreaterThanOrEqual(8);

    const sessions = await call(h, ana, "GET", "/v1/security/sessions");
    expect(sessions.status).toBe(200);
    const list = (sessions.body.items ?? sessions.body) as Array<{ id: string }>;
    expect(list.length).toBeGreaterThanOrEqual(2);

    const token = await call(h, ana, "POST", "/v1/tokens", { kind: "cli", label: "laptop" });
    expect(token.status).toBe(201);
    const bearer = async () =>
      (
        await handleFetch(
          new Request(`${h.env.APP_ORIGIN}/v1/mailboxes/${ana.mailboxId}/views/imbox`, {
            headers: { authorization: `Bearer ${token.body.token}` },
          }),
          h.env,
          ctx,
        )
      ).status;
    expect(await bearer()).toBe(200);
    const listTokens = async () => {
      const r = await call(h, ana, "GET", "/v1/tokens");
      return (r.body.items ?? r.body) as Array<{ id: string }>;
    };
    expect((await listTokens()).some((t) => t.id === token.body.id)).toBe(true);
    expect((await call(h, ana, "DELETE", `/v1/tokens/${token.body.id}`)).status).toBe(200);
    // Revocation is real: the token no longer authenticates and is gone from the list.
    expect(await bearer()).toBe(401);
    expect((await listTokens()).some((t) => t.id === token.body.id)).toBe(false);
    expect((await call(h, ana, "DELETE", `/v1/tokens/${token.body.id}`)).status).toBe(404);

    // Revoking the other browser session signs it out; the current one keeps working.
    const other = list.find((x) => !(x as { current?: boolean }).current)!;
    expect((await call(h, ana, "DELETE", `/v1/security/sessions/${other.id}`)).status).toBe(200);
    expect((await call(h, plain, "GET", "/v1/security/sessions")).status).toBe(401);
    expect((await call(h, ana, "GET", "/v1/security/sessions")).status).toBe(200);
  });

  it("[O02] organizations: create with step-up, invite, accept, list members and audit", async () => {
    const owner = await signup(h, "owner@bye.test");
    const org = await call(h, owner, "POST", "/v1/orgs", {
      kind: "domain",
      name: "Acme",
      seatLimit: 5,
    });
    expect(org.status).toBe(201);
    const orgId = org.body.orgId ?? org.body.id;
    // Refresh the principal so the new organization is visible.
    const invite = await call(h, owner, "POST", `/v1/orgs/${orgId}/invitations`, {
      address: "bob@bye.test",
      role: "member",
    });
    expect(invite.status).toBe(201);
    const bob = await signup(h, "bob@bye.test");
    const accepted = await call(h, bob, "POST", "/v1/invitations/accept", {
      token: invite.body.token,
    });
    expect(accepted.status).toBe(200);
    const members = await call(h, owner, "GET", `/v1/orgs/${orgId}/members`);
    expect(JSON.stringify(members.body)).toContain(bob.userId);
    const audit = await call(h, owner, "GET", `/v1/orgs/${orgId}/audit`);
    expect(audit.status).toBe(200);
    expect(JSON.stringify(audit.body)).toMatch(/invite/i);
    // The audit log is for organization admins only: a plain member and a stranger are refused.
    expect((await call(h, bob, "GET", `/v1/orgs/${orgId}/audit`)).status).toBe(403);
    const stranger = await signup(h, "eve@bye.test");
    expect((await call(h, stranger, "GET", `/v1/orgs/${orgId}/audit`)).status).toBe(403);
  });

  it("[O02] malformed admin bodies are 400s, never silent defaults", async () => {
    const owner = await signup(h, "owner@bye.test");
    const bad = [
      ["POST", "/v1/orgs", { kind: "corporate", name: "Acme" }],
      ["POST", "/v1/orgs", { kind: "domain", name: "Acme", seatLimit: "five" }],
      ["POST", "/v1/orgs", { kind: "domain", name: "Acme", reassignmentPolicy: "keep" }],
    ] as const;
    for (const [method, path, body] of bad) {
      const r = await call(h, owner, method, path, body);
      expect([path, r.status, r.body?.error?.code]).toEqual([path, 400, "bad_request"]);
    }
    const org = await call(h, owner, "POST", "/v1/orgs", { kind: "domain", name: "Acme" });
    expect(org.status).toBe(201);
    expect(org.body.seatLimit).toBe(5); // documented default, not a silent coercion
    const orgId = org.body.id;
    const typo = await call(h, owner, "POST", `/v1/orgs/${orgId}/invitations`, {
      address: "bob@bye.test",
      role: "owner",
    });
    expect(typo.status).toBe(400);
    const defaulted = await call(h, owner, "POST", `/v1/orgs/${orgId}/invitations`, {
      address: "bob@bye.test",
    });
    expect(defaulted.status).toBe(201);
    expect((await call(h, owner, "PUT", `/v1/orgs/${orgId}/seats`, {})).status).toBe(400);
  });

  it("[X02] every API write is audited with the acting credential; bodies are never recorded", async () => {
    const ana = await signup(h, "ana@bye.test");
    await call(h, ana, "POST", `/v1/mailboxes/${ana.mailboxId}/commands`, {
      _tag: "CreateLabel",
      commandId: cmdId(),
      name: "secret-label-name",
    });
    const rows = (
      await h.d1
        .prepare("SELECT actor_id, action, target, detail FROM audit_log WHERE actor_id = ?")
        .bind(ana.userId)
        .all<{ action: string; target: string; detail: string }>()
    ).results;
    const write = rows.find((r) => r.target.includes("/commands"));
    expect(write).toBeDefined();
    expect(JSON.stringify(rows)).not.toContain("secret-label-name");
  });

  it("[A04] exports list files with expiring signed links; tampered or expired links are refused", async () => {
    const ana = await signup(h, "ana@bye.test");
    const started = await call(h, ana, "POST", "/v1/exports", {});
    expect(started.status).toBe(202);
    const exportId = started.body.exportId as string;
    await h.buckets.EXPORTS.put(
      `t/${ana.userId}/export/${exportId}/${ana.mailboxId}.mbox`,
      "From x\n",
    );
    const status = await call(h, ana, "GET", `/v1/exports/${exportId}`);
    const file = (status.body.files as Array<{ url: string }>)[0]!;
    const ok = await call(h, null, "GET", file.url);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-disposition")).toContain("attachment");
    expect(
      (await call(h, null, "GET", file.url.replace(/token=[^&]+/, "token=forged"))).status,
    ).toBe(403);
    vi.setSystemTime(Date.now() + 2 * 24 * 3600_000);
    expect((await call(h, null, "GET", file.url)).status).toBe(403);
  });

  it("[O05] public links: preview shows exactly what becomes visible; revocation ends access", async () => {
    const { PublicGateway } = await import("../src/gateway.ts");
    const { handleInbound } = await import("../src/inbound.ts");
    const { inboundMessage, rfc822 } = await import("./harness.ts");
    const ana = await signup(h, "ana@bye.test");
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
        "bob@example.net",
        "ana@bye.test",
        rfc822({
          from: "bob@example.net",
          to: "ana@bye.test",
          subject: "Launch",
          body: "public body",
          messageId: "l1@example.net",
          extraHeaders: "Bcc: hidden@example.net",
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
    const spaceId = (
      await call(h, ana, "POST", "/v1/spaces", { organizationId: ana.organizationId })
    ).body.spaceId as string;
    const shared = await call(h, ana, "POST", "/v1/shared-threads", {
      spaceId,
      mailboxId: ana.mailboxId,
      threadId: thread.threadId,
      messageRefs: detail.body.deliveries.map((d: { deliveryId: string }) => d.deliveryId),
      grantees: [],
      includeFuture: false,
    });
    const sharedThreadId = shared.body as string;
    const preview = await call(
      h,
      ana,
      "GET",
      `/v1/spaces/${spaceId}/threads/${sharedThreadId}/public-preview`,
    );
    expect(preview.status).toBe(200);
    expect(JSON.stringify(preview.body)).toContain("Launch");
    expect(JSON.stringify(preview.body)).not.toContain("hidden@example.net");
    const link = await call(h, ana, "POST", "/v1/public-links", {
      spaceId,
      threadId: sharedThreadId,
      includeFuture: false,
    });
    const [, token] = new URL(link.body.url).pathname.split("/").slice(2);
    const gateway = new PublicGateway({} as never, h.env);
    expect(await gateway.resolveShareLink(spaceId, token!)).not.toBeNull();
    expect(
      (await call(h, ana, "DELETE", `/v1/spaces/${spaceId}/public-links/${link.body.linkId}`))
        .status,
    ).toBe(200);
    expect(await gateway.resolveShareLink(spaceId, token!)).toBeNull();
  });

  it("[P01] World: draft → preview → publish → unpublish writes and removes public copies", async () => {
    const ana = await signup(h, "ana@bye.test");
    const draft = await call(h, ana, "POST", "/v1/world/drafts", {
      title: "Draft post",
      html: "<p>body</p>",
      text: "body",
    });
    expect(draft.status).toBe(201);
    const postId = draft.body.postId as string;
    const preview = await call(h, ana, "GET", `/v1/world/posts/${postId}/preview`);
    expect(preview.status).toBe(200);
    expect([...h.buckets.PUBLISHED.objects.keys()].some((k) => k.includes("/posts/"))).toBe(false);
    expect((await call(h, ana, "POST", `/v1/world/posts/${postId}/publish`, {})).status).toBe(200);
    expect(
      [...h.buckets.PUBLISHED.objects.keys()].some((k) => k.startsWith("site/ana/posts/")),
    ).toBe(true);
    expect((await call(h, ana, "POST", `/v1/world/posts/${postId}/unpublish`, {})).status).toBe(
      200,
    );
    expect(
      [...h.buckets.PUBLISHED.objects.keys()].some((k) => k.startsWith("site/ana/posts/")),
    ).toBe(false);
  });

  it("[P01] publish is one durable pipeline: the FANOUT instance re-renders a site the synchronous attempt lost, once", async () => {
    const ana = await signup(h, "ana@bye.test");
    const created = await call(h, ana, "POST", "/v1/world/posts", {
      from: "ana@bye.test",
      title: "Durable",
      html: "<p>d</p>",
      text: "d",
    });
    expect(created.status).toBe(201);
    const postId = created.body.postId as string;
    const instance = h.workflows.FANOUT?.find((w) => w.id.startsWith(`fan-ana-${postId}-r`));
    expect(instance).toBeDefined();
    const sitePages = () =>
      [...h.buckets.PUBLISHED.objects.keys()].filter((k) => k.startsWith("site/ana/posts/"));
    expect(sitePages().length).toBeGreaterThan(0);
    // Crash after commit: the synchronous render never landed.
    for (const k of sitePages()) h.buckets.PUBLISHED.objects.delete(k);
    for (const k of [...h.buckets.PARTS.objects.keys()].filter((k) =>
      k.startsWith("t/world/ana/site-rendered/"),
    ))
      h.buckets.PARTS.objects.delete(k);
    const executed: Array<string> = [];
    const step = {
      do: async (name: string, ...args: ReadonlyArray<unknown>) => (
        executed.push(name),
        (args.at(-1) as () => Promise<unknown>)()
      ),
    };
    const run = () =>
      new FanoutWorkflow({} as never, h.env).run(
        { payload: instance!.params, instanceId: instance!.id, timestamp: new Date() } as never,
        step as never,
      );
    await run();
    expect(executed.slice(0, 2)).toEqual(["v1:site", "v2:approve"]);
    expect(sitePages().length).toBeGreaterThan(0);
    // A replay finds the version recorded as rendered and leaves the site alone.
    for (const k of sitePages()) h.buckets.PUBLISHED.objects.delete(k);
    await run();
    expect(sitePages()).toEqual([]);
  });

  it("[P01] sending from the author's identity to world@ publishes locally and never goes over SMTP", async () => {
    const ana = await signup(h, "ana@bye.test");
    expect(
      (
        await call(h, ana, "POST", `/v1/mailboxes/${ana.mailboxId}/commands`, {
          _tag: "AddIdentity",
          commandId: cmdId(),
          address: "ana@bye.test",
          kind: "hosted",
        })
      ).status,
    ).toBe(200);
    const draft = await call(h, ana, "POST", "/v1/drafts", {
      mailboxId: ana.mailboxId,
      commandId: cmdId(),
      content: {
        to: [{ address: "world@bye.test" }],
        cc: [],
        bcc: [],
        subject: "Hello from mail",
        text: "Published by email",
        attachments: [],
      },
    });
    const sent = await call(h, ana, "POST", `/v1/drafts/${draft.body.draftId}/send`, {
      mailboxId: ana.mailboxId,
      commandId: cmdId(),
      revision: draft.body.revision,
    });
    expect(sent.status).toBe(202);
    // A publish-only send is one real send job of the `publish` class (undo goes through cancelSend).
    expect(sent.body.sendJobIds).toHaveLength(1);
    expect(
      (await h.namespaces.MAILBOXES.instance(ana.mailboxId).sendJob(sent.body.sendJobIds[0]))
        ?.trafficClass,
    ).toBe("publish");
    // Publishing honours the undo window: nothing is public until it elapses.
    await h.drain();
    const published = () =>
      [...h.buckets.PUBLISHED.objects.keys()].some((k) => k.startsWith("site/ana/posts/"));
    expect(published()).toBe(false);
    vi.setSystemTime(Date.now() + 60_000);
    await h.namespaces.MAILBOXES.instance(ana.mailboxId).alarm();
    await h.drain();
    expect(published()).toBe(true);
    expect(h.sent).toHaveLength(0);
  });

  it("[O01] a retried onboarding Workflow receives zone authorization and reports its own status", async () => {
    const ana = await signup(h, "ana@bye.test");
    const orgId = (await call(h, ana, "GET", "/v1/me")).body.organizationIds[0];
    const created = await call(h, ana, "POST", "/v1/domains", { orgId, name: "ana-co.example" });
    expect(created.status).toBe(202);
    const retried = await call(h, ana, "POST", `/v1/domains/${created.body.id}/retry`, {});
    expect(retried.status).toBe(202);
    const retryId = retried.body.workflowId as string;
    expect(retryId).not.toBe(`dom-${created.body.id}`);
    await h.d1
      .prepare("UPDATE domains SET state = 'ownership-proven' WHERE id = ?")
      .bind(created.body.id)
      .run();
    const auth = await call(h, ana, "POST", `/v1/domains/${created.body.id}/authorize-zone`, {
      method: "manual-records",
    });
    expect(auth.status).toBe(202);
    expect(h.workflowEvents.PROVISION_DOMAIN).toEqual([
      { id: retryId, type: "zone-authorized", payload: { method: "manual-records" } },
    ]);
    expect((await call(h, ana, "GET", `/v1/domains/${created.body.id}`)).body.workflow.id).toBe(
      retryId,
    );
  });

  it("[P01] undoing a publish-by-email send (or a mixed send) stops the post", async () => {
    const ana = await signup(h, "ana@bye.test");
    await call(h, ana, "POST", `/v1/mailboxes/${ana.mailboxId}/commands`, {
      _tag: "AddIdentity",
      commandId: cmdId(),
      address: "ana@bye.test",
      kind: "hosted",
    });
    const published = () =>
      [...h.buckets.PUBLISHED.objects.keys()].some((k) => k.startsWith("site/ana/posts/"));
    for (const to of [
      [{ address: "world@bye.test" }],
      [{ address: "world@bye.test" }, { address: "bob@example.net" }],
    ]) {
      const draft = await call(h, ana, "POST", "/v1/drafts", {
        mailboxId: ana.mailboxId,
        commandId: cmdId(),
        content: { to, cc: [], bcc: [], subject: "Oops", text: "not yet", attachments: [] },
      });
      const sent = await call(h, ana, "POST", `/v1/drafts/${draft.body.draftId}/send`, {
        mailboxId: ana.mailboxId,
        commandId: cmdId(),
        revision: draft.body.revision,
      });
      const undo = await call(h, ana, "POST", `/v1/send-jobs/${sent.body.sendJobIds[0]}/cancel`, {
        mailboxId: ana.mailboxId,
        commandId: cmdId(),
      });
      expect(undo.body._tag).toBe("Cancelled");
      vi.setSystemTime(Date.now() + 60_000);
      await h.namespaces.MAILBOXES.instance(ana.mailboxId).alarm();
      await h.drain();
      expect(published()).toBe(false);
    }
  });

  it("[A03] signup records the browser time zone for the calendar (invalid zones are rejected)", async () => {
    const real = globalThis.fetch;
    globalThis.fetch = (async () => Response.json({ success: true })) as typeof fetch;
    try {
      const bad = await call(h, null, "POST", "/auth/signup", {
        address: "zoe@bye.test",
        displayName: "Zoe",
        turnstile: "t",
        timeZone: "Mars/Olympus",
      });
      expect(bad.status).toBe(400);
      const ok = await call(h, null, "POST", "/auth/signup", {
        address: "zoe@bye.test",
        displayName: "Zoe",
        turnstile: "t",
        timeZone: "Europe/Berlin",
      });
      expect(ok.status).toBe(201);
      const cal = await h.d1
        .prepare("SELECT id FROM calendars WHERE owner_user_id = ?")
        .bind(ok.body.userId)
        .first<{ id: string }>();
      const store = (
        h.namespaces.CALENDARS.instance(cal!.id) as unknown as {
          ctx: { storage: { kv: { get(k: string): { defaultZone: string } } } };
        }
      ).ctx.storage.kv.get("config");
      expect(store.defaultZone).toBe("Europe/Berlin");
    } finally {
      globalThis.fetch = real;
    }
  });

  it("[O04] replies to a thread shared with future messages are appended to the shared thread", async () => {
    const { handleInbound } = await import("../src/inbound.ts");
    const { inboundMessage, rfc822 } = await import("./harness.ts");
    const ana = await signup(h, "ana@bye.test");
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
        "bob@example.net",
        "ana@bye.test",
        rfc822({
          from: "bob@example.net",
          to: "ana@bye.test",
          subject: "Project",
          body: "first",
          messageId: "p1@example.net",
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
    const spaceId = (
      await call(h, ana, "POST", "/v1/spaces", { organizationId: ana.organizationId })
    ).body.spaceId as string;
    const sharedThreadId = (
      await call(h, ana, "POST", "/v1/shared-threads", {
        spaceId,
        mailboxId: ana.mailboxId,
        threadId: thread.threadId,
        messageRefs: detail.body.deliveries.map((d: { deliveryId: string }) => d.deliveryId),
        grantees: [],
        includeFuture: true,
      })
    ).body as string;
    await handleInbound(
      inboundMessage(
        "bob@example.net",
        "ana@bye.test",
        rfc822({
          from: "bob@example.net",
          to: "ana@bye.test",
          subject: "Re: Project",
          body: "second",
          messageId: "p2@example.net",
          inReplyTo: "p1@example.net",
        }),
      ),
      h.env,
    );
    await h.drain();
    const sharedView = await call(h, ana, "GET", `/v1/spaces/${spaceId}/threads/${sharedThreadId}`);
    expect(sharedView.status).toBe(200);
    expect(JSON.stringify(sharedView.body)).toContain("Re: Project");
  });

  it("[O03] mail to an extension address lands in the shared space's common history", async () => {
    const { handleInbound } = await import("../src/inbound.ts");
    const { inboundMessage, rfc822 } = await import("./harness.ts");
    const owner = await signup(h, "owner@bye.test");
    const org = (
      await call(h, owner, "POST", "/v1/orgs", { kind: "domain", name: "Acme", seatLimit: 5 })
    ).body;
    const orgId = org.orgId ?? org.id;
    await h.d1
      .prepare(
        "INSERT INTO domains (id, org_id, name, state, verification_token, created_at, updated_at) VALUES ('dom_acme', ?, 'acme.test', 'active', 't', 0, 0)",
      )
      .bind(orgId)
      .run();
    const ext = await call(h, owner, "POST", `/v1/orgs/${orgId}/extensions`, {
      domainId: "dom_acme",
      localPart: "support",
      memberIds: [owner.userId],
      displayName: "Support",
    });
    expect(ext.status).toBe(201);
    expect(ext.body.address).toBe("support@acme.test");
    await handleInbound(
      inboundMessage(
        "customer@example.net",
        "support@acme.test",
        rfc822({
          from: "customer@example.net",
          to: "support@acme.test",
          subject: "Help please",
          body: "it broke",
          messageId: "h1@example.net",
        }),
      ),
      h.env,
    );
    // Extension mailboxes screen like any mailbox; approve the sender so the delivery is active.
    const mbx = ext.body.mailboxId as string;
    await h.env.MAILBOXES.getByName(mbx).execute({
      _tag: "Screen",
      commandId: cmdId(),
      decisions: [{ sender: "customer@example.net", decision: "allow", destination: "imbox" }],
    } as never);
    await handleInbound(
      inboundMessage(
        "customer@example.net",
        "support@acme.test",
        rfc822({
          from: "customer@example.net",
          to: "support@acme.test",
          subject: "Help again",
          body: "still broken",
          messageId: "h2@example.net",
        }),
      ),
      h.env,
    );
    await h.drain();
    const threads = await call(h, owner, "GET", `/v1/spaces/${ext.body.spaceId}/threads`);
    expect(threads.status).toBe(200);
    expect(JSON.stringify(threads.body)).toContain("Help again");
  });
});

describe("space change feed and live channels", () => {
  (globalThis as { FixedLengthStream?: unknown }).FixedLengthStream = class extends (
    TransformStream
  ) {
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
    readonly calendarId: string;
    readonly organizationId: string;
    readonly token: string;
    readonly sessionId: string;
  }

  const signup = async (h: Harness, address: string): Promise<Account> => {
    const account = await new ControlDirectory(
      h.env.DIRECTORY,
      kernelClock,
    ).provisionPersonalAccount({ address, displayName: address.split("@")[0]! });
    await h.env.CALENDARS.getByName(account.calendarId).provision({
      ownerId: account.userId,
      selfAddresses: [address],
      defaultZone: "UTC",
    });
    const session = await new ControlAuth(
      h.env.DIRECTORY,
      kernelClock,
      await authConfig(h.env),
    ).issueSession(account.userId, "t", true);
    const row = await h.d1
      .prepare("SELECT id FROM sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT 1")
      .bind(account.userId)
      .first<{ id: string }>();
    return {
      userId: account.userId,
      mailboxId: account.mailboxId,
      calendarId: account.calendarId,
      organizationId: account.organizationId,
      token: session.token,
      sessionId: row!.id,
    };
  };

  const call = async (
    h: Harness,
    a: Account | null,
    method: string,
    path: string,
    json?: unknown,
    headers: Record<string, string> = {},
  ) => {
    const r = await handleFetch(
      new Request(`${h.env.APP_ORIGIN}${path}`, {
        method,
        headers: {
          ...(a ? { cookie: `__Host-session=${a.token}` } : {}),
          ...(method === "GET" ? {} : { origin: h.env.APP_ORIGIN }),
          ...(json !== undefined ? { "content-type": "application/json" } : {}),
          ...headers,
        },
        ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
      }),
      h.env,
      ctx,
    );
    return { status: r.status, body: (await r.json().catch(() => null)) as any };
  };

  /** Run the Cron reconciler over every catalog shard (one full rotation). */

  let h: Harness;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2026, 8, 26, 12));
    h = makeHarness();
  });
  afterEach(() => vi.useRealTimers());

  it("[§8] spaces expose a member-only change feed", async () => {
    const ana = await signup(h, "ana@bye.test");
    const eve = await signup(h, "eve@bye.test");
    const spaceId = (
      await call(h, ana, "POST", "/v1/spaces", { organizationId: ana.organizationId })
    ).body.spaceId as string;
    await h.env.SHARED_SPACES.getByName(`space:${spaceId}`).setMember(
      ana.userId,
      "usr_other",
      "member",
    );
    const feed = await call(h, ana, "GET", `/v1/spaces/${spaceId}/changes?cursor=0`);
    expect(feed.status).toBe(200);
    expect(feed.body.changes.length).toBeGreaterThan(0);
    expect(feed.body.cursor).toBeGreaterThan(0);
    expect((await call(h, eve, "GET", `/v1/spaces/${spaceId}/changes?cursor=0`)).status).toBe(404);
  });

  it("[§8] cookie-authenticated /v1/live upgrades must come from the app origin; bearer upgrades need none", async () => {
    const ana = await signup(h, "ana@bye.test");
    const calObj = h.namespaces.CALENDARS.instance(ana.calendarId) as unknown as {
      fetch(r: Request): Promise<Response>;
    };
    calObj.fetch = async () => new Response(null, { status: 204 });
    const path = `/v1/live?calendar=${ana.calendarId}`;
    const ws = { upgrade: "websocket" };
    expect((await call(h, ana, "GET", path, undefined, ws)).status).toBe(403);
    expect(
      (await call(h, ana, "GET", path, undefined, { ...ws, origin: "https://evil.example" }))
        .status,
    ).toBe(403);
    expect(
      (await call(h, ana, "GET", path, undefined, { ...ws, origin: h.env.APP_ORIGIN })).status,
    ).toBe(204);
    expect(
      (await call(h, null, "GET", path, undefined, { ...ws, authorization: `Bearer ${ana.token}` }))
        .status,
    ).toBe(204);
  });

  it("/healthz is unauthenticated, uncached and detail-free: 200 with D1 up, 503 without", async () => {
    const up = await handleFetch(new Request(`${h.env.APP_ORIGIN}/healthz`), h.env, ctx);
    expect([up.status, up.headers.get("cache-control"), await up.text()]).toEqual([
      200,
      "no-store",
      "ok",
    ]);
    h.d1.failing = true;
    try {
      const down = await handleFetch(new Request(`${h.env.APP_ORIGIN}/healthz`), h.env, ctx);
      expect([down.status, down.headers.get("cache-control"), await down.text()]).toEqual([
        503,
        "no-store",
        "unavailable",
      ]);
    } finally {
      h.d1.failing = false;
    }
  });

  it("[§8] /v1/live authorizes calendars and spaces, tags the socket with the verified credential, and sends seq hints", async () => {
    const ana = await signup(h, "ana@bye.test");
    const eve = await signup(h, "eve@bye.test");
    const spaceId = (
      await call(h, ana, "POST", "/v1/spaces", { organizationId: ana.organizationId })
    ).body.spaceId as string;
    const forwarded: Array<string | null> = [];
    const capture = async (r: Request) => (
      forwarded.push(r.headers.get("x-bye-credential")),
      new Response(null, { status: 204 })
    );
    const spaceObj = h.namespaces.SHARED_SPACES.instance(`space:${spaceId}`) as unknown as {
      fetch(r: Request): Promise<Response>;
    };
    const calObj = h.namespaces.CALENDARS.instance(ana.calendarId) as unknown as {
      fetch(r: Request): Promise<Response>;
    };
    const realSpaceFetch = spaceObj.fetch.bind(spaceObj);
    spaceObj.fetch = capture;
    calObj.fetch = capture;
    const live = (a: Account, query: string) =>
      call(h, a, "GET", `/v1/live?${query}`, undefined, {
        upgrade: "websocket",
        origin: h.env.APP_ORIGIN,
        "x-bye-credential": "forged",
      });

    expect((await live(ana, `space=${spaceId}`)).status).toBe(204);
    expect((await live(ana, `calendar=${ana.calendarId}`)).status).toBe(204);
    expect(forwarded).toEqual([ana.sessionId, ana.sessionId]);
    expect((await live(eve, `space=${spaceId}`)).status).toBe(403);
    expect((await live(eve, `calendar=${ana.calendarId}`)).status).toBe(403);
    expect((await live(ana, `space=${spaceId}&calendar=${ana.calendarId}`)).status).toBe(400);
    expect(forwarded).toHaveLength(2);

    // Seq hints: the accepted socket gets the current sequence, then a newer one after a change.
    const sent: Array<number> = [];
    const socket = {
      send: (d: string) => sent.push((JSON.parse(d) as { seq: number }).seq),
      close: () => undefined,
    };
    const g = globalThis as unknown as { WebSocketPair?: unknown; Response: typeof Response };
    const RealResponse = g.Response;
    g.WebSocketPair = class {
      0 = {};
      1 = socket;
    };
    g.Response = class extends RealResponse {
      constructor(body?: BodyInit | null, init?: ResponseInit) {
        super(body, init?.status === 101 ? { ...init, status: 200 } : init);
      }
    } as typeof Response;
    try {
      await realSpaceFetch(
        new Request("https://do/live", {
          headers: { upgrade: "websocket", "x-bye-credential": ana.sessionId },
        }),
      );
    } finally {
      g.Response = RealResponse;
      delete g.WebSocketPair;
    }
    expect(sent).toHaveLength(1);
    const space = h.env.SHARED_SPACES.getByName(`space:${spaceId}`);
    await space.setMember(ana.userId, eve.userId, "member");
    await h.settle();
    expect(sent.length).toBeGreaterThan(1);
    expect(sent.at(-1)!).toBeGreaterThan(sent[0]!);
  });
});

describe("MBOX export paging", () => {
  (globalThis as { FixedLengthStream?: unknown }).FixedLengthStream ??= class extends (
    TransformStream
  ) {
    constructor(_n: number) {
      super();
    }
  };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2026, 8, 25, 12));
  });
  afterEach(() => vi.useRealTimers());

  it("[A04] pages through every message into one multipart MBOX; retries and re-completion are safe; bytes are preserved", async () => {
    const h = makeHarness();
    const account = await new ControlDirectory(
      h.env.DIRECTORY,
      kernelClock,
    ).provisionPersonalAccount({ address: "ana@bye.test", displayName: "Ana" });
    for (let i = 0; i < 5; i++) {
      const raw = rfc822({
        from: "bob@example.net",
        to: "ana@bye.test",
        subject: `Message ${i} — café`,
        body: `body ${i} ünïcode`,
        messageId: `m${i}@example.net`,
      });
      await handleInbound(inboundMessage("bob@example.net", "ana@bye.test", raw), h.env);
    }
    await h.drain();

    const key = "t/usr/export/e1/mbx.mbox";
    const upload = await h.env.EXPORTS.createMultipartUpload(key);
    let state: MboxState = { cursor: null, parts: [], carry: null };
    let i = 0;
    do {
      const input = state;
      const carryKey = `carry/${i}`;
      const first = await appendMboxPage(
        h.env,
        account.mailboxId,
        key,
        upload.uploadId,
        input,
        carryKey,
        2,
        64,
      );
      // A retried step with the same input produces the same progress.
      const retried = await appendMboxPage(
        h.env,
        account.mailboxId,
        key,
        upload.uploadId,
        input,
        carryKey,
        2,
        64,
      );
      expect(retried).toEqual(first);
      state = first;
      i++;
    } while (state.cursor);
    expect(i).toBe(3);
    expect(state.parts.length).toBeGreaterThan(1);
    await completeMbox(h.env, key, upload.uploadId, state);
    // Completing again (a retried step) never replaces the finished file.
    await completeMbox(h.env, key, upload.uploadId, { cursor: null, parts: [], carry: null });

    const mbox = new Uint8Array(await (await h.env.EXPORTS.get(key))!.arrayBuffer());
    const originals = [...h.buckets.ORIGINALS.objects.entries()].filter(([k]) =>
      k.includes("/orig/"),
    );
    const expected = originals.reduce(
      (n, [, o]) =>
        n +
        binaryToBytes(mboxEntryText({ envelopeFrom: "bob@example.net", date: 0, bytes: o.bytes }))
          .byteLength,
      0,
    );
    expect(Math.abs(mbox.byteLength - expected)).toBeLessThan(originals.length * 64);
    const text = new TextDecoder().decode(mbox);
    for (let m = 0; m < 5; m++) expect(text).toContain(`body ${m} ünïcode`);
    expect((text.match(/^From /gm) ?? []).length).toBe(5);
  });
});

describe("sending ramp", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2026, 8, 25, 12));
  });
  afterEach(() => vi.useRealTimers());

  it("[§10] shared (extension) mailboxes ramp with their organization's age, not the new-account tier forever", async () => {
    const h = makeHarness();
    const policy = new SendingPolicy(h.env.DIRECTORY, kernelClock);
    const old = Date.now() - 400 * 24 * 3600_000;
    await h.d1
      .prepare(
        "INSERT INTO organizations (id, name, kind, seat_limit, created_at) VALUES ('org_old', 'Acme', 'domain', 10, ?)",
      )
      .bind(old)
      .run();
    await h.d1
      .prepare(
        "INSERT INTO mailboxes (id, org_id, owner_user_id, kind, created_at) VALUES ('mbx_support', 'org_old', NULL, 'extension', ?)",
      )
      .bind(old)
      .run();
    const newAccountTier = await policy.dailyBudget("usr_brand_new_unknown");
    expect(await policy.dailyBudget("mbx_support")).toBeGreaterThan(newAccountTier);
  });
});

describe("export download capabilities", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2026, 8, 25, 12));
  });
  afterEach(() => vi.useRealTimers());

  it("[A04] export and signup capabilities use the unified format, are bound to key and expiry, and legacy hex tokens are refused", async () => {
    const h = makeHarness();
    const now = Date.now();
    const exp = now + 60_000;
    const key = "t/usr/export/e/x.mbox";
    const token = await signDownload(h.env, key, exp, now);
    expect(token).toMatch(/^export\./);
    // Unified tokens: valid for their key until expiry; a flipped signature character is refused.
    // (Route-level tamper/forgery is covered by "[A04] exports list files with expiring signed links".)
    expect(await verifyDownload(h.env, key, token, now)).toBe(true);
    const tampered = `${token.slice(0, -1)}${token.endsWith("0") ? "1" : "0"}`;
    expect(await verifyDownload(h.env, key, tampered, now)).toBe(false);
    expect(await verifyDownload(h.env, "t/usr/export/e/other.mbox", token, now)).toBe(false);
    expect(await verifyDownload(h.env, key, token, exp + 1)).toBe(false);
    const legacyDownload = `${exp}.${await hmacHex(h.env.SESSION_KEY, `download:${key}:${exp}`)}`;
    expect(await verifyDownload(h.env, key, legacyDownload, now)).toBe(false);

    const signup = await signupToken(h.env, "usr_1", now);
    expect(signup).toMatch(/^signup\./);
    expect(await verifySignupToken(h.env, "usr_1", signup, now)).toBe(true);
    expect(await verifySignupToken(h.env, "usr_2", signup, now)).toBe(false);
    const legacySignup = `${exp}.${await hmacHex(h.env.SESSION_KEY, `signup:usr_1:${exp}`)}`;
    expect(await verifySignupToken(h.env, "usr_1", legacySignup, now)).toBe(false);
    // A capability for one purpose never verifies for another.
    expect(
      await verifySignupToken(h.env, "usr_1", await signDownload(h.env, "usr_1", exp, now), now),
    ).toBe(false);
  });

  it("[§10] SESSION_KEY rotates as a key ring: old links verify until retired, new ones use the current key", async () => {
    const h = makeHarness();
    const now = Date.now();
    const exp = now + 60_000;
    const key = "t/usr/export/e/x.mbox";
    const old = h.env.SESSION_KEY;
    const before = await signDownload(h.env, key, exp, now);
    const rotated = { ...h.env, SESSION_KEY: `v2:rotated-session-key-0123456789abcdef,v1:${old}` };
    // A token minted before the rotation still verifies while v1 stays in the ring.
    expect(await verifyDownload(rotated, key, before, now)).toBe(true);
    // New tokens are minted under v2: they verify with the ring, not with the retired key alone.
    const after = await signDownload(rotated, key, exp, now);
    expect(await verifyDownload(rotated, key, after, now)).toBe(true);
    expect(await verifyDownload(h.env, key, after, now)).toBe(false);
    // Once v1 is retired, its tokens stop verifying.
    const retired = { ...h.env, SESSION_KEY: "v2:rotated-session-key-0123456789abcdef" };
    expect(await verifyDownload(retired, key, before, now)).toBe(false);
    expect(await verifyDownload(retired, key, after, now)).toBe(true);
  });
});

describe("signup, publishing and webhooks", () => {
  (globalThis as { FixedLengthStream?: unknown }).FixedLengthStream = class extends (
    TransformStream
  ) {
    constructor(_length: number) {
      super();
    }
  };

  const ctx = {
    waitUntil: () => undefined,
    passThroughOnException: () => undefined,
  } as unknown as ExecutionContext;
  let n = 0;
  const cmdId = () => `cmd_xh_${(++n).toString(36).padStart(16, "0")}`;

  interface Account {
    readonly userId: string;
    readonly mailboxId: string;
    readonly token: string;
    readonly sessionId: string;
  }

  const signup = async (h: Harness, address: string): Promise<Account> => {
    const account = await new ControlDirectory(
      h.env.DIRECTORY,
      kernelClock,
    ).provisionPersonalAccount({ address, displayName: address.split("@")[0]! });
    const session = await new ControlAuth(
      h.env.DIRECTORY,
      kernelClock,
      await authConfig(h.env),
    ).issueSession(account.userId, "t", true);
    const row = await h.d1
      .prepare("SELECT id FROM sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT 1")
      .bind(account.userId)
      .first<{ id: string }>();
    return {
      userId: account.userId,
      mailboxId: account.mailboxId,
      token: session.token,
      sessionId: row!.id,
    };
  };

  const call = async (
    h: Harness,
    a: Account | null,
    method: string,
    path: string,
    init: { json?: unknown; body?: BodyInit; headers?: Record<string, string> } = {},
  ) => {
    const r = await handleFetch(
      new Request(`${h.env.APP_ORIGIN}${path}`, {
        method,
        headers: {
          ...(a ? { cookie: `__Host-session=${a.token}` } : {}),
          ...(method === "GET" ? {} : { origin: h.env.APP_ORIGIN }),
          ...(init.json !== undefined ? { "content-type": "application/json" } : {}),
          ...init.headers,
        },
        ...(init.json !== undefined
          ? { body: JSON.stringify(init.json) }
          : init.body !== undefined
            ? { body: init.body }
            : {}),
      }),
      h.env,
      ctx,
    );
    return { status: r.status, body: (await r.json().catch(() => null)) as any };
  };

  const command = (h: Harness, a: Account, body: Record<string, unknown>) =>
    call(h, a, "POST", `/v1/mailboxes/${a.mailboxId}/commands`, {
      json: { commandId: cmdId(), ...body },
    });

  /** Run due mailbox jobs and queues with the provider transport mocked; returns submitted bodies. */

  let h: Harness;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2026, 8, 25, 12));
    h = makeHarness();
    enablePersonalMail(h);
  });
  afterEach(() => vi.useRealTimers());

  it("[A01] signup refuses reserved system local parts and malformed addresses on the service domain", async () => {
    const real = globalThis.fetch;
    globalThis.fetch = (async () => Response.json({ success: true })) as typeof fetch;
    try {
      const attempt = (address: string) =>
        call(h, null, "POST", "/auth/signup", {
          json: { address, displayName: "x", turnstile: "t" },
        });
      for (const reserved of [
        "world@bye.test",
        "no-reply@bye.test",
        "postmaster@bye.test",
        "abuse@bye.test",
      ])
        expect((await attempt(reserved)).status).toBe(403);
      for (const malformed of [
        "@bye.test",
        "a..b@bye.test",
        ".ana@bye.test",
        "ana+tag@bye.test",
        "an a@bye.test",
      ])
        expect((await attempt(malformed)).status).toBe(400);
      expect((await attempt("zoe@bye.test")).status).toBe(201);
    } finally {
      globalThis.fetch = real;
    }
  });

  it("[P01] custom-domain users publish via world@<service domain>; world@<their domain> is ordinary mail", async () => {
    const carl = await signup(h, "carl@acme.test");
    await command(h, carl, { _tag: "AddIdentity", address: "carl@acme.test", kind: "hosted" });
    const send = async (to: string) => {
      const draft = await call(h, carl, "POST", "/v1/drafts", {
        json: {
          mailboxId: carl.mailboxId,
          commandId: cmdId(),
          content: {
            to: [{ address: to }],
            cc: [],
            bcc: [],
            subject: "Hi",
            text: "x",
            attachments: [],
          },
        },
      });
      return (
        await call(h, carl, "POST", `/v1/drafts/${draft.body.draftId}/send`, {
          json: { mailboxId: carl.mailboxId, commandId: cmdId(), revision: draft.body.revision },
        })
      ).body.sendJobIds as Array<string>;
    };
    const classOf = async (to: string) =>
      (await h.namespaces.MAILBOXES.instance(carl.mailboxId).sendJob((await send(to))[0]!))
        ?.trafficClass;
    expect(await classOf("world@acme.test")).not.toBe("publish");
    expect(await classOf("world@bye.test")).toBe("publish");
    expect((await call(h, carl, "GET", "/v1/world")).body.publishAddress).toBe("world@bye.test");
  });

  it("[P02] subscriber mail embeds sanitized author HTML", () => {
    const { html: raw } = renderNewsletter(h.env, "ana", {
      slug: "hi",
      title: "Hi",
      html: `<p>ok</p><script>steal()</script><img src="x" onerror="steal()">`,
      text: "ok",
    });
    expect(raw).toContain("ok");
    expect(raw).not.toMatch(/<script/i);
    expect(raw).not.toMatch(/onerror/i);
  });
});

describe("public share rendering", () => {
  (globalThis as { FixedLengthStream?: unknown }).FixedLengthStream = class extends (
    TransformStream
  ) {
    constructor(_length: number) {
      super();
    }
  };

  /** Run due mailbox jobs and queues with the provider transport mocked; returns submitted bodies. */

  let h: Harness;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2026, 8, 25, 12));
    h = makeHarness();
  });
  afterEach(() => vi.useRealTimers());

  it("[O05] public share pages never load remote images from stored bodies", async () => {
    const { PublicGateway } = await import("../src/gateway.ts");
    await h.buckets.PARTS.put(
      "t/mbx_s/body/ing_1.json",
      JSON.stringify({
        text: "x",
        html: '<style>article header{display:none}</style><p>hi <img src="https://cdn.example.net/t.png"></p>',
        remoteImages: 1,
        blockedTrackers: 0,
      }),
    );
    const gateway = Object.create(PublicGateway.prototype) as {
      env: unknown;
      resolveShareLink(s: string, t: string): Promise<{ messages: Array<{ html: string }> } | null>;
    };
    gateway.env = {
      ...h.env,
      SHARED_SPACES: {
        getByName: () => ({
          resolvePublicLink: async () => ({
            ok: true,
            value: {
              subject: "s",
              messages: [
                {
                  from: { address: "a@x.test" },
                  subject: "s",
                  sentAt: 0,
                  contentKey: "t/mbx_s/orig/ing_1.eml",
                  snippet: "x",
                },
              ],
            },
          }),
        }),
      },
    };
    const view = await gateway.resolveShareLink("spc_1", "tok");
    expect(view?.messages[0]?.html).toContain("hi");
    expect(view?.messages[0]?.html).not.toContain("cdn.example.net");
    // One document holds every message: a message's stylesheet must not reach the page.
    expect(view?.messages[0]?.html).not.toContain("<style");
    expect(view?.messages[0]?.html).not.toContain("display:none");
  });
});

describe("step-up signalling", () => {
  (globalThis as { FixedLengthStream?: unknown }).FixedLengthStream = class extends (
    TransformStream
  ) {
    constructor(_length: number) {
      super();
    }
  };

  const ctx = {
    waitUntil: () => undefined,
    passThroughOnException: () => undefined,
  } as unknown as ExecutionContext;
  let n = 0;
  const cmdId = () => `cmd_xh_${(++n).toString(36).padStart(16, "0")}`;

  interface Account {
    readonly userId: string;
    readonly mailboxId: string;
    readonly token: string;
    readonly sessionId: string;
  }

  const signup = async (h: Harness, address: string): Promise<Account> => {
    const account = await new ControlDirectory(
      h.env.DIRECTORY,
      kernelClock,
    ).provisionPersonalAccount({ address, displayName: address.split("@")[0]! });
    const session = await new ControlAuth(
      h.env.DIRECTORY,
      kernelClock,
      await authConfig(h.env),
    ).issueSession(account.userId, "t", true);
    const row = await h.d1
      .prepare("SELECT id FROM sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT 1")
      .bind(account.userId)
      .first<{ id: string }>();
    return {
      userId: account.userId,
      mailboxId: account.mailboxId,
      token: session.token,
      sessionId: row!.id,
    };
  };

  const call = async (
    h: Harness,
    a: Account | null,
    method: string,
    path: string,
    init: { json?: unknown; body?: BodyInit; headers?: Record<string, string> } = {},
  ) => {
    const r = await handleFetch(
      new Request(`${h.env.APP_ORIGIN}${path}`, {
        method,
        headers: {
          ...(a ? { cookie: `__Host-session=${a.token}` } : {}),
          ...(method === "GET" ? {} : { origin: h.env.APP_ORIGIN }),
          ...(init.json !== undefined ? { "content-type": "application/json" } : {}),
          ...init.headers,
        },
        ...(init.json !== undefined
          ? { body: JSON.stringify(init.json) }
          : init.body !== undefined
            ? { body: init.body }
            : {}),
      }),
      h.env,
      ctx,
    );
    return { status: r.status, body: (await r.json().catch(() => null)) as any };
  };

  const command = (h: Harness, a: Account, body: Record<string, unknown>) =>
    call(h, a, "POST", `/v1/mailboxes/${a.mailboxId}/commands`, {
      json: { commandId: cmdId(), ...body },
    });

  /** Run due mailbox jobs and queues with the provider transport mocked; returns submitted bodies. */

  let h: Harness;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2026, 8, 25, 12));
    h = makeHarness();
  });
  afterEach(() => vi.useRealTimers());

  it("[§10] only real step-up refusals carry the machine-readable stepUp marker", async () => {
    const ana = await signup(h, "ana@bye.test");
    const fresh = await new ControlAuth(
      h.env.DIRECTORY,
      kernelClock,
      await authConfig(h.env),
    ).issueSession(ana.userId, "t", false);
    const notStepped = { ...ana, token: fresh.token };
    const needs = await command(h, notStepped, {
      _tag: "AddIdentity",
      address: "ana@bye.test",
      kind: "hosted",
    });
    expect(needs.status).toBe(403);
    expect(needs.body.error.details).toMatchObject({ stepUp: true });
    const refused = await command(h, ana, {
      _tag: "AddIdentity",
      address: "ceo@bye.test",
      kind: "hosted",
    });
    expect(refused.status).toBe(403);
    expect(refused.body.error.details?.stepUp).toBeUndefined();
  });
});

describe("read-only credentials", () => {
  let h: Harness;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2026, 8, 26, 12));
    h = makeHarness();
  });
  afterEach(() => vi.useRealTimers());

  /** An interactive owner (cookie) plus a read-only agent token for the same user. */
  const owner = async () => {
    const account = await new ControlDirectory(
      h.env.DIRECTORY,
      kernelClock,
    ).provisionPersonalAccount({ address: "ana@bye.test", displayName: "ana" });
    const auth = new ControlAuth(h.env.DIRECTORY, kernelClock, await authConfig(h.env));
    const session = await auth.issueSession(account.userId, "t", true);
    const agent = await auth.createApiToken(session.session.user_id, {
      kind: "agent",
      label: "ro",
      scopes: ["read"],
    });
    return { account, cookie: `__Host-session=${session.token}`, bearer: `Bearer ${agent.token}` };
  };
  const req = (method: string, path: string, headers: Record<string, string>, json?: unknown) =>
    handleFetch(
      new Request(`${h.env.APP_ORIGIN}${path}`, {
        method,
        headers: {
          ...headers,
          ...(method === "GET" ? {} : { origin: h.env.APP_ORIGIN }),
          ...(json !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
      }),
      h.env,
      ctx,
    );

  it("[O03] read-only credentials can read a space but never change it", async () => {
    const { account, cookie, bearer } = await owner();
    const created = await req(
      "POST",
      "/v1/spaces",
      { cookie },
      { organizationId: account.organizationId },
    );
    expect(created.status).toBe(201);
    const { spaceId } = (await created.json()) as { spaceId: string };
    // Real, existing targets (the owner's own membership), so a refusal cannot be "not found".
    const self = account.userId;
    const ro = { authorization: bearer };
    expect((await req("GET", `/v1/spaces/${spaceId}/members`, ro)).status).toBe(200);
    for (const [method, path, json] of [
      ["POST", "/v1/spaces", { organizationId: account.organizationId }],
      ["PUT", `/v1/spaces/${spaceId}/members/${self}`, { role: "member" }],
      ["DELETE", `/v1/spaces/${spaceId}/members/${self}`, undefined],
      ["POST", `/v1/spaces/${spaceId}/threads/sth_1/comments`, { body: "hi" }],
      ["POST", `/v1/spaces/${spaceId}/collections`, { name: "C" }],
      [
        "POST",
        `/v1/spaces/${spaceId}/grants`,
        { kind: "thread", resourceId: "sth_1", grantee: self },
      ],
      ["DELETE", `/v1/spaces/${spaceId}/grants/grt_1`, undefined],
      ["DELETE", `/v1/spaces/${spaceId}/public-links/lnk_1`, undefined],
    ] as const) {
      const r = await req(method, path, ro, json);
      const body = (await r.json()) as { error: { code: string; message: string } };
      // The refusal is the scope check itself (write/admin/draft), not a membership or existence failure.
      expect([method, path, r.status, body.error.code, body.error.message]).toEqual([
        method,
        path,
        403,
        "forbidden",
        expect.stringMatching(/^missing scope (write|admin|draft)$/),
      ]);
    }
    const members = await (await req("GET", `/v1/spaces/${spaceId}/members`, ro)).text();
    // The owner is still the space's admin: neither the demotion nor the removal happened.
    expect(members).toContain(self);
    expect(members).toMatch(/"role":"(admin|owner)"/);
  });

  it("[A04] read-only agents can neither revoke device sessions nor start or read full-account exports", async () => {
    const { account, cookie, bearer } = await owner();
    const now = Date.now();
    await h.d1
      .prepare(
        "INSERT INTO device_sessions (id, user_id, client_id, device_name, created_at, last_used_at, idle_expires_at, absolute_expires_at) VALUES ('dvs_real', ?, 'bye-desktop', 'Mac', ?, ?, ?, ?)",
      )
      .bind(account.userId, now, now, now + 86400_000, now + 30 * 86400_000)
      .run();
    const started = await req("POST", "/v1/exports", { cookie }, {});
    expect(started.status).toBe(202);
    const { exportId } = (await started.json()) as { exportId: string };
    const ro = { authorization: bearer };
    for (const [method, path, json] of [
      ["DELETE", "/v1/devices/dvs_real", undefined],
      ["POST", "/v1/exports", {}],
      ["GET", `/v1/exports/${exportId}`, undefined],
    ] as const) {
      const r = await req(method, path, ro, json);
      const body = (await r.json()) as { error: { code: string; message: string } };
      expect([path, r.status, body.error.code, body.error.message]).toEqual([
        path,
        403,
        "forbidden",
        expect.stringMatching(/missing scope|interactive session/),
      ]);
    }
    // Nothing happened: the device session survives and no second export was started.
    expect(
      await h.d1.prepare("SELECT revoked_at FROM device_sessions WHERE id = 'dvs_real'").first(),
    ).toMatchObject({ revoked_at: null });
    expect(h.workflows.EXPORT_ACCOUNT).toHaveLength(1);
    // The account holder's own session still can.
    expect((await req("GET", `/v1/exports/${exportId}`, { cookie })).status).toBe(200);
    expect((await req("DELETE", "/v1/devices/dvs_real", { cookie })).status).toBe(200);
  });
});
