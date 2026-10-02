// Mailbox, search, drafts, uploads and sending routes (§8, E01–E24). The JSON API is the "mail"
// HttpApi group (../spec/mail.ts); downloads, vCard import/export, part uploads and public file
// links stay native routes (binary or streamed bodies, or no credential).
import { Effect, type Types, Predicate } from "effect";
import {
  blobKey,
  ingestionIdOf,
  executeMailboxCommand,
  Forbidden,
  NotFound,
  Principal,
  readMailboxChanges,
  readMailboxQuery,
  readMailboxThread,
  readMailboxView,
  type RequestPayload,
  requireMailbox,
  type Scope,
} from "@bye/application";
import {
  ApiError,
  MailAttachmentZipRequest,
  type MailboxCommand,
  type MailViewQuery,
} from "@bye/contracts";
import { htmlToReadableText, parseVCards, serializeVCards, type VCard } from "@bye/mail-codec";
import {
  authorizeSearchResults,
  type MailboxReadQuery,
  safeZipName,
  type SearchPage,
  zipStream,
} from "@bye/platform-cloudflare";
import { HttpApiBuilder } from "effect/http-api";
import { call, mailbox } from "../authorities.ts";
import { bodyKeyFor, type StoredBody } from "../objects.ts";
import type { CoreEnv } from "../env.ts";
import { errorResponse, Invocation, route, type Route } from "../http.ts";
import { ok, publicly } from "../httpapi.ts";
import { downloadToken, previewToken, renderToken } from "../render.ts";
import { CoreApi } from "../spec/index.ts";
import { authed, authedBody, readTextCapped } from "./common.ts";

// ---------------------------------------------------------------------------- helpers

/** Typed read through the mailbox authority (scope already checked by the caller). */
const readMailbox = <A = unknown>(env: CoreEnv, mailboxId: string, query: MailboxReadQuery) =>
  call(() => mailbox(env, mailboxId).read(query)) as Effect.Effect<A, ApiError>;

/** Optional number query parameter: absent, empty or non-numeric reads as absent. */
const num = (v: string | undefined): number | undefined =>
  v === undefined || v === "" || !Number.isFinite(Number(v)) ? undefined : Number(v);

/** Optional, clamped string query parameter (empty reads as absent). */
const clamp = (v: string | undefined, max = 256): string | undefined =>
  v ? v.slice(0, max) : undefined;

/** Upload part size returned by reserve; the last part may be smaller (R2 multipart minimum is 5 MiB). */
const MAIL_UPLOAD_PART_BYTES = 8 * 1024 * 1024;

const MAX_UNIFIED_MAILBOXES = 10;

const MAX_SEARCH_SHARDS = 24;

const ZIP_MAX_BYTES = 200 * 1024 * 1024;

const CONTACT_IMPORT_MAX_BYTES = 1024 * 1024;

/** Characters of plain-text body returned per message (larger bodies say `truncated`). */
const TEXT_BODY_MAX_CHARS = 1_000_000;

const downloadHeaders = (filename: string, size?: number): Record<string, string> => {
  const headers = {
    "content-type": "application/octet-stream",
    "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; sandbox",
    "cache-control": "private, no-store",
  };

  return size !== undefined ? { ...headers, "content-length": String(size) } : headers;
};

/** Command IDs for body-less or non-JSON writes come from the Idempotency-Key header (§8). */
const idempotencyKey = (request: Request): string | null => {
  const k = request.headers.get("idempotency-key");

  return k && /^[A-Za-z0-9_.:-]{8,64}$/.test(k) ? k : null;
};

type AttachmentAccess = { readonly allowed: boolean; readonly status: string };

/**
 * The one attachment gate (E20): only clean-scanned parts are served. `pending` is a retryable
 * conflict unless `pendingIs` says otherwise (a zip of several parts refuses outright).
 */
const requireAttachmentAccess = (
  access: AttachmentAccess,
  pendingIs: "conflict" | "forbidden" = "conflict",
) =>
  access.allowed
    ? Effect.void
    : Effect.fail(
        new ApiError({
          code: access.status === "pending" ? pendingIs : "forbidden",
          message:
            access.status === "pending"
              ? "attachment is still being scanned"
              : `attachment blocked: scan ${access.status}`,
          details: { scanStatus: access.status },
        }),
      );

/** A command or read the authority answered with nothing answers `{ ok: true }`. */
const orOk = <A>(value: A) => value ?? ok;

/** One mailbox command (decoded, guarded and scope-checked by the application). */
const command = (mailboxId: string, raw: RequestPayload) =>
  executeMailboxCommand(mailboxId, raw).pipe(Effect.map(orOk));

