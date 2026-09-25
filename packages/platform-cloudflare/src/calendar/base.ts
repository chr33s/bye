import {
  type CalAttendee,
  type CalException,
  calNormAddress,
  type CalPerson,
  type CalSeries,
} from "@bye/calendar-engine";
import { Kernel, type KernelClock, KERNEL_MIGRATIONS } from "../durable/kernel.ts";
import { bool, json, migrate, Sql, type TransactionalStorage } from "../durable/sql.ts";
import { CALENDAR_MIGRATIONS } from "./schema.ts";
import {
  calendarError,
  type CalendarEventRecord,
  type CalendarKind,
  type CalendarMessageRef,
  type CalendarPreferences,
  type CalendarRecord,
  type CalendarRole,
  type CalendarSearchHit,
  type CalendarStoreConfig,
  type EventRow,
} from "./types.ts";

// CalendarDO authority core (§3.2, §9): storage, the command/receipt transaction, calendar access
// primitives, event record mapping and the search index. The authority is layered across modules
// (events → calendars → invitations → planner → interop → views); each extends the previous one
// and shares this state. Access POLICY lives in `access.ts` and is enforced once by the dispatcher
// before any store method runs; the helpers here are the primitives it uses.

type CalendarRow = {
  id: string;
  name: string;
  color: string;
  kind: CalendarKind;
  visible: number;
  revision: number;
};

const toCalendar = (r: CalendarRow): CalendarRecord => ({
  id: r.id,
  name: r.name,
  color: r.color,
  kind: r.kind,
  visible: bool(r.visible),
  revision: Number(r.revision),
});

export abstract class CalendarBase {
  readonly sql: Sql;
  readonly kernel: Kernel;

  protected constructor(
    storage: TransactionalStorage,
    readonly clock: KernelClock,
    readonly config: CalendarStoreConfig,
  ) {
    this.sql = new Sql(storage);
    this.kernel = new Kernel(this.sql, clock);
    migrate(this.sql, "kernel", KERNEL_MIGRATIONS);
    migrate(this.sql, "calendar", CALENDAR_MIGRATIONS);
  }

  /**
   * The account's calendar time zone (C03, §9): the owner's saved preference, falling back to the
   * zone the authority was provisioned with. Reminders, all-day instants and floating times use it.
   */
  protected get zone(): string {
    return this.storedPreferences().timeZone ?? this.config.defaultZone;
  }

  protected storedPreferences(): Partial<CalendarPreferences> {
    return json<Partial<CalendarPreferences>>(
      this.sql.one<{ value: string }>("SELECT value FROM cal_preferences WHERE key = 'view'")
        ?.value,
      {},
    );
  }

  protected get self(): ReadonlyArray<string> {
    return this.config.selfAddresses.map(calNormAddress);
  }

  /** One mutation: a transaction with an idempotency receipt (replays return the first result). */
  protected command<T>(commandId: string, kind: string, fn: () => T): T {
    return this.sql.tx(() => this.kernel.receipt(commandId, kind, fn).result);
  }

  /** Whether a command ID already has a receipt (its result would be replayed, not recomputed). */
  protected hasReceipt(commandId: string): boolean {
    return (
      this.sql.one("SELECT 1 AS x FROM command_receipts WHERE command_id = ?", commandId) !==
      undefined
    );
  }

  // ---------------------------------------------------------------- access primitives

  isOwner(actor: string): boolean {
    return actor === this.config.ownerId;
  }

  calendar(id: string): CalendarRecord | undefined {
    const r = this.sql.one<CalendarRow>(
      "SELECT id, name, color, kind, visible, revision FROM cal_calendars WHERE id = ? AND deleted = 0",
      id,
    );
    return r ? toCalendar(r) : undefined;
  }

  roleFor(calendarId: string, actor: string): CalendarRole | undefined {
    if (!this.calendar(calendarId)) return undefined;
    if (this.isOwner(actor)) return "owner";
    return this.sql.one<{ role: "read" | "write" }>(
      "SELECT role FROM cal_grants WHERE calendar_id = ? AND grantee = ?",
      calendarId,
      actor,
    )?.role;
  }

  /** Calendars the actor can read, with their role: one query (owner sees all, grantees theirs). */
  listCalendars(actor: string): Array<CalendarRecord & { readonly role: CalendarRole }> {
    const owner = this.isOwner(actor);
    return this.sql
      .all<CalendarRow & { grant_role: "read" | "write" | null }>(
        `SELECT c.id, c.name, c.color, c.kind, c.visible, c.revision, g.role AS grant_role
         FROM cal_calendars c LEFT JOIN cal_grants g ON g.calendar_id = c.id AND g.grantee = ?
         WHERE c.deleted = 0 ORDER BY c.created_at, c.id`,
        actor,
      )
      .flatMap((r) => {
        const role: CalendarRole | null = owner ? "owner" : r.grant_role;
        return role ? [{ ...toCalendar(r), role }] : [];
      });
  }

