// JMAP endpoints (spec.md §16.5): authenticated session discovery, the API, blob upload and
// download, and EventSource. The JMAP envelope and its three error forms are protocol-defined
// (RFC 8620 §3.6), so these are native routes rather than HttpApi endpoints with Bye's error
// envelope. Account-scoped calls run inside each account's authority (MailboxDO); this module
// authenticates, prepares content outside any transaction (§4), and orchestrates the calls that
// span accounts (Email/copy, Blob/copy; B3).
import { Context, Effect, Layer, Option, Predicate, Result, Schema } from "effect";
import { Principal, type PrincipalContext, requestAuthLayer, requireScope } from "@bye/application";
import {
  ACCOUNT_METHODS,
  buildSession,
  CORE,
  CORE_LIMITS,
  coreEcho,
  dispatch,
  MAIL,
  type MethodDefinition,
  methodError,
  methodRegistry,
  parseRequest,
  type RequestProblem,
  requestProblem,
  Responses,
  type Session,
  type SessionAccount,
} from "@bye/jmap";
import { prepareEmail } from "@bye/mail-codec";
import {
  type PreparedCall,
  type PreparedContent,
  type PreparedSubmission,
  renderParsedEmail,
} from "@bye/platform-cloudflare";
import { mailbox } from "../authorities.ts";
import type { CoreEnv } from "../env.ts";
import { restoreGenerations } from "../generations.ts";
import { json, route, type Route, runHttp } from "../http.ts";
import { pushMethods } from "../jmap-push.ts";
import { draftsOnlyDestroy, missingScope } from "../jmap-scopes.ts";
import {
  type BlobReader,
  bodyValues,
  partBytes,
  prepareBlob,
  prepareEmailCreate,
  prepareSubmission,
  sha256Hex,
} from "../jmap-prepare.ts";
import { issuerOf } from "./discovery.ts";
import { authenticate, readTextCapped, requestId } from "./common.ts";

export const JMAP_SESSION_PATH = "/.well-known/jmap";

/** Accounts per principal served in one session; more would exceed one D1 IN list. */
const MAX_ACCOUNTS = 90;

/** Event streams fan in from at most this many accounts. */
const MAX_STREAM_ACCOUNTS = 10;

/** `base` with `entries` set (JSON objects are plain records, built without spreading). */
const withEntries = (
  base: Schema.JsonObject,
  entries: ReadonlyArray<readonly [string, Schema.Json]>,
): Schema.JsonObject => Object.fromEntries([...Object.entries(base), ...entries]);

const problem = (p: RequestProblem): Response =>
  json(p, p.status, { "content-type": "application/problem+json; charset=utf-8" });

const httpProblem = (status: number, detail: string): Response =>
  json({ type: "about:blank", status, detail }, status, {
    "content-type": "application/problem+json; charset=utf-8",
  });

interface AccountRow {
  readonly id: string;
  readonly kind: "personal" | "extension";
  readonly owner_user_id: string | null;
  readonly address: string | null;
}

interface HostAccount {
  readonly accountId: string;
  readonly restoreGeneration: number;
  readonly profile: "projection" | "core";
}

/** Per-request JMAP host: environment, principal and the accounts it may discover. */
interface HostContext {
  readonly env: CoreEnv;
  readonly principal: PrincipalContext;
  readonly credentialId: string;
  readonly accounts: ReadonlyMap<string, HostAccount>;
  readonly session: Session;
  readonly waitUntil: (p: Promise<unknown>) => void;
}

class JmapHost extends Context.Service<JmapHost, HostContext>()("jmap/Host") {}

/**
 * The principal's discoverable accounts: D1 directory intent filtered by each authority's
 * effective grants (A3 — the account-local decision is final).
 */
