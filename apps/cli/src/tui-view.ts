import type { OccurrenceWire } from "@bye/contracts";
import type { DeliveryWire } from "@bye/native-shared/wire";
import { MAIL_VIEW_NAV, type MailView } from "@bye/native-shared/views";
import { PARTSTAT_LABEL } from "@bye/native-shared/mail-calendar";
import { sanitize } from "./format.ts";

// TUI state and rendering (X02, P1.3). Rendering is a pure function of the state and the terminal
// size, so acceptance tests assert on frames. Every string that came from the server passes
// through `sanitize` (or `safeLines`) before it reaches a frame; selection is always marked with
// `>` so nothing depends on colour (NO_COLOR, monochrome terminals).

export type Screen = "mail" | "thread" | "compose" | "agenda" | "day" | "event" | "form" | "help";

export interface ThreadRow {
  readonly threadId: string;
  readonly subject?: string;
  readonly sender?: string;
  readonly revision?: number;
  readonly seenRevision?: number;
  readonly newForYou?: boolean;
  readonly lastActivityAt?: number;
  readonly messageCount?: number;
  readonly attention?: {
    readonly replyLater?: boolean;
    readonly setAside?: boolean;
    readonly bubble?: { readonly _tag: string; readonly at?: number };
  };
}

export interface SearchHit {
  readonly kind: string;
  readonly id: string;
  readonly threadId: string | null;
  readonly date: number;
  readonly snippet: string;
}

export interface ThreadState {
  readonly thread: ThreadRow;
  readonly deliveries: ReadonlyArray<DeliveryWire>;
  /** Plain-text bodies by delivery ID (`null` while loading; an Error when the render fetch failed). */
  readonly bodies: Readonly<Record<string, string | Error | null>>;
  readonly message: number;
  readonly attachment: number;
  readonly scroll: number;
}

export type ComposeMode = "new" | "reply" | "reply-all" | "forward";

export const COMPOSE_FIELDS = ["to", "cc", "bcc", "subject", "body"] as const;

export type ComposeField = (typeof COMPOSE_FIELDS)[number];

export interface ComposeState {
  readonly mode: ComposeMode;
  readonly draftId: string | null;
  readonly revision: number;
  readonly threadId: string | null;
  readonly fields: Readonly<Record<ComposeField, string>>;
  /** Field values as last saved, so a save sends only what changed. */
  readonly saved: Readonly<Record<ComposeField, string>>;
  readonly focus: number;
  readonly cursor: number;
  /** Where Esc returns to. */
  readonly back: Screen;
}

export interface AgendaDay {
  readonly date: string;
  readonly occurrences: ReadonlyArray<OccurrenceWire>;
}

export const EVENT_FIELDS = ["title", "start", "end", "location"] as const;

export type EventField = (typeof EVENT_FIELDS)[number];

export interface EventFormState {
  readonly occurrence: OccurrenceWire | null;
  readonly fields: Readonly<Record<EventField, string>>;
  readonly saved: Readonly<Record<EventField, string>>;
  /** Zone the wall-clock start/end are in: the event's own for edits, the viewer's for new ones. */
  readonly tz: string;
  readonly focus: number;
  readonly cursor: number;
  readonly back: Screen;
}

export interface PromptState {
  readonly label: string;
  readonly value: string;
  /** Single-key choices (e.g. "yn"); absent for free text submitted with Enter. */
  readonly choices?: string;
  readonly submit: (value: string) => Promise<void>;
}

