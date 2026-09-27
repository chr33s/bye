import { Effect, Layer, Schema } from "effect";
import {
  blobKey,
  decideDispatch,
  type Directory,
  OutboundRenderer,
  recordDispatched,
  releaseDispatch,
  RenderFailure,
  renderAndDispatch,
  type SendingPolicyService,
} from "@bye/application";
import { QueueMessage } from "@bye/contracts";
import {
  buildMessage,
  type MessageSummary,
  parseMessage,
  sanitizeHtml,
  summarizeMessage,
} from "@bye/mail-codec";
import type { SafetyVerdict } from "@bye/domain";
import {
  MailboxJobStoreLive,
  type MailboxRpcResult,
  type TransportAdapter,
  parseTrafficClasses,
  TransportRouterLive,
} from "@bye/platform-cloudflare";
import { buildTransportAdapters } from "./transports.ts";
import { describeError } from "./http.ts";
import { captureDeadLetters, isDeadLetterQueue } from "./dlq.ts";
import { handleNotify } from "./notify.ts";
import { isQueueRef, QUEUE_REF_GONE, releaseQueueRef, resolveQueueRef } from "./queueref.ts";
import {
  handleProviderEvent,
  parseProviderEvent,
  recordAcceptance,
  recordUnknown,
} from "./sendevents.ts";
import { type CoreEnv, journalPartition } from "./env.ts";
import { bodyKeyFor, ITIP_METHOD_HEADER, type StoredBody } from "./objects.ts";
import { policyLayers } from "./services.ts";
import { dispatchPropagate } from "./topics/index.ts";
import { safetyVerdict } from "./safety.ts";
import { metric } from "./metrics.ts";
import { MIME_INLINE_MAX_BYTES, parseViaContainer } from "./mime.ts";
import { recordUsage } from "./usage.ts";
import { mailboxErased } from "./erasure.ts";

// Queue consumers (§5.1 steps 5–7, §5.2, §6). Every handler is idempotent by (eventId, target);
// acknowledgement follows the committed result. Messages are acked or retried individually so a
// mixed-success batch keeps per-message semantics (§15.4).

const decode = Schema.decodeUnknownSync(QueueMessage);

export { personalMailEndpoint, sendEmailBinding } from "./transports.ts";

