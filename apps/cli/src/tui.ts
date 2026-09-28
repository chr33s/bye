import type { Layer } from "effect";
import type { MailDraftContent, OccurrenceWire } from "@bye/contracts";
import { addDays, parseLocalDate, ymd } from "@bye/native-shared/calendar-form";
import type { AfterSendChoice } from "@bye/native-shared/after-send";
import { htmlToReadableText } from "@bye/mail-codec";
import { firstCalendarId } from "@bye/native-shared/mail-calendar";
import { MAIL_VIEW_NAV } from "@bye/native-shared/views";
import type { DeliveryWire } from "@bye/native-shared/wire";
import { UsageError } from "./args.ts";
import { type CliApi, CliApiError } from "./client.ts";
import { invoke } from "./commands.ts";
import { sanitize } from "./format.ts";
import {
  type AgendaDay,
  COMPOSE_FIELDS,
  type ComposeMode,
  type ComposeState,
  decodeKeys,
  editText,
  EVENT_FIELDS,
  type EventField,
  type FrameOptions,
  formatTime,
  type PromptState,
  renderFrame,
  type Screen,
  type SearchHit,
  threadLines,
  type ThreadRow,
  type TuiState,
  visibleOccurrences,
  wallClock,
} from "./tui-view.ts";

// Keyboard-only TUI over the same API contracts as the CLI (X02, P1.3): mail views, complete
// threads, compose/reply/forward with undo and Send Later, screening and attention triage, search,
// and an agenda/day calendar with event editing and invitation replies. Every request goes through
// the CLI command table, so `bye tui` and `bye <command>` cannot drift apart. `createTui` is the
// testable core (keys in, frames out); `runTui` wires it to the terminal.

/** Ctrl-S answers: send, optionally with an after-send action (E08/E09). */
const SEND_KEYS: Readonly<Record<string, AfterSendChoice>> = {
  y: "none",
  d: "done",
  b: "follow-up",
  r: "follow-up-if-no-reply",
  c: "clear",
};
export { decodeKeys, sanitize };

export interface TuiOptions {
  readonly api: Layer.Layer<CliApi>;
  readonly newCommandId: () => string;
  /** Fetch a message document by its render-origin capability URL (never with credentials). */
  readonly fetchText?: (url: string) => Promise<string>;
  readonly now?: () => number;
  readonly timeZone?: string;
  readonly size?: () => { readonly columns: number; readonly rows: number };
  /** Called when background work (message bodies) changes the state, so the frame is redrawn. */
  readonly onUpdate?: () => void;
}

export interface TuiSession {
  readonly state: () => TuiState;
  /** True once the user quit. */
  readonly done: () => boolean;
  readonly start: () => Promise<void>;
  /** Handle one decoded key (see `decodeKeys`); resolves when its requests have settled. */
  readonly press: (key: string) => Promise<void>;
  /** Raw terminal input: decoded and pressed key by key. */
  readonly type: (input: string) => Promise<void>;
  readonly frame: (options?: Partial<FrameOptions>) => ReadonlyArray<string>;
  /** Resolves once background work (message bodies) has landed. */
  readonly settled: () => Promise<void>;
}

/** A structured, terminal-safe error line: what failed, the API error code and status, and why. */
export const describeError = (label: string, error: unknown): string =>
  error instanceof CliApiError
    ? `${label} failed — ${sanitize(error.code)} (${error.status === 0 ? "network" : `HTTP ${error.status}`}): ${sanitize(error.message)}`
    : error instanceof UsageError
      ? `${label}: ${sanitize(error.message)}`
      : `${label} failed: ${sanitize(error instanceof Error ? error.message : String(error))}`;

const UNITS: Readonly<Record<string, number>> = {
  m: 60_000,
  min: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

/**
 * When to bubble up or send: "now", a relative "2h" / "in 3d" / "+30m", "tomorrow" (08:00), or an
 * ISO-8601 time (`2026-10-01T09:00` is local time; a bare `2026-10-01` is 08:00 local). Null when unparseable.
 */
export const parseWhen = (input: string, now: number): number | "now" | null => {
  const value = input.trim().toLowerCase();
  if (value === "now") return "now";
  const relative = /^(?:in\s+|\+)?(\d+)\s*(min|m|h|d|w)$/.exec(value);
  if (relative) return now + Number(relative[1]) * UNITS[relative[2]!]!;
  if (value === "tomorrow") {
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    d.setHours(8, 0, 0, 0);
    return d.getTime();
  }
  // A bare date is that local day at 08:00 (like "tomorrow"); Date.parse would read it as UTC.
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (day) return new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3]), 8).getTime();
  const at = Date.parse(input.trim());
  return Number.isNaN(at) ? null : at;
};

/** The bare address from "Name <a@b>" (or the value itself). */
const senderAddress = (sender: string | undefined): string | undefined => {
  const match = /<([^<>\s]+@[^<>\s]+)>/.exec(sender ?? "");
  const address = match?.[1] ?? sender?.trim();
  return address && address.includes("@") ? address : undefined;
};

