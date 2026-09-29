import type {
  CalendarCommand,
  MailboxCommand,
  MailCancelResponse,
  MailDraftContent,
  MailSearchResponse,
  MailSendResponse,
  MailViewName,
  MailViewPage,
  MessageInvitationsResponse,
  OccurrenceWire,
} from "@bye/contracts";
import type {
  DeviceSessionWire,
  HabitWire,
  MeWire,
  ThreadDetailWire,
  TimerWire,
  WeekTaskWire,
  WidgetWire,
} from "./wire.ts";
import { Predicate } from "effect";
import type { JsonInput, JsonObject, JsonValue } from "./json.ts";
import type { AfterSend } from "./after-send.ts";
import type { CalendarSearchHitWire, FromMessageBody } from "./mail-calendar.ts";

// The one HTTP client for every first-party client (web, desktop, mobile, CLI/TUI) (X01, X02).
// Same /v1 contracts as agents (§8). What differs per host is only how a request is credentialed:
//
// - `cookie`: the web app's HTTP-only session cookie (same-origin; CSRF is Origin-based server-side).
// - `auth` (bearer): a native device session — short-lived access token, one transparent refresh on
//   401. Native hosts never send or store platform cookies (`credentials: "omit"`).
// - `token` (static bearer): CLI, agents, tests.
//
// Commands are typed against @bye/contracts; the client adds the command ID. Types only: nothing
// from contracts (or Effect) reaches the React Native bundle.

export interface FetchInit {
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body?: string | Uint8Array | Blob | ArrayBuffer;
  readonly credentials?: "omit" | "same-origin";
  /** Bearer requests never follow redirects, so a token is never forwarded to another host. */
  readonly redirect?: "error";
  readonly signal?: AbortSignal;
}

export type FetchLike = (
  url: string,
  init: FetchInit,
) => Promise<{
  readonly status: number;
  readonly statusText?: string;
  readonly headers?: { get(name: string): string | null };
  text(): Promise<string>;
}>;

/** A JSON request body as a caller states it (serialized with `JSON.stringify`). */
export type RequestBody = JsonInput;

type CreateDraftBody = {
  commandId: string;
  mailboxId: string;
  content: MailDraftContent;
  threadId?: string;
};

type SendDraftBody = {
  commandId: string;
  mailboxId: string;
  revision: number;
  afterSend?: AfterSend;
};

type RespondInvitationCommand = Extract<CalendarCommandInput, { type: "RespondInvitation" }>;

type MutableRespondInvitation = {
  -readonly [K in keyof RespondInvitationCommand]: RespondInvitationCommand[K];
};

type MutableFetchInit = { -readonly [K in keyof FetchInit]: FetchInit[K] };

/** Machine-readable details from an error envelope. */
export type ErrorDetails = Readonly<JsonObject>;

export class ByeApiError extends Error {
  readonly status: number;
  readonly code: string;
  /** Machine-readable details from the error envelope (e.g. `stepUp`, `currentRevision`). */
  readonly details?: ErrorDetails;

  constructor(status: number, code: string, message: string, details?: ErrorDetails) {
    super(message);
    this.name = "ByeApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export interface BearerAuth {
  token(): Promise<string | null>;
  /** The server rejected the current access token; refresh once and return a new one (or null). */
  onUnauthorized(): Promise<string | null>;
}

export interface ByeClientOptions {
  /** API base: an https origin, optionally with a path prefix (loopback may use http). */
  readonly origin: string;
  readonly fetch: FetchLike;
  /** Static bearer token (CLI/agents, tests). */
  readonly token?: string | undefined;
  /** Device session (desktop and mobile): supplies/refreshes short-lived access tokens. */
  readonly auth?: BearerAuth | undefined;
  /** Web: credential with the same-origin session cookie instead of a bearer token. */
  readonly cookie?: boolean;
  /** Extra headers on every request (e.g. the CLI's user agent). */
  readonly headers?: Readonly<Record<string, string>>;
  readonly newId?: () => string;
}

export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type QueryParams = Readonly<Record<string, string | number | boolean | null | undefined>>;

export interface RequestOptions {
  readonly query?: QueryParams;
  readonly signal?: AbortSignal;
  /** Extra headers for this request only. */
  readonly headers?: Readonly<Record<string, string>>;
}

/** A command as a client writes it: the client supplies `commandId`. */
type WithoutCommandId<T> = T extends unknown ? Omit<T, "commandId"> : never;

export type MailboxCommandInput = WithoutCommandId<MailboxCommand>;

export type CalendarCommandInput = WithoutCommandId<CalendarCommand>;

export const newCommandId = (): string => {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);

