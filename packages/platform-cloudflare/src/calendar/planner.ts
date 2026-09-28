import {
  calDateInZone,
  calFormatDate,
  calFreeTime,
  calInstant,
  calIsValidTimeZone,
  type CalLocalDate,
  calOrderKeyBetween,
  type CalTime,
  calWeekAnchor,
} from "@bye/calendar-engine";
import { CALENDAR_PHOTO_KEY } from "@bye/contracts";
import { json } from "../durable/sql.ts";
import { CalendarInvitations } from "./invitations.ts";
import {
  CALENDAR_DEFAULT_PREFERENCES,
  type CalendarDayContext,
  calendarError,
  type CalendarOccurrenceView,
  type CalendarPreferences,
  type CalendarTimeEntry,
  type CalendarWeekTask,
} from "./types.ts";

// The owner's private planner (C06–C08, C01/C03 preferences): week tasks, habits, time tracking,
// day decorations and the journal. All of it is owner-only — enforced by the dispatcher — and
// none of it is ever shared, exported to feeds, or indexed for grantees.

type WeekTaskRow = {
  id: string;
  anchor: string;
  title: string;
  order_key: string;
  completed_at: number | null;
  event_id: string | null;
  revision: number;
};

type TimeEntryRow = {
  id: string;
  label: string;
  started_at: number;
  stopped_at: number | null;
  source: "timer" | "manual";
};

const toWeekTask = (r: WeekTaskRow): CalendarWeekTask => ({
  id: r.id,
  anchor: r.anchor,
  title: r.title,
  orderKey: r.order_key,
  completedAt: r.completed_at ?? undefined,
  eventId: r.event_id ?? undefined,
  revision: Number(r.revision),
});

const toTimeEntry = (r: TimeEntryRow): CalendarTimeEntry => ({
  id: r.id,
  label: r.label,
  startedAt: Number(r.started_at),
  stoppedAt: r.stopped_at ?? undefined,
  source: r.source,
});

const WEEK_TASK_COLUMNS = "id, anchor, title, order_key, completed_at, event_id, revision";

const TIME_ENTRY_COLUMNS = "id, label, started_at, stopped_at, source";

export abstract class CalendarPlanner extends CalendarInvitations {
  // ---------------------------------------------------------------- week tasks (C06)

  private weekTask(id: string): CalendarWeekTask {
    const r = this.sql.one<WeekTaskRow>(
      `SELECT ${WEEK_TASK_COLUMNS} FROM cal_week_tasks WHERE id = ? AND deleted = 0`,
      id,
    );

    if (!r) throw calendarError("not_found", "task not found");

    return toWeekTask(r);
  }

  private lastKey(anchor: string): string | undefined {
    return (
      this.sql.one<{ k: string | null }>(
        "SELECT MAX(order_key) AS k FROM cal_week_tasks WHERE anchor = ? AND deleted = 0",
        anchor,
      )?.k ?? undefined
    );
  }

  listWeekTasks(date: CalLocalDate, firstWeekday: number): Array<CalendarWeekTask> {
    const anchor = calFormatDate(calWeekAnchor(date, firstWeekday));

    return this.sql
      .all<WeekTaskRow>(
        `SELECT ${WEEK_TASK_COLUMNS} FROM cal_week_tasks WHERE anchor = ? AND deleted = 0 ORDER BY order_key, id`,
        anchor,
      )
      .map(toWeekTask);
  }

  addWeekTask(input: {
    commandId: string;
    actor: string;
    date: CalLocalDate;
    firstWeekday: number;
    title: string;
  }): { taskId: string; anchor: string } {
    return this.command(input.commandId, "AddWeekTask", () => {
      const anchor = calFormatDate(calWeekAnchor(input.date, input.firstWeekday));
      const id = this.clock.id("tsk");
      this.sql.run(
        "INSERT INTO cal_week_tasks (id, anchor, title, order_key, created_at) VALUES (?, ?, ?, ?, ?)",
        id,
        anchor,
        input.title,
        calOrderKeyBetween(this.lastKey(anchor), undefined),
        this.clock.now(),
      );
      this.index(`task:${id}`, "task", anchor, input.title);
      this.kernel.change("task", "created", { taskId: id });

      return { taskId: id, anchor };
    });
  }

