import type { CoreEnv } from "./env.ts";
import { metric } from "./metrics.ts";
import { bodyKeyFor } from "./objects.ts";
import { recordUsage } from "./usage.ts";
import { mailbox } from "./authorities.ts";

// Reference-aware, delayed blob garbage collection (§12). Producers (retention purge, failed
// uploads, expired exports) record an intent; nothing is deleted immediately. The daily sweep
// deletes only after the delay AND a fresh check that no delivery, send job, pin (share, export,
// published copy) or unknown holder still references the key. Unknown key shapes are retained.

export const GC_DELAY_MS = 7 * 24 * 3600_000;

export type GcBucket = "ORIGINALS" | "PARTS" | "EXPORTS";

export interface GcIntent {
  readonly bucket: GcBucket;
  readonly key: string;
  readonly ownerKind: "mailbox" | "user";
  readonly ownerId: string;
  readonly reason: string;
  readonly delayMs?: number;
}

export const recordGcIntent = async (
  env: CoreEnv,
  intent: GcIntent,
  now = Date.now(),
): Promise<void> => {
  await env.DIRECTORY.prepare(
    `INSERT INTO blob_gc_intents (bucket, object_key, owner_kind, owner_id, reason, requested_at, not_before, state) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
     ON CONFLICT (bucket, object_key) DO UPDATE SET reason = excluded.reason, not_before = MAX(blob_gc_intents.not_before, excluded.not_before), state = 'pending'`,
  )
    .bind(
      intent.bucket,
      intent.key,
      intent.ownerKind,
      intent.ownerId,
      intent.reason.slice(0, 120),
      now,
      now + (intent.delayMs ?? GC_DELAY_MS),
    )
    .run();
};

