import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ControlAuth,
  ControlDirectory,
  Kernel,
  KERNEL_MIGRATIONS,
  migrate,
  outboxToQueueMessage,
  Sql,
} from "@bye/platform-cloudflare";
import { MemoryDurableStorage, TestClock } from "@bye/testing";
import { handleFetch } from "../src/api.ts";
import { handleQueueMessage } from "../src/consumers.ts";
import { kernelClock } from "../src/durable-host.ts";
import { FORWARD_MAX_HOPS, forwardHops, handleInbound } from "../src/inbound.ts";
import { MIME_INLINE_MAX_BYTES } from "../src/mime.ts";
import { quarantineUnprocessable } from "../src/scheduled.ts";
import { authConfig } from "../src/services.ts";
import {
  type Harness,
  inboundMessage,
  makeHarness,
  rfc822,
  enablePersonalMail,
} from "./harness.ts";
import { blobKey } from "@bye/application";
import { safetyVerdict, trustedAuthenticationResults } from "../src/safety.ts";

// Exceptional ingestion (§5.1 step 5, §6 row 7) and provider send evidence (§5.2).

(globalThis as { FixedLengthStream?: unknown }).FixedLengthStream = class extends TransformStream {
  constructor(_length: number) {
    super();
  }
};

const ctx = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
} as unknown as ExecutionContext;

const signup = async (h: Harness, address: string) => {
  const account = await new ControlDirectory(h.env.DIRECTORY, kernelClock).provisionPersonalAccount(
    { address, displayName: "ana" },
  );
  await h.env.CALENDARS.getByName(account.calendarId).provision({
    ownerId: account.userId,
    selfAddresses: [account.address],
    defaultZone: "UTC",
  });
  const session = await new ControlAuth(
    h.env.DIRECTORY,
    kernelClock,
    await authConfig(h.env),
  ).issueSession(account.userId, "test", true);
  return { ...account, cookie: `__Host-session=${session.token}` };
};

