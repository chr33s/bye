import {
  calEndFor,
  type CalException,
  type CalIcsEvent,
  calNormAddress,
  calParseCalendar,
  calRecurrenceKey,
  calSeriesDuration,
  calSerializeCalendar,
} from "@bye/calendar-engine";
import { bool, json } from "../durable/sql.ts";
import { calendarValidateFeedUrl } from "./net.ts";
import { CalendarPlanner } from "./planner.ts";
import { calendarError, type EventRow, SUBSCRIPTION_JOB } from "./types.ts";

/** Events written per transaction when importing or refreshing from ICS. */
const IMPORT_BATCH = 100;

/** An import checkpoint nobody has resumed for this long is abandoned and deleted. */
const IMPORT_CHECKPOINT_TTL_MS = 7 * 24 * 3600_000;

/** Identity of an import body, so a retry resumes only the same document (FNV-1a, 2×32 bits). */
const contentHash = (text: string): string => {
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ text.length;

  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x5bd1e995) >>> 0;
  }

  return `${text.length.toString(36)}.${a.toString(36)}.${b.toString(36)}`;
};

interface ImportCheckpoint {
  readonly commandId: string;
  readonly hash: string;
}

interface CheckpointRow {
  readonly calendar_id: string;
  readonly content_hash: string;
  readonly next_index: number;
  readonly imported: number;
  readonly updated: number;
  readonly warnings: string;
}

// Interoperability (C05, A04): ICS import/export, external read-only subscriptions (fetched
// outside the authority), and revocable private outbound feeds. Private notes, journals and
// source-message backlinks are never part of any ICS.

export abstract class CalendarInterop extends CalendarPlanner {
  private eventsForExport(
    calendarIds: ReadonlyArray<string>,
    options: { includeAttendees: boolean },
  ): Array<CalIcsEvent> {
    const out: Array<CalIcsEvent> = [];

    for (const calendarId of calendarIds) {
      for (const r of this.toRecords(
        this.sql.all<EventRow>(
          "SELECT * FROM cal_events WHERE calendar_id = ? AND deleted = 0 ORDER BY created_at, id",
          calendarId,
        ),
      )) {
        const cancelled = r.exceptions
          .filter((e) => e.cancelled)
          .map((e) => this.timeFromKey(r.series, e.recurrenceKey));

        const base: CalIcsEvent = {
          uid: r.uid,
          sequence: r.sequence,
          dtstamp: undefined,
          series: { ...r.series, exdates: [...(r.series.exdates ?? []), ...cancelled] },
          organizer: options.includeAttendees ? r.organizer : undefined,
          attendees: options.includeAttendees ? r.attendees : [],
          alarms: r.alarms,
        };

        out.push(base);
        const duration = calSeriesDuration(r.series);

        for (const e of r.exceptions.filter((x) => !x.cancelled)) {
          const recurrenceId = this.timeFromKey(r.series, e.recurrenceKey);
          const start = e.start ?? recurrenceId;
          out.push({
            ...base,
            recurrenceId,
            series: {
              uid: r.uid,
              dtstart: start,
              dtend: e.end ?? calEndFor(start, duration),
              data: { ...r.series.data, ...e.data },
            },
          });
        }
      }
    }

    return out;
  }

  /** Full export for portability (A04), limited to calendars the actor can read. */
  exportIcs(actor: string, calendarIds?: ReadonlyArray<string>): string {
    const readable = this.listCalendars(actor).map((c) => c.id);
    const ids = calendarIds ? calendarIds.filter((id) => readable.includes(id)) : readable;

    return calSerializeCalendar(this.eventsForExport(ids, { includeAttendees: true }), {
      now: this.clock.now(),
      method: "PUBLISH",
    });
  }

