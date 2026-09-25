// Calendar editor and navigation helpers live in @bye/native-shared so web and native share one
// tested implementation.
export * from "@bye/native-shared/calendar-form";

import { addDays, type LocalDate, weekStart } from "@bye/native-shared/calendar-form";

export type CalView = "day" | "week" | "agenda" | "month" | "year";

/** The dates a calendar view loads around its anchor date. */
export const range = (
  view: CalView,
  anchor: LocalDate,
  firstWeekday: number,
): { from: LocalDate; days: number } => {
  switch (view) {
    case "day":
      return { from: anchor, days: 1 };
    case "week":
      return { from: weekStart(anchor, firstWeekday), days: 7 };
    case "agenda":
      return { from: anchor, days: 14 };
    case "month":
      // The grid opens on the week containing the 1st, so load from there (at most six weeks).
      return {
        from: weekStart({ year: anchor.year, month: anchor.month, day: 1 }, firstWeekday),
        days: 42,
      };
    case "year":
      return { from: { year: anchor.year, month: 1, day: 1 }, days: 366 };
  }
};

/** The anchor date one page before or after `anchor` in a view (month and year pages start on day 1). */
export const step = (view: CalView, anchor: LocalDate, dir: 1 | -1): LocalDate => {
  if (view === "day") return addDays(anchor, dir);
  if (view === "week") return addDays(anchor, 7 * dir);
  if (view === "agenda") return addDays(anchor, 14 * dir);
  if (view === "month") {
    const m = anchor.month + dir;
    return { year: anchor.year + Math.floor((m - 1) / 12), month: ((m - 1 + 12) % 12) + 1, day: 1 };
  }
  return { year: anchor.year + dir, month: 1, day: 1 };
};