const call = async (h: Harness, cookie: string, method: string, path: string, body?: unknown) => {
  const r = await handleFetch(
    new Request(`${h.env.APP_ORIGIN}${path}`, {
      method,
      headers: {
        cookie,
        ...(method === "GET"
          ? {}
          : { origin: h.env.APP_ORIGIN, "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    h.env,
    ctx,
  );
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : null };
};

let n = 0;
const cmdId = () => `cmd_${(++n).toString(36).padStart(20, "0")}`;

describe("exceptional ingestion and send evidence", () => {
  let h: Harness;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2026, 8, 25, 12));
    h = makeHarness();
  });
  afterEach(() => vi.useRealTimers());

  it("[§5.1] messages above the inline limit are parsed by the MIME container via ParseScan", async () => {
    const ana = await signup(h, "ana@bye.test");
    const attachment = Buffer.alloc(MIME_INLINE_MAX_BYTES, 7)
      .toString("base64")
      .replace(/.{76}/g, "$&\r\n");
    const raw = rfc822({
      from: "big@example.net",
      to: "ana@bye.test",
      subject: "Huge",
      messageId: "huge-1@example.net",
      body: "",
      extraHeaders: "X-Test: 1",
    }).replace(
      "Content-Type: text/plain; charset=utf-8\r\n\r\n",
      `Content-Type: multipart/mixed; boundary="b1"\r\n\r\n--b1\r\nContent-Type: text/plain\r\n\r\nsee attached\r\n--b1\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename="blob.bin"\r\nContent-Transfer-Encoding: base64\r\n\r\n${attachment}\r\n--b1--\r\n`,
    );
    const outcome = await handleInbound(
      inboundMessage("big@example.net", "ana@bye.test", raw),
      h.env,
    );
    expect(outcome._tag).not.toBe("Rejected");
    await h.drain();
    expect(h.mime.parsed).toBe(1);
    const screener = await call(
      h,
      ana.cookie,
      "GET",
      `/v1/mailboxes/${ana.mailboxId}/views/screener`,
    );
    expect(JSON.stringify(screener.body)).toContain("big@example.net");
    const parts = [...h.buckets.PARTS.objects.keys()].filter((k) => k.includes("/part/"));
    expect(parts).toHaveLength(1);
    expect(h.buckets.PARTS.objects.get(parts[0]!)!.bytes.byteLength).toBe(MIME_INLINE_MAX_BYTES);
  });

  it("[§6] poison MIME after replay exhaustion commits a quarantined placeholder that keeps the original", async () => {
    const ana = await signup(h, "ana@bye.test");
    const key = `t/${ana.mailboxId}/orig/ing_poison.eml`;
    await h.buckets.ORIGINALS.put(key, "\u0000garbage");
    await quarantineUnprocessable(h.env, {
      ingestionId: "ing_poison",
      mailboxId: ana.mailboxId,
      recipient: "ana@bye.test",
      envelopeFrom: "bad@example.net",
      objectKey: key,
      rawSize: 8,
      receivedAt: Date.now(),
    });
    await h.drain(20, { tolerateRetries: true });
    // Idempotent per ingestion ID.
    await quarantineUnprocessable(h.env, {
      ingestionId: "ing_poison",
      mailboxId: ana.mailboxId,
      recipient: "ana@bye.test",
      envelopeFrom: "bad@example.net",
      objectKey: key,
      rawSize: 8,
      receivedAt: Date.now(),
    });
    const views = await Promise.all(
      ["imbox", "screener", "spam"].map((v) =>
        call(h, ana.cookie, "GET", `/v1/mailboxes/${ana.mailboxId}/views/${v}`),
      ),
    );
    expect(views.flatMap((v) => v.body.items)).toHaveLength(1);
    expect(views[2]!.body.items[0]).toMatchObject({
      subject: "(message could not be processed)",
      disposition: "spam",
      quarantined: true,
    });
    expect(h.buckets.ORIGINALS.objects.has(key)).toBe(true);
  });

  it("[§5.2] an Unknown submission is resolved when a provider event echoes its idempotency key", async () => {
    enablePersonalMail(h);
    const realFetch = globalThis.fetch;
    // The connection drops after the request left: the provider may have accepted it — Unknown.
    (h.env as { TRANSACTIONAL_EMAIL: unknown }).TRANSACTIONAL_EMAIL = {
      send: async () => {
        throw new Error("connection reset");
      },
    };
    try {
      const ana = await signup(h, "ana@bye.test");
      await call(h, ana.cookie, "POST", `/v1/mailboxes/${ana.mailboxId}/commands`, {
        _tag: "AddIdentity",
        commandId: cmdId(),
        address: "ana@bye.test",
        kind: "hosted",
      });
      const draft = await call(h, ana.cookie, "POST", "/v1/drafts", {
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
      });
      const send = await call(h, ana.cookie, "POST", `/v1/drafts/${draft.body.draftId}/send`, {
        mailboxId: ana.mailboxId,
        commandId: cmdId(),
        revision: draft.body.revision,
      });
      vi.setSystemTime(Date.now() + 60_000);
      const mailbox = h.namespaces.MAILBOXES.instance(ana.mailboxId);
      await mailbox.alarm();
      await h.drain(20, { tolerateRetries: true });
      const sendJobId = send.body.sendJobIds[0] as string;
      expect((await mailbox.sendJob(sendJobId))?.state).toBe("unknown");
      const unknown = await h.env.DIRECTORY.prepare(
        "SELECT resolved_at FROM send_unknowns WHERE send_job_id = ?",
      )
        .bind(sendJobId)
        .first<{ resolved_at: number | null }>();
      expect(unknown).toEqual({ resolved_at: null });

      await handleQueueMessage(h.env, {
        type: "email.delivered",
        messageId: "prov-9",
        recipient: "bob@example.net",
        idempotencyKey: sendJobId,
      });
      expect((await mailbox.sendJob(sendJobId))?.state).toBe("accepted");
      const resolved = await h.env.DIRECTORY.prepare(
        "SELECT resolution FROM send_unknowns WHERE send_job_id = ?",
      )
        .bind(sendJobId)
        .first<{ resolution: string }>();
      expect(resolved?.resolution).toBe("accepted-by-event");
      // Unrelated events are ignored, not errors.
      await handleQueueMessage(h.env, {
        type: "email.bounced",
        messageId: "other",
        recipient: "x@example.net",
      });
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("[E19] external send-as credentials need send scope, step-up, a sealing key and public https endpoints", async () => {
    const ana = await signup(h, "ana@bye.test");
    const path = `/v1/mailboxes/${ana.mailboxId}/external-identities/ana%40example.org`;
    const r = await call(h, ana.cookie, "PUT", path, {
      provider: "http",
      endpoint: "https://relay.example.org/send",
      apiKey: "k",
    });
    // issueSession(..., true) marks the session stepped-up; without a sealing key the feature is off.
    expect(r.status).toBe(409);
    (h.env as { EXTERNAL_IDENTITY_SEAL_KEY: string }).EXTERNAL_IDENTITY_SEAL_KEY = Buffer.alloc(
      32,
      1,
    ).toString("base64url");
    expect(
      (
        await call(h, ana.cookie, "PUT", path, {
          provider: "http",
          endpoint: "https://10.0.0.1/send",
          apiKey: "k",
        })
      ).status,
    ).toBe(400);
    expect((await call(h, ana.cookie, "PUT", path, { provider: "gmail" })).status).toBe(400);
    expect(
      (
        await call(h, ana.cookie, "PUT", path, {
          provider: "http",
          endpoint: "https://relay.example.org/send",
          apiKey: "k",
        })
      ).status,
    ).toBe(200);
    const row = await h.env.DIRECTORY.prepare(
      "SELECT provider, ciphertext FROM external_identity_credentials WHERE address = 'ana@example.org'",
    ).first<{ provider: string; ciphertext: string }>();
    expect(row?.provider).toBe("http");
    expect(row?.ciphertext).not.toContain('k"');
    const other = await signup(h, "bob@bye.test");
    expect(
      (
        await call(h, other.cookie, "PUT", path, {
          provider: "http",
          endpoint: "https://relay.example.org/send",
          apiKey: "k",
        })
      ).status,
    ).toBe(403);
  });
});

describe("propagate payloads", () => {
  let h: Harness;
  const kv = new Map<string, string>();
  beforeEach(() => {
    h = makeHarness();
    kv.clear();
    (h.env as { CONFIG_CACHE: unknown }).CONFIG_CACHE = {
      get: async (k: string) => kv.get(k) ?? null,
      put: async (k: string, v: string) => void kv.set(k, v),
    };
  });
  const probe = (payload: unknown, topic = "probe.echo") =>
    handleQueueMessage(h.env, {
      schemaVersion: 1,
      type: "propagate",
      eventId: `e-${Math.random()}`,
      topic,
      source: "probe",
      target: "t",
      payload,
    });
  const marker = (id: string) => h.env.CONFIG_CACHE.get(`probe:queue:${id}`);

  it("[§3.2] decode leniently: v1 payloads without their own topic use the envelope topic; the payload's topic wins", async () => {
    await probe({ probeId: "abcdefgh01" });
    expect(await marker("abcdefgh01")).not.toBeNull();
    await probe({ topic: "probe.echo", probeId: "abcdefgh02" }, "something.else");
    expect(await marker("abcdefgh02")).not.toBeNull();
  });

  it("[§3.2] a payload that doesn't match its topic's schema, or an unknown topic, is dropped without running a handler", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(probe({ probeId: 12345678 })).resolves.toBeUndefined();
    await expect(probe({ probeId: "abcdefgh03" }, "no.such.topic")).resolves.toBeUndefined();
    expect(await marker("abcdefgh03")).toBeNull();
    const ops = warn.mock.calls.map((c) => JSON.parse(String(c[0])).op);
    expect(ops).toEqual(
      expect.arrayContaining(["propagate.invalid-payload", "propagate.unknown-topic"]),
    );
    warn.mockRestore();
  });

  it("[§3.2] a typed Kernel.emit event relays through the outbox mapping and dispatches to its handler", async () => {
    const sql = new Sql(new MemoryDurableStorage());
    migrate(sql, "kernel", KERNEL_MIGRATIONS);
    const kernel = new Kernel(sql, new TestClock());
    kernel.emit("probe.echo", "t", { probeId: "abcdefgh04" });
    const [event] = kernel.pendingOutbox(10);
    const message = outboxToQueueMessage("probe", event!);
    expect(message.queue).toBe("propagate");
    await handleQueueMessage(h.env, message.body);
    expect(await marker("abcdefgh04")).not.toBeNull();
  });
});

describe("authentication evidence", () => {
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
    enablePersonalMail(h);
  });
  afterEach(() => vi.useRealTimers());

  it("[§5.1] Authentication-Results below an earlier hop's Received header are never trusted", () => {
    const forged: Array<[string, string]> = [
      ["Received", "from mx.cloudflare.net by edge"],
      ["Received", "from attacker.example by relay"],
      ["Authentication-Results", "mx.cloudflare.net; spf=pass; dkim=pass; dmarc=pass"],
    ];
    expect(trustedAuthenticationResults(forged as never)).toBeUndefined();
    const ours: Array<[string, string]> = [
      ["Received", "from mx.cloudflare.net by edge"],
      ["Authentication-Results", "mx.cloudflare.net; spf=pass; dkim=pass; dmarc=fail"],
      ["Received", "from sender.example by relay"],
    ];
    expect(trustedAuthenticationResults(ours as never)?.dmarc).toBe("fail");
  });

  it("[§10] method results are read only at the start of a resinfo, never inside property values", () => {
    const ar = (value: string) =>
      trustedAuthenticationResults([["Authentication-Results", value]] as never);
    const echoed = ar(
      "mx.cloudflare.net; dkim=neutral header.d=bank.example header.b=dmarc=pa; dmarc=fail header.from=bank.example",
    );
    expect(echoed?.dkim).toBe("neutral");
    expect(echoed?.dmarc).toBe("fail");
    const commented = ar(
      "mx.cloudflare.net; spf=pass (dmarc=pass; x) smtp.mailfrom=a@b.example; dmarc=fail header.from=b.example",
    );
    expect(commented?.dmarc).toBe("fail");
    const quoted = ar('mx.cloudflare.net; dkim=pass header.i="x; dmarc=pass"; dmarc=fail');
    expect(quoted?.dmarc).toBe("fail");
    // Duplicate dmarc resinfo or an unbalanced value is ambiguous and fails closed.
    expect(ar("mx.cloudflare.net; dmarc=pass; dmarc=fail")?.dmarc).toBe("fail");
    expect(ar("mx.cloudflare.net; dmarc=pass header.from=a.example; dmarc=pass")?.dmarc).toBe(
      "fail",
    );
    expect(ar("mx.cloudflare.net; dkim=pass (unterminated; dmarc=pass")?.dmarc).toBe("fail");
    expect(
      ar(
        "mx.cloudflare.net; spf=pass smtp.mailfrom=a.example; dkim=pass header.b=YWJj==; dmarc=pass header.from=A.example",
      ),
    ).toEqual({ spf: "pass", dkim: "pass", dmarc: "pass", headerFrom: "a.example" });
  });

  it("[A04] closure-forward hop counter cannot be lowered by a sender-supplied value", () => {
    const hops = (...values: Array<string>) => {
      const h = new Headers();
      for (const v of values) h.append("X-Bye-Loop", v);
      return forwardHops(h);
    };
    expect(forwardHops(undefined)).toBe(0);
    expect(hops("-1000000000")).toBe(0);
    expect(hops("-1000000000", String(FORWARD_MAX_HOPS))).toBe(FORWARD_MAX_HOPS);
    expect(hops("abc", "2", "1")).toBe(2);
    expect(hops("3x")).toBe(0);
  });

  it("[§10] the From used for sender policy must be the one DMARC authenticated", () => {
    const verdict = (headers: Array<[string, string]>) =>
      safetyVerdict({ headers, attachments: [], truncated: false } as never)._tag;
    const ar = (from: string): [string, string] => [
      "Authentication-Results",
      `mx.cloudflare.net; spf=pass smtp.mailfrom=${from}; dmarc=pass header.from=${from}`,
    ];
    expect(verdict([ar("attacker.example"), ["From", "Bank <ceo@bank.example>"]])).toBe("Spoofed");
    expect(verdict([ar("bank.example"), ["From", "Bank <ceo@bank.example>"]])).toBe("Clean");
    // Two From headers (e.g. `From :` plus `From:`) let the MTA and our parser pick different ones.
    expect(
      verdict([
        ar("attacker.example"),
        ["From", "ceo@bank.example"],
        ["From", "me@attacker.example"],
      ]),
    ).toBe("Spoofed");
    expect(verdict([ar("bank.example")])).toBe("Spoofed");
    // No header.from to bind against keeps the existing behaviour.
    expect(
      verdict([
        ["Authentication-Results", "mx.cloudflare.net; spf=pass; dkim=pass; dmarc=pass"],
        ["From", "ceo@bank.example"],
      ]),
    ).toBe("Clean");
  });
});