/** Render a frozen send job to MIME at its deterministic content key (idempotent put). */
const rendererLayer = (env: CoreEnv) =>
  Layer.succeed(OutboundRenderer, {
    render: (mailboxId, sendJobId) =>
      Effect.tryPromise({
        try: async () => {
          const stub = env.MAILBOXES.getByName(mailboxId);
          const frozen = await stub.frozenContent(sendJobId);
          if (!frozen) return;
          const existing = await env.ORIGINALS.head(frozen.job.contentKey);
          if (existing) return;
          // Uploads referenced from the HTML as `cid:<uploadId>` (composer inline images) become
          // multipart/related inline parts; every other upload is an ordinary attachment.
          const html = frozen.content.html;
          const inlineIds = new Set(
            html ? frozen.content.attachments.filter((id) => html.includes(`cid:${id}`)) : [],
          );
          // Sequential loads: one attachment read in flight at a time (§7.4).
          const loaded: Array<{
            uploadId: string;
            filename: string;
            contentType: string;
            content: Uint8Array;
          }> = [];
          for (const uploadId of frozen.content.attachments) {
            const object = await env.PARTS.get(blobKey.upload(mailboxId, uploadId));
            if (!object) throw new Error("attachment missing");
            loaded.push({
              uploadId,
              filename: object.customMetadata?.filename ?? uploadId,
              contentType: object.httpMetadata?.contentType ?? "application/octet-stream",
              content: new Uint8Array(await object.arrayBuffer()),
            });
          }
          const attachments = loaded
            .filter((a) => !inlineIds.has(a.uploadId))
            .map(({ uploadId: _uploadId, ...a }) => a);
          const inline = loaded
            .filter((a) => inlineIds.has(a.uploadId))
            .map(({ uploadId, ...a }) => ({ ...a, contentId: uploadId }));
          const from = { name: frozen.identity?.name ?? undefined, address: frozen.job.from };
          const headers = Object.entries(frozen.content.headers ?? {});
          const itipMethod = headers.find(([k]) => k.toLowerCase() === ITIP_METHOD_HEADER)?.[1];
          const autoSubmitted = headers.find(([k]) => k.toLowerCase() === "auto-submitted")?.[1];
          const extraHeaders = headers.filter(
            ([k]) => !["auto-submitted", ITIP_METHOD_HEADER].includes(k.toLowerCase()),
          );
          const signature =
            frozen.identity?.signature && !itipMethod
              ? `\n\n-- \n${frozen.identity.signature}`
              : "";
          const text = itipMethod
            ? `${frozen.content.subject}\n`
            : `${frozen.content.text}${signature}`;
          const built = buildMessage({
            from,
            to: frozen.content.to,
            cc: frozen.content.cc,
            bcc: frozen.content.bcc,
            subject: frozen.content.subject,
            text,
            ...(itipMethod
              ? {
                  calendar: {
                    method: itipMethod as "REQUEST" | "REPLY" | "CANCEL",
                    ics: frozen.content.text,
                  },
                }
              : {}),
            ...(autoSubmitted === "auto-replied" || autoSubmitted === "auto-generated"
              ? { autoSubmitted }
              : {}),
            ...(extraHeaders.length ? { extraHeaders } : {}),
            ...(html ? { html } : {}),
            ...(inline.length ? { inline } : {}),
            attachments,
            ...(frozen.content.inReplyTo ? { inReplyTo: frozen.content.inReplyTo } : {}),
            ...(frozen.content.references ? { references: frozen.content.references } : {}),
            date: Date.now(),
            messageId: `${sendJobId}@${frozen.job.from.split("@")[1] ?? "localhost"}`,
          });
          // The normalized body the render origin, search and share links read (as for inbound mail).
          // Written before the original so a crash between the two never leaves a bodiless sent message.
          await storeBody(env, mailboxId, frozen.job.contentKey, {
            ...sanitizedBody(text, html),
            ...(inlineIds.size
              ? {
                  inline: Object.fromEntries(
                    [...inlineIds].map((id) => [id, blobKey.upload(mailboxId, id)]),
                  ),
                }
              : {}),
          });
          await env.ORIGINALS.put(frozen.job.contentKey, built.bytes, {
            httpMetadata: { contentType: "message/rfc822" },
          });
          await stub.setRenderedSize(sendJobId, built.bytes.byteLength);
        },
        catch: (e) =>
          new RenderFailure({ detail: e instanceof Error ? e.message : "render failed" }),
      }),
  });

/**
 * Normalized body stored beside an original. Remote image URLs are kept (sanitized); the render
 * origin proxies or blocks them per the viewer's preference.
 */
const sanitizedBody = (text: string, html: string | undefined): StoredBody => {
  const sanitized = html
    ? sanitizeHtml(html, {
        proxyImage: (url) => url,
        cid: (id) => `cid:${id}`,
        blockRemoteImages: false,
      })
    : undefined;
  return {
    text,
    html: sanitized?.html ?? null,
    remoteImages: sanitized?.remoteImages.length ?? 0,
    blockedTrackers: sanitized?.blockedTrackers.length ?? 0,
  };
};

/** Idempotent body put; usage bytes are recorded only when the object didn't already exist. */
const storeBody = async (env: CoreEnv, mailboxId: string, objectKey: string, body: StoredBody) => {
  const json = JSON.stringify(body);
  const existed = await env.PARTS.head(bodyKeyFor(objectKey));
  await env.PARTS.put(bodyKeyFor(objectKey), json, {
    httpMetadata: { contentType: "application/json" },
  });
  if (!existed) await recordUsage(env, "mailbox", mailboxId, "bodies", json.length);
};

