import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ControlAuth,
  ControlDirectory,
  pkceChallenge,
  base32Decode,
  hotp,
  REPLAY_ATTEMPT_CAP,
  totpStep,
} from "@bye/platform-cloudflare";
import { handleFetch } from "../src/api.ts";
import { kernelClock } from "../src/durable-host.ts";
import { handleInbound } from "../src/inbound.ts";
import { reconcileCatalog, reconcileIngress, shardsForRun } from "../src/scheduled.ts";
import { authConfig } from "../src/services.ts";
import { CONSENT_STYLE } from "../src/routes/common.ts";
import {
  FakeServerSocket,
  type Harness,
  inboundMessage,
  installWebSocketPair,
  makeHarness,
  rfc822,
} from "./harness.ts";
import { signProxyUrl } from "@bye/mail-codec";
import { forbiddenResolution, readCapped } from "../src/dns.ts";
import { handleImageProxy, type ImageProxyDeps, MAX_IMAGE_BYTES } from "../src/render.ts";
import { type CoreEnv, journalPartition } from "../src/env.ts";
import { ExportWorkflow } from "../src/workflows/export.ts";
import {
  type ProbeFetch,
  probeInstance,
} from "../../../packages/native-shared/src/instance/index.ts";

// End-to-end wiring tests: real MailCore modules (HTTP API, email handler, queue consumers, DO
// hosts, cron) over in-memory bindings. Store-level semantics are covered in packages/*.

(globalThis as { FixedLengthStream?: unknown }).FixedLengthStream = class extends TransformStream {
  constructor(_length: number) {
    super();
  }
};

(globalThis as { __BYE_DEBUG__?: boolean }).__BYE_DEBUG__ = true;
const ctx = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
} as unknown as ExecutionContext;

interface Account {
  readonly userId: string;
  readonly mailboxId: string;
  readonly calendarId: string;
  readonly address: string;
  readonly cookie: string;
}

const signup = async (h: Harness, address: string): Promise<Account> => {
  const directory = new ControlDirectory(h.env.DIRECTORY, kernelClock);
  const account = await directory.provisionPersonalAccount({
    address,
    displayName: address.split("@")[0]!,
  });
  await h.env.CALENDARS.getByName(account.calendarId).provision({
    ownerId: account.userId,
    selfAddresses: [account.address],
    defaultZone: "UTC",
  });
  const auth = new ControlAuth(h.env.DIRECTORY, kernelClock, await authConfig(h.env));
  const session = await auth.issueSession(account.userId, "test", true);
  return { ...account, cookie: `__Host-session=${session.token}` };
};

