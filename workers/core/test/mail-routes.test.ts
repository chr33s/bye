import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ControlAuth,
  ControlDirectory,
  type MailboxStore,
  SendingPolicy,
  authorizeSearchResults,
} from "@bye/platform-cloudflare";
import { handleFetch } from "../src/api.ts";
import { kernelClock } from "../src/durable-host.ts";
import { handleInbound } from "../src/inbound.ts";
import { itipUid, type MailboxDO } from "../src/objects/mailbox.ts";
import { authConfig } from "../src/services.ts";
import {
  type Harness,
  inboundMessage,
  makeHarness,
  rfc822,
  enablePersonalMail,
} from "./harness.ts";
import { blobKey } from "@bye/application";
import { bodyKeyFor } from "../src/objects.ts";

// HTTP wiring for the mailbox/search gap routes (§8, E02–E24) over in-memory bindings.

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
  readonly address: string;
  readonly cookie: string;
}

const signup = async (h: Harness, address: string): Promise<Account> => {
  const directory = new ControlDirectory(h.env.DIRECTORY, kernelClock);
  const account = await directory.provisionPersonalAccount({
    address,
    displayName: address.split("@")[0]!,
  });
  const auth = new ControlAuth(h.env.DIRECTORY, kernelClock, await authConfig(h.env));
  const session = await auth.issueSession(account.userId, "test", true);
  return { ...account, cookie: `__Host-session=${session.token}` };
};

