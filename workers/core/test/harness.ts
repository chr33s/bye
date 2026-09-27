import { createHash } from "node:crypto";
import { MemoryD1, MemoryDurableStorage } from "@bye/testing";
import { parseToLines } from "../../../containers/mime/src/parse.ts";
import { handleQueueBatch } from "../src/consumers.ts";
import type { CoreEnv } from "../src/env.ts";
import {
  CalendarDO,
  IngressJournalDO,
  MailboxDO,
  SearchShardDO,
  SharedSpaceDO,
} from "../src/objects.ts";

// In-memory bindings for exercising the real MailCore modules in Node: SQLite-backed Durable
// Objects (node:sqlite), R2 buckets, Queues with explicit draining, D1 with real migrations.
// It deliberately does not emulate RPC serialization or isolate boundaries.

class HarnessStorage extends MemoryDurableStorage {
  private readonly kvMap = new Map<string, unknown>();
  alarmAt: number | null = null;
  readonly kv = {
    get: <T>(key: string): T | undefined => this.kvMap.get(key) as T | undefined,
    put: (key: string, value: unknown) => void this.kvMap.set(key, value),
  };
  override async setAlarm(at: number) {
    this.alarmAt = at;
  }
  override async getAlarm() {
    return this.alarmAt;
  }
  override async deleteAlarm() {
    this.alarmAt = null;
  }
  async deleteAll() {
    this.kvMap.clear();
    const tables = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all() as Array<{ name: string }>;
    for (const t of tables) {
      try {
        this.db.exec(`DROP TABLE IF EXISTS "${t.name}"`);
      } catch {
        // virtual table shadow tables are dropped with their parent
      }
    }
  }
}

/** Minimal hibernatable socket shape the objects use. */
export interface HarnessSocket {
  send(data: string): void;
  close?(code?: number, reason?: string): void;
}

export class HarnessState {
  readonly storage = new HarnessStorage();
  readonly pending: Array<Promise<unknown>> = [];
  /** Rejections of `waitUntil` promises; `settle()` rethrows them so background failures fail tests. */
  readonly backgroundErrors: Array<unknown> = [];
  readonly sockets: Array<HarnessSocket> = [];
  private readonly socketTags = new WeakMap<HarnessSocket, ReadonlyArray<string>>();
  private gate: Promise<unknown> = Promise.resolve();
  constructor(readonly id: { name: string }) {}
  waitUntil(p: Promise<unknown>) {
    this.pending.push(p.catch((error) => void this.backgroundErrors.push(error)));
  }
  /** Serializes concurrent callers (later callers wait for earlier blocks), like the input gate. */
  blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.gate.then(fn, fn);
    this.gate = run.catch(() => undefined);
    return run;
  }
  /** Resolves once every `blockConcurrencyWhile` started so far has finished. */
  idle(): Promise<unknown> {
    return this.gate;
  }
  acceptWebSocket(ws: HarnessSocket, tags: ReadonlyArray<string> = []) {
    this.sockets.push(ws);
    this.socketTags.set(ws, [...tags]);
  }
  getWebSockets(tag?: string) {
    return tag === undefined
      ? [...this.sockets]
      : this.sockets.filter((ws) => this.socketTags.get(ws)?.includes(tag));
  }
  getTags(ws: HarnessSocket) {
    return [...(this.socketTags.get(ws) ?? [])];
  }
}

class Namespace<T> {
  readonly instances = new Map<string, { object: T; state: HarnessState }>();
  constructor(
    private readonly make: (state: HarnessState, env: CoreEnv) => T,
    private readonly envRef: () => CoreEnv,
  ) {}
  /** Direct access to the object (tests only). */
  instance(name: string): T {
    let entry = this.instances.get(name);
    if (!entry) {
      const state = new HarnessState({ name });
      entry = { object: this.make(state, this.envRef()), state };
      this.instances.set(name, entry);
    }
    return entry.object;
  }