/** User whose sending budget applies: the mailbox owner, or the mailbox itself for shared mailboxes. */
const budgetSubject = async (env: CoreEnv, mailboxId: string): Promise<string> => {
  const row = await env.DIRECTORY.withSession("first-primary")
    .prepare("SELECT owner_user_id FROM mailboxes WHERE id = ?")
    .bind(mailboxId)
    .first<{ owner_user_id: string | null }>();
  return row?.owner_user_id ?? mailboxId;
};

const dispatchLayers = (
  env: CoreEnv,
  mailboxId: string,
  adapters: ReadonlyArray<TransportAdapter>,
) => {
  const stub = env.MAILBOXES.getByName(mailboxId);
  // The dispatch policy is the application's (`decideDispatch`, §5.2/§10) over the Directory and
  // SendingPolicy services; an outage rejects, so the claim throws and the dispatch message retries
  // without the job ever being attempted. This module is only the glue to the mailbox authority.
  // Resolved once per dispatch batch; the operator lookup never rejects (bootstrap.ts).
  const policies = policyLayers(env);
  const run = async <A, E>(
    program: Effect.Effect<A, E, Directory | SendingPolicyService>,
  ): Promise<A> => Effect.runPromise(Effect.provide(program, await policies));
  const jobInfo = new Map<
    string,
    {
      readonly from: string;
      readonly trafficClass: string;
      readonly recipients: number;
      readonly budgetUserId: string;
      /** Budget `decideDispatch` reserved; handed back if the send never reaches a provider. */
      readonly reserved: number;
    }
  >();
  // Best effort: a failed release only over-counts the budget (fails safe), never blocks dispatch.
  const release = async (budgetUserId: string, from: string, reserved: number) => {
    if (reserved <= 0) return;
    try {
      await run(releaseDispatch({ budgetUserId, from, recipients: reserved }));
    } catch {
      console.warn(JSON.stringify({ level: "warn", op: "send.budget.release" }));
    }
  };
  return Layer.mergeAll(
    rendererLayer(env),
    TransportRouterLive(adapters, parseTrafficClasses(env.MAIL_TRAFFIC_CLASSES)),
    MailboxJobStoreLive({
      // Dispatch revalidates sender authority, membership and abuse budgets (§5.2, §10) BEFORE
      // claiming, so a directory outage retries cleanly instead of stranding a never-attempted job.
      claim: async (id) => {
        const job = await stub.sendJob(id);
        if (!job || job.state !== "ready") return stub.claim(id);
        const budgetUserId = await budgetSubject(env, mailboxId);
        const forwardingScan =
          job.trafficClass === "forwarding"
            ? await stub.scanStatusForMessageKey(job.contentKey)
            : null;
        const decision = await run(
          decideDispatch({
            mailboxId,
            budgetUserId,
            from: job.from,
            trafficClass: job.trafficClass,
            recipients: job.recipients,
            forwardingScan,
          }),
        );
        const submission = await stub.claim(id);
        if (!submission) {
          // Lost the claim race: nothing will be sent under this decision's reservation.
          if (decision._tag === "Proceed") await release(budgetUserId, job.from, decision.reserved);
          return null;
        }
        if (decision._tag === "Refuse") {
          await stub.failed(id, { kind: decision.failure.kind, detail: decision.failure.detail });
          if (decision.blockedBy) metric("send.policy.blocked", 1, { reason: decision.blockedBy });
          return null;
        }
        // Suppressed recipients (prior hard bounce/complaint, §10) are removed from the envelope and
        // recorded as rejected outcomes; the rest of the message still goes out.
        const envelopeRecipients = submission.envelopeRecipients.filter(
          (r) => !decision.suppressed.has(r.toLowerCase()),
        );
        for (const address of submission.envelopeRecipients.filter((r) =>
          decision.suppressed.has(r.toLowerCase()),
        )) {
          await stub.recordRecipientEvent(
            `suppressed:${id}:${address}`,
            id,
            address,
            "rejected",
            "suppressed: previous bounce or complaint",
          );
        }
        jobInfo.set(id, {
          from: job.from,
          trafficClass: job.trafficClass,
          recipients: envelopeRecipients.length,
          budgetUserId,
          reserved: decision.reserved,
        });
        return { ...submission, envelopeRecipients };
      },
      accepted: async (id, receipt) => {
        await stub.accepted(id, receipt);
        const info = jobInfo.get(id);
        await recordAcceptance(
          env,
          receipt.providerId,
          mailboxId,
          id,
          info?.trafficClass ?? "unknown",
        );
        if (info)
          await run(
            recordDispatched({
              budgetUserId: info.budgetUserId,
              from: info.from,
              recipients: info.recipients,
            }),
          );
        metric("send.accepted", 1, { transport: info?.trafficClass ?? "unknown" });
      },
      failed: async (id, failure) => {
        await stub.failed(id, failure);
        const info = jobInfo.get(id);
        if (failure.kind === "RetryableBeforeAcceptance" && info) {
          // Never reached the provider: the retry reserves again, so hand this reservation back.
          jobInfo.delete(id);
          await release(info.budgetUserId, info.from, info.reserved);
        }
        if (failure.kind === "Unknown")
          await recordUnknown(env, mailboxId, id, info?.trafficClass ?? "unknown");
        metric("send.failed", 1, { kind: failure.kind });
      },
    }),
  );
};

