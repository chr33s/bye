import type { MailAddress, MailThreadSummary } from "@bye/contracts";

// Response shapes the clients read that @bye/contracts does not (yet) define as schemas. Every
// shape that DOES have a contract (views, drafts, commands, search, occurrences, …) is imported as
// a type from @bye/contracts directly; type imports are erased, so no Effect code reaches the
// React Native bundle.

export type MailThreadSummaryWire = typeof MailThreadSummary.Type;

export interface DeliveryWire {
  readonly deliveryId: string;
  readonly from: MailAddress;
  readonly to: ReadonlyArray<MailAddress>;
  readonly cc: ReadonlyArray<MailAddress>;
  readonly subject: string;
  readonly date: number;
  readonly snippet: string;
  /** Short-lived capability URL on the separate render origin (§10). */
  readonly renderUrl: string;
  readonly attachments?: ReadonlyArray<{
    readonly partId: string;
    readonly filename: string;
    readonly contentType: string;
    readonly size: number;
  }>;
  /** Whole-message scan state; attachments download only when clean (E20). */
  readonly scan?: {
    readonly status: "pending" | "clean" | "infected" | "failed" | "not-required" | "legacy";
    readonly signature?: string | null;
  };
}

export interface ThreadDetailWire {
  readonly thread: MailThreadSummaryWire;
  readonly deliveries: ReadonlyArray<DeliveryWire>;
}

export interface MeWire {
  readonly userId: string;
  readonly kind: "user" | "agent" | "cli";
  readonly scopes: ReadonlyArray<string>;
  readonly mailboxIds: ReadonlyArray<string>;
  readonly calendarIds: ReadonlyArray<string>;
  readonly organizationIds: ReadonlyArray<string>;
}

/** Calendar wire shapes (C06/C07/C10) used by the planning and widget surfaces. */
export interface WeekTaskWire {
  readonly id?: string;
  readonly taskId?: string;
  readonly title: string;
  readonly completed?: boolean;
  readonly completedAt?: number | null;
}

export interface HabitWire {
  readonly id?: string;
  readonly habitId?: string;
  readonly name: string;
  /** Dates (YYYY-MM-DD) completed within the requested range. */
  readonly completed?: ReadonlyArray<string>;
}

export interface TimerWire {
  readonly active?: {
    readonly id?: string;
    readonly label: string;
    readonly startedAt: number;
  } | null;
}

export interface WidgetWire {
  readonly upcoming?: ReadonlyArray<{
    readonly startMs: number;
    readonly data: { readonly summary: string };
  }>;
  readonly activeTimer?: { readonly label: string; readonly startedAt: number } | null;
  readonly weekTasks?: ReadonlyArray<WeekTaskWire>;
  readonly today?: string;
}

export interface DeviceSessionWire {
  readonly id: string;
  readonly clientId: string;
  readonly deviceName: string;
  readonly createdAt: number;
  readonly lastUsedAt: number;
}