const api = async (
  h: Harness,
  account: Account | null,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) => {
  const response = await handleFetch(
    new Request(`${h.env.APP_ORIGIN}${path}`, {
      method,
      headers: {
        ...(account ? { cookie: account.cookie } : {}),
        ...(method === "GET"
          ? {}
          : { origin: h.env.APP_ORIGIN, "content-type": "application/json" }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    h.env,
    ctx,
  );
  const text = await response.text();
  const isJson = (response.headers.get("content-type") ?? "").includes("json");
  return {
    status: response.status,
    body: text ? (isJson ? JSON.parse(text) : text) : null,
    headers: response.headers,
  };
};

let n = 0;
const cmdId = () => `cmd_${(++n).toString(36).padStart(20, "0")}`;

const deliver = async (
  h: Harness,
  from: string,
  to: string,
  subject: string,
  body: string,
  extra: { messageId?: string; inReplyTo?: string; headers?: string } = {},
) => {
  const message = inboundMessage(
    from,
    to,
    rfc822({
      from,
      to,
      subject,
      body,
      messageId: extra.messageId ?? `${subject.replace(/\W/g, "")}-${n++}@example.net`,
      ...(extra.inReplyTo ? { inReplyTo: extra.inReplyTo } : {}),
      ...(extra.headers ? { extraHeaders: extra.headers } : {}),
    }),
  );
  const outcome = await handleInbound(message, h.env);
  await h.drain();
  return { outcome, message };
};

describe("MailCore wiring", () => {
  let h: Harness;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2026, 8, 25, 12));
    h = makeHarness();
  });
  afterEach(() => vi.useRealTimers());

  it("[E01] inbound mail from an unknown sender waits in the Screener; approval moves it to the Imbox", async () => {
    const ana = await signup(h, "ana@bye.test");
    const { outcome } = await deliver(
      h,
      "stranger@example.net",
      "ana@bye.test",
      "Hello there",
      "Can we talk?",
    );
    expect(outcome._tag).toBe("Accepted");
    expect(h.buckets.ORIGINALS.objects.size).toBe(1);

    const screener = await api(h, ana, "GET", `/v1/mailboxes/${ana.mailboxId}/views/screener`);
    expect(screener.status).toBe(200);
    expect(screener.body.items).toHaveLength(1);
    expect(
      (await api(h, ana, "GET", `/v1/mailboxes/${ana.mailboxId}/views/imbox`)).body.items,
    ).toHaveLength(0);

    const approve = await api(h, ana, "POST", `/v1/mailboxes/${ana.mailboxId}/commands`, {
      _tag: "Screen",
      commandId: cmdId(),
      decisions: [{ sender: "stranger@example.net", decision: "allow", destination: "imbox" }],
    });
    expect(approve.status).toBe(200);
    const imbox = await api(h, ana, "GET", `/v1/mailboxes/${ana.mailboxId}/views/imbox`);
    expect(imbox.body.items.map((t: { subject: string }) => t.subject)).toEqual(["Hello there"]);
  });

  it("[O01] unknown recipients are rejected permanently; directory outages temp-fail instead", async () => {
    await signup(h, "ana@bye.test");
    const unknown = inboundMessage(
      "x@example.net",
      "nobody@bye.test",
      rfc822({
        from: "x@example.net",
        to: "nobody@bye.test",
        subject: "s",
        body: "b",
        messageId: "u1@x",
      }),
    );
    expect((await handleInbound(unknown, h.env))._tag).toBe("Rejected");
    expect(unknown.rejected).toMatch(/^550/);

    h.d1.failing = true;
    const outage = inboundMessage(
      "x@example.net",
      "ana@bye.test",
      rfc822({
        from: "x@example.net",
        to: "ana@bye.test",
        subject: "s",
        body: "b",
        messageId: "u2@x",
      }),
    );
    await expect(handleInbound(outage, h.env)).rejects.toThrow("directory unavailable");
    expect(outage.rejected).toBeNull();
  });

  it("[E21] indexed mail is searchable and every hit is rehydrated from the mailbox", async () => {
    const ana = await signup(h, "ana@bye.test");
    await api(h, ana, "POST", `/v1/mailboxes/${ana.mailboxId}/commands`, {
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
    await deliver(
      h,
      "bob@example.net",
      "ana@bye.test",
      "Quarterly numbers",
      "The zanzibar forecast is attached",
    );
    const hits = await api(h, ana, "GET", `/v1/mailboxes/${ana.mailboxId}/search?q=zanzibar`);
    expect(hits.status).toBe(200);
    expect(hits.body.results).toHaveLength(1);
    expect(hits.body.results[0].kind).toBe("delivery");
    expect(
      (await api(h, ana, "GET", `/v1/mailboxes/${ana.mailboxId}/search?q=nonexistentterm`)).body
        .results,
    ).toHaveLength(0);
  });

  it("[E21] a shard refusal (bad cursor, too many terms) is a 400, not a 500", async () => {
    const ana = await signup(h, "ana@bye.test");
    await deliver(h, "bob@example.net", "ana@bye.test", "Hello", "searchable body");
    const base = `/v1/mailboxes/${ana.mailboxId}/search`;
    const badCursor = await api(h, ana, "GET", `${base}?q=searchable&cursor=not-a-cursor`);
    expect([badCursor.status, badCursor.body.error?.code]).toEqual([400, "bad_request"]);
    const many = Array.from({ length: 80 }, (_, i) => `term${i}`).join(" ");
    const tooMany = await api(h, ana, "GET", `${base}?q=${encodeURIComponent(many)}`);
    expect([tooMany.status, tooMany.body.error?.code]).toEqual([400, "bad_request"]);
  });

  it("[E18] drafts send through the undo window, the transactional transport, and record acceptance", async () => {
    const ana = await signup(h, "ana@bye.test");
    const identity = await api(h, ana, "POST", `/v1/mailboxes/${ana.mailboxId}/commands`, {
      _tag: "AddIdentity",
      commandId: cmdId(),
      address: "ana@bye.test",
      kind: "hosted",
    });
    expect(identity.status).toBe(200);
    const draft = await api(h, ana, "POST", "/v1/drafts", {
      mailboxId: ana.mailboxId,
      commandId: cmdId(),
      content: {
        to: [{ address: "bob@example.net" }],
        cc: [],
        bcc: [{ address: "secret@example.net" }],
        subject: "Lunch",
        text: "Noon?",
        attachments: [],
      },
    });
    expect(draft.status).toBe(201);
    const send = await api(h, ana, "POST", `/v1/drafts/${draft.body.draftId}/send`, {
      mailboxId: ana.mailboxId,
      commandId: cmdId(),
      revision: draft.body.revision,
    });
    expect(send.status).toBe(202);
    expect(send.body._tag).toBe("Queued");

    // Undo window is a real pre-submission delay: nothing is sent until the alarm fires.
    await h.drain();
    expect(h.sent).toHaveLength(0);
    vi.setSystemTime(Date.now() + 60_000);
    const mailbox = h.namespaces.MAILBOXES.instance(ana.mailboxId);
    await mailbox.alarm();
    await h.drain();
    // Personal correspondence needs an approved PersonalMailTransport (§1, §5.4); without one the
    // job is rejected explicitly instead of silently using the transactional-only service.
    const job = await mailbox.sendJob(send.body.sendJobIds[0]);
    expect(job?.state).toBe("rejected");
    expect(job?.failure?.detail).toContain("no approved transport for personal");
    expect(h.sent).toHaveLength(0);
  });

  it("[E18] with an approved personal transport the job is accepted; Bcc stays envelope-only", async () => {
    (h.env as { PERSONAL_MAIL_API_KEY: string }).PERSONAL_MAIL_API_KEY = "pm-key";
    const submitted: Array<{ url: string; body: string; headers: Record<string, string> }> = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (
      url: string,
      init: { body: string; headers: Record<string, string> },
    ) => {
      submitted.push({ url, body: init.body, headers: init.headers });
      return new Response(JSON.stringify({ id: "prov-1", messageId: "wire-1@provider" }), {
        status: 202,
      });
    }) as typeof fetch;
    try {
      const ana = await signup(h, "ana@bye.test");
      await api(h, ana, "POST", `/v1/mailboxes/${ana.mailboxId}/commands`, {
        _tag: "AddIdentity",
        commandId: cmdId(),
        address: "ana@bye.test",
        kind: "hosted",
      });
      const draft = await api(h, ana, "POST", "/v1/drafts", {
        mailboxId: ana.mailboxId,
        commandId: cmdId(),
        content: {
          to: [{ address: "bob@example.net" }],
          cc: [],
          bcc: [{ address: "secret@example.net" }],
          subject: "Lunch",
          text: "Noon?",
          attachments: [],
        },
      });
      const send = await api(h, ana, "POST", `/v1/drafts/${draft.body.draftId}/send`, {
        mailboxId: ana.mailboxId,
        commandId: cmdId(),
        revision: draft.body.revision,
      });
      // A second click with a different command key does not create a second intent.
      const again = await api(h, ana, "POST", `/v1/drafts/${draft.body.draftId}/send`, {
        mailboxId: ana.mailboxId,
        commandId: cmdId(),
        revision: draft.body.revision,
      });
      expect(again.body).toMatchObject({
        _tag: "Queued",
        deduplicated: true,
        sendJobIds: send.body.sendJobIds,
      });
      vi.setSystemTime(Date.now() + 60_000);
      await h.namespaces.MAILBOXES.instance(ana.mailboxId).alarm();
      await h.drain();
      const job = await h.namespaces.MAILBOXES.instance(ana.mailboxId).sendJob(
        send.body.sendJobIds[0],
      );
      expect(job?.state).toBe("accepted");
      expect(submitted).toHaveLength(1);
      const payload = JSON.parse(submitted[0]!.body) as {
        raw?: string;
        to?: Array<string>;
        recipients?: Array<string>;
      };
      expect(JSON.stringify(payload)).toContain("secret@example.net");
      const mime = h.buckets.ORIGINALS.objects.get(job!.contentKey)!;
      const text = new TextDecoder().decode(mime.bytes);
      expect(text).toMatch(/^To: bob@example.net/im);
      expect(text).not.toMatch(/secret@example.net/);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("[E18] a send that fails before provider acceptance hands its budget reservation back", async () => {
    (h.env as { PERSONAL_MAIL_API_KEY: string }).PERSONAL_MAIL_API_KEY = "pm-key";
    let status = 429;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      status === 202
        ? new Response(JSON.stringify({ id: "prov-1", messageId: "wire-1@provider" }), {
            status,
          })
        : new Response("slow down", { status })) as unknown as typeof fetch;
    const counted = async () =>
      Number(
        (
          await h.env.DIRECTORY.prepare(
            "SELECT COALESCE(SUM(sent), 0) AS n FROM sending_counters WHERE scope = 'identity'",
          ).first<{ n: number }>()
        )?.n ?? 0,
      );
    try {
      const ana = await signup(h, "ana@bye.test");
      await api(h, ana, "POST", `/v1/mailboxes/${ana.mailboxId}/commands`, {
        _tag: "AddIdentity",
        commandId: cmdId(),
        address: "ana@bye.test",
        kind: "hosted",
      });
      const draft = await api(h, ana, "POST", "/v1/drafts", {
        mailboxId: ana.mailboxId,
        commandId: cmdId(),
        content: {
          to: [{ address: "bob@example.net" }],
          cc: [],
          bcc: [],
          subject: "Budget",
          text: "retry me",
          attachments: [],
        },
      });
      const send = await api(h, ana, "POST", `/v1/drafts/${draft.body.draftId}/send`, {
        mailboxId: ana.mailboxId,
        commandId: cmdId(),
        revision: draft.body.revision,
      });
      vi.setSystemTime(Date.now() + 60_000);
      const mailbox = h.namespaces.MAILBOXES.instance(ana.mailboxId);
      await mailbox.alarm();
      await h.drain();
      expect((await mailbox.sendJob(send.body.sendJobIds[0]))?.state).not.toBe("accepted");
      // Throttled before acceptance: the reservation was released, so nothing is counted.
      expect(await counted()).toBe(0);
      // The retry reserves again and, once accepted, counts exactly once.
      status = 202;
      vi.setSystemTime(Date.now() + 60 * 60_000);
      await mailbox.alarm();
      await h.drain();
      expect((await mailbox.sendJob(send.body.sendJobIds[0]))?.state).toBe("accepted");
      expect(await counted()).toBe(1);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("[E19] hosted identities require directory send-as authority", async () => {
    const ana = await signup(h, "ana@bye.test");
    await signup(h, "bob@bye.test");
    const spoof = await api(h, ana, "POST", `/v1/mailboxes/${ana.mailboxId}/commands`, {
      _tag: "AddIdentity",
      commandId: cmdId(),
      address: "bob@bye.test",
      kind: "hosted",
    });
    expect(spoof.status).toBe(403);
  });

  it("[E18] cancelling inside the undo window prevents submission", async () => {
    const ana = await signup(h, "ana@bye.test");
    await api(h, ana, "POST", `/v1/mailboxes/${ana.mailboxId}/commands`, {
      _tag: "AddIdentity",
      commandId: cmdId(),
      address: "ana@bye.test",
      kind: "hosted",
    });
    const draft = await api(h, ana, "POST", "/v1/drafts", {
      mailboxId: ana.mailboxId,
      commandId: cmdId(),
      content: {
        to: [{ address: "bob@example.net" }],
        cc: [],
        bcc: [],
        subject: "Oops",
        text: "wrong",
        attachments: [],
      },
    });
    const send = await api(h, ana, "POST", `/v1/drafts/${draft.body.draftId}/send`, {
      mailboxId: ana.mailboxId,
      commandId: cmdId(),
      revision: draft.body.revision,
    });
    const cancel = await api(h, ana, "POST", `/v1/send-jobs/${send.body.sendJobIds[0]}/cancel`, {
      mailboxId: ana.mailboxId,
      commandId: cmdId(),
    });
    expect(cancel.body._tag).toBe("Cancelled");
    vi.setSystemTime(Date.now() + 60_000);
    await h.namespaces.MAILBOXES.instance(ana.mailboxId).alarm();
    await h.drain();
    expect(h.sent).toHaveLength(0);
  });

  it("[E23] message HTML renders only on the separate origin with a short-lived token and strict CSP", async () => {
    const ana = await signup(h, "ana@bye.test");
    await api(h, ana, "POST", `/v1/mailboxes/${ana.mailboxId}/commands`, {
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
    const html =
      '<p>Hi <script>alert(1)</script><img src="https://tracker.example.net/p.gif" width=1 height=1></p>';
    const raw = rfc822({
      from: "news@example.net",
      to: "ana@bye.test",
      subject: "HTML",
      body: html,
      messageId: "html1@example.net",
    }).replace("Content-Type: text/plain", "Content-Type: text/html");
    await handleInbound(inboundMessage("news@example.net", "ana@bye.test", raw), h.env);
    await h.drain();
    const imbox = await api(h, ana, "GET", `/v1/mailboxes/${ana.mailboxId}/views/imbox`);
    const thread = await api(
      h,
      ana,
      "GET",
      `/v1/mailboxes/${ana.mailboxId}/threads/${imbox.body.items[0].threadId}`,
    );
    const renderUrl: string = thread.body.deliveries[0].renderUrl;
    expect(renderUrl.startsWith(h.env.MAIL_ORIGIN)).toBe(true);

    // The API origin never serves rendered mail; the render origin never serves the API.
    expect(
      (
        await handleFetch(
          new Request(renderUrl.replace(h.env.MAIL_ORIGIN, h.env.APP_ORIGIN)),
          h.env,
          ctx,
        )
      ).status,
    ).toBe(404);
    expect((await handleFetch(new Request(`${h.env.MAIL_ORIGIN}/v1/me`), h.env, ctx)).status).toBe(
      404,
    );

    const rendered = await handleFetch(new Request(renderUrl), h.env, ctx);
    const doc = await rendered.text();
    expect(rendered.headers.get("content-security-policy")).toContain("default-src 'none'");
    // Framed only by the app (never 'none', or the reader could not show it), over HSTS.
    expect(rendered.headers.get("content-security-policy")).toContain(
      `frame-ancestors ${h.env.APP_ORIGIN}`,
    );
    expect(rendered.headers.get("content-security-policy")).not.toContain("frame-ancestors 'none'");
    expect(rendered.headers.get("strict-transport-security")).toBe(
      "max-age=63072000; includeSubDomains",
    );
    expect(doc).not.toContain("<script");
    expect(doc).not.toContain("tracker.example.net");

    vi.setSystemTime(Date.now() + 10 * 60_000);
    const expired = await handleFetch(new Request(renderUrl), h.env, ctx);
    expect(expired.status).toBe(403);
    // Render-origin error pages show inside the app's frame too.
    expect(expired.headers.get("content-security-policy")).toBe(
      `default-src 'none'; frame-ancestors ${h.env.APP_ORIGIN}`,
    );
  });

  it("[X02] Worker-served JSON carries HSTS, nosniff, no-referrer and a no-content, unframeable CSP", async () => {
    const ana = await signup(h, "ana@bye.test");
    for (const r of [
      await handleFetch(
        new Request(`${h.env.APP_ORIGIN}/v1/me`, { headers: { cookie: ana.cookie } }),
        h.env,
        ctx,
      ),
      await handleFetch(new Request(`${h.env.APP_ORIGIN}/v1/nope`), h.env, ctx),
    ]) {
      expect(r.headers.get("content-type")).toContain("application/json");
      expect(r.headers.get("strict-transport-security")).toBe(
        "max-age=63072000; includeSubDomains",
      );
      expect(r.headers.get("x-content-type-options")).toBe("nosniff");
      expect(r.headers.get("referrer-policy")).toBe("no-referrer");
      expect(r.headers.get("content-security-policy")).toBe(
        "default-src 'none'; frame-ancestors 'none'",
      );
    }
  });

  it("[E17] domain rejections map to stable public error codes, not internal errors", async () => {
    const ana = await signup(h, "ana@bye.test");
    const missing = await api(h, ana, "POST", `/v1/mailboxes/${ana.mailboxId}/commands`, {
      _tag: "SaveDraft",
      commandId: cmdId(),
      draftId: "drf_00000000000000000000",
      expectedRevision: 1,
      content: { to: [], cc: [], bcc: [], subject: "", text: "", attachments: [] },
    });
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe("not_found");
    const invalid = await api(h, ana, "POST", `/v1/mailboxes/${ana.mailboxId}/commands`, {
      _tag: "NoSuchCommand",
      commandId: cmdId(),
    });
    expect(invalid.status).toBe(400);
    const badCalendar = await api(h, ana, "POST", `/v1/calendars/${ana.calendarId}/commands`, {
      schemaVersion: 1,
      command: { type: "Nope" },
    });
    expect(badCalendar.status).toBe(400);
  });

  it("[A03] requests without credentials, and cross-origin cookie writes, are refused", async () => {
    const ana = await signup(h, "ana@bye.test");
    expect((await api(h, null, "GET", `/v1/mailboxes/${ana.mailboxId}/views/imbox`)).status).toBe(
      401,
    );
    const csrf = await api(
      h,
      ana,
      "POST",
      `/v1/mailboxes/${ana.mailboxId}/commands`,
      { _tag: "RotateSpeakeasy", commandId: cmdId() },
      { origin: "https://evil.example" },
    );
    expect(csrf.status).toBe(403);
  });

  it("[X02] agent tokens default to read/draft and cannot send or read other mailboxes", async () => {
    const ana = await signup(h, "ana@bye.test");
    const bob = await signup(h, "bob@bye.test");
    const token = await api(h, ana, "POST", "/v1/tokens", { kind: "agent", label: "assistant" });
    expect(token.status).toBe(201);
    expect(token.body.scopes).toEqual(["read", "draft"]);
    const agent = { ...ana, cookie: "" };
    const bearer = { authorization: `Bearer ${token.body.token}` };
    expect(
      (await api(h, agent, "GET", `/v1/mailboxes/${ana.mailboxId}/views/imbox`, undefined, bearer))
        .status,
    ).toBe(200);
    expect(
      (await api(h, agent, "GET", `/v1/mailboxes/${bob.mailboxId}/views/imbox`, undefined, bearer))
        .status,
    ).toBe(403);
    const send = await api(
      h,
      agent,
      "POST",
      `/v1/drafts/drf_x/send`,
      { mailboxId: ana.mailboxId, commandId: cmdId(), revision: 1 },
      bearer,
    );
    expect(send.status).toBe(403);
  });

  it("[C09] invitations delivered by approved senders populate the calendar", async () => {
    const ana = await signup(h, "ana@bye.test");
    await api(h, ana, "POST", `/v1/mailboxes/${ana.mailboxId}/commands`, {
      _tag: "SetPolicy",
      commandId: cmdId(),
      kind: "address",
      subject: "org@example.net",
      policy: {
        decision: "allowed",
        destination: "imbox",
        labels: [],
        bundle: false,
        notify: false,
      },
    });
    const ics = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//test//EN",
      "METHOD:REQUEST",
      "BEGIN:VEVENT",
      "UID:evt-1@example.net",
      "DTSTAMP:20260925T120000Z",
      "DTSTART:20261001T150000Z",
      "DTEND:20261001T160000Z",
      "SUMMARY:Planning",
      "ORGANIZER:mailto:org@example.net",
      "ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:ana@bye.test",
      "SEQUENCE:0",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    const raw = rfc822({
      from: "org@example.net",
      to: "ana@bye.test",
      subject: "Invitation: Planning",
      body: ics,
      messageId: "inv1@example.net",
    }).replace(
      "Content-Type: text/plain; charset=utf-8",
      "Content-Type: text/calendar; charset=utf-8; method=REQUEST",
    );
    await handleInbound(inboundMessage("org@example.net", "ana@bye.test", raw), h.env);
    await h.drain();
    const events = await api(
      h,
      ana,
      "GET",
      `/v1/calendars/${ana.calendarId}/events?from=2026-09-28T00:00:00Z&to=2026-10-05T00:00:00Z`,
    );
    expect(events.status).toBe(200);
    expect(JSON.stringify(events.body)).toContain("Planning");

    // [C04] Accepting produces an iTIP REPLY sent through the mailbox as a calendar part.
    (h.env as { PERSONAL_MAIL_API_KEY: string }).PERSONAL_MAIL_API_KEY = "pm-key";
    await api(h, ana, "POST", `/v1/mailboxes/${ana.mailboxId}/commands`, {
      _tag: "AddIdentity",
      commandId: cmdId(),
      address: "ana@bye.test",
      kind: "hosted",
    });
    const submitted: Array<string> = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init: { body: string }) => {
      submitted.push(init.body);
      return new Response(JSON.stringify({ id: "prov-2" }), { status: 202 });
    }) as typeof fetch;
    try {
      const eventId = (events.body.occurrences as ReadonlyArray<{ eventId: string }>)[0]!.eventId;
      const reply = await api(h, ana, "POST", `/v1/calendars/${ana.calendarId}/commands`, {
        schemaVersion: 1,
        command: { type: "RespondInvitation", commandId: cmdId(), eventId, partstat: "ACCEPTED" },
      });
      expect(reply.status).toBe(200);
      await h.drain();
      vi.setSystemTime(Date.now() + 60_000);
      await h.namespaces.MAILBOXES.instance(ana.mailboxId).alarm();
      await h.drain();
      const jobs = [...h.buckets.ORIGINALS.objects.entries()].filter(([k]) => k.includes("/out/"));
      expect(jobs).toHaveLength(1);
      const mime = new TextDecoder().decode(jobs[0]![1].bytes);
      expect(mime).toMatch(/Content-Type: text\/calendar;[^\r\n]*method=REPLY/i);
      expect(mime).toMatch(/^To: org@example.net/im);
      expect(mime).not.toMatch(/x-bye-itip-method/i);
      expect(submitted).toHaveLength(1);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("[E09] cron reconciliation re-arms lost alarms and republishes stranded ingress receipts", async () => {
    const ana = await signup(h, "ana@bye.test");
    // Simulate a receipt whose queue publish failed after the blob was stored.
    const failingSend = h.env.INGEST.send.bind(h.env.INGEST);
    (h.env.INGEST as { send: unknown }).send = async () => {
      throw new Error("queue down");
    };
    const { outcome } = await deliver(h, "late@example.net", "ana@bye.test", "Stranded", "body");
    expect(outcome).toMatchObject({ _tag: "Accepted", enqueued: false });
    (h.env.INGEST as { send: unknown }).send = failingSend;
    expect(
      (await api(h, ana, "GET", `/v1/mailboxes/${ana.mailboxId}/views/screener`)).body.items,
    ).toHaveLength(0);

    vi.setSystemTime(Date.now() + 15 * 60_000);
    expect(await reconcileIngress(h.env)).toBe(1);
    await h.drain();
    expect(
      (await api(h, ana, "GET", `/v1/mailboxes/${ana.mailboxId}/views/screener`)).body.items,
    ).toHaveLength(1);

    // Every catalog shard is visited over a full rotation, including never-hinted mailboxes.
    const visited = new Set<number>();
    for (let run = 0; run < 16; run++)
      for (const s of shardsForRun(run * 5 * 60_000)) visited.add(s);
    expect(visited.size).toBe(64);
    let reconciled = 0;
    for (let run = 0; run < 16; run++)
      reconciled += (await reconcileCatalog(h.env, run * 5 * 60_000)).mailboxes;
    expect(reconciled).toBe(1);
  });

  it("[A04] account export produces MBOX, vCard, notes/settings and ICS files", async () => {
    const ana = await signup(h, "ana@bye.test");
    await deliver(h, "bob@example.net", "ana@bye.test", "Quarterly numbers", "see attached");
    const started = await api(h, ana, "POST", "/v1/exports", {});
    expect(started.status).toBe(202);
    const instance = h.workflows.EXPORT_ACCOUNT?.[0];
    expect(instance?.params).toMatchObject({
      userId: ana.userId,
      mailboxIds: [ana.mailboxId],
      calendarIds: [ana.calendarId],
    });
    // Run the real workflow; each step's output round-trips through JSON like a checkpoint.
    const steps: Array<string> = [];
    const step = {
      do: async (name: string, ...args: ReadonlyArray<unknown>) => {
        steps.push(name);
        const out = await (args.at(-1) as () => Promise<unknown>)();
        return out === undefined ? undefined : JSON.parse(JSON.stringify(out));
      },
    };
    const result = (await new ExportWorkflow({} as never, h.env).run(
      { payload: instance!.params, instanceId: instance!.id, timestamp: new Date() } as never,
      step as never,
    )) as { files: Array<string> };
    const prefix = `t/${ana.userId}/export/${started.body.exportId}`;
    expect(result.files.sort()).toEqual(
      [
        `${prefix}/${ana.mailboxId}.mbox`,
        `${prefix}/${ana.mailboxId}.vcf`,
        `${prefix}/${ana.calendarId}.ics`,
      ].sort(),
    );
    const text = async (key: string) => (await h.buckets.EXPORTS.get(key))!.text();
    const mbox = await text(`${prefix}/${ana.mailboxId}.mbox`);
    expect(mbox).toMatch(/^From /);
    expect(mbox).toContain("Subject: Quarterly numbers");
    expect(await text(`${prefix}/${ana.calendarId}.ics`)).toContain("BEGIN:VCALENDAR");
    expect(JSON.parse(await text(`${prefix}/${ana.mailboxId}.notes-settings.json`))).toHaveProperty(
      "senderPolicies",
    );
    // Carry objects are cleaned up; the status route lists the files with signed links.
    expect([...h.buckets.EXPORTS.objects.keys()].some((k) => k.includes("/.carry/"))).toBe(false);
    const status = await api(h, ana, "GET", `/v1/exports/${started.body.exportId}`);
    expect(status.status).toBe(200);
    expect(status.body.files.map((f: { name: string }) => f.name)).toEqual(
      expect.arrayContaining([`${ana.mailboxId}.mbox`, `${ana.mailboxId}.vcf`]),
    );
  });
});

describe("MailCore sharing and publishing", () => {
  let h: Harness;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2026, 8, 25, 12));
    h = makeHarness();
  });
  afterEach(() => vi.useRealTimers());

  it("[O05] a public thread link exposes the selected messages but never Bcc or private notes, and revocation ends access", async () => {
    const { PublicGateway } = await import("../src/gateway.ts");
    const ana = await signup(h, "ana@bye.test");
    await api(h, ana, "POST", `/v1/mailboxes/${ana.mailboxId}/commands`, {
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
    await deliver(h, "bob@example.net", "ana@bye.test", "Launch plan", "Public details only", {
      headers: "Bcc: hidden@example.net",
    });
    const thread = (await api(h, ana, "GET", `/v1/mailboxes/${ana.mailboxId}/views/imbox`)).body
      .items[0];
    const detail = await api(
      h,
      ana,
      "GET",
      `/v1/mailboxes/${ana.mailboxId}/threads/${thread.threadId}`,
    );
    await api(h, ana, "POST", `/v1/mailboxes/${ana.mailboxId}/commands`, {
      _tag: "PutNote",
      commandId: cmdId(),
      kind: "thread",
      threadId: thread.threadId,
      body: "PRIVATE NOTE",
    });

    const org = (await api(h, ana, "GET", "/v1/me")).body.organizationIds[0];
    const space = await api(h, ana, "POST", "/v1/spaces", { organizationId: org });
    expect(space.status).toBe(201);
    const shared = await api(h, ana, "POST", "/v1/shared-threads", {
      spaceId: space.body.spaceId,
      mailboxId: ana.mailboxId,
      threadId: thread.threadId,
      messageRefs: detail.body.deliveries.map((d: { deliveryId: string }) => d.deliveryId),
      grantees: [],
      includeFuture: false,
    });
    expect(shared.status).toBe(201);
    const link = await api(h, ana, "POST", "/v1/public-links", {
      spaceId: space.body.spaceId,
      threadId: shared.body,
      includeFuture: false,
    });
    expect(link.status).toBe(201);
    const [spaceId, token] = new URL(link.body.url).pathname.split("/").slice(2);

    const gateway = new PublicGateway({} as never, h.env);
    const view = await gateway.resolveShareLink(spaceId!, token!);
    const text = JSON.stringify(view);
    expect(view?.subject).toBe("Launch plan");
    expect(text).toContain("Public details only");
    expect(text).not.toContain("hidden@example.net");
    expect(text).not.toContain("PRIVATE NOTE");

    // Another organization's member cannot create links in this space.
    const eve = await signup(h, "eve@bye.test");
    expect(
      (
        await api(h, eve, "POST", "/v1/public-links", {
          spaceId: space.body.spaceId,
          threadId: shared.body,
          includeFuture: false,
        })
      ).status,
    ).toBe(403);
  });

  it("[P01] published posts route remote images through the signed image proxy", async () => {
    const ana = await signup(h, "ana@bye.test");
    const post = await api(h, ana, "POST", "/v1/world/posts", {
      from: "ana@bye.test",
      title: "Pics",
      html: '<p>x</p><img src="https://cdn.example/a.png"><img src="http://plain.example/b.png">',
      text: "x",
    });
    expect(post.status).toBe(201);
    const page = [...h.buckets.PUBLISHED.objects.entries()].find(([k]) =>
      k.startsWith("site/ana/posts/"),
    );
    const html = new TextDecoder().decode(page![1].bytes);
    expect(html).toContain(`src="${h.env.MAIL_ORIGIN}/img?u=`);
    expect(html).not.toContain('src="https://cdn.example');
    expect(html).not.toContain("plain.example");
  });

  it("[P02] the public gateway never creates World state for a handle without a public site", async () => {
    const { PublicGateway } = await import("../src/gateway.ts");
    const gateway = new PublicGateway({} as never, h.env);
    const before = h.namespaces.SHARED_SPACES.instances.size;
    expect(await gateway.subscribe("nobody-here", "victim@example.net")).toEqual({ ok: false });
    expect(await gateway.confirmSubscription("nobody-here", "x".repeat(20))).toEqual({ ok: false });
    expect(h.namespaces.SHARED_SPACES.instances.size).toBe(before);
    expect(h.sent).toHaveLength(0);
  });

  it("[P01] publishing writes sanitized public copies; another author cannot take over the handle", async () => {
    const ana = await signup(h, "ana@bye.test");
    const post = await api(h, ana, "POST", "/v1/world/posts", {
      from: "ana@bye.test",
      title: "Hello world",
      html: "<p>First post</p><script>steal()</script>",
      text: "First post",
    });
    expect(post.status).toBe(201);
    const page = [...h.buckets.PUBLISHED.objects.entries()].find(([k]) =>
      k.startsWith("site/ana/posts/"),
    );
    expect(page).toBeDefined();
    const html = new TextDecoder().decode(page![1].bytes);
    expect(html).toContain("First post");
    expect(html).not.toContain("<script");
    expect(h.buckets.PUBLISHED.objects.has("site/ana/feed.xml")).toBe(true);

    // A forged From that isn't the author's identity never publishes.
    const forged = await api(h, ana, "POST", "/v1/world/posts", {
      from: "ceo@bye.test",
      title: "Forged",
      html: "<p>x</p>",
      text: "x",
    });
    expect(forged.status).toBe(403);

    // Same local part on another domain gets a distinct handle rather than the existing one.
    const other = await signup(h, "ana@other.test");
    const theirs = await api(h, other, "POST", "/v1/world/posts", {
      from: "ana@other.test",
      title: "Mine",
      html: "<p>mine</p>",
      text: "mine",
    });
    expect(theirs.status).toBe(201);
    expect(h.buckets.PUBLISHED.objects.has("site/ana--other-test/feed.xml")).toBe(true);
    const anaIndex = new TextDecoder().decode(
      h.buckets.PUBLISHED.objects.get("site/ana/index.html")!.bytes,
    );
    expect(anaIndex).not.toContain("Mine");

    // A service-domain signup can't squat a custom-domain user's handle: `--` never occurs in one.
    const squatter = await signup(h, "carl-acme-test@bye.test");
    expect(
      (
        await api(h, squatter, "POST", "/v1/world/posts", {
          from: "carl-acme-test@bye.test",
          title: "Squat",
          html: "<p>s</p>",
          text: "s",
        })
      ).status,
    ).toBe(201);
    const carl = await signup(h, "carl@acme.test");
    expect(
      (
        await api(h, carl, "POST", "/v1/world/posts", {
          from: "carl@acme.test",
          title: "Real",
          html: "<p>r</p>",
          text: "r",
        })
      ).status,
    ).toBe(201);
    expect(h.buckets.PUBLISHED.objects.has("site/carl--acme-test/feed.xml")).toBe(true);

    // Addresses that sanitize alike get a deterministic fallback handle instead of failing.
    const dotted = await signup(h, "ana.b@bye.test");
    expect(
      (
        await api(h, dotted, "POST", "/v1/world/posts", {
          from: "ana.b@bye.test",
          title: "Dot",
          html: "<p>d</p>",
          text: "d",
        })
      ).status,
    ).toBe(201);
    const dashed = await signup(h, "ana-b@bye.test");
    expect(
      (
        await api(h, dashed, "POST", "/v1/world/posts", {
          from: "ana-b@bye.test",
          title: "Dash",
          html: "<p>d</p>",
          text: "d",
        })
      ).status,
    ).toBe(201);
    expect(
      [...h.buckets.PUBLISHED.objects.keys()].some((k) =>
        /^site\/ana-b--h[0-9a-f]{8}\/feed\.xml$/.test(k),
      ),
    ).toBe(true);
  });
});

describe("MailCore review regressions", () => {
  let h: Harness;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2026, 8, 25, 12));
    h = makeHarness();
  });
  afterEach(() => vi.useRealTimers());

  const withFetch = async <A>(
    impl: (url: string, init?: RequestInit) => Response,
    fn: () => Promise<A>,
  ): Promise<A> => {
    const real = globalThis.fetch;
    globalThis.fetch = (async (url: string, init?: RequestInit) =>
      impl(String(url), init)) as typeof fetch;
    try {
      return await fn();
    } finally {
      globalThis.fetch = real;
    }
  };
  const turnstileOk = (url: string) =>
    url.includes("turnstile")
      ? new Response(JSON.stringify({ success: true }))
      : new Response("{}", { status: 404 });

  it("[A03] personal signup only allocates service-domain addresses; a failed passkey ceremony can be retried", async () => {
    await withFetch(turnstileOk, async () => {
      const foreign = await api(h, null, "POST", "/auth/signup", {
        address: "ceo@acme.com",
        displayName: "x",
        turnstile: "t",
      });
      expect(foreign.status).toBe(400);
      const ok = await api(h, null, "POST", "/auth/signup", {
        address: "new@bye.test",
        displayName: "New",
        turnstile: "t",
      });
      expect(ok.status).toBe(201);
      const retry = await api(h, null, "POST", "/auth/signup/challenge", {
        userId: ok.body.userId,
        signupToken: ok.body.signupToken,
      });
      expect(retry.status).toBe(200);
      expect(retry.body.challenge).toBeTruthy();
      const forged = await api(h, null, "POST", "/auth/signup/challenge", {
        userId: ok.body.userId,
        signupToken: `${Date.now() + 60_000}.00`,
      });
      expect(forged.status).toBe(401);
    });
  });

  it("[O01] addresses on a customer domain cannot be claimed through personal provisioning", async () => {
    await h.d1
      .prepare(
        "INSERT INTO organizations (id, name, kind, seat_limit, created_at) VALUES ('org_acme', 'Acme', 'domain', 10, 0)",
      )
      .run();
    await h.d1
      .prepare(
        "INSERT INTO domains (id, org_id, name, state, verification_token, created_at, updated_at) VALUES ('dom_1', 'org_acme', 'acme.com', 'active', 't', 0, 0)",
      )
      .run();
    const directory = new ControlDirectory(h.env.DIRECTORY, kernelClock);
    await expect(
      directory.provisionPersonalAccount({ address: "ceo@acme.com", displayName: "x" }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("[E19] redelivery requires authority over the target mailbox", async () => {
    const ana = await signup(h, "ana@bye.test");
    const bob = await signup(h, "bob@bye.test");
    const r = await api(h, ana, "POST", `/v1/mailboxes/${ana.mailboxId}/commands`, {
      _tag: "Redeliver",
      commandId: cmdId(),
      deliveryId: "dlv_00000000000000000000",
      targetMailboxId: bob.mailboxId,
      mode: "copy",
    });
    expect(r.status).toBe(403);
  });

  it("[A03] new identities, forwarding changes and domain claims require a recent step-up", async () => {
    const ana = await signup(h, "ana@bye.test");
    const auth = new ControlAuth(h.env.DIRECTORY, kernelClock, await authConfig(h.env));
    const plain = {
      ...ana,
      cookie: `__Host-session=${(await auth.issueSession(ana.userId, "test", false)).token}`,
    };
    const identity = await api(h, plain, "POST", `/v1/mailboxes/${ana.mailboxId}/commands`, {
      _tag: "AddIdentity",
      commandId: cmdId(),
      address: "ana@bye.test",
      kind: "hosted",
    });
    expect(identity.status).toBe(403);
    const forward = await api(h, plain, "POST", `/v1/mailboxes/${ana.mailboxId}/commands`, {
      _tag: "AddForwardingDestination",
      commandId: cmdId(),
      address: "me@example.net",
    });
    expect(forward.status).toBe(403);
    const org = (await api(h, plain, "GET", "/v1/me")).body.organizationIds[0];
    expect(
      (await api(h, plain, "POST", "/v1/domains", { orgId: org, name: "bigcorp.com" })).status,
    ).toBe(403);
    // The step-up endpoint exists and requires a valid factor.
    expect((await api(h, plain, "POST", "/auth/step-up/totp", { code: "000000" })).status).toBe(
      401,
    );
  });

  it("[E18] a directory outage at dispatch leaves the job ready for retry instead of stranding it", async () => {
    const ana = await signup(h, "ana@bye.test");
    (h.env as { PERSONAL_MAIL_API_KEY: string }).PERSONAL_MAIL_API_KEY = "pm-key";
    await api(h, ana, "POST", `/v1/mailboxes/${ana.mailboxId}/commands`, {
      _tag: "AddIdentity",
      commandId: cmdId(),
      address: "ana@bye.test",
      kind: "hosted",
    });
    const draft = await api(h, ana, "POST", "/v1/drafts", {
      mailboxId: ana.mailboxId,
      commandId: cmdId(),
      content: {
        to: [{ address: "bob@example.net" }],
        cc: [],
        bcc: [],
        subject: "x",
        text: "y",
        attachments: [],
      },
    });
    const send = await api(h, ana, "POST", `/v1/drafts/${draft.body.draftId}/send`, {
      mailboxId: ana.mailboxId,
      commandId: cmdId(),
      revision: draft.body.revision,
    });
    vi.setSystemTime(Date.now() + 60_000);
    await h.namespaces.MAILBOXES.instance(ana.mailboxId).alarm();
    h.d1.failing = true;
    await expect(h.drain()).rejects.toThrow(/dispatch/);
    h.d1.failing = false;
    const job = await h.namespaces.MAILBOXES.instance(ana.mailboxId).sendJob(
      send.body.sendJobIds[0],
    );
    expect(job?.state).toBe("ready");
  });

  it("[P02] subscribing sends a double opt-in confirmation with a working link", async () => {
    const { PublicGateway } = await import("../src/gateway.ts");
    const ana = await signup(h, "ana@bye.test");
    await api(h, ana, "POST", "/v1/world/posts", {
      from: "ana@bye.test",
      title: "Hi",
      html: "<p>hi</p>",
      text: "hi",
    });
    const gateway = new PublicGateway({} as never, h.env);
    expect((await gateway.subscribe("ana", "reader@example.net")).ok).toBe(true);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.to).toBe("reader@example.net");
    const token = /confirm\/([A-Za-z0-9_-]+)/.exec(h.sent[0]!.raw)?.[1];
    expect(token).toBeTruthy();
    expect((await gateway.confirmSubscription("ana", token!)).ok).toBe(true);
  });

  it("[E24] erased originals stop ingress replay instead of retrying forever", async () => {
    await signup(h, "ana@bye.test");
    const message = inboundMessage(
      "x@example.net",
      "ana@bye.test",
      rfc822({
        from: "x@example.net",
        to: "ana@bye.test",
        subject: "gone",
        body: "b",
        messageId: "gone@x",
      }),
    );
    await handleInbound(message, h.env);
    h.buckets.ORIGINALS.objects.clear();
    await h.drain();
    vi.setSystemTime(Date.now() + 15 * 60_000);
    expect(await reconcileIngress(h.env)).toBe(0);
  });

  it("[E24] an exhausted receipt whose quarantine fails is parked, never rejected or pruned", async () => {
    const ana = await signup(h, "ana@bye.test");
    const id = "ing_quarantine_fail";
    const journal = h.env.INGRESS_JOURNALS.getByName(journalPartition(id));
    await journal.register({
      ingestionId: id,
      mailboxId: ana.mailboxId,
      recipient: "ana@bye.test",
      envelopeFrom: "x@example.net",
      objectKey: "originals/missing",
      rawSize: 10,
    });
    await journal.markBlobReady(id);
    for (let i = 0; i < REPLAY_ATTEMPT_CAP; i++) await journal.touchRepublished(id);
    const mailboxes = h.env.MAILBOXES as { getByName: unknown };
    const realGetByName = mailboxes.getByName;
    mailboxes.getByName = () => ({
      commitDelivery: async () => {
        throw new Error("mailbox unavailable");
      },
    });
    vi.setSystemTime(Date.now() + 15 * 60_000);
    await reconcileIngress(h.env);
    expect((await journal.get(id))?.state).toBe("quarantine-failed");
    // Never pruned, however old.
    expect(await journal.pruneCommitted(0)).toBe(0);
    expect(await journal.get(id)).not.toBeNull();
    // Retried after the back-off; a successful quarantine commits it.
    mailboxes.getByName = realGetByName;
    vi.setSystemTime(Date.now() + 7 * 60 * 60_000);
    await reconcileIngress(h.env);
    expect((await journal.get(id))?.state).toBe("committed");
  });

  it("[X02] malformed percent-encoding in paths is a client error, not a server error", async () => {
    const ana = await signup(h, "ana@bye.test");
    expect((await api(h, ana, "GET", `/v1/mailboxes/%E0%A4%A/views/imbox`)).status).toBe(400);
  });
});

describe("inbound whole-message scanning", () => {
  let h: Harness;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2026, 8, 25, 12));
    h = makeHarness();
  });
  afterEach(() => vi.useRealTimers());

  const EICAR = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";

  const withAttachment = (
    from: string,
    to: string,
    subject: string,
    content: string,
    filename = "notes.txt",
  ) =>
    [
      "Authentication-Results: mx.cloudflare.net; spf=pass; dkim=pass; dmarc=pass",
      `From: ${from}`,
      `To: ${to}`,
      `Subject: ${subject}`,
      "Date: Fri, 25 Sep 2026 12:00:00 +0000",
      `Message-ID: <${subject.replace(/\W/g, "")}@example.net>`,
      "MIME-Version: 1.0",
      'Content-Type: multipart/mixed; boundary="b1"',
      "",
      "--b1",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "See attached.",
      "--b1",
      `Content-Type: text/plain; name="${filename}"`,
      `Content-Disposition: attachment; filename="${filename}"`,
      "",
      content,
      "--b1--",
      "",
    ].join("\r\n");

  const setup = async () => {
    const ana = await signup(h, "ana@bye.test");
    await api(h, ana, "POST", `/v1/mailboxes/${ana.mailboxId}/commands`, {
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
    return ana;
  };

  const receive = async (
    ana: Account,
    subject: string,
    content: string,
    options: { tolerate?: boolean; maxRetries?: number } = {},
  ) => {
    await handleInbound(
      inboundMessage(
        "bob@example.net",
        "ana@bye.test",
        withAttachment("bob@example.net", "ana@bye.test", subject, content),
      ),
      h.env,
    );
    await h.drain(20, {
      tolerateRetries: options.tolerate === true,
      ...(options.maxRetries === undefined ? {} : { maxRetries: options.maxRetries }),
    });
    const views = [
      ...(await api(h, ana, "GET", `/v1/mailboxes/${ana.mailboxId}/views/everything`)).body.items,
      ...(await api(h, ana, "GET", `/v1/mailboxes/${ana.mailboxId}/views/spam`)).body.items,
    ];
    const thread = views.find((t: { subject: string }) => t.subject === subject);
    const detail = await api(
      h,
      ana,
      "GET",
      `/v1/mailboxes/${ana.mailboxId}/threads/${thread.threadId}`,
    );
    const delivery = detail.body.deliveries[0];
    const download = () =>
      api(
        h,
        ana,
        "GET",
        `/v1/mailboxes/${ana.mailboxId}/deliveries/${delivery.deliveryId}/attachments/${delivery.attachments[0].partId}`,
      );
    return { thread, delivery, download };
  };

  it("[E20] the whole original is scanned once after delivery; clean attachments become downloadable", async () => {
    const ana = await setup();
    const { delivery } = await receive(ana, "Clean report", "quarterly numbers");
    expect(h.scanner.scanned).toHaveLength(1);
    expect(h.scanner.scanned[0]).toContain("Subject: Clean report");
    expect(delivery.scan.status).toBe("clean");
    const file = await handleFetch(
      new Request(
        `${h.env.APP_ORIGIN}/v1/mailboxes/${ana.mailboxId}/deliveries/${delivery.deliveryId}/attachments/${delivery.attachments[0].partId}`,
        { headers: { cookie: ana.cookie } },
      ),
      h.env,
      ctx,
    );
    expect(file.status).toBe(200);
    expect(file.headers.get("content-disposition")).toContain("attachment;");
    expect(file.headers.get("content-security-policy")).toContain("sandbox");
    expect(await file.text()).toContain("quarterly numbers");
  });

  it("[E24] infected mail is quarantined to Spam; attachments stay blocked even after restore", async () => {
    const ana = await setup();
    const { thread, delivery, download } = await receive(ana, "Invoice", EICAR);
    expect(delivery.scan.status).toBe("infected");
    const spam = await api(h, ana, "GET", `/v1/mailboxes/${ana.mailboxId}/views/spam`);
    expect(
      spam.body.items.map((t: { threadId: string; quarantined: boolean }) => [
        t.threadId,
        t.quarantined,
      ]),
    ).toEqual([[thread.threadId, true]]);
    expect((await download()).status).toBe(403);
    // False-positive recovery restores the thread but never unblocks an infected attachment.
    await api(h, ana, "POST", `/v1/mailboxes/${ana.mailboxId}/commands`, {
      _tag: "Restore",
      commandId: cmdId(),
      threadIds: [thread.threadId],
    });
    const blocked = await download();
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.details.scanStatus).toBe("infected");
    // Redelivering it to another mailbox is refused too.
    const redeliver = await api(h, ana, "POST", `/v1/mailboxes/${ana.mailboxId}/commands`, {
      _tag: "Redeliver",
      commandId: cmdId(),
      deliveryId: delivery.deliveryId,
      targetMailboxId: ana.mailboxId,
      mode: "copy",
    });
    expect(redeliver.status).toBe(403);
  });

  it("[E20] during a scanner outage mail still arrives, attachments wait, and reconciliation re-scans later", async () => {
    const ana = await setup();
    h.scanner.mode = "down";
    // The outage outlasts the queue's retries: the scan message is dead-lettered while pending.
    const { delivery, download } = await receive(ana, "Contract", "terms", {
      tolerate: true,
      maxRetries: 0,
    });
    expect(JSON.stringify(h.deadLettered)).toContain("scan-message");
    expect(delivery.scan.status).toBe("pending");
    const waiting = await download();
    expect(waiting.status).toBe(409);
    expect(waiting.body.error.details.scanStatus).toBe("pending");

    h.scanner.mode = "clean";
    vi.setSystemTime(Date.now() + 20 * 60_000);
    await h.namespaces.MAILBOXES.instance(ana.mailboxId).reconcile(Date.now());
    await h.drain();
    expect((await download()).status).toBe(200);
  });

  it("[E20] messages without attachments are not sent to the scanner", async () => {
    const ana = await setup();
    await deliver(h, "bob@example.net", "ana@bye.test", "Just text", "no files here");
    const thread = (await api(h, ana, "GET", `/v1/mailboxes/${ana.mailboxId}/views/imbox`)).body
      .items[0];
    const detail = await api(
      h,
      ana,
      "GET",
      `/v1/mailboxes/${ana.mailboxId}/threads/${thread.threadId}`,
    );
    expect(detail.body.deliveries[0].scan.status).toBe("not-required");
    expect(h.scanner.scanned).toHaveLength(0);
  });
});

describe("desktop sign-in: browser passkey + authorization code with PKCE", () => {
  let h: Harness;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2026, 8, 25, 12));
    h = makeHarness();
  });
  afterEach(() => vi.useRealTimers());

  const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"; // RFC 7636 Appendix B
  const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
  const STATE = "st_0123456789abcdef";

  const authorizeQuery = (overrides: Record<string, string> = {}) =>
    new URLSearchParams({
      response_type: "code",
      client_id: "bye-desktop",
      redirect_uri: "bye://oauth/callback",
      code_challenge: CHALLENGE,
      code_challenge_method: "S256",
      state: STATE,
      device_name: "Work Mac",
      ...overrides,
    });

  const raw = (path: string, init: RequestInit = {}) =>
    handleFetch(new Request(`${h.env.APP_ORIGIN}${path}`, init), h.env, ctx);

  const approve = async (ana: Account, query = authorizeQuery(), origin = h.env.APP_ORIGIN) =>
    raw("/oauth/authorize", {
      method: "POST",
      redirect: "manual",
      headers: { cookie: ana.cookie, origin, "content-type": "application/x-www-form-urlencoded" },
      body: `${query.toString()}&decision=allow`,
    });

  const token = async (fields: Record<string, string>) => {
    const r = await raw("/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields).toString(),
    });
    return { status: r.status, body: (await r.json()) as Record<string, string> };
  };

  const codeFrom = (response: Response) => {
    const location = new URL(response.headers.get("location")!);
    return {
      location,
      code: location.searchParams.get("code")!,
      state: location.searchParams.get("state"),
    };
  };

  it("[A03] PKCE uses S256 exactly as RFC 7636 Appendix B", async () => {
    expect(await pkceChallenge(VERIFIER)).toBe(CHALLENGE);
  });

  it("[X01] publishes a compatibility document and issuer metadata the shared client validates", async () => {
    const probeFetch: ProbeFetch = async (url, init) => {
      expect(init.credentials).toBe("omit");
      const r = await handleFetch(new Request(url, { headers: init.headers }), h.env, ctx);
      return { status: r.status, headers: r.headers, text: () => r.text() };
    };
    for (const [clientId, redirectUri] of [
      ["bye-desktop", "bye://oauth/callback"],
      ["bye-mobile", "bye://oauth/callback"],
      ["bye-desktop", "http://127.0.0.1:49152/oauth/callback"],
      ["bye-cli", null],
    ] as const) {
      const r = await probeInstance(h.env.APP_ORIGIN, {
        fetch: probeFetch,
        clientId,
        redirectUri,
        privateNetwork: "allow",
      });
      expect(r._tag, clientId).toBe("Valid");
      if (r._tag !== "Valid") continue;
      expect(r.instance.issuer).toBe(h.env.APP_ORIGIN);
      expect(r.instance.endpoints.token).toBe(`${h.env.APP_ORIGIN}/oauth/token`);
      expect(r.instance.routes.accountDeletion).toBe(`${h.env.APP_ORIGIN}/v1/account/close`);
    }
    const meta = await raw("/.well-known/oauth-authorization-server");
    expect(meta.headers.get("cache-control")).toContain("public");
    const body = (await meta.json()) as Record<string, unknown>;
    expect(body.code_challenge_methods_supported).toEqual(["S256"]);
    expect(body.token_endpoint_auth_methods_supported).toEqual(["none"]);
  });

  it("[X01] a `decision` smuggled into the authorize link can't override the user's Cancel", async () => {
    const ana = await signup(h, "ana@bye.test");
    const page = await raw(`/oauth/authorize?${authorizeQuery({ decision: "allow" }).toString()}`, {
      headers: { cookie: ana.cookie },
    });
    const html = await page.text();
    expect(html).not.toContain('name="decision" value="allow" type="hidden"');
    expect(html).not.toMatch(/type="hidden" name="decision"/);
    // Even if a form carried an earlier `decision=allow`, the clicked button (last) wins.
    const cancelled = await raw("/oauth/authorize", {
      method: "POST",
      redirect: "manual",
      headers: {
        cookie: ana.cookie,
        origin: h.env.APP_ORIGIN,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: `decision=allow&${authorizeQuery().toString()}&decision=deny`,
    });
    const location = new URL(cancelled.headers.get("location")!);
    expect(location.searchParams.get("error")).toBe("access_denied");
    expect(location.searchParams.has("code")).toBe(false);
  });

  it("[X01] signed-out browsers go to passkey sign-in first; bad clients/redirects are shown, never redirected", async () => {
    const signedOut = await raw(`/oauth/authorize?${authorizeQuery().toString()}`);
    expect(signedOut.status).toBe(303);
    expect(signedOut.headers.get("location")).toBe(
      `/?next=${encodeURIComponent(`/oauth/authorize?${authorizeQuery().toString()}`)}`,
    );
    const bads: Array<Record<string, string>> = [
      { redirect_uri: "https://evil.example/cb" },
      { redirect_uri: "http://localhost:5000/oauth/callback" },
      { client_id: "other" },
      { code_challenge_method: "plain" },
    ];
    for (const bad of bads) {
      const r = await raw(`/oauth/authorize?${authorizeQuery(bad).toString()}`);
      expect(r.status).toBe(400);
      expect(r.headers.get("location")).toBeNull();
    }
  });

  it("[X01] the consent page is unframeable, approval returns a code to the registered callback, and cross-origin approval is refused", async () => {
    const ana = await signup(h, "ana@bye.test");
    const page = await raw(`/oauth/authorize?${authorizeQuery().toString()}`, {
      headers: { cookie: ana.cookie },
    });
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    // The only inline content (the stylesheet) is allowed by hash, never 'unsafe-inline'.
    const csp = page.headers.get("content-security-policy")!;
    expect(csp).not.toContain("unsafe-inline");
    const digest = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(CONSENT_STYLE)),
    );
    expect(csp).toContain(`'sha256-${btoa(String.fromCharCode(...digest))}'`);
    expect(page.headers.get("strict-transport-security")).toBe(
      "max-age=63072000; includeSubDomains",
    );
    // The handler's own referrer policy (the consent POST needs a real Origin) is kept.
    expect(page.headers.get("referrer-policy")).toBe("same-origin");
    expect(await page.text()).toContain("Work Mac");

    const approved = codeFrom(await approve(ana));
    expect(approved.location.protocol).toBe("bye:");
    expect(approved.state).toBe(STATE);
    // RFC 9207: the response names its issuer so multi-instance clients can't be mixed up.
    expect(approved.location.searchParams.get("iss")).toBe(h.env.APP_ORIGIN);
    expect(approved.code).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    // No tokens ever travel in the callback URL.
    expect(approved.location.searchParams.has("access_token")).toBe(false);

    const forged = await approve(ana, authorizeQuery(), "https://evil.example");
    expect(forged.status).toBe(401);

    // The consent page must let its own form post carry a real Origin (not `no-referrer`), and a
    // browser that still sends the opaque `Origin: null` is judged by Fetch Metadata instead.
    expect(page.headers.get("referrer-policy")).toBe("same-origin");
    const opaque = await raw("/oauth/authorize", {
      method: "POST",
      redirect: "manual",
      headers: {
        cookie: ana.cookie,
        origin: "null",
        "sec-fetch-site": "same-origin",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: `${authorizeQuery().toString()}&decision=allow`,
    });
    expect(codeFrom(opaque).code).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    const opaqueCrossSite = await raw("/oauth/authorize", {
      method: "POST",
      redirect: "manual",
      headers: {
        cookie: ana.cookie,
        origin: "null",
        "sec-fetch-site": "cross-site",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: `${authorizeQuery().toString()}&decision=allow`,
    });
    expect(opaqueCrossSite.status).toBe(401);

    // Loopback redirects are accepted on any port (RFC 8252 §7.3).
    const loop = codeFrom(
      await approve(ana, authorizeQuery({ redirect_uri: "http://127.0.0.1:53123/oauth/callback" })),
    );
    expect(loop.location.host).toBe("127.0.0.1:53123");
  });

  it("[A03] a code is single-use, PKCE- and redirect-bound; replay revokes the session it issued", async () => {
    const ana = await signup(h, "ana@bye.test");
    const { code } = codeFrom(await approve(ana));
    const exchange = {
      grant_type: "authorization_code",
      code,
      client_id: "bye-desktop",
      redirect_uri: "bye://oauth/callback",
    };
    expect((await token({ ...exchange, code_verifier: "x".repeat(43) })).body.error).toBe(
      "invalid_grant",
    );
    // The failed attempt consumed the code: a correct verifier afterwards is still refused.
    expect((await token({ ...exchange, code_verifier: VERIFIER })).body.error).toBe(
      "invalid_grant",
    );

    const second = codeFrom(await approve(ana)).code;
    const ok = await token({ ...exchange, code: second, code_verifier: VERIFIER });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ token_type: "Bearer", expires_in: 900 });
    const me = await api(h, { ...ana, cookie: "" }, "GET", "/v1/me", undefined, {
      authorization: `Bearer ${ok.body.access_token}`,
    });
    expect(me.status).toBe(200);
    expect(me.body.userId).toBe(ana.userId);

    const replay = await token({ ...exchange, code: second, code_verifier: VERIFIER });
    expect(replay.body.error).toBe("invalid_grant");
    expect(
      (
        await api(h, { ...ana, cookie: "" }, "GET", "/v1/me", undefined, {
          authorization: `Bearer ${ok.body.access_token}`,
        })
      ).status,
    ).toBe(401);

    const expiredCode = codeFrom(await approve(ana)).code;
    vi.setSystemTime(Date.now() + 3 * 60_000);
    expect(
      (await token({ ...exchange, code: expiredCode, code_verifier: VERIFIER })).body.error,
    ).toBe("invalid_grant");
  });

  it("[A03] refresh rotates; replaying a rotated refresh credential revokes the device session (RFC 9700)", async () => {
    const ana = await signup(h, "ana@bye.test");
    const { code } = codeFrom(await approve(ana));
    const first = (
      await token({
        grant_type: "authorization_code",
        code,
        client_id: "bye-desktop",
        redirect_uri: "bye://oauth/callback",
        code_verifier: VERIFIER,
      })
    ).body;

    vi.setSystemTime(Date.now() + 20 * 60_000); // access token expired
    const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
    expect(
      (
        await api(
          h,
          { ...ana, cookie: "" },
          "GET",
          "/v1/me",
          undefined,
          bearer(first.access_token!),
        )
      ).status,
    ).toBe(401);
    const second = await token({
      grant_type: "refresh_token",
      refresh_token: first.refresh_token!,
      client_id: "bye-desktop",
    });
    expect(second.status).toBe(200);
    expect(second.body.refresh_token).not.toBe(first.refresh_token);
    expect(
      (
        await api(
          h,
          { ...ana, cookie: "" },
          "GET",
          "/v1/me",
          undefined,
          bearer(second.body.access_token!),
        )
      ).status,
    ).toBe(200);

    const reuse = await token({
      grant_type: "refresh_token",
      refresh_token: first.refresh_token!,
      client_id: "bye-desktop",
    });
    expect(reuse.body.error).toBe("invalid_grant");
    expect(
      (
        await api(
          h,
          { ...ana, cookie: "" },
          "GET",
          "/v1/me",
          undefined,
          bearer(second.body.access_token!),
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await token({
          grant_type: "refresh_token",
          refresh_token: second.body.refresh_token!,
          client_id: "bye-desktop",
        })
      ).body.error,
    ).toBe("invalid_grant");
  });

  it("[X01] device sessions are listed and revocable from the web; logout revokes; consequential actions still need step-up", async () => {
    const ana = await signup(h, "ana@bye.test");
    const { code } = codeFrom(await approve(ana));
    const tokens = (
      await token({
        grant_type: "authorization_code",
        code,
        client_id: "bye-desktop",
        redirect_uri: "bye://oauth/callback",
        code_verifier: VERIFIER,
      })
    ).body;
    const device = { ...ana, cookie: "" };
    const bearer = { authorization: `Bearer ${tokens.access_token}` };

    const identity = await api(
      h,
      device,
      "POST",
      `/v1/mailboxes/${ana.mailboxId}/commands`,
      { _tag: "AddIdentity", commandId: cmdId(), address: "ana@bye.test", kind: "hosted" },
      bearer,
    );
    expect(identity.status).toBe(403);

    const listed = await api(h, ana, "GET", "/v1/devices");
    expect(listed.body.items).toHaveLength(1);
    expect(listed.body.items[0].deviceName).toBe("Work Mac");
    expect((await api(h, ana, "DELETE", `/v1/devices/${listed.body.items[0].id}`)).status).toBe(
      200,
    );
    expect((await api(h, device, "GET", "/v1/me", undefined, bearer)).status).toBe(401);

    const again = codeFrom(await approve(ana)).code;
    const t2 = (
      await token({
        grant_type: "authorization_code",
        code: again,
        client_id: "bye-desktop",
        redirect_uri: "bye://oauth/callback",
        code_verifier: VERIFIER,
      })
    ).body;
    const revoked = await raw("/oauth/revoke", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `token=${t2.refresh_token}`,
    });
    expect(revoked.status).toBe(200);
    expect(
      (
        await token({
          grant_type: "refresh_token",
          refresh_token: t2.refresh_token!,
          client_id: "bye-desktop",
        })
      ).body.error,
    ).toBe("invalid_grant");
  });
});