type IngestMessage = Extract<QueueMessage, { type: "ingest" }>;

/** Commit a parsed delivery; permanent authority rejections stop replay (§5.1 step 6). */
const commitParsed = async (
  env: CoreEnv,
  m: IngestMessage,
  summary: MessageSummary,
  safety: SafetyVerdict,
): Promise<void> => {
  const journal = env.INGRESS_JOURNALS.getByName(journalPartition(m.ingestionId));
  // Forced by Cloudflare's RPC type mapping, which narrows this DO method's `RpcResult` union to its
  // success branch; the full envelope is restored so rejections are handled.
  const result = (await env.MAILBOXES.getByName(m.mailboxId).commitDelivery({
    ingestionId: m.ingestionId,
    recipient: m.recipient,
    messageKey: m.objectKey,
    rawSize: m.rawSize,
    summary,
    safety,
    receivedAt: m.receivedAt,
  })) as unknown as MailboxRpcResult<unknown>;
  if (result.ok === false && result.code !== "conflict") {
    // Expected, permanent rejection by the authority (e.g. mailbox closed): record and stop replay.
    await journal.markRejected(m.ingestionId);
    // Erased mid-ingest: remove the body and parts this message just wrote under the mailbox.
    if (result.code === "gone") await purgeIngestWrites(env, m);
    console.warn(
      JSON.stringify({
        level: "warn",
        op: "ingest.rejected",
        ingestionId: m.ingestionId,
        code: result.code,
      }),
    );
    return;
  }
  await journal.markCommitted(m.ingestionId);
  metric("ingest.committed", 1, { path: "inline" });
};

// Usage deltas count an object once: retries and journal replays re-put the same key (idempotent
// content), so bytes are recorded only when the object didn't already exist.
const storePart = async (
  env: CoreEnv,
  m: IngestMessage,
  part: { readonly partId: string; readonly filename: string; readonly content: Uint8Array },
) => {
  const key = blobKey.part(m.mailboxId, m.ingestionId, part.partId);
  const existed = await env.PARTS.head(key);
  await env.PARTS.put(key, part.content, { customMetadata: { filename: part.filename } });
  if (!existed) await recordUsage(env, "mailbox", m.mailboxId, "parts", part.content.byteLength);
};

/** `inline` entry for a stored body: parts with a Content-ID, keyed to where storePart puts them. */
const inlineMap = (
  m: IngestMessage,
  attachments: ReadonlyArray<{ readonly partId: string; readonly contentId?: string | undefined }>,
): { inline?: Record<string, string> } => {
  const entries = attachments
    .filter((a) => a.contentId)
    .map((a) => [a.contentId!, blobKey.part(m.mailboxId, m.ingestionId, a.partId)] as const);
  return entries.length ? { inline: Object.fromEntries(entries) } : {};
};

