import { CalendarEvents } from "./events.ts";
import { calendarError, SUBSCRIPTION_JOB } from "./types.ts";

// Calendars and sharing (C05). Journal, habits, day context and time entries are never shared:
// grants cover event calendars only. Owner-only access is enforced by the dispatcher.

export abstract class CalendarCalendars extends CalendarEvents {
  createCalendar(input: {
    commandId: string;
    actor: string;
    name: string;
    color: string;
    kind?: "local";
  }): { calendarId: string } {
    return this.command(input.commandId, "CreateCalendar", () => {
      const id = this.clock.id("cal");
      this.sql.run(
        "INSERT INTO cal_calendars (id, name, color, kind, created_at) VALUES (?, ?, ?, ?, ?)",
        id,
        input.name,
        input.color,
        input.kind ?? "local",
        this.clock.now(),
      );
      this.kernel.change("calendar", "created", { calendarId: id });

      return { calendarId: id };
    });
  }

  updateCalendar(input: {
    commandId: string;
    actor: string;
    calendarId: string;
    expectedRevision: number;
    name?: string;
    color?: string;
    visible?: boolean;
  }): { revision: number } {
    return this.command(input.commandId, "UpdateCalendar", () => {
      const cal = this.calendar(input.calendarId);

      if (!cal) throw calendarError("not_found", "calendar not found");

      if (cal.revision !== input.expectedRevision)
        throw calendarError("conflict", "calendar revision changed", cal.revision);
      this.sql.run(
        "UPDATE cal_calendars SET name = ?, color = ?, visible = ?, revision = revision + 1 WHERE id = ?",
        input.name ?? cal.name,
        input.color ?? cal.color,
        input.visible ?? cal.visible,
        cal.id,
      );
      this.kernel.change("calendar", "updated", { calendarId: cal.id });

      return { revision: cal.revision + 1 };
    });
  }

  deleteCalendar(input: { commandId: string; actor: string; calendarId: string }): {
    deleted: boolean;
  } {
    return this.command(input.commandId, "DeleteCalendar", () => {
      const cal = this.calendar(input.calendarId);

      if (!cal) return { deleted: false };

      for (const e of this.sql.all<{ id: string }>(
        "SELECT id FROM cal_events WHERE calendar_id = ? AND deleted = 0",
        cal.id,
      ))
        this.removeEventRow(e.id);
      this.sql.run(
        "UPDATE cal_calendars SET deleted = 1, revision = revision + 1 WHERE id = ?",
        cal.id,
      );

      for (const g of this.sql.all<{ grantee: string }>(
        "SELECT grantee FROM cal_grants WHERE calendar_id = ?",
        cal.id,
      )) {
        this.kernel.emit("calendar.grant", g.grantee, { calendarId: cal.id, role: null });
      }

      this.sql.run("DELETE FROM cal_grants WHERE calendar_id = ?", cal.id);
      this.kernel.cancelJob(SUBSCRIPTION_JOB, cal.id);
      this.kernel.change("calendar", "deleted", { calendarId: cal.id });

      return { deleted: true };
    });
  }

  grantCalendar(input: {
    commandId: string;
    actor: string;
    calendarId: string;
    grantee: string;
    role: "read" | "write";
  }): void {
    this.command(input.commandId, "GrantCalendar", () => {
      if (!this.calendar(input.calendarId)) throw calendarError("not_found", "calendar not found");

      if (input.grantee === this.config.ownerId)
        throw calendarError("bad_request", "owner already has access");
      this.sql.run(
        `INSERT INTO cal_grants (calendar_id, grantee, role, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (calendar_id, grantee) DO UPDATE SET role = excluded.role`,
        input.calendarId,
        input.grantee,
        input.role,
        this.clock.now(),
      );
      this.kernel.change("grant", "set", {
        calendarId: input.calendarId,
        grantee: input.grantee,
        role: input.role,
      });
      // Index the grant in the directory so the grantee can discover the calendar (C05).
      this.kernel.emit("calendar.grant", input.grantee, {
        calendarId: input.calendarId,
        role: input.role,
      });

      return null;
    });
  }

  revokeCalendar(input: {
    commandId: string;
    actor: string;
    calendarId: string;
    grantee: string;
  }): void {
    this.command(input.commandId, "RevokeCalendar", () => {
      this.sql.run(
        "DELETE FROM cal_grants WHERE calendar_id = ? AND grantee = ?",
        input.calendarId,
        input.grantee,
      );
      this.kernel.change("grant", "revoked", {
        calendarId: input.calendarId,
        grantee: input.grantee,
      });
      this.kernel.emit("calendar.grant", input.grantee, {
        calendarId: input.calendarId,
        role: null,
      });

      return null;
    });
  }

  protected ensureInvitationsCalendar(): string {
    const existing = this.sql.one<{ id: string }>(
      "SELECT id FROM cal_calendars WHERE kind = 'invitations' AND deleted = 0",
    );

    if (existing) return existing.id;
    const id = this.clock.id("cal");
    this.sql.run(
      "INSERT INTO cal_calendars (id, name, color, kind, created_at) VALUES (?, 'Invitations', '#6b7280', 'invitations', ?)",
      id,
      this.clock.now(),
    );
    this.kernel.change("calendar", "created", { calendarId: id });

    return id;
  }
}