  /** RPC-like stub: every call is async and results are structured-cloned, as over real RPC. */
  getByName(name: string): T {
    // Like a real stub, each call reaches the CURRENT instance (a new one after an abort/restart).
    return new Proxy({} as Record<string, unknown>, {
      get: (_obj, prop) => {
        const probe = (this.instance(name) as Record<string, unknown>)[prop as string];
        if (typeof probe !== "function") return probe;
        return async (...args: Array<unknown>) => {
          // Events are not delivered while the object is inside blockConcurrencyWhile.
          await this.instances.get(name)?.state.idle();
          const obj = this.instance(name) as Record<string, unknown>;
          const result = await (obj[prop as string] as (...a: Array<unknown>) => unknown).apply(
            obj,
            args.map((a) => (a instanceof Request ? a : structuredClone(a))),
          );
          return result instanceof Response
            ? result
            : result === undefined
              ? undefined
              : structuredClone(result);
        };
      },
    }) as T;
  }
  /** Direct access to an instance's state (tests only). */
  state(name: string): HarnessState {
    this.instance(name);
    return this.instances.get(name)!.state;
  }
  async settle() {
    for (const { state } of this.instances.values()) {
      await Promise.all(state.pending.splice(0));
      const errors = state.backgroundErrors.splice(0);
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1)
        throw new AggregateError(errors, `${errors.length} waitUntil rejections`);
    }
  }
}

export interface StoredObject {
  bytes: Uint8Array;
  httpMetadata: Record<string, string>;
  customMetadata: Record<string, string>;
  etag?: string;
  uploaded?: Date;
}

/** R2 etags for single-part objects are the MD5 hex of the bytes. */
export const md5Hex = (bytes: Uint8Array) => createHash("md5").update(bytes).digest("hex");

const toBytes = async (value: unknown): Promise<Uint8Array> => {
  if (typeof value === "string") return new TextEncoder().encode(value);
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (value && typeof (value as ReadableStream).getReader === "function")
    return new Uint8Array(await new Response(value as ReadableStream).arrayBuffer());
  throw new Error("unsupported body");
};

export class MemoryR2 {
  readonly objects = new Map<string, StoredObject>();
  private view(key: string, o: StoredObject) {
    const etag = o.etag ?? md5Hex(o.bytes);
    return {
      key,
      size: o.bytes.byteLength,
      etag,
      httpEtag: `"${etag}"`,
      uploaded: o.uploaded ?? new Date(0),
      httpMetadata: o.httpMetadata,
      customMetadata: o.customMetadata,
      get body() {
        return new Response(o.bytes).body!;
      },
      arrayBuffer: async () => o.bytes.slice().buffer,
      text: async () => new TextDecoder().decode(o.bytes),
      json: async () => JSON.parse(new TextDecoder().decode(o.bytes)),
    };
  }
  async put(
    key: string,
    value: unknown,
    options: {
      httpMetadata?: Record<string, string>;
      customMetadata?: Record<string, string>;
    } = {},
  ) {
    const bytes = await toBytes(value);
    this.objects.set(key, {
      bytes,
      httpMetadata: options.httpMetadata ?? {},
      customMetadata: options.customMetadata ?? {},
      etag: md5Hex(bytes),
      uploaded: new Date(),
    });
    return this.view(key, this.objects.get(key)!);
  }
  async get(key: string) {
    const o = this.objects.get(key);
    return o ? this.view(key, o) : null;
  }
  async head(key: string) {
    return this.get(key);
  }
  async delete(keys: string | Array<string>) {
    for (const k of Array.isArray(keys) ? keys : [keys]) this.objects.delete(k);
  }
  /**
   * Key-ordered listing with an opaque key-based cursor (the last key returned), so objects deleted
   * or added between pages do not shift later pages the way an offset would.
   */
  async list(options: { prefix?: string; limit?: number; cursor?: string } = {}) {
    const after = options.cursor
      ? Buffer.from(options.cursor, "base64url").toString("utf8")
      : undefined;
    const all = [...this.objects.keys()]
      .filter((k) => k.startsWith(options.prefix ?? "") && (after === undefined || k > after))
      .sort();
    const page = all.slice(0, options.limit ?? 1000);
    const truncated = page.length < all.length;
    return {
      objects: page.map((key) => this.view(key, this.objects.get(key)!)),
      truncated,
      cursor: truncated ? Buffer.from(page.at(-1)!, "utf8").toString("base64url") : undefined,
      delimitedPrefixes: [] as Array<string>,
    };
  }
  private readonly multipart = new Map<
    string,
    { key: string; parts: Array<Uint8Array>; options: { httpMetadata?: Record<string, string> } }
  >();
  async createMultipartUpload(
    key: string,
    options: { httpMetadata?: Record<string, string> } = {},
  ) {
    const uploadId = `mpu_${this.multipart.size + 1}`;
    this.multipart.set(uploadId, { key, parts: [], options });
    return this.resumeMultipartUpload(key, uploadId);
  }
  resumeMultipartUpload(key: string, uploadId: string) {
    const upload = () =>
      this.multipart.get(uploadId) ??
      (() => {
        throw new Error("no such multipart upload");
      })();
    return {
      key,
      uploadId,
      uploadPart: async (n: number, value: unknown) => {
        if (!Number.isInteger(n) || n < 1 || n > 10_000) throw new Error("invalid part number");
        const bytes = await toBytes(value);
        upload().parts[n - 1] = bytes;
        return { partNumber: n, etag: md5Hex(bytes) };
      },
      /** Assembles exactly the listed parts, in ascending order, each matching its uploaded etag. */
      complete: async (parts: ReadonlyArray<{ partNumber: number; etag: string }>) => {
        const u = upload();
        if (!Array.isArray(parts) || parts.length === 0)
          throw new Error("complete: parts list is required");
        const chunks = parts.map((p, i) => {
          if (i > 0 && p.partNumber <= parts[i - 1]!.partNumber)
            throw new Error("complete: parts must be in ascending order");
          const bytes = u.parts[p.partNumber - 1];
          if (!bytes) throw new Error(`complete: part ${p.partNumber} was not uploaded`);
          if (p.etag !== md5Hex(bytes))
            throw new Error(`complete: part ${p.partNumber} etag mismatch`);
          return bytes;
        });
        this.multipart.delete(uploadId);
        const stored = await this.put(key, new Uint8Array(Buffer.concat(chunks)), u.options);
        // Multipart etags are `<md5 of part md5s>-<part count>`, as on R2/S3.
        const etag = `${md5Hex(Buffer.concat(parts.map((p) => Buffer.from(p.etag, "hex"))))}-${parts.length}`;
        this.objects.get(key)!.etag = etag;
        return { ...stored, etag, httpEtag: `"${etag}"` };
      },
      abort: async () => void this.multipart.delete(uploadId),
    };
  }
}