  /** Whether the actor may observe this space at all (owns it or holds any grant). */
  mayObserve(actor: string): boolean {
    return (
      this.isOwner(actor) ||
      this.sql.one(
        "SELECT 1 AS x FROM cal_grants g JOIN cal_calendars c ON c.id = g.calendar_id AND c.deleted = 0 WHERE g.grantee = ? LIMIT 1",
        actor,
      ) !== undefined
    );
  }

  /** Access check: the actor's role on a calendar covers `need`, and the calendar accepts writes. */
  requireRole(calendarId: string, actor: string, need: "read" | "write"): CalendarRecord {
    const role = this.roleFor(calendarId, actor);
    if (!role) throw calendarError("not_found", "calendar not found");
    if (need === "write" && role === "read") throw calendarError("forbidden", "read-only grant");
    return need === "write" ? this.writableCalendar(calendarId) : this.calendar(calendarId)!;
  }

  /** Domain invariant (independent of who asks): the calendar exists and is not a read-only subscription. */
  protected writableCalendar(calendarId: string): CalendarRecord {
    const calendar = this.calendar(calendarId);
    if (!calendar) throw calendarError("not_found", "calendar not found");
    if (calendar.kind === "subscription")
      throw calendarError("read_only", "subscribed calendars are read-only");
    return calendar;
  }

  /** The calendar that holds a live event, for event-scoped access checks. */
  calendarOfEvent(eventId: string): string | undefined {
    return this.sql.one<{ calendar_id: string }>(
      "SELECT calendar_id FROM cal_events WHERE id = ? AND deleted = 0",
      eventId,
    )?.calendar_id;
  }

  // ---------------------------------------------------------------- event records

  protected eventRow(eventId: string): EventRow | undefined {
    return this.sql.one<EventRow>("SELECT * FROM cal_events WHERE id = ? AND deleted = 0", eventId);
  }

  protected eventByUid(uid: string): EventRow | undefined {
    return this.sql.one<EventRow>(
      "SELECT * FROM cal_events WHERE uid = ? AND deleted = 0 ORDER BY created_at LIMIT 1",
      uid,
    );
  }

  protected toRecord(row: EventRow): CalendarEventRecord {
    return this.toRecords([row])[0]!;
  }

  /** Map event rows to records, loading every row's exceptions in ONE query. */
  protected toRecords(rows: ReadonlyArray<EventRow>): Array<CalendarEventRecord> {
    if (rows.length === 0) return [];
    const exceptions = new Map<string, Array<CalException>>();
    for (const e of this.sql.all<{ event_id: string; body: string }>(
      "SELECT event_id, body FROM cal_exceptions WHERE event_id IN (SELECT value FROM json_each(?)) ORDER BY event_id, recurrence_key",
      JSON.stringify(rows.map((r) => r.id)),
    )) {
      const list = exceptions.get(e.event_id) ?? [];
      list.push(json<CalException>(e.body, { recurrenceKey: "", cancelled: true }));
      exceptions.set(e.event_id, list);
    }
    return rows.map((r) => ({
      id: r.id,
      calendarId: r.calendar_id,
      uid: r.uid,
      series: JSON.parse(r.series) as CalSeries,
      exceptions: exceptions.get(r.id) ?? [],
      organizer: r.organizer ? json<CalPerson>(r.organizer, { address: "" }) : undefined,
      weAreOrganizer: bool(r.we_are_organizer),
      attendees: json<Array<CalAttendee>>(r.attendees, []),
      alarms: json<Array<number>>(r.alarms, []),
      sequence: Number(r.sequence),
      revision: Number(r.revision),
      generation: Number(r.generation),
      highlight: bool(r.highlight),
      countdown: bool(r.countdown),
      privateNote: r.private_note ?? undefined,
      sourceRef: r.source_ref ? (JSON.parse(r.source_ref) as CalendarMessageRef) : undefined,
    }));
  }

  /** Read an event. `privateNote` and the source backlink are returned only to the owner. */
  getEvent(actor: string, eventId: string): CalendarEventRecord {
    const row = this.eventRow(eventId);
    if (!row) throw calendarError("not_found", "event not found");
    this.requireRole(row.calendar_id, actor, "read");
    const record = this.toRecord(row);
    return this.isOwner(actor)
      ? record
      : { ...record, privateNote: undefined, sourceRef: undefined };
  }

  // ---------------------------------------------------------------- search index (C10)

  protected index(docId: string, kind: CalendarSearchHit["kind"], ref: string, body: string): void {
    this.unindex(docId);
    this.sql.run(
      "INSERT INTO cal_search (doc_id, kind, ref, body) VALUES (?, ?, ?, ?)",
      docId,
      kind,
      ref,
      body,
    );
  }

  protected unindex(docId: string): void {
    this.sql.run("DELETE FROM cal_search WHERE doc_id = ?", docId);
  }
}