  reorderWeekTask(input: {
    commandId: string;
    actor: string;
    taskId: string;
    afterId?: string;
    beforeId?: string;
  }): { orderKey: string } {
    return this.command(input.commandId, "ReorderWeekTask", () => {
      const task = this.weekTask(input.taskId);
      const after = input.afterId ? this.weekTask(input.afterId) : undefined;
      const before = input.beforeId ? this.weekTask(input.beforeId) : undefined;

      if ((after && after.anchor !== task.anchor) || (before && before.anchor !== task.anchor))
        throw calendarError("bad_request", "tasks are in different weeks");

      const neighbour = (agg: "MAX" | "MIN", cmp: "<" | ">", key: string) =>
        this.sql.one<{ k: string | null }>(
          `SELECT ${agg}(order_key) AS k FROM cal_week_tasks WHERE anchor = ? AND deleted = 0 AND order_key ${cmp} ? AND id != ?`,
          task.anchor,
          key,
          task.id,
        )?.k ?? undefined;

      const lo = after?.orderKey ?? (before ? neighbour("MAX", "<", before.orderKey) : undefined);
      const hi = before?.orderKey ?? (after ? neighbour("MIN", ">", after.orderKey) : undefined);
      const key = calOrderKeyBetween(lo, hi);
      this.sql.run(
        "UPDATE cal_week_tasks SET order_key = ?, revision = revision + 1 WHERE id = ?",
        key,
        task.id,
      );
      this.kernel.change("task", "reordered", { taskId: task.id });

      return { orderKey: key };
    });
  }

  moveWeekTask(input: {
    commandId: string;
    actor: string;
    taskId: string;
    date: CalLocalDate;
    firstWeekday: number;
  }): { anchor: string } {
    return this.command(input.commandId, "MoveWeekTask", () => {
      const task = this.weekTask(input.taskId);
      const anchor = calFormatDate(calWeekAnchor(input.date, input.firstWeekday));
      this.sql.run(
        "UPDATE cal_week_tasks SET anchor = ?, order_key = ?, revision = revision + 1 WHERE id = ?",
        anchor,
        calOrderKeyBetween(this.lastKey(anchor), undefined),
        task.id,
      );
      this.index(`task:${task.id}`, "task", anchor, task.title);
      this.kernel.change("task", "moved", { taskId: task.id, anchor });

      return { anchor };
    });
  }

  completeWeekTask(input: {
    commandId: string;
    actor: string;
    taskId: string;
    completed: boolean;
  }): void {
    this.command(input.commandId, "CompleteWeekTask", () => {
      this.weekTask(input.taskId);
      this.sql.run(
        "UPDATE cal_week_tasks SET completed_at = ?, revision = revision + 1 WHERE id = ?",
        input.completed ? this.clock.now() : null,
        input.taskId,
      );
      this.kernel.change("task", input.completed ? "completed" : "reopened", {
        taskId: input.taskId,
      });

      return null;
    });
  }

  deleteWeekTask(input: { commandId: string; actor: string; taskId: string }): void {
    this.command(input.commandId, "DeleteWeekTask", () => {
      this.sql.run("UPDATE cal_week_tasks SET deleted = 1 WHERE id = ?", input.taskId);
      this.unindex(`task:${input.taskId}`);
      this.kernel.change("task", "deleted", { taskId: input.taskId });

      return null;
    });
  }

