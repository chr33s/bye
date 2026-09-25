import { api, list, ApiRequestError, apiRaw, newCommandId, query } from "../api.ts";
import { degrade, bestEffort } from "../core/degrade.ts";
import {
  act,
  announce,
  errorMessage,
  field,
  formatDate,
  h,
  section,
  show,
  table,
  text,
} from "../core/dom.ts";
import { cal, calendarCommand, remember, zone } from "../core/state.ts";
import {
  addDays,
  type CalView,
  DAY_CODES,
  eventPayload,
  type EventForm,
  type LocalDate,
  monthGrid,
  nightHours,
  parseLocalDate,
  range,
  step,
  toLocalDate,
  updatePayload,
  weekStart,
  ymd,
} from "../lib/calendar.ts";

// Calendar (C01–C10): day/week/agenda/month/year views with remembered navigation and collapsible
// night hours, an event editor (recurrence, scope, attendees, reminders, location), invitations,
// week tasks, habits, the timer, day context (label, photo, journal), feeds, subscriptions and ICS.

export type { CalView };
const CAL_VIEWS: ReadonlyArray<CalView> = ["day", "week", "agenda", "month", "year"];

interface Occurrence {
  readonly revision?: number;
  readonly eventId: string;
  readonly calendarId: string;
  readonly key: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly allDay: boolean;
  readonly recurring: boolean;
  readonly data: {
    readonly summary: string;
    readonly location?: string;
    readonly description?: string;
  };
  readonly column?: number;
  readonly columns?: number;
}

interface Preferences {
  readonly firstWeekday?: number;
  readonly hour12?: boolean;
  readonly timeZone?: string;
  readonly lastView?: CalView;
  readonly lastDate?: string;
  readonly nightHoursCollapsed?: boolean;
  readonly waking?: { readonly startMinute: number; readonly endMinute: number };
}

interface CalendarInfo {
  readonly id?: string;
  readonly calendarId?: string;
  readonly name: string;
  readonly color?: string;
  readonly visible?: boolean;
  readonly kind?: string;
  readonly revision?: number;
}

const calId = (c: CalendarInfo): string => c.calendarId ?? c.id ?? "";

/** Event revisions from occurrence payloads (and command results); a stale value surfaces as a conflict. */
const revisions = new Map<string, number>();

const loadPreferences = (signal: AbortSignal) =>
  api<Preferences>("GET", `/v1/calendars/${cal()}/preferences`, undefined, signal).catch(
    degrade({} as Preferences),
  );

const loadCalendars = (signal: AbortSignal) =>
  list<CalendarInfo>(`/v1/calendars/${cal()}/calendars`, signal).catch(degrade([]));

const calendarOptions = (calendars: ReadonlyArray<CalendarInfo>) =>
  calendars.map((c) => h("option", { value: calId(c) }, c.name));

const savePreferences = (preferences: Preferences) =>
  api("PATCH", `/v1/calendars/${cal()}/preferences`, {
    commandId: newCommandId(),
    preferences,
  }).catch(bestEffort);

const toMs = (d: LocalDate) => new Date(d.year, d.month - 1, d.day).getTime();
const sameDay = (ms: number, d: LocalDate) => ymd(toLocalDate(new Date(ms))) === ymd(d);
const timeLabel = (ms: number, hour12: boolean) =>
  new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", hour12 });

const occurrenceLink = (o: Occurrence, hour12: boolean): HTMLElement =>
  h(
    "a",
    {
      href: `#/calendar/event/${encodeURIComponent(o.eventId)}${query({ key: o.key, cal: o.calendarId })}`,
      class: o.allDay ? "event all-day" : "event",
    },
    o.allDay ? "" : `${timeLabel(o.startMs, hour12)} `,
    o.data.summary || "(untitled)",
  );

const dayColumn = (
  day: LocalDate,
  occurrences: ReadonlyArray<Occurrence>,
  prefs: Preferences,
  collapsed: boolean,
): HTMLElement => {
  const night = nightHours(prefs.waking);
  const visibleStart = collapsed ? night.before : 0;
  const visibleMinutes = collapsed ? night.waking.endMinute - night.waking.startMinute : 24 * 60;
  const col = h(
    "div",
    { class: "day", role: "gridcell", "aria-label": new Date(toMs(day)).toDateString() },
    h(
      "h3",
      {},
      h(
        "a",
        { href: `#/calendar/day/${ymd(day)}` },
        new Date(toMs(day)).toLocaleDateString(undefined, { weekday: "short", day: "numeric" }),
      ),
    ),
  );
  for (const o of occurrences.filter((o) => sameDay(o.startMs, day))) {
    const start = new Date(o.startMs);
    const minute = start.getHours() * 60 + start.getMinutes();
    const top = o.allDay ? 0 : Math.max(0, ((minute - visibleStart) / visibleMinutes) * 100);
    const height = o.allDay
      ? 4
      : Math.max(2, ((o.endMs - o.startMs) / 60_000 / visibleMinutes) * 100);
    const width = 100 / (o.columns ?? 1);
    const node = occurrenceLink(o, prefs.hour12 ?? false);
    node.setAttribute(
      "style",
      `top:${top}%;height:${height}%;left:${(o.column ?? 0) * width}%;width:${width}%`,
    );
    col.append(node);
  }
  return col;
};