export interface QueueSendOptions {
  readonly delaySeconds?: number;
  readonly contentType?: string;
}

export class MemoryQueue {
  /** Bodies awaiting first delivery (drained by `drain()`). */
  readonly messages: Array<unknown> = [];
  /** Every send with its options, in order (delays are recorded, not waited for). */
  readonly sends: Array<{ body: unknown; options: QueueSendOptions }> = [];
  /** Retried messages awaiting redelivery with their attempt count. */
  readonly redeliveries: Array<{ body: unknown; attempts: number; delaySeconds?: number }> = [];
  async send(body: unknown, options: QueueSendOptions = {}) {
    const cloned = structuredClone(body);
    this.messages.push(cloned);
    this.sends.push({ body: cloned, options: { ...options } });
  }
  async sendBatch(
    batch: Iterable<{ body: unknown } & QueueSendOptions>,
    options: QueueSendOptions = {},
  ) {
    for (const { body, ...perMessage } of batch)
      await this.send(body, { ...options, ...perMessage });
  }
}

export interface SentEmail {
  readonly from: string;
  readonly to: string;
  readonly raw: string;
}

export const makeHarness = () => {
  const queues = {
    INGEST: new MemoryQueue(),
    PARSE_SCAN: new MemoryQueue(),
    INDEX: new MemoryQueue(),
    DISPATCH: new MemoryQueue(),
    NOTIFY: new MemoryQueue(),
    PROPAGATE: new MemoryQueue(),
    PUBLISH: new MemoryQueue(),
  };
  const buckets = {
    ORIGINALS: new MemoryR2(),
    PARTS: new MemoryR2(),
    EXPORTS: new MemoryR2(),
    PUBLISHED: new MemoryR2(),
  };
  const sent: Array<SentEmail> = [];
  const workflows: Record<string, Array<{ id: string; params: unknown }>> = {};
  const workflowEvents: Record<string, Array<{ id: string; type: string; payload: unknown }>> = {};
  /** Instance status per workflow binding and id; tests may overwrite it to simulate progress. */
  const workflowStatus: Record<string, Map<string, { status: string; output?: unknown }>> = {};
  const workflowUnstoppable = new Set<string>();
  const workflow = (name: string) => {
    const instance = (id: string) => ({
      id,
      status: async () => structuredClone(workflowStatus[name]!.get(id)!),
      sendEvent: async (event: { type: string; payload: unknown }) =>
        void (workflowEvents[name] ??= []).push({ id, ...structuredClone(event) }),
      terminate: async () => {
        // Tests add an id to `workflowUnstoppable` to simulate a stop that does not take effect.
        if (!workflowUnstoppable.has(id)) workflowStatus[name]!.get(id)!.status = "terminated";
      },
    });
    return {
      create: async (options: { id: string; params: unknown }) => {
        const statuses = (workflowStatus[name] ??= new Map());
        // Workflow instance ids are unique per workflow, including finished instances.
        if (statuses.has(options.id))
          throw new Error(`instance.already_exists: ${name} instance ${options.id} already exists`);
        statuses.set(options.id, { status: "queued" });
        (workflows[name] ??= []).push({ id: options.id, params: structuredClone(options.params) });
        return instance(options.id);
      },
      get: async (id: string) => {
        if (!workflowStatus[name]?.has(id))
          throw new Error(`instance.not_found: ${name} instance ${id} not found`);
        return instance(id);
      },
    };
  };
  let env: CoreEnv;
  const namespaces = {
    MAILBOXES: new Namespace(
      (s, e) => new MailboxDO(s as never, e),
      () => env,
    ),
    CALENDARS: new Namespace(
      (s, e) => new CalendarDO(s as never, e),
      () => env,
    ),
    SHARED_SPACES: new Namespace(
      (s, e) => new SharedSpaceDO(s as never, e),
      () => env,
    ),
    SEARCH_SHARDS: new Namespace(
      (s, e) => new SearchShardDO(s as never, e),
      () => env,
    ),
    INGRESS_JOURNALS: new Namespace(
      (s, e) => new IngressJournalDO(s as never, e),
      () => env,
    ),
  };
  const d1 = MemoryD1.migrated();
  /** Auth rate limiter: every key is recorded; `deny(key)` returning true answers "limited". */
  const rateLimit = {
    keys: [] as Array<string>,
    deny: (_key: string): boolean => false,
  };
  /** Fake scanner container: records scanned bodies and answers per `scanner.mode`. */
  const scanner = {
    mode: "clean" as "clean" | "infected" | "error" | "down",
    scanned: [] as Array<string>,
  };
  const scannerNamespace = {
    getByName: (_name: string) => ({
      fetch: async (request: Request) => {
        if (scanner.mode === "down") throw new Error("container unavailable");
        const body = await request.text();
        scanner.scanned.push(body);
        if (scanner.mode === "error")
          return new Response(JSON.stringify({ verdict: "error", reason: "clamd timeout" }), {
            status: 502,
          });
        const infected =
          scanner.mode === "infected" || body.includes("EICAR-STANDARD-ANTIVIRUS-TEST-FILE");
        return new Response(
          JSON.stringify(
            infected
              ? { verdict: "infected", signature: "Eicar-Test-Signature" }
              : { verdict: "clean" },
          ),
        );
      },
    }),
  };
  /** Fake MIME container: runs the real container parser in-process (§5.1 step 5). */
  const mime = { mode: "ok" as "ok" | "down", parsed: 0 };
  const mimeNamespace = {
    getByName: (_name: string) => ({
      fetch: async (request: Request) => {
        if (mime.mode === "down") throw new Error("container unavailable");
        const receivedAt = Number(
          new URL(request.url).searchParams.get("receivedAt") ?? Date.now(),
        );
        const bytes = new Uint8Array(await request.arrayBuffer());
        mime.parsed++;
        return new Response([...parseToLines(bytes, receivedAt)].map((l) => `${l}\n`).join(""), {
          headers: { "content-type": "application/x-ndjson" },
        });
      },
    }),
  };
  env = {
    APP_ORIGIN: "https://app.bye.test",
    MAIL_ORIGIN: "https://mail.bye-render.test",
    DIRECTORY: d1,
    ...buckets,
    CONFIG_CACHE: {},
    ...queues,
    ...namespaces,
    PROVISION_DOMAIN: workflow("PROVISION_DOMAIN"),
    EXPORT_ACCOUNT: workflow("EXPORT_ACCOUNT"),
    ERASE_ACCOUNT: workflow("ERASE_ACCOUNT"),
    REINDEX: workflow("REINDEX"),
    FANOUT: workflow("FANOUT"),
    TRANSACTIONAL_EMAIL: {
      send: async (message: { from: string; to: string; raw: ReadableStream | string }) => {
        const raw =
          typeof message.raw === "string" ? message.raw : await new Response(message.raw).text();
        sent.push({ from: message.from, to: message.to, raw });
        return { messageId: `cf-${sent.length}` };
      },
    },
    SCANNER: scannerNamespace,
    MIME_PARSER: mimeNamespace,
    AUTH_RATE_LIMIT: {
      limit: async ({ key }: { key: string }) => {
        rateLimit.keys.push(key);
        return { success: !rateLimit.deny(key) };
      },
    },
    MAIL_TRAFFIC_CLASSES: "transactional,external-identity,forwarding",
    SESSION_KEY: "test-session-key-0123456789abcdef",
    PROXY_SIGNING_KEY: "test-proxy-key-0123456789abcdef",
    BILLING_WEBHOOK_SECRET: "test-billing-secret-0123456789abcdef",
    TURNSTILE_SECRET: "test-turnstile",
  } as unknown as CoreEnv;

  const settle = async () => {
    for (const ns of Object.values(namespaces)) await ns.settle();
  };

  /** Messages that exhausted their retries, as delivered to the queue's DLQ consumer. */
  const deadLettered: Array<{ queue: string; body: unknown; attempts: number }> = [];
  let messageSeq = 0;

  const deliver = async (queue: string, body: unknown, attempts: number) => {
    let acked = false;
    let retry: { delaySeconds?: number } | null = null;
    await handleQueueBatch(
      {
        queue,
        messages: [
          {
            id: `msg_${++messageSeq}`,
            timestamp: new Date(),
            body,
            attempts,
            ack: () => void (acked = true),
            retry: (options: { delaySeconds?: number } = {}) => void (retry = { ...options }),
          },
        ],
        ackAll: () => void (acked = true),
        retryAll: (options: { delaySeconds?: number } = {}) => void (retry = { ...options }),
      } as never,
      env,
    );
    // An explicit retry wins over an implicit ack, as on Cloudflare.
    return retry !== null
      ? { retried: true as const, ...(retry as object) }
      : { retried: false as const, acked };
  };

  /** Physical DLQ name for a binding, e.g. PARSE_SCAN → `parsescandlq` (see dlq.ts naming). */
  const dlqName = (binding: string) => `${binding.replace(/_/g, "").toLowerCase()}dlq`;

  /**
   * Deliver queued messages until all queues are empty (bounded). Returns processed count.
   *
   * By default a retried message fails the test immediately. With `tolerateRetries`, a retried
   * message is redelivered in a later round with `attempts + 1` (its `delaySeconds` is recorded
   * but not waited for); after `maxRetries` redeliveries it goes to the queue's DLQ consumer, like
   * a Cloudflare queue with `max_retries` and a dead-letter queue configured.
   */
  const drain = async (
    rounds = 20,
    options: { readonly tolerateRetries?: boolean; readonly maxRetries?: number } = {},
  ): Promise<number> => {
    const maxRetries = options.maxRetries ?? 3;
    let processed = 0;
    for (let round = 0; round < rounds; round++) {
      await settle();
      const batch = Object.entries(queues).flatMap(([name, q]) => [
        ...q.messages.splice(0).map((body) => ({ name, body, attempts: 1 })),
        ...q.redeliveries.splice(0).map((r) => ({ name, body: r.body, attempts: r.attempts })),
      ]);
      if (batch.length === 0) return processed;
      for (const { name, body, attempts } of batch) {
        const outcome = await deliver(name, body, attempts);
        processed++;
        if (!outcome.retried) continue;
        if (!options.tolerateRetries)
          throw new Error(`queue ${name} message failed: ${JSON.stringify(body).slice(0, 200)}`);
        if (attempts <= maxRetries) {
          queues[name as keyof typeof queues].redeliveries.push({
            body,
            attempts: attempts + 1,
            ...("delaySeconds" in outcome && outcome.delaySeconds !== undefined
              ? { delaySeconds: outcome.delaySeconds as number }
              : {}),
          });
        } else {
          deadLettered.push({ queue: name, body, attempts });
          await deliver(dlqName(name), body, attempts);
        }
      }
    }
    return processed;
  };

  return {
    env,
    d1,
    queues,
    deadLettered,
    rateLimit,
    workflowStatus,
    workflowUnstoppable,
    buckets,
    sent,
    workflows,
    workflowEvents,
    namespaces,
    settle,
    drain,
    scanner,
    mime,
  };
};