  /** Convert a week task into a scheduled event, keeping the link (C06). */
  convertWeekTaskToEvent(input: {
    commandId: string;
    actor: string;
    taskId: string;
    calendarId: string;
    start: CalTime;
    end: CalTime;
  }): { eventId: string } {
    return this.command(input.commandId, "ConvertWeekTask", () => {
      const task = this.weekTask(input.taskId);

      if (task.eventId) return { eventId: task.eventId };

      // A nested command with its own receipt: a replay of the conversion never duplicates the event.
      const { eventId } = this.createEvent({
        commandId: `${input.commandId}:event`,
        actor: input.actor,
        calendarId: input.calendarId,
        series: { start: input.start, end: input.end, data: { summary: task.title } },
      });

      this.sql.run(
        "UPDATE cal_week_tasks SET event_id = ?, completed_at = COALESCE(completed_at, ?), revision = revision + 1 WHERE id = ?",
        eventId,
        this.clock.now(),
        task.id,
      );
      this.kernel.change("task", "converted", { taskId: task.id, eventId });

      return { eventId };
    });
  }

  // ---------------------------------------------------------------- habits (C07)

  createHabit(input: {
    commandId: string;
    actor: string;
    name: string;
    weekdays: ReadonlyArray<number>;
  }): { habitId: string } {
    return this.command(input.commandId, "CreateHabit", () => {
      if (
        input.weekdays.length === 0 ||
        input.weekdays.some((d) => !Number.isInteger(d) || d < 0 || d > 6)
      )
        throw calendarError("bad_request", "weekdays must be 0-6");
      const id = this.clock.id("hab");
      this.sql.run(
        "INSERT INTO cal_habits (id, name, weekdays, created_at) VALUES (?, ?, ?, ?)",
        id,
        input.name,
        JSON.stringify([...new Set(input.weekdays)].sort((a, b) => a - b)),
        this.clock.now(),
      );
      this.index(`habit:${id}`, "habit", "", input.name);
      this.kernel.change("habit", "created", { habitId: id });

      return { habitId: id };
    });
  }

  setHabitCompletion(input: {
    commandId: string;
    actor: string;
    habitId: string;
    date: CalLocalDate;
    completed: boolean;
  }): void {
    this.command(input.commandId, "SetHabitCompletion", () => {
      if (!this.sql.one("SELECT id FROM cal_habits WHERE id = ?", input.habitId))
        throw calendarError("not_found", "habit not found");
      const date = calFormatDate(input.date);

      if (input.completed)
        this.sql.run(
          "INSERT OR IGNORE INTO cal_habit_completions (habit_id, date, created_at) VALUES (?, ?, ?)",
          input.habitId,
          date,
          this.clock.now(),
        );
      else
        this.sql.run(
          "DELETE FROM cal_habit_completions WHERE habit_id = ? AND date = ?",
          input.habitId,
          date,
        );
      this.kernel.change("habit", "completion", {
        habitId: input.habitId,
        date,
        completed: input.completed,
      });

      return null;
    });
  }

  archiveHabit(input: { commandId: string; actor: string; habitId: string }): void {
    this.command(input.commandId, "ArchiveHabit", () => {
      if (this.sql.run("UPDATE cal_habits SET archived = 1 WHERE id = ?", input.habitId) === 0)
        throw calendarError("not_found", "habit not found");
      this.unindex(`habit:${input.habitId}`);
      this.kernel.change("habit", "archived", { habitId: input.habitId });

      return null;
    });
  }

  habitHistory(habitId: string, from: CalLocalDate, to: CalLocalDate): HabitHistory {
    const habit = this.sql.one<{ name: string; weekdays: string }>(
      "SELECT name, weekdays FROM cal_habits WHERE id = ?",
      habitId,
    );

    if (!habit) throw calendarError("not_found", "habit not found");

    return {
      name: habit.name,
      weekdays: json<Array<number>>(habit.weekdays, []),
      completed: this.sql
        .all<{ date: string }>(
          "SELECT date FROM cal_habit_completions WHERE habit_id = ? AND date >= ? AND date <= ? ORDER BY date",
          habitId,
          calFormatDate(from),
          calFormatDate(to),
        )
        .map((r) => r.date),
    };
  }

