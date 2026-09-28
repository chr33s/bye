import type { JsonValue, Kernel, KernelClock } from "../durable/kernel.ts";
import { json, type Sql } from "../durable/sql.ts";

/** Codec functions injected into the store; implemented by @bye/mail-codec in production. */
export interface MailboxCodec {
  /** Strip reply/forward prefixes and whitespace for conservative fallback threading. */
  readonly normalizeSubject: (subject: string) => string;
}

export const basicMailboxCodec: MailboxCodec = {
  normalizeSubject: (subject) =>
    subject
      .replace(/^\s*((re|fwd?|aw|sv|antw)(\[\d+\])?\s*:\s*)+/i, "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase(),
};

// Mailbox refusals use the platform-wide `Rejection` (durable/rpc.ts). The old names remain as
// aliases so callers migrate without churn.
export { reject } from "../durable/rpc.ts";

export type MailboxRejectionCode =
  | "not_found"
  | "conflict"
  | "forbidden"
  | "bad_request"
  | "too_late"
  | "payload_too_large";

/** Shared state for the mailbox sub-stores. One instance per MailboxDO. */
export class MailboxContext {
  constructor(
    readonly mailboxId: string,
    readonly sql: Sql,
    readonly kernel: Kernel,
    readonly clock: KernelClock,
    readonly codec: MailboxCodec,
  ) {}

  now(): number {
    return this.clock.now();
  }

  id(prefix: string): string {
    return this.clock.id(prefix);
  }

  /**
   * Idempotent command: the receipt, mutation, change events and outbox rows commit in one
   * local transaction. A replay returns the stored result (§6).
   */
  cmd<T>(commandId: string, kind: string, fn: () => T, payload?: JsonValue): T {
    return this.sql.tx(() => this.kernel.receipt(commandId, kind, fn, payload)).result;
  }

  setting<T>(key: string, fallback: T): T {
    return json<T>(
      this.sql.one<{ value: string }>("SELECT value FROM mailbox_settings WHERE key = ?", key)
        ?.value,
      fallback,
    );
  }

  putSetting(key: string, value: JsonValue): void {
    this.sql.run(
      "INSERT INTO mailbox_settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      key,
      JSON.stringify(value),
    );
  }

  change(resource: string, kind: string, payload: JsonValue): number {
    return this.kernel.change(resource, kind, payload);
  }

  /**
   * Emit an index event and record it as pending until the indexer acknowledges it, so search can
   * report an honest watermark (§8: "show an indexing watermark when results may be incomplete").
   */
  indexUpsert(kind: string, id: string): void {
    this.markIndexPending(kind, id);
    this.kernel.outbox("index", this.mailboxId, { op: "upsert", kind, id });
  }

  indexDelete(kind: string, id: string): void {
    this.markIndexPending(kind, id);
    this.kernel.outbox("index", this.mailboxId, { op: "delete", kind, id });
  }

  private markIndexPending(kind: string, id: string): void {
    this.sql.run(
      "INSERT INTO index_pending (doc_key, emitted_seq) VALUES (?, ?) ON CONFLICT (doc_key) DO UPDATE SET emitted_seq = excluded.emitted_seq",
      `${kind}:${id}`,
      this.kernel.currentSeq(),
    );
  }

  /** Re-index every delivery of a thread after a change that affects search (disposition, labels…). */
  reindexThread(threadId: string): void {
    for (const d of this.sql.all<{ delivery_id: string }>(
      "SELECT delivery_id FROM deliveries WHERE thread_id = ?",
      threadId,
    ))
      this.indexUpsert("delivery", d.delivery_id);
  }

  /** Cryptographically random URL-safe secret (Workers and Node both expose Web Crypto). */
  secret(bytes = 18): string {
    const buf = new Uint8Array(bytes);
    crypto.getRandomValues(buf);
    let out = "";

    for (const b of buf) out += b.toString(16).padStart(2, "0");

    return out;
  }
}