const resolveAccounts = (env: CoreEnv, principal: PrincipalContext) =>
  Effect.promise(async () => {
    const ids = principal.mailboxIds.slice(0, MAX_ACCOUNTS);
    const db = env.DIRECTORY.withSession("first-primary");

    const rows = ids.length
      ? (
          await db
            .prepare(
              `SELECT m.id, m.kind, m.owner_user_id,
                 (SELECT ar.address FROM address_routes ar WHERE ar.mailbox_id = m.id
                    AND ar.kind = 'primary' AND ar.disabled_at IS NULL ORDER BY ar.created_at LIMIT 1) AS address
               FROM mailboxes m WHERE m.status = 'active' AND m.id IN (${ids.map(() => "?").join(",")})
               ORDER BY m.created_at, m.id`,
            )
            .bind(...ids)
            .all<AccountRow>()
        ).results
      : [];

    const user = await db
      .prepare("SELECT primary_address FROM users WHERE id = ?")
      .bind(principal.userId)
      .first<{ primary_address: string }>();

    const generations = await restoreGenerations(
      env,
      "mailbox",
      rows.map((r) => r.id),
    );

    const accounts = new Map<string, HostAccount>();
    const sessionAccounts: Array<SessionAccount> = [];

    const personal = (r: AccountRow) =>
      r.kind === "personal" && r.owner_user_id === principal.userId;

    // Each authority decides its own account independently: ask them all at once.
    // bounded: at most MAX_ACCOUNTS authorities (the session's account cap).
    const decided = await Promise.all(
      rows.map(async (r) => {
        const restoreGeneration = generations.get(r.id) ?? 0;

        return {
          r,
          restoreGeneration,
          acct: await mailbox(env, r.id).jmapAccount(principal.userId, restoreGeneration),
        };
      }),
    );

    for (const { r, restoreGeneration, acct } of decided) {
      if (!acct) continue;
      const profile = acct.profile === "core" ? "core" : "projection";
      accounts.set(r.id, { accountId: r.id, restoreGeneration, profile });
      sessionAccounts.push({
        accountId: r.id,
        name: r.address ?? r.id,
        isPersonal: personal(r),
        isReadOnly: acct.isReadOnly,
        profile,
      });
    }

    const primary =
      rows.find((r) => personal(r) && accounts.has(r.id)) ?? rows.find((r) => accounts.has(r.id));

    const base = issuerOf(env);

    const session = buildSession({
      username: user?.primary_address ?? principal.userId,
      apiUrl: `${base}/jmap/api`,
      downloadUrl: `${base}/jmap/download/{accountId}/{blobId}/{name}?type={type}`,
      uploadUrl: `${base}/jmap/upload/{accountId}`,
      eventSourceUrl: `${base}/jmap/eventsource?types={types}&closeafter={closeafter}&ping={ping}`,
      accounts: sessionAccounts,
      primaryAccountId: primary?.id ?? null,
    });

    return { session, accounts };
  });

/** Authenticate and require the read scope, then run `program` with the principal. */
const withPrincipal = (
  request: Request,
  env: CoreEnv,
  program: (principal: PrincipalContext, credentialId: string) => Effect.Effect<Response>,
) =>
  runHttp(
    Effect.gen(function* () {
      const auth = yield* authenticate(request, env);

      const principal = yield* Effect.gen(function* () {
        yield* requireScope("read");

        return yield* Principal;
      }).pipe(Effect.provide(requestAuthLayer(auth)));

      return yield* program(principal, auth.credentialId);
    }),
    requestId(),
  );

// ------------------------------------------------------------------ account calls

const accountOf = (host: HostContext, accountId: Schema.Json | undefined) =>
  Predicate.isString(accountId)
    ? Option.fromNullishOr(host.accounts.get(accountId))
    : Option.none<HostAccount>();

/** Bytes of a blob as this principal may read them (A3 gate); part blobs are extracted. */
const blobReader =
  (host: HostContext, accountId: string): BlobReader =>
  async (blobId) => {
    const blob = await mailbox(host.env, accountId).jmapBlob(host.principal.userId, blobId);

    if (!blob || !blob.allowed) return null;

    const object = await (blob.bucket === "originals" ? host.env.ORIGINALS : host.env.PARTS).get(
      blob.r2Key,
    );

    if (!object) return null;
    const bytes = new Uint8Array(await object.arrayBuffer());

    if (blob.partId === null) return bytes;

    return partBytes(bytes, blob.partId)?.content ?? null;
  };

const emailBytes = async (host: HostContext, accountId: string, emailId: string) => {
  const blob = await mailbox(host.env, accountId).jmapEmailBlob(host.principal.userId, emailId);

  if (!blob || !blob.allowed) return null;

  const object = await (blob.bucket === "originals" ? host.env.ORIGINALS : host.env.PARTS).get(
    blob.r2Key,
  );

  return object ? new Uint8Array(await object.arrayBuffer()) : null;
};

const resolveRef = (id: string, createdIds: ReadonlyMap<string, string>) =>
  id.startsWith("#") ? (createdIds.get(id.slice(1)) ?? id) : id;

const entries = (
  value: Schema.Json | undefined,
): ReadonlyArray<readonly [string, Schema.JsonObject]> =>
  Predicate.isObject(value) && !Array.isArray(value)
    ? Object.entries(value as Schema.JsonObject).flatMap(([k, v]) =>
        Predicate.isObject(v) && !Array.isArray(v) ? [[k, v as Schema.JsonObject] as const] : [],
      )
    : [];

/**
 * Prepare creations before the authority call (§4): build or read immutable bytes, write them to
 * R2, and parse them once. A creation that can't be prepared is reported per object by the
 * authority, never as a failed method.
 */
