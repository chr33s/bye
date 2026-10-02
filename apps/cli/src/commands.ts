import { Effect, type Layer, Option } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import type { CalTimeWire, MailDraftContent } from "@bye/contracts";
import { MAIL_VIEWS } from "@bye/domain";
import {
  AFTER_SEND_CHOICES,
  type AfterSendChoice,
  afterSendFor,
} from "@bye/native-shared/after-send";
import {
  action,
  bool,
  calendar,
  calendarCommand,
  commandId,
  del,
  execute,
  get,
  group,
  instant,
  mailbox,
  mailCommand,
  opt,
  optInt,
  patch,
  post,
  root,
  scoped,
  UsageError,
} from "./args.ts";
import type { CliApi } from "./client.ts";
import type { JsonValue } from "./json.ts";
import { OPS_COMMANDS } from "./ops.ts";
import { UPLOAD_COMMANDS } from "./upload.ts";

// CLI command tree (X02), parsed by effect/cli. Every write carries a fresh command ID
// so retries are idempotent and server audit logs attribute the action to this credential.

export { UsageError } from "./args.ts";

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

const addresses = (value: string | undefined): Array<string> =>
  value === undefined
    ? []
    : value
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

const localDate = (value: string) => {
  const m = DATE.exec(value)!;

  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
};

const invalidDate = (value: string) => `invalid date ${value} (want YYYY-MM-DD)`;

/** An optional YYYY-MM-DD flag. */
const dateFlag = (name: string) =>
  opt(name).pipe(
    Flag.filter(
      (value) => value === undefined || DATE.test(value),
      (v) => invalidDate(v!),
    ),
  );

const threadIds = Argument.String("threadId").pipe(Argument.variadic({ min: 1 }));

/** Free text from the remaining arguments (put words that start with `-` after `--`). */
const words = (name: string, min = 0) => Argument.String(name).pipe(Argument.variadic({ min }));

const today = () => new Date().toLocaleDateString("en-CA");

const zone = (tz: string | undefined) => tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

const PARTSTATS = { accept: "ACCEPTED", tentative: "TENTATIVE", decline: "DECLINED" } as const;

/** Earlier names for the follow-up choices, still accepted by `--after`. */
const LEGACY_AFTER_SEND = new Map<string, AfterSendChoice>([
  ["bubble", "follow-up"],
  ["bubble-no-reply", "follow-up-if-no-reply"],
]);

// Flag.Literals needs a non-empty tuple; both sources are static and non-empty.
const literals = (values: ReadonlyArray<string>): readonly [string, ...Array<string>] => {
  const [first = "", ...rest] = values;

  return [first, ...rest];
};

const AFTER_SEND = literals([
  ...AFTER_SEND_CHOICES.map((c) => c.value),
  ...LEGACY_AFTER_SEND.keys(),
]);