describe("[DS10] device-authorization grant routes", () => {
  // Device-authorization grant over HTTP (DS10, RFC 8628): a headless client starts the flow, the
  // user approves the code in a signed-in browser, and the client's poll yields a device session.

  const ctx = {
    waitUntil: () => undefined,
    passThroughOnException: () => undefined,
  } as unknown as ExecutionContext;
  const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

  let h: Harness;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2026, 8, 26, 12));
    h = makeHarness();
  });
  afterEach(() => vi.useRealTimers());

  const raw = (path: string, init: RequestInit = {}) =>
    handleFetch(new Request(`${h.env.APP_ORIGIN}${path}`, init), h.env, ctx);
  const form = (fields: Record<string, string>, headers: Record<string, string> = {}) => ({
    method: "POST",
    redirect: "manual" as const,
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(fields).toString(),
  });

  it("start → approve in the browser → poll yields working device credentials", async () => {
    const account = await new ControlDirectory(
      h.env.DIRECTORY,
      kernelClock,
    ).provisionPersonalAccount({ address: "ana@bye.test", displayName: "Ana" });
    const { token } = await new ControlAuth(
      h.env.DIRECTORY,
      kernelClock,
      await authConfig(h.env),
    ).issueSession(account.userId, "laptop", true);
    const cookie = `__Host-session=${token}`;

    const started = await raw(
      "/oauth/device_authorization",
      form({ client_id: "bye-cli", device_name: "build box" }),
    );
    expect(started.status).toBe(200);
    const auth = (await started.json()) as {
      device_code: string;
      user_code: string;
      verification_uri: string;
      verification_uri_complete: string;
      interval: number;
    };
    expect(auth.verification_uri).toBe(`${h.env.APP_ORIGIN}/device`);
    expect(auth.verification_uri_complete).toContain(encodeURIComponent(auth.user_code));

    const poll = () =>
      raw(
        "/oauth/token",
        form({ grant_type: DEVICE_GRANT, device_code: auth.device_code, client_id: "bye-cli" }),
      );
    const pending = await poll();
    expect(pending.status).toBe(400);
    expect(await pending.json()).toMatchObject({ error: "authorization_pending" });

    // Signed out: the verification page sends the browser to sign in first.
    const signedOut = await raw(`/device?user_code=${encodeURIComponent(auth.user_code)}`, {
      redirect: "manual",
    });
    expect(signedOut.status).toBe(303);

    const page = await raw(`/device?user_code=${encodeURIComponent(auth.user_code)}`, {
      headers: { cookie },
    });
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(await page.text()).toContain("build box");

    // Cross-site approval is refused by the CSRF check.
    const forged = await raw(
      "/device",
      form(
        { user_code: auth.user_code, decision: "allow" },
        { cookie, origin: "https://evil.example" },
      ),
    );
    expect(forged.status).toBe(401);

    const approved = await raw(
      "/device",
      form({ user_code: auth.user_code, decision: "allow" }, { cookie, origin: h.env.APP_ORIGIN }),
    );
    expect(approved.status).toBe(200);

    vi.setSystemTime(Date.now() + auth.interval * 1000 + 1);
    const granted = await poll();
    expect(granted.status).toBe(200);
    const tokens = (await granted.json()) as { access_token: string; refresh_token: string };
    const me = await raw("/v1/me", { headers: { authorization: `Bearer ${tokens.access_token}` } });
    expect(me.status).toBe(200);
    expect(((await me.json()) as { userId: string }).userId).toBe(account.userId);

    // The same device code can't be redeemed twice.
    expect(await (await poll()).json()).toMatchObject({ error: "expired_token" });
  });

  it("denied requests and unknown codes", async () => {
    const account = await new ControlDirectory(
      h.env.DIRECTORY,
      kernelClock,
    ).provisionPersonalAccount({ address: "bo@bye.test", displayName: "Bo" });
    const { token } = await new ControlAuth(
      h.env.DIRECTORY,
      kernelClock,
      await authConfig(h.env),
    ).issueSession(account.userId, "laptop", true);
    const cookie = `__Host-session=${token}`;
    const auth = (await (
      await raw("/oauth/device_authorization", form({ client_id: "bye-cli" }))
    ).json()) as { device_code: string; user_code: string };
    await raw(
      "/device",
      form({ user_code: auth.user_code, decision: "deny" }, { cookie, origin: h.env.APP_ORIGIN }),
    );
    const denied = await raw(
      "/oauth/token",
      form({ grant_type: DEVICE_GRANT, device_code: auth.device_code, client_id: "bye-cli" }),
    );
    expect(await denied.json()).toMatchObject({ error: "access_denied" });

    const unknown = await raw("/device?user_code=BCDF-GHJK", { headers: { cookie } });
    expect(unknown.status).toBe(400);
    expect((await raw("/oauth/device_authorization", form({ client_id: "nope" }))).status).toBe(
      401,
    );
  });
});