const prepare = async (
  host: HostContext,
  accountId: string,
  name: string,
  args: Schema.JsonObject,
  createdIds: ReadonlyMap<string, string>,
): Promise<PreparedCall | undefined> => {
  const emails: Array<readonly [string, PreparedContent]> = [];
  const submissions: Array<readonly [string, PreparedSubmission]> = [];
  const read = blobReader(host, accountId);

  if (name === "Email/set")
    for (const [cid, obj] of entries(args["create"])) {
      try {
        emails.push([
          cid,
          await prepareEmailCreate(host.env, accountId, obj, (id) =>
            read(resolveRef(id, createdIds)),
          ),
        ]);
      } catch {
        // reported by the authority as notCreated
      }
    }

  if (name === "Email/import")
    for (const [cid, e] of entries(args["emails"])) {
      const blobId = e["blobId"];

      if (!Predicate.isString(blobId)) continue;
      const resolved = resolveRef(blobId, createdIds);
      const blob = await mailbox(host.env, accountId).jmapBlob(host.principal.userId, resolved);
      const bytes = await read(resolved);

      if (!blob || !bytes) continue;

      if (blob.partId === null) {
        emails.push([
          cid,
          prepareBlob({ blobId: resolved, bucket: blob.bucket, r2Key: blob.r2Key }, bytes),
        ]);
        continue;
      }

      // An attached message (a part blob): its own bytes become a content-addressed original,
      // so the new Email never points at the outer message.
      const digest = await sha256Hex(bytes);
      const r2Key = `t/${accountId}/jmap/msg/${digest}.eml`;
      const ownId = `C${digest.slice(0, 40)}`;

      if (!(await host.env.ORIGINALS.head(r2Key)))
        await host.env.ORIGINALS.put(r2Key, bytes, {
          httpMetadata: { contentType: "message/rfc822" },
        });

      await mailbox(host.env, accountId).jmapRegisterUpload(host.principal.userId, {
        blobId: ownId,
        bucket: "originals",
        r2Key,
        size: bytes.byteLength,
        type: "message/rfc822",
      });
      emails.push([cid, prepareBlob({ blobId: ownId, bucket: "originals", r2Key }, bytes)]);
    }

  if (name === "EmailSubmission/set")
    for (const [cid, s] of entries(args["create"])) {
      const emailId = s["emailId"];

      if (!Predicate.isString(emailId)) continue;
      const bytes = await emailBytes(host, accountId, resolveRef(emailId, createdIds));

      if (bytes) submissions.push([cid, await prepareSubmission(host.env, accountId, bytes)]);
    }

  return emails.length + submissions.length > 0 ? { emails, submissions } : undefined;
};

/** RFC 8621 §4.2 `fetch*BodyValues`: filled from the immutable bytes after the authority read. */
const withBodyValues = async (
  host: HostContext,
  accountId: string,
  args: Schema.JsonObject,
  responses: ReadonlyArray<readonly [string, Schema.JsonObject]>,
): Promise<ReadonlyArray<readonly [string, Schema.JsonObject]>> => {
  const text = args["fetchTextBodyValues"] === true;
  const html = args["fetchHTMLBodyValues"] === true;
  const all = args["fetchAllBodyValues"] === true;

  if (!text && !html && !all) return responses;
  const maxBytes = Predicate.isNumber(args["maxBodyValueBytes"]) ? args["maxBodyValueBytes"] : 0;

  // Sequential: one R2 read in flight at a time (§7.4), bounded by maxObjectsInGet.
  const out: Array<readonly [string, Schema.JsonObject]> = [];

  for (const [name, args0] of responses) {
    if (name !== "Email/get" || !Array.isArray(args0["list"])) {
      out.push([name, args0]);
      continue;
    }

    const list: Array<Schema.JsonObject> = [];

    for (const e of args0["list"] as ReadonlyArray<Schema.JsonObject>) {
      const bytes =
        Object.hasOwn(e, "bodyValues") && Predicate.isString(e["id"])
          ? await emailBytes(host, accountId, e["id"])
          : null;

      list.push(
        bytes
          ? withEntries(e, [["bodyValues", bodyValues(bytes, { text, html, all, maxBytes })]])
          : e,
      );
    }

    out.push([name, withEntries(args0, [["list", list]])]);
  }

  return out;
};