/** One plain authority read, authorized for `scope` on the mailbox, answered as returned. */
const authorityRead = (mailboxId: string, query: MailboxReadQuery, scope: Scope = "read") =>
  readMailboxQuery(mailboxId, query, scope).pipe(Effect.map(orOk), publicly);

// ---------------------------------------------------------------------------- native routes

export const mailRoutes: ReadonlyArray<Route> = [
  // ---- contacts (E16): vCard export and import ----
  route(
    "GET",
    "/v1/mailboxes/:id/contacts/export.vcf",
    authed(
      ({ params }) =>
        Effect.gen(function* () {
          const { items } = yield* readMailboxQuery<{
            items: ReadonlyArray<{
              contactId: string;
              name: string;
              emails: ReadonlyArray<string>;
              notes: string;
              groups: ReadonlyArray<string>;
            }>;
          }>(params.id!, { _tag: "ExportContacts" });

          const cards: Array<VCard> = items.map((c) => ({
            version: "4.0",
            uid: c.contactId,
            fn: c.name,
            n: undefined,
            emails: c.emails.map((value) => ({ value, types: [] })),
            tels: [],
            org: undefined,
            note: c.notes || undefined,
            categories: c.groups,
          }));

          return serializeVCards(cards);
        }),
      {
        raw: (text) =>
          new Response(text, {
            headers: {
              ...downloadHeaders("contacts.vcf"),
              "content-type": "text/vcard; charset=utf-8",
            },
          }),
      },
    ),
  ),
  route(
    "POST",
    "/v1/mailboxes/:id/contacts/import",
    authed(
      ({ params, request }) =>
        Effect.gen(function* () {
          yield* requireMailbox(params.id!, "draft");
          const key = idempotencyKey(request);

          if (!key)
            return yield* new ApiError({
              code: "bad_request",
              message: "Idempotency-Key header required",
            });

          // Streaming cap: an oversized (or unannounced chunked) upload is cancelled, never buffered.
          const text = yield* Effect.promise(() =>
            readTextCapped(request, CONTACT_IMPORT_MAX_BYTES),
          );

          if (text === null)
            return yield* new ApiError({
              code: "payload_too_large",
              message: "vCard file too large",
            });
          const cards = parseVCards(text);

          const contacts = cards
            .map((c) => {
              const name = c.fn || c.emails[0]?.value || "Unnamed";

              const emails = c.emails
                .map((e) => e.value.trim().toLowerCase())
                .filter((e) => /^[^\s@<>()",;]+@[^\s@<>()",;]+$/.test(e));

              return c.note ? { name, emails, notes: c.note.slice(0, 20_000) } : { name, emails };
            })
            .filter((c) => c.emails.length > 0)
            .slice(0, 5000);

          return yield* executeMailboxCommand(params.id!, {
            _tag: "ImportContacts",
            commandId: key,
            contacts,
          });
        }),
      { rawBody: true },
    ),
  ),

  // ---- uploads (§8 `/v1/uploads`, E20): the part body streams straight to R2 multipart ----
  route(
    "PUT",
    "/v1/uploads/:uploadId/parts/:part",
    authed(
      ({ params, url, request, env }) =>
        Effect.gen(function* () {
          const mailboxId = url.searchParams.get("mailbox") ?? "";
          yield* requireMailbox(mailboxId, "draft");
          const partNumber = Number(params.part);

          if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10_000)
            return yield* new ApiError({ code: "bad_request", message: "invalid part number" });
          const length = Number(request.headers.get("content-length") ?? "-1");

          if (!(length > 0) || length > MAIL_UPLOAD_PART_BYTES * 2)
            return yield* new ApiError({
              code: "payload_too_large",
              message: "part must declare a content-length within the part size",
            });
          const stub = mailbox(env, mailboxId);

          const state = yield* readMailbox<{
            state: string;
            blobKey: string;
            declaredSize: number;
          }>(env, mailboxId, { _tag: "Upload", uploadId: params.uploadId! });

          if (state.state !== "reserved" && state.state !== "uploading")
            return yield* new ApiError({ code: "conflict", message: `upload is ${state.state}` });
          const { r2UploadId } = yield* Effect.promise(() => stub.uploadParts(params.uploadId!));

          if (!r2UploadId || !request.body)
            return yield* new ApiError({ code: "conflict", message: "upload session missing" });
          const mp = env.PARTS.resumeMultipartUpload(state.blobKey, r2UploadId);

          const uploaded = yield* Effect.promise(() =>
            mp.uploadPart(partNumber, request.body as ReadableStream),
          );

          const after = yield* Effect.promise(() =>
            stub.recordUploadPart(params.uploadId!, partNumber, length, uploaded.etag),
          );

          if (after?.state === "failed") {
            yield* Effect.promise(() => mp.abort());

            return yield* new ApiError({
              code: "payload_too_large",
              message: "upload exceeds its declared size",
            });
          }

          return { part: partNumber, etag: uploaded.etag };
        }),
      { rawBody: true },
    ),
  ),

  // ---- attachments (E20) ----
  route(
    "GET",
    "/v1/mailboxes/:id/deliveries/:deliveryId/attachments/:partId",
    authed(
      ({ params, env }) =>
        Effect.gen(function* () {
          yield* requireMailbox(params.id!, "read");
          const stub = mailbox(env, params.id!);
          const delivery = yield* Effect.promise(() => stub.delivery(params.deliveryId!));
          const attachment = delivery?.attachments.find((a) => a.partId === params.partId);

          if (!delivery || !attachment) return yield* new NotFound({ resource: "attachment" });
          yield* requireAttachmentAccess(
            yield* Effect.promise(() => stub.attachmentAccess(params.deliveryId!)),
          );

          const object = yield* Effect.promise(() =>
            env.PARTS.get(
              blobKey.part(params.id!, ingestionIdOf(delivery.messageKey), attachment.partId),
            ),
          );

          if (!object) return yield* new NotFound({ resource: "attachment" });

          return { object, attachment };
        }),
      {
        raw: ({ object, attachment }) =>
          new Response(object.body, { headers: downloadHeaders(attachment.filename, object.size) }),
      },
    ),
  ),
  // Bulk download: bounded, clean-scanned only, streamed as a stored ZIP.
  route(
    "POST",
    "/v1/mailboxes/:id/attachments/zip",
    authedBody(
      MailAttachmentZipRequest,
      ({ params, body, env }) =>
        Effect.gen(function* () {
          yield* requireMailbox(params.id!, "read");
          const stub = mailbox(env, params.id!);

          const resolved = yield* Effect.forEach(
            body.items,
            (i) => Effect.promise(() => stub.attachmentFor(i.deliveryId, i.partId)),
            { concurrency: 8 },
          );

          let total = 0;
          const used = new Set<string>();
          const entries = [];

          for (const a of resolved) {
            if (!a) return yield* new NotFound({ resource: "attachment" });
            // A zip never waits for pending scans: anything not clean refuses the whole selection.
            yield* requireAttachmentAccess(a.access, "forbidden");
            total += a.size;

            if (total > ZIP_MAX_BYTES)
              return yield* new ApiError({
                code: "payload_too_large",
                message: "selection too large to zip",
              });
            entries.push(a);
          }

          return entries.map((a, idx) => ({
            name: safeZipName(a.filename, used),
            modified: a.date,
            open: async () =>
              (
                await env.PARTS.get(
                  blobKey.part(params.id!, ingestionIdOf(a.messageKey), body.items[idx]!.partId),
                )
              )?.body ?? null,
          }));
        }),
      {
        raw: (entries) =>
          new Response(zipStream(entries), {
            headers: { ...downloadHeaders("attachments.zip"), "content-type": "application/zip" },
          }),
      },
    ),
  ),

  // ---- large-file links (E20): public, token-checked on every request, revocable, expiring ----
  route("GET", "/v1/files/:mailboxId/:token", async (request, params, env) => {
    const ip = request.headers.get("cf-connecting-ip") ?? "anon";
    const limited = await env.AUTH_RATE_LIMIT.limit({ key: `files:${ip}` });

    if (!limited.success) return errorResponse("rate_limited", "slow down");

    if (
      !/^[A-Za-z0-9_]{4,64}$/.test(params.mailboxId ?? "") ||
      !/^[A-Za-z0-9_.-]{8,160}$/.test(params.token ?? "")
    )
      return errorResponse("not_found", "not found");
    const link = await mailbox(env, params.mailboxId!).resolveFileLink(params.token!);

    if (!link) return errorResponse("not_found", "link expired or revoked");
    const object = await env.PARTS.get(link.blobKey);

    if (!object) return errorResponse("not_found", "not found");

    return new Response(object.body, {
      headers: { ...downloadHeaders(link.filename, object.size), "x-robots-tag": "noindex" },
    });
  }),
];

