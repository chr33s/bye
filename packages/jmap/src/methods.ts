import { Context, Effect, Option, Predicate, Result, Schema } from "effect";
import {
  BYE,
  CORE,
  CORE_LIMITS,
  MAIL,
  MAX_QUERY_LIMIT,
  SUBMISSION,
  VACATION_RESPONSE,
} from "./capabilities.ts";
import { type MethodDefinition, methodRegistry, Responses } from "./dispatch.ts";
import { type MethodError, methodError } from "./errors.ts";
import {
  type AuthorityState,
  type ChangeType,
  ChangesArgs,
  checkInts,
  checkProperties,
  decodeArgs,
  EMAIL_PROPERTIES,
  GetArgs,
  MAILBOX_PROPERTIES,
  type Mailbox,
  type MailReadQuery,
  type MailReadResult,
  type ObjectType,
  parseEmailFilter,
  parseEmailSort,
  parseMailboxFilter,
  parseMailboxSort,
  searchTerms,
  QueryArgs,
  QueryChangesArgs,
  SearchSnippetArgs,
  THREAD_PROPERTIES,
} from "./mail.ts";
import {
  decodeState,
  encodeQueryState,
  encodeState,
  queryDigest,
  sameStateLineage,
  type StateDomain,
} from "./state.ts";
import {
  type MailWriteCommand,
  type MailWriteResult,
  type NativeAction,
  type SetError,
  type SetOutcome,
  type SetType,
} from "./write.ts";

// Standard Core and Mail method handlers over an account port. Handlers own protocol validation
// and state tokens; the port owns authorization-checked, consistent authority reads and the
// per-object write semantics. In production these run inside the account authority, next to its
// storage, so every call is one short local transaction (spec.md §16.2, §16.4).

/**
 * - `projection`: the read-only view of a not-yet-migrated legacy account (labeled partial).
 * - `core`: an account whose authority is the JMAP core (spec.md §16 C3 state `jmap`).
 */
export type AccountProfile = "projection" | "core";

export interface MailAccount {
  readonly accountId: string;
  /**
   * Recovery generation from the registry outside the account snapshot (spec.md §16 C2): a
   * restore advances it, so no pre-restore state token is comparable afterwards.
   */
  readonly restoreGeneration: number;
  /** Principal visibility/ACL generation for this account (spec.md §16 A3, C1). */
  readonly visibilityGeneration: number;
  readonly isReadOnly: boolean;
  readonly profile?: AccountProfile;
  /** Writer epoch (C3) bound into every state token. */
  readonly writerEpoch?: number;
}

export interface MailStoreService {
  /** The accounts this principal can discover; anything else is `accountNotFound`. */
  readonly accounts: ReadonlyMap<string, MailAccount>;
  readonly read: (
    accountId: string,
    query: MailReadQuery,
  ) => Effect.Effect<MailReadResult, MethodError>;
  readonly write?: (
    accountId: string,
    command: MailWriteCommand,
  ) => Effect.Effect<MailWriteResult, MethodError>;
}

export class MailStore extends Context.Service<MailStore, MailStoreService>()("jmap/MailStore") {}

const fromResult = <A>(r: Result.Result<A, MethodError>): Effect.Effect<A, MethodError> =>
  Result.isSuccess(r) ? Effect.succeed(r.success) : Effect.fail(r.failure);

const failIf = (error: Option.Option<MethodError>): Effect.Effect<void, MethodError> =>
  Option.isSome(error) ? Effect.fail(error.value) : Effect.void;

const account = (accountId: string) =>
  Effect.gen(function* () {
    const store = yield* MailStore;
    const found = store.accounts.get(accountId);

    if (!found) return yield* methodError("accountNotFound");

    return { store, account: found };
  });

const read = <T extends MailReadResult["_tag"]>(
  accountId: string,
  query: MailReadQuery & { readonly _tag: T },
) =>
  Effect.gen(function* () {
    const { store, account: acct } = yield* account(accountId);
    const result = yield* store.read(accountId, query);

    if (Predicate.isTagged(result, "Refused"))
      return yield* methodError(result.type, result.description);

    if (!Predicate.isTagged(result, query._tag)) return yield* methodError("serverFail");

    return { account: acct, result: result as Extract<MailReadResult, { readonly _tag: T }> };
  });

const write = <T extends MailWriteResult["_tag"]>(
  accountId: string,
  command: MailWriteCommand,
  expect: T,
) =>
  Effect.gen(function* () {
    const { store, account: acct } = yield* account(accountId);

    if (acct.isReadOnly || !store.write) return yield* methodError("accountReadOnly");
    const result = yield* store.write(accountId, command);

    if (Predicate.isTagged(result, "Refused"))
      return yield* methodError(result.type, result.description);

    if (!Predicate.isTagged(result, expect)) return yield* methodError("serverFail");

    return { account: acct, result: result as Extract<MailWriteResult, { readonly _tag: T }> };
  });

