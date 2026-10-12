import { Option, Predicate, Result, Schema } from "effect";
import type { MethodErrorType, SetErrorType } from "./errors.ts";
import { type AuthorityState, normalizeKeyword } from "./mail.ts";

// Write contracts between the protocol handlers and an account authority (RFC 8620 §5.3, §5.4;
// RFC 8621). The authority applies every object independently inside its own short transaction
// and reports per-object outcomes; one object's failure never undoes another (spec.md §16.4).

export interface SetError {
  readonly type: SetErrorType;
  readonly description?: string;
  readonly properties?: ReadonlyArray<string>;
  readonly existingId?: string;
}

export const setError = (
  type: SetErrorType,
  description?: string,
  properties?: ReadonlyArray<string>,
): SetError => ({
  type,
  ...(description === undefined ? undefined : { description }),
  ...(properties === undefined ? undefined : { properties }),
});

export type SetType =
  | "Mailbox"
  | "Email"
  | "Identity"
  | "EmailSubmission"
  | "VacationResponse"
  | "Conversation"
  | "DraftSession";

export interface SetCommand {
  readonly _tag: "Set";
  readonly type: SetType;
  /** Expected current revision of the type (from `ifInState`), or null. */
  readonly ifInState: string | null;
  readonly create: ReadonlyArray<readonly [creationId: string, object: Schema.JsonObject]>;
  readonly update: ReadonlyArray<readonly [id: string, patch: Schema.JsonObject]>;
  readonly destroy: ReadonlyArray<string>;
  /** Method-specific arguments (onDestroyRemoveEmails, onSuccessUpdateEmail, …). */
  readonly options: Schema.JsonObject;
  /** Creation IDs known before this call, for `#creationId` references. */
  readonly createdIds: ReadonlyArray<readonly [creationId: string, id: string]>;
}

export interface ImportCommand {
  readonly _tag: "Import";
  readonly ifInState: string | null;
  readonly emails: ReadonlyArray<
    readonly [
      creationId: string,
      email: {
        readonly blobId: string;
        readonly mailboxIds: ReadonlyArray<string>;
        readonly keywords: ReadonlyArray<string>;
        readonly receivedAt: number | null;
      },
    ]
  >;
  readonly createdIds: ReadonlyArray<readonly [creationId: string, id: string]>;
}

/** Bye's native mail actions (spec.md §16 A1), each a per-email policy over standard state. */
export type NativeAction =
  | { readonly _tag: "Archive" }
  | { readonly _tag: "Move"; readonly from: ReadonlyArray<string>; readonly to: string }
  | { readonly _tag: "Trash" }
  | { readonly _tag: "Spam" }
  | { readonly _tag: "Restore"; readonly to: string }
  | { readonly _tag: "Label"; readonly mailboxId: string; readonly add: boolean }
  | { readonly _tag: "Seen"; readonly seen: boolean }
  | { readonly _tag: "Flag"; readonly flagged: boolean }
  | { readonly _tag: "AcceptScreener"; readonly to: string }
  | { readonly _tag: "DestroyPermanently" }
  | { readonly _tag: "EmptyTrash" };

export interface NativeCommand {
  readonly _tag: "Native";
  /** Exact Email IDs captured at selection, with their placement versions (A1 bulk rule). */
  readonly emails: ReadonlyArray<readonly [id: string, version: number | null]>;
  readonly action: NativeAction;
  readonly intentId: string | null;
  /**
   * Run later as a timer (A2): the captured Email IDs and placement versions are rechecked at
   * execution; a later placement edit or destruction invalidates the mail-moving action.
   */
  readonly dueAt: number | null;
}

export type MailWriteCommand = SetCommand | ImportCommand | NativeCommand;

export interface SetOutcome {
  readonly _tag: "Set";
  readonly oldState: AuthorityState;
  readonly newState: AuthorityState;
  readonly created: ReadonlyArray<readonly [creationId: string, object: Schema.JsonObject]>;
  readonly updated: ReadonlyArray<readonly [id: string, changed: Schema.JsonObject | null]>;
  readonly destroyed: ReadonlyArray<string>;
  readonly notCreated: ReadonlyArray<readonly [creationId: string, error: SetError]>;
  readonly notUpdated: ReadonlyArray<readonly [id: string, error: SetError]>;
  readonly notDestroyed: ReadonlyArray<readonly [id: string, error: SetError]>;
  /** EmailSubmission/set's implicit Email/set result (RFC 8621 §7.5), when one ran. */
  readonly implicitEmail?: SetOutcome;
}

export type MailWriteResult =
  | {
      readonly _tag: "Refused";
      readonly type: MethodErrorType;
      readonly description: string;
    }
  | SetOutcome
  | {
      readonly _tag: "Native";
      readonly state: AuthorityState;
      readonly results: ReadonlyArray<
        readonly [id: string, outcome: { readonly ok: boolean; readonly reason?: string }]
      >;
      /** Replayed from a stored intent receipt rather than executed now (B1). */
      readonly replayed: boolean;
      /** Set when the action was armed as a timer instead of run now. */
      readonly timerId?: string;
    };

// ------------------------------------------------------------------ patches