const mail = group("mail", "Mail views, threads and triage", [
  action(
    "view",
    { summary: "List a mailbox view" },
    {
      view: Argument.Literals("view", literals(MAIL_VIEWS)),
      limit: optInt("limit"),
      cursor: opt("cursor"),
    },
    ({ view, limit, cursor }) => scoped("mailboxes", `/views/${view}`, { limit, cursor }),
  ),
  action(
    "show",
    { summary: "Show a thread" },
    { threadId: Argument.String("threadId") },
    ({ threadId }) => scoped("mailboxes", `/threads/${encodeURIComponent(threadId)}`),
  ),
  action(
    "text",
    {
      summary: "Show one message's body as plain text (HTML-only mail is converted by the server)",
    },
    { deliveryId: Argument.String("deliveryId") },
    ({ deliveryId }) => scoped("mailboxes", `/deliveries/${encodeURIComponent(deliveryId)}/text`),
  ),
  action(
    "seen",
    { summary: "Mark a thread seen up to its current revision" },
    {
      threadId: Argument.String("threadId"),
      revision: Flag.Int("revision").pipe(Flag.withDefault(0)),
    },
    ({ threadId, revision }) =>
      mailCommand({ _tag: "MarkSeen", threadId, observedRevision: revision }),
  ),
  action(
    "reply-later",
    { summary: "Add or remove a thread from Reply Later" },
    { threadId: Argument.String("threadId"), off: bool("off") },
    ({ threadId, off }) =>
      mailCommand({ _tag: "SetAttention", flag: "replyLater", threadId, on: !off }),
  ),
  action(
    "set-aside",
    { summary: "Add or remove a thread from Set Aside" },
    { threadId: Argument.String("threadId"), off: bool("off") },
    ({ threadId, off }) =>
      mailCommand({ _tag: "SetAttention", flag: "setAside", threadId, on: !off }),
  ),
  action(
    "follow-up",
    {
      summary:
        "Follow up on a thread at a time (--at ISO-8601, optionally --if-no-reply), pin it now, bring it back now (--pop), or clear it (--off)",
    },
    {
      threadId: Argument.String("threadId"),
      at: instant("at"),
      ifNoReply: bool("if-no-reply"),
      pin: bool("pin"),
      pop: bool("pop"),
      off: bool("off"),
    },
    ({ threadId, at, ifNoReply, pin, pop, off }) => {
      if (off) return mailCommand({ _tag: "ClearBubble", threadId });

      if (pop) return mailCommand({ _tag: "PopBubble", threadId });

      if (pin) return mailCommand({ _tag: "PinBubble", threadId });

      if (at === undefined)
        return Effect.fail(
          new UsageError("pass --at <iso> [--if-no-reply], --pin, --pop or --off"),
        );

      if (ifNoReply)
        return mailCommand({ _tag: "BubbleUp", threadId, at, condition: "if-no-reply" });

      return mailCommand({ _tag: "BubbleUp", threadId, at });
    },
    // `bubble` was this command's first name; scripts that use it keep working.
  ).pipe(Command.withAlias("bubble")),
  action("focus", { summary: "Show the reply queue" }, {}, () => scoped("mailboxes", "/focus")),
  action(
    "batch",
    { summary: "Create a reply batch from threads (or --new: everything new for you)" },
    { threadIds: Argument.String("threadId").pipe(Argument.variadic()), fresh: bool("new") },
    ({ threadIds, fresh }) =>
      fresh || threadIds.length > 0
        ? mailCommand({ _tag: "CreateBatch", threadIds: fresh ? "new-for-you" : [...threadIds] })
        : Effect.fail(new UsageError("missing <threadId...> (or pass --new)")),
  ).pipe(
    Command.withSubcommands([
      action(
        "show",
        { summary: "Show a reply batch" },
        { batchId: Argument.String("batchId") },
        ({ batchId }) => scoped("mailboxes", `/batches/${encodeURIComponent(batchId)}`),
      ),
    ]),
  ),
  action("trash", { summary: "Move threads to Trash" }, { threadIds }, ({ threadIds }) =>
    mailCommand({ _tag: "MoveToTrash", threadIds: [...threadIds] }),
  ),
  action("spam", { summary: "Mark threads as spam" }, { threadIds }, ({ threadIds }) =>
    mailCommand({ _tag: "MarkSpam", threadIds: [...threadIds] }),
  ),
  action(
    "restore",
    { summary: "Restore threads from Trash or Spam" },
    { threadIds },
    ({ threadIds }) => mailCommand({ _tag: "Restore", threadIds: [...threadIds] }),
  ),
]);

const DESTINATIONS = ["imbox", "feed", "paper-trail"] as const;

const senders = Argument.String("address").pipe(Argument.variadic({ min: 1 }));

const screen = group("screen", "New senders: first-time senders waiting for approval", [
  action("list", { summary: "List first-time senders waiting for approval" }, {}, () =>
    scoped("mailboxes", "/views/screener"),
  ),
  action(
    "approve",
    { summary: "Approve senders (optionally into feed or paper-trail)", consequential: true },
    {
      senders,
      to: Flag.Literals("to", DESTINATIONS).pipe(Flag.withDefault("imbox" as const)),
      seen: bool("seen"),
    },
    ({ senders, to, seen }) =>
      mailCommand({
        _tag: "Screen",
        decisions: senders.map((sender) => ({
          sender,
          decision: "allow",
          destination: to,
          asSeen: seen,
        })),
      }),
  ),
  action(
    "reject",
    { summary: "Screen out senders", consequential: true },
    { senders },
    ({ senders }) =>
      mailCommand({
        _tag: "Screen",
        decisions: senders.map((sender) => ({ sender, decision: "block" })),
      }),
  ),
]);