export type Harness = ReturnType<typeof makeHarness>;

/** Minimal inbound message for the email handler. */
export const inboundMessage = (from: string, to: string, raw: string) => {
  const bytes = new TextEncoder().encode(raw);
  let rejected: string | null = null;
  let forwardedTo: string | null = null;
  return {
    from,
    to,
    rawSize: bytes.byteLength,
    raw: new Response(bytes).body!,
    setReject: (reason: string) => void (rejected = reason),
    forward: async (rcpt: string) => void (forwardedTo = rcpt),
    get rejected() {
      return rejected;
    },
    get forwardedTo() {
      return forwardedTo;
    },
  };
};

export const rfc822 = (input: {
  from: string;
  to: string;
  subject: string;
  body: string;
  messageId: string;
  inReplyTo?: string;
  extraHeaders?: string;
}) =>
  [
    `Authentication-Results: mx.cloudflare.net; spf=pass; dkim=pass; dmarc=pass`,
    `From: ${input.from}`,
    `To: ${input.to}`,
    `Subject: ${input.subject}`,
    `Date: Fri, 25 Sep 2026 12:00:00 +0000`,
    `Message-ID: <${input.messageId}>`,
    ...(input.inReplyTo
      ? [`In-Reply-To: <${input.inReplyTo}>`, `References: <${input.inReplyTo}>`]
      : []),
    ...(input.extraHeaders ? [input.extraHeaders] : []),
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    input.body,
    "",
  ].join("\r\n");