  /**
   * Import events from ICS. The document is parsed once and written in bounded batches, each its
   * own transaction, so a large file never becomes one huge write. Each batch commits a checkpoint
   * keyed by the command ID, so a retry of the same command with the same document resumes after
   * the last committed batch and reports totals for the whole import; the receipt commits last and
   * removes the checkpoint. A different document under the same command ID is refused. There is no
   * explicit cancel: an import that is never retried keeps its committed batches (rows are upserted
   * by UID, so a later import of the same file is still idempotent) and its checkpoint expires.
   */
  importIcs(input: {
    commandId: string;
    actor: string;
    calendarId: string;
    ics: string;
    maxItems?: number;
  }): { imported: number; updated: number; warnings: Array<string> } {
    const empty = { imported: 0, updated: 0, warnings: [] as Array<string> };

    if (this.hasReceipt(input.commandId))
      return this.command(input.commandId, "ImportIcs", () => empty);
    this.writableCalendar(input.calendarId);
    this.sql.run(
      "DELETE FROM cal_import_checkpoints WHERE updated_at < ?",
      this.clock.now() - IMPORT_CHECKPOINT_TTL_MS,
    );

    const result = this.replaceFromIcs(input.calendarId, input.ics, input.maxItems ?? 5000, false, {
      commandId: input.commandId,
      hash: contentHash(input.ics),
    });

    return this.command(input.commandId, "ImportIcs", () => {
      this.sql.run("DELETE FROM cal_import_checkpoints WHERE command_id = ?", input.commandId);

      return result;
    });
  }

  private replaceFromIcs(
    calendarId: string,
    ics: string,
    maxItems: number,
    removeMissing: boolean,
    checkpoint?: ImportCheckpoint,
  ): IcsReplaceResult {
    const parsed = calParseCalendar(ics, { defaultZone: this.zone, maxItems });
    const warnings = [...parsed.warnings];

    if (parsed.truncated) warnings.push(`only the first ${maxItems} items were imported`);

    const resumed = checkpoint
      ? this.sql.one<CheckpointRow>(
          "SELECT * FROM cal_import_checkpoints WHERE command_id = ?",
          checkpoint.commandId,
        )
      : undefined;

    if (
      resumed &&
      (resumed.content_hash !== checkpoint!.hash || resumed.calendar_id !== calendarId)
    )
      throw calendarError("conflict", "this import was started with a different document");
    let imported = resumed ? Number(resumed.imported) : 0;
    let updated = resumed ? Number(resumed.updated) : 0;
    // Per-event warnings from committed batches; parse warnings are recomputed from the document.
    const eventWarnings: Array<string> = resumed ? json<Array<string>>(resumed.warnings, []) : [];
    const seen = new Set<string>();
    const overrides = new Map<string, Array<CalIcsEvent>>();

    for (const o of parsed.events) {
      if (!o.recurrenceId) continue;
      const list = overrides.get(o.uid) ?? [];
      list.push(o);
      overrides.set(o.uid, list);
    }

    const upsert = (e: CalIcsEvent): void => {
      seen.add(e.uid);

      // RECURRENCE-IDs may use UTC or another zone: key them in the series' own wall clock.
      const exceptions: Array<CalException> = (overrides.get(e.uid) ?? []).map((o) => ({
        recurrenceKey: calRecurrenceKey(o.recurrenceId!, e.series.dtstart),
        cancelled: o.series.data.status === "cancelled",
        start: o.series.dtstart,
        end: o.series.dtend,
        data: o.series.data,
      }));

      const existing = this.sql.one<EventRow>(
        "SELECT * FROM cal_events WHERE calendar_id = ? AND uid = ?",
        calendarId,
        e.uid,
      );

      const base = {
        calendarId,
        uid: e.uid,
        series: e.series,
        exceptions,
        organizer: e.organizer,
        weAreOrganizer: !!e.organizer && this.self.includes(calNormAddress(e.organizer.address)),
        attendees: e.attendees,
        alarms: e.alarms,
        sequence: e.sequence,
        highlight: false,
        countdown: false,
        privateNote: undefined,
        sourceRef: undefined,
      };

      try {
        // A savepoint per event: a rejected event leaves no partial rows behind.
        this.sql.tx(() => {
          if (existing) {
            const prior = this.toRecord(existing);

            if (bool(existing.deleted))
              this.sql.run("UPDATE cal_events SET deleted = 0 WHERE id = ?", existing.id);
            this.writeEvent(
              {
                ...base,
                id: existing.id,
                highlight: prior.highlight,
                countdown: prior.countdown,
                privateNote: prior.privateNote,
              },
              false,
            );
          } else {
            this.writeEvent({ ...base, id: this.clock.id("evt") }, true);
          }
        });

        if (existing) updated++;
        else imported++;
      } catch (error) {
        eventWarnings.push(`${e.uid}: ${error instanceof Error ? error.message : "invalid event"}`);
      }
    };

    const masters = parsed.events.filter((x) => !x.recurrenceId);
    const start = resumed ? Number(resumed.next_index) : 0;

    // Resumed batches were written by an earlier attempt: their UIDs still count as present.
    for (const e of masters.slice(0, start)) seen.add(e.uid);

    for (let i = start; i < masters.length; i += IMPORT_BATCH) {
      const batch = masters.slice(i, i + IMPORT_BATCH);
      this.sql.tx(() => {
        batch.forEach(upsert);

        if (checkpoint)
          this.sql.run(
            `INSERT INTO cal_import_checkpoints
               (command_id, calendar_id, content_hash, next_index, imported, updated, warnings, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (command_id) DO UPDATE SET next_index = excluded.next_index,
               imported = excluded.imported, updated = excluded.updated,
               warnings = excluded.warnings, updated_at = excluded.updated_at`,
            checkpoint.commandId,
            calendarId,
            checkpoint.hash,
            i + batch.length,
            imported,
            updated,
            JSON.stringify(eventWarnings),
            this.clock.now(),
          );
      });
    }

    warnings.push(...eventWarnings);

    if (removeMissing) {
      const gone = this.sql
        .all<{ id: string; uid: string }>(
          "SELECT id, uid FROM cal_events WHERE calendar_id = ? AND deleted = 0",
          calendarId,
        )
        .filter((row) => !seen.has(row.uid));

      for (let i = 0; i < gone.length; i += IMPORT_BATCH) {
        const batch = gone.slice(i, i + IMPORT_BATCH);
        this.sql.tx(() => batch.forEach((row) => this.removeEventRow(row.id)));
      }
    }

    return { imported, updated, warnings };
  }