const call = async (
  h: Harness,
  account: Account | null,
  method: string,
  url: string,
  init: { body?: BodyInit; json?: unknown; headers?: Record<string, string> } = {},
) => {
  const response = await handleFetch(
    new Request(url.startsWith("http") ? url : `${h.env.APP_ORIGIN}${url}`, {
      method,
      headers: {
        ...(account ? { cookie: account.cookie } : {}),
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
  const type = response.headers.get("content-type") ?? "";
  const bytes = new Uint8Array(await response.arrayBuffer());
  const text = new TextDecoder().decode(bytes);
  return {
    status: response.status,
    headers: response.headers,
    bytes,
    text,
    body: type.includes("json") && text ? JSON.parse(text) : null,
  };
};

let n = 0;
const cmdId = () => `cmd_${(++n).toString(36).padStart(20, "0")}`;

const command = (h: Harness, a: Account, body: Record<string, unknown>) =>
  call(h, a, "POST", `/v1/mailboxes/${a.mailboxId}/commands`, {
    json: { commandId: cmdId(), ...body },
  });

const allowDomain = (h: Harness, a: Account, domain: string) =>
  command(h, a, {
    _tag: "SetPolicy",
    kind: "domain",
    subject: domain,
    policy: { decision: "allowed", destination: "imbox", labels: [], bundle: false, notify: false },
  });

const deliver = async (h: Harness, raw: string, from: string, to: string) => {
  const outcome = await handleInbound(inboundMessage(from, to, raw), h.env);
  await h.drain();
  return outcome;
};

const withAttachment = (
  from: string,
  to: string,
  subject: string,
  filename: string,
  content: string,
) =>
  [
    "Authentication-Results: mx.cloudflare.net; spf=pass; dkim=pass; dmarc=pass",
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    "Date: Fri, 25 Sep 2026 12:00:00 +0000",
    `Message-ID: <${subject.replace(/\W/g, "")}-${++n}@example.net>`,
    "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="b1"',
    "",
    "--b1",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "see attached",
    "--b1",
    `Content-Type: text/plain; name="${filename}"`,
    `Content-Disposition: attachment; filename="${filename}"`,
    "",
    content,
    "--b1--",
    "",
  ].join("\r\n");

describe("mail gap routes", () => {
  let h: Harness;
  let ana: Account;
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2026, 8, 25, 12));
    h = makeHarness();
    ana = await signup(h, "ana@bye.test");
  });
  afterEach(() => vi.useRealTimers());

  it("[§7.5] JSON routes decode their contract: a malformed body is a 400 before any authority is called", async () => {
    const bad = await call(h, ana, "POST", "/v1/drafts", {
      json: { mailboxId: ana.mailboxId, content: { subject: "no command id" } },
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error.message).toMatch(/invalid request body/);
    expect(
      (
        await call(h, ana, "POST", "/v1/drafts/drf_x/send", {
          json: { mailboxId: ana.mailboxId, commandId: cmdId(), revision: "one" },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call(h, ana, "POST", "/v1/uploads", {
          json: { mailboxId: ana.mailboxId, commandId: cmdId(), filename: 7 },
        })
      ).status,
    ).toBe(400);
  });

  it("[§8] typed reads: every list read answers { items } through one read table, and authority refusals map once", async () => {
    for (const path of [
      "labels",
      "rules",
      "workflows",
      "notes",
      "clips",
      "policies",
      "contacts",
      "identities",
      "attachments",
      "focus",
    ]) {
      const r = await call(h, ana, "GET", `/v1/mailboxes/${ana.mailboxId}/${path}`);
      expect(r.status, path).toBe(200);
      expect(Array.isArray(r.body.items), path).toBe(true);
    }
    // A refusal inside the authority (unknown board) is the public not_found, not a 500.
    expect(
      (await call(h, ana, "GET", `/v1/mailboxes/${ana.mailboxId}/workflows/brd_missing`)).status,
    ).toBe(404);
    // Another tenant's mailbox is refused before the read reaches the authority.
    const bob = await signup(h, "bob@bye.test");
    expect((await call(h, bob, "GET", `/v1/mailboxes/${ana.mailboxId}/labels`)).status).toBe(403);
  });

  it("[E20] uploads: reserve → PUT part → complete with size verification → scanned → public file link → revoke", async () => {
    const reserve = await call(h, ana, "POST", "/v1/uploads", {
      json: {
        mailboxId: ana.mailboxId,
        commandId: cmdId(),
        filename: "big.bin",
        contentType: "application/octet-stream",
        declaredSize: 11,
      },
    });
    expect(reserve.status).toBe(201);
    const { uploadId, partSize } = reserve.body;
    expect(partSize).toBeGreaterThan(0);
    const part = await call(
      h,
      ana,
      "PUT",
      `/v1/uploads/${uploadId}/parts/1?mailbox=${ana.mailboxId}`,
      { body: "hello world", headers: { "content-length": "11" } },
    );
    expect(part.status).toBe(200);
    const done = await call(h, ana, "POST", `/v1/uploads/${uploadId}/complete`, {
      json: { mailboxId: ana.mailboxId, commandId: cmdId() },
    });
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ state: "complete", actualSize: 11 });
    await h.drain();

    const link = await command(h, ana, { _tag: "CreateFileLink", uploadId });
    expect(link.status).toBe(200);
    const pub = await call(h, null, "GET", `/v1/files/${ana.mailboxId}/${link.body.token}`);
    expect(pub.status).toBe(200);
    expect(pub.text).toBe("hello world");
    expect(pub.headers.get("content-disposition")).toContain("big.bin");

    const grants = await call(h, ana, "GET", `/v1/grants?mailbox=${ana.mailboxId}`);
    expect(grants.body.items.map((g: { linkId: string }) => g.linkId)).toEqual([link.body.linkId]);
    expect(
      (
        await call(h, ana, "DELETE", `/v1/grants/${link.body.linkId}?mailbox=${ana.mailboxId}`, {
          headers: { "idempotency-key": cmdId() },
        })
      ).status,
    ).toBe(200);
    expect(
      (await call(h, null, "GET", `/v1/files/${ana.mailboxId}/${link.body.token}`)).status,
    ).toBe(404);
    expect(
      (await call(h, null, "GET", `/v1/files/${ana.mailboxId}/lnk_guess.nope-secret`)).status,
    ).toBe(404);
  });

  it("[E20] an upload larger than declared fails on complete", async () => {
    const reserve = await call(h, ana, "POST", "/v1/uploads", {
      json: {
        mailboxId: ana.mailboxId,
        commandId: cmdId(),
        filename: "x.bin",
        contentType: "application/octet-stream",
        declaredSize: 4,
      },
    });
    const { uploadId } = reserve.body;
    // The declared part length fits, but the stored bytes are what count.
    await call(h, ana, "PUT", `/v1/uploads/${uploadId}/parts/1?mailbox=${ana.mailboxId}`, {
      body: "123456789",
      headers: { "content-length": "4" },
    });
    const done = await call(h, ana, "POST", `/v1/uploads/${uploadId}/complete`, {
      json: { mailboxId: ana.mailboxId, commandId: cmdId() },
    });
    expect(done.body).toMatchObject({ state: "failed", actualSize: 9 });
  });

  it("[E20] attachment library, bulk zip, and sandboxed preview on the render origin", async () => {
    await allowDomain(h, ana, "example.net");
    await deliver(
      h,
      withAttachment("bob@example.net", "ana@bye.test", "Notes", "notes.txt", "line one"),
      "bob@example.net",
      "ana@bye.test",
    );
    await deliver(
      h,
      withAttachment("bob@example.net", "ana@bye.test", "More", "notes.txt", "line two"),
      "bob@example.net",
      "ana@bye.test",
    );
    const lib = await call(h, ana, "GET", `/v1/mailboxes/${ana.mailboxId}/attachments`);
    expect(lib.status).toBe(200);
    expect(lib.body.items).toHaveLength(2);
    expect(lib.body.items.every((a: { scan: string }) => a.scan === "clean")).toBe(true);

    const zip = await call(h, ana, "POST", `/v1/mailboxes/${ana.mailboxId}/attachments/zip`, {
      json: {
        items: lib.body.items.map((a: { deliveryId: string; partId: string }) => ({
          deliveryId: a.deliveryId,
          partId: a.partId,
        })),
      },
    });
    expect(zip.status).toBe(200);
    expect(zip.headers.get("content-type")).toBe("application/zip");
    expect(new DataView(zip.bytes.buffer).getUint32(0, true)).toBe(0x04034b50);
    expect(zip.text).toContain("notes.txt");
    expect(zip.text).toContain("notes (2).txt");

    const a0 = lib.body.items[0] as { deliveryId: string; partId: string };
    const preview = await call(
      h,
      ana,
      "GET",
      `/v1/mailboxes/${ana.mailboxId}/deliveries/${a0.deliveryId}/attachments/${encodeURIComponent(a0.partId)}/preview`,
    );
    expect(preview.status).toBe(200);
    expect(preview.body.previewUrl.startsWith(h.env.MAIL_ORIGIN)).toBe(true);
    const rendered = await call(h, null, "GET", preview.body.previewUrl);
    expect(rendered.status).toBe(200);
    expect(rendered.headers.get("content-security-policy")).toContain("sandbox");
    expect(rendered.text).toMatch(/line (one|two)/);
    // Other users cannot preview or zip.
    const eve = await signup(h, "eve@bye.test");
    expect(
      (
        await call(h, eve, "POST", `/v1/mailboxes/${ana.mailboxId}/attachments/zip`, {
          json: { items: [a0] },
        })
      ).status,
    ).toBe(403);
  });

  it("[E21] a read-only credential can search but never writes the recent-search history", async () => {
    const auth = new ControlAuth(h.env.DIRECTORY, kernelClock, await authConfig(h.env));
    const session = await auth.issueSession(ana.userId, "t", true);
    const agent = await auth.createApiToken(session.session.user_id, {
      kind: "agent",
      label: "ro",
      scopes: ["read"],
    });
    const hits = await call(h, null, "GET", `/v1/mailboxes/${ana.mailboxId}/search?q=zanzibar`, {
      headers: { authorization: `Bearer ${agent.token}` },
    });
    expect(hits.status).toBe(200);
    const recent = await call(h, ana, "GET", `/v1/mailboxes/${ana.mailboxId}/searches/recent`);
    expect(recent.body.items).not.toContain("zanzibar");
  });

  it("[E21] search fans out over shards, reports the watermark, and records recent searches", async () => {
    await allowDomain(h, ana, "example.net");
    await deliver(
      h,
      rfc822({
        from: "bob@example.net",
        to: "ana@bye.test",
        subject: "Zanzibar trip",
        body: "plans",
        messageId: "z1@example.net",
      }),
      "bob@example.net",
      "ana@bye.test",
    );
    const hits = await call(h, ana, "GET", `/v1/mailboxes/${ana.mailboxId}/search?q=zanzibar`);
    expect(hits.status).toBe(200);
    expect(hits.body.results).toHaveLength(1);
    expect(hits.body).toMatchObject({ lagging: false });
    expect(typeof hits.body.watermark).toBe("number");
    const recent = await call(h, ana, "GET", `/v1/mailboxes/${ana.mailboxId}/searches/recent`);
    expect(recent.body.items).toContain("zanzibar");

    // Trash is reindexed and excluded from default search; `in:trash` finds it (P0 #3).
    const thread = (await call(h, ana, "GET", `/v1/mailboxes/${ana.mailboxId}/views/imbox`)).body
      .items[0];
    await command(h, ana, { _tag: "MoveToTrash", threadIds: [thread.threadId] });
    await h.drain();
    expect(
      (await call(h, ana, "GET", `/v1/mailboxes/${ana.mailboxId}/search?q=zanzibar`)).body.results,
    ).toHaveLength(0);
    expect(
      (
        await call(
          h,
          ana,
          "GET",
          `/v1/mailboxes/${ana.mailboxId}/search?q=${encodeURIComponent("zanzibar in:trash")}`,
        )
      ).body.results,
    ).toHaveLength(1);
  });

  it("[E16] contacts vCard import, search, suggest and export round-trip", async () => {
    const vcf = [
      "BEGIN:VCARD",
      "VERSION:4.0",
      "FN:Carol Jones",
      "EMAIL:carol@example.org",
      "END:VCARD",
      "BEGIN:VCARD",
      "VERSION:3.0",
      "FN:No Email",
      "END:VCARD",
      "",
    ].join("\r\n");
    const imported = await call(h, ana, "POST", `/v1/mailboxes/${ana.mailboxId}/contacts/import`, {
      body: vcf,
      headers: { "content-type": "text/vcard", "idempotency-key": cmdId() },
    });
    expect(imported.status).toBe(200);
    expect(imported.body).toMatchObject({ imported: 1 });
    const search = await call(h, ana, "GET", `/v1/mailboxes/${ana.mailboxId}/contacts?q=carol`);
    expect(search.body.items).toHaveLength(1);
    const suggest = await call(
      h,
      ana,
      "GET",
      `/v1/mailboxes/${ana.mailboxId}/contacts/suggest?prefix=car`,
    );
    expect(suggest.status).toBe(200);
    const exported = await call(
      h,
      ana,
      "GET",
      `/v1/mailboxes/${ana.mailboxId}/contacts/export.vcf`,
    );
    expect(exported.status).toBe(200);
    expect(exported.headers.get("content-type")).toContain("text/vcard");
    expect(exported.text).toContain("carol@example.org");
    expect(
      (
        await call(h, ana, "POST", `/v1/mailboxes/${ana.mailboxId}/contacts/import`, {
          body: vcf,
          headers: { "content-type": "text/vcard" },
        })
      ).status,
    ).toBe(400);
  });

  it("[E02/E05/E19] policies with history, expanded feed, unified view, labels and send-job detail", async () => {
    await allowDomain(h, ana, "example.net");
    const policies = await call(h, ana, "GET", `/v1/mailboxes/${ana.mailboxId}/policies`);
    expect(policies.body.items).toEqual([expect.objectContaining({ subject: "example.net" })]);
    const history = await call(h, ana, "GET", `/v1/mailboxes/${ana.mailboxId}/policies/history`);
    expect(history.body.items.length).toBeGreaterThan(0);

    await deliver(
      h,
      rfc822({
        from: "bob@example.net",
        to: "ana@bye.test",
        subject: "Hi",
        body: "hello",
        messageId: "h1@example.net",
      }),
      "bob@example.net",
      "ana@bye.test",
    );
    const unified = await call(h, ana, "GET", "/v1/unified/views/imbox");
    expect(unified.status).toBe(200);
    expect(unified.body.items[0]).toMatchObject({
      mailboxId: ana.mailboxId,
      thread: expect.objectContaining({ subject: "Hi" }),
    });

    const feed = await call(h, ana, "GET", `/v1/mailboxes/${ana.mailboxId}/feed`);
    expect(feed.status).toBe(200);
    expect(feed.body).toMatchObject({ items: [], position: null });

    await command(h, ana, { _tag: "CreateLabel", name: "Work" });
    const labels = await call(h, ana, "GET", `/v1/mailboxes/${ana.mailboxId}/labels`);
    expect(labels.body.items.map((l: { name: string }) => l.name)).toContain("Work");

    await command(h, ana, { _tag: "AddIdentity", address: "ana@bye.test", kind: "hosted" });
    const draft = await call(h, ana, "POST", "/v1/drafts", {
      json: {
        mailboxId: ana.mailboxId,
        commandId: cmdId(),
        content: {
          to: [{ address: "bob@example.net" }],
          cc: [],
          bcc: [],
          subject: "Lunch",
          text: "Noon?",
          attachments: [],
        },
      },
    });
    const send = await call(h, ana, "POST", `/v1/drafts/${draft.body.draftId}/send`, {
      json: {
        mailboxId: ana.mailboxId,
        commandId: cmdId(),
        revision: draft.body.revision,
        afterSend: { _tag: "MarkDone" },
      },
    });
    expect(send.status).toBe(202);
    const jobId = send.body.sendJobIds[0];
    const job = await call(h, ana, "GET", `/v1/mailboxes/${ana.mailboxId}/send-jobs/${jobId}`);
    expect(job.status).toBe(200);
    expect(job.body).toMatchObject({ sendJobId: jobId, recipients: ["bob@example.net"] });
    expect(
      (await call(h, ana, "GET", `/v1/mailboxes/${ana.mailboxId}/send-jobs`)).body.items,
    ).toHaveLength(1);
  });

  it("[C04] an iTIP REPLY from an unscreened sender bypasses the Screener only when the calendar organizes the event", async () => {
    const itip = (from: string, method: string, uid: string) =>
      [
        "Authentication-Results: mx.cloudflare.net; spf=pass; dkim=pass; dmarc=pass",
        `From: ${from}`,
        "To: ana@bye.test",
        `Subject: ${method} ${uid}`,
        "Date: Fri, 25 Sep 2026 12:00:00 +0000",
        `Message-ID: <${uid}-${method}-${++n}@example.net>`,
        "MIME-Version: 1.0",
        `Content-Type: text/calendar; method=${method}; charset=utf-8`,
        "",
        "BEGIN:VCALENDAR",
        `METHOD:${method}`,
        "BEGIN:VEVENT",
        `UID:${uid}`,
        "DTSTART:20261001T100000Z",
        "END:VEVENT",
        "END:VCALENDAR",
        "",
      ].join("\r\n");
    const calendar = h.namespaces.CALENDARS.instance(ana.calendarId) as unknown as {
      isOrganizerOf: (uid: string) => boolean;
    };
    const asked: Array<string> = [];
    calendar.isOrganizerOf = (uid: string) => (asked.push(uid), uid === "evt-ours");
    await deliver(
      h,
      itip("guest@example.org", "REPLY", "evt-ours"),
      "guest@example.org",
      "ana@bye.test",
    );
    await deliver(
      h,
      itip("other@example.org", "REPLY", "evt-theirs"),
      "other@example.org",
      "ana@bye.test",
    );
    await deliver(
      h,
      itip("spam@example.org", "REQUEST", "evt-ours"),
      "spam@example.org",
      "ana@bye.test",
    );
    expect(asked).toEqual(["evt-ours", "evt-theirs"]);
    const imbox = await call(h, ana, "GET", `/v1/mailboxes/${ana.mailboxId}/views/imbox`);
    expect(imbox.body.items.map((t: { subject: string }) => t.subject)).toEqual(["REPLY evt-ours"]);
    const screener = await call(h, ana, "GET", `/v1/mailboxes/${ana.mailboxId}/views/screener`);
    expect(screener.body.items).toHaveLength(2);
    expect(itipUid("BEGIN:VEVENT\r\nUID:abc\r\n 123\r\nEND:VEVENT")).toBe("abc123");
  });

  it("[C04] outbound iTIP jobs commit with their receipt: a failure part-way leaves nothing behind", async () => {
    const cal = await signup(h, "cal@bye.test");
    const mailbox = h.namespaces.MAILBOXES.instance(cal.mailboxId) as unknown as Pick<
      MailboxDO,
      "sendCalendarMessage"
    > & { store: MailboxStore };
    const sends = mailbox.store.sends;
    mailbox.store.ctx.sql.tx(() =>
      mailbox.store.identities.addIdentity({ address: "cal@bye.test", kind: "hosted" }),
    );
    const input = {
      eventKey: "evt-1:1",
      method: "REQUEST",
      ics: "BEGIN:VCALENDAR\r\nEND:VCALENDAR",
      recipients: ["a@example.org", "b@example.org"],
      from: "cal@bye.test",
      subject: "Invitation",
    };
    const before = sends.jobs().length;
    const real = sends.createSystemJob.bind(sends);
    let calls = 0;
    sends.createSystemJob = (job) => {
      if (++calls === 2) throw new Error("storage hiccup");
      return real(job);
    };
    expect(() => mailbox.sendCalendarMessage(input)).toThrow("storage hiccup");
    expect(sends.jobs()).toHaveLength(before);
    sends.createSystemJob = real;
    const first = mailbox.sendCalendarMessage(input);
    expect(first).toHaveLength(2);
    expect(first.every((id) => typeof id === "string")).toBe(true);
    expect(mailbox.sendCalendarMessage(input)).toEqual(first);
    expect(sends.jobs()).toHaveLength(before + 2);
  });
});

describe("signed attachment download links", () => {
  it("[E20] a clean attachment gets a short-lived render-origin link; expiry and blocked scans refuse it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2026, 8, 25, 12));
    const h = makeHarness();
    const ana = await signup(h, "ana@bye.test");
    const raw = [
      "Authentication-Results: mx.cloudflare.net; spf=pass; dkim=pass; dmarc=pass",
      "From: bob@example.net",
      "To: ana@bye.test",
      "Subject: Report",
      "Date: Fri, 25 Sep 2026 12:00:00 +0000",
      "Message-ID: <report-1@example.net>",
      "MIME-Version: 1.0",
      'Content-Type: multipart/mixed; boundary="b1"',
      "",
      "--b1",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "See attached.",
      "--b1",
      'Content-Type: text/plain; name="numbers.txt"',
      'Content-Disposition: attachment; filename="numbers.txt"',
      "",
      "42",
      "--b1--",
      "",
    ].join("\r\n");
    await handleInbound(inboundMessage("bob@example.net", "ana@bye.test", raw), h.env);
    await h.drain();
    const thread = (await call(h, ana, "GET", `/v1/mailboxes/${ana.mailboxId}/views/screener`)).body
      .items[0];
    const detail = await call(
      h,
      ana,
      "GET",
      `/v1/mailboxes/${ana.mailboxId}/threads/${thread.threadId}`,
    );
    const d = detail.body.deliveries[0];
    const link = await call(
      h,
      ana,
      "POST",
      `/v1/mailboxes/${ana.mailboxId}/deliveries/${d.deliveryId}/attachments/${d.attachments[0].partId}/link`,
      { json: {} },
    );
    expect(link.status).toBe(200);
    expect(link.body.downloadUrl.startsWith(h.env.MAIL_ORIGIN)).toBe(true);
    const file = await handleFetch(
      new Request(link.body.downloadUrl),
      h.env,
      {} as ExecutionContext,
    );
    expect(file.status).toBe(200);
    expect(file.headers.get("content-disposition")).toContain("numbers.txt");
    expect((await file.text()).trim()).toBe("42");
    // Another user cannot mint a link for Ana's mailbox.
    const eve = await signup(h, "eve@bye.test");
    expect(
      (
        await call(
          h,
          eve,
          "POST",
          `/v1/mailboxes/${ana.mailboxId}/deliveries/${d.deliveryId}/attachments/${d.attachments[0].partId}/link`,
          { json: {} },
        )
      ).status,
    ).toBe(403);
    // Links expire.
    vi.setSystemTime(Date.now() + 6 * 60_000);
    expect(
      (await handleFetch(new Request(link.body.downloadUrl), h.env, {} as ExecutionContext)).status,
    ).toBe(403);
    vi.useRealTimers();
  });
});