describe("ingest storage accounting", () => {
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

  it("[§12] the daily usage sweep recomputes drifted totals from R2 and never overwrites a concurrent delta", async () => {
    const ana = await signup(h, "ana@bye.test");
    await allow(ana);
    await receive("news@example.net", "ana@bye.test", "Drift", "drift@example.net");
    const rows = () =>
      h.d1
        .prepare("SELECT category, bytes FROM storage_usage WHERE owner_id = ? ORDER BY category")
        .bind(ana.mailboxId)
        .all<{ category: string; bytes: number }>()
        .then((r) => r.results);
    const truth = await rows();
    expect(truth.length).toBeGreaterThan(0);
    // Drift: a raced head→put→record counted twice, and a swallowed D1 failure lost a row.
    await h.d1
      .prepare("UPDATE storage_usage SET bytes = bytes * 2 + 7, updated_at = 1 WHERE owner_id = ?")
      .bind(ana.mailboxId)
      .run();
    const { sweepUsage } = await import("../src/usage.ts");
    const swept = await sweepUsage(h.env, Date.now());
    expect(swept).toMatchObject({ owners: 1, failed: 0 });
    expect(swept.corrected).toBe(truth.length);
    expect(await rows()).toEqual(truth);
    // A second run finds nothing to correct.
    expect((await sweepUsage(h.env, Date.now() + 1)).corrected).toBe(0);
  });

  it("[§12] ingest retries don't double-count storage usage", async () => {
    const ana = await signup(h, "ana@bye.test");
    await allow(ana);
    const outcome = await receive("news@example.net", "ana@bye.test", "Once", "once@example.net");
    const usage = () =>
      h.d1
        .prepare("SELECT SUM(bytes) AS n FROM storage_usage WHERE owner_id = ?")
        .bind(ana.mailboxId)
        .first<{ n: number }>()
        .then((r) => r?.n ?? 0);
    const before = await usage();
    expect(before).toBeGreaterThan(0);
    const ingestionId = (outcome as { ingestionId: string }).ingestionId;
    const { handleQueueMessage } = await import("../src/consumers.ts");
    await handleQueueMessage(h.env, {
      schemaVersion: 1,
      type: "ingest",
      eventId: `ingest:${ingestionId}`,
      ingestionId,
      mailboxId: ana.mailboxId,
      recipient: "ana@bye.test",
      envelopeFrom: "news@example.net",
      objectKey: blobKey.original(ana.mailboxId, ingestionId),
      rawSize: 10,
      receivedAt: Date.now(),
    } as never);
    expect(await usage()).toBe(before);
  });
});