/** Forward an account-scoped call to its authority, preparing content first (§4). */
const forward =
  (name: string): MethodDefinition<JmapHost>["handler"] =>
  (args, context) =>
    Effect.gen(function* () {
      const host = yield* JmapHost;

      if (!Predicate.isString(args["accountId"]))
        return yield* methodError("invalidArguments", "accountId");
      const acct = accountOf(host, args["accountId"]);

      if (Option.isNone(acct)) return yield* methodError("accountNotFound");
      const accountId = acct.value.accountId;

      const out = yield* Effect.tryPromise({
        try: async () => {
          const prepared = await prepare(host, accountId, name, args, context.createdIds);

          const result = await mailbox(host.env, accountId).jmapCall({
            principalId: host.principal.userId,
            accountId,
            restoreGeneration: acct.value.restoreGeneration,
            name,
            args,
            using: [...context.using],
            createdIds: [...context.createdIds],
            callId: context.callId,
            draftsOnlyDestroy: draftsOnlyDestroy(host.principal.scopes, name, args),
            mayTrash: host.principal.scopes.includes("delete"),
            ...(prepared ? { prepared } : undefined),
          });

          const plain = result.responses.map((r) => [r.name, r.args] as const);

          const responses =
            name === "Email/get" ? await withBodyValues(host, accountId, args, plain) : plain;

          return { responses, createdIds: Object.entries(result.createdIds) };
        },
        catch: () => methodError("serverUnavailable"),
      });

      for (const [cid, id] of out.createdIds) context.createdIds.set(cid, id);

      return new Responses(out.responses);
    });

// ------------------------------------------------------------------ host-level methods

const ParseArgs = Schema.Struct({
  accountId: Schema.String,
  blobIds: Schema.Array(Schema.String),
  properties: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
  fetchTextBodyValues: Schema.optional(Schema.Boolean),
  fetchHTMLBodyValues: Schema.optional(Schema.Boolean),
  fetchAllBodyValues: Schema.optional(Schema.Boolean),
  maxBodyValueBytes: Schema.optional(Schema.Number),
});

const PARSE_DEFAULT_PROPERTIES = [
  "messageId",
  "inReplyTo",
  "references",
  "sender",
  "from",
  "to",
  "cc",
  "bcc",
  "replyTo",
  "subject",
  "sentAt",
  "hasAttachment",
  "preview",
  "bodyValues",
  "textBody",
  "htmlBody",
  "attachments",
];

/** Email/parse (RFC 8621 §4.9): parse blobs the principal can read, without importing them. */
const emailParse: MethodDefinition<JmapHost> = {
  name: "Email/parse",
  capability: MAIL,
  handler: (raw) =>
    Effect.gen(function* () {
      const host = yield* JmapHost;
      const args = Schema.decodeUnknownOption(ParseArgs)(raw);

      if (Option.isNone(args)) return yield* methodError("invalidArguments");
      const acct = accountOf(host, args.value.accountId);

      if (Option.isNone(acct)) return yield* methodError("accountNotFound");

      if (args.value.blobIds.length > CORE_LIMITS.maxObjectsInGet)
        return yield* methodError("requestTooLarge");
      const properties = args.value.properties ?? PARSE_DEFAULT_PROPERTIES;
      const read = blobReader(host, acct.value.accountId);
      const v = args.value;

      return yield* Effect.promise(async (): Promise<Schema.JsonObject> => {
        const parsed: { [blobId: string]: Schema.Json } = {};
        const notFound: Array<string> = [];
        const notParsable: Array<string> = [];

        for (const blobId of v.blobIds) {
          const bytes = await read(blobId);

          if (bytes === null) {
            notFound.push(blobId);
            continue;
          }

          const e = prepareEmail(bytes);

          if (e.truncated || (e.from === null && e.headers.length === 0)) {
            notParsable.push(blobId);
            continue;
          }

          const obj = renderParsedEmail(blobId, e, properties);
          const fetch = v.fetchTextBodyValues || v.fetchHTMLBodyValues || v.fetchAllBodyValues;

          parsed[blobId] =
            properties.includes("bodyValues") && fetch
              ? withEntries(obj, [
                  [
                    "bodyValues",
                    bodyValues(bytes, {
                      text: v.fetchTextBodyValues === true,
                      html: v.fetchHTMLBodyValues === true,
                      all: v.fetchAllBodyValues === true,
                      maxBytes: v.maxBodyValueBytes ?? 0,
                    }),
                  ],
                ])
              : obj;
        }

        return {
          accountId: acct.value.accountId,
          parsed: Object.keys(parsed).length ? parsed : null,
          notParsable: notParsable.length ? notParsable : null,
          notFound: notFound.length ? notFound : null,
        };
      });
    }),
};

const BlobCopyArgs = Schema.Struct({
  fromAccountId: Schema.String,
  accountId: Schema.String,
  blobIds: Schema.Array(Schema.String),
});

/**
 * Blob/copy (RFC 8620 §6.3; B3): read under the source grant, write destination-owned bytes, then
 * commit the destination blob. Success is reported only after the destination commit; the source
 * is never destroyed.
 */
