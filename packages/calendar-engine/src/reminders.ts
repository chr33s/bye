import { calExpand } from "./rrule.ts";
import { type CalException, calExpandSeries, type CalSeries } from "./series.ts";
import { calInstant } from "./time.ts";

// Reminder jobs reference event, occurrence, offset, and event generation (§9). Only the next
// due reminder per event is persisted as a durable job; firing schedules the following one.
// Any edit bumps the event generation so obsolete jobs are ignored when they fire.

export interface CalReminderJob {
  readonly eventId: string;
  readonly occurrenceKey: string;
  readonly offsetMinutes: number;
  readonly dueAt: number;
  readonly occurrenceStartMs: number;
  readonly generation: number;
}

/** How far ahead `calNextReminder` looks for the next due reminder. */
export const CAL_REMINDER_HORIZON_MS = 400 * 86_400_000;

export const calNextReminder = (
  eventId: string,
  generation: number,
  series: CalSeries,
  exceptions: ReadonlyArray<CalException>,
  offsetsMinutes: ReadonlyArray<number>,
  after: number,
  viewerZone = "UTC",
  horizonMs = CAL_REMINDER_HORIZON_MS,
): CalReminderJob | undefined => {
  if (offsetsMinutes.length === 0) return undefined;
  const maxOffset = Math.max(...offsetsMinutes) * 60_000;
  const occurrences = calExpandSeries(
    series,
    exceptions,
    { from: after, to: after + horizonMs + maxOffset, viewerZone },
    5000,
  );
  let best: CalReminderJob | undefined;
  for (const o of occurrences) {
    if (o.data.status === "cancelled") continue;
    for (const offset of offsetsMinutes) {
      const dueAt = o.startMs - offset * 60_000;
      if (dueAt <= after) continue;
      if (!best || dueAt < best.dueAt) {
        best = {
          eventId,
          occurrenceKey: o.key,
          offsetMinutes: offset,
          dueAt,
          occurrenceStartMs: o.startMs,
          generation,
        };
      }
    }
  }
  return best;
};

/**
 * When `calNextReminder` found nothing inside its horizon but the series still has occurrences
 * after it (an infinite rule, a far-future start, an override moved out), the instant to look
 * again — `after + horizonMs`. `undefined` when nothing can ever be due.
 */
export const calReminderRecheckAt = (
  series: CalSeries,
  exceptions: ReadonlyArray<CalException>,
  offsetsMinutes: ReadonlyArray<number>,
  after: number,
  viewerZone = "UTC",
  horizonMs = CAL_REMINDER_HORIZON_MS,
): number | undefined => {
  if (offsetsMinutes.length === 0) return undefined;
  const recheckAt = after + horizonMs;
  const later = (ms: number): boolean => ms > recheckAt;
  if (exceptions.some((e) => !e.cancelled && e.start && later(calInstant(e.start, viewerZone))))
    return recheckAt;
  const beyond = calExpand(
    { dtstart: series.dtstart, rule: series.rule, rdates: series.rdates ?? [] },
    { from: recheckAt, to: Number.MAX_SAFE_INTEGER / 2, viewerZone, maxOccurrences: 1 },
  );
  return beyond.some((o) => later(o.startMs)) ? recheckAt : undefined;
};

/** A fired job is valid only if its generation still matches the event's current generation. */
export const calReminderIsCurrent = (
  job: Pick<CalReminderJob, "generation">,
  currentGeneration: number,
): boolean => job.generation === currentGeneration;