const domainOf = (acct: MailAccount, type: string, state: AuthorityState): StateDomain => ({
  accountId: acct.accountId,
  type,
  restoreGeneration: acct.restoreGeneration,
  visibilityGeneration: acct.visibilityGeneration,
  writerEpoch: acct.writerEpoch ?? 0,
  revision: BigInt(state.revision),
});

const stateOf = (acct: MailAccount, type: string, state: AuthorityState): string =>
  encodeState(domainOf(acct, type, state));

/** Keep only the requested properties of a returned object (`id` is always included). */
const pick = (
  value: Mailbox | Schema.JsonObject,
  properties: ReadonlyArray<string>,
): Schema.JsonObject => {
  const source = value as Schema.JsonObject;

  return Object.fromEntries(
    properties.flatMap((p) => (Object.hasOwn(source, p) ? [[p, source[p]!]] : [])),
  );
};

/** `base` plus the optional response fields that are defined; absent ones are omitted. */
const withOptional = (
  base: Schema.JsonObject,
  optional: ReadonlyArray<readonly [string, Schema.Json | undefined]>,
): Schema.JsonObject =>
  Object.fromEntries([
    ...Object.entries(base),
    ...optional.flatMap(([key, value]) => (value === undefined ? [] : [[key, value] as const])),
  ]);

/** The `limit` to report when the requested one was clamped (RFC 8620 §5.5). */
const clamped = (limit: number | null | undefined): number | undefined =>
  limit !== undefined && limit !== null && limit > MAX_QUERY_LIMIT ? MAX_QUERY_LIMIT : undefined;

const dedupe = (ids: ReadonlyArray<string>): ReadonlyArray<string> => [...new Set(ids)];

const checkGetSize = (ids: ReadonlyArray<string> | null | undefined, allowAll: boolean) =>
  (ids === null || ids === undefined) && !allowAll
    ? Effect.fail(methodError("requestTooLarge", "ids must be given for this type"))
    : ids && ids.length > CORE_LIMITS.maxObjectsInGet
      ? Effect.fail(methodError("requestTooLarge", `at most ${CORE_LIMITS.maxObjectsInGet} ids`))
      : Effect.void;

/** Resolve `#creationId` references in an `ids` argument (RFC 8620 §5.1). */
const resolveIds = (
  ids: ReadonlyArray<string> | null | undefined,
  createdIds: ReadonlyMap<string, string>,
): ReadonlyArray<string> | null | undefined =>
  ids?.map((id) => (id.startsWith("#") ? (createdIds.get(id.slice(1)) ?? id) : id));

// ------------------------------------------------------------------ /changes

/**
 * `/changes` over the typed history (spec.md §16 C1). A fresh call fixes its target at the
 * current revision; a page that can't hold every net change returns an intermediate token
 * (base, target, cursor) and the next call continues the same target before later revisions. A
 * token from another lineage, or one whose history was compacted, is `cannotCalculateChanges`.
 */
const changes = (type: ChangeType) => (raw: Schema.JsonObject) =>
  Effect.gen(function* () {
    const args = yield* fromResult(decodeArgs(ChangesArgs)(raw));
    yield* failIf(checkInts([["maxChanges", args.maxChanges, "unsigned"]]));

    if (args.maxChanges === 0)
      return yield* methodError("invalidArguments", "maxChanges must be positive");
    const { account: acct } = yield* account(args.accountId);
    const since = decodeState(args.sinceState);

    const lineage = domainOf(acct, type, { revision: "0" });

    if (Option.isNone(since) || !sameStateLineage(since.value, lineage))
      return yield* methodError("cannotCalculateChanges");
    const limit = Math.min(args.maxChanges ?? MAX_QUERY_LIMIT, MAX_QUERY_LIMIT);
    const page = since.value.page;

    const { result } = yield* read(args.accountId, {
      _tag: "Changes",
      type,
      base: (page?.base ?? since.value.revision).toString(),
      target: page ? since.value.revision.toString() : null,
      cursor: page?.cursor ?? null,
      limit,
    });

    const target = domainOf(acct, type, result.state);

    const newState = encodeState(
      result.nextCursor === null
        ? target
        : {
            ...target,
            page: { base: page?.base ?? since.value.revision, cursor: result.nextCursor },
          },
    );

    return withOptional(
      {
        accountId: acct.accountId,
        oldState: args.sinceState,
        newState,
        hasMoreChanges: result.nextCursor !== null,
        created: [...result.created],
        updated: [...result.updated],
        destroyed: [...result.destroyed],
      },
      [["updatedProperties", type === "Mailbox" ? null : undefined]],
    );
  });

