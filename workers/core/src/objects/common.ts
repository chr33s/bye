import { Effect } from "effect";
import { QueuePublisherLive, relayOutbox } from "@bye/platform-cloudflare";
import { offloadToR2 } from "../queueref.ts";
import type { CoreEnv } from "../env.ts";

// Durable Object hosts. Each class is a thin native adapter: RPC methods run one synchronous
// store transaction, then re-derive the alarm from persisted jobs and relay the outbox. Business
// rules live in the stores (packages/platform-cloudflare) and are tested there.

export const queuesOf = (env: CoreEnv) =>
  QueuePublisherLive({
    ingest: env.INGEST,
    dispatch: env.DISPATCH,
    index: env.INDEX,
    notify: env.NOTIFY,
    propagate: env.PROPAGATE,
  });

export const flush = (env: CoreEnv, kernel: Parameters<typeof relayOutbox>[0], source: string) =>
  // Oversize rows go by R2 reference; poison rows are dead-lettered locally (§6). Failures stay in
  // the durable outbox and the alarm retries; log (redacted) instead of swallowing silently.
  Effect.runPromise(
    relayOutbox(kernel, source, 100, { offload: offloadToR2(env) }).pipe(
      Effect.provide(queuesOf(env)),
    ),
  ).catch(() => {
    console.warn(
      JSON.stringify({ level: "warn", op: "outbox.relay-failed", source: source.split(":")[0] }),
    );
  });

export const setAlarmAt = async (storage: DurableObjectStorage, at: number | null) => {
  if (at === null) return;
  const current = await storage.getAlarm();
  if (current === null || current > at) await storage.setAlarm(Math.max(at, Date.now()));
};

/** Object name as provisioned by the directory (`getByName`). */
export const nameOf = (ctx: DurableObjectState): string => {
  const name = ctx.id.name;
  if (!name) throw new Error("durable object must be addressed by name");
  return name;
};

/** Internal draft marker; the renderer turns it into a text/calendar part and never emits it. */
export const ITIP_METHOD_HEADER = "x-bye-itip-method";

/** Normalized body stored beside the original by the ingest consumer. */
export const bodyKeyFor = (messageKey: string): string =>
  messageKey.replace("/orig/", "/body/").replace(/\.eml$/, ".json");

export interface StoredBody {
  readonly text: string;
  readonly html: string | null;
  readonly remoteImages: number;
  readonly blockedTrackers: number;
  /** Inline parts referenced as `cid:<id>` in `html`: content ID → PARTS key (served via the render origin). */
  readonly inline?: Readonly<Record<string, string>>;
}

export interface SearchHit {
  readonly kind: string;
  readonly id: string;
  readonly threadId: string | null;
  readonly date: number;
  readonly snippet: string;
}