const search = action(
  "search",
  {
    summary:
      'Search mail, contacts, notes, clips and files (supports "phrases", -exclude, from:, to:, label:, in:, has:attachment, before:, after:; put -terms after --)',
  },
  { query: words("query", 1), limit: optInt("limit") },
  ({ query, limit }) => {
    const q = query.join(" ");

    return q.trim().length === 0
      ? Effect.fail(new UsageError("missing <query>"))
      : scoped("mailboxes", "/search", { q, limit });
  },
).pipe(
  Command.withSubcommands([
    action("recent", { summary: "List recent searches" }, {}, () =>
      scoped("mailboxes", "/searches/recent"),
    ),
  ]),
);

const REPLY_MODES = ["reply", "reply-all", "forward"] as const;

const draft = group("draft", "Drafts: compose, reply and send", [
  action(
    "create",
    { summary: "Create a draft" },
    {
      to: opt("to"),
      cc: opt("cc"),
      bcc: opt("bcc"),
      subject: opt("subject"),
      body: opt("body"),
      replyToThread: opt("reply-to-thread"),
    },
    (input) =>
      Effect.gen(function* () {
        const id = yield* mailbox;

        return yield* post("/v1/drafts", {
          commandId: yield* commandId,
          mailboxId: id,
          threadId: input.replyToThread,
          content: {
            to: recipients(input.to),
            cc: recipients(input.cc),
            bcc: recipients(input.bcc),
            subject: input.subject ?? "",
            text: input.body ?? "",
            attachments: [],
          },
        });
      }),
  ),
  action(
    "send",
    {
      summary: "Send a draft (returns a send-job ID, not a delivery guarantee)",
      consequential: true,
    },
    {
      draftId: Argument.String("draftId"),
      revision: Flag.Int("revision").pipe(Flag.withDefault(0)),
      at: instant("at"),
      after: Flag.Literals("after", AFTER_SEND).pipe(Flag.withDefault("none")),
    },
    ({ draftId, revision, at, after }) =>
      Effect.gen(function* () {
        const id = yield* mailbox;

        // Follow-ups (bubble in a day) count from when the message goes out, not from now.
        const afterSend = afterSendFor(
          LEGACY_AFTER_SEND.get(after) ?? (after as AfterSendChoice),
          at ?? Date.now(),
        );

        const body = {
          commandId: yield* commandId,
          mailboxId: id,
          revision,
          sendAt: at,
          afterSend: afterSend || undefined,
        };

        return yield* post(`/v1/drafts/${encodeURIComponent(draftId)}/send`, body);
      }),
  ),
  action(
    "reply",
    { summary: "Create a reply, reply-all or forward draft (addressed and quoted by the server)" },
    {
      threadId: Argument.String("threadId"),
      mode: Flag.Literals("mode", REPLY_MODES).pipe(Flag.withDefault("reply" as const)),
    },
    ({ threadId, mode }) => mailCommand({ _tag: "CreateReplyDraft", threadId, mode }),
  ),
  action(
    "show",
    { summary: "Show a draft's revision and content" },
    { draftId: Argument.String("draftId") },
    ({ draftId }) => scoped("mailboxes", `/drafts/${encodeURIComponent(draftId)}`),
  ),
  action(
    "save",
    {
      summary:
        "Change a draft's recipients, subject or body; other fields (threading, files) are kept",
    },
    {
      draftId: Argument.String("draftId"),
      revision: optInt("revision"),
      to: opt("to"),
      cc: opt("cc"),
      bcc: opt("bcc"),
      subject: opt("subject"),
      body: opt("body"),
    },
    (input) =>
      Effect.gen(function* () {
        const draftId = encodeURIComponent(input.draftId);
        const id = yield* mailbox;

        const current = (yield* get(
          `/v1/mailboxes/${encodeURIComponent(id)}/drafts/${draftId}`,
        )) as {
          readonly revision: number;
          readonly content: MailDraftContent;
        };

        // A new plain-text body replaces any HTML alternative, so the two never disagree.
        const replacesBody = input.body !== undefined;

        const content = {
          ...current.content,
          ...Object.fromEntries(
            (["to", "cc", "bcc"] as const).flatMap((key) =>
              input[key] === undefined ? [] : [[key, recipients(input[key])]],
            ),
          ),
          subject: input.subject ?? current.content.subject,
          text: replacesBody ? input.body : current.content.text,
          html: replacesBody ? undefined : current.content.html,
        };

        return yield* patch(`/v1/drafts/${draftId}`, {
          commandId: yield* commandId,
          mailboxId: id,
          expectedRevision: input.revision ?? current.revision,
          content,
        });
      }),
  ),
]);