describe("§10 image proxy hardening", () => {
  // §10 image proxy: DNS-rebinding defense (resolved addresses checked on every hop) and a
  // byte-bounded streaming read.

  const env = {
    PROXY_SIGNING_KEY: "proxy-key-test",
    MAIL_ORIGIN: "https://mail.bye.test",
  } as unknown as CoreEnv;
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

  /** DoH fake: host → addresses (A and AAAA answered from the same list by family). */
  const dohFor = (zones: Record<string, ReadonlyArray<string>>) => {
    const asked: Array<string> = [];
    const doh: ImageProxyDeps["doh"] = async (url) => {
      const u = new URL(url);
      const name = u.searchParams.get("name")!;
      const type = u.searchParams.get("type");
      asked.push(`${name}/${type}`);
      const ips = (zones[name] ?? []).filter((ip) =>
        type === "AAAA" ? ip.includes(":") : !ip.includes(":"),
      );
      return Response.json({
        Status: 0,
        Answer: ips.map((data) => ({ type: type === "AAAA" ? 28 : 1, data })),
      });
    };
    return { doh, asked };
  };

  const proxied = async (target: string, deps: ImageProxyDeps) =>
    handleImageProxy(
      new Request(await signProxyUrl(target, env.PROXY_SIGNING_KEY, `${env.MAIL_ORIGIN}/img`)),
      env,
      deps,
    );

  it("refuses a hostname that resolves to a private address, before any fetch", async () => {
    const { doh } = dohFor({ "evil.example.net": ["93.184.216.34", "10.0.0.5"] });
    let fetched = 0;
    const res = await proxied("https://evil.example.net/p.png", {
      doh,
      fetch: async () => (
        fetched++,
        new Response(PNG, { headers: { "content-type": "image/png" } })
      ),
    });
    expect(res.status).toBe(403);
    expect(fetched).toBe(0);
  });

  it("refuses metadata/IPv6-private answers and unresolvable or failing lookups", async () => {
    expect(
      await forbiddenResolution(
        "meta.example.net",
        dohFor({ "meta.example.net": ["169.254.169.254"] }).doh,
      ),
    ).not.toBeNull();
    expect(
      await forbiddenResolution("v6.example.net", dohFor({ "v6.example.net": ["fd00::1"] }).doh),
    ).not.toBeNull();
    expect(await forbiddenResolution("nx.example.net", dohFor({}).doh)).toBe("did not resolve");
    expect(
      await forbiddenResolution("down.example.net", async () => new Response("", { status: 502 })),
    ).toBe("resolution failed");
    expect(
      await forbiddenResolution("boom.example.net", async () => Promise.reject(new Error("net"))),
    ).toBe("resolution failed");
  });

  it("re-checks resolution on every redirect hop (public host redirecting to a rebinding host)", async () => {
    const { doh, asked } = dohFor({
      "cdn.example.net": ["93.184.216.34"],
      "rebind.example.net": ["127.0.0.1"],
    });
    const fetched: Array<string> = [];
    const res = await proxied("https://cdn.example.net/a.png", {
      doh,
      fetch: async (url) => (
        fetched.push(url),
        new Response(null, {
          status: 302,
          headers: { location: "https://rebind.example.net/b.png" },
        })
      ),
    });
    expect(res.status).toBe(403);
    expect(fetched).toEqual(["https://cdn.example.net/a.png"]);
    expect(asked).toContain("rebind.example.net/A");
  });

  it("serves a raster image from a host with only public answers", async () => {
    const { doh } = dohFor({ "cdn.example.net": ["93.184.216.34", "2606:2800:220:1::1"] });
    const res = await proxied("https://cdn.example.net/ok.png", {
      doh,
      fetch: async () => new Response(PNG, { headers: { "content-type": "image/png" } }),
    });
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("rejects SVG and non-image types", async () => {
    const { doh } = dohFor({ "cdn.example.net": ["93.184.216.34"] });
    for (const type of ["image/svg+xml", "text/html"]) {
      const res = await proxied("https://cdn.example.net/x", {
        doh,
        fetch: async () =>
          new Response("<svg onload=alert(1)>", { headers: { "content-type": type } }),
      });
      expect(res.status).toBe(415);
    }
  });

  it("rejects an oversized declared length without reading, and aborts an unannounced oversized stream early", async () => {
    const { doh } = dohFor({ "cdn.example.net": ["93.184.216.34"] });
    let pulledDeclared = 0;
    const declared = await proxied("https://cdn.example.net/big.png", {
      doh,
      fetch: async () =>
        new Response(
          new ReadableStream(
            {
              pull: (c) => {
                pulledDeclared++;
                c.enqueue(new Uint8Array(1024));
              },
            },
            { highWaterMark: 0 },
          ),
          {
            headers: { "content-type": "image/png", "content-length": String(MAX_IMAGE_BYTES + 1) },
          },
        ),
    });
    expect(declared.status).toBe(413);
    expect(pulledDeclared).toBe(0);

    let pulled = 0;
    let cancelled = false;
    const chunk = 1 << 20;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull: (c) => {
          pulled += chunk;
          c.enqueue(new Uint8Array(chunk));
        },
        cancel: () => {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const res = await proxied("https://cdn.example.net/chunked.png", {
      doh,
      fetch: async () => new Response(stream, { headers: { "content-type": "image/png" } }),
    });
    expect(res.status).toBe(413);
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThanOrEqual(MAX_IMAGE_BYTES + chunk);
  });

  it("readCapped returns the exact bytes under the cap", async () => {
    expect(await readCapped(new Response(new Uint8Array([1, 2, 3])), 3)).toEqual(
      new Uint8Array([1, 2, 3]),
    );
    expect(await readCapped(new Response(new Uint8Array([1, 2, 3, 4])), 3)).toBeNull();
  });
});

describe("DS11 device sign-in secrets never reach logs or stored state", () => {
  // §10 image proxy: DNS-rebinding defense (resolved addresses checked on every hop) and a
  // byte-bounded streaming read.

  /** DoH fake: host → addresses (A and AAAA answered from the same list by family). */

  it("authorization code, PKCE verifier, access and refresh tokens are absent from every log line and D1 row", async () => {
    const lines: Array<string> = [];
    const capture = (...args: Array<unknown>) =>
      void lines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(capture),
    );
    const h = makeHarness();
    const ctx = {
      waitUntil: () => undefined,
      passThroughOnException: () => undefined,
    } as unknown as ExecutionContext;
    const raw = (path: string, init: RequestInit = {}) =>
      handleFetch(new Request(`${h.env.APP_ORIGIN}${path}`, init), h.env, ctx);
    const form = (fields: Record<string, string>): RequestInit => ({
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields).toString(),
    });
    try {
      const account = await new ControlDirectory(
        h.env.DIRECTORY,
        kernelClock,
      ).provisionPersonalAccount({ address: "ana@bye.test", displayName: "ana" });
      const session = await new ControlAuth(
        h.env.DIRECTORY,
        kernelClock,
        await authConfig(h.env),
      ).issueSession(account.userId, "browser", true);
      const verifier = "VERIFIERCANARY-" + "x".repeat(43);
      const query = new URLSearchParams({
        response_type: "code",
        client_id: "bye-desktop",
        redirect_uri: "bye://oauth/callback",
        code_challenge: await pkceChallenge(verifier),
        code_challenge_method: "S256",
        state: "st_0123456789abcdef",
        device_name: "Mac",
      });
      const approved = await raw("/oauth/authorize", {
        method: "POST",
        redirect: "manual",
        headers: {
          cookie: `__Host-session=${session.token}`,
          origin: h.env.APP_ORIGIN,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: `${query.toString()}&decision=allow`,
      });
      const code = new URL(approved.headers.get("location")!).searchParams.get("code")!;
      expect(code).toBeTruthy();
      const exchanged = (await (
        await raw(
          "/oauth/token",
          form({
            grant_type: "authorization_code",
            code,
            code_verifier: verifier,
            redirect_uri: "bye://oauth/callback",
            client_id: "bye-desktop",
          }),
        )
      ).json()) as Record<string, string>;
      expect(exchanged.access_token).toBeTruthy();
      const refreshed = (await (
        await raw(
          "/oauth/token",
          form({
            grant_type: "refresh_token",
            refresh_token: exchanged.refresh_token!,
            client_id: "bye-desktop",
          }),
        )
      ).json()) as Record<string, string>;
      expect(refreshed.refresh_token).toBeTruthy();
      await raw("/v1/me", { headers: { authorization: `Bearer ${refreshed.access_token}` } });
      // Reusing the rotated refresh token revokes the session (and must not log the token).
      await raw(
        "/oauth/token",
        form({
          grant_type: "refresh_token",
          refresh_token: exchanged.refresh_token!,
          client_id: "bye-desktop",
        }),
      );
      await raw("/oauth/revoke", form({ token: refreshed.refresh_token! }));
      // Failure paths must not log what they reject either: a replayed code with a wrong verifier.
      await raw(
        "/oauth/token",
        form({
          grant_type: "authorization_code",
          code,
          code_verifier: "WRONGVERIFIERCANARY".padEnd(43, "y"),
          redirect_uri: "bye://oauth/callback",
          client_id: "bye-desktop",
        }),
      );

      const secrets = [
        code,
        verifier,
        "WRONGVERIFIERCANARY",
        exchanged.access_token!,
        exchanged.refresh_token!,
        refreshed.access_token!,
        refreshed.refresh_token!,
        session.token,
      ];
      const logged = lines.join("\n");
      for (const secret of secrets)
        expect(logged, `log leaked ${secret.slice(0, 10)}…`).not.toContain(secret);

      // Stored state keeps only hashes: no table row contains any raw credential.
      const tables = (
        await h.d1
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
          .all<{ name: string }>()
      ).results.map((t) => t.name);
      const dump: Array<string> = [];
      for (const t of tables)
        dump.push(JSON.stringify((await h.d1.prepare(`SELECT * FROM "${t}"`).all()).results));
      const stored = dump.join("\n");
      for (const secret of secrets)
        expect(stored, `D1 stores ${secret.slice(0, 10)}…`).not.toContain(secret);
    } finally {
      for (const s of spies) s.mockRestore();
    }
  });
});

describe("device-code rate limits", () => {
  const ctx = {
    waitUntil: () => undefined,
    passThroughOnException: () => undefined,
  } as unknown as ExecutionContext;

  interface Account {
    readonly userId: string;
    readonly mailboxId: string;
    readonly calendarId: string;
    readonly token: string;
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
    return {
      userId: account.userId,
      mailboxId: account.mailboxId,
      calendarId: account.calendarId,
      token: session.token,
    };
  };

  let h: Harness;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2026, 8, 26, 12));
    h = makeHarness();
  });
  afterEach(() => vi.useRealTimers());

  it("[DS10] device-code lookups and decisions are rate-limited per session", async () => {
    const ana = await signup(h, "ana@bye.test");
    const seen: Array<string> = [];
    (h.env as { AUTH_RATE_LIMIT: unknown }).AUTH_RATE_LIMIT = {
      limit: async ({ key }: { key: string }) => (
        seen.push(key),
        { success: !key.startsWith("device:") }
      ),
    };
    const cookie = `__Host-session=${ana.token}`;
    const lookup = await handleFetch(
      new Request(`${h.env.APP_ORIGIN}/device?user_code=BCDF-GHJK`, { headers: { cookie } }),
      h.env,
      ctx,
    );
    expect(lookup.status).toBe(429);
    const decide = await handleFetch(
      new Request(`${h.env.APP_ORIGIN}/device`, {
        method: "POST",
        headers: {
          cookie,
          origin: h.env.APP_ORIGIN,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: "user_code=BCDF-GHJK&decision=deny",
      }),
      h.env,
      ctx,
    );
    expect(decide.status).toBe(429);
    expect(seen.every((k) => k.startsWith("device:"))).toBe(true);
  });
});