export const renderCalendar = async (
  params: URLSearchParams,
  signal: AbortSignal,
  routeView?: string,
  routeDate?: string,
): Promise<void> => {
  const prefs = await loadPreferences(signal);
  const view: CalView = CAL_VIEWS.includes(routeView as CalView)
    ? (routeView as CalView)
    : (prefs.lastView ?? (remember.get("calView") as CalView | null) ?? "week");
  const anchor =
    parseLocalDate(routeDate ?? params.get("date") ?? prefs.lastDate ?? "") ??
    toLocalDate(new Date());
  const firstWeekday = prefs.firstWeekday ?? 1;
  const collapsed = prefs.nightHoursCollapsed ?? false;
  const hour12 = prefs.hour12 ?? false;
  const hidden = new Set((remember.get("calHidden") ?? "").split(",").filter(Boolean));
  if (view !== prefs.lastView || ymd(anchor) !== prefs.lastDate)
    void savePreferences({ lastView: view, lastDate: ymd(anchor) });
  remember.set("calView", view);

  const calendars = await loadCalendars(signal);
  const visibleIds = calendars.map(calId).filter((id) => id && !hidden.has(id));
  const { from, days } = range(view, anchor, firstWeekday);
  const to = addDays(from, days);
  const occurrences =
    view === "year"
      ? []
      : await api<{ occurrences: ReadonlyArray<Occurrence> }>(
          "GET",
          `/v1/calendars/${cal()}/events${query({ from: new Date(toMs(from)).toISOString(), to: new Date(toMs(to)).toISOString(), tz: prefs.timeZone ?? zone(), calendarIds: visibleIds.length && hidden.size ? visibleIds.join(",") : undefined, visibleOnly: "true" })}`,
          undefined,
          signal,
        )
          .then((r) => r.occurrences)
          .catch(degrade([]));

  const nav = h(
    "div",
    { class: "bulk", role: "toolbar", "aria-label": "Calendar navigation" },
    h(
      "a",
      {
        href: `#/calendar/${view}/${ymd(step(view, anchor, -1))}`,
        class: "button",
        "aria-label": "Previous",
      },
      "‹",
    ),
    h(
      "a",
      { href: `#/calendar/${view}/${ymd(toLocalDate(new Date()))}`, class: "button" },
      "Today",
    ),
    h(
      "a",
      {
        href: `#/calendar/${view}/${ymd(step(view, anchor, 1))}`,
        class: "button",
        "aria-label": "Next",
      },
      "›",
    ),
    h("input", {
      type: "date",
      value: ymd(anchor),
      "aria-label": "Go to date",
      onchange: (e: Event) =>
        (location.hash = `#/calendar/${view}/${(e.target as HTMLInputElement).value}`),
    }),
    ...CAL_VIEWS.map((v) =>
      h(
        "a",
        {
          href: `#/calendar/${v}/${ymd(anchor)}`,
          class: v === view ? "button primary" : "button",
          "aria-current": v === view ? "page" : false,
        },
        v[0]!.toUpperCase() + v.slice(1),
      ),
    ),
    view === "day" || view === "week"
      ? h(
          "button",
          {
            type: "button",
            "aria-pressed": collapsed ? "true" : "false",
            onclick: act(
              collapsed ? "Showing night hours" : "Hiding night hours",
              () => savePreferences({ nightHoursCollapsed: !collapsed }),
              () => void renderCalendar(params, signal, view, ymd(anchor)),
            ),
          },
          collapsed ? "Show night" : "Hide night",
        )
      : null,
    h(
      "a",
      { href: `#/calendar/new${query({ date: ymd(anchor) })}`, class: "button primary" },
      "New event",
    ),
  );

  let body: HTMLElement;
  if (view === "agenda") {
    const byDay = new Map<string, Array<Occurrence>>();
    for (const o of occurrences) {
      const k = ymd(toLocalDate(new Date(o.startMs)));
      byDay.set(k, [...(byDay.get(k) ?? []), o]);
    }
    body =
      byDay.size === 0
        ? h("p", { class: "empty" }, "Nothing scheduled.")
        : h(
            "dl",
            { class: "agenda" },
            [...byDay].flatMap(([day, list]) => [
              h("dt", {}, new Date(`${day}T00:00`).toDateString()),
              h(
                "dd",
                {},
                h(
                  "ul",
                  {},
                  list.map((o) => h("li", {}, occurrenceLink(o, hour12))),
                ),
              ),
            ]),
          );
  } else if (view === "month") {
    const weeks = monthGrid(anchor.year, anchor.month, firstWeekday);
    body = h(
      "table",
      { class: "month" },
      h(
        "caption",
        {},
        new Date(anchor.year, anchor.month - 1, 1).toLocaleDateString(undefined, {
          month: "long",
          year: "numeric",
        }),
      ),
      h(
        "tbody",
        {},
        weeks.map((w) =>
          h(
            "tr",
            {},
            w.map((d) =>
              h(
                "td",
                { class: d.month === anchor.month ? "" : "muted" },
                h("a", { href: `#/calendar/day/${ymd(d)}` }, String(d.day)),
                h(
                  "ul",
                  {},
                  occurrences
                    .filter((o) => sameDay(o.startMs, d))
                    .slice(0, 3)
                    .map((o) => h("li", {}, occurrenceLink(o, hour12))),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  } else if (view === "year") {
    const overview = await api<{ counts?: Readonly<Record<string, number>> }>(
      "GET",
      `/v1/calendars/${cal()}/year/${anchor.year}${query({ tz: prefs.timeZone ?? zone() })}`,
      undefined,
      signal,
    ).catch(degrade({ counts: {} }));
    const counts = new Map<string, number>(Object.entries(overview.counts ?? {}));
    body = h(
      "div",
      { class: "year" },
      Array.from({ length: 12 }, (_, i) => {
        return h(
          "table",
          { class: "mini-month" },
          h(
            "caption",
            {},
            h(
              "a",
              { href: `#/calendar/month/${anchor.year}-${String(i + 1).padStart(2, "0")}-01` },
              new Date(anchor.year, i, 1).toLocaleDateString(undefined, { month: "short" }),
            ),
          ),
          h(
            "tbody",
            {},
            monthGrid(anchor.year, i + 1, firstWeekday).map((w) =>
              h(
                "tr",
                {},
                w.map((d) =>
                  h(
                    "td",
                    { class: d.month === i + 1 ? (counts.get(ymd(d)) ? "busy" : "") : "muted" },
                    d.month === i + 1
                      ? h(
                          "a",
                          {
                            href: `#/calendar/day/${ymd(d)}`,
                            "aria-label": `${ymd(d)}, ${counts.get(ymd(d)) ?? 0} events`,
                          },
                          String(d.day),
                        )
                      : "",
                  ),
                ),
              ),
            ),
          ),
        );
      }),
    );
  } else {
    const daysShown =
      view === "day" ? [anchor] : Array.from({ length: 7 }, (_, i) => addDays(from, i));
    body = h(
      "div",
      {
        class: view === "day" ? "week single" : "week",
        role: "grid",
        "aria-label": view === "day" ? "Day" : "Week",
      },
      daysShown.map((d) => dayColumn(d, occurrences, prefs, collapsed)),
    );
  }

  const calendarList = h(
    "details",
    {},
    h("summary", {}, "Calendars"),
    h(
      "ul",
      {},
      calendars.map((c) =>
        h(
          "li",
          {},
          h(
            "label",
            {},
            h("input", {
              type: "checkbox",
              checked: !hidden.has(calId(c)),
              onchange: (e: Event) => {
                const next = new Set(hidden);
                if ((e.target as HTMLInputElement).checked) next.delete(calId(c));
                else next.add(calId(c));
                remember.set("calHidden", [...next].join(","));
                void renderCalendar(params, signal, view, ymd(anchor));
              },
            }),
            h("span", { class: "swatch", style: `background:${c.color ?? "#1f3a5f"}` }),
            ` ${c.name}`,
          ),
        ),
      ),
    ),
    h(
      "p",
      {},
      h("a", { href: "#/calendar/manage" }, "Manage calendars, feeds and subscriptions"),
      " · ",
      h("a", { href: "#/calendar/planning" }, "Tasks, habits and timer"),
      " · ",
      h("a", { href: `#/calendar/context/${ymd(anchor)}` }, "Day notes"),
    ),
  );

  show(
    section(
      "calendar-title",
      view === "year"
        ? String(anchor.year)
        : new Date(toMs(anchor)).toLocaleDateString(undefined, { month: "long", year: "numeric" }),
      nav,
      calendarList,
      body,
    ),
  );
};

const localInput = (ms: number | undefined, allDay: boolean): string => {
  if (ms === undefined) return "";
  const d = new Date(ms);
  const date = ymd(toLocalDate(d));
  return allDay
    ? date
    : `${date}T${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

/** Event editor (C02/C03/C10): create, or edit with an explicit this/future/series scope. */
export const renderEventEditor = async (
  eventId: string | undefined,
  params: URLSearchParams,
  signal: AbortSignal,
): Promise<void> => {
  const calendars = await loadCalendars(signal);
  let existing: Occurrence | undefined;
  if (eventId) {
    const key = params.get("key") ?? "";
    const around = key
      ? Date.parse(`${key.slice(0, 4)}-${key.slice(4, 6)}-${key.slice(6, 8)}T00:00:00Z`)
      : Date.now();
    const window = await api<{ occurrences: ReadonlyArray<Occurrence> }>(
      "GET",
      `/v1/calendars/${cal()}/events${query({ from: new Date(around - 40 * 86_400_000).toISOString(), to: new Date(around + 40 * 86_400_000).toISOString(), tz: zone() })}`,
      undefined,
      signal,
    ).catch(degrade({ occurrences: [] }));
    existing =
      window.occurrences.find((o) => o.eventId === eventId && (!key || o.key === key)) ??
      window.occurrences.find((o) => o.eventId === eventId);
  }
  const date = params.get("date") ?? ymd(toLocalDate(new Date()));
  const allDay = h("input", { type: "checkbox", checked: existing?.allDay ?? false });
  const title = h("input", {
    required: true,
    value: existing?.data.summary ?? params.get("title") ?? "",
    autocomplete: "off",
  });
  const start = h("input", {
    value: existing ? localInput(existing.startMs, existing.allDay) : `${date}T09:00`,
  });
  const end = h("input", {
    value: existing ? localInput(existing.endMs, existing.allDay) : `${date}T10:00`,
  });
  const tz = h("input", { value: zone(), "aria-describedby": "tz-help" });
  const calendarSelect = h(
    "select",
    {},
    calendars.map((c) =>
      h(
        "option",
        { value: calId(c), selected: calId(c) === (existing?.calendarId ?? params.get("cal")) },
        c.name,
      ),
    ),
  );
  const frequency = h(
    "select",
    {},
    ["none", "DAILY", "WEEKLY", "MONTHLY", "YEARLY"].map((f) =>
      h("option", { value: f }, f === "none" ? "Doesn't repeat" : f.toLowerCase()),
    ),
  );
  const interval = h("input", { type: "number", min: "1", value: "1" });
  const byDay = DAY_CODES.map((d) => h("input", { type: "checkbox", value: d, "aria-label": d }));
  const endsKind = h(
    "select",
    {},
    h("option", { value: "never" }, "Forever"),
    h("option", { value: "count" }, "After N times"),
    h("option", { value: "until" }, "Until date"),
  );
  const endsValue = h("input", { placeholder: "count or YYYY-MM-DD" });
  const place = h("input", {
    value: existing?.data.location ?? "",
    list: "location-suggestions",
    autocomplete: "off",
  });
  const suggestions = h("datalist", { id: "location-suggestions" });
  place.addEventListener("input", async () => {
    if (place.value.length < 3) return;
    // Typing-time suggestions: a failed lookup just offers none.
    const found =
      (await list<{ label: string; address?: string }>(
        `/v1/locations${query({ q: place.value })}`,
      ).catch(bestEffort)) ?? [];
    suggestions.replaceChildren(
      ...found.map((f) => h("option", { value: f.address ? `${f.label}, ${f.address}` : f.label })),
    );
  });
  const description = h("textarea", { rows: "4" }, existing?.data.description ?? "");
  const attendees = h("input", { placeholder: "a@example.com, b@example.com" });
  const reminders = h("input", { value: "10", placeholder: "minutes before, comma-separated" });
  const scope = h(
    "select",
    {},
    h("option", { value: "this" }, "Only this event"),
    h("option", { value: "future" }, "This and future events"),
    h("option", { value: "series" }, "All events in the series"),
  );
  const errors = h("ul", { class: "errors", role: "alert" });

  const form = (): EventForm => {
    const kind = endsKind.value as "never" | "count" | "until";
    return {
      calendarId: calendarSelect.value,
      title: title.value,
      allDay: allDay.checked,
      start: start.value,
      end: end.value,
      timeZone: tz.value || zone(),
      frequency: frequency.value as EventForm["frequency"],
      interval: Number(interval.value) || 1,
      byDay: byDay.filter((b) => b.checked).map((b) => b.value),
      ends:
        kind === "count"
          ? { kind, count: Number(endsValue.value) }
          : kind === "until"
            ? { kind, until: parseLocalDate(endsValue.value) ?? toLocalDate(new Date()) }
            : { kind: "never" },
      location: place.value,
      description: description.value,
      attendees: attendees.value,
      reminders: reminders.value,
    };
  };

  const save = async (event: Event) => {
    event.preventDefault();
    const built = existing
      ? updatePayload(
          existing.eventId,
          existing.revision ?? revisions.get(existing.eventId) ?? 1,
          scope.value as "this" | "future" | "series",
          existing.key,
          form(),
        )
      : eventPayload(form());
    if (!built.ok) {
      errors.replaceChildren(...built.errors.map((e) => h("li", {}, `${e.field}: ${e.message}`)));
      return;
    }
    try {
      const result = await calendarCommand<{ revision?: number; eventId?: string }>(built.command);
      if (result?.eventId && result.revision) revisions.set(result.eventId, result.revision);
      announce(existing ? "Event updated" : "Event created");
      location.hash = `#/calendar/day/${form().start.slice(0, 10)}`;
    } catch (error) {
      if (error instanceof ApiRequestError && error.status === 409) {
        errors.replaceChildren(
          h(
            "li",
            {},
            "This event changed elsewhere. Reload it before saving so no one's edit is lost.",
          ),
        );
      } else {
        errors.replaceChildren(h("li", {}, errorMessage(error)));
      }
    }
  };

  const respond = (partstat: "ACCEPTED" | "TENTATIVE" | "DECLINED") =>
    act(`Replied ${partstat.toLowerCase()}`, () =>
      calendarCommand({
        type: "RespondInvitation",
        eventId: existing!.eventId,
        partstat,
        ...(existing!.recurring ? { occurrenceKey: existing!.key } : {}),
      }),
    );

  show(
    section(
      "event-title",
      existing ? "Edit event" : "New event",
      h(
        "form",
        { class: "compose", onsubmit: save },
        errors,
        field("Title", title),
        field("Calendar", calendarSelect),
        h("label", {}, allDay, " All day"),
        field("Starts (YYYY-MM-DDTHH:mm)", start),
        field("Ends", end),
        field("Time zone (IANA)", tz),
        h(
          "p",
          { id: "tz-help", class: "muted" },
          "Times are stored as wall-clock times in this zone, so they follow daylight-saving changes.",
        ),
        h(
          "fieldset",
          {},
          h("legend", {}, "Repeat"),
          frequency,
          field("Every", interval),
          h(
            "div",
            {},
            byDay.map((b, i) => h("label", {}, b, ` ${DAY_CODES[i]}`)),
          ),
          endsKind,
          endsValue,
        ),
        field("Location", place),
        suggestions,
        field("Description", description),
        field("Invite (addresses)", attendees),
        field("Reminders (minutes before)", reminders),
        existing?.recurring ? field("Apply changes to", scope) : null,
        h(
          "div",
          { class: "bulk" },
          h("button", { type: "submit", class: "primary" }, "Save"),
          h("a", { href: "#/calendar", class: "button" }, "Cancel"),
        ),
      ),
      existing
        ? h(
            "div",
            { class: "bulk", "aria-label": "Invitation response" },
            h("button", { type: "button", onclick: respond("ACCEPTED") }, "Accept"),
            h("button", { type: "button", onclick: respond("TENTATIVE") }, "Maybe"),
            h("button", { type: "button", onclick: respond("DECLINED") }, "Decline"),
            h(
              "button",
              {
                type: "button",
                class: "danger",
                onclick: act(
                  "Deleted",
                  () =>
                    calendarCommand({
                      type: "DeleteEvent",
                      eventId: existing!.eventId,
                      scope: existing!.recurring ? (scope.value as "this") : "series",
                      ...(existing!.recurring ? { occurrenceKey: existing!.key } : {}),
                    }),
                  () => (location.hash = "#/calendar"),
                ),
              },
              "Delete",
            ),
          )
        : null,
    ),
  );
};

/** Week tasks (C06), habits and the timer (C07). */
export const renderPlanning = async (signal: AbortSignal): Promise<void> => {
  const today = toLocalDate(new Date());
  const prefs = await loadPreferences(signal);
  const firstWeekday = prefs.firstWeekday ?? 1;
  const monday = weekStart(today, firstWeekday);
  const [tasks, habits, timer, entries] = await Promise.all([
    list<{
      id?: string;
      taskId?: string;
      title: string;
      completed?: boolean;
      completedAt?: number | null;
    }>(
      `/v1/calendars/${cal()}/week-tasks${query({ date: ymd(today), firstWeekday: String(firstWeekday) })}`,
      signal,
    ).catch(degrade([])),
    list<{ id?: string; habitId?: string; name: string; completed?: ReadonlyArray<string> }>(
      `/v1/calendars/${cal()}/habits${query({ from: ymd(addDays(today, -6)), to: ymd(today) })}`,
      signal,
    ).catch(degrade([])),
    api<{
      active?: { id?: string; entryId?: string; label: string; startedAt: number } | null;
    } | null>("GET", `/v1/calendars/${cal()}/timer`, undefined, signal).catch(degrade(null)),
    list<{ label: string; startedAt: number; stoppedAt: number | null }>(
      `/v1/calendars/${cal()}/time-entries${query({ from: new Date(toMs(today)).toISOString(), to: new Date(toMs(addDays(today, 1))).toISOString() })}`,
      signal,
    ).catch(degrade([])),
  ]);
  const reload = () => void renderPlanning(signal);
  const taskTitle = h("input", {
    "aria-label": "New task this week",
    placeholder: "Something for this week",
  });
  const habitName = h("input", { "aria-label": "New habit" });
  const timerLabel = h("input", { "aria-label": "What are you working on?" });
  const active =
    timer?.active ??
    (timer && "label" in (timer as object)
      ? (timer as unknown as { label: string; startedAt: number })
      : null);
  const tid = (t: { id?: string; taskId?: string }) => t.taskId ?? t.id ?? "";
  const hid = (x: { id?: string; habitId?: string }) => x.habitId ?? x.id ?? "";
  show(
    section(
      "planning-title",
      "Tasks, habits and time",
      h("h2", {}, `Sometime this week (from ${new Date(toMs(monday)).toLocaleDateString()})`),
      h(
        "ul",
        { class: "tasks" },
        tasks.map((t) =>
          h(
            "li",
            {},
            h(
              "label",
              {},
              h("input", {
                type: "checkbox",
                checked: Boolean(t.completed ?? t.completedAt),
                onchange: (e: Event) =>
                  void act("Updated", () =>
                    calendarCommand({
                      type: "CompleteWeekTask",
                      taskId: tid(t),
                      completed: (e.target as HTMLInputElement).checked,
                    }),
                  )(),
              }),
              ` ${t.title}`,
            ),
            h(
              "button",
              {
                type: "button",
                onclick: act(
                  "Moved to next week",
                  () =>
                    calendarCommand({
                      type: "MoveWeekTask",
                      taskId: tid(t),
                      date: addDays(monday, 7),
                      firstWeekday,
                    }),
                  reload,
                ),
              },
              "Next week",
            ),
            h(
              "a",
              {
                href: `#/calendar/new${query({ title: t.title, date: ymd(today) })}`,
                class: "button",
              },
              "Schedule",
            ),
            h(
              "button",
              {
                type: "button",
                class: "danger",
                onclick: act(
                  "Deleted",
                  () => calendarCommand({ type: "DeleteWeekTask", taskId: tid(t) }),
                  reload,
                ),
              },
              "Delete",
            ),
          ),
        ),
      ),
      h(
        "form",
        {
          class: "bulk",
          onsubmit: act(
            "Added",
            () =>
              calendarCommand({
                type: "AddWeekTask",
                date: today,
                firstWeekday,
                title: taskTitle.value,
              }),
            reload,
          ),
        },
        taskTitle,
        h("button", { type: "submit" }, "Add"),
      ),
      h("h2", {}, "Habits (last 7 days)"),
      table(
        "Habits",
        habits,
        [
          ["Habit", (x) => text(x.name)],
          ...Array.from({ length: 7 }, (_, i) => {
            const d = addDays(today, i - 6);
            return [
              new Date(toMs(d)).toLocaleDateString(undefined, { weekday: "narrow" }),
              (x: Record<string, unknown>) => {
                const done = ((x.completed as ReadonlyArray<string> | undefined) ?? []).includes(
                  ymd(d),
                );
                return h("input", {
                  type: "checkbox",
                  checked: done,
                  "aria-label": `${text(x.name)} on ${ymd(d)}`,
                  onchange: (e: Event) =>
                    void act("Saved", () =>
                      calendarCommand({
                        type: "SetHabitCompletion",
                        habitId: hid(x),
                        date: d,
                        completed: (e.target as HTMLInputElement).checked,
                      }),
                    )(),
                });
              },
            ] as const;
          }),
          [
            "",
            (x) =>
              h(
                "button",
                {
                  type: "button",
                  onclick: act(
                    "Archived",
                    () => calendarCommand({ type: "ArchiveHabit", habitId: hid(x) }),
                    reload,
                  ),
                },
                "Archive",
              ),
          ],
        ],
        "No habits yet.",
      ),
      h(
        "form",
        {
          class: "bulk",
          onsubmit: act(
            "Habit added",
            () =>
              calendarCommand({
                type: "CreateHabit",
                name: habitName.value,
                weekdays: [0, 1, 2, 3, 4, 5, 6],
              }),
            reload,
          ),
        },
        habitName,
        h("button", { type: "submit" }, "Add habit"),
      ),
      h("h2", {}, "Timer"),
      active
        ? h(
            "p",
            {},
            `Tracking “${active.label}” since ${new Date(active.startedAt).toLocaleTimeString()} `,
            h(
              "button",
              {
                type: "button",
                onclick: act("Timer stopped", () => calendarCommand({ type: "StopTimer" }), reload),
              },
              "Stop",
            ),
          )
        : h(
            "form",
            {
              class: "bulk",
              onsubmit: act(
                "Timer started",
                () => calendarCommand({ type: "StartTimer", label: timerLabel.value || "Focus" }),
                reload,
              ),
            },
            timerLabel,
            h("button", { type: "submit" }, "Start"),
          ),
      table(
        "Today",
        entries,
        [
          ["What", (e) => text(e.label)],
          ["Started", (e) => formatDate(e.startedAt)],
          [
            "Minutes",
            (e) =>
              e.stoppedAt ? String(Math.round((e.stoppedAt - e.startedAt) / 60_000)) : "running",
          ],
        ],
        "No time tracked today.",
      ),
    ),
  );
};

/** Day context (C08): label, background photo, private journal. */
export const renderDayContext = async (dateText: string, signal: AbortSignal): Promise<void> => {
  const date = parseLocalDate(dateText) ?? toLocalDate(new Date());
  const context = await api<{
    label?: string | null;
    photoUrl?: string | null;
    journal?: { body: string; revision: number } | null;
  }>("GET", `/v1/calendars/${cal()}/days/${ymd(date)}/context`, undefined, signal).catch(
    degrade(
      {} as { label?: string; photoUrl?: string; journal?: { body: string; revision: number } },
    ),
  );
  const label = h("input", { value: context.label ?? "", "aria-label": "Name this day" });
  const journal = h(
    "textarea",
    { rows: "8", "aria-label": "Journal (private)" },
    context.journal?.body ?? "",
  );
  const photo = h("input", {
    type: "file",
    accept: "image/jpeg,image/png,image/webp,image/gif",
    "aria-label": "Background photo",
  });
  const reload = () => void renderDayContext(ymd(date), signal);
  show(
    section(
      "day-title",
      new Date(toMs(date)).toDateString(),
      context.photoUrl
        ? h("img", {
            src: context.photoUrl,
            alt: "Background photo for this day",
            class: "day-photo",
          })
        : null,
      h(
        "form",
        {
          class: "bulk",
          onsubmit: act(
            "Saved",
            () => calendarCommand({ type: "SetDayDecoration", date, label: label.value || null }),
            reload,
          ),
        },
        label,
        h("button", { type: "submit" }, "Save name"),
      ),
      h(
        "div",
        { class: "bulk" },
        photo,
        h(
          "button",
          {
            type: "button",
            onclick: act(
              "Photo uploaded",
              async () => {
                const file = photo.files?.[0];
                if (!file) throw new Error("Choose a photo first");
                await apiRaw(
                  "POST",
                  `/v1/calendars/${cal()}/days/${ymd(date)}/photo`,
                  file,
                  file.type,
                );
              },
              reload,
            ),
          },
          "Upload photo",
        ),
      ),
      h("h2", {}, "Journal"),
      h("p", { class: "muted" }, "Only you can see this, even on shared calendars."),
      journal,
      h(
        "button",
        {
          type: "button",
          onclick: act(
            "Journal saved",
            () =>
              calendarCommand({
                type: "WriteJournal",
                date,
                body: journal.value,
                expectedRevision: context.journal?.revision ?? 0,
              }),
            reload,
          ),
        },
        "Save journal",
      ),
    ),
  );
};

/** Calendars, sharing grants, private feeds, subscriptions and ICS import/export (C05). */
export const renderCalendarManage = async (signal: AbortSignal): Promise<void> => {
  const [calendars, tokens] = await Promise.all([
    loadCalendars(signal),
    list<{ tokenHash?: string; hash?: string; label: string; createdAt: number }>(
      `/v1/calendars/${cal()}/feed-tokens`,
      signal,
    ).catch(degrade([])),
  ]);
  const reload = () => void renderCalendarManage(signal);
  const newName = h("input", { "aria-label": "Calendar name" });
  const newColor = h("input", { type: "color", value: "#1f3a5f", "aria-label": "Color" });
  const subName = h("input", { "aria-label": "Subscription name" });
  const subUrl = h("input", {
    type: "url",
    placeholder: "https://…/calendar.ics",
    "aria-label": "Feed URL",
  });
  const feedLabel = h("input", { "aria-label": "Feed label", placeholder: "e.g. Work phone" });
  const feedResult = h("div", { role: "status", "aria-live": "polite" });
  const importFile = h("input", {
    type: "file",
    accept: ".ics,text/calendar",
    "aria-label": "ICS file",
  });
  const importTarget = h("select", { "aria-label": "Import into" }, calendarOptions(calendars));
  const grantee = h("input", { type: "email", "aria-label": "Share with (address or user)" });
  const grantCal = h("select", { "aria-label": "Calendar to share" }, calendarOptions(calendars));
  const grantRole = h(
    "select",
    { "aria-label": "Permission" },
    h("option", { value: "read" }, "Can view"),
    h("option", { value: "write" }, "Can edit"),
  );
  show(
    section(
      "calmanage-title",
      "Calendars",
      table("Calendars", calendars, [
        ["Name", (c) => text(c.name)],
        ["Kind", (c) => text(c.kind ?? "local")],
        [
          "",
          (c) =>
            h(
              "button",
              {
                type: "button",
                class: "danger",
                onclick: act(
                  "Deleted",
                  () =>
                    calendarCommand({
                      type: "DeleteCalendar",
                      calendarId: calId(c),
                    }),
                  reload,
                ),
              },
              "Delete",
            ),
        ],
      ]),
      h(
        "form",
        {
          class: "bulk",
          onsubmit: act(
            "Calendar created",
            () =>
              calendarCommand({
                type: "CreateCalendar",
                name: newName.value,
                color: newColor.value,
              }),
            reload,
          ),
        },
        newName,
        newColor,
        h("button", { type: "submit" }, "Add calendar"),
      ),
      h("h2", {}, "Share a calendar"),
      h(
        "form",
        {
          class: "bulk",
          onsubmit: act(
            "Shared",
            () =>
              calendarCommand({
                type: "GrantCalendar",
                calendarId: grantCal.value,
                grantee: grantee.value,
                role: grantRole.value as "read",
              }),
            reload,
          ),
        },
        grantCal,
        grantee,
        grantRole,
        h("button", { type: "submit" }, "Share"),
      ),
      h("h2", {}, "Subscribe to a calendar (read-only)"),
      h(
        "form",
        {
          class: "bulk",
          onsubmit: act(
            "Subscribed",
            () =>
              calendarCommand({
                type: "AddSubscription",
                name: subName.value || subUrl.value,
                color: "#7a5c9e",
                url: subUrl.value,
              }),
            reload,
          ),
        },
        subName,
        subUrl,
        h("button", { type: "submit" }, "Subscribe"),
      ),
      h("h2", {}, "Private feed links"),
      h(
        "p",
        { class: "muted" },
        "Anyone with a feed link can read your events (never your journal or private notes). Revoke links you no longer use.",
      ),
      table(
        "Feed links",
        tokens,
        [
          ["Label", (t) => text(t.label)],
          ["Created", (t) => formatDate(t.createdAt)],
          [
            "",
            (t) =>
              h(
                "button",
                {
                  type: "button",
                  class: "danger",
                  onclick: act(
                    "Revoked",
                    () =>
                      api(
                        "DELETE",
                        `/v1/calendars/${cal()}/feed-tokens/${encodeURIComponent(text(t.tokenHash ?? t.hash))}`,
                      ),
                    reload,
                  ),
                },
                "Revoke",
              ),
          ],
        ],
        "No feed links.",
      ),
      h(
        "form",
        {
          class: "bulk",
          onsubmit: act("Feed link created", async () => {
            const r = await api<{ token: string; url: string }>(
              "POST",
              `/v1/calendars/${cal()}/feed-tokens`,
              {
                schemaVersion: 1,
                commandId: newCommandId(),
                calendarIds: calendars.map(calId),
                label: feedLabel.value || "Feed",
              },
            );
            feedResult.replaceChildren(
              h("p", {}, "Copy this link now — it won't be shown again:"),
              h("code", { class: "token" }, r.url),
            );
          }),
        },
        feedLabel,
        h("button", { type: "submit" }, "Create feed link"),
      ),
      feedResult,
      h("h2", {}, "Import and export"),
      h(
        "p",
        {},
        h(
          "a",
          { href: `/v1/calendars/${cal()}/export.ics`, download: "calendar.ics", class: "button" },
          "Export all (.ics)",
        ),
      ),
      h(
        "div",
        { class: "bulk" },
        importFile,
        importTarget,
        h(
          "button",
          {
            type: "button",
            onclick: act(
              "Imported",
              async () => {
                const file = importFile.files?.[0];
                if (!file) throw new Error("Choose an .ics file");
                await api("POST", `/v1/calendars/${cal()}/import`, {
                  commandId: newCommandId(),
                  calendarId: importTarget.value,
                  ics: await file.text(),
                });
              },
              reload,
            ),
          },
          "Import",
        ),
      ),
    ),
  );
};