/** `/queryChanges`: the initial query profiles can't calculate changes (spec.md §16 C1). */
const queryChanges = (raw: Schema.JsonObject) =>
  Effect.gen(function* () {
    const args = yield* fromResult(decodeArgs(QueryChangesArgs)(raw));
    yield* account(args.accountId);

    return yield* methodError("cannotCalculateChanges");
  });

/** Apply position/anchor/limit to an already filtered and sorted id list (RFC 8620 §5.5). */
const window = (
  ids: ReadonlyArray<string>,
  position: number,
  anchor: string | null,
  anchorOffset: number,
  limit: number,
): Result.Result<
  { readonly ids: ReadonlyArray<string>; readonly position: number },
  MethodError
> => {
  let start: number;

  if (anchor !== null) {
    const at = ids.indexOf(anchor);

    if (at < 0) return Result.fail(methodError("anchorNotFound"));
    start = Math.max(0, at + anchorOffset);
  } else start = position < 0 ? Math.max(0, ids.length + position) : position;

  return Result.succeed({ ids: ids.slice(start, start + limit), position: start });
};

// ------------------------------------------------------------------ /set

const SetArgs = Schema.Struct({
  accountId: Schema.String,
  ifInState: Schema.optional(Schema.NullOr(Schema.String)),
  create: Schema.optional(Schema.NullOr(Schema.Record(Schema.String, Schema.JsonObject))),
  update: Schema.optional(Schema.NullOr(Schema.Record(Schema.String, Schema.JsonObject))),
  destroy: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
});

const SET_KEYS = new Set(["accountId", "ifInState", "create", "update", "destroy"]);

const errorMap = (entries: ReadonlyArray<readonly [string, SetError]>): Schema.JsonObject | null =>
  entries.length === 0
    ? null
    : Object.fromEntries(
        entries.map(([id, e]) => [
          id,
          withOptional({ type: e.type }, [
            ["description", e.description],
            ["properties", e.properties ? [...e.properties] : undefined],
            ["existingId", e.existingId],
          ]),
        ]),
      );

/** Resolve `ifInState` to an expected revision: a token of another lineage never matches. */
const expectedRevision = (acct: MailAccount, type: string, token: string | null | undefined) => {
  if (token === null || token === undefined) return Effect.succeed(null);
  const decoded = decodeState(token);

  return Option.isSome(decoded) &&
    decoded.value.page === undefined &&
    sameStateLineage(decoded.value, domainOf(acct, type, { revision: "0" }))
    ? Effect.succeed(decoded.value.revision.toString())
    : Effect.fail(methodError("stateMismatch"));
};

const formatSet = (acct: MailAccount, type: string, out: SetOutcome): Schema.JsonObject => ({
  accountId: acct.accountId,
  oldState: stateOf(acct, type, out.oldState),
  newState: stateOf(acct, type, out.newState),
  created: out.created.length ? Object.fromEntries(out.created.map(([k, v]) => [k, v])) : null,
  updated: out.updated.length ? Object.fromEntries(out.updated.map(([k, v]) => [k, v])) : null,
  destroyed: out.destroyed.length ? [...out.destroyed] : null,
  notCreated: errorMap(out.notCreated),
  notUpdated: errorMap(out.notUpdated),
  notDestroyed: errorMap(out.notDestroyed),
});

const recordCreated = (out: SetOutcome, createdIds: Map<string, string>) => {
  for (const [cid, obj] of out.created) {
    const id = obj["id"];

    if (Predicate.isString(id)) createdIds.set(cid, id);
  }
};