  /** External read-only subscription (C05); fetching happens outside the authority. */
  addSubscription(input: {
    commandId: string;
    actor: string;
    name: string;
    color: string;
    url: string;
    itemLimit?: number;
    refreshMs?: number;
  }): { calendarId: string } {
    return this.command(input.commandId, "AddSubscription", () => {
      const url = calendarValidateFeedUrl(input.url);
      const id = this.clock.id("cal");
      this.sql.run(
        "INSERT INTO cal_calendars (id, name, color, kind, created_at) VALUES (?, ?, ?, 'subscription', ?)",
        id,
        input.name,
        input.color,
        this.clock.now(),
      );
      this.sql.run(
        "INSERT INTO cal_subscriptions (calendar_id, url, item_limit, refresh_ms) VALUES (?, ?, ?, ?)",
        id,
        url,
        Math.min(Math.max(input.itemLimit ?? 2000, 1), 10_000),
        Math.max(input.refreshMs ?? 3_600_000, 15 * 60_000),
      );
      this.kernel.schedule(SUBSCRIPTION_JOB, id, this.clock.now(), { calendarId: id });
      this.kernel.change("calendar", "created", { calendarId: id });

      return { calendarId: id };
    });
  }

  subscription(
    calendarId: string,
  ):
    | { url: string; etag: string | undefined; lastModified: string | undefined; itemLimit: number }
    | undefined {
    const r = this.sql.one<{
      url: string;
      etag: string | null;
      last_modified: string | null;
      item_limit: number;
    }>(
      "SELECT url, etag, last_modified, item_limit FROM cal_subscriptions WHERE calendar_id = ?",
      calendarId,
    );

    if (!r) return undefined;

    return {
      url: r.url,
      etag: r.etag ?? undefined,
      lastModified: r.last_modified ?? undefined,
      itemLimit: Number(r.item_limit),
    };
  }

