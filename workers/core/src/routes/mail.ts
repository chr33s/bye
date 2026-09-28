// Mailbox, search, drafts, uploads and sending routes (§8, E01–E24).
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
  requireMailbox,
  type Scope,
} from "@bye/application";
import {
  ApiError,
  MailAttachmentZipRequest,
  type MailboxCommand,
  MailboxWriteRequest,
  MailDraftCreateRequest,
  MailDraftSaveRequest,
  MailSendRequest,
  type MailViewQuery,
  MailUploadReserveRequest,
} from "@bye/contracts";
import { htmlToReadableText, parseVCards, serializeVCards, type VCard } from "@bye/mail-codec";
import {
  authorizeSearchResults,
  type MailboxReadQuery,
  safeZipName,
  type SearchPage,
  zipStream,
} from "@bye/platform-cloudflare";
import { call, mailbox } from "../authorities.ts";
import { bodyKeyFor, type StoredBody } from "../objects.ts";
import type { CoreEnv } from "../env.ts";
import { errorResponse, type Params, route, type Route } from "../http.ts";
import { downloadToken, previewToken, renderToken } from "../render.ts";
import { authed, authedBody, readTextCapped } from "./common.ts";

// ---------------------------------------------------------------------------- helpers

/** Typed read through the mailbox authority (scope already checked by the caller). */
const readMailbox = <A = unknown>(env: CoreEnv, mailboxId: string, query: MailboxReadQuery) =>
  call(() => mailbox(env, mailboxId).read(query)) as Effect.Effect<A, ApiError>;

const num = (url: URL, key: string): number | undefined => {
  const v = url.searchParams.get(key);

  return v === null || v === "" || !Number.isFinite(Number(v)) ? undefined : Number(v);
};

/** Optional, clamped string query parameter. */
const qs = (url: URL, key: string, max = 256): string | undefined => {
  const v = url.searchParams.get(key);

  return v ? v.slice(0, max) : undefined;
};

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

/**
 * Plain authority reads, as data: path, the read it maps to, and (optionally) where the mailbox ID
 * comes from and which scope it needs. One factory turns each into a route.
 */
type ReadSpec = readonly [
  path: string,
  query: (params: Params, url: URL) => MailboxReadQuery,
  options?: { readonly mailboxFrom?: "query"; readonly scope?: Scope },
];