/** Generic `/set` (RFC 8620 §5.3); `optionKeys` are the method's extra arguments. */
const setMethod =
  (type: SetType, optionKeys: ReadonlyArray<string>): MethodDefinition<MailStore>["handler"] =>
  (raw, context) =>
    Effect.gen(function* () {
      const args = yield* fromResult(decodeArgs(SetArgs)(raw));

      for (const key of Object.keys(raw))
        if (!SET_KEYS.has(key) && !optionKeys.includes(key))
          return yield* methodError("invalidArguments", `unknown argument ${key}`);
      const create = Object.entries(args.create ?? {});
      const update = Object.entries(args.update ?? {});
      const destroy = resolveIds(args.destroy ?? [], context.createdIds) ?? [];

      if (create.length + update.length + destroy.length > CORE_LIMITS.maxObjectsInSet)
        return yield* methodError(
          "requestTooLarge",
          `at most ${CORE_LIMITS.maxObjectsInSet} objects`,
        );
      const { account: acct } = yield* account(args.accountId);
      const ifInState = yield* expectedRevision(acct, type, args.ifInState);

      const { result } = yield* write(
        args.accountId,
        {
          _tag: "Set",
          type,
          ifInState,
          create,
          update: update.map(([id, patch]) => [
            id.startsWith("#") ? (context.createdIds.get(id.slice(1)) ?? id) : id,
            patch,
          ]),
          destroy,
          options: Object.fromEntries(
            optionKeys.flatMap((k) => (Object.hasOwn(raw, k) ? [[k, raw[k]!]] : [])),
          ),
          createdIds: [...context.createdIds],
        },
        "Set",
      );

      recordCreated(result, context.createdIds);
      const main = formatSet(acct, type, result);

      if (!result.implicitEmail) return main;
      recordCreated(result.implicitEmail, context.createdIds);

      return new Responses([
        [`${type}/set`, main],
        ["Email/set", formatSet(acct, "Email", result.implicitEmail)],
      ]);
    });

// ------------------------------------------------------------------ methods

const mailboxGet: MethodDefinition<MailStore> = {
  name: "Mailbox/get",
  capability: MAIL,
  handler: (raw, context) =>
    Effect.gen(function* () {
      const args = yield* fromResult(decodeArgs(GetArgs)(raw));
      const properties = yield* fromResult(checkProperties(MAILBOX_PROPERTIES, args.properties));
      yield* checkGetSize(args.ids, true);
      const ids = resolveIds(args.ids, context.createdIds);

      const { account: acct, result } = yield* read(args.accountId, {
        _tag: "MailboxGet",
        ids: ids ? dedupe(ids) : null,
      });

      return {
        accountId: acct.accountId,
        state: stateOf(acct, "Mailbox", result.state),
        list: result.list.map((m) => pick(m, properties)),
        notFound: [...result.notFound],
      };
    }),
};

const mailboxQuery: MethodDefinition<MailStore> = {
  name: "Mailbox/query",
  capability: MAIL,
  handler: (raw) =>
    Effect.gen(function* () {
      const args = yield* fromResult(decodeArgs(QueryArgs)(raw));
      yield* failIf(
        checkInts([
          ["position", args.position, "signed"],
          ["anchorOffset", args.anchorOffset, "signed"],
          ["limit", args.limit, "unsigned"],
        ]),
      );
      const filter = yield* fromResult(parseMailboxFilter(args.filter));
      const sort = yield* fromResult(parseMailboxSort(args.sort));

      const { account: acct, result } = yield* read(args.accountId, {
        _tag: "MailboxGet",
        ids: null,
      });

      const matching = result.list.filter(
        (m) =>
          (filter.parentId === undefined || m.parentId === filter.parentId) &&
          (filter.name === undefined || m.name.toLowerCase().includes(filter.name.toLowerCase())) &&
          (filter.role === undefined || m.role === filter.role) &&
          (filter.hasAnyRole === undefined || (m.role !== null) === filter.hasAnyRole) &&
          (filter.isSubscribed === undefined || m.isSubscribed === filter.isSubscribed),
      );

      const sorted = [...matching].sort((a, b) => {
        for (const s of sort) {
          const order =
            s.property === "name" ? a.name.localeCompare(b.name) : a.sortOrder - b.sortOrder;

          if (order !== 0) return s.isAscending ? order : -order;
        }

        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      });

      const limit = Math.min(args.limit ?? MAX_QUERY_LIMIT, MAX_QUERY_LIMIT);

      const page = yield* fromResult(
        window(
          sorted.map((m) => m.id),
          args.position ?? 0,
          args.anchor ?? null,
          args.anchorOffset ?? 0,
          limit,
        ),
      );

      return withOptional(
        {
          accountId: acct.accountId,
          queryState: encodeQueryState({
            ...domainOf(acct, "Mailbox", result.state),
            query: queryDigest({
              filter: args.filter ?? null,
              sort: (args.sort ?? []).map((c) => ({ ...c })),
            }),
            indexGeneration: 0,
          }),
          canCalculateChanges: false,
          position: page.position,
          ids: [...page.ids],
        },
        [
          ["total", args.calculateTotal ? sorted.length : undefined],
          ["limit", clamped(args.limit)],
        ],
      );
    }),
};