describe("quota includes derived storage", () => {
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
  const cmdId = () => `cmd_oc_${(++n).toString(36).padStart(16, "0")}`;

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

  it("[§12] the quota counts extracted parts, bodies and the owner's exports", async () => {
    const ana = await signup(h, "ana@bye.test");
    const instance = h.namespaces.MAILBOXES.instance(ana.mailboxId) as unknown as {
      store: { uploads: { setQuota(n: number): void } };
    };
    instance.store.uploads.setQuota(10_000);
    const now = Date.now();
    await h.d1
      .prepare(
        "INSERT INTO storage_usage (owner_kind, owner_id, category, bytes, updated_at) VALUES ('mailbox', ?, 'parts', 6000, ?), ('mailbox', ?, 'bodies', 1000, ?), ('user', ?, 'exports', 2500, ?)",
      )
      .bind(ana.mailboxId, now, ana.mailboxId, now, ana.userId, now)
      .run();
    const quota = await call(h, ana, "GET", `/v1/mailboxes/${ana.mailboxId}/quota`);
    expect(quota.body).toMatchObject({ limitBytes: 10_000, usedBytes: 9500 });
    const tooBig = await call(h, ana, "POST", "/v1/uploads", {
      mailboxId: ana.mailboxId,
      commandId: cmdId(),
      filename: "a.bin",
      contentType: "application/octet-stream",
      declaredSize: 600,
    });
    expect(tooBig.status).toBe(413);
    const fits = await call(h, ana, "POST", "/v1/uploads", {
      mailboxId: ana.mailboxId,
      commandId: cmdId(),
      filename: "b.bin",
      contentType: "application/octet-stream",
      declaredSize: 400,
    });
    expect(fits.status).toBe(201);
  });
});

