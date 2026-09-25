import { Effect } from "effect";
import type { CalTimeWire } from "@bye/contracts";
import { MAIL_VIEWS } from "@bye/domain";
import {
  calendar,
  calendarCommand,
  type CommandContext,
  type CommandSpec,
  del,
  flag,
  get,
  mailbox,
  mailCommand,
  post,
  required,
  scoped,
  UsageError,
} from "./args.ts";
import { INSTANCE_HELP } from "./instance.ts";
import { OPS_COMMANDS } from "./ops.ts";
import { UPLOAD_COMMANDS } from "./upload.ts";

// CLI command table (X02). Every write carries a fresh command ID so retries are idempotent
// and server audit logs attribute the action to this credential.

export {
  type CommandContext,
  type CommandSpec,
  type ParsedArgs,
  parseArgs,
  UsageError,
} from "./args.ts";

const recipients = (value: string | undefined) => addresses(value).map((address) => ({ address }));

/** Wall-clock time in an IANA zone (C03: stored with its original representation). */
const calTime = (local: string, tzid: string): CalTimeWire => {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/.exec(local);
  if (!m) throw new UsageError(`invalid local time ${local}`);
  const date = { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
  return m[4] === undefined
    ? { kind: "date", date }
    : {
        kind: "timed",
        tzid,
        local: { ...date, hour: Number(m[4]), minute: Number(m[5]), second: 0 },
      };
};

const DESTINATIONS = ["imbox", "feed", "paper-trail"] as const;
const destination = (value: string | undefined): (typeof DESTINATIONS)[number] => {
  if (value === undefined) return "imbox";
  if (!(DESTINATIONS as ReadonlyArray<string>).includes(value))
    throw new UsageError(`--to must be one of ${DESTINATIONS.join(", ")}`);
  return value as (typeof DESTINATIONS)[number];
};

const addresses = (value: string | undefined): Array<string> =>
  value === undefined
    ? []
    : value
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);

const threadIds = (ctx: CommandContext) => {
  if (ctx.args.positionals.length === 0) throw new UsageError("missing <threadId...>");
  return [...ctx.args.positionals];
};

/** One or more sender addresses; with none, reports the missing <address>. */
const senders = (ctx: CommandContext): ReadonlyArray<string> =>
  ctx.args.positionals.length > 0 ? ctx.args.positionals : [required(ctx, 0, "address")];

const localDate = (value: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) throw new UsageError(`invalid date ${value} (want YYYY-MM-DD)`);
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
};

const today = () => new Date().toLocaleDateString("en-CA");
const zone = (ctx: CommandContext) =>
  flag(ctx, "tz") ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

