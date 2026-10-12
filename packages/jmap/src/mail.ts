import { Option, Predicate, Result, Schema } from "effect";
import { type MethodError, methodError, type MethodErrorType } from "./errors.ts";

// JMAP Mail data types and argument parsing (RFC 8621 §§2–5). Storage-independent: the account
// authority answers `MailReadQuery` values and this module owns the protocol-level validation.

/** Standard Mailbox roles Bye uses (spec.md §16 A1). Role-less workflow Mailboxes have none. */
export const MAILBOX_ROLES = ["inbox", "drafts", "sent", "trash", "junk", "archive"] as const;

export type MailboxRole = (typeof MAILBOX_ROLES)[number];

export interface MailboxRights {
  readonly mayReadItems: boolean;
  readonly mayAddItems: boolean;
  readonly mayRemoveItems: boolean;
  readonly maySetSeen: boolean;
  readonly maySetKeywords: boolean;
  readonly mayCreateChild: boolean;
  readonly mayRename: boolean;
  readonly mayDelete: boolean;
  readonly maySubmit: boolean;
}

export interface Mailbox {
  readonly id: string;
  readonly name: string;
  readonly parentId: string | null;
  readonly role: MailboxRole | null;
  readonly sortOrder: number;
  readonly totalEmails: number;
  readonly unreadEmails: number;
  readonly totalThreads: number;
  readonly unreadThreads: number;
  readonly myRights: MailboxRights;
  readonly isSubscribed: boolean;
}

export interface Thread {
  readonly id: string;
  readonly emailIds: ReadonlyArray<string>;
}

export interface EmailAddress {
  readonly name: string | null;
  readonly email: string;
}

/** The rights of every Mailbox in a read-only account: read, nothing else (A3). */
export const READ_ONLY_RIGHTS: MailboxRights = {
  mayReadItems: true,
  mayAddItems: false,
  mayRemoveItems: false,
  maySetSeen: false,
  maySetKeywords: false,
  mayCreateChild: false,
  mayRename: false,
  mayDelete: false,
  maySubmit: false,
};

// ------------------------------------------------------------------ property catalogs

/**
 * Every standard property with its status in this profile. `unsupported` properties are named,
 * not hidden: requesting one is `invalidArguments`, and the profile stays labeled partial (D1).
 */
export type PropertyStatus = "supported" | "unsupported";

export const MAILBOX_PROPERTIES: ReadonlyArray<readonly [string, PropertyStatus]> = [
  ["id", "supported"],
  ["name", "supported"],
  ["parentId", "supported"],
  ["role", "supported"],
  ["sortOrder", "supported"],
  ["totalEmails", "supported"],
  ["unreadEmails", "supported"],
  ["totalThreads", "supported"],
  ["unreadThreads", "supported"],
  ["myRights", "supported"],
  ["isSubscribed", "supported"],
];

export const THREAD_PROPERTIES: ReadonlyArray<readonly [string, PropertyStatus]> = [
  ["id", "supported"],
  ["emailIds", "supported"],
];

export const EMAIL_PROPERTIES: ReadonlyArray<readonly [string, PropertyStatus]> = [
  // Metadata (RFC 8621 §4.1.1)
  ["id", "supported"],
  ["blobId", "supported"],
  ["threadId", "supported"],
  ["mailboxIds", "supported"],
  ["keywords", "supported"],
  ["size", "supported"],
  ["receivedAt", "supported"],
  // Header fields parsed forms (§4.1.3)
  ["headers", "unsupported"],
  ["messageId", "supported"],
  ["inReplyTo", "supported"],
  ["references", "supported"],
  ["sender", "unsupported"],
  ["from", "supported"],
  ["to", "supported"],
  ["cc", "supported"],
  ["bcc", "unsupported"],
  ["replyTo", "unsupported"],
  ["subject", "supported"],
  ["sentAt", "supported"],
  // Body parts (§4.1.4)
  ["bodyStructure", "unsupported"],
  ["bodyValues", "unsupported"],
  ["textBody", "unsupported"],
  ["htmlBody", "unsupported"],
  ["attachments", "unsupported"],
  ["hasAttachment", "supported"],
  ["preview", "supported"],
];

const supported = (catalog: ReadonlyArray<readonly [string, PropertyStatus]>) =>
  catalog.flatMap(([name, status]) => (status === "supported" ? [name] : []));

export const DEFAULT_EMAIL_PROPERTIES = supported(EMAIL_PROPERTIES);