/** Server end of a fake WebSocketPair: records hints sent and the close code/reason. */
export class FakeServerSocket {
  readonly sent: Array<string> = [];
  closed: { code?: number; reason?: string } | null = null;
  send(data: string) {
    if (this.closed) throw new Error("socket closed");
    this.sent.push(data);
  }
  close(code?: number, reason?: string) {
    if (this.closed) throw new Error("socket already closed");
    this.closed = {
      ...(code === undefined ? {} : { code }),
      ...(reason === undefined ? {} : { reason }),
    };
  }
}

/**
 * Install `WebSocketPair` and let `Response` carry status 101 (Node's Response rejects it) so the
 * objects' real `acceptLiveSocket` path runs. Returns the server sockets created and a restore.
 */
export const installWebSocketPair = () => {
  const g = globalThis as unknown as { WebSocketPair?: unknown; Response: typeof Response };
  const RealResponse = g.Response;
  const created: Array<FakeServerSocket> = [];
  g.WebSocketPair = class {
    0 = {};
    1: FakeServerSocket;
    constructor() {
      this[1] = new FakeServerSocket();
      created.push(this[1]);
    }
  };
  g.Response = class extends RealResponse {
    constructor(body?: BodyInit | null, init?: ResponseInit & { webSocket?: unknown }) {
      super(body, init?.status === 101 ? { ...init, status: 200 } : init);
    }
  } as typeof Response;
  return {
    created,
    restore: () => {
      g.Response = RealResponse;
      delete g.WebSocketPair;
    },
  };
};

/** Enables the `personal` traffic class (Cloudflare send_email; sent mail lands in `h.sent`). */
export const enablePersonalMail = (h: { env: CoreEnv }): void => {
  (h.env as { MAIL_TRAFFIC_CLASSES: string }).MAIL_TRAFFIC_CLASSES =
    "transactional,personal,external-identity,forwarding";
};