  listHabits(
    from: CalLocalDate,
    to: CalLocalDate,
  ): Array<{ id: string; name: string; weekdays: Array<number>; completed: Array<string> }> {
    const completions = new Map<string, Array<string>>();

    for (const c of this.sql.all<{ habit_id: string; date: string }>(
      "SELECT habit_id, date FROM cal_habit_completions WHERE date >= ? AND date <= ? ORDER BY date",
      calFormatDate(from),
      calFormatDate(to),
    )) {
      completions.set(c.habit_id, [...(completions.get(c.habit_id) ?? []), c.date]);
    }

    return this.sql
      .all<{ id: string; name: string; weekdays: string }>(
        "SELECT id, name, weekdays FROM cal_habits WHERE archived = 0 ORDER BY created_at, id",
      )
      .map((h) => ({
        id: h.id,
        name: h.name,
        weekdays: json<Array<number>>(h.weekdays, []),
        completed: completions.get(h.id) ?? [],
      }));
  }

  // ---------------------------------------------------------------- time tracking (C07)

  private timeEntry(id: string): CalendarTimeEntry | undefined {
    const r = this.sql.one<TimeEntryRow>(
      `SELECT ${TIME_ENTRY_COLUMNS} FROM cal_time_entries WHERE id = ?`,
      id,
    );

    return r ? toTimeEntry(r) : undefined;
  }

  activeTimer(): CalendarTimeEntry | undefined {
    const r = this.sql.one<TimeEntryRow>(
      `SELECT ${TIME_ENTRY_COLUMNS} FROM cal_time_entries WHERE active = 1`,
    );

    return r ? toTimeEntry(r) : undefined;
  }

  /**
   * Start a timer. There is at most one active timer per account; starting a new one stops the
   * previous at the same instant. Command IDs make concurrent device retries idempotent.
   */
  startTimer(input: { commandId: string; actor: string; label: string; at?: number }): {
    entryId: string;
    stoppedEntryId?: string;
  } {
    return this.command(input.commandId, "StartTimer", () => {
      const at = input.at ?? this.clock.now();

      const active = this.sql.one<{ id: string; started_at: number }>(
        "SELECT id, started_at FROM cal_time_entries WHERE active = 1",
      );

      if (active)
        this.sql.run(
          "UPDATE cal_time_entries SET stopped_at = ?, active = NULL WHERE id = ?",
          Math.max(at, Number(active.started_at)),
          active.id,
        );
      const id = this.clock.id("tim");
      this.sql.run(
        "INSERT INTO cal_time_entries (id, label, started_at, active, source, created_at) VALUES (?, ?, ?, 1, 'timer', ?)",
        id,
        input.label,
        at,
        this.clock.now(),
      );
      this.index(`time:${id}`, "time", calFormatDate(calDateInZone(at, this.zone)), input.label);
      this.kernel.change("timer", "started", { entryId: id });

      return active ? { entryId: id, stoppedEntryId: active.id } : { entryId: id };
    });
  }

  /** Stop the active timer; stopping an entry another device already stopped is a no-op. */
  stopTimer(input: {
    commandId: string;
    actor: string;
    entryId?: string;
    at?: number;
  }):
    | { _tag: "Stopped"; entry: CalendarTimeEntry }
    | { _tag: "AlreadyStopped"; entry: CalendarTimeEntry | undefined } {
    return this.command(input.commandId, "StopTimer", () => {
      const active = this.sql.one<{ id: string; started_at: number }>(
        "SELECT id, started_at FROM cal_time_entries WHERE active = 1",
      );

      if (!active || (input.entryId && input.entryId !== active.id))
        return {
          _tag: "AlreadyStopped" as const,
          entry: input.entryId ? this.timeEntry(input.entryId) : undefined,
        };
      const at = Math.max(input.at ?? this.clock.now(), Number(active.started_at));
      this.sql.run(
        "UPDATE cal_time_entries SET stopped_at = ?, active = NULL WHERE id = ?",
        at,
        active.id,
      );
      this.kernel.change("timer", "stopped", { entryId: active.id });

      return { _tag: "Stopped" as const, entry: this.timeEntry(active.id)! };
    });
  }

