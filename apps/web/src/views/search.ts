import { api, list as listItems, query } from "../api.ts";
import { degrade } from "../core/degrade.ts";
import { act, h, section, show } from "../core/dom.ts";
import { cal, mailCommand, mb, state } from "../core/state.ts";

// Search (E21, C10): mail, contacts, notes, clips and files, plus calendar events/tasks/journal.
// Recent searches, bulk actions on results, and an indexing-lag notice when results may be incomplete.

interface Hit {
  readonly kind: string;
  readonly id: string;
  readonly threadId: string | null;
  readonly date: number;
  readonly snippet: string;
}

const HELP =
  'from:ana@example.com to: label: in:trash has:attachment before:2026-09-01 after: "exact phrase" -exclude';

export const renderSearch = async (params: URLSearchParams, signal: AbortSignal): Promise<void> => {
  const q = params.get("q") ?? "";
  const input = h("input", {
    type: "search",
    name: "q",
    value: q,
    "aria-label": "Search",
    "aria-describedby": "search-help",
    placeholder: "Search mail and calendar",
  });
  const results = h("div", {});
  const selected = new Set<string>();
  const form = h(
    "form",
    {
      role: "search",
      onsubmit: (e) => (
        e.preventDefault(),
        (location.hash = `#/search?q=${encodeURIComponent(input.value)}`)
      ),
    },
    input,
    h("button", { type: "submit" }, "Search"),
    h("p", { id: "search-help", class: "hint" }, HELP),
  );
  show(section("search-title", "Search", form, results));

  if (!q) {
    const recent = await listItems<{ query: string } | string>(
      `/v1/mailboxes/${mb()}/searches/recent`,
      signal,
    ).catch(degrade([]));
    if (recent.length) {
      results.append(
        h("h2", {}, "Recent searches"),
        h(
          "ul",
          {},
          recent.map((r) => {
            const text = typeof r === "string" ? r : r.query;
            return h("li", {}, h("a", { href: `#/search?q=${encodeURIComponent(text)}` }, text));
          }),
        ),
        h(
          "button",
          {
            type: "button",
            onclick: act(
              "Cleared recent searches",
              () => mailCommand({ _tag: "ClearRecentSearches" }),
              () => results.replaceChildren(),
            ),
          },
          "Clear recent searches",
        ),
      );
    }
    return;
  }

  const [mail, calendar] = await Promise.all([
    api<{ results: ReadonlyArray<Hit>; lagging: boolean; nextCursor: string | null }>(
      "GET",
      `/v1/mailboxes/${mb()}/search${query({ q, limit: 50 })}`,
      undefined,
      signal,
    ),
    state.calendarId
      ? listItems<{ kind: string; ref: string; snippet: string }>(
          `/v1/calendars/${cal()}/search${query({ q, limit: 10 })}`,
          signal,
        ).catch(degrade([]))
      : Promise.resolve([]),
  ]);
  if (mail.lagging)
    results.append(
      h(
        "p",
        { class: "notice", role: "status" },
        "Search is catching up; recent mail may be missing.",
      ),
    );
  const threadIds = () => [...selected];
  const needSelection = (fn: () => Promise<unknown>) => async () => {
    if (!selected.size) throw new Error("Select at least one result");
    await fn();
  };
  const bar = h(
    "div",
    { class: "bulk", role: "toolbar", "aria-label": "Actions for selected results" },
    h(
      "button",
      {
        type: "button",
        onclick: act(
          "Moved to trash",
          needSelection(() => mailCommand({ _tag: "MoveToTrash", threadIds: threadIds() })),
        ),
      },
      "Trash",
    ),
    h(
      "button",
      {
        type: "button",
        onclick: act(
          "Restored",
          needSelection(() => mailCommand({ _tag: "Restore", threadIds: threadIds() })),
        ),
      },
      "Restore",
    ),
    h(
      "button",
      {
        type: "button",
        onclick: act(
          "Added to Reply Later",
          needSelection(async () => {
            for (const threadId of threadIds())
              await mailCommand({ _tag: "SetAttention", threadId, flag: "replyLater", on: true });
          }),
        ),
      },
      "Reply later",
    ),
    h(
      "button",
      {
        type: "button",
        onclick: act(
          "Read All",
          needSelection(async () => {
            const batch = await mailCommand<{ batchId: string }>({
              _tag: "CreateBatch",
              threadIds: threadIds(),
            });
            location.hash = `#/batch/${encodeURIComponent(batch.batchId)}`;
          }),
        ),
      },
      "Read together",
    ),
  );
  const list = h(
    "ul",
    { class: "threads", "aria-label": "Mail results" },
    mail.results.map((hit) =>
      h(
        "li",
        { class: "thread" },
        hit.threadId
          ? h("input", {
              type: "checkbox",
              "aria-label": `Select result: ${hit.snippet.slice(0, 60)}`,
              onchange: (e) =>
                (e.target as HTMLInputElement).checked
                  ? selected.add(hit.threadId!)
                  : selected.delete(hit.threadId!),
            })
          : null,
        h(
          "a",
          {
            href: hit.threadId
              ? `#/thread/${encodeURIComponent(hit.threadId)}`
              : hit.kind === "contact"
                ? "#/contacts"
                : hit.kind === "note"
                  ? "#/notes"
                  : "#/clips",
          },
          h("span", { class: "from" }, hit.kind),
          h("span", { class: "subject" }, hit.snippet),
          h("span", { class: "snippet" }, new Date(hit.date).toLocaleDateString()),
        ),
      ),
    ),
  );
  results.append(
    h("h2", {}, "Mail"),
    mail.results.length ? h("div", {}, bar, list) : h("p", { class: "empty" }, "No mail results."),
  );
  if (calendar.length) {
    results.append(
      h("h2", {}, "Calendar"),
      h(
        "ul",
        { "aria-label": "Calendar results" },
        calendar.map((c) =>
          h(
            "li",
            {},
            h("span", { class: "badge" }, c.kind),
            " ",
            c.kind === "event"
              ? h("a", { href: `#/calendar/event/${encodeURIComponent(c.ref)}` }, c.snippet)
              : c.snippet,
          ),
        ),
      ),
    );
  }
};