const blobCopy: MethodDefinition<JmapHost> = {
  name: "Blob/copy",
  capability: CORE,
  handler: (raw) =>
    Effect.gen(function* () {
      const host = yield* JmapHost;
      const args = Schema.decodeUnknownOption(BlobCopyArgs)(raw);

      if (Option.isNone(args)) return yield* methodError("invalidArguments");
      const from = accountOf(host, args.value.fromAccountId);
      const to = accountOf(host, args.value.accountId);

      if (Option.isNone(from)) return yield* methodError("fromAccountNotFound");

      if (Option.isNone(to)) return yield* methodError("accountNotFound");

      if (to.value.profile !== "core") return yield* methodError("accountReadOnly");
      const read = blobReader(host, from.value.accountId);
      const blobIds = args.value.blobIds;

      return yield* Effect.promise(async (): Promise<Schema.JsonObject> => {
        const copied: { [id: string]: string } = {};
        const notCopied: { [id: string]: Schema.JsonObject } = {};

        for (const blobId of blobIds) {
          const bytes = await read(blobId);

          if (bytes === null) {
            notCopied[blobId] = { type: "blobNotFound" };
            continue;
          }

          const digest = await sha256Hex(bytes);
          const r2Key = `t/${to.value.accountId}/jmap/blob/${digest}`;
          await host.env.PARTS.put(r2Key, bytes);
          const newId = `B${digest.slice(0, 40)}`;

          await mailbox(host.env, to.value.accountId).jmapRegisterUpload(host.principal.userId, {
            blobId: newId,
            r2Key,
            size: bytes.byteLength,
            type: "application/octet-stream",
          });
          copied[blobId] = newId;
        }

        return {
          fromAccountId: from.value.accountId,
          accountId: to.value.accountId,
          copied: Object.keys(copied).length ? copied : null,
          notCopied: Object.keys(notCopied).length ? notCopied : null,
        };
      });
    }),
};

const EmailCopyArgs = Schema.Struct({
  fromAccountId: Schema.String,
  ifFromInState: Schema.optional(Schema.NullOr(Schema.String)),
  accountId: Schema.String,
  ifInState: Schema.optional(Schema.NullOr(Schema.String)),
  create: Schema.Record(Schema.String, Schema.JsonObject),
  onSuccessDestroyOriginal: Schema.optional(Schema.Boolean),
  destroyFromIfInState: Schema.optional(Schema.NullOr(Schema.String)),
});

/**
 * Email/copy across accounts (RFC 8621 §4.7; spec.md §16 B3) as a multi-phase operation:
 * source read under its grant, destination-owned bytes and pins, a complete destination commit,
 * then the optional source destruction reported separately. A destination success followed by a
 * failed source delete leaves two copies, never zero.
 */