  addTimeEntry(input: {
    commandId: string;
    actor: string;
    label: string;
    startedAt: number;
    stoppedAt: number;
  }): { entryId: string } {
    return this.command(input.commandId, "AddTimeEntry", () => {
      if (input.stoppedAt <= input.startedAt)
        throw calendarError("bad_request", "entry must have positive duration");
      const id = this.clock.id("tim");
      this.sql.run(
        "INSERT INTO cal_time_entries (id, label, started_at, stopped_at, source, created_at) VALUES (?, ?, ?, ?, 'manual', ?)",
        id,
        input.label,
        input.startedAt,
        input.stoppedAt,
        this.clock.now(),
      );
      this.index(
        `time:${id}`,
        "time",
        calFormatDate(calDateInZone(input.startedAt, this.zone)),
        input.label,
      );
      this.kernel.change("timer", "entry", { entryId: id });

      return { entryId: id };
    });
  }

  timeEntries(from: number, to: number): Array<CalendarTimeEntry> {
    return this.sql
      .all<TimeEntryRow>(
        `SELECT ${TIME_ENTRY_COLUMNS} FROM cal_time_entries WHERE started_at < ? AND (stopped_at IS NULL OR stopped_at > ?) ORDER BY started_at`,
        to,
        from,
      )
      .map(toTimeEntry);
  }

  // ---------------------------------------------------------------- day context and journal (C08)

  /**
   * Label and/or photo for a day. `expectedPhotoKey` makes it a compare-and-set: the change applies
   * only while that photo is still the day's photo, so rejecting an infected upload can never
   * clear a photo the owner has since replaced (one atomic step inside the authority).
   * `released` names the prior photo when this replaced or cleared it and no other day still shows
   * it, so the caller can delete the stored object.
   */
  setDayDecoration(input: {
    commandId: string;
    actor: string;
    date: CalLocalDate;
    label?: string | null | undefined;
    photoKey?: string | null | undefined;
    expectedPhotoKey?: string | undefined;
  }): { applied: boolean; released?: string } {
    if (input.photoKey && !CALENDAR_PHOTO_KEY.test(input.photoKey))
      throw calendarError("bad_request", "photoKey must reference an uploaded day photo");

    return this.command(input.commandId, "SetDayDecoration", () => {
      const date = calFormatDate(input.date);

      const prior = this.sql.one<{ label: string | null; photo_key: string | null }>(
        "SELECT label, photo_key FROM cal_day_decorations WHERE date = ?",
        date,
      );

      if (
        input.expectedPhotoKey !== undefined &&
        (prior?.photo_key ?? undefined) !== input.expectedPhotoKey
      )
        return { applied: false };
      const label = input.label === undefined ? (prior?.label ?? null) : input.label;
      const photo = input.photoKey === undefined ? (prior?.photo_key ?? null) : input.photoKey;
      this.sql.run(
        `INSERT INTO cal_day_decorations (date, label, photo_key, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (date) DO UPDATE SET label = excluded.label, photo_key = excluded.photo_key, updated_at = excluded.updated_at`,
        date,
        label,
        photo,
        this.clock.now(),
      );

      if (label) this.index(`day:${date}`, "day", date, label);
      else this.unindex(`day:${date}`);
      this.kernel.change("day", "decorated", { date });
      const old = prior?.photo_key ?? null;

      const released =
        old !== null &&
        old !== photo &&
        this.sql.one("SELECT 1 AS x FROM cal_day_decorations WHERE photo_key = ? LIMIT 1", old) ===
          undefined;

      return released ? { applied: true, released: old } : { applied: true };
    });
  }