/** Holders outside the owning mailbox (shared spaces, exports, published copies) pin keys. */
export const pinBlob = (
  env: CoreEnv,
  bucket: GcBucket,
  key: string,
  holderKind: string,
  holderId: string,
) =>
  env.DIRECTORY.prepare(
    "INSERT OR IGNORE INTO blob_pins (bucket, object_key, holder_kind, holder_id, created_at) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(bucket, key, holderKind, holderId, Date.now())
    .run();

export const unpinBlob = (
  env: CoreEnv,
  bucket: GcBucket,
  key: string,
  holderKind: string,
  holderId: string,
) =>
  env.DIRECTORY.prepare(
    "DELETE FROM blob_pins WHERE bucket = ? AND object_key = ? AND holder_kind = ? AND holder_id = ?",
  )
    .bind(bucket, key, holderKind, holderId)
    .run();

export type BlobKeyClass =
  | { readonly kind: "original"; readonly mailboxId: string; readonly ingestionId: string }
  | { readonly kind: "outbound"; readonly mailboxId: string; readonly sendJobId: string }
  /** Normalized body of a sent message (`bodyKeyFor` of its `out/…eml`), stored in PARTS. */
  | { readonly kind: "outbound-body"; readonly mailboxId: string; readonly sendJobId: string }
  | { readonly kind: "body"; readonly mailboxId: string; readonly ingestionId: string }
  | { readonly kind: "part"; readonly mailboxId: string; readonly ingestionId: string }
  | { readonly kind: "upload"; readonly mailboxId: string; readonly uploadId: string }
  | { readonly kind: "export"; readonly userId: string }
  | { readonly kind: "unknown" };

export const classifyKey = (key: string): BlobKeyClass => {
  let m: RegExpExecArray | null;

  if ((m = /^t\/([^/]+)\/orig\/([^/]+)\.eml$/.exec(key)))
    return { kind: "original", mailboxId: m[1]!, ingestionId: m[2]! };

  if ((m = /^t\/([^/]+)\/out\/([^/]+)\.eml$/.exec(key)))
    return { kind: "outbound", mailboxId: m[1]!, sendJobId: m[2]! };

  if ((m = /^t\/([^/]+)\/out\/([^/]+)\.json$/.exec(key)))
    return { kind: "outbound-body", mailboxId: m[1]!, sendJobId: m[2]! };

  if ((m = /^t\/([^/]+)\/body\/([^/]+)\.json$/.exec(key)))
    return { kind: "body", mailboxId: m[1]!, ingestionId: m[2]! };

  if ((m = /^t\/([^/]+)\/part\/([^/]+)\/[^/]+$/.exec(key)))
    return { kind: "part", mailboxId: m[1]!, ingestionId: m[2]! };

  if ((m = /^t\/([^/]+)\/upload\/([^/]+)$/.exec(key)))
    return { kind: "upload", mailboxId: m[1]!, uploadId: m[2]! };

  if ((m = /^t\/([^/]+)\/export\//.exec(key))) return { kind: "export", userId: m[1]! };

  return { kind: "unknown" };
};

const TERMINAL_JOB = new Set(["accepted", "rejected", "cancelled"]);

/** True when anything still references the key. Errors count as referenced (fail safe). */
export const isReferenced = async (
  env: CoreEnv,
  bucket: GcBucket,
  key: string,
  reason: string,
): Promise<boolean> => {
  try {
    const pinned = await env.DIRECTORY.prepare(
      "SELECT 1 AS p FROM blob_pins WHERE bucket = ? AND object_key = ? LIMIT 1",
    )
      .bind(bucket, key)
      .first();

    if (pinned) return true;
    const parsed = classifyKey(key);

    switch (parsed.kind) {
      case "original":
      case "body":
      case "part": {
        const original = `t/${parsed.mailboxId}/orig/${parsed.ingestionId}.eml`;

        if (
          parsed.kind !== "original" &&
          (await env.DIRECTORY.prepare("SELECT 1 AS p FROM blob_pins WHERE object_key = ? LIMIT 1")
            .bind(original)
            .first())
        )
          return true;
        // Any delivery (inbound or redelivered copy) still pointing at the original keeps it.
        const status = await mailbox(env, parsed.mailboxId).scanStatusForMessageKey(original);

        return status !== null;
      }

      case "outbound-body":
        // Lives exactly as long as its sent message's original.
        return isReferenced(
          env,
          "ORIGINALS",
          `t/${parsed.mailboxId}/out/${parsed.sendJobId}.eml`,
          reason,
        );
      case "outbound": {
        const job = await mailbox(env, parsed.mailboxId).sendJob(parsed.sendJobId);

        if (job && !TERMINAL_JOB.has(job.state ?? "")) return true;
        const status = await mailbox(env, parsed.mailboxId).scanStatusForMessageKey(key);

        return status !== null;
      }

      case "upload":
        // Only failed/aborted uploads are collected; anything else may be referenced by a draft.
        return !/^upload-(failed|aborted)$/.test(reason);
      case "export":
        return false; // exports are pinned while downloadable; unpinned + expired → collectable
      case "unknown":
        return true;
    }
  } catch {
    return true;
  }
};

const deleteDerived = async (env: CoreEnv, key: string): Promise<void> => {
  const parsed = classifyKey(key);

  if (parsed.kind === "outbound") {
    const sentBody = await env.PARTS.head(bodyKeyFor(key));

    if (sentBody) {
      await env.PARTS.delete(bodyKeyFor(key));
      await recordUsage(env, "mailbox", parsed.mailboxId, "bodies", -sentBody.size);
    }

    return;
  }

  if (parsed.kind !== "original") return;
  const body = await env.PARTS.head(bodyKeyFor(key));

  if (body) {
    await env.PARTS.delete(bodyKeyFor(key));
    await recordUsage(env, "mailbox", parsed.mailboxId, "bodies", -body.size);
  }

  const prefix = `t/${parsed.mailboxId}/part/${parsed.ingestionId}/`;
  let cursor: string | undefined;

  do {
    const listed = await env.PARTS.list(
      cursor ? { prefix, limit: 500, cursor } : { prefix, limit: 500 },
    );

    const bytes = listed.objects.reduce((n, o) => n + (o.size ?? 0), 0);

    if (listed.objects.length) {
      await env.PARTS.delete(listed.objects.map((o) => o.key));
      await recordUsage(env, "mailbox", parsed.mailboxId, "parts", -bytes);
    }

    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
};

export const sweepBlobGc = async (
  env: CoreEnv,
  now = Date.now(),
  limit = 200,
): Promise<{ readonly deleted: number; readonly retained: number }> => {
  const due = (
    await env.DIRECTORY.prepare(
      "SELECT bucket, object_key, owner_kind, owner_id, reason FROM blob_gc_intents WHERE state = 'pending' AND not_before <= ? ORDER BY not_before LIMIT ?",
    )
      .bind(now, limit)
      .all<{
        bucket: GcBucket;
        object_key: string;
        owner_kind: string;
        owner_id: string;
        reason: string;
      }>()
  ).results;

  let deleted = 0;
  let retained = 0;

  for (const intent of due) {
    const referenced = await isReferenced(env, intent.bucket, intent.object_key, intent.reason);

    if (referenced) {
      retained++;
      await env.DIRECTORY.prepare(
        "UPDATE blob_gc_intents SET state = 'retained', checked_at = ?, attempts = attempts + 1 WHERE bucket = ? AND object_key = ?",
      )
        .bind(now, intent.bucket, intent.object_key)
        .run();
      continue;
    }

    const bucket = env[intent.bucket];
    const head = await bucket.head(intent.object_key);
    await bucket.delete(intent.object_key);
    await deleteDerived(env, intent.object_key);

    if (head && intent.bucket === "EXPORTS")
      await recordUsage(env, "user", intent.owner_id, "exports", -head.size);
    await env.DIRECTORY.prepare(
      "UPDATE blob_gc_intents SET state = 'deleted', checked_at = ?, attempts = attempts + 1 WHERE bucket = ? AND object_key = ?",
    )
      .bind(now, intent.bucket, intent.object_key)
      .run();
    deleted++;
  }

  metric("blobgc.deleted", deleted);
  metric("blobgc.retained", retained);

  return { deleted, retained };
};

/**
 * Authorized redelivery (E19) copies the message into the TARGET tenant's namespace, so the target
 * never references `t/<source>/…` keys: the source's retention/GC can then delete its own copy
 * without breaking the target, and tenant keys stay tenant-scoped (§4.1). Idempotent: the target
 * key is derived from the transfer ID and re-copying overwrites identical bytes.
 */
export const copyMessageForTransfer = async (
  env: CoreEnv,
  input: {
    readonly sourceKey: string;
    readonly targetMailboxId: string;
    readonly transferId: string;
  },
): Promise<{ readonly messageKey: string; readonly bytes: number }> => {
  const source = /^t\/([^/]+)\/orig\/([^/]+)\.eml$/.exec(input.sourceKey);

  if (!source) throw new Error("unexpected source message key");
  const [, sourceMailbox, sourceIngestion] = source;
  const targetIngestion = `xfer_${input.transferId.replace(/[^A-Za-z0-9_-]/g, "")}`;
  const messageKey = `t/${input.targetMailboxId}/orig/${targetIngestion}.eml`;
  const original = await env.ORIGINALS.get(input.sourceKey);

  if (!original) throw new Error("redelivery source original missing");
  await env.ORIGINALS.put(messageKey, original.body, {
    httpMetadata: original.httpMetadata ?? { contentType: "message/rfc822" },
  });
  let bytes = original.size;
  let bodyBytes = 0;
  let partBytes = 0;
  const body = await env.PARTS.get(bodyKeyFor(input.sourceKey));

  if (body) {
    await env.PARTS.put(bodyKeyFor(messageKey), body.body, {
      httpMetadata: body.httpMetadata ?? {},
    });
    bodyBytes = body.size;
  }

  const partPrefix = `t/${sourceMailbox}/part/${sourceIngestion}/`;
  let cursor: string | undefined;

  do {
    const listed = await env.PARTS.list(
      cursor ? { prefix: partPrefix, limit: 100, cursor } : { prefix: partPrefix, limit: 100 },
    );

    for (const o of listed.objects) {
      const part = await env.PARTS.get(o.key);

      if (!part) continue;
      const putOptions: R2PutOptions = {};

      if (part.httpMetadata) putOptions.httpMetadata = part.httpMetadata;

      if (part.customMetadata) putOptions.customMetadata = part.customMetadata;
      await env.PARTS.put(
        `t/${input.targetMailboxId}/part/${targetIngestion}/${o.key.slice(partPrefix.length)}`,
        part.body,
        putOptions,
      );
      partBytes += part.size;
    }

    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);

  // Originals are counted by the mailbox's own quota (rawSize); derived copies are tracked here.
  await recordUsage(env, "mailbox", input.targetMailboxId, "bodies", bodyBytes).catch(
    () => undefined,
  );
  await recordUsage(env, "mailbox", input.targetMailboxId, "parts", partBytes).catch(
    () => undefined,
  );
  bytes += bodyBytes + partBytes;
  metric("redeliver.copied.bytes", bytes);

  return { messageKey, bytes };
};
