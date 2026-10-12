import { Predicate } from "effect";
import { ByeApiError, type ByeClient, type FetchInit, type FetchLike } from "./client.ts";
import type { JsonObject, JsonValue } from "./json.ts";

// First-party JMAP client state (spec.md §16 C4), shared by web, mobile, desktop and the CLI.
// Caches are versioned by account and model generation; a cutover or a token the server can no
// longer use resets the proprietary state and downloads a JMAP baseline. Unsent local intents are
// kept for explicit rebase: they replay only when their exact Email set is still recoverable, and
// are otherwise handed back for user review — never re-expanded.

export const JMAP_CORE = "urn:ietf:params:jmap:core";

export const JMAP_MAIL = "urn:ietf:params:jmap:mail";

export const JMAP_SUBMISSION = "urn:ietf:params:jmap:submission";

export const JMAP_VACATION = "urn:ietf:params:jmap:vacationresponse";

export const BYE_CAPABILITY = "https://github.com/chr33s/bye/blob/main/spec.md#jmap-capability";

/** Bumped when the cached model's shape changes; part of every cache key. */
export const MODEL_GENERATION = 1;

export const SESSION_PATH = "/.well-known/jmap";

export interface JmapSessionAccount {
  readonly name: string;
  readonly isPersonal: boolean;
  readonly isReadOnly: boolean;
  readonly accountCapabilities: JsonObject;
}

export interface JmapSessionResource {
  readonly apiUrl: string;
  readonly downloadUrl: string;
  readonly uploadUrl: string;
  readonly eventSourceUrl: string;
  readonly state: string;
  readonly username: string;
  readonly capabilities: JsonObject;
  readonly accounts: { readonly [accountId: string]: JmapSessionAccount };
  readonly primaryAccounts: { readonly [capability: string]: string };
}

export type Invocation = readonly [name: string, args: JsonObject, callId: string];

/** A request-level failure (problem document) or transport failure. */
export class JmapRequestError extends Error {
  override readonly name = "JmapRequestError";

  constructor(
    readonly status: number,
    readonly type: string,
    detail: string,
  ) {
    super(detail);
  }
}

/** The object at `value`, or null (wire payloads are parsed here, at the boundary). */
const objectOf = (value: JsonValue | undefined): JsonObject | null =>
  Predicate.isObject(value) && !Array.isArray(value) ? (value as JsonObject) : null;

const stringOf = (value: JsonValue | undefined): string => (Predicate.isString(value) ? value : "");

const stringsOf = (value: JsonValue | undefined): ReadonlyArray<string> =>
  Array.isArray(value) ? (value as ReadonlyArray<JsonValue>).filter(Predicate.isString) : [];

const listOf = (value: JsonValue | undefined): ReadonlyArray<JsonValue> =>
  Array.isArray(value) ? (value as ReadonlyArray<JsonValue>) : [];

const sessionAccount = (raw: JsonValue): JmapSessionAccount | null => {
  const a = objectOf(raw);

  return a
    ? {
        name: stringOf(a["name"]),
        isPersonal: a["isPersonal"] === true,
        isReadOnly: a["isReadOnly"] === true,
        accountCapabilities: objectOf(a["accountCapabilities"]) ?? {},
      }
    : null;
};

/** Parse the session resource, keeping only what this client relies on. */
export const parseSession = (value: JsonValue): JmapSessionResource => {
  const o = objectOf(value);
  const accounts = objectOf(o?.["accounts"]);

  if (!o || !accounts || !Predicate.isString(o["apiUrl"]))
    throw new JmapRequestError(502, "notSession", "response is not a JMAP session");

  const parsedAccounts: { [accountId: string]: JmapSessionAccount } = {};

  for (const [id, raw] of Object.entries(accounts)) {
    const a = sessionAccount(raw);

    if (a) parsedAccounts[id] = a;
  }

  const primaryAccounts: { [capability: string]: string } = {};

  for (const [capability, id] of Object.entries(objectOf(o["primaryAccounts"]) ?? {}))
    if (Predicate.isString(id)) primaryAccounts[capability] = id;

  return {
    apiUrl: o["apiUrl"],
    downloadUrl: stringOf(o["downloadUrl"]),
    uploadUrl: stringOf(o["uploadUrl"]),
    eventSourceUrl: stringOf(o["eventSourceUrl"]),
    state: stringOf(o["state"]),
    username: stringOf(o["username"]),
    capabilities: objectOf(o["capabilities"]) ?? {},
    accounts: parsedAccounts,
    primaryAccounts,
  };
};