describe("sending policy at dispatch", () => {
  const ctx = {
    waitUntil: () => undefined,
    passThroughOnException: () => undefined,
  } as unknown as ExecutionContext;
  let n = 0;
  const cmdId = () => `cmd_rv_${(++n).toString(36).padStart(16, "0")}`;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2026, 8, 25, 12));
  });
  afterEach(() => vi.useRealTimers());

  it("[§10] suppressed recipients are removed from the envelope while the rest still receive the message", async () => {
    const h = makeHarness();
    enablePersonalMail(h);
    const account = await new ControlDirectory(
      h.env.DIRECTORY,
      kernelClock,
    ).provisionPersonalAccount({ address: "ana@bye.test", displayName: "Ana" });
    const token = (
      await new ControlAuth(h.env.DIRECTORY, kernelClock, await authConfig(h.env)).issueSession(
        account.userId,
        "t",
        true,
      )
    ).token;
    const api = async (method: string, path: string, body?: unknown) => {
      const r = await handleFetch(
        new Request(`${h.env.APP_ORIGIN}${path}`, {
          method,
          headers: {
            cookie: `__Host-session=${token}`,
            origin: h.env.APP_ORIGIN,
            "content-type": "application/json",
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        }),
        h.env,
        ctx,
      );
      return { status: r.status, body: (await r.json().catch(() => null)) as any };
    };
    await new SendingPolicy(h.env.DIRECTORY, kernelClock).suppress(
      "bob@example.net",
      "manual",
      "test",
    );
    await api("POST", `/v1/mailboxes/${account.mailboxId}/commands`, {
      _tag: "AddIdentity",
      commandId: cmdId(),
      address: "ana@bye.test",
      kind: "hosted",
    });
    const draft = await api("POST", "/v1/drafts", {
      mailboxId: account.mailboxId,
      commandId: cmdId(),
      content: {
        to: [{ address: "alice@example.net" }, { address: "bob@example.net" }],
        cc: [],
        bcc: [],
        subject: "Hi",
        text: "x",
        attachments: [],
      },
    });
    const sent = await api("POST", `/v1/drafts/${draft.body.draftId}/send`, {
      mailboxId: account.mailboxId,
      commandId: cmdId(),
      revision: draft.body.revision,
    });
    const before = h.sent.length;
    vi.setSystemTime(Date.now() + 60_000);
    await h.namespaces.MAILBOXES.instance(account.mailboxId).alarm();
    await h.drain();
    // One send per envelope recipient: only alice is on the envelope.
    expect(h.sent.slice(before).map((m) => m.to)).toEqual(["alice@example.net"]);
    const job = await h.namespaces.MAILBOXES.instance(account.mailboxId).sendJob(
      sent.body.sendJobIds[0],
    );
    expect(job?.state).toBe("accepted");
    expect(job?.outcomes.find((o) => o.address === "bob@example.net")?.outcome).toBe("rejected");
  });
});