const emailCopy: MethodDefinition<JmapHost> = {
  name: "Email/copy",
  capability: MAIL,
  handler: (raw, context) =>
    Effect.gen(function* () {
      const host = yield* JmapHost;
      const decoded = Schema.decodeUnknownOption(EmailCopyArgs)(raw);

      if (Option.isNone(decoded)) return yield* methodError("invalidArguments");
      const args = decoded.value;
      const from = accountOf(host, args.fromAccountId);
      const to = accountOf(host, args.accountId);

      if (Option.isNone(from)) return yield* methodError("fromAccountNotFound");

      if (Option.isNone(to)) return yield* methodError("accountNotFound");

      if (to.value.profile !== "core") return yield* methodError("accountReadOnly");

      if (from.value.accountId === to.value.accountId)
        return yield* methodError("invalidArguments", "fromAccountId and accountId must differ");
      const source = from.value;
      const target = to.value;

      const call = async (
        acct: HostAccount,
        name: string,
        callArgs: Schema.JsonObject,
        prepared?: PreparedCall,
      ) => {
        const out = await mailbox(host.env, acct.accountId).jmapCall({
          principalId: host.principal.userId,
          accountId: acct.accountId,
          restoreGeneration: acct.restoreGeneration,
          name,
          args: callArgs,
          using: [...context.using],
          createdIds: [...context.createdIds],
          callId: context.callId,
          ...(prepared ? { prepared } : undefined),
        });

        return {
          responses: out.responses.map((r) => [r.name, r.args] as const),
          createdIds: Object.entries(out.createdIds),
        };
      };

      const failed: readonly [string, Schema.JsonObject] = ["error", { type: "serverFail" }];
      const opId = crypto.randomUUID();

      return yield* Effect.tryPromise({
        try: async (): Promise<Responses> => {
          const creates = Object.entries(args.create);

          const sourceIds = creates.flatMap(([, c]) =>
            Predicate.isString(c["id"]) ? [c["id"]] : [],
          );

          // Phase 1 — source read: authorize and apply the source-state precondition.
          const read1 = await call(source, "Email/get", {
            accountId: source.accountId,
            ids: sourceIds,
            properties: ["blobId", "receivedAt", "keywords"],
          });

          const [sourceName, sourceOut] = read1.responses[0] ?? failed;

          if (sourceName === "error") return new Responses([["error", sourceOut]]);

          if (args.ifFromInState && sourceOut["state"] !== args.ifFromInState)
            return new Responses([["error", { type: "stateMismatch" }]]);

          const found = new Map(
            (sourceOut["list"] as ReadonlyArray<Schema.JsonObject>).map((e) => [
              Predicate.isString(e["id"]) ? e["id"] : "",
              e,
            ]),
          );

          const read = blobReader(host, source.accountId);
          const emails: { [cid: string]: Schema.JsonObject } = {};
          const prepared: Array<readonly [string, PreparedContent]> = [];
          const notCreated: { [cid: string]: Schema.JsonObject } = {};

          // Phase 2 — destination preparation: destination-owned bytes and pins.
          for (const [cid, c] of creates) {
            const e = Predicate.isString(c["id"]) ? found.get(c["id"]) : undefined;
            const bytes = e && Predicate.isString(e["blobId"]) ? await read(e["blobId"]) : null;

            if (!e || bytes === null) {
              notCreated[cid] = { type: "notFound" };
              continue;
            }

            const digest = await sha256Hex(bytes);
            const r2Key = `t/${target.accountId}/jmap/msg/${digest}.eml`;

            if (!(await host.env.ORIGINALS.head(r2Key)))
              await host.env.ORIGINALS.put(r2Key, bytes, {
                httpMetadata: { contentType: "message/rfc822" },
              });
            const blobId = `C${digest.slice(0, 40)}`;

            await mailbox(host.env, target.accountId).jmapRegisterUpload(
              host.principal.userId,
              {
                blobId,
                bucket: "originals",
                r2Key,
                size: bytes.byteLength,
                type: "message/rfc822",
              },
              `copy:${opId}`,
            );
            prepared.push([cid, { ...prepareBlob({ blobId, bucket: "originals", r2Key }, bytes) }]);
            emails[cid] = {
              blobId,
              mailboxIds: c["mailboxIds"] ?? {},
              keywords: c["keywords"] ?? e["keywords"] ?? {},
              ...(Predicate.isString(c["receivedAt"] ?? e["receivedAt"])
                ? { receivedAt: (c["receivedAt"] ?? e["receivedAt"]) as string }
                : undefined),
            };
          }

          // Phase 3 — destination commit: a complete destination Email or nothing.
          const committed = await call(
            target,
            "Email/import",
            { accountId: target.accountId, ifInState: args.ifInState ?? null, emails },
            { emails: prepared, submissions: [] },
          );

          for (const [cid, id] of committed.createdIds) context.createdIds.set(cid, id);
          const [importName, importOut] = committed.responses[0] ?? failed;

          if (importName === "error") return new Responses([["error", importOut]]);
          const created = (importOut["created"] ?? null) as Schema.JsonObject | null;
          const importFailures = (importOut["notCreated"] ?? null) as Schema.JsonObject | null;

          const copyResponse: Schema.JsonObject = {
            fromAccountId: source.accountId,
            accountId: target.accountId,
            oldState: importOut["oldState"] ?? null,
            newState: importOut["newState"] ?? null,
            created,
            notCreated:
              Object.keys(notCreated).length > 0 || importFailures !== null
                ? withEntries(notCreated, Object.entries(importFailures ?? {}))
                : null,
          };

          if (!args.onSuccessDestroyOriginal || created === null)
            return new Responses([["Email/copy", copyResponse]]);

          // Phase 4 — optional source destruction, reported as its own implicit Email/set.
          const destroy = Object.keys(created).flatMap((cid) => {
            const c = args.create[cid];

            return c && Predicate.isString(c["id"]) ? [c["id"]] : [];
          });

          const destroyed = await call(source, "Email/set", {
            accountId: source.accountId,
            ifInState: args.destroyFromIfInState ?? null,
            destroy,
          });

          return new Responses([["Email/copy", copyResponse], ...destroyed.responses]);
        },
        catch: () => methodError("serverUnavailable"),
      });
    }),
};

/** Refuse a call whose credential lacks the scope the equivalent legacy command needs (A3). */
const scoped = (m: MethodDefinition<JmapHost>): MethodDefinition<JmapHost> => ({
  ...m,
  handler: (args, context) =>
    Effect.gen(function* () {
      const host = yield* JmapHost;
      const missing = missingScope(host.principal.scopes, m.name, args);

      if (missing !== undefined)
        return yield* methodError("forbidden", `credential lacks the ${missing} scope`);

      return yield* m.handler(args, context);
    }),
});