/** Key-value persistence the host provides (IndexedDB, AsyncStorage, a file…). */
export interface CacheStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export const memoryCacheStore = (): CacheStore => {
  const map = new Map<string, string>();

  return {
    get: async (k) => map.get(k) ?? null,
    set: async (k, v) => void map.set(k, v),
    delete: async (k) => void map.delete(k),
  };
};

/** The served profile of an account: `core` after migration, `projection` before (C3). */
export const accountProfile = (account: JmapSessionAccount): "core" | "projection" =>
  objectOf(account.accountCapabilities[BYE_CAPABILITY])?.["profile"] === "core"
    ? "core"
    : "projection";

/**
 * Cache key: account, served profile and model generation. A cutover changes the profile, so
 * the old cache is never read against the new model (C4).
 */
export const cacheKey = (accountId: string, account: JmapSessionAccount, type: string): string =>
  `jmap:${MODEL_GENERATION}:${accountId}:${accountProfile(account)}:${type}`;

/** True for a legacy-API refusal telling this client to move to JMAP (C4). */
export const isUpgradeRequired = (body: JsonValue): boolean =>
  objectOf(objectOf(objectOf(body)?.["error"])?.["details"])?.["upgradeRequired"] === true;

export interface JmapClientOptions {
  /** Instance origin, e.g. `https://app.example`. */
  readonly origin: string;
  readonly fetch: FetchLike;
  readonly headers: () => Promise<Record<string, string>> | Record<string, string>;
  readonly store: CacheStore;
}

/** One cached type: its state and the IDs it covers. */
export interface CachedType {
  readonly state: string;
  readonly ids: ReadonlyArray<string>;
}

const parseCached = (raw: string | null): CachedType | null => {
  if (raw === null) return null;

  try {
    const o = objectOf(JSON.parse(raw) as JsonValue);

    return o && Predicate.isString(o["state"])
      ? { state: o["state"], ids: stringsOf(o["ids"]) }
      : null;
  } catch {
    return null;
  }
};

export interface SyncResult {
  readonly state: string;
  readonly created: ReadonlyArray<string>;
  readonly updated: ReadonlyArray<string>;
  readonly destroyed: ReadonlyArray<string>;
  /** True when the cache was discarded and rebuilt from a baseline. */
  readonly reset: boolean;
}

/** One method response by name and arguments. */
export type MethodResponse = readonly [name: string, args: JsonObject];

/** Restarts of an Email baseline whose query moved while it was paging. */
const BASELINE_ATTEMPTS = 3;

const BASELINE_PAGE = 500;

export class JmapClient {
  private session: JmapSessionResource | null = null;

  constructor(private readonly options: JmapClientOptions) {}

  private async send(url: string, method: "GET" | "POST", body?: string): Promise<JsonObject> {
    const base = await this.options.headers();

    const init: FetchInit =
      body === undefined
        ? { method, headers: base }
        : { method, headers: { ...base, "content-type": "application/json" }, body };

    const response = await this.options.fetch(url, init);
    const text = await response.text();
    let parsed: JsonValue = null;

    try {
      parsed = text ? (JSON.parse(text) as JsonValue) : null;
    } catch {
      parsed = null;
    }

    const o = objectOf(parsed);

    if (response.status >= 400 || o === null)
      throw new JmapRequestError(
        response.status,
        stringOf(o?.["type"]) || "http",
        stringOf(o?.["detail"]) || text.slice(0, 200),
      );

    return o;
  }

  /** The session resource (cached until `refreshSession`). */
  async sessionResource(): Promise<JmapSessionResource> {
    this.session ??= parseSession(await this.send(`${this.options.origin}${SESSION_PATH}`, "GET"));

    return this.session;
  }

  refreshSession(): void {
    this.session = null;
  }