const send = group("send", "Send jobs and their per-recipient outcomes", [
  action(
    "cancel",
    { summary: "Cancel a pending send (may report too-late)" },
    { sendJobId: Argument.String("sendJobId") },
    ({ sendJobId }) =>
      Effect.gen(function* () {
        const id = yield* mailbox;

        return yield* post(`/v1/send-jobs/${encodeURIComponent(sendJobId)}/cancel`, {
          commandId: yield* commandId,
          mailboxId: id,
        });
      }),
  ),
  action(
    "list",
    { summary: "List send jobs and their per-recipient outcomes" },
    { limit: optInt("limit") },
    ({ limit }) => scoped("mailboxes", "/send-jobs", { limit }),
  ),
  action(
    "show",
    { summary: "Show a send job's per-recipient outcomes" },
    { sendJobId: Argument.String("sendJobId") },
    ({ sendJobId }) => scoped("mailboxes", `/send-jobs/${encodeURIComponent(sendJobId)}`),
  ),
]);

const workflow = group("workflow", "Workflow boards", [
  action(
    "create",
    { summary: "Create a workflow board with ordered stages (--stages a,b,c)" },
    { name: Argument.String("name"), stages: opt("stages") },
    ({ name, stages }) => mailCommand({ _tag: "CreateBoard", name, stages: addresses(stages) }),
  ),
  action(
    "add",
    { summary: "Add a thread to a workflow board" },
    { boardId: Argument.String("boardId"), threadId: Argument.String("threadId") },
    ({ boardId, threadId }) => mailCommand({ _tag: "AddToBoard", boardId, threadId }),
  ),
  action(
    "move",
    { summary: "Move a card to a stage" },
    {
      cardId: Argument.String("cardId"),
      stageId: Argument.String("stageId"),
      position: Flag.Int("position").pipe(Flag.withDefault(0)),
    },
    ({ cardId, stageId, position }) => mailCommand({ _tag: "MoveCard", cardId, stageId, position }),
  ),
]);

const policy = group("policy", "Sender and domain policies", [
  action("list", { summary: "List sender and domain policies" }, {}, () =>
    scoped("mailboxes", "/policies"),
  ),
  action(
    "history",
    { summary: "Show policy change history" },
    { limit: optInt("limit") },
    ({ limit }) => scoped("mailboxes", "/policies/history", { limit }),
  ),
  action(
    "clear",
    { summary: "Clear the policy for an address or domain", consequential: true },
    { subject: Argument.String("address|domain") },
    ({ subject }) =>
      mailCommand({
        _tag: "SetPolicy",
        kind: subject.includes("@") ? "address" : "domain",
        subject,
        policy: null,
      }),
  ),
  action(
    "revert",
    { summary: "Revert a policy change" },
    { historyId: Argument.String("historyId") },
    ({ historyId }) => mailCommand({ _tag: "RevertPolicy", historyId }),
  ),
]);

const contacts = group("contacts", "Contacts", [
  action("list", { summary: "List contacts" }, { q: opt("q") }, ({ q }) =>
    scoped("mailboxes", "/contacts", { q }),
  ),
  action(
    "export",
    { summary: "Export contacts as vCard (bye contacts export > contacts.vcf)" },
    {},
    () => scoped("mailboxes", "/contacts/export.vcf"),
  ),
]);

const SCOPES = ["this", "future", "series"] as const;