export interface TuiState {
  readonly screen: Screen;
  readonly view: MailView;
  readonly rows: ReadonlyArray<ThreadRow>;
  readonly search: {
    readonly query: string;
    readonly hits: ReadonlyArray<SearchHit>;
    readonly lagging: boolean;
  } | null;
  readonly index: number;
  readonly thread: ThreadState | null;
  readonly compose: ComposeState | null;
  /** Calendar mode the event screens return to, and the day it is anchored on (YYYY-MM-DD). */
  readonly calendar: "agenda" | "day";
  readonly date: string;
  readonly days: ReadonlyArray<AgendaDay>;
  readonly occurrence: number;
  readonly form: EventFormState | null;
  readonly prompt: PromptState | null;
  readonly status: { readonly level: "info" | "error"; readonly text: string };
  /** The last send, while it can still be cancelled (undo / Send Later). */
  readonly undo: {
    readonly draftId: string;
    readonly jobIds: ReadonlyArray<string>;
    readonly dueAt: number;
    readonly mode: ComposeMode;
    readonly threadId: string | null;
  } | null;
  readonly help: { readonly scroll: number; readonly back: Screen };
  readonly timeZone: string;
}

export interface FrameOptions {
  readonly columns: number;
  readonly rows: number;
  /** Reverse-video the selected line; selection is also always marked with `>`. */
  readonly color: boolean;
  readonly now: number;
}

// ---- text helpers ----

const chars = (s: string) => Array.from(s);

/** Truncate to `width` terminal cells (one per code point; wide glyphs are not measured). */
export const fit = (s: string, width: number): string => {
  const c = chars(s);

  return c.length <= width ? s : `${c.slice(0, Math.max(0, width - 1)).join("")}…`;
};

/** Word-wrap one line to `width`; words longer than a line are broken. */
export const wrap = (line: string, width: number): Array<string> => {
  if (chars(line).length <= width) return [line];
  const out: Array<string> = [];
  let current: Array<string> = [];

  for (const word of line.split(" ")) {
    let w = chars(word);

    if (current.length > 0 && current.length + 1 + w.length <= width) {
      current.push(" ", ...w);
      continue;
    }

    if (current.length > 0) out.push(current.join(""));

    while (w.length > width) {
      out.push(w.slice(0, width).join(""));
      w = w.slice(width);
    }

    current = w;
  }

  if (current.length > 0 || out.length === 0) out.push(current.join(""));

  return out;
};

/** Wrap to `width` with every piece indented (the indent counts toward the width). */
const indented = (text: string, indent: string, width: number) =>
  wrap(text, Math.max(1, width - indent.length)).map((piece) => `${indent}${piece}`);

/** Untrusted multi-line text as terminal-safe lines (line structure kept, controls stripped). */
export const safeLines = (text: string): Array<string> =>
  text.split(/\r\n|\r|\n|\u2028|\u2029/).map((line) => sanitize(line.replace(/\t/g, "    ")));

// ---- keys ----

const SEQUENCES = new Map<string, string>([
  ["\u001b[A", "up"],
  ["\u001b[B", "down"],
  ["\u001b[C", "right"],
  ["\u001b[D", "left"],
  ["\u001bOA", "up"],
  ["\u001bOB", "down"],
  ["\u001bOC", "right"],
  ["\u001bOD", "left"],
  ["\u001b[H", "home"],
  ["\u001b[F", "end"],
  ["\u001bOH", "home"],
  ["\u001bOF", "end"],
  ["\u001b[1~", "home"],
  ["\u001b[4~", "end"],
  ["\u001b[3~", "delete"],
  ["\u001b[5~", "pageup"],
  ["\u001b[6~", "pagedown"],
  ["\u001b[Z", "shift-tab"],
]);

/**
 * Raw terminal input as key names: printable characters as themselves, and "enter", "tab",
 * "escape", "backspace", "up", "ctrl-s", …. Unknown escape sequences (bracketed-paste markers,
 * function keys) are dropped, so pasted text arrives as plain keys.
 */