/** A set-valued property update: either a full replacement or per-member additions/removals. */
export interface MemberPatch {
  readonly replace: ReadonlyArray<string> | null;
  readonly add: ReadonlyArray<string>;
  readonly remove: ReadonlyArray<string>;
}

export interface EmailPatch {
  readonly mailboxIds: MemberPatch | null;
  readonly keywords: MemberPatch | null;
}

/** Resolve a `#creationId` reference in an ID position (RFC 8620 §5.3). */
export type IdResolver = (id: string) => Option.Option<string>;

export const idResolver =
  (createdIds: ReadonlyArray<readonly [string, string]>): IdResolver =>
  (id) => {
    if (!id.startsWith("#")) return Option.some(id);
    const found = createdIds.find(([cid]) => cid === id.slice(1));

    return found ? Option.some(found[1]) : Option.none();
  };

const memberSet = (
  value: Schema.Json,
  resolve: (key: string) => Option.Option<string>,
): Option.Option<ReadonlyArray<string>> => {
  if (!Predicate.isObject(value) || Array.isArray(value)) return Option.none();
  const out: Array<string> = [];

  for (const [key, member] of Object.entries(value as Schema.JsonObject)) {
    if (member !== true) return Option.none();
    const id = resolve(key);

    if (Option.isNone(id)) return Option.none();
    out.push(id.value);
  }

  return Option.some(out);
};

const keywordKey = (k: string) => normalizeKeyword(k);

/**
 * Parse an Email/set update patch (RFC 8621 §4.6): only `mailboxIds` and `keywords` are mutable,
 * as whole values or by member path. Anything else is `invalidProperties`.
 */
export const parseEmailPatch = (
  patch: Schema.JsonObject,
  resolve: IdResolver,
): Result.Result<EmailPatch, SetError> => {
  const sets = {
    mailboxIds: {
      replace: null as ReadonlyArray<string> | null,
      add: [] as Array<string>,
      remove: [] as Array<string>,
    },
    keywords: {
      replace: null as ReadonlyArray<string> | null,
      add: [] as Array<string>,
      remove: [] as Array<string>,
    },
  };

  const touched = new Set<"mailboxIds" | "keywords">();

  for (const [path, value] of Object.entries(patch)) {
    const [head, ...rest] = path.split("/");

    if (head !== "mailboxIds" && head !== "keywords")
      return Result.fail(setError("invalidProperties", `${path} is immutable`, [path]));
    const target = sets[head];
    const resolveMember = head === "mailboxIds" ? resolve : keywordKey;
    touched.add(head);

    if (rest.length === 0) {
      const all = memberSet(value, resolveMember);

      if (Option.isNone(all)) return Result.fail(setError("invalidProperties", path, [head]));
      target.replace = all.value;
      continue;
    }

    if (rest.length !== 1) return Result.fail(setError("invalidPatch", path, [path]));
    const member = resolveMember(rest[0]!.replaceAll("~1", "/").replaceAll("~0", "~"));

    if (Option.isNone(member)) return Result.fail(setError("invalidProperties", path, [head]));

    if (value === true) target.add.push(member.value);
    else if (value === null) target.remove.push(member.value);
    else return Result.fail(setError("invalidProperties", path, [head]));
  }

  for (const key of touched) {
    const t = sets[key];

    if (t.replace !== null && (t.add.length > 0 || t.remove.length > 0))
      return Result.fail(setError("invalidPatch", `${key} replaced and patched together`, [key]));
  }

  return Result.succeed({
    mailboxIds: touched.has("mailboxIds") ? sets.mailboxIds : null,
    keywords: touched.has("keywords") ? sets.keywords : null,
  });
};

/** Apply a member patch to a current set. */
export const applyMemberPatch = (
  current: ReadonlyArray<string>,
  patch: MemberPatch,
): ReadonlyArray<string> => {
  if (patch.replace !== null) return [...new Set(patch.replace)];
  const next = new Set(current);

  for (const r of patch.remove) next.delete(r);

  for (const a of patch.add) next.add(a);

  return [...next];
};

/**
 * Generic patch for flat objects (RFC 8620 §5.3): every key must be a top-level property in
 * `mutable`; a path into a property is accepted only for `objectProperties`.
 */
export const parseFlatPatch = (
  patch: Schema.JsonObject,
  mutable: ReadonlyArray<string>,
  immutable: ReadonlyArray<string>,
): Result.Result<Schema.JsonObject, SetError> => {
  const out: { [key: string]: Schema.Json } = {};

  for (const [path, value] of Object.entries(patch)) {
    if (path.includes("/"))
      return Result.fail(
        setError("invalidPatch", `${path}: nested patches are not supported`, [path]),
      );

    if (!mutable.includes(path))
      return Result.fail(
        setError(
          "invalidProperties",
          immutable.includes(path) ? `${path} is immutable` : `unknown property ${path}`,
          [path],
        ),
      );
    out[path] = value;
  }

  return Result.succeed(out);
};

export const decodeOption = <S extends Schema.Codec<unknown, unknown>>(
  schema: S,
  value: Schema.Json | undefined,
): Option.Option<S["Type"]> =>
  Schema.decodeUnknownOption(schema as never)(value) as Option.Option<S["Type"]>;