  /** One batch; responses by call ID (an implicit second response is keyed `<id>#1`). */
  async call(
    calls: ReadonlyArray<Invocation>,
    using?: ReadonlyArray<string>,
  ): Promise<ReadonlyMap<string, MethodResponse>> {
    const session = await this.sessionResource();

    const out = await this.send(
      session.apiUrl,
      "POST",
      JSON.stringify({ using: using ?? Object.keys(session.capabilities), methodCalls: calls }),
    );

    const responses = new Map<string, MethodResponse>();

    for (const raw of listOf(out["methodResponses"])) {
      const [name, args, callId] = listOf(raw);
      let key = stringOf(callId);

      for (let i = 1; responses.has(key); i++) key = `${stringOf(callId)}#${i}`;
      responses.set(key, [stringOf(name), objectOf(args) ?? {}]);
    }

    // A changed session state means accounts or capabilities moved (e.g. a cutover): re-read it.
    if (out["sessionState"] !== session.state) this.refreshSession();

    return responses;
  }

  /**
   * Bring one type's cached ID set up to date (Mailbox, Email, …). A missing cache, a cutover, or
   * `cannotCalculateChanges` resets to a baseline; otherwise `/changes` pages until
   * `hasMoreChanges` is false, so a large commit is never truncated.
   */
  async sync(accountId: string, type: string): Promise<SyncResult> {
    const session = await this.sessionResource();
    const account = session.accounts[accountId];

    if (!account) throw new JmapRequestError(404, "accountNotFound", accountId);
    const key = cacheKey(accountId, account, type);
    const cached = parseCached(await this.options.store.get(key));

    if (cached !== null) {
      const ids = new Set(cached.ids);
      const created: Array<string> = [];
      const updated: Array<string> = [];
      const destroyed: Array<string> = [];
      let state = cached.state;

      for (;;) {
        const r = (
          await this.call([
            [`${type}/changes`, { accountId, sinceState: state, maxChanges: BASELINE_PAGE }, "c"],
          ])
        ).get("c");

        if (!r || r[0] === "error") break;
        const out = r[1];

        for (const id of stringsOf(out["created"])) {
          ids.add(id);
          created.push(id);
        }

        updated.push(...stringsOf(out["updated"]));

        for (const id of stringsOf(out["destroyed"])) {
          ids.delete(id);
          destroyed.push(id);
        }

        state = stringOf(out["newState"]);

        if (out["hasMoreChanges"] !== true) {
          await this.options.store.set(key, JSON.stringify({ state, ids: [...ids] }));

          return { state, created, updated, destroyed, reset: false };
        }
      }
    }

    return this.baseline(accountId, type, key);
  }

  /** Download a fresh baseline of IDs and its state, discarding any cached proprietary cursor. */
  private async baseline(accountId: string, type: string, key: string): Promise<SyncResult> {
    await this.options.store.delete(key);
    const ids: Array<string> = [];
    let state = "";

    if (type === "Email") {
      // The state is the first page's: anything created or destroyed while paging is replayed by
      // the next /changes. A query state that moves between pages may have shifted positions
      // (an ID skipped or repeated), so the baseline restarts, a bounded number of times.
      for (let attempt = 0; attempt < BASELINE_ATTEMPTS; attempt++) {
        ids.length = 0;
        state = "";
        let queryState = "";
        let moved = false;

        for (let position = 0; ; position += BASELINE_PAGE) {
          const r = await this.call([
            ["Email/query", { accountId, position, limit: BASELINE_PAGE }, "q"],
            ["Email/get", { accountId, ids: [], properties: ["id"] }, "s"],
          ]);

          const q = r.get("q");

          if (!q || q[0] === "error")
            throw new JmapRequestError(500, "baseline", stringOf(q?.[1]["type"]));
          const page = stringsOf(q[1]["ids"]);
          ids.push(...page);

          if (position === 0) {
            state = stringOf(r.get("s")?.[1]["state"]);
            queryState = stringOf(q[1]["queryState"]);
          } else if (stringOf(q[1]["queryState"]) !== queryState) moved = true;

          if (page.length < BASELINE_PAGE) break;
        }

        if (!moved) break;
      }

      ids.splice(0, ids.length, ...new Set(ids));
    } else {
      const r = (
        await this.call([[`${type}/get`, { accountId, ids: null, properties: ["id"] }, "g"]])
      ).get("g");

      if (!r || r[0] === "error")
        throw new JmapRequestError(500, "baseline", stringOf(r?.[1]["type"]));

      for (const item of listOf(r[1]["list"])) {
        const id = objectOf(item)?.["id"];

        if (Predicate.isString(id)) ids.push(id);
      }

      state = stringOf(r[1]["state"]);
    }

    await this.options.store.set(key, JSON.stringify({ state, ids }));

    return { state, created: ids, updated: [], destroyed: [], reset: true };
  }
}