export const decodeKeys = (input: string): Array<string> => {
  const keys: Array<string> = [];

  for (let i = 0; i < input.length;) {
    if (input[i] === "\u001b") {
      // oxlint-disable-next-line no-control-regex -- intentional control-char match
      const seq = /^\u001b(?:\[[0-9;]*[@-~]|O[A-Za-z])/.exec(input.slice(i));

      if (seq) {
        const name = SEQUENCES.get(seq[0]);

        if (name) keys.push(name);
        i += seq[0].length;
      } else {
        keys.push("escape");
        i++;
      }

      continue;
    }

    const ch = String.fromCodePoint(input.codePointAt(i)!);
    const cp = ch.codePointAt(0)!;
    i += ch.length;

    if (ch === "\r") {
      keys.push("enter");

      if (input[i] === "\n") i++;
    } else if (ch === "\n") keys.push("enter");
    else if (ch === "\t") keys.push("tab");
    else if (ch === "\u007f" || ch === "\b") keys.push("backspace");
    else if (cp < 0x20) keys.push(`ctrl-${String.fromCharCode(cp + 96)}`);
    else if (cp >= 0x80 && cp <= 0x9f) continue;
    else keys.push(ch);
  }

  return keys;
};

/**
 * One key applied to a text field with a cursor (insert, delete, move). Returns null for keys a
 * field doesn't handle. Multi-line fields move by line with up/down.
 */
export const editText = (
  value: string,
  cursor: number,
  key: string,
  multiline: boolean,
): { readonly value: string; readonly cursor: number } | null => {
  const c = chars(value);
  const at = Math.min(Math.max(cursor, 0), c.length);

  const lineStart = (pos: number) => {
    let p = pos;

    while (p > 0 && c[p - 1] !== "\n") p--;

    return p;
  };

  const lineEnd = (pos: number) => {
    let p = pos;

    while (p < c.length && c[p] !== "\n") p++;

    return p;
  };

  switch (key) {
    case "backspace":
      return at === 0
        ? { value, cursor: 0 }
        : { value: [...c.slice(0, at - 1), ...c.slice(at)].join(""), cursor: at - 1 };
    case "delete":
      return { value: [...c.slice(0, at), ...c.slice(at + 1)].join(""), cursor: at };
    case "left":
      return { value, cursor: Math.max(0, at - 1) };
    case "right":
      return { value, cursor: Math.min(c.length, at + 1) };
    case "home":
    case "ctrl-a":
      return { value, cursor: multiline ? lineStart(at) : 0 };
    case "end":
    case "ctrl-e":
      return { value, cursor: multiline ? lineEnd(at) : c.length };
    case "ctrl-u":
      return { value: "", cursor: 0 };
    case "up":
    case "down": {
      if (!multiline) return null;
      const start = lineStart(at);
      const column = at - start;

      if (key === "up") {
        if (start === 0) return { value, cursor: 0 };
        const prev = lineStart(start - 1);

        return { value, cursor: Math.min(prev + column, start - 1) };
      }

      const end = lineEnd(at);

      if (end === c.length) return { value, cursor: c.length };

      return { value, cursor: Math.min(end + 1 + column, lineEnd(end + 1)) };
    }

    case "enter":
      if (!multiline) return null;

      return { value: [...c.slice(0, at), "\n", ...c.slice(at)].join(""), cursor: at + 1 };
    default:
      if (chars(key).length !== 1) return null;

      return { value: [...c.slice(0, at), key, ...c.slice(at)].join(""), cursor: at + 1 };
  }
};

// ---- formatting ----

const pad2 = (n: number) => String(n).padStart(2, "0");

/** `YYYY-MM-DD HH:mm` in the viewer's zone. */
export const formatTime = (ms: number, timeZone: string): string => {
  // A missing or invalid time from the server renders blank rather than throwing (RangeError).
  if (!Number.isFinite(ms)) return "";

  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(ms));

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";

  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
};

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const dayLabel = (date: string) => {
  const [y, m, d] = date.split("-").map(Number);

  return `${WEEKDAYS[new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay()]} ${date}`;
};