const cal = group("cal", "Calendar: events, planning, timer and feeds", [
  action(
    "events",
    { summary: "List calendar occurrences in a window (default: the next 7 days)" },
    { from: instant("from"), to: instant("to"), tz: opt("tz") },
    (input) => {
      const start = input.from ?? Date.now();
      const from = new Date(start).toISOString();
      const to = new Date(input.to ?? start + 7 * 86_400_000).toISOString();

      return scoped("calendars", "/events", { from, to, tz: input.tz });
    },
  ),
  action(
    "add",
    { summary: "Create a calendar event (--start/--end as 2026-10-01T09:00 or 2026-10-01)" },
    {
      calendarId: Flag.String("calendar-id"),
      title: Flag.String("title"),
      start: Flag.String("start"),
      end: Flag.String("end"),
      location: opt("location"),
      tz: opt("tz"),
    },
    (input) =>
      Effect.suspend(() => {
        const tzid = zone(input.tz);
        const data = { summary: input.title, location: input.location || undefined };

        return calendarCommand({
          type: "CreateEvent",
          calendarId: input.calendarId,
          data,
          start: calTime(input.start, tzid),
          end: calTime(input.end, tzid),
        });
      }),
  ),
  action(
    "search",
    { summary: "Search events, tasks, journal, tracked time and day labels" },
    { query: words("query") },
    ({ query }) => scoped("calendars", "/search", { q: query.join(" ") }),
  ),
  action(
    "agenda",
    { summary: "Agenda for the next days" },
    { from: dateFlag("from"), days: optInt("days"), tz: opt("tz") },
    ({ from, days, tz }) =>
      scoped("calendars", "/agenda", { from: from ?? today(), days, tz: zone(tz) }),
  ),
  action(
    "year",
    { summary: "Year view: event counts per day" },
    { year: Argument.Int("year").pipe(Argument.optional), tz: opt("tz") },
    ({ year, tz }) =>
      scoped("calendars", `/year/${Option.getOrElse(year, () => new Date().getFullYear())}`, {
        tz: zone(tz),
      }),
  ),
  action(
    "tasks",
    { summary: "Sometime-this-week tasks" },
    { date: dateFlag("date"), firstWeekday: optInt("first-weekday") },
    ({ date, firstWeekday }) =>
      scoped("calendars", "/week-tasks", { date: date ?? today(), firstWeekday }),
  ),
  group("task", "Sometime-this-week tasks", [
    action(
      "add",
      { summary: "Add a task to a week" },
      {
        title: words("title", 1),
        date: dateFlag("date"),
        firstWeekday: Flag.Int("first-weekday").pipe(Flag.withDefault(1)),
      },
      ({ title, date, firstWeekday }) => {
        const text = title.join(" ").trim();

        return text
          ? calendarCommand({
              type: "AddWeekTask",
              date: localDate(date ?? today()),
              firstWeekday,
              title: text,
            })
          : Effect.fail(new UsageError("missing <title>"));
      },
    ),
    action(
      "done",
      { summary: "Complete (or with --off, reopen) a week task" },
      { taskId: Argument.String("taskId"), off: bool("off") },
      ({ taskId, off }) => calendarCommand({ type: "CompleteWeekTask", taskId, completed: !off }),
    ),
  ]),
  action("timer", { summary: "Show the active timer" }, {}, () =>
    scoped("calendars", "/timer"),
  ).pipe(
    Command.withSubcommands([
      action(
        "start",
        { summary: "Start the timer (stops any running one)" },
        { label: words("label") },
        ({ label }) =>
          calendarCommand({ type: "StartTimer", label: label.join(" ").trim() || "Focus" }),
      ),
      action("stop", { summary: "Stop the active timer" }, {}, () =>
        calendarCommand({ type: "StopTimer" }),
      ),
    ]),
  ),
  action("feeds", { summary: "List private calendar feed tokens" }, {}, () =>
    scoped("calendars", "/feed-tokens"),
  ).pipe(
    Command.withSubcommands([
      action(
        "create",
        { summary: "Create a private .ics feed URL (shown once)", consequential: true },
        { label: opt("label"), calendars: opt("calendars") },
        ({ label, calendars }) =>
          Effect.gen(function* () {
            const id = yield* calendar;
            const calendarIds = addresses(calendars);

            return yield* post(`/v1/calendars/${encodeURIComponent(id)}/feed-tokens`, {
              schemaVersion: 1,
              commandId: yield* commandId,
              calendarIds: calendarIds.length > 0 ? calendarIds : [id],
              label: label ?? "CLI",
            });
          }),
      ),
      action(
        "revoke",
        { summary: "Revoke a calendar feed token", consequential: true },
        { tokenHash: Argument.String("tokenHash") },
        ({ tokenHash }) =>
          Effect.gen(function* () {
            const id = yield* calendar;

            return yield* del(
              `/v1/calendars/${encodeURIComponent(id)}/feed-tokens/${encodeURIComponent(tokenHash)}`,
              {
                commandId: yield* commandId,
              },
            );
          }),
      ),
    ]),
  ),
  action("calendars", { summary: "List the calendars in the selected space" }, {}, () =>
    scoped("calendars", "/calendars"),
  ),
  action(
    "day",
    { summary: "Day view: occurrences and day context (default: today)" },
    {
      date: Argument.String("date").pipe(
        Argument.filter((value) => DATE.test(value), invalidDate),
        Argument.optional,
      ),
      tz: opt("tz"),
    },
    ({ date, tz }) =>
      scoped("calendars", `/day/${Option.getOrElse(date, today)}`, { tz: zone(tz) }),
  ),
  action(
    "respond",
    { summary: "Accept, tentatively accept or decline an invitation (replies to the organizer)" },
    {
      eventId: Argument.String("eventId"),
      answer: Argument.Literals("answer", ["accept", "tentative", "decline"]),
      occurrence: opt("occurrence"),
    },
    ({ eventId, answer, occurrence }) =>
      occurrence
        ? calendarCommand({
            type: "RespondInvitation",
            eventId,
            partstat: PARTSTATS[answer],
            occurrenceKey: occurrence,
          })
        : calendarCommand({ type: "RespondInvitation", eventId, partstat: PARTSTATS[answer] }),
  ),
  action(
    "edit",
    { summary: "Edit an event (only the given fields change)" },
    {
      eventId: Argument.String("eventId"),
      revision: Flag.Int("revision"),
      scope: Flag.Literals("scope", SCOPES).pipe(Flag.withDefault("series" as const)),
      occurrence: opt("occurrence"),
      title: opt("title"),
      start: opt("start"),
      end: opt("end"),
      location: opt("location"),
      tz: opt("tz"),
    },
    (input) =>
      Effect.suspend(() => {
        const data = { summary: input.title, location: input.location };
        const hasData = data.summary !== undefined || data.location !== undefined;

        const changes = {
          start: input.start === undefined ? undefined : calTime(input.start, zone(input.tz)),
          end: input.end === undefined ? undefined : calTime(input.end, zone(input.tz)),
          data: hasData ? data : undefined,
        };

        const update = {
          type: "UpdateEvent" as const,
          eventId: input.eventId,
          expectedRevision: input.revision,
          scope: input.scope,
          changes,
        };

        // For the whole series the occurrence anchors the times: the series moves by the same amount.
        return calendarCommand(
          input.occurrence ? { ...update, occurrenceKey: input.occurrence } : update,
        );
      }),
  ),
]);