  return `cmd_${Array.from(bytes, (b) => b.toString(36).padStart(2, "0"))
    .join("")
    .slice(0, 26)}`;
};

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** `?a=1&b=2` from defined, non-empty values (empty string when none). */
export const queryString = (params: QueryParams | undefined): string => {
  const q = new URLSearchParams();

  for (const [k, v] of Object.entries(params ?? {}))
    if (v !== undefined && v !== null && v !== "") q.set(k, String(v));
  const s = q.toString();

  return s ? `?${s}` : "";
};

/** JSON when the body is JSON; otherwise the text itself (vCard, ICS and CSV exports). */
const parseBody = (text: string, contentType: string | null): JsonValue => {
  if (!text) return null;

  if ((contentType ?? "").includes("json") || /^[[{]/.test(text.trimStart())) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  return text;
};

const errorFrom = (
  status: number,
  statusText: string | undefined,
  data: JsonValue,
): ByeApiError => {
  const error = Predicate.isObject(data) ? data.error : undefined;
  const envelope = Predicate.isObject(error) ? error : undefined;
  const code = envelope?.code;
  const message = envelope?.message;
  const details = envelope?.details;

  return new ByeApiError(
    status,
    Predicate.isString(code) ? code : "internal",
    Predicate.isString(message) ? message : statusText || `HTTP ${status}`,
    Predicate.isObject(details) ? details : undefined,
  );
};

export class ByeClient {
  /** The API origin (scheme://host[:port]). */
  readonly origin: string;
  /** Origin plus any base path: the instance this client is bound to for its lifetime. */
  readonly base: string;
  private readonly fetchImpl: FetchLike;
  private readonly token: string | undefined;
  private readonly auth: BearerAuth | undefined;
  private readonly cookie: boolean;
  private readonly extraHeaders: Readonly<Record<string, string>>;
  readonly newId: () => string;

  constructor(options: ByeClientOptions) {
    const url = new URL(options.origin);

    if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.has(url.hostname)))
      throw new Error("API origin must be https");
    this.origin = url.origin;
    this.base = `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
    this.fetchImpl = options.fetch;
    this.token = options.token;
    this.auth = options.auth;
    this.cookie = options.cookie === true;
    this.extraHeaders = options.headers ?? {};
    this.newId = options.newId ?? newCommandId;
  }

  /** JSON request; the body (if any) is sent as JSON. */
  request<T>(
    method: Method,
    path: string,
    body?: RequestBody,
    options: RequestOptions = {},
  ): Promise<T> {
    return this.dispatch<T>(
      method,
      path,
      body === undefined
        ? undefined
        : { body: JSON.stringify(body), contentType: "application/json" },
      options,
      false,
    );
  }

  /** Raw body (upload parts, photos, vCard/CSV/ICS imports); the response is parsed like `request`. */
  raw<T>(
    method: Method,
    path: string,
    body: string | Uint8Array | Blob | ArrayBuffer,
    contentType: string,
    options: RequestOptions = {},
  ): Promise<T> {
    return this.dispatch<T>(method, path, { body, contentType }, options, false);
  }

  private async dispatch<T>(
    method: Method,
    path: string,
    payload:
      | { readonly body: string | Uint8Array | Blob | ArrayBuffer; readonly contentType: string }
      | undefined,
    options: RequestOptions,
    retried: boolean,
  ): Promise<T> {
    const headers = new Map<string, string>(
      Object.entries({
        accept: "application/json",
        ...this.extraHeaders,
        ...options.headers,
      }),
    );

    if (!this.cookie) {
      const bearer = this.auth ? await this.auth.token() : this.token;

      if (this.auth && !bearer) throw new ByeApiError(401, "unauthenticated", "signed out");

      if (bearer) headers.set("authorization", `Bearer ${bearer}`);

      // Browsers set Origin themselves; bearer clients state it for the server's Origin checks.
      if (method !== "GET") headers.set("origin", this.origin);
    }

    if (payload) {
      headers.set("content-type", payload.contentType);

      if (payload.body instanceof Uint8Array)
        headers.set("content-length", String(payload.body.byteLength));
    }

    const init: MutableFetchInit = {
      method,
      headers: Object.fromEntries(headers),
      // Cookie sessions are same-origin only; bearer clients never send or store platform cookies.
      credentials: this.cookie ? "same-origin" : "omit",
    };

    if (payload) init.body = payload.body;

    if (!this.cookie) init.redirect = "error";

    if (options.signal) init.signal = options.signal;

    const response = await this.fetchImpl(`${this.base}${path}${queryString(options.query)}`, init);

    // An expired/rotated access token gets exactly one transparent refresh and retry.
    if (response.status === 401 && this.auth && !retried && (await this.auth.onUnauthorized())) {
      return this.dispatch<T>(method, path, payload, options, true);
    }

    const data = parseBody(await response.text(), response.headers?.get("content-type") ?? null);

    if (response.status >= 400) throw errorFrom(response.status, response.statusText, data);

    return data as T;
  }

  // ---- typed commands (contracts) ----

  command = <T = unknown>(mailboxId: string, command: MailboxCommandInput) =>
    this.request<T>("POST", `/v1/mailboxes/${encodeURIComponent(mailboxId)}/commands`, {
      commandId: this.newId(),
      // The preference command's `value` is schema-`unknown` but is JSON on the wire.
      ...(command as JsonObject),
    });

  calendarCommand = <T = unknown>(calendarId: string, command: CalendarCommandInput) =>
    this.request<T>("POST", `/v1/calendars/${encodeURIComponent(calendarId)}/commands`, {
      schemaVersion: 1,
      command: { commandId: this.newId(), ...command },
    });

  me = () => this.request<MeWire>("GET", "/v1/me");

  /** Short-lived signed download URL (render origin) for handing an attachment to the OS. */
  attachmentLink = (mailboxId: string, deliveryId: string, partId: string) =>
    this.request<{ downloadUrl: string; expiresInSeconds: number }>(
      "POST",
      `/v1/mailboxes/${encodeURIComponent(mailboxId)}/deliveries/${encodeURIComponent(deliveryId)}/attachments/${encodeURIComponent(partId)}/link`,
    );

  view = (mailboxId: string, view: MailViewName, cursor?: string) =>
    this.request<MailViewPage>(
      "GET",
      `/v1/mailboxes/${encodeURIComponent(mailboxId)}/views/${view}`,
      undefined,
      { query: { cursor } },
    );

  thread = (mailboxId: string, threadId: string) =>
    this.request<ThreadDetailWire>(
      "GET",
      `/v1/mailboxes/${encodeURIComponent(mailboxId)}/threads/${encodeURIComponent(threadId)}`,
    );

  markSeen = (mailboxId: string, threadId: string, observedRevision: number) =>
    this.command(mailboxId, { _tag: "MarkSeen", threadId, observedRevision });

  screen = (mailboxId: string, sender: string, allow: boolean) =>
    this.screenMany(mailboxId, [sender], allow);

  // ---- drafts (§8; the offline sync in ./drafts.ts drives these) ----

  createDraft = (mailboxId: string, content: MailDraftContent, threadId?: string) => {
    const body: CreateDraftBody = { commandId: this.newId(), mailboxId, content };

    if (threadId) body.threadId = threadId;

    return this.request<{ draftId: string; revision: number }>("POST", "/v1/drafts", body);
  };

  saveDraft = (
    mailboxId: string,
    draftId: string,
    expectedRevision: number,
    content: MailDraftContent,
  ) =>
    this.request<
      { _tag: "Saved"; revision: number } | { _tag: "Conflict"; currentRevision: number }
    >("PATCH", `/v1/drafts/${encodeURIComponent(draftId)}`, {
      commandId: this.newId(),
      mailboxId,
      expectedRevision,
      content,
    });

  getDraft = (mailboxId: string, draftId: string) =>
    this.request<{ revision: number; content: MailDraftContent }>(
      "GET",
      `/v1/mailboxes/${encodeURIComponent(mailboxId)}/drafts/${encodeURIComponent(draftId)}`,
    );

  send = (
    mailboxId: string,
    draftId: string,
    revision: number,
    commandId = this.newId(),
    afterSend?: AfterSend,
  ) => {
    const body: SendDraftBody = { commandId, mailboxId, revision };

    if (afterSend) body.afterSend = afterSend;

    return this.request<typeof MailSendResponse.Type>(
      "POST",
      `/v1/drafts/${encodeURIComponent(draftId)}/send`,
      body,
    );
  };

  cancelSend = (mailboxId: string, sendJobId: string) =>
    this.request<typeof MailCancelResponse.Type>(
      "POST",
      `/v1/send-jobs/${encodeURIComponent(sendJobId)}/cancel`,
      { commandId: this.newId(), mailboxId },
    );

  search = (mailboxId: string, q: string) =>
    this.request<typeof MailSearchResponse.Type>(
      "GET",
      `/v1/mailboxes/${encodeURIComponent(mailboxId)}/search`,
      undefined,
      { query: { q } },
    );

  occurrences = (calendarId: string, from: number, to: number, tz: string) =>
    this.request<{ schemaVersion: 1; occurrences: ReadonlyArray<OccurrenceWire> }>(
      "GET",
      `/v1/calendars/${encodeURIComponent(calendarId)}/events`,
      undefined,
      {
        query: { from: new Date(from).toISOString(), to: new Date(to).toISOString(), tz },
      },
    );

  signOut = () => this.request<{ ok: true }>("POST", "/auth/logout", {});

  // ---- triage (E01, E04, E08, E09, E24) ----

  /** Screener bulk decision for every listed sender in one command (E01). */
  screenMany = (
    mailboxId: string,
    senders: ReadonlyArray<string>,
    allow: boolean,
    options: { destination?: "imbox" | "feed" | "paper-trail" } = {},
  ) =>
    this.command(mailboxId, {
      _tag: "Screen",
      decisions: [...new Set(senders)].map((sender) =>
        allow
          ? { sender, decision: "allow" as const, destination: options.destination ?? "imbox" }
          : { sender, decision: "block" as const },
      ),
    });

  clearScreener = (mailboxId: string, boundary: number) =>
    this.command(mailboxId, { _tag: "ClearScreener", boundary });

  attention = (
    mailboxId: string,
    threadId: string,
    flag: "replyLater" | "setAside" | "unfollowed",
    on: boolean,
  ) => this.command(mailboxId, { _tag: "SetAttention", threadId, flag, on });

  bubbleUp = (
    mailboxId: string,
    threadId: string,
    at: number,
    condition: "always" | "if-no-reply" = "always",
  ) => this.command(mailboxId, { _tag: "BubbleUp", threadId, at, condition });

  trash = (mailboxId: string, threadIds: ReadonlyArray<string>) =>
    this.command(mailboxId, { _tag: "MoveToTrash", threadIds });

  spam = (mailboxId: string, threadIds: ReadonlyArray<string>) =>
    this.command(mailboxId, { _tag: "MarkSpam", threadIds });

  restore = (mailboxId: string, threadIds: ReadonlyArray<string>) =>
    this.command(mailboxId, { _tag: "Restore", threadIds });

  setPreference = (
    mailboxId: string,
    key: Extract<MailboxCommandInput, { _tag: "SetPreference" }>["key"],
    value: JsonValue,
  ) => this.command(mailboxId, { _tag: "SetPreference", key, value });

  preferences = (mailboxId: string) =>
    this.request<JsonObject>("GET", `/v1/mailboxes/${encodeURIComponent(mailboxId)}/preferences`);

  sendJob = (mailboxId: string, sendJobId: string) =>
    this.request<{
      state: string;
      outcomes?: ReadonlyArray<{ address: string; outcome: string; detail: string | null }>;
    }>(
      "GET",
      `/v1/mailboxes/${encodeURIComponent(mailboxId)}/send-jobs/${encodeURIComponent(sendJobId)}`,
    );

  // ---- calendar (C02, C06, C07, C10) ----

  weekTasks = (calendarId: string, date: string, firstWeekday = 1) =>
    this.request<{ items: ReadonlyArray<WeekTaskWire> }>(
      "GET",
      `/v1/calendars/${encodeURIComponent(calendarId)}/week-tasks`,
      undefined,
      { query: { date, firstWeekday } },
    );

  habits = (calendarId: string, from: string, to: string) =>
    this.request<{ items: ReadonlyArray<HabitWire> }>(
      "GET",
      `/v1/calendars/${encodeURIComponent(calendarId)}/habits`,
      undefined,
      { query: { from, to } },
    );

  timer = (calendarId: string) =>
    this.request<TimerWire | null>("GET", `/v1/calendars/${encodeURIComponent(calendarId)}/timer`);

  // ---- email integration (C09) ----

  calendars = (calendarId: string) =>
    this.request<{ items: ReadonlyArray<{ id?: string; calendarId?: string; name: string }> }>(
      "GET",
      `/v1/calendars/${encodeURIComponent(calendarId)}/calendars`,
    );

  calendarSearch = (calendarId: string, q: string, limit = 25) =>
    this.request<{ items: ReadonlyArray<CalendarSearchHitWire> }>(
      "GET",
      `/v1/calendars/${encodeURIComponent(calendarId)}/search`,
      undefined,
      { query: { q, limit } },
    );

  /** Invitations a delivered message carried, with the owner's current answer (C09). */
  messageInvitations = (calendarId: string, mailboxId: string, deliveryId: string) =>
    this.request<typeof MessageInvitationsResponse.Type>(
      "GET",
      `/v1/calendars/${encodeURIComponent(calendarId)}/invitations`,
      undefined,
      { query: { mailboxId, deliveryId } },
    );

  /** Accept, tentatively accept or decline an invitation; the server replies to the organizer (iTIP). */
  respondInvitation = (
    calendarId: string,
    eventId: string,
    partstat: "ACCEPTED" | "TENTATIVE" | "DECLINED",
    occurrenceKey?: string,
  ) => {
    const command: MutableRespondInvitation = {
      type: "RespondInvitation",
      eventId,
      partstat,
    };

    if (occurrenceKey) command.occurrenceKey = occurrenceKey;

    return this.calendarCommand(calendarId, command);
  };

  /** Create an event with a backlink to a message; the server checks read access to its mailbox. */
  createEventFromMessage = (calendarId: string, body: FromMessageBody) =>
    this.request<{ eventId: string; uid: string }>(
      "POST",
      `/v1/calendars/${encodeURIComponent(calendarId)}/from-message`,
      { schemaVersion: 1, commandId: this.newId(), ...body },
    );

  widget = (calendarId: string, tz: string) =>
    this.request<WidgetWire>(
      "GET",
      `/v1/calendars/${encodeURIComponent(calendarId)}/widget`,
      undefined,
      { query: { tz } },
    );

  // ---- push (E23, P1.7) ----

  /** The instance's Web Push application-server key; 404 when push isn't configured there. */
  pushVapidKey = () => this.request<{ publicKey: string }>("GET", "/v1/push/vapid-key");

  registerPush = (registration: {
    readonly kind: "webpush";
    readonly endpoint: string;
    readonly keys: { readonly p256dh: string; readonly auth: string };
    readonly label: string;
  }) => this.request<{ id: string }>("POST", "/v1/push/subscriptions", registration);

  /** This account's push registrations (endpoints are never returned). */
  pushDevices = () =>
    this.request<{ items: ReadonlyArray<{ readonly id: string; readonly enabled: boolean }> }>(
      "GET",
      "/v1/push/subscriptions",
    );

  removePush = (id: string) =>
    this.request<{ ok: true }>("DELETE", `/v1/push/subscriptions/${encodeURIComponent(id)}`);

  // ---- devices (A03, DS) ----

  devices = () => this.request<{ items: ReadonlyArray<DeviceSessionWire> }>("GET", "/v1/devices");

  revokeDevice = (id: string) =>
    this.request<{ revoked: boolean }>("DELETE", `/v1/devices/${encodeURIComponent(id)}`);
}

/** "New for you" count for the widget: threads in the Imbox's first page still marked new (E04). */
export const countNewForYou = (page: Pick<MailViewPage, "items"> | null): number =>
  (page?.items ?? []).filter((t) => t.newForYou).length;

/** Normalize the widget route into the snapshot the iOS and Android widgets render (timer included). */
export const widgetSnapshot = (w: WidgetWire | null, unseen: number, now = Date.now()) => {
  const next = (w?.upcoming ?? [])
    .filter((o) => o.startMs >= now)
    .sort((a, b) => a.startMs - b.startMs)[0];

  return {
    nextEvent: next ? { title: next.data.summary, startMs: next.startMs } : null,
    timer: w?.activeTimer
      ? { label: w.activeTimer.label, startedAtMs: w.activeTimer.startedAt }
      : null,
    unseen,
  };
};

/** Start of the week containing `now` (Monday), in local time. */
export const weekStart = (now: Date): Date => {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));

  return d;
};