/** Blobs one ingest writes under the mailbox prefix (body + extracted parts) and their usage. */
const purgeIngestWrites = async (env: CoreEnv, m: IngestMessage): Promise<void> => {
  const prefix = `t/${m.mailboxId}/part/${m.ingestionId}/`;
  for (;;) {
    const listed = await env.PARTS.list({ prefix, limit: 1000 });
    if (listed.objects.length) await env.PARTS.delete(listed.objects.map((o) => o.key));
    if (!listed.truncated) break;
  }
  await env.PARTS.delete(bodyKeyFor(m.objectKey));
  await env.DIRECTORY.prepare(
    "DELETE FROM storage_usage WHERE owner_kind = 'mailbox' AND owner_id = ?",
  )
    .bind(m.mailboxId)
    .run();
};

/** Erased mailbox (tombstone): permanent, never write anything for it (§12). */
const rejectErased = async (env: CoreEnv, m: IngestMessage): Promise<boolean> => {
  if (!(await mailboxErased(env, m.mailboxId))) return false;
  await env.INGRESS_JOURNALS.getByName(journalPartition(m.ingestionId)).markRejected(m.ingestionId);
  console.warn(
    JSON.stringify({ level: "warn", op: "ingest.mailbox-erased", ingestionId: m.ingestionId }),
  );
  return true;
};

const ingest = async (env: CoreEnv, m: IngestMessage): Promise<void> => {
  const journal = env.INGRESS_JOURNALS.getByName(journalPartition(m.ingestionId));
  if (await rejectErased(env, m)) return;
  const head = await env.ORIGINALS.head(m.objectKey);
  if (!head) {
    // Permanent: the original was erased or never stored. Stop replay instead of retrying forever.
    await journal.markRejected(m.ingestionId);
    console.warn(
      JSON.stringify({ level: "warn", op: "ingest.original-missing", ingestionId: m.ingestionId }),
    );
    return;
  }
  // Exceptional inputs go to the bounded MIME container instead of the isolate (§5.1 step 5).
  if (head.size > MIME_INLINE_MAX_BYTES) {
    await env.PARSE_SCAN.send({ ...m, type: "parse-scan" }, { contentType: "json" });
    metric("ingest.offloaded", 1);
    return;
  }
  const object = await env.ORIGINALS.get(m.objectKey);
  if (!object) return ingest(env, m);
  const parsed = parseMessage(new Uint8Array(await object.arrayBuffer()));
  const summary = summarizeMessage(parsed, m.receivedAt);

  // Inline parts are mapped cid → stored part so the render origin can serve them.
  await storeBody(env, m.mailboxId, m.objectKey, {
    ...sanitizedBody(parsed.text ?? "", parsed.html),
    ...inlineMap(m, parsed.attachments),
  });
  // Sequential, one part at a time (bounded memory and concurrency, §7.4).
  for (const a of parsed.attachments) {
    const part = parsed.parts.find((p) => p.partId === a.partId);
    if (part)
      await storePart(env, m, { partId: a.partId, filename: a.filename, content: part.content });
  }
  await commitParsed(env, m, summary, safetyVerdict(parsed));
};

/** ParseScan queue: the container parses; parts stream to R2 one at a time. */
const ingestViaContainer = async (env: CoreEnv, m: IngestMessage): Promise<void> => {
  if (await rejectErased(env, m)) return;
  const meta = await parseViaContainer(env, m.objectKey, m.receivedAt, (part) =>
    storePart(env, m, part),
  );
  await storeBody(env, m.mailboxId, m.objectKey, {
    ...meta.body,
    ...inlineMap(m, meta.attachments),
  });
  const safety = safetyVerdict({
    headers: meta.headers,
    attachments: meta.attachments,
    truncated: meta.truncated,
  } as never);
  await commitParsed(env, m, meta.summary, safety);
  metric("ingest.committed", 1, { path: "container" });
};