/** Web/native parity (X02): focus, batches, trash/spam, policies, send jobs, contacts, planning, feeds. */
const PARITY_COMMANDS: ReadonlyArray<CommandSpec> = [
  {
    path: ["mail", "focus"],
    summary: "Show the Focus & Reply queue",
    usage: "bye mail focus",
    run: (ctx) => scoped(ctx, "mailboxes", "/focus"),
  },
  {
    path: ["mail", "batch"],
    summary: "Create a reply batch from threads (or everything new for you)",
    usage: "bye mail batch (<threadId...> | --new)",
    run: (ctx) =>
      mailCommand(ctx, {
        _tag: "CreateBatch",
        threadIds: ctx.args.flags.new === true ? "new-for-you" : threadIds(ctx),
      }),
  },
  {
    path: ["mail", "batch", "show"],
    summary: "Show a reply batch",
    usage: "bye mail batch show <batchId>",
    run: (ctx) =>
      scoped(ctx, "mailboxes", `/batches/${encodeURIComponent(required(ctx, 0, "batchId"))}`),
  },
  {
    path: ["mail", "trash"],
    summary: "Move threads to Trash",
    usage: "bye mail trash <threadId...>",
    run: (ctx) => mailCommand(ctx, { _tag: "MoveToTrash", threadIds: threadIds(ctx) }),
  },
  {
    path: ["mail", "spam"],
    summary: "Mark threads as spam",
    usage: "bye mail spam <threadId...>",
    run: (ctx) => mailCommand(ctx, { _tag: "MarkSpam", threadIds: threadIds(ctx) }),
  },
  {
    path: ["mail", "restore"],
    summary: "Restore threads from Trash or Spam",
    usage: "bye mail restore <threadId...>",
    run: (ctx) => mailCommand(ctx, { _tag: "Restore", threadIds: threadIds(ctx) }),
  },
  {
    path: ["search", "recent"],
    summary: "List recent searches",
    usage: "bye search recent",
    run: (ctx) => scoped(ctx, "mailboxes", "/searches/recent"),
  },
  {
    path: ["policy", "list"],
    summary: "List sender and domain policies",
    usage: "bye policy list",
    run: (ctx) => scoped(ctx, "mailboxes", "/policies"),
  },
  {
    path: ["policy", "history"],
    summary: "Show policy change history",
    usage: "bye policy history [--limit n]",
    run: (ctx) => scoped(ctx, "mailboxes", "/policies/history", { limit: flag(ctx, "limit") }),
  },
  {
    path: ["policy", "clear"],
    summary: "Clear the policy for an address or domain",
    usage: "bye policy clear <address|domain> --yes",
    consequential: true,
    run: (ctx) => {
      const subject = required(ctx, 0, "subject");
      return mailCommand(ctx, {
        _tag: "SetPolicy",
        kind: subject.includes("@") ? "address" : "domain",
        subject,
        policy: null,
      });
    },
  },
  {
    path: ["policy", "revert"],
    summary: "Revert a policy change",
    usage: "bye policy revert <historyId>",
    run: (ctx) =>
      mailCommand(ctx, { _tag: "RevertPolicy", historyId: required(ctx, 0, "historyId") }),
  },
  {
    path: ["send", "list"],
    summary: "List send jobs and their per-recipient outcomes",
    usage: "bye send list [--limit n]",
    run: (ctx) => scoped(ctx, "mailboxes", "/send-jobs", { limit: flag(ctx, "limit") }),
  },
  {
    path: ["send", "show"],
    summary: "Show a send job's per-recipient outcomes",
    usage: "bye send show <sendJobId>",
    run: (ctx) =>
      scoped(ctx, "mailboxes", `/send-jobs/${encodeURIComponent(required(ctx, 0, "sendJobId"))}`),
  },
  {
    path: ["contacts", "list"],
    summary: "List contacts",
    usage: "bye contacts list [--q text]",
    run: (ctx) => scoped(ctx, "mailboxes", "/contacts", { q: flag(ctx, "q") }),
  },
  {
    path: ["contacts", "export"],
    summary: "Export contacts as vCard",
    usage: "bye contacts export > contacts.vcf",
    run: (ctx) => scoped(ctx, "mailboxes", "/contacts/export.vcf"),
  },
  {
    path: ["cal", "agenda"],
    summary: "Agenda for the next days",
    usage: "bye cal agenda [--from YYYY-MM-DD] [--days n] [--tz <IANA>]",
    run: (ctx) =>
      scoped(ctx, "calendars", "/agenda", {
        from: flag(ctx, "from") ?? today(),
        days: flag(ctx, "days"),
        tz: zone(ctx),
      }),
  },
  {
    path: ["cal", "year"],
    summary: "Year view: event counts per day",
    usage: "bye cal year [year]",
    run: (ctx) =>
      scoped(ctx, "calendars", `/year/${ctx.args.positionals[0] ?? new Date().getFullYear()}`, {
        tz: zone(ctx),
      }),
  },
  {
    path: ["cal", "tasks"],
    summary: "Sometime-this-week tasks",
    usage: "bye cal tasks [--date YYYY-MM-DD] [--first-weekday 0-6]",
    run: (ctx) =>
      scoped(ctx, "calendars", "/week-tasks", {
        date: flag(ctx, "date") ?? today(),
        firstWeekday: flag(ctx, "first-weekday"),
      }),
  },
  {
    path: ["cal", "task", "add"],
    summary: "Add a task to a week",
    usage: "bye cal task add <title...> [--date YYYY-MM-DD]",
    run: (ctx) => {
      const title = ctx.args.positionals.join(" ").trim();
      if (!title) throw new UsageError("missing <title>");
      return calendarCommand(ctx, {
        type: "AddWeekTask",
        date: localDate(flag(ctx, "date") ?? today()),
        firstWeekday: Number(flag(ctx, "first-weekday") ?? 1),
        title,
      });
    },
  },
  {
    path: ["cal", "task", "done"],
    summary: "Complete (or reopen) a week task",
    usage: "bye cal task done <taskId> [--off]",
    run: (ctx) =>
      calendarCommand(ctx, {
        type: "CompleteWeekTask",
        taskId: required(ctx, 0, "taskId"),
        completed: ctx.args.flags.off !== true,
      }),
  },
  {
    path: ["cal", "timer"],
    summary: "Show the active timer",
    usage: "bye cal timer",
    run: (ctx) => scoped(ctx, "calendars", "/timer"),
  },
  {
    path: ["cal", "timer", "start"],
    summary: "Start the timer (stops any running one)",
    usage: "bye cal timer start <label...>",
    run: (ctx) =>
      calendarCommand(ctx, {
        type: "StartTimer",
        label: ctx.args.positionals.join(" ").trim() || "Focus",
      }),
  },
  {
    path: ["cal", "timer", "stop"],
    summary: "Stop the active timer",
    usage: "bye cal timer stop",
    run: (ctx) => calendarCommand(ctx, { type: "StopTimer" }),
  },
  {
    path: ["cal", "feeds"],
    summary: "List private calendar feed tokens",
    usage: "bye cal feeds",
    run: (ctx) => scoped(ctx, "calendars", "/feed-tokens"),
  },
  {
    path: ["cal", "feeds", "create"],
    summary: "Create a private .ics feed URL (shown once)",
    usage: "bye cal feeds create [--label text] [--calendars id,id] --yes",
    consequential: true,
    run: (ctx) =>
      Effect.gen(function* () {
        const id = yield* calendar(ctx);
        const calendarIds = addresses(flag(ctx, "calendars"));
        return yield* post(`/v1/calendars/${id}/feed-tokens`, {
          schemaVersion: 1,
          commandId: ctx.newCommandId(),
          calendarIds: calendarIds.length > 0 ? calendarIds : [id],
          label: flag(ctx, "label") ?? "CLI",
        });
      }),
  },
  {
    path: ["cal", "feeds", "revoke"],
    summary: "Revoke a calendar feed token",
    usage: "bye cal feeds revoke <tokenHash> --yes",
    consequential: true,
    run: (ctx) =>
      Effect.gen(function* () {
        const id = yield* calendar(ctx);
        return yield* del(
          `/v1/calendars/${id}/feed-tokens/${encodeURIComponent(required(ctx, 0, "tokenHash"))}`,
          { commandId: ctx.newCommandId() },
        );
      }),
  },
];