describe("quota accounting", () => {
  const ctx = {
    waitUntil: () => undefined,
    passThroughOnException: () => undefined,
  } as unknown as ExecutionContext;
  let n = 0;
  const cmdId = () => `cmd_r5_${(++n).toString(36).padStart(16, "0")}`;

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

  let h: Harness;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2026, 8, 26, 12));
    h = makeHarness();
  });
  afterEach(() => vi.useRealTimers());

  it("[§12] a D1 error refreshing storage usage doesn't fail uploads or the quota read", async () => {
    const ana = await signup(h, "ana@bye.test");
    await h.d1.prepare("DROP TABLE storage_usage").run();
    const reserve = await call(h, ana, "POST", "/v1/uploads", {
      json: {
        mailboxId: ana.mailboxId,
        commandId: cmdId(),
        filename: "a.txt",
        contentType: "text/plain",
        declaredSize: 3,
      },
    });
    expect(reserve.status).toBe(201);
    expect((await call(h, ana, "GET", `/v1/mailboxes/${ana.mailboxId}/quota`)).status).toBe(200);
  });

  it("[§12] a user's exports count against one mailbox's quota, not every mailbox they own", async () => {
    const ana = await signup(h, "ana@bye.test");
    const org = (await h.d1
      .prepare("SELECT org_id FROM mailboxes WHERE id = ?")
      .bind(ana.mailboxId)
      .first<{ org_id: string }>())!.org_id;
    await h.d1
      .prepare(
        "INSERT INTO mailboxes (id, org_id, owner_user_id, kind, created_at) VALUES ('mbx_second', ?, ?, 'personal', ?)",
      )
      .bind(org, ana.userId, Date.now() + 1000)
      .run();
    await h.d1
      .prepare(
        "INSERT INTO mailbox_access (mailbox_id, user_id, role, can_send, created_at) VALUES ('mbx_second', ?, 'owner', 1, ?)",
      )
      .bind(ana.userId, Date.now())
      .run();
    await h.d1
      .prepare(
        "INSERT INTO storage_usage (owner_kind, owner_id, category, bytes, updated_at) VALUES ('user', ?, 'exports', 3000000, ?)",
      )
      .bind(ana.userId, Date.now())
      .run();
    const used = async (mailboxId: string) =>
      (await call(h, ana, "GET", `/v1/mailboxes/${mailboxId}/quota`)).body.usedBytes as number;
    expect(await used(ana.mailboxId)).toBeGreaterThanOrEqual(3000000);
    expect(await used("mbx_second")).toBeLessThan(3000000);
  });
});