describe("image proxy DNS lookups", () => {
  it("[§10] the image proxy's A and AAAA lookups run concurrently", async () => {
    let inFlight = 0;
    let peak = 0;
    const doh = async (url: string) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      const type = new URL(url).searchParams.get("type");
      return Response.json({
        Status: 0,
        Answer: type === "A" ? [{ type: 1, data: "93.184.216.34" }] : [],
      });
    };
    vi.useRealTimers();
    expect(await forbiddenResolution("cdn.example.net", doh as never)).toBeNull();
    expect(peak).toBe(2);
  });
});

describe("live sockets and credentials", () => {
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

  /** Run due mailbox jobs and queues with the provider transport mocked; returns submitted bodies. */

  let h: Harness;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2026, 8, 25, 12));
    h = makeHarness();
    (h.env as { PERSONAL_MAIL_API_KEY: string }).PERSONAL_MAIL_API_KEY = "pm-key";
  });
  afterEach(() => vi.useRealTimers());

  it("[DS09] live sockets are tagged with the server-verified credential and closed when it is revoked", async () => {
    const ana = await signup(h, "ana@bye.test");
    const second = await new ControlAuth(
      h.env.DIRECTORY,
      kernelClock,
      await authConfig(h.env),
    ).issueSession(ana.userId, "phone", true);
    const phone = { ...ana, token: second.token };
    const pairs = installWebSocketPair();
    try {
      // A client-supplied credential header is ignored: the API tags with the verified session.
      for (const who of [ana, phone])
        await call(h, who, "GET", `/v1/live?mailbox=${ana.mailboxId}`, {
          headers: {
            upgrade: "websocket",
            origin: h.env.APP_ORIGIN,
            "x-bye-credential": "forged",
          },
        });
    } finally {
      pairs.restore();
    }
    const state = h.namespaces.MAILBOXES.state(ana.mailboxId);
    expect(pairs.created).toHaveLength(2);
    const [laptopSocket, phoneSocket] = pairs.created as [FakeServerSocket, FakeServerSocket];
    expect(state.getTags(laptopSocket)).toEqual([`cred:${ana.sessionId}`]);
    expect(state.getWebSockets("cred:forged")).toEqual([]);
    const phoneTag = state.getTags(phoneSocket)[0]!;
    expect(phoneTag).not.toBe(`cred:${ana.sessionId}`);

    const sessions = (await call(h, phone, "GET", "/v1/security/sessions")).body.items as Array<{
      id: string;
    }>;
    expect(sessions).toHaveLength(2);
    expect((await call(h, phone, "DELETE", `/v1/security/sessions/${ana.sessionId}`)).status).toBe(
      200,
    );
    // Only the revoked session's socket closes; the phone's stays open and keeps receiving hints.
    expect(laptopSocket.closed).toEqual({ code: 4401, reason: "session revoked" });
    expect(phoneSocket.closed).toBeNull();
    expect((await call(h, ana, "GET", "/v1/security/sessions")).status).toBe(401);
  });
});