export const COMMANDS: ReadonlyArray<CommandSpec> = [
  {
    path: ["whoami"],
    summary: "Show the authenticated principal and credential scopes",
    usage: "bye whoami",
    run: () => get("/v1/me"),
  },
  {
    path: ["mail", "view"],
    summary: "List a mailbox view",
    usage: `bye mail view <${MAIL_VIEWS.join("|")}> [--limit n] [--cursor c]`,
    run: (ctx) =>
      Effect.gen(function* () {
        const view = required(ctx, 0, "view");
        if (!(MAIL_VIEWS as ReadonlyArray<string>).includes(view))
          throw new UsageError(`unknown view ${view}`);
        const id = yield* mailbox(ctx);
        return yield* get(`/v1/mailboxes/${id}/views/${view}`, {
          limit: flag(ctx, "limit"),
          cursor: flag(ctx, "cursor"),
        });
      }),
  },
  {
    path: ["mail", "show"],
    summary: "Show a thread",
    usage: "bye mail show <threadId>",
    run: (ctx) => scoped(ctx, "mailboxes", `/threads/${required(ctx, 0, "threadId")}`),
  },
  {
    path: ["mail", "seen"],
    summary: "Mark a thread seen up to its current revision",
    usage: "bye mail seen <threadId> --revision n",
    run: (ctx) =>
      mailCommand(ctx, {
        _tag: "MarkSeen",
        threadId: required(ctx, 0, "threadId"),
        observedRevision: Number(flag(ctx, "revision") ?? 0),
      }),
  },
  {
    path: ["mail", "reply-later"],
    summary: "Add or remove a thread from Reply Later",
    usage: "bye mail reply-later <threadId> [--off]",
    run: (ctx) =>
      mailCommand(ctx, {
        _tag: "SetAttention",
        flag: "replyLater",
        threadId: required(ctx, 0, "threadId"),
        on: ctx.args.flags.off !== true,
      }),
  },
  {
    path: ["mail", "set-aside"],
    summary: "Add or remove a thread from Set Aside",
    usage: "bye mail set-aside <threadId> [--off]",
    run: (ctx) =>
      mailCommand(ctx, {
        _tag: "SetAttention",
        flag: "setAside",
        threadId: required(ctx, 0, "threadId"),
        on: ctx.args.flags.off !== true,
      }),
  },
  {
    path: ["mail", "bubble"],
    summary: "Bubble a thread up at a time (ISO-8601) or pin it now",
    usage: "bye mail bubble <threadId> (--at <iso> | --pin | --off)",
    run: (ctx) => {
      const threadId = required(ctx, 0, "threadId");
      if (ctx.args.flags.off === true) return mailCommand(ctx, { _tag: "ClearBubble", threadId });
      if (ctx.args.flags.pin !== undefined)
        return mailCommand(ctx, { _tag: "PinBubble", threadId });
      const at = flag(ctx, "at");
      if (!at || Number.isNaN(Date.parse(at)))
        throw new UsageError("--at must be an ISO-8601 time");
      return mailCommand(ctx, { _tag: "BubbleUp", threadId, at: Date.parse(at) });
    },
  },
  {
    path: ["screen", "list"],
    summary: "List senders waiting in the Screener",
    usage: "bye screen list",
    run: (ctx) => scoped(ctx, "mailboxes", "/views/screener"),
  },
  {
    path: ["screen", "approve"],
    summary: "Approve senders (optionally into feed or paper-trail)",
    usage: "bye screen approve <address...> [--to imbox|feed|paper-trail] [--seen]",
    consequential: true,
    run: (ctx) =>
      mailCommand(ctx, {
        _tag: "Screen",
        decisions: senders(ctx).map((sender) => ({
          sender,
          decision: "allow",
          destination: destination(flag(ctx, "to")),
          asSeen: ctx.args.flags.seen === true,
        })),
      }),
  },
  {
    path: ["screen", "reject"],
    summary: "Screen out senders",
    usage: "bye screen reject <address...>",
    consequential: true,
    run: (ctx) =>
      mailCommand(ctx, {
        _tag: "Screen",
        decisions: senders(ctx).map((sender) => ({ sender, decision: "block" })),
      }),
  },
  {
    path: ["search"],
    summary: "Search mail, contacts, notes, clips and files",
    usage:
      'bye search <query> (supports "phrases", -exclude, from:, to:, label:, in:, has:attachment, before:, after:)',
    run: (ctx) =>
      Effect.gen(function* () {
        const q = ctx.args.positionals.join(" ");
        if (q.trim().length === 0) throw new UsageError("missing <query>");
        return yield* scoped(ctx, "mailboxes", "/search", { q, limit: flag(ctx, "limit") });
      }),
  },
  {
    path: ["draft", "create"],
    summary: "Create a draft",
    usage:
      "bye draft create --to a@x,b@y [--cc ..] [--bcc ..] --subject s --body text [--reply-to-thread id]",
    run: (ctx) =>
      Effect.gen(function* () {
        const id = yield* mailbox(ctx);
        return yield* post("/v1/drafts", {
          commandId: ctx.newCommandId(),
          mailboxId: id,
          threadId: flag(ctx, "reply-to-thread"),
          content: {
            to: recipients(flag(ctx, "to")),
            cc: recipients(flag(ctx, "cc")),
            bcc: recipients(flag(ctx, "bcc")),
            subject: flag(ctx, "subject") ?? "",
            text: flag(ctx, "body") ?? "",
            attachments: [],
          },
        });
      }),
  },
  {
    path: ["draft", "send"],
    summary: "Send a draft (returns a send-job ID, not a delivery guarantee)",
    usage: "bye draft send <draftId> --revision n [--at <iso>] --yes",
    consequential: true,
    run: (ctx) =>
      Effect.gen(function* () {
        const draftId = required(ctx, 0, "draftId");
        const id = yield* mailbox(ctx);
        const at = flag(ctx, "at");
        return yield* post(`/v1/drafts/${draftId}/send`, {
          commandId: ctx.newCommandId(),
          mailboxId: id,
          revision: Number(flag(ctx, "revision") ?? 0),
          sendAt: at === undefined ? undefined : Date.parse(at),
        });
      }),
  },
  {
    path: ["send", "cancel"],
    summary: "Cancel a pending send (may report too-late)",
    usage: "bye send cancel <sendJobId>",
    run: (ctx) =>
      Effect.gen(function* () {
        const jobId = required(ctx, 0, "sendJobId");
        const id = yield* mailbox(ctx);
        return yield* post(`/v1/send-jobs/${jobId}/cancel`, {
          commandId: ctx.newCommandId(),
          mailboxId: id,
        });
      }),
  },
  {
    path: ["workflow", "create"],
    summary: "Create a workflow board with ordered stages",
    usage: "bye workflow create <name> --stages a,b,c",
    run: (ctx) =>
      mailCommand(ctx, {
        _tag: "CreateBoard",
        name: required(ctx, 0, "name"),
        stages: addresses(flag(ctx, "stages")),
      }),
  },
  {
    path: ["workflow", "add"],
    summary: "Add a thread to a workflow board",
    usage: "bye workflow add <boardId> <threadId>",
    run: (ctx) =>
      mailCommand(ctx, {
        _tag: "AddToBoard",
        boardId: required(ctx, 0, "boardId"),
        threadId: required(ctx, 1, "threadId"),
      }),
  },
  {
    path: ["workflow", "move"],
    summary: "Move a card to a stage",
    usage: "bye workflow move <cardId> <stageId> [--position n]",
    run: (ctx) =>
      mailCommand(ctx, {
        _tag: "MoveCard",
        cardId: required(ctx, 0, "cardId"),
        stageId: required(ctx, 1, "stageId"),
        position: Number(flag(ctx, "position") ?? 0),
      }),
  },
  {
    path: ["cal", "events"],
    summary: "List calendar occurrences in a window",
    usage: "bye cal events [--from <iso>] [--to <iso>]",
    run: (ctx) =>
      Effect.gen(function* () {
        const from = flag(ctx, "from") ?? new Date().toISOString();
        const to = flag(ctx, "to") ?? new Date(Date.parse(from) + 7 * 86_400_000).toISOString();
        return yield* scoped(ctx, "calendars", "/events", { from, to, tz: flag(ctx, "tz") });
      }),
  },
  {
    path: ["cal", "add"],
    summary: "Create a calendar event",
    usage:
      "bye cal add --calendar-id <id> --title t --start 2026-10-01T09:00 --end 2026-10-01T10:00 [--tz <IANA>]",
    run: (ctx) => {
      const title = flag(ctx, "title");
      const start = flag(ctx, "start");
      const end = flag(ctx, "end");
      const calendarId = flag(ctx, "calendar-id");
      if (!title || !start || !end || !calendarId)
        throw new UsageError("--calendar-id, --title, --start and --end are required");
      const tzid = zone(ctx);
      return calendarCommand(ctx, {
        type: "CreateEvent",
        calendarId,
        data: { summary: title },
        start: calTime(start, tzid),
        end: calTime(end, tzid),
      });
    },
  },
  {
    path: ["cal", "search"],
    summary: "Search events, tasks, journal, tracked time and day labels",
    usage: "bye cal search <query>",
    run: (ctx) => scoped(ctx, "calendars", "/search", { q: ctx.args.positionals.join(" ") }),
  },
  ...PARITY_COMMANDS,
  ...OPS_COMMANDS,
  ...UPLOAD_COMMANDS,
];

export const findCommand = (
  positionals: ReadonlyArray<string>,
): { spec: CommandSpec; rest: ReadonlyArray<string> } | undefined => {
  const sorted = [...COMMANDS].sort((a, b) => b.path.length - a.path.length);
  for (const spec of sorted) {
    if (spec.path.every((segment, i) => positionals[i] === segment))
      return { spec, rest: positionals.slice(spec.path.length) };
  }
  return undefined;
};

export const helpText = (): string =>
  [
    "bye — mail and calendar from the terminal",
    "",
    "Global flags: --json (machine-readable output), --yes (confirm consequential actions), --mailbox id, --calendar id",
    "",
    ...COMMANDS.map(
      (c) => `  ${c.usage}\n      ${c.summary}${c.consequential ? " [requires --yes]" : ""}`,
    ),
    ...INSTANCE_HELP,
    "  bye tui",
    "",
    "Exit codes: 0 ok, 1 failure, 2 usage, 3 unauthenticated, 4 forbidden, 5 not found, 6 conflict/too-late, 7 rate limited, 8 unavailable",
  ].join("\n");