// ------------------------------------------------------------------ offline intents (C4)

/** A native action queued while offline, bound to the exact Emails and versions it saw. */
export interface OfflineIntent {
  readonly intentId: string;
  readonly accountId: string;
  /** Email ID → placement version at selection (null when unknown). */
  readonly emails: { readonly [emailId: string]: number | null };
  readonly action: JsonObject;
}

export type RebaseOutcome =
  | { readonly kind: "replay"; readonly intent: OfflineIntent }
  | { readonly kind: "review"; readonly intent: OfflineIntent; readonly reason: string };

/**
 * Rebase queued intents against the server's current Emails: replay only when every captured
 * Email still exists (versions are rechecked by the server at execution); otherwise hand the
 * intent back for review. Nothing is re-expanded to Emails that arrived later.
 */
export const rebaseIntents = (
  intents: ReadonlyArray<OfflineIntent>,
  existing: ReadonlySet<string>,
): ReadonlyArray<RebaseOutcome> =>
  intents.map((intent) => {
    const missing = Object.keys(intent.emails).filter((id) => !existing.has(id));

    return missing.length === 0
      ? { kind: "replay", intent }
      : { kind: "review", intent, reason: `emails no longer exist: ${missing.join(", ")}` };
  });

/** The EmailAction/apply call for a replayed intent; the intent ID makes a lost response safe. */
export const intentCall = (intent: OfflineIntent, callId: string): Invocation => [
  "EmailAction/apply",
  {
    accountId: intent.accountId,
    emails: { ...intent.emails },
    action: intent.action,
    intentId: intent.intentId,
  },
  callId,
];

/** A legacy thread command queued by a pre-cutover client. */
export interface LegacyQueuedCommand {
  readonly commandId: string;
  readonly mailboxId: string;
  readonly command: JsonObject;
  /**
   * Delivery IDs per thread as the client saw them when it queued the command. Without this
   * snapshot the original Email set is unrecoverable and the command goes to review.
   */
  readonly snapshot?: { readonly [threadId: string]: ReadonlyArray<string> };
}

const LEGACY_ACTIONS = new Map<string, JsonObject>([
  ["MoveToTrash", { type: "trash" }],
  ["MarkSpam", { type: "spam" }],
  ["MarkSeen", { type: "seen", value: true }],
  ["MarkUnseen", { type: "seen", value: false }],
]);

export type LegacyTranslation = { readonly intent: OfflineIntent } | { readonly review: string };

/**
 * Translate a queued legacy command into an offline intent when its original Email set is
 * recoverable (legacy delivery IDs are the migrated Email IDs, C3); otherwise reject it for
 * review. A thread command is never re-expanded against the thread's current membership.
 */
export const translateLegacyCommand = (queued: LegacyQueuedCommand): LegacyTranslation => {
  const tag = stringOf(queued.command["_tag"]);
  const action = LEGACY_ACTIONS.get(tag);

  if (!action) return { review: `no JMAP equivalent for ${tag || "this command"}` };
  const single = queued.command["threadId"];
  const threads = Predicate.isString(single) ? [single] : stringsOf(queued.command["threadIds"]);
  const snapshot = queued.snapshot;

  if (!snapshot || threads.some((t) => !snapshot[t]))
    return { review: "the original Email set was not recorded; review before applying" };
  const emails: { [emailId: string]: null } = {};

  for (const t of threads) for (const id of snapshot[t] ?? []) emails[id] = null;

  return {
    intent: { intentId: queued.commandId, accountId: queued.mailboxId, emails, action },
  };
};

/**
 * A JMAP transport over an authenticated ByeClient: the native apps reuse their device session
 * (token refresh on 401) for the session resource and the API, which live on the same origin.
 */
export const fetchOverByeClient =
  (client: ByeClient): FetchLike =>
  async (url, init) => {
    const path = new URL(url).pathname;

    try {
      const body =
        init.method === "POST" && Predicate.isString(init.body)
          ? (JSON.parse(init.body) as JsonValue)
          : undefined;

      const out = await client.request<JsonValue>(
        init.method === "POST" ? "POST" : "GET",
        path,
        body,
      );

      return { status: 200, text: async () => JSON.stringify(out) };
    } catch (error) {
      if (!(error instanceof ByeApiError)) throw error;

      return {
        status: error.status,
        text: async () => JSON.stringify({ type: error.code, detail: error.message }),
      };
    }
  };