  /** Apply a completed fetch: 200 replaces contents, 304 keeps them; either way schedule the next refresh. */
  applySubscriptionFetch(input: {
    calendarId: string;
    fetchId: string;
    status: "ok" | "not-modified" | "error";
    body?: string | undefined;
    etag?: string | undefined;
    lastModified?: string | undefined;
    error?: string | undefined;
  }): { imported: number; updated: number; warnings: Array<string> } {
    const commandId = `subscription:${input.fetchId}`;
    const empty = { imported: 0, updated: 0, warnings: [] as Array<string> };

    if (this.hasReceipt(commandId))
      return this.command(commandId, "ApplySubscriptionFetch", () => empty);

    const sub = this.sql.one<{ refresh_ms: number; item_limit: number }>(
      "SELECT refresh_ms, item_limit FROM cal_subscriptions WHERE calendar_id = ?",
      input.calendarId,
    );

    if (!sub) throw calendarError("not_found", "subscription not found");

    // Contents are replaced in bounded batches before the bookkeeping transaction (see importIcs).
    const result =
      input.status === "ok" && input.body !== undefined
        ? this.replaceFromIcs(input.calendarId, input.body, Number(sub.item_limit), true)
        : empty;

    return this.command(commandId, "ApplySubscriptionFetch", () => {
      this.sql.run(
        "UPDATE cal_subscriptions SET etag = COALESCE(?, etag), last_modified = COALESCE(?, last_modified), last_fetched_at = ?, last_status = ? WHERE calendar_id = ?",
        input.etag ?? null,
        input.lastModified ?? null,
        this.clock.now(),
        input.status === "error" ? `error: ${input.error ?? "unknown"}` : input.status,
        input.calendarId,
      );

      const backoff =
        input.status === "error"
          ? Math.min(Number(sub.refresh_ms) * 4, 24 * 3_600_000)
          : Number(sub.refresh_ms);

      this.kernel.schedule(SUBSCRIPTION_JOB, input.calendarId, this.clock.now() + backoff, {
        calendarId: input.calendarId,
      });
      this.kernel.change("calendar", "refreshed", {
        calendarId: input.calendarId,
        status: input.status,
      });

      return result;
    });
  }

  /** Private outbound feed: the token is hashed by the caller; only the hash is stored. */
  createFeedToken(input: {
    commandId: string;
    actor: string;
    tokenHash: string;
    calendarIds: ReadonlyArray<string>;
    label: string;
  }): void {
    this.command(input.commandId, "CreateFeedToken", () => {
      for (const id of input.calendarIds)
        if (!this.calendar(id)) throw calendarError("not_found", "calendar not found");
      this.sql.run(
        "INSERT INTO cal_feed_tokens (token_hash, calendar_ids, label, created_at) VALUES (?, ?, ?, ?)",
        input.tokenHash,
        JSON.stringify(input.calendarIds),
        input.label,
        this.clock.now(),
      );
      this.kernel.change("feed", "created", { label: input.label });

      return null;
    });
  }

  revokeFeedToken(input: { commandId: string; actor: string; tokenHash: string }): void {
    this.command(input.commandId, "RevokeFeedToken", () => {
      this.sql.run(
        "UPDATE cal_feed_tokens SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL",
        this.clock.now(),
        input.tokenHash,
      );
      this.kernel.change("feed", "revoked", {});

      return null;
    });
  }

  /** Feed tokens (C05) are listed by hash so clients can revoke them; the raw token is never stored. */
  listFeedTokens(): Array<{
    tokenHash: string;
    label: string;
    calendarIds: Array<string>;
    createdAt: number;
    revokedAt: number | undefined;
  }> {
    return this.sql
      .all<{
        token_hash: string;
        label: string;
        calendar_ids: string;
        created_at: number;
        revoked_at: number | null;
      }>(
        "SELECT token_hash, label, calendar_ids, created_at, revoked_at FROM cal_feed_tokens ORDER BY created_at DESC",
      )
      .map((r) => ({
        tokenHash: r.token_hash,
        label: r.label,
        calendarIds: json<Array<string>>(r.calendar_ids, []),
        createdAt: Number(r.created_at),
        revokedAt: r.revoked_at ?? undefined,
      }));
  }

  /**
   * Serve a private feed by token hash. Excludes journals, private notes, attendee lists, and
   * source-message backlinks; revoked tokens return undefined.
   */
  feedIcs(tokenHash: string): string | undefined {
    const token = this.sql.one<{ calendar_ids: string; revoked_at: number | null }>(
      "SELECT calendar_ids, revoked_at FROM cal_feed_tokens WHERE token_hash = ?",
      tokenHash,
    );

    if (!token || token.revoked_at !== null) return undefined;
    const ids = json<Array<string>>(token.calendar_ids, []).filter((id) => this.calendar(id));

    return calSerializeCalendar(this.eventsForExport(ids, { includeAttendees: false }), {
      now: this.clock.now(),
      method: "PUBLISH",
    });
  }
}

/** Counts and warnings from replacing a calendar's contents from ICS. */
export interface IcsReplaceResult {
  imported: number;
  updated: number;
  warnings: Array<string>;
}