  /** The owner's private context for a day. Pass `occurrences` (from `date` for 2 days) when already loaded. */
  dayContext(
    date: CalLocalDate,
    viewerZone?: string,
    loaded?: {
      readonly occurrences: ReadonlyArray<CalendarOccurrenceView>;
      readonly preferences: CalendarPreferences;
    },
  ): CalendarDayContext {
    const key = calFormatDate(date);
    const zone = viewerZone ?? this.zone;

    const deco = this.sql.one<{ label: string | null; photo_key: string | null }>(
      "SELECT label, photo_key FROM cal_day_decorations WHERE date = ?",
      key,
    );

    const journal = this.sql.one<{ body: string; revision: number }>(
      "SELECT body, revision FROM cal_journal WHERE date = ?",
      key,
    );

    const prefs = loaded?.preferences ?? this.preferences();
    const from = calInstant({ kind: "date", date }, zone);

    const occurrences =
      loaded?.occurrences ??
      this.listOccurrences({
        actor: this.config.ownerId,
        from,
        to: from + 2 * 86_400_000,
        viewerZone: zone,
        visibleOnly: true,
      });

    return {
      date: key,
      label: deco?.label ?? undefined,
      photoKey: deco?.photo_key ?? undefined,
      journal: journal ? { body: journal.body, revision: Number(journal.revision) } : undefined,
      freeTime: calFreeTime(occurrences, date, {
        viewerZone: zone,
        waking: prefs.waking,
        minimumMinutes: 15,
      }),
      highlights: occurrences.filter((o) => o.highlight),
    };
  }

  /** Private journal entry; optimistic revision prevents one device silently overwriting another. */
  writeJournal(input: {
    commandId: string;
    actor: string;
    date: CalLocalDate;
    body: string;
    expectedRevision: number;
  }): { revision: number } {
    return this.command(input.commandId, "WriteJournal", () => {
      const date = calFormatDate(input.date);

      const current = Number(
        this.sql.one<{ revision: number }>("SELECT revision FROM cal_journal WHERE date = ?", date)
          ?.revision ?? 0,
      );

      if (current !== input.expectedRevision)
        throw calendarError("conflict", "journal changed on another device", current);
      this.sql.run(
        `INSERT INTO cal_journal (date, body, revision, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (date) DO UPDATE SET body = excluded.body, revision = excluded.revision, updated_at = excluded.updated_at`,
        date,
        input.body,
        current + 1,
        this.clock.now(),
      );
      this.index(`journal:${date}`, "journal", date, input.body);
      this.kernel.change("journal", "written", { date });

      return { revision: current + 1 };
    });
  }

  // ---------------------------------------------------------------- preferences (C01, C03)

  preferences(): CalendarPreferences {
    return {
      ...CALENDAR_DEFAULT_PREFERENCES,
      timeZone: this.config.defaultZone,
      ...this.storedPreferences(),
    };
  }

  setPreferences(input: {
    commandId: string;
    actor: string;
    preferences: Partial<CalendarPreferences>;
  }): CalendarPreferences {
    return this.command(input.commandId, "SetPreferences", () => {
      const next = { ...this.preferences(), ...input.preferences };

      if (!Number.isInteger(next.firstWeekday) || next.firstWeekday < 0 || next.firstWeekday > 6)
        throw calendarError("bad_request", "firstWeekday must be 0-6");

      if (
        next.waking.startMinute < 0 ||
        next.waking.endMinute > 1440 ||
        next.waking.startMinute >= next.waking.endMinute
      )
        throw calendarError("bad_request", "invalid waking window");

      if (!["day", "week", "agenda", "year", "month"].includes(next.lastView))
        throw calendarError("bad_request", "invalid view");

      if (next.lastDate !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(next.lastDate))
        throw calendarError("bad_request", "lastDate must be YYYY-MM-DD");

      if (
        next.timeZone.length === 0 ||
        next.timeZone.length > 64 ||
        !calIsValidTimeZone(next.timeZone)
      )
        throw calendarError("bad_request", "unknown IANA time zone");
      const previousZone = this.zone;
      this.sql.run(
        "INSERT INTO cal_preferences (key, value) VALUES ('view', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        JSON.stringify(next),
      );

      // Reminders for all-day and floating events depend on the account zone: recompute them (§9).
      if (next.timeZone !== previousZone) {
        for (const e of this.sql.all<{ id: string }>("SELECT id FROM cal_events WHERE deleted = 0"))
          this.scheduleReminder(e.id);
      }

      this.kernel.change("preferences", "updated", {});

      return next;
    });
  }
}

/** A habit with its completions in a date range. */
export interface HabitHistory {
  name: string;
  weekdays: Array<number>;
  completed: Array<string>;
}
