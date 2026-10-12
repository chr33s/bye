import { Predicate, type Schema } from "effect";
import type { Scope } from "@bye/application";

// Credential scopes for JMAP calls (spec.md §16 A3, §8). JMAP is another surface over the same
// mailbox, so a call needs the scopes the equivalent legacy command needs
// (MAILBOX_COMMAND_SCOPES): drafting needs `draft`, organizing needs `screen`, irreversible
// removal needs `delete`, sending needs `send`, and identity/away settings need `admin`. Moving
// mail into Trash (retention destroys it) needs `delete` too: the account authority refuses it
// for a credential without (`mayTrash`), since only it knows which Mailbox is Trash.

type Args = { readonly [key: string]: Schema.Json | undefined };

const has = (args: Args, key: string) => {
  const value = args[key];

  if (Array.isArray(value)) return value.length > 0;

  return Predicate.isObject(value) && Object.keys(value).length > 0;
};

const READ_SUFFIXES = ["/get", "/changes", "/query", "/queryChanges", "/parse"];

/** Native actions that remove mail: same scope as MoveToTrash / Empty. */
const DESTRUCTIVE_ACTIONS = new Set(["trash", "destroy", "emptyTrash", "restore"]);

const actionType = (args: Args) => {
  const action = args["action"];

  return Predicate.isObject(action) && !Array.isArray(action) && Predicate.isString(action["type"])
    ? action["type"]
    : "";
};

/** Scopes a JMAP method call requires beyond `read`, from its name and arguments. */
export const jmapCallScopes = (name: string, args: Args): ReadonlyArray<Scope> => {
  if (READ_SUFFIXES.some((s) => name.endsWith(s)) || name === "Core/echo") return [];

  const scopes = new Set<Scope>();

  if (name === "Email/set") {
    if (has(args, "create")) scopes.add("draft");

    if (has(args, "update")) scopes.add("screen");

    if (has(args, "destroy")) scopes.add("delete");
  } else if (name === "Email/import" || name === "Blob/copy" || name === "Email/copy") {
    scopes.add("draft");

    if (args["onSuccessDestroyOriginal"] === true) scopes.add("delete");
  } else if (name === "Mailbox/set") {
    if (has(args, "create") || has(args, "update")) scopes.add("screen");

    if (has(args, "destroy")) scopes.add("delete");
  } else if (name === "EmailSubmission/set") {
    // Like legacy Send, the implicit Email/set on the call's own submissions needs only `send`.
    scopes.add("send");
  } else if (name === "Identity/set" || name === "VacationResponse/set") {
    scopes.add("admin");
  } else if (name === "EmailAction/apply") {
    scopes.add(DESTRUCTIVE_ACTIONS.has(actionType(args)) ? "delete" : "screen");
  } else if (name === "DraftSession/set") {
    scopes.add("draft");
  } else {
    // Any other write (Conversation/set, PushSubscription/set is handled per session): organize.
    scopes.add("screen");
  }

  return [...scopes];
};

/**
 * A `draft` credential without `delete` may still destroy its drafts (legacy DeleteDraft): the
 * call goes ahead with destroys limited to `$draft` Emails, enforced by the account authority.
 */
export const draftsOnlyDestroy = (granted: ReadonlyArray<Scope>, name: string, args: Args) =>
  name === "Email/set" &&
  has(args, "destroy") &&
  !granted.includes("delete") &&
  granted.includes("draft");

/** The first required scope the credential lacks, if any. */
export const missingScope = (
  granted: ReadonlyArray<Scope>,
  name: string,
  args: Args,
): Scope | undefined =>
  jmapCallScopes(name, args).find(
    (s) => !granted.includes(s) && !(s === "delete" && draftsOnlyDestroy(granted, name, args)),
  );