const index = async (env: CoreEnv, m: Extract<QueueMessage, { type: "index" }>): Promise<void> => {
  const mailbox = env.MAILBOXES.getByName(m.source.mailboxId);
  const target = await mailbox.indexTarget(m.source.kind, m.source.id);
  const shardName = target.shard ?? `search:${m.source.mailboxId}`;
  const shard = env.SEARCH_SHARDS.getByName(shardName);
  // Erasure fence: a document hydrated before the authority was erased must not land in a shard
  // that erasure already cleared (clear() also drops the version rows that would reject it).
  if (target.doc && (await mailboxErased(env, m.source.mailboxId, "first-unconstrained"))) return;
  if (target.doc) await shard.upsert(target.doc);
  else await shard.remove(target.docKey, target.seq);
  await shard.setWatermark(target.seq);
  await mailbox.ackIndexed(target.docKey, target.seq);
  const health = await shard.health();
  await mailbox.recordShardHealth(shardName, health.storedBytes);
};

export const handleQueueMessage = async (
  env: CoreEnv,
  body: unknown,
  attempt = 1,
): Promise<void> => {
  // Shapes outside the versioned QueueMessage union: provider lifecycle events and ParseScan jobs.
  const providerEvent = parseProviderEvent(body);
  if (providerEvent) {
    await handleProviderEvent(env, providerEvent);
    return;
  }
  if (
    typeof body === "object" &&
    body !== null &&
    (body as { type?: unknown }).type === "parse-scan"
  ) {
    return ingestViaContainer(
      env,
      decode({ ...(body as object), type: "ingest" }) as IngestMessage,
    );
  }
  const message = decode(body);
  switch (message.type) {
    case "ingest":
      return ingest(env, message);
    case "dispatch": {
      const adapters = await buildTransportAdapters(env, message.mailboxId);
      return Effect.runPromise(
        renderAndDispatch(message.mailboxId, message.sendJobId).pipe(
          Effect.provide(dispatchLayers(env, message.mailboxId, adapters)),
        ),
      );
    }
    case "index":
      return index(env, message);
    case "notify":
      return handleNotify(env, message);
    case "propagate":
      return dispatchPropagate(env, message, attempt);
  }
};

export const handleQueueBatch = async (
  batch: MessageBatch<unknown>,
  env: CoreEnv,
): Promise<void> => {
  // DLQs are drained into D1 for inspection and validated replay (§6).
  if (isDeadLetterQueue(batch.queue)) return captureDeadLetters(batch, env);
  let ok = 0;
  let failed = 0;
  for (const msg of batch.messages) {
    try {
      const ref = isQueueRef(msg.body) ? msg.body : null;
      const body = ref ? await resolveQueueRef(env, ref) : msg.body;
      if (body === QUEUE_REF_GONE) {
        // The payload object is deleted only after a successful ack, so a missing reference on
        // redelivery means an earlier attempt already processed (and released) it. Retrying would
        // only fail until the DLQ; ack it as done.
        console.warn(
          JSON.stringify({
            level: "warn",
            op: "queue.ref-missing",
            queue: batch.queue,
            attempts: msg.attempts,
          }),
        );
        msg.ack();
        ok++;
        continue;
      }
      await handleQueueMessage(env, body, msg.attempts);
      msg.ack();
      if (ref) await releaseQueueRef(env, ref).catch(() => undefined);
      ok++;
    } catch (error) {
      failed++;
      console.error(
        JSON.stringify({
          level: "error",
          op: "queue.message",
          queue: batch.queue,
          attempts: msg.attempts,
          error: describeError(error),
        }),
      );
      msg.retry({ delaySeconds: Math.min(300, 10 * 2 ** Math.min(msg.attempts, 5)) });
    }
  }
  metric("queue.batch", batch.messages.length, { ok, failed });
};