const BLANK: Readonly<Record<(typeof COMPOSE_FIELDS)[number], string>> = {
  to: "",
  cc: "",
  bcc: "",
  subject: "",
  body: "",
};

const addressList = (list: ReadonlyArray<{ readonly address: string }> | undefined) =>
  (list ?? []).map((a) => a.address).join(", ");

const draftFields = (c: MailDraftContent) => ({
  to: addressList(c.to),
  cc: addressList(c.cc),
  bcc: addressList(c.bcc),
  subject: c.subject ?? "",
  body: c.text ?? "",
});

const REPLY_LABEL: Readonly<Record<ComposeMode, string>> = {
  new: "New message",
  reply: "Reply",
  "reply-all": "Reply all",
  forward: "Forward",
};

const PARTSTAT_KEYS: Readonly<Record<string, "accept" | "tentative" | "decline">> = {
  Y: "accept",
  T: "tentative",
  D: "decline",
};

export const createTui = (options: TuiOptions): TuiSession => {
  const now = options.now ?? Date.now;
  const timeZone = options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const size = options.size ?? (() => ({ columns: 80, rows: 24 }));
  const today = () => formatTime(now(), timeZone).slice(0, 10);
  let s: TuiState = {
    screen: "mail",
    view: "imbox",
    rows: [],
    search: null,
    index: 0,
    thread: null,
    compose: null,
    calendar: "agenda",
    date: today(),
    days: [],
    occurrence: 0,
    form: null,
    prompt: null,
    status: { level: "info", text: "Press ? for keys." },
    undo: null,
    help: { scroll: 0, back: "mail" },
    timeZone,
  };
  let finished = false;
  let calendarId: string | undefined;
  const set = (patch: Partial<TuiState>) => {
    s = { ...s, ...patch };
  };
  const bodyHeight = () => Math.max(4, size().rows - 4);

  /**
   * Run a CLI command, so the TUI sends exactly the requests `bye <path>` would.
   * Consequential commands (send, screening) are only reached through a confirmation prompt.
   */
  const exec = <A = unknown>(
    path: string,
    positionals: ReadonlyArray<string> = [],
    flags: Readonly<Record<string, string | true>> = {},
  ): Promise<A> => invoke<A>(path, positionals, flags, options);

  /** Run an action; its result (or structured error) becomes the status line. */
  const attempt = async (label: string, run: () => Promise<string | void>) => {
    try {
      const text = await run();
      if (text !== undefined) set({ status: { level: "info", text } });
    } catch (error) {
      set({ status: { level: "error", text: describeError(label, error) } });
    }
  };

  const ask = (prompt: Omit<PromptState, "value">) => set({ prompt: { value: "", ...prompt } });

  // ---- mail ----

  const loadView = () =>
    attempt("Loading", async () => {
      const page = await exec<{ items?: ReadonlyArray<ThreadRow> }>("mail view", [s.view], {
        limit: "100",
      });
      const rows = page.items ?? [];
      set({ rows, index: Math.min(s.index, Math.max(0, rows.length - 1)) });
    });

  /** Run a search (a refresh keeps the selection; a new query starts at the top). */
  const runSearch = (query: string, fresh = true) =>
    attempt("Search", async () => {
      if (!query.trim()) return "Search cancelled";
      const result = await exec<{ results?: ReadonlyArray<SearchHit>; lagging?: boolean }>(
        "search",
        [query],
        { limit: "50" },
      );
      const hits = result.results ?? [];
      set({
        search: { query, hits, lagging: result.lagging === true },
        index: fresh ? 0 : Math.min(s.index, Math.max(0, hits.length - 1)),
      });
    });

  const loadBodies = async () => {
    const t = s.thread;
    if (!t) return;
    const fetchText = options.fetchText;
    // Bounded fan-out: a long thread fetches four bodies at a time, each batch shown as it lands.
    for (let i = 0; i < t.deliveries.length; i += 4) {
      const bodies: Record<string, string | Error> = {};
      await Promise.all(
        t.deliveries.slice(i, i + 4).map(async (d: DeliveryWire) => {
          try {
            bodies[d.deliveryId] = await exec<{ text: string }>("mail text", [d.deliveryId]).then(
              (r) => r.text,
            );
          } catch (textError) {
            // Instances older than the text route only offer the rendered document.
            try {
              if (!fetchText) throw textError;
              bodies[d.deliveryId] = htmlToReadableText(await fetchText(d.renderUrl));
            } catch (error) {
              bodies[d.deliveryId] = error instanceof Error ? error : new Error(String(error));
            }
          }
        }),
      );
      // The user may have left or switched threads meanwhile.
      if (s.thread?.thread.threadId !== t.thread.threadId) return;
      set({ thread: { ...s.thread, bodies: { ...s.thread.bodies, ...bodies } } });
      options.onUpdate?.();
    }
  };
  /** Bodies load in the background so the thread (with snippets) shows at once. */
  let background: Promise<void> = Promise.resolve();

  const fetchThread = (threadId: string) =>
    exec<{ thread: ThreadRow; deliveries?: ReadonlyArray<DeliveryWire> }>("mail show", [threadId]);

  const openThread = (threadId: string) =>
    attempt("Opening thread", async () => {
      const detail = await fetchThread(threadId);
      set({
        screen: "thread",
        thread: {
          thread: detail.thread,
          deliveries: detail.deliveries ?? [],
          bodies: {},
          message: 0,
          attachment: 0,
          scroll: 0,
        },
      });
      background = Promise.all([background, loadBodies()]).then(() => undefined);
    });

  /** Reload the list, and the open thread's summary (bodies are kept). */
  const refresh = async () => {
    if (s.search) await runSearch(s.search.query, false);
    else await loadView();
    const open = s.thread;
    if (s.screen === "thread" && open) {
      try {
        const detail = await fetchThread(open.thread.threadId);
        if (s.thread === open) set({ thread: { ...open, thread: detail.thread } });
      } catch {
        // The list reload already reported any API failure.
      }
    }
  };

  /** The thread an action applies to: the open one, else the selected row or search hit. */
  const target = (): { threadId: string; row: ThreadRow | undefined; sender?: string } | null => {
    if (s.screen === "thread" && s.thread)
      return {
        threadId: s.thread.thread.threadId,
        row: s.thread.thread,
        sender: s.thread.deliveries[0]?.from.address ?? s.thread.thread.sender,
      };
    if (s.search) {
      const hit = s.search.hits[s.index];
      return hit?.threadId ? { threadId: hit.threadId, row: undefined } : null;
    }
    const row = s.rows[s.index];
    return row ? { threadId: row.threadId, row, sender: row.sender } : null;
  };

  /** A thread mutation, then a refresh; trash/spam from a thread returns to the list. */
  const mutate = (label: string, done: string, run: () => Promise<unknown>, leave = false) =>
    attempt(label, async () => {
      await run();
      if (leave && s.screen === "thread") set({ screen: "mail", thread: null });
      await refresh();
      return done;
    });

  const openCompose = (
    mode: ComposeMode,
    draft: { draftId: string; revision: number; content: MailDraftContent } | null,
    threadId: string | null,
  ) => {
    const fields = draft ? draftFields(draft.content) : BLANK;
    // Replies start in the body; new messages and forwards start with the recipients.
    const focus = mode === "reply" || mode === "reply-all" ? 4 : 0;
    set({
      screen: "compose",
      compose: {
        mode,
        draftId: draft?.draftId ?? null,
        revision: draft?.revision ?? 0,
        threadId,
        fields,
        saved: fields,
        focus,
        cursor: 0,
        back: s.screen === "compose" || s.screen === "help" ? "mail" : s.screen,
      },
    });
  };

  const showDraft = (draftId: string) =>
    exec<{ revision: number; content: MailDraftContent }>("draft show", [draftId]);

  const reply = (threadId: string, mode: "reply" | "reply-all" | "forward") =>
    attempt(REPLY_LABEL[mode], async () => {
      const created = await exec<{ draftId: string } | string>("draft reply", [threadId], {
        mode,
      });
      const draftId = typeof created === "string" ? created : created.draftId;
      const draft = await showDraft(draftId);
      openCompose(mode, { draftId, ...draft }, threadId);
      return `${REPLY_LABEL[mode]}: draft ready`;
    });

  /** Save the compose form: create the draft on first save, then send only the changed fields. */
  const saveCompose = async (): Promise<ComposeState> => {
    const c = s.compose!;
    let { draftId, revision } = c;
    if (draftId === null) {
      const created = await exec<{ draftId: string; revision?: number } | string>(
        "draft create",
        [],
        {
          ...c.fields,
          ...(c.threadId ? { "reply-to-thread": c.threadId } : {}),
        },
      );
      draftId = typeof created === "string" ? created : created.draftId;
      revision =
        typeof created !== "string" && created.revision !== undefined
          ? created.revision
          : (await showDraft(draftId)).revision;
    } else {
      const changed = COMPOSE_FIELDS.filter((f) => c.fields[f] !== c.saved[f]);
      if (changed.length > 0) {
        const saved = await exec<{
          _tag?: string;
          revision?: number;
          currentRevision?: number;
          current?: { revision: number };
        }>("draft save", [draftId], {
          revision: String(revision),
          ...Object.fromEntries(changed.map((f) => [f, c.fields[f]])),
        });
        if (saved._tag === "Conflict")
          throw new Error(
            `the draft changed elsewhere (now revision ${saved.current?.revision ?? saved.currentRevision}); close it and reopen to see that version`,
          );
        revision = saved.revision ?? revision + 1;
      }
    }
    const next = { ...c, draftId, revision, saved: c.fields };
    set({ compose: next });
    return next;
  };

  const closeCompose = () =>
    attempt("Saving draft", async () => {
      const c = s.compose!;
      const dirty = COMPOSE_FIELDS.some((f) => c.fields[f] !== c.saved[f]);
      if (dirty) await saveCompose();
      set({ screen: c.back, compose: null });
      return dirty ? "Draft saved" : "Closed";
    });

  const send = (at?: number, after: AfterSendChoice = "none") =>
    attempt(at === undefined ? "Send" : "Send later", async () => {
      const c = await saveCompose();
      const result = await exec<{
        _tag?: string;
        sendJobIds?: ReadonlyArray<string>;
        sendJobId?: string;
        dueAt?: number;
        currentRevision?: number;
      }>("draft send", [c.draftId!], {
        revision: String(c.revision),
        ...(at === undefined ? {} : { at: new Date(at).toISOString() }),
        ...(after === "none" ? {} : { after }),
      });
      if (result._tag === "Conflict")
        throw new Error(
          `the draft changed elsewhere (now revision ${result.currentRevision}); reopen it before sending`,
        );
      const jobIds = result.sendJobIds ?? (result.sendJobId ? [result.sendJobId] : []);
      const dueAt = result.dueAt ?? at ?? now();
      set({
        screen: c.back,
        compose: null,
        undo: { draftId: c.draftId!, jobIds, dueAt, mode: c.mode, threadId: c.threadId },
      });
      if (c.back === "mail" || c.back === "thread") await refresh();
      return at === undefined
        ? "Sending. Press u to undo."
        : `Scheduled for ${formatTime(dueAt, timeZone)}. Press u to cancel.`;
    });

  /** Undo / cancel Send Later: cancel every job, then reopen the draft. */
  const undo = () =>
    attempt("Undo send", async () => {
      const u = s.undo;
      if (!u) return "Nothing to undo";
      // Every job is tried; a failed request keeps the jobs not yet settled available to retry.
      const late: Array<string> = [];
      for (const [i, job] of u.jobIds.entries()) {
        let result: { _tag?: string; state?: string };
        try {
          result = await exec<{ _tag?: string; state?: string }>("send cancel", [job]);
        } catch (error) {
          set({ undo: { ...u, jobIds: u.jobIds.slice(i) } });
          throw error;
        }
        if (result._tag === "TooLate") late.push(sanitize(String(result.state)));
      }
      set({ undo: null });
      if (late.length === u.jobIds.length)
        throw new Error(`too late: the message is already ${late.join(", ")}`);
      const draft = await showDraft(u.draftId);
      openCompose(u.mode, { draftId: u.draftId, ...draft }, u.threadId);
      return late.length === 0
        ? "Send cancelled; the draft is open again"
        : `Partly cancelled: ${late.length} of ${u.jobIds.length} sends were already ${late.join(", ")}; the draft is open again`;
    });

  const bubble = (threadId: string, ifNoReply = false) =>
    ask({
      label: ifNoReply
        ? "Follow up if no reply by? (2h, 3d, tomorrow, 2026-10-01T09:00):"
        : "Follow up when? (2h, 3d, tomorrow, 2026-10-01T09:00, now):",
      submit: async (value) => {
        const when = parseWhen(value, now());
        if (when === null) {
          set({ status: { level: "error", text: `Follow up: can't read "${sanitize(value)}"` } });
          return;
        }
        await mutate(
          "Follow up",
          when === "now"
            ? "Following up now"
            : `Follow-up ${formatTime(when, timeZone)}${ifNoReply ? " unless someone replies" : ""}`,
          () =>
            exec(
              "mail follow-up",
              [threadId],
              when === "now"
                ? { pin: true }
                : {
                    at: new Date(when).toISOString(),
                    ...(ifNoReply ? { "if-no-reply": true } : {}),
                  },
            ),
        );
      },
    });

  const screen = (sender: string | undefined, allow: boolean) => {
    const address = senderAddress(sender);
    if (!address) {
      set({ status: { level: "error", text: "Screening: this thread has no sender address" } });
      return;
    }
    const shown = sanitize(address);
    if (allow)
      ask({
        label: `Approve ${shown} into (i)mbox, (f)eed or (p)aper trail? esc cancels`,
        choices: "ifp",
        submit: (key) => {
          const to = key === "f" ? "feed" : key === "p" ? "paper-trail" : "imbox";
          return mutate("Approve sender", `Approved ${shown} into ${to}`, () =>
            exec("screen approve", [address], { to }),
          );
        },
      });
    else
      ask({
        label: `Screen out ${shown}? (y)es / (n)o`,
        choices: "yn",
        submit: (key) =>
          key === "y"
            ? mutate("Screen out", `Screened out ${shown}`, () => exec("screen reject", [address]))
            : Promise.resolve(set({ status: { level: "info", text: "Kept" } })),
      });
  };

  /** Actions shared by the mail list and the thread view. Returns false for unhandled keys. */
  const mailAction = async (key: string): Promise<boolean> => {
    if (key === "c") {
      openCompose("new", null, null);
      return true;
    }
    const t = target();
    const needs = ["r", "e", "f", "s", "l", "a", "b", "B", "p", "x", "d", "!", "R", "y", "n"];
    if (!needs.includes(key)) return false;
    if (!t) {
      set({ status: { level: "info", text: "Select a thread first" } });
      return true;
    }
    const id = t.threadId;
    let { row, sender } = t;
    // A search hit carries no thread state: read it, so seen and attention toggles act on the real
    // revision and flags, and screening knows the sender.
    if (!row && ["s", "l", "a", "y", "n"].includes(key)) {
      try {
        const detail = await fetchThread(id);
        row = detail.thread;
        sender = detail.deliveries?.[0]?.from.address ?? detail.thread.sender;
      } catch (error) {
        set({ status: { level: "error", text: describeError("Reading thread", error) } });
        return true;
      }
    }
    const attention = row?.attention;
    switch (key) {
      case "r":
        await reply(id, "reply");
        break;
      case "e":
        await reply(id, "reply-all");
        break;
      case "f":
        await reply(id, "forward");
        break;
      case "s":
        await mutate("Mark seen", "Marked seen", () =>
          exec("mail seen", [id], { revision: String(row?.revision ?? 0) }),
        );
        break;
      case "l": {
        const on = !attention?.replyLater;
        await mutate("Reply Later", on ? "Added to Reply Later" : "Removed from Reply Later", () =>
          exec("mail reply-later", [id], on ? {} : { off: true }),
        );
        break;
      }
      case "a": {
        const on = !attention?.setAside;
        await mutate("Set Aside", on ? "Set aside" : "No longer set aside", () =>
          exec("mail set-aside", [id], on ? {} : { off: true }),
        );
        break;
      }
      case "b":
        bubble(id);
        break;
      case "B":
        bubble(id, true);
        break;
      case "p":
        await mutate("Follow up now", "Back in the Inbox", () =>
          exec("mail follow-up", [id], { pop: true }),
        );
        break;
      case "x":
        await mutate("Clear follow-up", "Follow-up cleared", () =>
          exec("mail follow-up", [id], { off: true }),
        );
        break;
      case "d":
        await mutate("Trash", "Moved to Trash", () => exec("mail trash", [id]), true);
        break;
      case "!":
        await mutate("Spam", "Marked as spam", () => exec("mail spam", [id]), true);
        break;
      case "R":
        await mutate("Restore", "Restored", () => exec("mail restore", [id]), true);
        break;
      case "y":
      case "n":
        screen(sender, key === "y");
        break;
    }
    return true;
  };

  const moveIndex = (delta: number, length: number) =>
    set({ index: Math.max(0, Math.min(length - 1, s.index + delta)) });

  const onMail = async (key: string) => {
    const length = s.search ? s.search.hits.length : s.rows.length;
    const page = bodyHeight();
    if (key === "j" || key === "down") moveIndex(1, length);
    else if (key === "k" || key === "up") moveIndex(-1, length);
    else if (key === "pagedown" || key === " ") moveIndex(page, length);
    else if (key === "pageup") moveIndex(-page, length);
    else if (key === "enter" || key === "o") {
      const t = target();
      if (t) await openThread(t.threadId);
      else if (s.search) set({ status: { level: "info", text: "This result isn't a thread" } });
    } else if (/^[0-9]$/.test(key)) {
      const nav = MAIL_VIEW_NAV[(Number(key) + 9) % 10];
      if (nav) {
        set({ view: nav.view, index: 0, search: null });
        await loadView();
      }
    } else if (key === "/") ask({ label: "Search mail:", submit: (value) => runSearch(value) });
    else if (key === "g") await refresh();
    else if (key === "C") await openCalendar("agenda");
    else if (key === "escape" && s.search) {
      set({ search: null, index: 0 });
      await loadView();
    } else if (key === "q") {
      if (s.search) {
        set({ search: null, index: 0 });
        await loadView();
      } else finished = true;
    } else await mailAction(key);
  };

  const onThread = async (key: string) => {
    const t = s.thread!;
    const { lines, starts } = threadLines(t, size().columns, timeZone);
    const maxScroll = Math.max(0, lines.length - bodyHeight());
    const scrollTo = (scroll: number) => {
      const clamped = Math.max(0, Math.min(maxScroll, scroll));
      // The current message follows the top of the viewport.
      let message = 0;
      starts.forEach((start, i) => {
        if (start <= clamped) message = i;
      });
      set({
        thread: {
          ...t,
          scroll: clamped,
          message,
          attachment: message === t.message ? t.attachment : 0,
        },
      });
    };
    const files = t.deliveries[t.message]?.attachments ?? [];
    if (key === "j" || key === "down") scrollTo(t.scroll + 1);
    else if (key === "k" || key === "up") scrollTo(t.scroll - 1);
    else if (key === " " || key === "pagedown") scrollTo(t.scroll + bodyHeight());
    else if (key === "pageup") scrollTo(t.scroll - bodyHeight());
    else if (key === "]" || key === "[") {
      const message = Math.max(
        0,
        Math.min(t.deliveries.length - 1, t.message + (key === "]" ? 1 : -1)),
      );
      set({
        thread: {
          ...t,
          message,
          attachment: 0,
          scroll: Math.min(maxScroll, starts[message] ?? 0),
        },
      });
    } else if (key === "." || key === ",") {
      if (files.length === 0) set({ status: { level: "info", text: "No attachments here" } });
      else {
        const attachment = (t.attachment + (key === "." ? 1 : files.length - 1)) % files.length;
        const a = files[attachment]!;
        set({
          thread: { ...t, attachment },
          status: {
            level: "info",
            text: `Attachment ${attachment + 1}/${files.length}: ${sanitize(a.filename)} (${sanitize(a.contentType)}, ${a.size} bytes)`,
          },
        });
      }
    } else if (key === "q" || key === "escape") {
      set({ screen: "mail", thread: null });
      await refresh();
    } else if (key === "g") await refresh();
    else await mailAction(key);
  };

  const onCompose = async (key: string) => {
    const c = s.compose!;
    const field = COMPOSE_FIELDS[c.focus]!;
    const focus = (to: number) => {
      const next = (to + COMPOSE_FIELDS.length) % COMPOSE_FIELDS.length;
      set({
        compose: {
          ...c,
          focus: next,
          cursor: Array.from(c.fields[COMPOSE_FIELDS[next]!]).length,
        },
      });
    };
    if (key === "tab") focus(c.focus + 1);
    else if (key === "shift-tab") focus(c.focus - 1);
    else if (key === "escape") await closeCompose();
    else if (key === "ctrl-s")
      ask(
        c.threadId
          ? {
              label: "Send? y, d +done, b +follow up, r +follow up if no reply, c +clear, n no",
              choices: "ydbrcn",
              submit: (answer) =>
                answer === "n" ? Promise.resolve() : send(undefined, SEND_KEYS[answer]),
            }
          : {
              label: "Send? y, b +follow up, r +follow up if no reply, n no",
              choices: "ybrn",
              submit: (answer) =>
                answer === "n" ? Promise.resolve() : send(undefined, SEND_KEYS[answer]),
            },
      );
    else if (key === "ctrl-l")
      ask({
        label: "Send when? (2h, tomorrow, 2026-10-01T09:00):",
        submit: async (value) => {
          const when = parseWhen(value, now());
          if (when === null || when === "now" || when <= now())
            set({
              status: {
                level: "error",
                text: `Send later: "${sanitize(value)}" isn't a future time`,
              },
            });
          else await send(when);
        },
      });
    else {
      const edited = editText(c.fields[field], c.cursor, key, field === "body");
      if (edited)
        set({
          compose: { ...c, fields: { ...c.fields, [field]: edited.value }, cursor: edited.cursor },
        });
      else if (key === "enter" || key === "down") focus(c.focus + 1);
      else if (key === "up") focus(c.focus - 1);
    }
  };

  // ---- calendar ----

  const loadCalendar = () =>
    attempt("Loading calendar", async () => {
      if (s.calendar === "day") {
        const day = await exec<{ date?: string; occurrences?: ReadonlyArray<OccurrenceWire> }>(
          "cal day",
          [s.date],
          { tz: timeZone },
        );
        set({ days: [{ date: day.date ?? s.date, occurrences: day.occurrences ?? [] }] });
      } else {
        const agenda = await exec<{ days?: ReadonlyArray<AgendaDay> }>("cal agenda", [], {
          from: s.date,
          days: "7",
          tz: timeZone,
        });
        set({ days: agenda.days ?? [] });
      }
      const count = visibleOccurrences(s).length;
      set({ occurrence: Math.min(s.occurrence, Math.max(0, count - 1)) });
    });

  const openCalendar = async (mode: "agenda" | "day", date = s.date) => {
    set({ screen: mode, calendar: mode, date, occurrence: 0 });
    await loadCalendar();
  };

  const shiftDate = (days: number) => {
    const d = parseLocalDate(s.date);
    return d ? ymd(addDays(d, days)) : today();
  };

  const selected = () => visibleOccurrences(s)[s.occurrence];

  /** The day the selected occurrence is listed under (agenda), else the anchor date. */
  const selectedDay = () => {
    let n = s.occurrence;
    for (const day of s.days) {
      if (n < day.occurrences.length) return day.date;
      n -= day.occurrences.length;
    }
    return s.date;
  };

  const respond = (answer: "accept" | "tentative" | "decline", scope?: "this" | "series") => {
    const o = selected();
    if (!o) return set({ status: { level: "info", text: "Select an event first" } });
    if (!o.invitation)
      return set({ status: { level: "info", text: "This event isn't an invitation to you" } });
    if (o.recurring && scope === undefined) {
      ask({
        label: `Reply ${answer} to (t)his occurrence or the whole (s)eries?`,
        choices: "ts",
        submit: async (key) => {
          await respond(answer, key === "t" ? "this" : "series");
        },
      });
      return;
    }
    return attempt("Reply to invitation", async () => {
      await exec("cal respond", [o.eventId, answer], scope === "this" ? { occurrence: o.key } : {});
      await loadCalendar();
      const what = scope === "series" ? " (every occurrence)" : "";
      return `Replied ${answer} to ${sanitize(o.data.summary || "(untitled)")}${what}`;
    });
  };

  const openForm = (occurrence: OccurrenceWire | null) => {
    const day = selectedDay();
    const fields = occurrence
      ? {
          title: occurrence.data.summary,
          start: wallClock(occurrence.start),
          end: wallClock(occurrence.end),
          location: occurrence.data.location ?? "",
        }
      : { title: "", start: `${day}T09:00`, end: `${day}T10:00`, location: "" };
    set({
      screen: "form",
      form: {
        occurrence,
        fields,
        saved: fields,
        // Edits keep the event's own zone; new events use the viewer's.
        tz: occurrence?.start.kind === "timed" ? occurrence.start.tzid : timeZone,
        focus: 0,
        cursor: Array.from(fields.title).length,
        back: s.calendar,
      },
    });
  };

  const defaultCalendar = async () => {
    if (calendarId) return calendarId;
    const list = await exec<{ items?: ReadonlyArray<{ id?: string; calendarId?: string }> }>(
      "cal calendars",
    );
    calendarId = firstCalendarId(list.items ?? []) ?? undefined;
    if (!calendarId) throw new Error("no calendar to add the event to");
    return calendarId;
  };

  const saveEvent = async (scope?: "this" | "future" | "series") => {
    const f = s.form!;
    const o = f.occurrence;
    if (o?.recurring && scope === undefined) {
      ask({
        label: "Change (t)his occurrence, (f)uture ones, or the whole (s)eries?",
        choices: "tfs",
        submit: (key) => saveEvent(key === "t" ? "this" : key === "f" ? "future" : "series"),
      });
      return;
    }
    await attempt(o ? "Save event" : "Create event", async () => {
      const location = f.fields.location.trim();
      if (!o) {
        await exec("cal add", [], {
          "calendar-id": await defaultCalendar(),
          title: f.fields.title,
          start: f.fields.start,
          end: f.fields.end,
          tz: f.tz,
          ...(location ? { location } : {}),
        });
      } else {
        const changed = EVENT_FIELDS.filter((k: EventField) => f.fields[k] !== f.saved[k]);
        if (changed.length === 0) {
          set({ screen: f.back, form: null });
          return "No changes";
        }
        await exec("cal edit", [o.eventId], {
          revision: String(o.revision ?? 0),
          scope: scope ?? "series",
          // A recurring event's times were edited from this occurrence (it anchors a series edit).
          ...(o.recurring ? { occurrence: o.key } : {}),
          tz: f.tz,
          ...Object.fromEntries(changed.map((k) => [k, k === "location" ? location : f.fields[k]])),
        });
      }
      set({ screen: f.back, form: null });
      await loadCalendar();
      return o ? "Event updated" : "Event created";
    });
  };

  const onCalendar = async (key: string) => {
    const count = visibleOccurrences(s).length;
    const day = s.screen === "day";
    if (key === "j" || key === "down")
      set({ occurrence: Math.min(Math.max(0, count - 1), s.occurrence + 1) });
    else if (key === "k" || key === "up") set({ occurrence: Math.max(0, s.occurrence - 1) });
    else if (key === "h" || key === "left")
      await openCalendar(s.calendar, shiftDate(day ? -1 : -7));
    else if (key === "l" || key === "right") await openCalendar(s.calendar, shiftDate(day ? 1 : 7));
    else if (key === "t") await openCalendar(s.calendar, today());
    else if (key === "a") await openCalendar("agenda");
    else if (key === "v") await openCalendar("day", selectedDay());
    else if (key === "g") await loadCalendar();
    else if (key === "enter" || key === "o") {
      if (selected()) set({ screen: "event" });
    } else if (key === "c") openForm(null);
    else if (key === "e") {
      const o = selected();
      if (o) openForm(o);
    } else if (Object.hasOwn(PARTSTAT_KEYS, key)) await respond(PARTSTAT_KEYS[key]!);
    else if (key === "m" || key === "q" || key === "escape") {
      set({ screen: "mail" });
      if (s.rows.length === 0 && !s.search) await loadView();
    }
  };

  const onEvent = async (key: string) => {
    const o = selected();
    if (key === "e" && o) openForm(o);
    else if (Object.hasOwn(PARTSTAT_KEYS, key)) await respond(PARTSTAT_KEYS[key]!);
    else if (key === "q" || key === "escape") set({ screen: s.calendar });
  };

  const onForm = async (key: string) => {
    const f = s.form!;
    const field = EVENT_FIELDS[f.focus]!;
    const focus = (to: number) => {
      const next = (to + EVENT_FIELDS.length) % EVENT_FIELDS.length;
      set({
        form: { ...f, focus: next, cursor: Array.from(f.fields[EVENT_FIELDS[next]!]).length },
      });
    };
    if (key === "tab" || key === "enter" || key === "down") focus(f.focus + 1);
    else if (key === "shift-tab" || key === "up") focus(f.focus - 1);
    else if (key === "escape")
      set({ screen: f.back, form: null, status: { level: "info", text: "Cancelled" } });
    else if (key === "ctrl-s") await saveEvent();
    else {
      const edited = editText(f.fields[field], f.cursor, key, false);
      if (edited)
        set({
          form: { ...f, fields: { ...f.fields, [field]: edited.value }, cursor: edited.cursor },
        });
    }
  };

  const onPrompt = async (key: string) => {
    const p = s.prompt!;
    if (key === "escape") set({ prompt: null, status: { level: "info", text: "Cancelled" } });
    else if (p.choices) {
      if (p.choices.includes(key)) {
        set({ prompt: null });
        await p.submit(key);
      }
    } else if (key === "enter") {
      set({ prompt: null });
      await p.submit(p.value);
    } else {
      const edited = editText(p.value, Array.from(p.value).length, key, false);
      if (edited) set({ prompt: { ...p, value: edited.value } });
    }
  };

  const press = async (key: string) => {
    if (key === "ctrl-c") {
      finished = true;
      return;
    }
    if (s.prompt) return onPrompt(key);
    const typing = s.screen === "compose" || s.screen === "form";
    if (!typing && key === "?") {
      set({ screen: "help", help: { scroll: 0, back: s.screen === "help" ? "mail" : s.screen } });
      return;
    }
    if (!typing && key === "u" && s.screen !== "help") return undo();
    const handlers: Readonly<Record<Screen, (key: string) => Promise<void> | void>> = {
      mail: onMail,
      thread: onThread,
      compose: onCompose,
      agenda: onCalendar,
      day: onCalendar,
      event: onEvent,
      form: onForm,
      help: (k) => {
        if (k === "j" || k === "down") set({ help: { ...s.help, scroll: s.help.scroll + 1 } });
        else if (k === "k" || k === "up")
          set({ help: { ...s.help, scroll: Math.max(0, s.help.scroll - 1) } });
        else if (k === "q" || k === "escape") set({ screen: s.help.back });
      },
    };
    await handlers[s.screen](key);
  };

  return {
    state: () => s,
    done: () => finished,
    start: loadView,
    press,
    type: async (input) => {
      for (const key of decodeKeys(input)) await press(key);
    },
    frame: (frame = {}) => renderFrame(s, { ...size(), color: false, now: now(), ...frame }),
    settled: () => background,
  };
};

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Message documents come from the render origin by capability URL: no credentials, no redirects. */
export const fetchRendered = async (url: string): Promise<string> => {
  const target = new URL(url);
  if (
    target.protocol !== "https:" &&
    !(target.protocol === "http:" && LOOPBACK.has(target.hostname))
  )
    throw new Error("render URL must be https");
  const response = await fetch(target, { redirect: "error", credentials: "omit" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
};

export const runTui = async (
  api: Layer.Layer<CliApi>,
  newCommandId: () => string,
): Promise<number> => {
  const input = process.stdin;
  const output = process.stdout;
  // Monochrome when asked (NO_COLOR) or not a colour terminal; selection is also marked with `>`.
  const color = output.isTTY === true && !process.env.NO_COLOR && process.env.TERM !== "dumb";
  const size = () => ({ columns: output.columns || 80, rows: output.rows || 24 });
  let failed: unknown;
  let finish = () => undefined as void;
  // Any render or key-handling failure restores the terminal before it is reported.
  const safely = (run: () => void) => {
    try {
      run();
    } catch (error) {
      failed ??= error;
      finish();
    }
  };
  const tui = createTui({
    api,
    newCommandId,
    fetchText: fetchRendered,
    size,
    onUpdate: () => safely(paint),
  });
  const paint = () =>
    void output.write(
      `\u001b[H${tui
        .frame({ color })
        .map((line) => `${line}\u001b[K`)
        .join("\r\n")}\u001b[J`,
    );
  const draw = () => safely(paint);
  output.write("\u001b[?1049h\u001b[?25l");
  if (input.isTTY) input.setRawMode(true);
  input.setEncoding("utf8");
  try {
    await tui.start();
  } catch (error) {
    failed = error;
  }
  if (failed === undefined) draw();
  // Redraw once a second so the undo countdown stays current.
  const ticker = setInterval(() => {
    if (tui.state().undo) draw();
  }, 1000);
  return new Promise<number>((resolve) => {
    let queue = Promise.resolve();
    let finished = false;
    finish = () => {
      if (finished) return;
      finished = true;
      clearInterval(ticker);
      input.off("data", onData);
      output.off("resize", draw);
      if (input.isTTY) input.setRawMode(false);
      input.pause();
      output.write("\u001b[?25h\u001b[?1049l");
      if (failed === undefined) return resolve(0);
      process.stderr.write(
        `bye tui: ${sanitize(failed instanceof Error ? failed.message : JSON.stringify(failed))}\n`,
      );
      resolve(1);
    };
    const onData = (chunk: string) => {
      queue = queue
        .then(async () => {
          for (const key of decodeKeys(chunk)) {
            if (tui.done() || finished) break;
            await tui.press(key);
            draw();
          }
          if (tui.done()) finish();
        })
        .catch((error: unknown) => {
          failed ??= error;
          finish();
        });
    };
    input.on("data", onData);
    output.on("resize", draw);
    if (failed !== undefined) finish();
  });
};