describe("outbound mail and delivery rules", () => {
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
  /** Runs the undo window out and returns the raw messages handed to the sending binding. */
  const dispatch = async (h: Harness, mailboxId: string): Promise<Array<string>> => {
    const before = h.sent.length;
    vi.setSystemTime(Date.now() + 60_000);
    await h.namespaces.MAILBOXES.instance(mailboxId).alarm();
    await h.drain();
    return h.sent.slice(before).map((m) => m.raw);
  };

  let h: Harness;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2026, 8, 25, 12));
    h = makeHarness();
    enablePersonalMail(h);
  });
  afterEach(() => vi.useRealTimers());

  it("[E20] sent mail stores its normalized body and sends composer cid: images as inline parts", async () => {
    const ana = await signup(h, "ana@bye.test");
    await command(h, ana, { _tag: "AddIdentity", address: "ana@bye.test", kind: "hosted" });
    const upload = async (filename: string, contentType: string, content: string) => {
      const reserve = await call(h, ana, "POST", "/v1/uploads", {
        json: {
          mailboxId: ana.mailboxId,
          commandId: cmdId(),
          filename,
          contentType,
          declaredSize: content.length,
        },
      });
      const { uploadId } = reserve.body;
      await call(h, ana, "PUT", `/v1/uploads/${uploadId}/parts/1?mailbox=${ana.mailboxId}`, {
        body: content,
        headers: { "content-length": String(content.length) },
      });
      await call(h, ana, "POST", `/v1/uploads/${uploadId}/complete`, {
        json: { mailboxId: ana.mailboxId, commandId: cmdId() },
      });
      return uploadId as string;
    };
    const image = await upload("dot.png", "image/png", "PNG-bytes");
    const doc = await upload("notes.txt", "text/plain", "plain notes");
    await h.drain();
    // Raw-body writes (upload parts) are audited like every other API write (X02).
    const audited = await h.d1
      .prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'api.put' AND actor_id = ?")
      .bind(ana.userId)
      .first<{ n: number }>();
    expect(audited?.n).toBe(2);

    const draft = await call(h, ana, "POST", "/v1/drafts", {
      json: {
        mailboxId: ana.mailboxId,
        commandId: cmdId(),
        content: {
          to: [{ address: "bob@example.net" }],
          cc: [],
          bcc: [],
          subject: "Pic",
          text: "see picture",
          html: `<p>see <img src="cid:${image}" alt="dot"></p>`,
          attachments: [image, doc],
        },
      },
    });
    const sent = await call(h, ana, "POST", `/v1/drafts/${draft.body.draftId}/send`, {
      json: { mailboxId: ana.mailboxId, commandId: cmdId(), revision: draft.body.revision },
    });
    expect(sent.status).toBe(202);
    expect(await dispatch(h, ana.mailboxId)).toHaveLength(1);

    const job = await h.namespaces.MAILBOXES.instance(ana.mailboxId).sendJob(
      sent.body.sendJobIds[0],
    );
    expect(job?.state).toBe("accepted");
    const mime = new TextDecoder().decode(h.buckets.ORIGINALS.objects.get(job!.contentKey)!.bytes);
    expect(mime).toContain("multipart/related");
    expect(mime).toContain(`Content-ID: <${image}>`);
    expect(mime).toMatch(/Content-Disposition: inline/);
    expect(mime).toMatch(/Content-Disposition: attachment; filename="?notes\.txt/);

    const body = JSON.parse(
      new TextDecoder().decode(h.buckets.PARTS.objects.get(bodyKeyFor(job!.contentKey))!.bytes),
    ) as { text: string; html: string | null };
    expect(body.text).toContain("see picture");
    expect((body as { inline?: Record<string, string> }).inline).toEqual({
      [image]: blobKey.upload(ana.mailboxId, image),
    });
    expect(body.html).toContain("see");
  });

  it("[§10] transactional mail (verification codes) obeys sending suspensions", async () => {
    const ana = await signup(h, "ana@bye.test");
    await command(h, ana, { _tag: "AddIdentity", address: "ana@bye.test", kind: "hosted" });
    await new SendingPolicy(h.env.DIRECTORY, kernelClock).suspend(
      "user",
      ana.userId,
      "abuse review",
      "usr_operator",
    );
    const before = h.sent.length;
    const added = await command(h, ana, {
      _tag: "AddForwardingDestination",
      address: "victim@example.net",
    });
    expect(added.status).toBe(200);
    const submitted = await dispatch(h, ana.mailboxId);
    expect(submitted).toEqual([]);
    expect(h.sent.length).toBe(before);
  });

  it("[E23] an invalid quiet-hours zone is refused, and a bad stored zone never blocks delivery", async () => {
    const ana = await signup(h, "ana@bye.test");
    const bad = await command(h, ana, {
      _tag: "SetNotificationSettings",
      quietHours: { start: "22:00", end: "07:00", timeZone: "Mars/Olympus" },
      devices: {},
    });
    expect(bad.status).toBe(400);
    // Simulate a value stored before validation existed.
    const store = (
      h.namespaces.MAILBOXES.instance(ana.mailboxId) as unknown as {
        store: { ctx: { putSetting(k: string, v: unknown): void } };
      }
    ).store;
    store.ctx.putSetting("notifications", {
      quietHours: { start: "22:00", end: "07:00", timeZone: "Mars/Olympus" },
      devices: {},
    });
    await command(h, ana, {
      _tag: "SetPolicy",
      kind: "domain",
      subject: "example.net",
      policy: {
        decision: "allowed",
        destination: "imbox",
        labels: [],
        bundle: false,
        notify: true,
      },
    });
    await handleInbound(
      inboundMessage(
        "bob@example.net",
        "ana@bye.test",
        rfc822({
          from: "bob@example.net",
          to: "ana@bye.test",
          subject: "Still arrives",
          body: "hi",
          messageId: "qh-1@example.net",
        }),
      ),
      h.env,
    );
    await h.drain();
    const imbox = await call(h, ana, "GET", `/v1/mailboxes/${ana.mailboxId}/views/imbox`);
    expect(JSON.stringify(imbox.body)).toContain("Still arrives");
  });

  it("[E12] screened mail is never enrolled on a workflow board by address", async () => {
    const ana = await signup(h, "ana@bye.test");
    const board = await command(h, ana, {
      _tag: "CreateBoard",
      name: "Hiring",
      stages: ["New"],
      enrollAddress: "ana@bye.test",
    });
    expect(board.status).toBe(200);
    // Unknown sender → Screener.
    await handleInbound(
      inboundMessage(
        "stranger@example.org",
        "ana@bye.test",
        rfc822({
          from: "stranger@example.org",
          to: "ana@bye.test",
          subject: "Screen me",
          body: "hi",
          messageId: "scr-1@example.org",
        }),
      ),
      h.env,
    );
    await h.drain();
    const cards = h.namespaces.MAILBOXES.instance(ana.mailboxId) as unknown as {
      store: { ctx: { sql: { all<T>(q: string): Array<T> } } };
    };
    expect(
      cards.store.ctx.sql.all<{ thread_id: string }>("SELECT thread_id FROM workflow_cards"),
    ).toEqual([]);
  });
});