const READS: ReadonlyArray<ReadSpec> = [
  ["/v1/mailboxes/:id/focus", () => ({ _tag: "FocusQueue" })],
  ["/v1/mailboxes/:id/batches/:batchId", (p) => ({ _tag: "Batch", batchId: p.batchId! })],
  ["/v1/mailboxes/:id/bundles/:bundleKey", (p) => ({ _tag: "Bundle", bundleKey: p.bundleKey! })],
  ["/v1/mailboxes/:id/screener/senders", () => ({ _tag: "ScreenerSenders" })],
  ["/v1/mailboxes/:id/searches/recent", () => ({ _tag: "RecentSearches" })],
  // ---- sender policies (E02) ----
  ["/v1/mailboxes/:id/policies", () => ({ _tag: "Policies" })],
  [
    "/v1/mailboxes/:id/policies/history",
    (_p, url) => {
      const subject = qs(url, "subject", 320);

      return subject ? { _tag: "PolicyHistory", subject } : { _tag: "PolicyHistory" };
    },
  ],
  // ---- organization reads (E11–E16) ----
  ["/v1/mailboxes/:id/labels", () => ({ _tag: "Labels" })],
  ["/v1/mailboxes/:id/rules", () => ({ _tag: "Rules" })],
  ["/v1/mailboxes/:id/workflows", () => ({ _tag: "Boards" })],
  ["/v1/mailboxes/:id/workflows/:boardId", (p) => ({ _tag: "Board", boardId: p.boardId! })],
  [
    "/v1/mailboxes/:id/notes",
    (_p, url) => {
      const kind = url.searchParams.get("kind");

      const notes: Types.Mutable<Extract<MailboxReadQuery, { _tag: "Notes" }>> = {
        _tag: "Notes",
      };

      const threadId = qs(url, "threadId", 64);

      if (threadId) notes.threadId = threadId;

      if (kind === "thread" || kind === "sticky" || kind === "cover") notes.kind = kind;

      return notes;
    },
  ],
  [
    "/v1/mailboxes/:id/clips",
    (_p, url) => {
      const query = qs(url, "q");

      return query ? { _tag: "Clips", query } : { _tag: "Clips" };
    },
  ],
  // Personal collections (§8 `/v1/collections`, E14) and grants (the revocable large-file links).
  ["/v1/collections", () => ({ _tag: "Collections" }), { mailboxFrom: "query" }],
  [
    "/v1/collections/:collectionId",
    (p) => ({ _tag: "CollectionTimeline", collectionId: p.collectionId! }),
    { mailboxFrom: "query" },
  ],
  ["/v1/grants", () => ({ _tag: "FileLinks" }), { mailboxFrom: "query" }],
  // ---- contacts (E16) ----
  [
    "/v1/mailboxes/:id/contacts",
    (_p, url) => {
      const query = qs(url, "q");

      return query ? { _tag: "Contacts", query } : { _tag: "Contacts" };
    },
  ],
  [
    "/v1/mailboxes/:id/contacts/suggest",
    (_p, url) => ({
      _tag: "SuggestRecipients",
      prefix: qs(url, "prefix", 128) ?? "",
      limit: num(url, "limit") ?? 10,
    }),
  ],
  ["/v1/mailboxes/:id/contacts/:contactId", (p) => ({ _tag: "Contact", contactId: p.contactId! })],
  [
    "/v1/mailboxes/:id/senders/:address/history",
    (p, url) => ({ _tag: "SenderHistory", address: p.address!, limit: num(url, "limit") ?? 50 }),
  ],
  [
    "/v1/mailboxes/:id/recipients/:address/history",
    (p, url) => ({ _tag: "RecipientHistory", address: p.address!, limit: num(url, "limit") ?? 50 }),
  ],
  // ---- settings reads (E19, E22–E24) ----
  ["/v1/mailboxes/:id/identities", () => ({ _tag: "Identities" })],
  ["/v1/mailboxes/:id/forwarding", () => ({ _tag: "ForwardingDestinations" })],
  ["/v1/mailboxes/:id/preferences", () => ({ _tag: "Preferences" })],
  // ---- drafts and send jobs (E17/E18) ----
  ["/v1/mailboxes/:id/drafts", () => ({ _tag: "Drafts" }), { scope: "draft" }],
  [
    "/v1/mailboxes/:id/send-jobs",
    (_p, url) => {
      const state = qs(url, "state", 32);

      return state ? { _tag: "SendJobs", state } : { _tag: "SendJobs" };
    },
  ],
  ["/v1/mailboxes/:id/send-jobs/:sendJobId", (p) => ({ _tag: "SendJob", sendJobId: p.sendJobId! })],
  [
    "/v1/mailboxes/:id/uploads",
    (_p, url) => ({ _tag: "Uploads", limit: num(url, "limit") ?? 100 }),
  ],
  // ---- attachments (E20) ----
  [
    "/v1/mailboxes/:id/attachments",
    (_p, url) => {
      const attachments: Types.Mutable<Extract<MailboxReadQuery, { _tag: "Attachments" }>> = {
        _tag: "Attachments",
        limit: num(url, "limit") ?? 100,
      };

      const contentTypePrefix = qs(url, "type", 64);
      const from = qs(url, "from", 320);
      const minSize = num(url, "minSize");

      if (contentTypePrefix) attachments.contentTypePrefix = contentTypePrefix;

      if (from) attachments.from = from;

      if (minSize !== undefined) attachments.minSize = minSize;

      return attachments;
    },
  ],
];