/** Every command that calls the API; `bye tui` sends exactly these. */
export const COMMANDS: ReadonlyArray<Command.Command.Any> = [
  action("whoami", { summary: "Show the authenticated principal and credential scopes" }, {}, () =>
    get("/v1/me"),
  ),
  mail,
  screen,
  search,
  draft,
  send,
  workflow,
  policy,
  contacts,
  cal,
  ...OPS_COMMANDS,
  ...UPLOAD_COMMANDS,
];

const API = root(COMMANDS);

/**
 * Run one API command for a caller that wants its value (the TUI): consequential commands are
 * confirmed (the caller asked first), and failures are thrown rather than printed.
 */
export const invoke = async <A = JsonValue>(
  path: string,
  positionals: ReadonlyArray<string>,
  flags: Readonly<Record<string, string | true | undefined>>,
  options: { readonly api: Layer.Layer<CliApi>; readonly newCommandId: () => string },
): Promise<A> => {
  let outcome:
    | { readonly ok: true; readonly value: unknown }
    | { readonly ok: false; readonly error: unknown }
    | undefined;

  const argv = [
    ...path.split(" "),
    // An absent value means the flag isn't passed (never the text "undefined").
    ...Object.entries(flags).flatMap(([name, value]) =>
      value === undefined ? [] : value === true ? [`--${name}`] : [`--${name}=${value}`],
    ),
    "--yes",
    "--",
    ...positionals,
  ];

  const result = await execute(API, argv, {
    api: options.api,
    newCommandId: options.newCommandId,
    verbose: false,
    stderr: () => undefined,
    succeed: (value) => (outcome = { ok: true, value }),
    fail: (error) => (outcome = { ok: false, error }),
    exit: () => undefined,
  });

  if (result.usage) throw new UsageError(result.usage.errors.map((e) => e.message).join("; "));

  if (result.failure !== undefined) throw result.failure;

  if (!outcome) throw new Error(`no command ${path}`);

  if (!outcome.ok) throw outcome.error;

  return outcome.value as A;
};