describe("message rendering, search and redelivery", () => {
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

  const PNG_B64 = btoa(
    String.fromCharCode(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4),
  );
  const newsletter = (messageId: string) =>
    [
      "Authentication-Results: mx.cloudflare.net; spf=pass; dkim=pass; dmarc=pass",
      "From: news@example.net",
      "To: ana@bye.test",
      "Subject: Weekly",
      "Date: Fri, 25 Sep 2026 12:00:00 +0000",
      `Message-ID: <${messageId}>`,
      "MIME-Version: 1.0",
      'Content-Type: multipart/related; boundary="rel"',
      "",
      "--rel",
      "Content-Type: text/html; charset=utf-8",
      "",
      '<p>Hero <img src="https://cdn.example.net/hero.png" alt="hero"> logo <img src="cid:logo@x" alt="logo"></p>',
      "--rel",
      "Content-Type: image/png",
      "Content-Transfer-Encoding: base64",
      "Content-ID: <logo@x>",
      "Content-Disposition: inline",
      "",
      PNG_B64,
      "--rel--",
      "",
    ].join("\r\n");

  const renderDoc = async (ana: Account) => {
    const imbox = await call(h, ana, "GET", `/v1/mailboxes/${ana.mailboxId}/views/imbox`);
    const thread = await call(
      h,
      ana,
      "GET",
      `/v1/mailboxes/${ana.mailboxId}/threads/${imbox.body.items[0].threadId}`,
    );
    return (await handleFetch(new Request(thread.body.deliveries[0].renderUrl), h.env, ctx)).text();
  };

  it("[E23] remote images are proxied (or blocked by preference) and inline cid: images are served at render", async () => {
    const ana = await signup(h, "ana@bye.test");
    await command(h, ana, {
      _tag: "SetPolicy",
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
      inboundMessage("news@example.net", "ana@bye.test", newsletter("nl1@example.net")),
      h.env,
    );
    await h.drain();

    const doc = await renderDoc(ana);
    expect(doc).toContain(`${h.env.MAIL_ORIGIN}/img?u=`);
    const inlineUrl = /src="([^"]*\/render\/inline\.[^"]+)"/.exec(doc)?.[1]?.replace(/&amp;/g, "&");
    expect(inlineUrl).toBeDefined();
    const image = await handleFetch(new Request(inlineUrl!), h.env, ctx);
    expect(image.status).toBe(200);
    expect(image.headers.get("content-type")).toBe("image/png");
    expect(image.headers.get("x-content-type-options")).toBe("nosniff");
    // A tampered token (another key) is refused.
    expect(
      (await handleFetch(new Request(inlineUrl!.replace(/\.[^.]+$/, ".forged")), h.env, ctx))
        .status,
    ).toBe(403);

    await command(h, ana, { _tag: "SetPreference", key: "remoteImages", value: "off" });
    const blocked = await renderDoc(ana);
    expect(blocked).not.toContain("/img?u=");
    expect(blocked).not.toContain("cdn.example.net");
    expect(blocked).toContain("/render/inline."); // inline parts are part of the message, not remote
  });

  it("[X02] plain-text bodies convert HTML-only mail and stay inside the owner's mailbox", async () => {
    const ana = await signup(h, "ana@bye.test");
    const bob = await signup(h, "bob@bye.test");
    await command(h, ana, {
      _tag: "SetPolicy",
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
      inboundMessage("news@example.net", "ana@bye.test", newsletter("txt1@example.net")),
      h.env,
    );
    await h.drain();
    const imbox = await call(h, ana, "GET", `/v1/mailboxes/${ana.mailboxId}/views/imbox`);
    const thread = await call(
      h,
      ana,
      "GET",
      `/v1/mailboxes/${ana.mailboxId}/threads/${imbox.body.items[0].threadId}`,
    );
    const deliveryId = thread.body.deliveries[0].deliveryId;
    const path = `/v1/mailboxes/${ana.mailboxId}/deliveries/${deliveryId}/text`;
    const text = await call(h, ana, "GET", path);
    expect(text.status).toBe(200);
    expect(text.body).toMatchObject({
      deliveryId,
      source: "html",
      hasHtml: true,
      truncated: false,
    });
    expect(text.body.text).toContain("Hero");
    expect(text.body.text).not.toContain("<p>");
    expect((await call(h, bob, "GET", path)).status).toBe(403);
    expect(
      (await call(h, ana, "GET", `/v1/mailboxes/${ana.mailboxId}/deliveries/dlv_missing/text`))
        .status,
    ).toBe(404);
    // A purged body is reported, not shown as an empty message.
    for (const key of h.buckets.PARTS.objects.keys())
      if (key.includes("/body/")) h.buckets.PARTS.objects.delete(key);
    const purged = await call(h, ana, "GET", path);
    expect(purged.status).toBe(404);
    expect(purged.body.error.code).toBe("not_found");
  });

  it("[§11] Redeliver from someone else's mailbox is refused without revealing the delivery", async () => {
    const ana = await signup(h, "ana@bye.test");
    const bob = await signup(h, "bob@bye.test");
    await command(h, ana, {
      _tag: "SetPolicy",
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
      inboundMessage("news@example.net", "ana@bye.test", newsletter("nl2@example.net")),
      h.env,
    );
    await h.drain();
    const imbox = await call(h, ana, "GET", `/v1/mailboxes/${ana.mailboxId}/views/imbox`);
    const thread = await call(
      h,
      ana,
      "GET",
      `/v1/mailboxes/${ana.mailboxId}/threads/${imbox.body.items[0].threadId}`,
    );
    const probe = async (deliveryId: string) =>
      call(h, bob, "POST", `/v1/mailboxes/${ana.mailboxId}/commands`, {
        json: {
          commandId: cmdId(),
          _tag: "Redeliver",
          targetMailboxId: bob.mailboxId,
          deliveryId,
          mode: "copy",
        },
      });
    const real = await probe(thread.body.deliveries[0].deliveryId);
    const fake = await probe("dlv_does_not_exist");
    expect(real.status).toBe(403);
    expect(fake.status).toBe(403);
    expect(real.body.error.code).toBe(fake.body.error.code);
    expect(real.body.error.message).toBe(fake.body.error.message);
    expect(JSON.stringify(real.body)).not.toMatch(/scan|quarantine/i);
  });

  it("[E21] the search cursor comes from the de-duplicated page", async () => {
    const c = (docId: string, date: number) => ({
      docId,
      kind: "delivery",
      refId: docId,
      threadId: null,
      date,
      version: 1,
    });
    const pages = [
      { candidates: [c("a", 3), c("b", 2)], nextCursor: null, watermark: 1 },
      { candidates: [c("a", 3), c("c", 1)], nextCursor: null, watermark: 1 },
    ];
    const page = await authorizeSearchResults(pages, async (cs) => cs.map((x) => x.docId), 2);
    expect(page.results).toEqual(["a", "b"]);
    expect(page.last?.docId).toBe("b");
    expect(page.more).toBe(true);
  });
});

describe("unified view, uploads and threading", () => {
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

  /** Run due mailbox jobs and queues with the provider transport mocked; returns submitted bodies. */

  let h: Harness;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2026, 8, 25, 12));
    h = makeHarness();
  });
  afterEach(() => vi.useRealTimers());

  const allow = (a: Account, mailboxId = a.mailboxId) =>
    call(h, a, "POST", `/v1/mailboxes/${mailboxId}/commands`, {
      json: {
        commandId: cmdId(),
        _tag: "SetPolicy",
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
  const receive = async (
    from: string,
    to: string,
    subject: string,
    messageId: string,
    extra = "",
  ) => {
    const raw = rfc822({
      from,
      to,
      subject,
      body: "hi",
      messageId,
      ...(extra ? { extraHeaders: extra } : {}),
    });
    const outcome = await handleInbound(inboundMessage(from, to, raw), h.env);
    await h.drain();
    return outcome;
  };

  it("[E19] the unified view returns exactly `limit` items per page, newest first across mailboxes, without skipping", async () => {
    const ana = await signup(h, "ana@bye.test");
    const org = (await h.d1
      .prepare("SELECT org_id FROM mailboxes WHERE id = ?")
      .bind(ana.mailboxId)
      .first<{ org_id: string }>())!.org_id;
    await h.d1
      .prepare(
        "INSERT INTO mailboxes (id, org_id, owner_user_id, kind, created_at) VALUES ('mbx_team', ?, NULL, 'extension', ?)",
      )
      .bind(org, Date.now())
      .run();
    await h.d1
      .prepare(
        "INSERT INTO mailbox_access (mailbox_id, user_id, role, can_send, created_at) VALUES ('mbx_team', ?, 'owner', 1, ?)",
      )
      .bind(ana.userId, Date.now())
      .run();
    await h.d1
      .prepare(
        "INSERT INTO address_routes (address, domain, mailbox_id, kind, created_at) VALUES ('team@bye.test', 'bye.test', 'mbx_team', 'alias', ?)",
      )
      .bind(Date.now())
      .run();
    await allow(ana);
    await allow(ana, "mbx_team");
    const day = 86400_000;
    const start = Date.now();
    for (const [i, to] of [
      [1, "ana@bye.test"],
      [2, "ana@bye.test"],
      [3, "ana@bye.test"],
      [10, "team@bye.test"],
      [11, "team@bye.test"],
      [12, "team@bye.test"],
    ] as const) {
      vi.setSystemTime(start + i * day);
      await receive("news@example.net", to, `Day ${i}`, `d${i}@example.net`);
    }
    const seen: Array<string> = [];
    let cursor: string | null = null;
    for (let pageNo = 0; pageNo < 5; pageNo++) {
      const page: { status: number; body: any } = await call(
        h,
        ana,
        "GET",
        `/v1/unified/views/imbox?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      expect(page.status).toBe(200);
      expect(page.body.items.length).toBeLessThanOrEqual(2);
      seen.push(...page.body.items.map((i: { thread: { subject: string } }) => i.thread.subject));
      cursor = page.body.cursor;
      if (!cursor) break;
    }
    expect(seen).toEqual(["Day 12", "Day 11", "Day 10", "Day 3", "Day 2", "Day 1"]);
  });

  it("[E20] empty files upload and complete", async () => {
    const ana = await signup(h, "ana@bye.test");
    const reserve = await call(h, ana, "POST", "/v1/uploads", {
      json: {
        mailboxId: ana.mailboxId,
        commandId: cmdId(),
        filename: "empty.txt",
        contentType: "text/plain",
        declaredSize: 0,
      },
    });
    expect(reserve.status).toBe(201);
    const done = await call(h, ana, "POST", `/v1/uploads/${reserve.body.uploadId}/complete`, {
      json: { mailboxId: ana.mailboxId, commandId: cmdId() },
    });
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ state: "complete", actualSize: 0 });
  });

  it("[E11] a Message-ID reference only joins a thread for someone already in it", async () => {
    const ana = await signup(h, "ana@bye.test");
    await allow(ana);
    await receive("bob@example.net", "ana@bye.test", "Private plan", "plan-1@example.net");
    await receive(
      "carol@example.net",
      "ana@bye.test",
      "Re: Private plan",
      "spliced@example.net",
      "In-Reply-To: <plan-1@example.net>",
    );
    await receive(
      "bob@example.net",
      "ana@bye.test",
      "Re: Private plan",
      "plan-2@example.net",
      "In-Reply-To: <plan-1@example.net>",
    );
    const imbox = await call(h, ana, "GET", `/v1/mailboxes/${ana.mailboxId}/views/imbox`);
    const threads = imbox.body.items as Array<{ threadId: string; subject: string }>;
    expect(threads).toHaveLength(2);
    const counts = await Promise.all(
      threads.map(async (t) =>
        (
          await call(h, ana, "GET", `/v1/mailboxes/${ana.mailboxId}/threads/${t.threadId}`)
        ).body.deliveries.map((d: { from: { address: string } }) => d.from.address),
      ),
    );
    expect(counts.map((c: Array<string>) => c.sort().join(",")).sort()).toEqual([
      "bob@example.net,bob@example.net",
      "carol@example.net",
    ]);
  });
});