export const DEFAULT_MAILBOX_PROPERTIES = supported(MAILBOX_PROPERTIES);

export const DEFAULT_THREAD_PROPERTIES = supported(THREAD_PROPERTIES);

/**
 * Validate requested properties against a catalog: unknown names and names this profile doesn't
 * serve are `invalidArguments`. `id` is always returned (RFC 8620 §5.1).
 */
export const checkProperties = (
  catalog: ReadonlyArray<readonly [string, PropertyStatus]>,
  requested: ReadonlyArray<string> | null | undefined,
): Result.Result<ReadonlyArray<string>, MethodError> => {
  if (requested === null || requested === undefined) return Result.succeed(supported(catalog));
  const known = new Map(catalog);

  for (const name of requested) {
    // `header:` forms and body properties need the parsed message, not served by this profile.
    const status = known.get(name);

    if (status === undefined)
      return Result.fail(methodError("invalidArguments", `unknown property: ${name}`));

    if (status === "unsupported")
      return Result.fail(
        methodError("invalidArguments", `property not served by this server profile: ${name}`),
      );
  }

  return Result.succeed(requested.includes("id") ? requested : ["id", ...requested]);
};

// ------------------------------------------------------------------ standard arguments

const Ids = Schema.NullOr(Schema.Array(Schema.String));

export const GetArgs = Schema.Struct({
  accountId: Schema.String,
  ids: Schema.optional(Ids),
  properties: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
});

export const ChangesArgs = Schema.Struct({
  accountId: Schema.String,
  sinceState: Schema.String,
  maxChanges: Schema.optional(Schema.NullOr(Schema.Number)),
});

export const Comparator = Schema.Struct({
  property: Schema.String,
  isAscending: Schema.optional(Schema.Boolean),
  collation: Schema.optional(Schema.String),
  keyword: Schema.optional(Schema.String),
});

export type Comparator = typeof Comparator.Type;

export const QueryArgs = Schema.Struct({
  accountId: Schema.String,
  filter: Schema.optional(Schema.NullOr(Schema.JsonObject)),
  sort: Schema.optional(Schema.NullOr(Schema.Array(Comparator))),
  position: Schema.optional(Schema.Number),
  anchor: Schema.optional(Schema.NullOr(Schema.String)),
  anchorOffset: Schema.optional(Schema.Number),
  limit: Schema.optional(Schema.NullOr(Schema.Number)),
  calculateTotal: Schema.optional(Schema.Boolean),
  collapseThreads: Schema.optional(Schema.Boolean),
  // Mailbox/query only (RFC 8621 §2.3)
  sortAsTree: Schema.optional(Schema.Boolean),
  filterAsTree: Schema.optional(Schema.Boolean),
});

export const QueryChangesArgs = Schema.Struct({
  accountId: Schema.String,
  filter: Schema.optional(Schema.NullOr(Schema.JsonObject)),
  sort: Schema.optional(Schema.NullOr(Schema.Array(Comparator))),
  sinceQueryState: Schema.String,
  maxChanges: Schema.optional(Schema.NullOr(Schema.Number)),
  upToId: Schema.optional(Schema.NullOr(Schema.String)),
  calculateTotal: Schema.optional(Schema.Boolean),
  collapseThreads: Schema.optional(Schema.Boolean),
});

export const SearchSnippetArgs = Schema.Struct({
  accountId: Schema.String,
  filter: Schema.optional(Schema.NullOr(Schema.JsonObject)),
  emailIds: Schema.Array(Schema.String),
});

/** Decode method arguments; any mismatch is `invalidArguments` with the first issue. */
export const decodeArgs =
  <S extends Schema.Codec<unknown, unknown>>(schema: S) =>
  (args: Schema.JsonObject): Result.Result<S["Type"], MethodError> => {
    const decoded = Schema.decodeUnknownResult(schema as never)(args) as Result.Result<
      S["Type"],
      Schema.SchemaError
    >;

    return Result.mapError(decoded, (e) =>
      methodError("invalidArguments", String(e.message).split("\n")[0]),
    );
  };

const isUnsignedInt = (n: number) => Number.isSafeInteger(n) && n >= 0;