/** The API host's registry: Core/echo, host-level methods, and every account method forwarded. */
const registryFor = (push: ReadonlyArray<MethodDefinition<never>>) =>
  methodRegistry<JmapHost>([
    coreEcho,
    ...push,
    ...[
      emailParse,
      blobCopy,
      emailCopy,
      ...ACCOUNT_METHODS.map((m) => ({
        name: m.name,
        capability: m.capability,
        handler: forward(m.name),
      })),
    ].map(scoped),
  ]);

// ------------------------------------------------------------------ routes

const session = route("GET", JMAP_SESSION_PATH, (request, _params, env) =>
  withPrincipal(request, env, (principal) =>
    Effect.map(resolveAccounts(env, principal), ({ session: s }) => json(s)),
  ),
);

const api = route("POST", "/jmap/api", (request, _params, env, ctx) =>
  withPrincipal(request, env, (principal, credentialId) =>
    Effect.gen(function* () {
      const body = yield* Effect.promise(() => readTextCapped(request, CORE_LIMITS.maxSizeRequest));

      if (body === null)
        return problem(requestProblem("limit", "request too large", "maxSizeRequest"));
      const parsed = parseRequest(body);

      if (Result.isFailure(parsed)) return problem(parsed.failure);
      const resolved = yield* resolveAccounts(env, principal);
      const waitUntil = (p: Promise<unknown>) => ctx.waitUntil(p);

      const host: HostContext = {
        env,
        principal,
        credentialId,
        accounts: resolved.accounts,
        session: resolved.session,
        waitUntil,
      };

      const push = pushMethods({
        userId: principal.userId,
        sessionId: credentialId,
        env,
        fetch: (input, init) => fetch(input, init),
        waitUntil,
      });

      const result = yield* dispatch(
        registryFor(push),
        parsed.success,
        resolved.session.state,
      ).pipe(Effect.provide(Layer.succeed(JmapHost, host)));

      return Result.isSuccess(result) ? json(result.success) : problem(result.failure);
    }),
  ),
);

const SAFE_TYPE = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i;

/** Blob download (RFC 8620 §6.2) behind the account grant and the quarantine gate (A3). */
const download = route("GET", "/jmap/download/:accountId/:blobId/:name", (request, params, env) =>
  withPrincipal(request, env, (principal) =>
    Effect.gen(function* () {
      const accountId = params["accountId"] ?? "";
      const blobId = params["blobId"] ?? "";
      const name = params["name"] ?? "blob";

      // An account the principal can't see is indistinguishable from a missing blob.
      if (!principal.mailboxIds.includes(accountId)) return httpProblem(404, "blob not found");

      const blob = yield* Effect.promise(() =>
        mailbox(env, accountId).jmapBlob(principal.userId, blobId),
      );

      if (!blob) return httpProblem(404, "blob not found");

      if (!blob.allowed) return httpProblem(403, `blob unavailable: ${blob.status}`);

      const object = yield* Effect.promise(() =>
        (blob.bucket === "originals" ? env.ORIGINALS : env.PARTS).get(blob.r2Key),
      );

      if (!object) return httpProblem(404, "blob not found");
      const requested = new URL(request.url).searchParams.get("type") ?? "";
      let body: ReadableStream | Uint8Array = object.body;
      let size = object.size;
      let fallbackType = blob.type;

      if (blob.partId !== null) {
        const bytes = new Uint8Array(yield* Effect.promise(() => object.arrayBuffer()));
        const part = partBytes(bytes, blob.partId);

        if (!part) return httpProblem(404, "blob not found");
        body = part.content;
        size = part.content.byteLength;
        fallbackType = part.type;
      }

      return new Response(body, {
        headers: {
          "content-type": SAFE_TYPE.test(requested) ? requested : fallbackType,
          "content-length": String(size),
          "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
          "x-content-type-options": "nosniff",
          "content-security-policy": "default-src 'none'; sandbox",
          // Blob IDs name immutable content, but access is per principal: never shared caches.
          "cache-control": "private, immutable, max-age=31536000",
        },
      });
    }),
  ),
);

