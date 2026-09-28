import {
  calendarPanelEnabled,
  type CoverOccurrence,
  coverAgenda,
  coverTimeText,
  coverWindow,
} from "@bye/native-shared/mail-calendar";
import { toLocalDate, ymd } from "@bye/native-shared/calendar-form";
import { api, client, query } from "../api.ts";
import { degrade } from "../core/degrade.ts";
import { act, errorMessage, h } from "../core/dom.ts";
import { cal, mailCommand, mb, remember, state, zone } from "../core/state.ts";

// Calendar cover panel (C09): an optional, collapsible panel in the Imbox with today's agenda and
// the next event, linking into the calendar. Whether it shows is the `calendarPanel` mailbox
// preference (so it follows the account across devices); whether it is collapsed is a per-browser
// convenience.

const COLLAPSED_KEY = "coverPanelCollapsed";

/** Whether the Imbox shows the panel; off when there is no calendar or the preference is unset. */
export const coverPanelEnabled = (signal: AbortSignal): Promise<boolean> =>
  state.calendarId
    ? api("GET", `/v1/mailboxes/${mb()}/preferences`, undefined, signal).then(
        calendarPanelEnabled,
        degrade(false),
      )
    : Promise.resolve(false);

const eventLink = (o: CoverOccurrence, now: number): HTMLElement =>
  h(
    "a",
    {
      href: `#/calendar/event/${encodeURIComponent(o.eventId)}${query({ key: o.key, cal: o.calendarId })}`,
    },
    h("span", { class: "cover-time" }, coverTimeText(o, now)),
    " ",
    o.data.summary || "(untitled)",
  );

export const coverPanel = (now: () => number = Date.now): HTMLElement => {
  const body = h("div", { class: "cover-body" });
  const today = ymd(toLocalDate(new Date(now())));
  const details = h(
    "details",
    remember.get(COLLAPSED_KEY) === "1" ? {} : { open: true },
    h("summary", { id: "cover-title" }, "Today's calendar"),
    body,
  );
  const panel = h("aside", { class: "cover-panel", "aria-labelledby": "cover-title" }, details);
  details.addEventListener("toggle", () => remember.set(COLLAPSED_KEY, details.open ? "0" : "1"));
  const footer = h(
    "p",
    { class: "cover-actions" },
    h("a", { href: `#/calendar/day/${today}` }, "Open calendar"),
    " ",
    h(
      "button",
      {
        type: "button",
        class: "link",
        onclick: act(
          "Calendar panel hidden (turn it back on in Settings)",
          () => mailCommand({ _tag: "SetPreference", key: "calendarPanel", value: false }),
          () => panel.remove(),
        ),
      },
      "Hide panel",
    ),
  );
  const load = async (): Promise<void> => {
    body.setAttribute("aria-busy", "true");
    body.replaceChildren(h("p", { role: "status" }, "Loading your calendar…"));
    try {
      const at = now();
      const { from, to } = coverWindow(at);
      const { occurrences } = await client.occurrences(cal(), from, to, zone());
      const agenda = coverAgenda(occurrences, at);
      body.replaceChildren(
        h("h2", {}, "Today"),
        agenda.today.length
          ? h(
              "ul",
              { "aria-label": "Today's events" },
              agenda.today.map((o) => h("li", {}, eventLink(o, at))),
            )
          : h("p", {}, "Nothing on your calendar today."),
        h("h2", {}, "Next"),
        agenda.next
          ? h("p", {}, eventLink(agenda.next, at))
          : h("p", {}, "Nothing else coming up this week."),
        footer,
      );
    } catch (error) {
      body.replaceChildren(
        h("p", { role: "alert" }, `Calendar unavailable: ${errorMessage(error)}`),
        h("button", { type: "button", onclick: () => void load() }, "Try again"),
        footer,
      );
    } finally {
      body.removeAttribute("aria-busy");
    }
  };
  void load();
  return panel;
};