/** `UnsignedInt` / `Int` argument checks (RFC 8620 §1.3). */
export const checkInts = (
  values: ReadonlyArray<readonly [string, number | null | undefined, "unsigned" | "signed"]>,
): Option.Option<MethodError> => {
  for (const [name, value, kind] of values) {
    if (value === null || value === undefined) continue;

    if (kind === "unsigned" ? !isUnsignedInt(value) : !Number.isSafeInteger(value))
      return Option.some(methodError("invalidArguments", `${name} must be an ${kind} integer`));
  }

  return Option.none();
};

// ------------------------------------------------------------------ Email filters and sorts

/** The Email/query FilterCondition properties this profile evaluates (RFC 8621 §4.4.1). */
export interface EmailCondition {
  readonly allInThreadHaveKeyword?: string;
  readonly someInThreadHaveKeyword?: string;
  readonly noneInThreadHaveKeyword?: string;
  readonly text?: string;
  readonly from?: string;
  readonly to?: string;
  readonly cc?: string;
  readonly bcc?: string;
  readonly subject?: string;
  readonly body?: string;
  /** Header name and optional value substring (RFC 8621 §4.4.1 `header`). */
  readonly header?: readonly [name: string, value: string | null];
  readonly inMailbox?: string;
  readonly inMailboxOtherThan?: ReadonlyArray<string>;
  readonly before?: number;
  readonly after?: number;
  readonly minSize?: number;
  readonly maxSize?: number;
  readonly hasKeyword?: string;
  readonly notKeyword?: string;
  readonly hasAttachment?: boolean;
}

export type EmailFilter =
  | {
      readonly _tag: "Operator";
      readonly operator: "AND" | "OR" | "NOT";
      readonly conditions: ReadonlyArray<EmailFilter>;
    }
  | { readonly _tag: "Condition"; readonly condition: EmailCondition };

/**
 * Conditions only the JMAP core evaluates; the legacy projection refuses them with
 * `unsupportedFilter` (see `projectionSupportsFilter`).
 */
export const CORE_ONLY_CONDITIONS: ReadonlyArray<keyof EmailCondition> = [
  "allInThreadHaveKeyword",
  "someInThreadHaveKeyword",
  "noneInThreadHaveKeyword",
  "text",
  "from",
  "to",
  "cc",
  "bcc",
  "subject",
  "body",
  "header",
];

/**
 * The free-text terms a filter searches for (text/subject/body), for snippet highlighting.
 * Terms under NOT are excluded: they describe what didn't match.
 */
export const searchTerms = (filter: EmailFilter | null): ReadonlyArray<string> => {
  if (filter === null) return [];

  if (Predicate.isTagged(filter, "Operator"))
    return filter.operator === "NOT" ? [] : filter.conditions.flatMap(searchTerms);
  const c = filter.condition;

  return [c.text, c.subject, c.body].flatMap((t) =>
    t === undefined
      ? []
      : t
          .toLowerCase()
          .split(/[^\p{L}\p{N}]+/u)
          .filter((w) => w.length > 0),
  );
};

/** Whether a parsed filter uses only conditions the legacy projection can evaluate. */
export const projectionSupportsFilter = (filter: EmailFilter | null): boolean =>
  filter === null ||
  (Predicate.isTagged(filter, "Operator")
    ? filter.conditions.every(projectionSupportsFilter)
    : CORE_ONLY_CONDITIONS.every((k) => filter.condition[k] === undefined));

const MAX_TEXT_CONDITION = 512;

const MAX_FILTER_DEPTH = 8;

const KEYWORD = /^[\x21-\x7e]{1,255}$/;

const FORBIDDEN_KEYWORD_CHARS = /[()[\]{}%*"\\]/;

/** Keywords are case-insensitive and stored lowercased (RFC 8621 §4.1.1). */
export const normalizeKeyword = (k: string): Option.Option<string> =>
  KEYWORD.test(k) && !FORBIDDEN_KEYWORD_CHARS.test(k)
    ? Option.some(k.toLowerCase())
    : Option.none();

/** A UTCDate (RFC 8620 §1.4): whole seconds drop the fraction. */
export const utcDate = (ms: number): string => new Date(ms).toISOString().replace(".000Z", "Z");

const parseUtcDate = (value: Schema.Json): Option.Option<number> => {
  if (!Predicate.isString(value)) return Option.none();

  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(value)) return Option.none();
  const ms = Date.parse(value);

  return Number.isFinite(ms) ? Option.some(ms) : Option.none();
};

const unsupportedFilter = (detail: string) => methodError("unsupportedFilter", detail);