const readRoute = ([path, query, options]: ReadSpec): Route<CoreEnv> =>
  route(
    "GET",
    path,
    authed(({ params, url }) =>
      readMailboxQuery(
        options?.mailboxFrom === "query" ? (url.searchParams.get("mailbox") ?? "") : params.id!,
        query(params, url),
        options?.scope ?? "read",
      ),
    ),
  );

// ---------------------------------------------------------------------------- routes

export const mailRoutes: ReadonlyArray<Route<CoreEnv>> = [
  // ---- views and threads (E04–E06, E10, E11) ----
  route(
    "GET",
    "/v1/mailboxes/:id/views/:view",
    authed(({ params, url }) => {
      const paging: Types.Mutable<Omit<MailViewQuery, "view">> = {};
      const label = url.searchParams.get("label");
      const cursor = url.searchParams.get("cursor");
      const limit = url.searchParams.get("limit");

      if (label) paging.label = label;

      if (cursor) paging.cursor = cursor;

      if (limit) paging.limit = Number(limit);

      return readMailboxView(params.id!, { view: params.view, ...paging });
    }),
  ),
  route(
    "GET",
    "/v1/mailboxes/:id/threads/:threadId",
    authed(({ params, env }) =>
      Effect.gen(function* () {
        const detail = (yield* readMailboxThread(params.id!, params.threadId!)) as {
          thread: unknown;
          deliveries: ReadonlyArray<{ deliveryId: string }>;
          mergeHistory: unknown;
        };

        const now = Date.now();

        // Render tokens are short-lived capabilities for the separate render origin (§10).
        const deliveries = yield* Effect.forEach(
          detail.deliveries,
          (d) =>
            Effect.promise(() => renderToken(env, params.id!, d.deliveryId, now)).pipe(
              Effect.map((token) => ({
                ...d,
                renderToken: token,
                renderUrl: `${env.MAIL_ORIGIN}/render/${token}`,
              })),
            ),
          { concurrency: 8 },
        );

        return { ...detail, deliveries };
      }),
    ),
  ),
  // Plain-text body for terminal and agent clients (X02): the same stored, sanitized body the
  // render origin serves, as text. HTML-only messages are converted here, so clients never parse
  // HTML themselves. Output is data, not markup: clients must still sanitize control characters.
  route(
    "GET",
    "/v1/mailboxes/:id/deliveries/:deliveryId/text",
    authed(({ params, env }) =>
      Effect.gen(function* () {
        yield* requireMailbox(params.id!, "read");

        const renderable = yield* Effect.promise(() =>
          mailbox(env, params.id!).renderable(params.deliveryId!),
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
          schemaVersion: 1,
          deliveryId: params.deliveryId!,
          text: cut,
          truncated,
          source: converted ? "html" : "text",
          hasHtml: stored.html !== null,
        };
      }),
    ),
  ),
  // Expanded Feed (E05): one page of feed threads, each with its latest message's render URL for
  // safe lazy rendering; visit markers and remembered position come with the page.
  route(
    "GET",
    "/v1/mailboxes/:id/feed",
    authed(({ params, url, env }) =>
      Effect.gen(function* () {
        const feedCursor = url.searchParams.get("cursor");
        const feedLimit = Math.min(num(url, "limit") ?? 20, 50);

        const page = (yield* readMailboxView(
          params.id!,
          feedCursor
            ? { view: "feed", limit: feedLimit, cursor: feedCursor }
            : { view: "feed", limit: feedLimit },
        )) as {
          items: ReadonlyArray<{ threadId: string }>;
          nextCursor: string | null;
          boundary: number;
          position?: string | null;
          previousVisitAt?: number;
        };

        const now = Date.now();
        const stub = mailbox(env, params.id!);

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
                renderToken(env, params.id!, latest.deliveryId, now),
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
      }),
    ),
  ),
  // Unified view across the principal's mailboxes with identity badges (E19). Bounded fan-out.
  route(
    "GET",
    "/v1/unified/views/:view",
    authed(({ params, url, env }) =>
      Effect.gen(function* () {
        const principal = yield* Principal;

        if (!principal.scopes.includes("read"))
          return yield* new Forbidden({ reason: "missing scope read" });
        const limit = Math.min(num(url, "limit") ?? 50, 100);

        const cursors = (() => {
          try {
            return JSON.parse(atob(url.searchParams.get("cursor") ?? "") || "{}") as Record<
              string,
              string | null
            >;
          } catch {
            return {} as Record<string, string | null>;
          }
        })();

        // Cursor map: mailboxId → resume cursor ("" = from the start); absent = exhausted.
        const first = !url.searchParams.get("cursor");

        const mailboxes = principal.mailboxIds
          .slice(0, MAX_UNIFIED_MAILBOXES)
          .filter((m) => first || Predicate.isString(cursors[m]));

        type Page = {
          items: ReadonlyArray<{ lastActivityAt: number; threadId: string }>;
          nextCursor: string | null;
          order?: {
            ascending: boolean;
            keys: ReadonlyArray<number>;
            cursors: ReadonlyArray<string>;
          };
        };

        const pages = yield* Effect.forEach(
          mailboxes,
          (mailboxId) =>
            Effect.gen(function* () {
              const mailboxCursor = cursors[mailboxId];

              const page = (yield* readMailboxView(
                mailboxId,
                mailboxCursor
                  ? { view: params.view, limit, cursor: mailboxCursor }
                  : { view: params.view, limit },
              )) as Page;

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
      }),
    ),
  ),

  // ---- commands ----
  // Per-command guards (step-up, redelivery, rule targets, send-as) live with the scope table in
  // the application's `executeMailboxCommand` (COMMAND_GUARDS).
  route(
    "POST",
    "/v1/mailboxes/:id/commands",
    authed(({ params, body }) => executeMailboxCommand(params.id!, body)),
  ),

  // ---- search (§8, E21): fan out over the mailbox's shards, merge by date, rehydrate ----
  route(
    "GET",
    "/v1/mailboxes/:id/search",
    authed(({ params, url, env }) =>
      Effect.gen(function* () {
        const principal = yield* requireMailbox(params.id!, "read");
        const q = (url.searchParams.get("q") ?? "").slice(0, 1024);
        const limit = Math.min(100, Math.max(1, num(url, "limit") ?? 25));
        const cursor = url.searchParams.get("cursor") ?? undefined;
        const stub = mailbox(env, params.id!);
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
          yield* readMailbox(env, params.id!, { _tag: "RecordSearch", query: q });

        return {
          results,
          nextCursor: more && last ? btoa(JSON.stringify({ d: last.date, id: last.docId })) : null,
          watermark: indexing.watermark,
          lagging: indexing.lagging,
        };
      }),
    ),
  ),
  route(
    "GET",
    "/v1/changes",
    authed(({ url }) =>
      readMailboxChanges(
        url.searchParams.get("mailbox") ?? "",
        Number(url.searchParams.get("cursor") ?? "0"),
      ),
    ),
  ),
  route(
    "DELETE",
    "/v1/grants/:grantId",
    authed(({ params, url, request }) =>
      executeMailboxCommand(url.searchParams.get("mailbox") ?? "", {
        _tag: "RevokeFileLink",
        commandId: idempotencyKey(request) ?? `revoke:${params.grantId}`,
        linkId: params.grantId,
      }),
    ),
  ),

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

  route(
    "GET",
    "/v1/mailboxes/:id/quota",
    authed(({ params, env }) =>
      requireMailbox(params.id!, "read").pipe(
        // Include parts, bodies and exports (D1 accounting) in what the quota reports (§12).
        Effect.andThen(() => Effect.promise(() => mailbox(env, params.id!).refreshExternalUsage())),
        Effect.andThen(() => readMailbox(env, params.id!, { _tag: "Quota" })),
      ),
    ),
  ),

  // ---- drafts and sending (E17/E18) ----
  route(
    "POST",
    "/v1/drafts",
    authedBody(
      MailDraftCreateRequest,
      ({ body }) => {
        const draft = {
          _tag: "CreateDraft",
          commandId: body.commandId,
          content: body.content,
        } as const;

        return executeMailboxCommand(
          body.mailboxId,
          body.threadId ? { ...draft, threadId: body.threadId } : draft,
        );
      },
      { status: 201 },
    ),
  ),
  route(
    "PATCH",
    "/v1/drafts/:id",
    authedBody(MailDraftSaveRequest, ({ params, body }) =>
      executeMailboxCommand(body.mailboxId, {
        _tag: "SaveDraft",
        commandId: body.commandId,
        draftId: params.id,
        expectedRevision: body.expectedRevision,
        content: body.content,
      }),
    ),
  ),
  route(
    "POST",
    "/v1/drafts/:id/send",
    authedBody(
      MailSendRequest,
      ({ params, body }) => {
        const send: Types.Mutable<Extract<MailboxCommand, { _tag: "Send" }>> = {
          _tag: "Send",
          commandId: body.commandId,
          draftId: params.id!,
          expectedRevision: body.revision,
        };

        if (body.sendAt) send.sendAt = body.sendAt;

        if (body.individually) send.individually = true;

        if (body.afterSend !== undefined) send.afterSend = body.afterSend;

        return executeMailboxCommand(body.mailboxId, send);
      },
      { status: 202 },
    ),
  ),
  route(
    "POST",
    "/v1/send-jobs/:id/cancel",
    authedBody(MailboxWriteRequest, ({ params, body }) =>
      executeMailboxCommand(body.mailboxId, {
        _tag: "CancelSend",
        commandId: body.commandId,
        sendJobId: params.id,
      }),
    ),
  ),
  route(
    "GET",
    "/v1/mailboxes/:id/drafts/:draftId",
    authed(({ params, env }) =>
      Effect.gen(function* () {
        yield* requireMailbox(params.id!, "draft");
        const draft = yield* Effect.promise(() => mailbox(env, params.id!).draft(params.draftId!));

        if (!draft) return yield* new NotFound({ resource: "draft" });

        return draft;
      }),
    ),
  ),

  // ---- uploads (§8 `/v1/uploads`, E20): reserve → PUT parts (R2 multipart) → complete ----
  route(
    "POST",
    "/v1/uploads",
    authedBody(
      MailUploadReserveRequest,
      ({ body, env }) =>
        Effect.gen(function* () {
          // The quota decision counts parts, bodies and exports too (§12): refresh them first.
          yield* requireMailbox(body.mailboxId, "draft");
          const stub = mailbox(env, body.mailboxId);
          yield* Effect.promise(() => stub.refreshExternalUsage());

          const reserved = (yield* executeMailboxCommand(body.mailboxId, {
            _tag: "ReserveUpload",
            commandId: body.commandId,
            filename: body.filename,
            contentType: body.contentType || "application/octet-stream",
            declaredSize: body.declaredSize,
          })) as { uploadId: string; blobKey: string };

          const existing = yield* Effect.promise(() => stub.uploadParts(reserved.uploadId));

          if (!existing.r2UploadId) {
            const mp = yield* Effect.promise(() =>
              env.PARTS.createMultipartUpload(reserved.blobKey, {
                customMetadata: { filename: body.filename.slice(0, 255) },
              }),
            );

            yield* Effect.promise(() => stub.setUploadR2Id(reserved.uploadId, mp.uploadId));
          }

          return {
            uploadId: reserved.uploadId,
            partSize: MAIL_UPLOAD_PART_BYTES,
            maxParts: 10_000,
          };
        }),
      { status: 201 },
    ),
  ),
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
  route(
    "POST",
    "/v1/uploads/:uploadId/complete",
    authedBody(MailboxWriteRequest, ({ params, body, env }) =>
      Effect.gen(function* () {
        const { mailboxId, commandId } = body;
        yield* requireMailbox(mailboxId, "draft");
        const stub = mailbox(env, mailboxId);

        const state = yield* readMailbox<{ blobKey: string; declaredSize: number }>(
          env,
          mailboxId,
          { _tag: "Upload", uploadId: params.uploadId! },
        );

        const { r2UploadId, parts } = yield* Effect.promise(() =>
          stub.uploadParts(params.uploadId!),
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

          return yield* executeMailboxCommand(mailboxId, {
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

        return yield* executeMailboxCommand(mailboxId, {
          _tag: "CompleteUpload",
          commandId,
          uploadId: params.uploadId,
          actualSize: head.size,
        });
      }),
    ),
  ),
  route(
    "POST",
    "/v1/uploads/:uploadId/abort",
    authedBody(MailboxWriteRequest, ({ params, body, env }) =>
      Effect.gen(function* () {
        const { mailboxId, commandId } = body;
        yield* requireMailbox(mailboxId, "draft");

        const state = yield* readMailbox<{ blobKey: string }>(env, mailboxId, {
          _tag: "Upload",
          uploadId: params.uploadId!,
        });

        const { r2UploadId } = yield* Effect.promise(() =>
          mailbox(env, mailboxId).uploadParts(params.uploadId!),
        );

        if (r2UploadId)
          yield* Effect.promise(() =>
            env.PARTS.resumeMultipartUpload(state.blobKey, r2UploadId)
              .abort()
              .catch(() => undefined),
          );

        return yield* executeMailboxCommand(mailboxId, {
          _tag: "AbortUpload",
          commandId,
          uploadId: params.uploadId,
        });
      }),
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
  // Signed, short-lived download link on the render origin for clients that open links outside the app.
  route(
    "POST",
    "/v1/mailboxes/:id/deliveries/:deliveryId/attachments/:partId/link",
    authed(({ params, env }) =>
      Effect.gen(function* () {
        yield* requireMailbox(params.id!, "read");

        const a = yield* Effect.promise(() =>
          mailbox(env, params.id!).attachmentFor(params.deliveryId!, params.partId!),
        );

        if (!a) return yield* new NotFound({ resource: "attachment" });
        yield* requireAttachmentAccess(a.access);

        const token = yield* Effect.promise(() =>
          downloadToken(env, params.id!, params.deliveryId!, params.partId!, Date.now()),
        );

        return { downloadUrl: `${env.MAIL_ORIGIN}/render/${token}`, expiresInSeconds: 300 };
      }),
    ),
  ),
  // Sandboxed preview on the render origin (text and raster images only).
  route(
    "GET",
    "/v1/mailboxes/:id/deliveries/:deliveryId/attachments/:partId/preview",
    authed(({ params, env }) =>
      Effect.gen(function* () {
        yield* requireMailbox(params.id!, "read");

        const a = yield* Effect.promise(() =>
          mailbox(env, params.id!).attachmentFor(params.deliveryId!, params.partId!),
        );

        if (!a) return yield* new NotFound({ resource: "attachment" });
        yield* requireAttachmentAccess(a.access);

        const token = yield* Effect.promise(() =>
          previewToken(env, params.id!, params.deliveryId!, params.partId!, Date.now()),
        );

        return { previewUrl: `${env.MAIL_ORIGIN}/render/${token}` };
      }),
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

  // Plain authority reads (declared above as data). Listed after the specific routes they could
  // shadow (e.g. `contacts/export.vcf` before `contacts/:contactId`).
  ...READS.map(readRoute),
];