/** Blob upload (RFC 8620 §6.1): immutable bytes for the uploader, expiring unless referenced. */
const upload = route("POST", "/jmap/upload/:accountId", (request, params, env) =>
  withPrincipal(request, env, (principal) =>
    Effect.gen(function* () {
      const accountId = params["accountId"] ?? "";

      if (!principal.mailboxIds.includes(accountId)) return httpProblem(404, "account not found");

      if (!principal.scopes.includes("draft")) return httpProblem(403, "missing scope draft");

      const generation =
        (yield* Effect.promise(() => restoreGenerations(env, "mailbox", [accountId]))).get(
          accountId,
        ) ?? 0;

      const acct = yield* Effect.promise(() =>
        mailbox(env, accountId).jmapAccount(principal.userId, generation),
      );

      if (!acct) return httpProblem(404, "account not found");

      if (acct.isReadOnly) return httpProblem(403, "account is read-only");
      const declared = Number(request.headers.get("content-length") ?? "");

      if (Number.isFinite(declared) && declared > CORE_LIMITS.maxSizeUpload)
        return problem(requestProblem("limit", "upload too large", "maxSizeUpload"));
      const bytes = new Uint8Array(yield* Effect.promise(() => request.arrayBuffer()));

      if (bytes.byteLength > CORE_LIMITS.maxSizeUpload)
        return problem(requestProblem("limit", "upload too large", "maxSizeUpload"));
      const digest = yield* Effect.promise(() => sha256Hex(bytes));
      const r2Key = `t/${accountId}/jmap/up/${digest}`;

      const type = (request.headers.get("content-type") ?? "application/octet-stream")
        .split(";")[0]!
        .trim();

      yield* Effect.promise(() =>
        env.PARTS.put(r2Key, bytes, { httpMetadata: { contentType: type } }),
      );
      const blobId = `U${digest.slice(0, 40)}`;

      yield* Effect.promise(() =>
        mailbox(env, accountId).jmapRegisterUpload(principal.userId, {
          blobId,
          r2Key,
          size: bytes.byteLength,
          type,
        }),
      );

      return json({ accountId, blobId, type, size: bytes.byteLength }, 201);
    }),
  ),
);

/**
 * EventSource (RFC 8620 §7.3): StateChange events fanned in from each account's authority, plus
 * pings. Streams are budgeted apart from hibernating sockets and close on revocation (A3, §5).
 */
const eventSource = route("GET", "/jmap/eventsource", (request, _params, env) =>
  withPrincipal(request, env, (principal, credentialId) =>
    Effect.gen(function* () {
      const url = new URL(request.url);
      const types = url.searchParams.get("types") ?? "*";
      const closeAfter = url.searchParams.get("closeafter") === "state";
      const ping = Math.min(Math.max(Number(url.searchParams.get("ping") ?? 0) || 0, 0), 300);
      const resolved = yield* resolveAccounts(env, principal);
      const accounts = [...resolved.accounts.values()].slice(0, MAX_STREAM_ACCOUNTS);
      const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
      const writer = writable.getWriter();
      const encoder = new TextEncoder();
      const readers: Array<ReadableStreamDefaultReader<Uint8Array>> = [];
      let closed = false;
      let timer: ReturnType<typeof setInterval> | undefined;

      const close = () => {
        if (closed) return;
        closed = true;

        if (timer !== undefined) clearInterval(timer);

        for (const r of readers) r.cancel().catch(() => undefined);
        writer.close().catch(() => undefined);
      };

      let open = accounts.length;

      if (open === 0) close();

      for (const a of accounts) {
        const response = yield* Effect.promise(() =>
          mailbox(env, a.accountId).fetch(
            new Request(
              `https://mailbox/jmap-events?principal=${encodeURIComponent(principal.userId)}&types=${encodeURIComponent(types)}&restoreGeneration=${a.restoreGeneration}`,
              { headers: { "x-bye-credential": credentialId } },
            ),
          ),
        );

        if (!response.body) {
          open--;
          continue;
        }

        const reader = response.body.getReader();
        readers.push(reader);

        void (async () => {
          // Streams interleave only at event boundaries: a chunk may end mid-event, and another
          // account's event must never be spliced into it.
          const decoder = new TextDecoder();
          let pending = "";

          for (;;) {
            const next = await reader.read().catch(() => null);

            if (next === null || next.done || closed) break;
            pending += decoder.decode(next.value, { stream: true });
            const end = pending.lastIndexOf("\n\n");

            if (end < 0) continue;
            const events = pending.slice(0, end + 2);
            pending = pending.slice(end + 2);
            await writer.write(encoder.encode(events)).catch(close);

            if (closeAfter) {
              close();

              break;
            }
          }

          // An authority closed its stream (revocation, A3): when every one has, so does this.
          open--;

          if (open === 0) close();
        })();
      }

      if (ping > 0)
        timer = setInterval(() => {
          writer
            .write(encoder.encode(`event: ping\ndata: ${JSON.stringify({ interval: ping })}\n\n`))
            .catch(close);
        }, ping * 1000);

      return new Response(readable, {
        headers: {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        },
      });
    }),
  ),
);

export const jmapRoutes: ReadonlyArray<Route> = [session, api, download, upload, eventSource];