const parseCondition = (record: Schema.JsonObject): Result.Result<EmailFilter, MethodError> => {
  const condition: {
    -readonly [K in keyof EmailCondition]: EmailCondition[K];
  } = {};

  for (const [key, value] of Object.entries(record)) {
    switch (key) {
      case "allInThreadHaveKeyword":
      case "someInThreadHaveKeyword":
      case "noneInThreadHaveKeyword": {
        const keyword = Predicate.isString(value) ? normalizeKeyword(value) : Option.none();

        if (Option.isNone(keyword)) return Result.fail(unsupportedFilter(`${key} keyword`));
        condition[key] = keyword.value;
        break;
      }

      case "text":
      case "from":
      case "to":
      case "cc":
      case "bcc":
      case "subject":
      case "body":
        if (!Predicate.isString(value) || value.length > MAX_TEXT_CONDITION)
          return Result.fail(unsupportedFilter(`${key} must be a string`));
        condition[key] = value;
        break;
      case "header": {
        if (
          !Array.isArray(value) ||
          value.length < 1 ||
          value.length > 2 ||
          !value.every(Predicate.isString)
        )
          return Result.fail(unsupportedFilter("header must be [name] or [name, value]"));
        const [name, text] = value as ReadonlyArray<string>;
        condition.header = [name!, text ?? null];
        break;
      }

      case "inMailbox":
        if (!Predicate.isString(value)) return Result.fail(unsupportedFilter("inMailbox"));
        condition.inMailbox = value;
        break;
      case "inMailboxOtherThan":
        if (!Array.isArray(value) || !value.every(Predicate.isString))
          return Result.fail(unsupportedFilter("inMailboxOtherThan"));
        condition.inMailboxOtherThan = value as ReadonlyArray<string>;
        break;
      case "before":
      case "after": {
        const at = parseUtcDate(value);

        if (Option.isNone(at)) return Result.fail(unsupportedFilter(`${key} must be a UTCDate`));
        condition[key] = at.value;
        break;
      }

      case "minSize":
      case "maxSize":
        if (!Predicate.isNumber(value) || !isUnsignedInt(value))
          return Result.fail(unsupportedFilter(`${key} must be an UnsignedInt`));
        condition[key] = value;
        break;
      case "hasKeyword":
      case "notKeyword": {
        const keyword = Predicate.isString(value) ? normalizeKeyword(value) : Option.none();

        if (Option.isNone(keyword)) return Result.fail(unsupportedFilter(`${key} keyword`));
        condition[key] = keyword.value;
        break;
      }

      case "hasAttachment":
        if (!Predicate.isBoolean(value)) return Result.fail(unsupportedFilter("hasAttachment"));
        condition.hasAttachment = value;
        break;
      default:
        return Result.fail(unsupportedFilter(`unknown filter property ${key}`));
    }
  }

  return Result.succeed({ _tag: "Condition", condition });
};

const parseFilterAt = (
  value: Schema.Json,
  depth: number,
): Result.Result<EmailFilter, MethodError> => {
  if (depth > MAX_FILTER_DEPTH) return Result.fail(unsupportedFilter("filter nests too deeply"));

  if (!Predicate.isObject(value) || Array.isArray(value))
    return Result.fail(unsupportedFilter("filter must be an object"));
  const record = value as Schema.JsonObject;

  if (!Object.hasOwn(record, "operator")) return parseCondition(record);
  const { operator, conditions } = record;

  if (operator !== "AND" && operator !== "OR" && operator !== "NOT")
    return Result.fail(unsupportedFilter("operator must be AND, OR or NOT"));

  if (!Array.isArray(conditions) || Object.keys(record).length !== 2)
    return Result.fail(unsupportedFilter("FilterOperator needs exactly operator and conditions"));
  const parsed: Array<EmailFilter> = [];

  for (const c of conditions as ReadonlyArray<Schema.Json>) {
    const child = parseFilterAt(c, depth + 1);

    if (Result.isFailure(child)) return child;
    parsed.push(child.success);
  }

  return Result.succeed({ _tag: "Operator", operator, conditions: parsed });
};

/** Parse an Email/query filter; null/absent matches everything. */
export const parseEmailFilter = (
  filter: Schema.JsonObject | null | undefined,
): Result.Result<EmailFilter | null, MethodError> =>
  filter === null || filter === undefined ? Result.succeed(null) : parseFilterAt(filter, 0);