describe("live sockets on credential rotation", () => {
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

  /** Run due mailbox jobs and queues with the provider transport mocked; returns submitted bodies. */

  let h: Harness;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2026, 8, 25, 12));
    h = makeHarness();
  });
  afterEach(() => vi.useRealTimers());

  it("[DS09] step-up rotation, OAuth revoke and refresh-token reuse close the old credential's sockets", async () => {
    const ana = await signup(h, "ana@bye.test");
    const instance = h.namespaces.MAILBOXES.instance(ana.mailboxId) as unknown as {
      closeSockets(id?: string): number;
    };
    const closed: Array<string | undefined> = [];
    instance.closeSockets = (id?: string) => (closed.push(id), 0);

    // Step-up rotates the cookie session; sockets tagged with the old session close.
    const auth = new ControlAuth(h.env.DIRECTORY, kernelClock, await authConfig(h.env));
    const { secret } = await auth.enrollTotp(ana.userId);
    await auth.confirmTotp(ana.userId, await hotp(base32Decode(secret), totpStep(Date.now())));
    vi.setSystemTime(Date.now() + 30_000);
    const stepped = await call(h, ana, "POST", "/auth/step-up/totp", {
      json: { code: await hotp(base32Decode(secret), totpStep(Date.now())) },
    });
    expect(stepped.status).toBe(200);
    expect(closed).toEqual([ana.sessionId]);

    // Device sessions: explicit revoke and refresh-token reuse.
    const sha = async (v: string) =>
      [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v)))]
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
    const device = async (id: string, refresh: string, rotated: boolean) => {
      const now = Date.now();
      await h.d1
        .prepare(
          "INSERT INTO device_sessions (id, user_id, client_id, device_name, created_at, last_used_at, idle_expires_at, absolute_expires_at) VALUES (?, ?, 'bye-desktop', 'Mac', ?, ?, ?, ?)",
        )
        .bind(id, ana.userId, now, now, now + 86400_000, now + 30 * 86400_000)
        .run();
      await h.d1
        .prepare(
          "INSERT INTO device_refresh_tokens (token_hash, session_id, created_at, rotated_at) VALUES (?, ?, ?, ?)",
        )
        .bind(await sha(refresh), id, now, rotated ? now : null)
        .run();
    };
    const form = (fields: Record<string, string>) => ({
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields).toString(),
    });
    await device("dvs_revoke", "refresh-token-to-revoke", false);
    await handleFetch(
      new Request(`${h.env.APP_ORIGIN}/oauth/revoke`, form({ token: "refresh-token-to-revoke" })),
      h.env,
      ctx,
    );
    await device("dvs_reuse", "already-rotated-refresh", true);
    const reuse = await handleFetch(
      new Request(
        `${h.env.APP_ORIGIN}/oauth/token`,
        form({
          grant_type: "refresh_token",
          refresh_token: "already-rotated-refresh",
          client_id: "bye-desktop",
        }),
      ),
      h.env,
      ctx,
    );
    expect(reuse.status).toBe(400);
    expect(closed).toEqual([ana.sessionId, "dvs_revoke", "dvs_reuse"]);
  });
});