// ---------------------------------------------------------------------------- JSON API

export const MailHandlers = HttpApiBuilder.group(CoreApi, "mail", (handlers) =>
  handlers
    // ---- views and threads (E04–E06, E10, E11) ----
    .handle("getView", ({ params, query }) => {
      const paging: Types.Mutable<Omit<MailViewQuery, "view">> = {};

      if (query.label) paging.label = query.label;

      if (query.cursor) paging.cursor = query.cursor;

      if (query.limit) paging.limit = Number(query.limit);

      return readMailboxView(params.id, { view: params.view, ...paging }).pipe(publicly);
    })
    .handle("getThread", ({ params }) =>
      Effect.gen(function* () {
        const { env } = yield* Invocation;

        // The authority's thread detail is untyped over RPC; only the delivery IDs are read here,
        // every other key passes through (`MailRenderableDelivery`).
        const detail = (yield* readMailboxThread(params.id, params.threadId)) as {
          readonly thread: unknown;
          readonly deliveries: ReadonlyArray<{ readonly deliveryId: string }>;
          readonly mergeHistory: unknown;
        };

        const now = Date.now();

        // Render tokens are short-lived capabilities for the separate render origin (§10).
        const deliveries = yield* Effect.forEach(
          detail.deliveries,
          (d) =>
            Effect.promise(() => renderToken(env, params.id, d.deliveryId, now)).pipe(
              Effect.map((token) => ({
                ...d,
                renderToken: token,
                renderUrl: `${env.MAIL_ORIGIN}/render/${token}`,
              })),
            ),
          { concurrency: 8 },
        );

        return { ...detail, deliveries };
      }).pipe(publicly),
    )
    .handle("getDeliveryText", ({ params }) =>
      Effect.gen(function* () {
        const { env } = yield* Invocation;
        yield* requireMailbox(params.id, "read");

        const renderable = yield* Effect.promise(() =>
          mailbox(env, params.id).renderable(params.deliveryId),
        );

        if (!renderable) return yield* new NotFound({ resource: "delivery" });

        const object = yield* Effect.promise(() =>
          env.PARTS.get(bodyKeyFor(renderable.messageKey)),
        );

        // A missing body (purged, or not yet stored) is reported, never shown as an empty message.
        if (!object) return yield* new NotFound({ resource: "message body" });
        const stored = (yield* Effect.promise(() => object.json())) as StoredBody;
        const converted = !stored.text.trim() && stored.html !== null;
        const text = converted ? htmlToReadableText(stored.html!) : stored.text;
        const truncated = text.length > TEXT_BODY_MAX_CHARS;
        let cut = truncated ? text.slice(0, TEXT_BODY_MAX_CHARS) : text;

        // Never end on half of a surrogate pair (an emoji cut in two).
        if (truncated && /[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);

        return {
          schemaVersion: 1 as const,
          deliveryId: params.deliveryId,
          text: cut,
          truncated,
          source: converted ? ("html" as const) : ("text" as const),
          hasHtml: stored.html !== null,
        };
      }).pipe(publicly),
    )
    .handle("getFeed", ({ params, query }) =>
      Effect.gen(function* () {
        const { env } = yield* Invocation;
        const feedLimit = Math.min(num(query.limit) ?? 20, 50);

        const page = yield* readMailboxView(
          params.id,
          query.cursor
            ? { view: "feed", limit: feedLimit, cursor: query.cursor }
            : { view: "feed", limit: feedLimit },
        );

        const now = Date.now();
        const stub = mailbox(env, params.id);

        const items = yield* Effect.forEach(
          page.items,
          (thread) =>
            Effect.gen(function* () {
              const t = (yield* Effect.promise(() => stub.thread(thread.threadId))) as {
                ok: boolean;
                value?: {
                  deliveries: ReadonlyArray<{
                    deliveryId: string;
                    from: unknown;
                    date: number;
                    subject: string;
                  }>;
                };
              };

              const latest = t.ok ? t.value?.deliveries.at(-1) : undefined;

              if (!latest) return { thread, latest: null };

              const token = yield* Effect.promise(() =>
                renderToken(env, params.id, latest.deliveryId, now),
              );

              return {
                thread,
                latest: {
                  deliveryId: latest.deliveryId,
                  from: latest.from,
                  date: latest.date,
                  subject: latest.subject,
                  renderUrl: `${env.MAIL_ORIGIN}/render/${token}`,
                },
              };
            }),
          { concurrency: 6 },
        );

        return {
          items,
          nextCursor: page.nextCursor,
          boundary: page.boundary,
          position: page.position ?? null,
          previousVisitAt: page.previousVisitAt ?? 0,
        };
      }).pipe(publicly),
    )
    .handle("getUnifiedView", ({ params, query }) =>
      Effect.gen(function* () {
        const { env } = yield* Invocation;
        const principal = yield* Principal;

        if (!principal.scopes.includes("read"))
          return yield* new Forbidden({ reason: "missing scope read" });
        const limit = Math.min(num(query.limit) ?? 50, 100);

        const cursors = (() => {
          try {
            return JSON.parse(atob(query.cursor ?? "") || "{}") as Record<string, string | null>;
          } catch {
            return {} as Record<string, string | null>;
          }
        })();

        // Cursor map: mailboxId → resume cursor ("" = from the start); absent = exhausted.
        const first = !query.cursor;

        const mailboxes = principal.mailboxIds
          .slice(0, MAX_UNIFIED_MAILBOXES)
          .filter((m) => first || Predicate.isString(cursors[m]));

        const pages = yield* Effect.forEach(
          mailboxes,
          (mailboxId) =>
            Effect.gen(function* () {
              const mailboxCursor = cursors[mailboxId];

              const page = yield* readMailboxView(
                mailboxId,
                mailboxCursor
                  ? { view: params.view, limit, cursor: mailboxCursor }
                  : { view: params.view, limit },
              );

              const ids = (yield* readMailbox<{
                items: ReadonlyArray<{ address: string; name: string | null; isDefault: boolean }>;
              }>(env, mailboxId, { _tag: "Identities" })).items;

              const primary = ids.find((i) => i.isDefault) ?? ids[0];

              return {
                mailboxId,
                page,
                identity: primary ? { address: primary.address, name: primary.name } : null,
              };
            }),
          { concurrency: 4 },
        );

        // Merge by each view's own sort key and direction, take exactly `limit`, and resume every
        // mailbox right after the last item it contributed (items not shown are fetched again later).
        const ascending = pages.find((p) => p.page.order)?.page.order?.ascending ?? false;

        const candidates = pages.flatMap((p) =>
          p.page.items.map((thread, i) => ({
            mailboxId: p.mailboxId,
            identity: p.identity,
            thread,
            index: i,
            key: p.page.order?.keys[i] ?? thread.lastActivityAt,
          })),
        );

        candidates.sort(
          (a, b) =>
            (ascending ? a.key - b.key : b.key - a.key) ||
            (a.thread.threadId < b.thread.threadId ? (ascending ? -1 : 1) : ascending ? 1 : -1),
        );
        const taken = candidates.slice(0, limit);
        const next: Record<string, string> = {};

        for (const p of pages) {
          const used = taken.filter((t) => t.mailboxId === p.mailboxId);

          if (used.length === p.page.items.length) {
            if (p.page.nextCursor) next[p.mailboxId] = p.page.nextCursor;
          } else if (used.length === 0) {
            next[p.mailboxId] = cursors[p.mailboxId] ?? "";
          } else {
            const lastIndex = Math.max(...used.map((t) => t.index));
            const resume = p.page.order?.cursors[lastIndex];

            if (resume) next[p.mailboxId] = resume;
          }
        }

        const items = taken.map(({ mailboxId, identity, thread }) => ({
          mailboxId,
          identity,
          thread,
        }));

        return {
          view: params.view,
          items,
          cursors: next,
          cursor: Object.keys(next).length ? btoa(JSON.stringify(next)) : null,
        };
      }).pipe(publicly),
    )

    // ---- commands ----
    .handle("executeCommand", ({ params, payload }) => command(params.id, payload).pipe(publicly))

    // ---- search (§8, E21): fan out over the mailbox's shards, merge by date, rehydrate ----
    .handle("search", ({ params, query }) =>
      Effect.gen(function* () {
        const { env } = yield* Invocation;
        const principal = yield* requireMailbox(params.id, "read");
        const q = (query.q ?? "").slice(0, 1024);
        const limit = Math.min(100, Math.max(1, num(query.limit) ?? 25));
        const cursor = query.cursor;
        const stub = mailbox(env, params.id);
        const shards = (yield* Effect.promise(() => stub.searchShards())).slice(-MAX_SEARCH_SHARDS);

        const pages: Array<SearchPage> = yield* Effect.forEach(
          shards,
          // A shard refusal (bad cursor, too many terms) is the client's 400, not a 500.
          (s) =>
            call(() =>
              env.SEARCH_SHARDS.getByName(s.name).candidates(
                q,
                cursor ? { limit, cursor } : { limit },
              ),
            ),
          { concurrency: 4 },
        );

        // Merge (de-duplicated) by stable date ordering, then rehydrate/reauthorize (never compare
        // shard scores). The cursor comes from the same merged page the results do.
        const { results, last, more } = yield* Effect.promise(() =>
          authorizeSearchResults(pages, (candidates) => stub.searchHits(candidates, q), limit),
        );

        const indexing = yield* Effect.promise(() => stub.indexWatermark());

        // Recording the query is a write to the mailbox: only for credentials that may triage it.
        // Read-only credentials (agents, support sessions) search without leaving history behind.
        if (q.trim() && !cursor && principal.scopes.includes("screen"))
          yield* readMailbox(env, params.id, { _tag: "RecordSearch", query: q });

        return {
          results,
          nextCursor: more && last ? btoa(JSON.stringify({ d: last.date, id: last.docId })) : null,
          watermark: indexing.watermark,
          lagging: indexing.lagging,
        };
      }).pipe(publicly),
    )
    .handle("listChanges", ({ query }) =>
      readMailboxChanges(query.mailbox ?? "", Number(query.cursor ?? "0")).pipe(publicly),
    )
    .handle("revokeGrant", ({ params, query }) =>
      Effect.gen(function* () {
        const { request } = yield* Invocation;

        return yield* command(query.mailbox ?? "", {
          _tag: "RevokeFileLink",
          commandId: idempotencyKey(request) ?? `revoke:${params.grantId}`,
          linkId: params.grantId,
        });
      }).pipe(publicly),
    )
    .handle("getQuota", ({ params }) =>
      Effect.gen(function* () {
        const { env } = yield* Invocation;
        yield* requireMailbox(params.id, "read");
        // Include parts, bodies and exports (D1 accounting) in what the quota reports (§12).
        yield* Effect.promise(() => mailbox(env, params.id).refreshExternalUsage());

        return orOk(yield* readMailbox(env, params.id, { _tag: "Quota" }));
      }).pipe(publicly),
    )

    // ---- drafts and sending (E17/E18) ----
    .handle("createDraft", ({ payload }) => {
      const draft = {
        _tag: "CreateDraft",
        commandId: payload.commandId,
        content: payload.content,
      } as const;

      return command(
        payload.mailboxId,
        payload.threadId ? { ...draft, threadId: payload.threadId } : draft,
      ).pipe(publicly);
    })
    .handle("saveDraft", ({ params, payload }) =>
      command(payload.mailboxId, {
        _tag: "SaveDraft",
        commandId: payload.commandId,
        draftId: params.id,
        expectedRevision: payload.expectedRevision,
        content: payload.content,
      }).pipe(publicly),
    )
    .handle("sendDraft", ({ params, payload }) => {
      const send: Types.Mutable<Extract<MailboxCommand, { _tag: "Send" }>> = {
        _tag: "Send",
        commandId: payload.commandId,
        draftId: params.id,
        expectedRevision: payload.revision,
      };

      if (payload.sendAt) send.sendAt = payload.sendAt;

      if (payload.individually) send.individually = true;

      if (payload.afterSend !== undefined) send.afterSend = payload.afterSend;

      return command(payload.mailboxId, send).pipe(publicly);
    })
    .handle("cancelSend", ({ params, payload }) =>
      command(payload.mailboxId, {
        _tag: "CancelSend",
        commandId: payload.commandId,
        sendJobId: params.id,
      }).pipe(publicly),
    )
    .handle("getDraft", ({ params }) =>
      Effect.gen(function* () {
        const { env } = yield* Invocation;
        yield* requireMailbox(params.id, "draft");
        const draft = yield* Effect.promise(() => mailbox(env, params.id).draft(params.draftId));

        if (!draft) return yield* new NotFound({ resource: "draft" });

        return draft;
      }).pipe(publicly),
    )

    // ---- uploads (§8 `/v1/uploads`, E20): reserve → PUT parts (R2 multipart) → complete ----
    .handle("reserveUpload", ({ payload }) =>
      Effect.gen(function* () {
        const { env } = yield* Invocation;
        // The quota decision counts parts, bodies and exports too (§12): refresh them first.
        yield* requireMailbox(payload.mailboxId, "draft");
        const stub = mailbox(env, payload.mailboxId);
        yield* Effect.promise(() => stub.refreshExternalUsage());

        const reserved = (yield* executeMailboxCommand(payload.mailboxId, {
          _tag: "ReserveUpload",
          commandId: payload.commandId,
          filename: payload.filename,
          contentType: payload.contentType || "application/octet-stream",
          declaredSize: payload.declaredSize,
        })) as { uploadId: string; blobKey: string };

        const existing = yield* Effect.promise(() => stub.uploadParts(reserved.uploadId));

        if (!existing.r2UploadId) {
          const mp = yield* Effect.promise(() =>
            env.PARTS.createMultipartUpload(reserved.blobKey, {
              customMetadata: { filename: payload.filename.slice(0, 255) },
            }),
          );

          yield* Effect.promise(() => stub.setUploadR2Id(reserved.uploadId, mp.uploadId));
        }

        return {
          uploadId: reserved.uploadId,
          partSize: MAIL_UPLOAD_PART_BYTES,
          maxParts: 10_000,
        };
      }).pipe(publicly),
    )
    .handle("completeUpload", ({ params, payload }) =>
      Effect.gen(function* () {
        const { env } = yield* Invocation;
        const { mailboxId, commandId } = payload;
        yield* requireMailbox(mailboxId, "draft");
        const stub = mailbox(env, mailboxId);

        const state = yield* readMailbox<{ blobKey: string; declaredSize: number }>(
          env,
          mailboxId,
          { _tag: "Upload", uploadId: params.uploadId },
        );

        const { r2UploadId, parts } = yield* Effect.promise(() =>
          stub.uploadParts(params.uploadId),
        );

        if (parts.length === 0 && state.declaredSize === 0) {
          // An empty file has no parts to upload: store the empty object directly (R2 multipart
          // needs at least one part), then verify and scan like any other upload.
          if (r2UploadId)
            yield* Effect.promise(() =>
              env.PARTS.resumeMultipartUpload(state.blobKey, r2UploadId)
                .abort()
                .catch(() => undefined),
            );
          yield* Effect.promise(() => env.PARTS.put(state.blobKey, new Uint8Array(0)));

          return yield* command(mailboxId, {
            _tag: "CompleteUpload",
            commandId,
            uploadId: params.uploadId,
            actualSize: 0,
          });
        }

        if (!r2UploadId || parts.length === 0)
          return yield* new ApiError({ code: "conflict", message: "no parts uploaded" });
        const mp = env.PARTS.resumeMultipartUpload(state.blobKey, r2UploadId);
        yield* Effect.promise(() =>
          mp.complete(parts.map((p) => ({ partNumber: p.n, etag: p.etag }))),
        );
        // Verify the ACTUAL stored size against the declaration before scanning (§10).
        const head = yield* Effect.promise(() => env.PARTS.head(state.blobKey));

        if (!head) return yield* new ApiError({ code: "conflict", message: "upload not stored" });

        return yield* command(mailboxId, {
          _tag: "CompleteUpload",
          commandId,
          uploadId: params.uploadId,
          actualSize: head.size,
        });
      }).pipe(publicly),
    )
    .handle("abortUpload", ({ params, payload }) =>
      Effect.gen(function* () {
        const { env } = yield* Invocation;
        const { mailboxId, commandId } = payload;
        yield* requireMailbox(mailboxId, "draft");

        const state = yield* readMailbox<{ blobKey: string }>(env, mailboxId, {
          _tag: "Upload",
          uploadId: params.uploadId,
        });

        const { r2UploadId } = yield* Effect.promise(() =>
          mailbox(env, mailboxId).uploadParts(params.uploadId),
        );

        if (r2UploadId)
          yield* Effect.promise(() =>
            env.PARTS.resumeMultipartUpload(state.blobKey, r2UploadId)
              .abort()
              .catch(() => undefined),
          );

        return yield* command(mailboxId, {
          _tag: "AbortUpload",
          commandId,
          uploadId: params.uploadId,
        });
      }).pipe(publicly),
    )

    // ---- attachments (E20) ----
    .handle("createAttachmentLink", ({ params }) =>
      Effect.gen(function* () {
        const { env } = yield* Invocation;
        yield* requireMailbox(params.id, "read");

        const a = yield* Effect.promise(() =>
          mailbox(env, params.id).attachmentFor(params.deliveryId, params.partId),
        );

        if (!a) return yield* new NotFound({ resource: "attachment" });
        yield* requireAttachmentAccess(a.access);

        const token = yield* Effect.promise(() =>
          downloadToken(env, params.id, params.deliveryId, params.partId, Date.now()),
        );

        return { downloadUrl: `${env.MAIL_ORIGIN}/render/${token}`, expiresInSeconds: 300 };
      }).pipe(publicly),
    )
    .handle("getAttachmentPreview", ({ params }) =>
      Effect.gen(function* () {
        const { env } = yield* Invocation;
        yield* requireMailbox(params.id, "read");

        const a = yield* Effect.promise(() =>
          mailbox(env, params.id).attachmentFor(params.deliveryId, params.partId),
        );

        if (!a) return yield* new NotFound({ resource: "attachment" });
        yield* requireAttachmentAccess(a.access);

        const token = yield* Effect.promise(() =>
          previewToken(env, params.id, params.deliveryId, params.partId, Date.now()),
        );

        return { previewUrl: `${env.MAIL_ORIGIN}/render/${token}` };
      }).pipe(publicly),
    )

    // ---- plain authority reads ----
    .handle("getFocusQueue", ({ params }) => authorityRead(params.id, { _tag: "FocusQueue" }))
    .handle("getBatch", ({ params }) =>
      authorityRead(params.id, { _tag: "Batch", batchId: params.batchId }),
    )
    .handle("getBundle", ({ params }) =>
      authorityRead(params.id, { _tag: "Bundle", bundleKey: params.bundleKey }),
    )
    .handle("listScreenerSenders", ({ params }) =>
      authorityRead(params.id, { _tag: "ScreenerSenders" }),
    )
    .handle("listRecentSearches", ({ params }) =>
      authorityRead(params.id, { _tag: "RecentSearches" }),
    )
    // ---- sender policies (E02) ----
    .handle("listPolicies", ({ params }) => authorityRead(params.id, { _tag: "Policies" }))
    .handle("listPolicyHistory", ({ params, query }) => {
      const subject = clamp(query.subject, 320);

      return authorityRead(
        params.id,
        subject ? { _tag: "PolicyHistory", subject } : { _tag: "PolicyHistory" },
      );
    })
    // ---- organization reads (E11–E16) ----
    .handle("listLabels", ({ params }) => authorityRead(params.id, { _tag: "Labels" }))
    .handle("listRules", ({ params }) => authorityRead(params.id, { _tag: "Rules" }))
    .handle("listBoards", ({ params }) => authorityRead(params.id, { _tag: "Boards" }))
    .handle("getBoard", ({ params }) =>
      authorityRead(params.id, { _tag: "Board", boardId: params.boardId }),
    )
    .handle("listNotes", ({ params, query }) => {
      const notes: Types.Mutable<Extract<MailboxReadQuery, { _tag: "Notes" }>> = { _tag: "Notes" };
      const threadId = clamp(query.threadId, 64);

      if (threadId) notes.threadId = threadId;

      if (query.kind === "thread" || query.kind === "sticky" || query.kind === "cover")
        notes.kind = query.kind;

      return authorityRead(params.id, notes);
    })
    .handle("listClips", ({ params, query }) => {
      const q = clamp(query.q);

      return authorityRead(params.id, q ? { _tag: "Clips", query: q } : { _tag: "Clips" });
    })
    // Personal collections (§8 `/v1/collections`, E14) and grants (the revocable large-file links).
    .handle("listCollections", ({ query }) =>
      authorityRead(query.mailbox ?? "", { _tag: "Collections" }),
    )
    .handle("getCollection", ({ params, query }) =>
      authorityRead(query.mailbox ?? "", {
        _tag: "CollectionTimeline",
        collectionId: params.collectionId,
      }),
    )
    .handle("listGrants", ({ query }) => authorityRead(query.mailbox ?? "", { _tag: "FileLinks" }))
    // ---- contacts (E16) ----
    .handle("listContacts", ({ params, query }) => {
      const q = clamp(query.q);

      return authorityRead(params.id, q ? { _tag: "Contacts", query: q } : { _tag: "Contacts" });
    })
    .handle("suggestRecipients", ({ params, query }) =>
      authorityRead(params.id, {
        _tag: "SuggestRecipients",
        prefix: clamp(query.prefix, 128) ?? "",
        limit: num(query.limit) ?? 10,
      }),
    )
    .handle("getContact", ({ params }) =>
      authorityRead(params.id, { _tag: "Contact", contactId: params.contactId }),
    )
    .handle("getSenderHistory", ({ params, query }) =>
      authorityRead(params.id, {
        _tag: "SenderHistory",
        address: params.address,
        limit: num(query.limit) ?? 50,
      }),
    )
    .handle("getRecipientHistory", ({ params, query }) =>
      authorityRead(params.id, {
        _tag: "RecipientHistory",
        address: params.address,
        limit: num(query.limit) ?? 50,
      }),
    )
    // ---- settings reads (E19, E22–E24) ----
    .handle("listIdentities", ({ params }) => authorityRead(params.id, { _tag: "Identities" }))
    .handle("listForwardingDestinations", ({ params }) =>
      authorityRead(params.id, { _tag: "ForwardingDestinations" }),
    )
    .handle("getPreferences", ({ params }) => authorityRead(params.id, { _tag: "Preferences" }))
    // ---- drafts and send jobs (E17/E18) ----
    .handle("listDrafts", ({ params }) => authorityRead(params.id, { _tag: "Drafts" }, "draft"))
    .handle("listSendJobs", ({ params, query }) => {
      const state = clamp(query.state, 32);

      return authorityRead(params.id, state ? { _tag: "SendJobs", state } : { _tag: "SendJobs" });
    })
    .handle("getSendJob", ({ params }) =>
      authorityRead(params.id, { _tag: "SendJob", sendJobId: params.sendJobId }),
    )
    .handle("listUploads", ({ params, query }) =>
      authorityRead(params.id, { _tag: "Uploads", limit: num(query.limit) ?? 100 }),
    )
    // ---- attachments (E20) ----
    .handle("listAttachments", ({ params, query }) => {
      const attachments: Types.Mutable<Extract<MailboxReadQuery, { _tag: "Attachments" }>> = {
        _tag: "Attachments",
        limit: num(query.limit) ?? 100,
      };

      const contentTypePrefix = clamp(query.type, 64);
      const from = clamp(query.from, 320);
      const minSize = num(query.minSize);

      if (contentTypePrefix) attachments.contentTypePrefix = contentTypePrefix;

      if (from) attachments.from = from;

      if (minSize !== undefined) attachments.minSize = minSize;

      return authorityRead(params.id, attachments);
    }),
);