export const EMAIL_SORT_PROPERTIES = [
  "receivedAt",
  "sentAt",
  "size",
  "subject",
  "from",
  "to",
  "hasKeyword",
] as const;

/** Sorts the legacy projection evaluates; the rest need the JMAP core. */
export const PROJECTION_SORT_PROPERTIES: ReadonlyArray<string> = ["receivedAt", "sentAt", "size"];

export interface EmailSort {
  readonly property: (typeof EMAIL_SORT_PROPERTIES)[number];
  readonly isAscending: boolean;
  /** For `hasKeyword`. */
  readonly keyword?: string;
}

/** Parse sort comparators; default is newest `receivedAt` first. Collations don't apply here. */
export const parseEmailSort = (
  sort: ReadonlyArray<Comparator> | null | undefined,
): Result.Result<ReadonlyArray<EmailSort>, MethodError> => {
  if (!sort || sort.length === 0)
    return Result.succeed([{ property: "receivedAt", isAscending: false }]);
  const out: Array<EmailSort> = [];

  for (const c of sort) {
    const property = EMAIL_SORT_PROPERTIES.find((p) => p === c.property);

    if (!property) return Result.fail(methodError("unsupportedSort", c.property));

    if (property === "hasKeyword") {
      const keyword = c.keyword === undefined ? Option.none() : normalizeKeyword(c.keyword);

      if (Option.isNone(keyword)) return Result.fail(methodError("unsupportedSort", "keyword"));
      out.push({ property, isAscending: c.isAscending ?? true, keyword: keyword.value });
      continue;
    }

    out.push({ property, isAscending: c.isAscending ?? true });
  }

  return Result.succeed(out);
};

/** Mailbox/query filter (RFC 8621 §2.3). */
export interface MailboxCondition {
  readonly parentId?: string | null;
  readonly name?: string;
  readonly role?: string | null;
  readonly hasAnyRole?: boolean;
  readonly isSubscribed?: boolean;
}

export const parseMailboxFilter = (
  filter: Schema.JsonObject | null | undefined,
): Result.Result<MailboxCondition, MethodError> => {
  if (filter === null || filter === undefined) return Result.succeed({});

  if (Object.hasOwn(filter, "operator"))
    return Result.fail(unsupportedFilter("Mailbox/query supports a single FilterCondition"));
  const condition: { -readonly [K in keyof MailboxCondition]: MailboxCondition[K] } = {};

  for (const [key, value] of Object.entries(filter)) {
    switch (key) {
      case "parentId":
      case "role":
        if (value !== null && !Predicate.isString(value))
          return Result.fail(unsupportedFilter(key));
        condition[key] = value;
        break;
      case "name":
        if (!Predicate.isString(value)) return Result.fail(unsupportedFilter(key));
        condition.name = value;
        break;
      case "hasAnyRole":
      case "isSubscribed":
        if (!Predicate.isBoolean(value)) return Result.fail(unsupportedFilter(key));
        condition[key] = value;
        break;
      default:
        return Result.fail(unsupportedFilter(`unknown filter property ${key}`));
    }
  }

  return Result.succeed(condition);
};

/** Mailbox/query sort properties (RFC 8621 §2.3). */
export const parseMailboxSort = (
  sort: ReadonlyArray<Comparator> | null | undefined,
): Result.Result<
  ReadonlyArray<{ readonly property: "name" | "sortOrder"; readonly isAscending: boolean }>,
  MethodError
> => {
  const out: Array<{ readonly property: "name" | "sortOrder"; readonly isAscending: boolean }> = [];

  for (const c of sort ?? []) {
    if (c.property !== "name" && c.property !== "sortOrder")
      return Result.fail(methodError("unsupportedSort", c.property));
    out.push({ property: c.property, isAscending: c.isAscending ?? true });
  }

  return Result.succeed(out);
};

// ------------------------------------------------------------------ authority read port

/** Data types with a `/changes` history (spec.md §16 C1). */
export const CHANGE_TYPES = [
  "Mailbox",
  "Email",
  "Thread",
  "Identity",
  "EmailSubmission",
  "VacationResponse",
  "Conversation",
  "DraftSession",
] as const;

export type ChangeType = (typeof CHANGE_TYPES)[number];

/** Non-mail object types served through the generic `ObjectGet` read. */
export type ObjectType =
  | "Identity"
  | "EmailSubmission"
  | "VacationResponse"
  | "Conversation"
  | "DraftSession";