const threadGet: MethodDefinition<MailStore> = {
  name: "Thread/get",
  capability: MAIL,
  handler: (raw, context) =>
    Effect.gen(function* () {
      const args = yield* fromResult(decodeArgs(GetArgs)(raw));
      const properties = yield* fromResult(checkProperties(THREAD_PROPERTIES, args.properties));
      yield* checkGetSize(args.ids, false);

      const { account: acct, result } = yield* read(args.accountId, {
        _tag: "ThreadGet",
        ids: dedupe(resolveIds(args.ids, context.createdIds) ?? []),
      });

      return {
        accountId: acct.accountId,
        state: stateOf(acct, "Thread", result.state),
        list: result.list.map((t) => pick({ id: t.id, emailIds: [...t.emailIds] }, properties)),
        notFound: [...result.notFound],
      };
    }),
};

/** RFC 8621 §4.1 default properties of Email/get. */
const RFC_DEFAULT_EMAIL_PROPERTIES = [
  "id",
  "blobId",
  "threadId",
  "mailboxIds",
  "keywords",
  "size",
  "receivedAt",
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

const HEADER_PROPERTY =
  /^header:[\x21-\x39\x3b-\x7e]+(:as(Raw|Text|Addresses|GroupedAddresses|MessageIds|Date|URLs))?(:all)?$/;

/** Email properties: the projection serves its catalog; the core serves every standard one. */
const emailProperties = (
  acct: MailAccount,
  requested: ReadonlyArray<string> | null | undefined,
): Result.Result<ReadonlyArray<string>, MethodError> => {
  if (acct.profile !== "core") return checkProperties(EMAIL_PROPERTIES, requested);
  const list = requested ?? RFC_DEFAULT_EMAIL_PROPERTIES;
  const known = new Set([...RFC_DEFAULT_EMAIL_PROPERTIES, "headers", "bodyStructure"]);

  for (const p of list)
    if (!known.has(p) && !HEADER_PROPERTY.test(p))
      return Result.fail(methodError("invalidArguments", `unknown property: ${p}`));

  return Result.succeed(list.includes("id") ? list : ["id", ...list]);
};

const emailGet: MethodDefinition<MailStore> = {
  name: "Email/get",
  capability: MAIL,
  handler: (raw, context) =>
    Effect.gen(function* () {
      const args = yield* fromResult(decodeArgs(GetArgs)(raw));
      const { account: acct } = yield* account(args.accountId);
      const properties = yield* fromResult(emailProperties(acct, args.properties));
      yield* checkGetSize(args.ids, false);

      const { result } = yield* read(args.accountId, {
        _tag: "EmailGet",
        ids: dedupe(resolveIds(args.ids, context.createdIds) ?? []),
        properties,
      });

      return {
        accountId: acct.accountId,
        state: stateOf(acct, "Email", result.state),
        list: [...result.list],
        notFound: [...result.notFound],
      };
    }),
};

const emailQuery: MethodDefinition<MailStore> = {
  name: "Email/query",
  capability: MAIL,
  handler: (raw) =>
    Effect.gen(function* () {
      const args = yield* fromResult(decodeArgs(QueryArgs)(raw));
      yield* failIf(
        checkInts([
          ["position", args.position, "signed"],
          ["anchorOffset", args.anchorOffset, "signed"],
          ["limit", args.limit, "unsigned"],
        ]),
      );
      const filter = yield* fromResult(parseEmailFilter(args.filter));
      const sort = yield* fromResult(parseEmailSort(args.sort));
      const collapseThreads = args.collapseThreads ?? false;
      const limit = Math.min(args.limit ?? MAX_QUERY_LIMIT, MAX_QUERY_LIMIT);

      const { account: acct, result } = yield* read(args.accountId, {
        _tag: "EmailQuery",
        filter,
        sort,
        collapseThreads,
        position: args.position ?? 0,
        anchor: args.anchor ?? null,
        anchorOffset: args.anchorOffset ?? 0,
        limit,
        calculateTotal: args.calculateTotal ?? false,
      });

      if (!result.anchorFound) return yield* methodError("anchorNotFound");

      return withOptional(
        {
          accountId: acct.accountId,
          queryState: encodeQueryState({
            ...domainOf(acct, "Email", result.state),
            query: queryDigest({
              filter: args.filter ?? null,
              sort: sort.map((s) => ({ ...s })),
              collapseThreads,
            }),
            indexGeneration: 0,
          }),
          canCalculateChanges: false,
          position: result.position,
          ids: [...result.ids],
        },
        [
          ["total", result.total ?? undefined],
          ["limit", clamped(args.limit)],
        ],
      );
    }),
};

/**
 * SearchSnippet/get (RFC 8621 §5.1). On the core, matching terms of the filter's text, subject
 * and body conditions are highlighted with `<mark>` in an HTML-escaped subject and body excerpt;
 * a field without a match is null. The read-only projection evaluates no text conditions, so its
 * snippets are always null.
 */
const searchSnippetGet: MethodDefinition<MailStore> = {
  name: "SearchSnippet/get",
  capability: MAIL,
  handler: (raw, context) =>
    Effect.gen(function* () {
      const args = yield* fromResult(decodeArgs(SearchSnippetArgs)(raw));
      const filter = yield* fromResult(parseEmailFilter(args.filter));
      yield* checkGetSize(args.emailIds, false);
      const { account: acct } = yield* account(args.accountId);
      const ids = dedupe(resolveIds(args.emailIds, context.createdIds) ?? []);

      if (acct.profile === "core") {
        const { result } = yield* read(args.accountId, {
          _tag: "Snippets",
          ids,
          terms: searchTerms(filter),
        });

        return {
          accountId: acct.accountId,
          list: result.list.map((s) => ({ ...s })),
          notFound: result.notFound.length > 0 ? [...result.notFound] : null,
        };
      }

      const { result } = yield* read(args.accountId, { _tag: "EmailGet", ids, properties: ["id"] });

      return {
        accountId: acct.accountId,
        list: result.list.map((e) => ({ emailId: e["id"] ?? null, subject: null, preview: null })),
        notFound: result.notFound.length > 0 ? [...result.notFound] : null,
      };
    }),
};

/** `/get` for the non-mail object types (Identity, EmailSubmission, extensions…). */
const objectGet =
  (type: ObjectType): MethodDefinition<MailStore>["handler"] =>
  (raw, context) =>
    Effect.gen(function* () {
      const args = yield* fromResult(decodeArgs(GetArgs)(raw));
      yield* checkGetSize(args.ids, true);

      const { account: acct, result } = yield* read(args.accountId, {
        _tag: "ObjectGet",
        type,
        ids: resolveIds(args.ids, context.createdIds) ?? null,
      });

      if (result.list.length > CORE_LIMITS.maxObjectsInGet)
        return yield* methodError("requestTooLarge");
      const properties = args.properties;

      return {
        accountId: acct.accountId,
        state: stateOf(acct, type, result.state),
        list: result.list.map((o) =>
          properties ? pick(o, properties.includes("id") ? properties : ["id", ...properties]) : o,
        ),
        notFound: [...result.notFound],
      };
    });

const SubmissionFilter = Schema.Struct({
  identityIds: Schema.optional(Schema.Array(Schema.String)),
  emailIds: Schema.optional(Schema.Array(Schema.String)),
  threadIds: Schema.optional(Schema.Array(Schema.String)),
  undoStatus: Schema.optional(Schema.Literals(["pending", "final", "canceled"])),
  before: Schema.optional(Schema.String),
  after: Schema.optional(Schema.String),
});

const SUBMISSION_FILTER_KEYS = new Set([
  "identityIds",
  "emailIds",
  "threadIds",
  "undoStatus",
  "before",
  "after",
]);

const submissionQuery: MethodDefinition<MailStore> = {
  name: "EmailSubmission/query",
  capability: SUBMISSION,
  handler: (raw) =>
    Effect.gen(function* () {
      const args = yield* fromResult(decodeArgs(QueryArgs)(raw));
      yield* failIf(
        checkInts([
          ["position", args.position, "signed"],
          ["anchorOffset", args.anchorOffset, "signed"],
          ["limit", args.limit, "unsigned"],
        ]),
      );

      if (
        args.filter &&
        (Option.isNone(Schema.decodeUnknownOption(SubmissionFilter)(args.filter)) ||
          Object.keys(args.filter).some((k) => !SUBMISSION_FILTER_KEYS.has(k)))
      )
        return yield* methodError("unsupportedFilter");

      for (const c of args.sort ?? [])
        if (!["emailId", "threadId", "sentAt"].includes(c.property))
          return yield* methodError("unsupportedSort", c.property);
      const limit = Math.min(args.limit ?? MAX_QUERY_LIMIT, MAX_QUERY_LIMIT);

      const { account: acct, result } = yield* read(args.accountId, {
        _tag: "SubmissionQuery",
        filter: args.filter ?? null,
        sort: args.sort ?? [],
        position: args.position ?? 0,
        anchor: args.anchor ?? null,
        anchorOffset: args.anchorOffset ?? 0,
        limit,
        calculateTotal: args.calculateTotal ?? false,
      });

      if (!result.anchorFound) return yield* methodError("anchorNotFound");

      return withOptional(
        {
          accountId: acct.accountId,
          queryState: encodeQueryState({
            ...domainOf(acct, "EmailSubmission", result.state),
            query: queryDigest({
              filter: args.filter ?? null,
              sort: (args.sort ?? []).map((c) => ({ ...c })),
            }),
            indexGeneration: 0,
          }),
          canCalculateChanges: false,
          position: result.position,
          ids: [...result.ids],
        },
        [
          ["total", result.total ?? undefined],
          ["limit", clamped(args.limit)],
        ],
      );
    }),
};

const ImportArgs = Schema.Struct({
  accountId: Schema.String,
  ifInState: Schema.optional(Schema.NullOr(Schema.String)),
  emails: Schema.Record(
    Schema.String,
    Schema.Struct({
      blobId: Schema.String,
      mailboxIds: Schema.Record(Schema.String, Schema.Literal(true)),
      keywords: Schema.optional(Schema.Record(Schema.String, Schema.Literal(true))),
      receivedAt: Schema.optional(Schema.String),
    }),
  ),
});

const emailImport: MethodDefinition<MailStore> = {
  name: "Email/import",
  capability: MAIL,
  handler: (raw, context) =>
    Effect.gen(function* () {
      const args = yield* fromResult(decodeArgs(ImportArgs)(raw));
      const entries = Object.entries(args.emails);

      if (entries.length > CORE_LIMITS.maxObjectsInSet)
        return yield* methodError("requestTooLarge");
      const { account: acct } = yield* account(args.accountId);
      const ifInState = yield* expectedRevision(acct, "Email", args.ifInState);

      const resolve = (id: string) =>
        id.startsWith("#") ? (context.createdIds.get(id.slice(1)) ?? id) : id;

      const emails = entries.map(
        ([cid, e]) =>
          [
            cid,
            {
              blobId: resolve(e.blobId),
              mailboxIds: Object.keys(e.mailboxIds).map(resolve),
              keywords: Object.keys(e.keywords ?? {}),
              receivedAt:
                e.receivedAt !== undefined && Number.isFinite(Date.parse(e.receivedAt))
                  ? Date.parse(e.receivedAt)
                  : null,
            },
          ] as const,
      );

      const { result } = yield* write(
        args.accountId,
        { _tag: "Import", ifInState, emails, createdIds: [...context.createdIds] },
        "Set",
      );

      recordCreated(result, context.createdIds);
      const full = formatSet(acct, "Email", result);

      return {
        accountId: full["accountId"]!,
        oldState: full["oldState"]!,
        newState: full["newState"]!,
        created: full["created"]!,
        notCreated: full["notCreated"]!,
      };
    }),
};

const NativeArgs = Schema.Struct({
  accountId: Schema.String,
  emails: Schema.Record(Schema.String, Schema.NullOr(Schema.Number)),
  action: Schema.JsonObject,
  intentId: Schema.optional(Schema.NullOr(Schema.String)),
  /** UTCDate: arm a timer instead of acting now (spec.md §16 A2). */
  at: Schema.optional(Schema.NullOr(Schema.String)),
});

const NativeActionSchema = Schema.Union([
  Schema.Struct({ type: Schema.Literal("archive") }),
  Schema.Struct({
    type: Schema.Literal("move"),
    from: Schema.Array(Schema.String),
    to: Schema.String,
  }),
  Schema.Struct({ type: Schema.Literal("trash") }),
  Schema.Struct({ type: Schema.Literal("spam") }),
  Schema.Struct({ type: Schema.Literal("restore"), to: Schema.String }),
  Schema.Struct({ type: Schema.Literal("label"), mailboxId: Schema.String, add: Schema.Boolean }),
  Schema.Struct({ type: Schema.Literal("seen"), value: Schema.Boolean }),
  Schema.Struct({ type: Schema.Literal("flag"), value: Schema.Boolean }),
  Schema.Struct({ type: Schema.Literal("acceptScreener"), to: Schema.String }),
  Schema.Struct({ type: Schema.Literal("destroy") }),
  Schema.Struct({ type: Schema.Literal("emptyTrash") }),
]);

const toNativeAction = (a: typeof NativeActionSchema.Type): NativeAction => {
  switch (a.type) {
    case "archive":
      return { _tag: "Archive" };
    case "move":
      return { _tag: "Move", from: a.from, to: a.to };
    case "trash":
      return { _tag: "Trash" };
    case "spam":
      return { _tag: "Spam" };
    case "restore":
      return { _tag: "Restore", to: a.to };
    case "label":
      return { _tag: "Label", mailboxId: a.mailboxId, add: a.add };
    case "seen":
      return { _tag: "Seen", seen: a.value };
    case "flag":
      return { _tag: "Flag", flagged: a.value };
    case "acceptScreener":
      return { _tag: "AcceptScreener", to: a.to };
    case "destroy":
      return { _tag: "DestroyPermanently" };
    case "emptyTrash":
      return { _tag: "EmptyTrash" };
  }
};

/**
 * Bye native actions (spec.md §16 A1) as a vendor method: the exact Email IDs and placement
 * versions captured at selection, per-email results, and an optional intent ID so a lost
 * response replays the stored result instead of acting twice (B1).
 */
const nativeApply: MethodDefinition<MailStore> = {
  name: "EmailAction/apply",
  capability: BYE,
  handler: (raw) =>
    Effect.gen(function* () {
      const args = yield* fromResult(decodeArgs(NativeArgs)(raw));
      const action = Schema.decodeUnknownOption(NativeActionSchema)(args.action);

      if (Option.isNone(action)) return yield* methodError("invalidArguments", "unknown action");
      const emails = Object.entries(args.emails);

      if (emails.length > CORE_LIMITS.maxObjectsInSet) return yield* methodError("requestTooLarge");
      const dueAt = args.at ? Date.parse(args.at) : null;

      if (dueAt !== null && !Number.isFinite(dueAt))
        return yield* methodError("invalidArguments", "at must be a UTCDate");

      const { account: acct, result } = yield* write(
        args.accountId,
        {
          _tag: "Native",
          emails,
          action: toNativeAction(action.value),
          intentId: args.intentId ?? null,
          dueAt,
        },
        "Native",
      );

      return {
        accountId: acct.accountId,
        newState: stateOf(acct, "Email", result.state),
        replayed: result.replayed,
        timerId: result.timerId ?? null,
        results: Object.fromEntries(
          result.results.map(([id, r]) => [id, withOptional({ ok: r.ok }, [["reason", r.reason]])]),
        ),
      };
    }),
};

const define = (
  name: string,
  capability: string,
  handler: MethodDefinition<MailStore>["handler"],
): MethodDefinition<MailStore> => ({ name, capability, handler });

/** Every account-scoped method the authority answers; anything else is `unknownMethod`. */
export const ACCOUNT_METHODS: ReadonlyArray<MethodDefinition<MailStore>> = [
  mailboxGet,
  define("Mailbox/changes", MAIL, changes("Mailbox")),
  mailboxQuery,
  define("Mailbox/queryChanges", MAIL, queryChanges),
  define("Mailbox/set", MAIL, setMethod("Mailbox", ["onDestroyRemoveEmails"])),
  threadGet,
  define("Thread/changes", MAIL, changes("Thread")),
  emailGet,
  define("Email/changes", MAIL, changes("Email")),
  emailQuery,
  define("Email/queryChanges", MAIL, queryChanges),
  define("Email/set", MAIL, setMethod("Email", [])),
  emailImport,
  searchSnippetGet,
  define("Identity/get", SUBMISSION, objectGet("Identity")),
  define("Identity/changes", SUBMISSION, changes("Identity")),
  define("Identity/set", SUBMISSION, setMethod("Identity", [])),
  define("EmailSubmission/get", SUBMISSION, objectGet("EmailSubmission")),
  define("EmailSubmission/changes", SUBMISSION, changes("EmailSubmission")),
  submissionQuery,
  define("EmailSubmission/queryChanges", SUBMISSION, queryChanges),
  define(
    "EmailSubmission/set",
    SUBMISSION,
    setMethod("EmailSubmission", ["onSuccessUpdateEmail", "onSuccessDestroyEmail"]),
  ),
  define("VacationResponse/get", VACATION_RESPONSE, objectGet("VacationResponse")),
  define("VacationResponse/set", VACATION_RESPONSE, setMethod("VacationResponse", [])),
  define("Conversation/get", BYE, objectGet("Conversation")),
  define("Conversation/changes", BYE, changes("Conversation")),
  define("Conversation/set", BYE, setMethod("Conversation", [])),
  define("DraftSession/get", BYE, objectGet("DraftSession")),
  define("DraftSession/changes", BYE, changes("DraftSession")),
  define("DraftSession/set", BYE, setMethod("DraftSession", [])),
  nativeApply,
];

export const ACCOUNT_REGISTRY = methodRegistry(ACCOUNT_METHODS);

const coreEcho: MethodDefinition<never> = {
  name: "Core/echo",
  capability: CORE,
  handler: (args) => Effect.succeed(args),
};

/** In-process registry: every account method plus Core/echo (tests and single-process hosts). */
export const MAIL_METHODS: ReadonlyArray<MethodDefinition<MailStore>> = [
  coreEcho,
  ...ACCOUNT_METHODS,
];

export const MAIL_REGISTRY = methodRegistry(MAIL_METHODS);

export { coreEcho };
