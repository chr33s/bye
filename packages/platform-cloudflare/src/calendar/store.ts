import type { KernelClock } from "../durable/kernel.ts";
import type { TransactionalStorage } from "../durable/sql.ts";
import type { CalendarStoreConfig } from "./types.ts";
import { CalendarViews } from "./views.ts";

export * from "./types.ts";

/**
 * CalendarDO authority (§3.2, §9). Owns one account's calendar space: its calendars, events,
 * invitations, reminders, week tasks, habits, time tracking, day context and journal. Journal,
 * habits, day photos/labels and time tracking are private to the owner even when an event calendar
 * is shared. Every mutation runs in one local transaction with a command receipt, a change event,
 * and any outbox work.
 *
 * The authority is layered by concern, each module extending the previous one:
 * base (storage, access primitives, records, index) → events → calendars → invitations →
 * planner → interop → views. Who may call what is decided before any of it runs, by the
 * dispatcher's exhaustive policy table (`access.ts`).
 */
export class CalendarStore extends CalendarViews {
  /** Open the authority; kernel and calendar migrations run under the initialization gate. */
  static open(
    storage: TransactionalStorage,
    clock: KernelClock,
    config: CalendarStoreConfig,
  ): CalendarStore {
    return new CalendarStore(storage, clock, config);
  }
}