/** One consistent read of an account authority (spec.md §16 C1: one logical view per call). */
export type MailReadQuery =
  | { readonly _tag: "State"; readonly type: ChangeType }
  | { readonly _tag: "MailboxGet"; readonly ids: ReadonlyArray<string> | null }
  | {
      readonly _tag: "EmailGet";
      readonly ids: ReadonlyArray<string>;
      readonly properties: ReadonlyArray<string>;
    }
  | {
      readonly _tag: "EmailQuery";
      readonly filter: EmailFilter | null;
      readonly sort: ReadonlyArray<EmailSort>;
      readonly collapseThreads: boolean;
      readonly position: number;
      readonly anchor: string | null;
      readonly anchorOffset: number;
      readonly limit: number;
      readonly calculateTotal: boolean;
    }
  | { readonly _tag: "ThreadGet"; readonly ids: ReadonlyArray<string> }
  | {
      /** Highlighted subject/preview for the given search terms (RFC 8621 §5.1). */
      readonly _tag: "Snippets";
      readonly ids: ReadonlyArray<string>;
      readonly terms: ReadonlyArray<string>;
    }
  | {
      /**
       * Net changes of one type in (base, target] for object IDs after `cursor`, at most `limit`.
       * `target` null means the current revision (the start of a fresh `/changes`).
       */
      readonly _tag: "Changes";
      readonly type: ChangeType;
      readonly base: string;
      readonly target: string | null;
      readonly cursor: string | null;
      readonly limit: number;
    }
  | {
      readonly _tag: "ObjectGet";
      readonly type: ObjectType;
      readonly ids: ReadonlyArray<string> | null;
    }
  | {
      readonly _tag: "SubmissionQuery";
      readonly filter: Schema.JsonObject | null;
      readonly sort: ReadonlyArray<Comparator>;
      readonly position: number;
      readonly anchor: string | null;
      readonly anchorOffset: number;
      readonly limit: number;
      readonly calculateTotal: boolean;
    };

/** The authority's revision at the moment it answered. */
export interface AuthorityState {
  /** Monotonic revision as a decimal string (no precision loss across RPC). */
  readonly revision: string;
}

export type MailReadResult =
  | {
      /** The authority refused the read with a standard method error (e.g. `unsupportedFilter`). */
      readonly _tag: "Refused";
      readonly type: MethodErrorType;
      readonly description: string;
    }
  | { readonly _tag: "State"; readonly state: AuthorityState }
  | {
      readonly _tag: "MailboxGet";
      readonly state: AuthorityState;
      readonly list: ReadonlyArray<Mailbox>;
      readonly notFound: ReadonlyArray<string>;
    }
  | {
      readonly _tag: "EmailGet";
      readonly state: AuthorityState;
      readonly list: ReadonlyArray<Schema.JsonObject>;
      readonly notFound: ReadonlyArray<string>;
    }
  | {
      readonly _tag: "EmailQuery";
      readonly state: AuthorityState;
      readonly ids: ReadonlyArray<string>;
      readonly position: number;
      readonly total: number | null;
      /** False when an anchor was given but isn't in the results. */
      readonly anchorFound: boolean;
    }
  | {
      readonly _tag: "ThreadGet";
      readonly state: AuthorityState;
      readonly list: ReadonlyArray<Thread>;
      readonly notFound: ReadonlyArray<string>;
    }
  | {
      readonly _tag: "Changes";
      /** The target revision these changes lead to. */
      readonly state: AuthorityState;
      readonly created: ReadonlyArray<string>;
      readonly updated: ReadonlyArray<string>;
      readonly destroyed: ReadonlyArray<string>;
      /** Set when more changes up to the same target remain after this page. */
      readonly nextCursor: string | null;
    }
  | {
      readonly _tag: "Snippets";
      readonly list: ReadonlyArray<{
        readonly emailId: string;
        readonly subject: string | null;
        readonly preview: string | null;
      }>;
      readonly notFound: ReadonlyArray<string>;
    }
  | {
      readonly _tag: "ObjectGet";
      readonly state: AuthorityState;
      readonly list: ReadonlyArray<Schema.JsonObject>;
      readonly notFound: ReadonlyArray<string>;
    }
  | {
      readonly _tag: "SubmissionQuery";
      readonly state: AuthorityState;
      readonly ids: ReadonlyArray<string>;
      readonly position: number;
      readonly total: number | null;
      readonly anchorFound: boolean;
    };