const size = (bytes: number) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${(bytes / 1024).toFixed(1)} KB`
      : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

const address = (a: { readonly name?: string; readonly address: string }) =>
  a.name ? `${a.name} <${a.address}>` : a.address;

/** `HH:mm–HH:mm` (or "all day") for an occurrence, in the viewer's zone. */
export const occurrenceTime = (o: OccurrenceWire, timeZone: string): string =>
  o.allDay
    ? "all day    "
    : `${formatTime(o.startMs, timeZone).slice(11)}–${formatTime(o.endMs, timeZone).slice(11)}`;

/** Wall-clock `YYYY-MM-DDTHH:mm` (or `YYYY-MM-DD`) of an event time, in the event's own zone. */
export const wallClock = (t: OccurrenceWire["start"]): string =>
  t.kind === "date"
    ? `${t.date.year}-${pad2(t.date.month)}-${pad2(t.date.day)}`
    : `${t.local.year}-${pad2(t.local.month)}-${pad2(t.local.day)}T${pad2(t.local.hour)}:${pad2(t.local.minute)}`;

const BUBBLE_MARK = new Map<string, string>([
  ["Scheduled", "B"],
  ["Pinned", "P"],
]);

const flags = (row: ThreadRow) => {
  const unseen = row.newForYou === true || (row.revision ?? 0) > (row.seenRevision ?? Infinity);
  const bubble = row.attention?.bubble?._tag;

  return [
    unseen ? "N" : " ",
    row.attention?.replyLater ? "L" : " ",
    row.attention?.setAside ? "A" : " ",
    (bubble === undefined ? undefined : BUBBLE_MARK.get(bubble)) ?? " ",
  ].join("");
};

// ---- screens ----

interface Line {
  readonly text: string;
  readonly selected?: boolean;
}

/** Scroll window of `height` lines around `focus`. */
const windowed = <T>(items: ReadonlyArray<T>, focus: number, height: number): ReadonlyArray<T> => {
  const start = Math.max(0, Math.min(focus - Math.floor(height / 2), items.length - height));

  return items.slice(start, start + height);
};

const viewLabel = (view: MailView) => MAIL_VIEW_NAV.find((n) => n.view === view)?.label ?? view;

const mailBody = (s: TuiState, width: number, height: number): Array<Line> => {
  if (s.search) {
    if (s.search.hits.length === 0) return [{ text: "  No results." }];

    const lines = s.search.hits.map((hit, i) => ({
      text: `${i === s.index ? ">" : " "} ${fit(sanitize(hit.kind), 8).padEnd(8)} ${formatTime(hit.date, s.timeZone).slice(0, 10)}  ${sanitize(hit.snippet)}`,
      selected: i === s.index,
    }));

    return [...windowed(lines, s.index, height)];
  }

  if (s.rows.length === 0) return [{ text: "  Nothing here." }];
  const senderWidth = Math.min(24, Math.max(10, Math.floor(width * 0.3)));

  // The Screener is about who is writing, so it shows full addresses; other views show names.
  const who = (sender: string) =>
    s.view === "screener" ? sender : sender.replace(/\s*<[^<>]*>\s*$/, "") || sender;

  const lines = s.rows.map((row, i) => ({
    text: `${i === s.index ? ">" : " "} ${flags(row)} ${fit(who(sanitize(row.sender ?? "")), senderWidth).padEnd(senderWidth)}  ${sanitize(row.subject || "(no subject)")}`,
    selected: i === s.index,
  }));

  return [...windowed(lines, s.index, height)];
};

interface ThreadLines {
  readonly lines: ReadonlyArray<Line>;
  readonly starts: ReadonlyArray<number>;
}

/** The whole thread as lines, with where each message starts (for [ and ] navigation). */
export const threadLines = (t: ThreadState, width: number, timeZone: string): ThreadLines => {
  const lines: Array<Line> = [];
  const starts: Array<number> = [];

  const push = (text: string, selected = false, indent = "") => {
    for (const piece of indented(text, indent, width)) lines.push({ text: piece, selected });
  };

  t.deliveries.forEach((d, i) => {
    const current = i === t.message;
    starts.push(lines.length);
    push(
      `${current ? ">" : " "} [${i + 1}/${t.deliveries.length}] ${sanitize(d.subject || "(no subject)")}`,
      current,
    );
    push(`  From: ${sanitize(address(d.from))}`);

    if (d.to.length) push(`  To: ${sanitize(d.to.map(address).join(", "))}`);

    if (d.cc.length) push(`  Cc: ${sanitize(d.cc.map(address).join(", "))}`);
    push(`  Date: ${formatTime(d.date, timeZone)}`);
    const files = d.attachments ?? [];

    if (d.scan) push(`  Scan: ${sanitize(d.scan.status)}`);

    if (files.length) {
      push(`  Attachments (${files.length}):`);
      files.forEach((a, j) => {
        const mark = current && j === t.attachment ? ">" : " ";
        push(
          `  ${mark} [${j + 1}] ${sanitize(a.filename)}  ${sanitize(a.contentType)}  ${size(a.size)}  id ${sanitize(a.partId)}`,
        );
      });
    }

    push("");
    const body = t.bodies[d.deliveryId];

    const text =
      body === undefined || body === null
        ? `${d.snippet}\n(loading full message…)`
        : body instanceof Error
          ? `${d.snippet}\n(full message unavailable: ${body.message})`
          : body;

    for (const line of safeLines(text)) push(line, false, "  ");
    push("");
  });

  return { lines, starts };
};

const threadBody = (s: TuiState, width: number, height: number): Array<Line> => {
  const t = s.thread;

  if (!t) return [];
  const { lines } = threadLines(t, width, s.timeZone);

  return lines.slice(t.scroll, t.scroll + height);
};

const CURSOR = "|";

/** A field's value with the cursor marked, as terminal-safe lines. */
const withCursor = (value: string, cursor: number | null): Array<string> => {
  if (cursor === null) return safeLines(value);
  const c = chars(value);
  const before = safeLines(c.slice(0, cursor).join(""));
  const after = safeLines(c.slice(cursor).join(""));

  const joined = [
    ...before.slice(0, -1),
    `${before.at(-1)}${CURSOR}${after[0]}`,
    ...after.slice(1),
  ];

  return joined;
};

const COMPOSE_LABELS: Readonly<Record<ComposeField, string>> = {
  to: "To",
  cc: "Cc",
  bcc: "Bcc",
  subject: "Subject",
  body: "Body",
};

const composeBody = (s: TuiState, width: number, height: number): Array<Line> => {
  const c = s.compose;

  if (!c) return [];

  const head: Array<Line> = COMPOSE_FIELDS.slice(0, 4).map((field, i) => {
    const focused = c.focus === i;
    const value = withCursor(c.fields[field], focused ? c.cursor : null).join(" ");

    return {
      text: `${focused ? ">" : " "} ${COMPOSE_LABELS[field].padEnd(8)}${value}`,
      selected: focused,
    };
  });

  const bodyFocused = c.focus === 4;
  head.push({ text: `${bodyFocused ? ">" : " "} Body:`, selected: bodyFocused });
  const raw = withCursor(c.fields.body, bodyFocused ? c.cursor : null);
  const body: Array<string> = [];
  let cursorLine = 0;

  for (const line of raw) {
    if (line.includes(CURSOR)) cursorLine = body.length;
    body.push(...indented(line, "  ", width));
  }

  const room = Math.max(1, height - head.length);

  return [...head, ...windowed(body, cursorLine, room).map((text) => ({ text }))];
};

const calendarBody = (s: TuiState, height: number): Array<Line> => {
  const lines: Array<Line> = [];
  let focusLine = 0;
  let n = 0;

  for (const day of s.days) {
    lines.push({ text: dayLabel(day.date) });

    if (day.occurrences.length === 0) lines.push({ text: "    (nothing scheduled)" });

    for (const o of day.occurrences) {
      const selected = n === s.occurrence;

      if (selected) focusLine = lines.length;
      const where = o.data.location ? `  @ ${sanitize(o.data.location)}` : "";
      const status = o.data.status && o.data.status !== "confirmed" ? ` (${o.data.status})` : "";
      lines.push({
        text: `${selected ? ">" : " "}   ${occurrenceTime(o, s.timeZone)}  ${sanitize(o.data.summary || "(untitled)")}${status}${o.recurring ? " [repeats]" : ""}${where}`,
        selected,
      });
      n++;
    }
  }

  if (lines.length === 0) lines.push({ text: "  No events." });

  return [...windowed(lines, focusLine, height)];
};

/** Occurrences in display order (the agenda's days, or the day view's one day). */
export const visibleOccurrences = (s: TuiState): ReadonlyArray<OccurrenceWire> =>
  s.days.flatMap((d) => d.occurrences);

const eventBody = (s: TuiState, width: number): Array<Line> => {
  const o = visibleOccurrences(s)[s.occurrence];

  if (!o) return [{ text: "  No event selected." }];

  const lines: Array<Line> = [
    { text: `  ${sanitize(o.data.summary || "(untitled)")}` },
    { text: "" },
    {
      text: `  When: ${o.allDay ? `${wallClock(o.start)} (all day)` : `${formatTime(o.startMs, s.timeZone)} – ${formatTime(o.endMs, s.timeZone)}`}`,
    },
  ];

  if (o.start.kind === "timed") lines.push({ text: `  Zone: ${sanitize(o.start.tzid)}` });

  if (o.data.location) lines.push({ text: `  Where: ${sanitize(o.data.location)}` });

  if (o.data.status) lines.push({ text: `  Status: ${sanitize(o.data.status)}` });

  if (o.recurring) lines.push({ text: `  Repeats (occurrence ${sanitize(o.key)})` });

  if (o.invitation) {
    const who = o.invitation.organizer.name || o.invitation.organizer.address;
    lines.push({ text: `  Invited by: ${sanitize(who)}` });
    lines.push({
      text: `  Your answer: ${PARTSTAT_LABEL[o.invitation.partstat] ?? sanitize(o.invitation.partstat)}  (Y/T/D to reply)`,
    });
  }

  if (o.data.url) lines.push({ text: `  Link: ${sanitize(o.data.url)}` });

  if (o.data.description) {
    lines.push({ text: "" });

    for (const line of safeLines(o.data.description))
      for (const piece of indented(line, "  ", width)) lines.push({ text: piece });
  }

  return lines;
};

const EVENT_LABELS: Readonly<Record<EventField, string>> = {
  title: "Title",
  start: "Start",
  end: "End",
  location: "Where",
};

const formBody = (s: TuiState): Array<Line> => {
  const f = s.form;

  if (!f) return [];

  return [
    { text: `  ${f.occurrence ? "Edit event" : "New event"} (times in ${sanitize(f.tz)})` },
    { text: "" },
    ...EVENT_FIELDS.map((field, i) => ({
      text: `${f.focus === i ? ">" : " "} ${EVENT_LABELS[field].padEnd(7)}${withCursor(f.fields[field], f.focus === i ? f.cursor : null).join(" ")}`,
      selected: f.focus === i,
    })),
    { text: "" },
    { text: "  Start/End: YYYY-MM-DDTHH:mm, or YYYY-MM-DD for all day." },
  ];
};

export const HELP: ReadonlyArray<string> = [
  "Everywhere: ? help  u undo last send  q/esc back  ctrl-c quit (only ctrl-c while typing)",
  "",
  "Mail list",
  "  j/k or up/down  move            enter/o  open thread",
  "  1-9, 0          views: Inbox, Newsletters, Receipts, New Senders, Reply Later,",
  "                  Set Aside, Follow Up, Spam, Screened Out, Trash",
  "  /  search       g  refresh      C  calendar",
  "",
  "Thread and list actions",
  "  c new message   r reply   e reply all   f forward",
  "  s mark seen     l reply later (toggle)  a set aside (toggle)",
  "  b follow up (when: 2h, 3d, tomorrow, 2026-10-01T09:00, now)",
  "  B follow up only if nobody replies",
  "  p follow up now  x clear follow-up",
  "  y approve sender (New Senders)   n screen out sender",
  "  d trash   !  spam   R restore",
  "",
  "Thread",
  "  j/k scroll   space/pagedown page   ] / [ next/previous message",
  "  . / , next/previous attachment of the current message",
  "",
  "Compose",
  "  tab/shift-tab next/previous field   arrows move the cursor",
  "  ctrl-s send   ctrl-l send later   ctrl-u clear field   esc save and close",
  "",
  "Calendar",
  "  j/k move   enter details   a agenda   v day view   h/l previous/next",
  "  t today    c new event     e edit     g refresh    m mail",
  "  Y accept   T tentative     D decline (invitations)",
  "",
  "Event form: tab next field, ctrl-s save, esc cancel",
];

const HINTS: Readonly<Record<Screen, string>> = {
  mail: "j/k move  enter open  r/e/f reply  c new  / search  1-0 views  C calendar  ? help",
  thread: "j/k scroll  ]/[ message  ./, attachment  r/e/f reply  d trash  ? help  q back",
  compose: "tab field  ctrl-s send  ctrl-l send later  esc save+close",
  agenda: "j/k move  enter details  v day  h/l week  c new  e edit  Y/T/D reply  m mail",
  day: "j/k move  enter details  h/l day  a agenda  c new  e edit  Y/T/D reply  m mail",
  event: "e edit  Y/T/D reply to invitation  q back",
  form: "tab field  ctrl-s save  esc cancel",
  help: "j/k scroll  q back",
};

const title = (s: TuiState): string => {
  switch (s.screen) {
    case "mail":
      return s.search
        ? `Search "${sanitize(s.search.query)}" · ${s.search.hits.length} results${s.search.lagging ? " (index catching up; may be incomplete)" : ""}`
        : `${viewLabel(s.view)} · ${s.rows.length} threads`;
    case "thread":
      return `Thread · ${sanitize(s.thread?.thread.subject || "(no subject)")}`;
    case "compose": {
      const mode = s.compose?.mode ?? "new";

      return `Compose · ${mode === "new" ? "new message" : mode}${s.compose?.draftId ? " · draft saved" : ""}`;
    }

    case "agenda":
      return `Agenda · from ${s.date}`;
    case "day":
      return `Day · ${dayLabel(s.date)}`;
    case "event":
      return "Event";
    case "form":
      return s.form?.occurrence ? "Edit event" : "New event";
    case "help":
      return "Keys";
  }
};

/** Render the whole screen: title, rule, body, status/prompt and key hints, fitted to the terminal. */
export const renderFrame = (s: TuiState, o: FrameOptions): ReadonlyArray<string> => {
  const width = Math.max(20, o.columns);
  const height = Math.max(4, o.rows - 4);

  const body = (() => {
    switch (s.screen) {
      case "mail":
        return mailBody(s, width, height);
      case "thread":
        return threadBody(s, width, height);
      case "compose":
        return composeBody(s, width, height);
      case "agenda":
      case "day":
        return calendarBody(s, height);
      case "event":
        return eventBody(s, width).slice(0, height);
      case "form":
        return formBody(s);
      case "help":
        return HELP.slice(s.help.scroll, s.help.scroll + height).map((text) => ({ text }));
    }
  })();

  const undo =
    s.undo && s.undo.dueAt > o.now
      ? `  [u undo until ${formatTime(s.undo.dueAt, s.timeZone).slice(11)}]`
      : "";

  const status = s.prompt
    ? `${s.prompt.label}${s.prompt.choices ? "" : ` ${s.prompt.value}${CURSOR}`}`
    : `${s.status.level === "error" ? "error: " : ""}${s.status.text}${undo}`;

  const lines: Array<Line> = [
    { text: `bye · ${title(s)}` },
    { text: "-".repeat(width) },
    ...body.slice(0, height),
  ];

  while (lines.length < height + 2) lines.push({ text: "" });
  lines.push({ text: status, selected: s.prompt !== null }, { text: HINTS[s.screen] });

  return lines.map((line) => {
    const text = fit(line.text, width);

    return o.color && line.selected ? `\u001b[7m${text.padEnd(width)}\u001b[27m` : text;
  });
};
