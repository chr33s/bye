import { avatarToneIndex, mailViewLabel, senderInitials } from "@bye/native-shared/views";
import { bestEffort } from "../core/degrade.ts";
import { api, list, query, type ThreadRow, type ViewPage } from "../api.ts";
import { act, announce, choice, h, section, show } from "../core/dom.ts";
import { mailCommand, mb } from "../core/state.ts";
import { appendPage, emptyPaged, type Paged } from "../lib/paging.ts";
import { coverPanel, coverPanelEnabled } from "./cover-panel.ts";

// Mailbox views (E01–E10, E24): paging, Screener bulk decisions, Spam/Screened Out/Trash restore and
// empty, attention piles (Reply Later, Set Aside, Bubble Up), Focus & Reply, Read Together, the
// expanded Feed with visit markers, and a unified view across linked mailboxes.

const EMPTY = new Map([
  ["screener", "Nobody is waiting to be screened."],
  ["reply-later", "Nothing to reply to later."],
  ["set-aside", "Nothing set aside."],
  ["bubble-up", "No follow-ups."],
  ["spam", "No spam."],
  ["screened-out", "Nobody screened out."],
  ["trash", "Trash is empty."],
]);

const DISPOSITIONS = ["spam", "screened-out", "trash"] as const;

const DISPOSITION_VIEWS: ReadonlySet<string> = new Set(DISPOSITIONS);

const DESTINATIONS = ["imbox", "feed", "paper-trail"] as const;

const addressOf = (sender: string): string => /<([^>]+)>/.exec(sender)?.[1] ?? sender;

const refresh = () => window.dispatchEvent(new HashChangeEvent("hashchange"));

interface ListState {
  readonly view: string;
  paged: Paged<ThreadRow>;
  boundary: number;
  readonly selected: Set<string>;
}

const rowActions = (row: ThreadRow, view: string): HTMLElement => {
  const id = row.threadId;

  const attention = (flag: "replyLater" | "setAside" | "unfollowed", on: boolean, label: string) =>
    h(
      "button",
      {
        type: "button",
        onclick: act(
          label,
          () => mailCommand({ _tag: "SetAttention", threadId: id, flag, on }),
          refresh,
        ),
      },
      label,
    );

  if (view === "screener") {
    const sender = addressOf(row.sender);

    return h(
      "div",
      { class: "row-actions", role: "group", "aria-label": `Screen ${sender}` },
      h(
        "button",
        {
          type: "button",
          onclick: act(`Approved ${sender}`, () => screen([sender], "allow"), refresh),
        },
        "Yes",
      ),
      h(
        "button",
        {
          type: "button",
          onclick: act(`Screened out ${sender}`, () => screen([sender], "block"), refresh),
        },
        "No",
      ),
    );
  }

  if (DISPOSITION_VIEWS.has(view)) {
    return h(
      "div",
      { class: "row-actions" },
      h(
        "button",
        {
          type: "button",
          onclick: act(
            "Restored",
            () => mailCommand({ _tag: "Restore", threadIds: [id] }),
            refresh,
          ),
        },
        "Restore",
      ),
    );
  }

  const buttons: Array<HTMLElement> = [];

  if (view === "set-aside") buttons.push(attention("setAside", false, "Done"));
  else if (view === "reply-later") buttons.push(attention("replyLater", false, "Done"));
  else if (view === "bubble-up") {
    buttons.push(
      h(
        "button",
        {
          type: "button",
          onclick: act(
            "Back in the Inbox",
            () => mailCommand({ _tag: "PopBubble", threadId: id }),
            refresh,
          ),
        },
        "Pop",
      ),
      h(
        "button",
        {
          type: "button",
          onclick: act(
            "Cleared",
            () => mailCommand({ _tag: "ClearBubble", threadId: id }),
            refresh,
          ),
        },
        "Clear",
      ),
    );
  } else {
    buttons.push(
      attention("replyLater", true, "Reply later"),
      attention("setAside", true, "Set aside"),
    );
  }

  return h("div", { class: "row-actions" }, buttons);
};

const screen = (
  senders: ReadonlyArray<string>,
  decision: "allow" | "block",
  extra: { destination?: string; asSeen?: boolean; reply?: boolean } = {},
) =>
  mailCommand({
    _tag: "Screen",
    decisions: senders.map((sender) =>
      decision === "allow"
        ? {
            sender,
            decision,
            destination: choice(extra.destination ?? "imbox", DESTINATIONS, "imbox"),
            asSeen: extra.asSeen || undefined,
            reply: extra.reply || undefined,
          }
        : { sender, decision },
    ),
  });

const threadItem = (row: ThreadRow, s: ListState): HTMLElement => {
  const selectBox = h("input", {
    type: "checkbox",
    "aria-label": `Select ${row.subject || "(no subject)"}`,
    checked: s.selected.has(row.threadId),
    onchange: (e) =>
      (e.target as HTMLInputElement).checked
        ? s.selected.add(row.threadId)
        : s.selected.delete(row.threadId),
  });

  const bubble = row.attention?.bubble;

  const badges = [
    row.newSinceVisit ? h("span", { class: "badge" }, "New since last visit") : null,
    row.quarantined ? h("span", { class: "badge warn" }, "Quarantined") : null,
    bubble?._tag === "Scheduled"
      ? h(
          "span",
          { class: "badge" },
          `Follow-up ${new Date(bubble.at).toLocaleString()}${bubble.condition === "if-no-reply" ? " if no reply" : ""}`,
        )
      : null,
    bubble?._tag === "Pinned" ? h("span", { class: "badge" }, "Pinned") : null,
    ...(row.labels ?? []).map((l) => h("span", { class: "label" }, l)),
  ];

  const bundle = row.bundleCount > 1 && row.bundleKey;

  return h(
    "li",
    { class: row.newForYou ? "thread unseen" : "thread", "data-thread": row.threadId },
    selectBox,
    h(
      "a",
      {
        href: bundle
          ? `#/bundle/${encodeURIComponent(row.bundleKey!)}`
          : `#/thread/${encodeURIComponent(row.threadId)}`,
      },
      h(
        "span",
        {
          class: `avatar tone-${avatarToneIndex(row.sender)}`,
          "aria-hidden": "true",
        },
        senderInitials(row.sender),
      ),
      h("span", { class: "from" }, bundle ? `${row.sender} (${row.bundleCount})` : row.sender),
      h("span", { class: "subject" }, row.subject || "(no subject)"),
      h("span", { class: "snippet" }, row.snippet ?? "", ...badges),
    ),
    rowActions(row, s.view),
  );
};

const readTogether = async (threadIds: ReadonlyArray<string> | "new-for-you") => {
  const batch = await mailCommand<{ batchId: string }>({ _tag: "CreateBatch", threadIds });
  location.hash = `#/batch/${encodeURIComponent(batch.batchId)}`;
};

const bulkBar = (s: ListState): HTMLElement => {
  const ids = () => [...s.selected];

  const senders = () => [
    ...new Set(
      s.paged.items.filter((r) => s.selected.has(r.threadId)).map((r) => addressOf(r.sender)),
    ),
  ];

  const need =
    <R>(fn: () => Promise<R>) =>
    async () => {
      if (s.selected.size === 0) throw new Error("Select at least one conversation");
      await fn();
      s.selected.clear();
    };

  const buttons: Array<HTMLElement> = [];

  if (s.view === "screener") {
    const dest = h(
      "select",
      { "aria-label": "Approve into" },
      h("option", { value: "imbox" }, "Inbox"),
      h("option", { value: "feed" }, "Newsletters"),
      h("option", { value: "paper-trail" }, "Receipts"),
    );

    buttons.push(
      dest,
      h(
        "button",
        {
          type: "button",
          onclick: act(
            "Approved",
            need(() => screen(senders(), "allow", { destination: dest.value })),
            refresh,
          ),
        },
        "Approve selected",
      ),
      h(
        "button",
        {
          type: "button",
          onclick: act(
            "Approved as seen",
            need(() => screen(senders(), "allow", { destination: dest.value, asSeen: true })),
            refresh,
          ),
        },
        "Approve as seen",
      ),
      h(
        "button",
        {
          type: "button",
          onclick: act(
            "Approved",
            need(async () => {
              const first = s.paged.items.find((r) => s.selected.has(r.threadId));
              await screen(senders(), "allow", { destination: dest.value, reply: true });

              if (first) location.hash = `#/compose?thread=${encodeURIComponent(first.threadId)}`;
            }),
          ),
        },
        "Approve and reply",
      ),
      h(
        "button",
        {
          type: "button",
          onclick: act(
            "Screened out",
            need(() => screen(senders(), "block")),
            refresh,
          ),
        },
        "Screen out selected",
      ),
      // Clearing the list never approves anyone (E01): it only dismisses what was shown.
      h(
        "button",
        {
          type: "button",
          onclick: act(
            "Cleared New Senders",
            () => mailCommand({ _tag: "ClearScreener", boundary: s.boundary }),
            refresh,
          ),
        },
        "Clear list",
      ),
    );
  } else if (DISPOSITION_VIEWS.has(s.view)) {
    buttons.push(
      h(
        "button",
        {
          type: "button",
          onclick: act(
            "Restored",
            need(() => mailCommand({ _tag: "Restore", threadIds: ids() })),
            refresh,
          ),
        },
        "Restore selected",
      ),
      h(
        "button",
        {
          type: "button",
          class: "danger",
          onclick: act(
            "Emptied",
            async () => {
              if (!confirm(`Permanently delete everything in ${s.view}?`))
                throw new Error("Cancelled");
              await mailCommand({
                _tag: "Empty",
                disposition: choice(s.view, DISPOSITIONS, "trash"),
              });
            },
            refresh,
          ),
        },
        `Empty ${s.view.replace("-", " ")}`,
      ),
    );
  } else {
    buttons.push(
      h(
        "button",
        {
          type: "button",
          onclick: act(
            "Read All",
            need(() => readTogether(ids())),
          ),
        },
        "Read together",
      ),
      h(
        "button",
        {
          type: "button",
          onclick: act(
            "Moved to trash",
            need(() => mailCommand({ _tag: "MoveToTrash", threadIds: ids() })),
            refresh,
          ),
        },
        "Trash",
      ),
      h(
        "button",
        {
          type: "button",
          onclick: act(
            "Marked spam",
            need(() => mailCommand({ _tag: "MarkSpam", threadIds: ids() })),
            refresh,
          ),
        },
        "Spam",
      ),
    );
    const when = h("input", { type: "datetime-local", "aria-label": "Follow up at" });
    buttons.push(
      when,
      h(
        "button",
        {
          type: "button",
          onclick: act(
            "Scheduled",
            need(async () => {
              const at = Date.parse(when.value);

              if (!Number.isFinite(at)) throw new Error("Pick a date and time");

              for (const threadId of ids()) await mailCommand({ _tag: "BubbleUp", threadId, at });
            }),
            refresh,
          ),
        },
        "Follow up",
      ),
      h(
        "button",
        {
          type: "button",
          onclick: act(
            "Pinned",
            need(async () => {
              for (const threadId of ids()) await mailCommand({ _tag: "PinBubble", threadId });
            }),
            refresh,
          ),
        },
        "Pin now",
      ),
    );

    if (s.view === "reply-later")
      buttons.unshift(h("a", { href: "#/focus", class: "button primary" }, "Reply Queue"));

    if (s.view === "imbox")
      buttons.unshift(
        h(
          "button",
          {
            type: "button",
            onclick: act("Read All", () => readTogether("new-for-you")),
          },
          "Power through new",
        ),
      );
  }

  return h(
    "div",
    { class: "bulk", role: "toolbar", "aria-label": "Actions for selected conversations" },
    buttons,
  );
};

export const renderView = async (
  view: string,
  signal: AbortSignal,
  label?: string,
): Promise<void> => {
  const title = mailViewLabel(view) ?? (label ? `Label: ${label}` : view);
  const s: ListState = { view, paged: emptyPaged(), boundary: 0, selected: new Set() };
  const list = h("ul", { class: "threads" });
  const more = h("button", { type: "button", class: "more" }, "Load more");
  const body = h("div", {});

  const load = async () => {
    const page = await api<ViewPage>(
      "GET",
      `/v1/mailboxes/${mb()}/views/${label ? "label" : view}${query({ cursor: s.paged.cursor, limit: 50, label })}`,
      undefined,
      signal,
    );

    if (!s.boundary) s.boundary = page.boundary;
    s.paged = appendPage(s.paged, page, (r) => r.threadId);
    renderRows();
  };

  const renderRows = () => {
    body.replaceChildren();

    if (s.paged.items.length === 0) {
      body.append(h("div", { class: "empty" }, h("p", {}, EMPTY.get(view) ?? "Nothing here.")));
    } else if (view === "imbox") {
      const fresh = s.paged.items.filter((r) => r.newForYou);
      const seen = s.paged.items.filter((r) => !r.newForYou);

      if (fresh.length) {
        body.append(
          h("h2", {}, "New for you"),
          h(
            "button",
            {
              type: "button",
              class: "link",
              onclick: act(
                "Marked all seen",
                () => mailCommand({ _tag: "MarkAllSeen", view, boundary: s.boundary }),
                refresh,
              ),
            },
            "Mark all seen",
          ),
          h(
            "ul",
            { class: "threads" },
            fresh.map((r) => threadItem(r, s)),
          ),
        );
      }

      if (seen.length)
        body.append(
          h("h2", {}, "Previously seen"),
          h(
            "ul",
            { class: "threads" },
            seen.map((r) => threadItem(r, s)),
          ),
        );
    } else {
      list.replaceChildren(...s.paged.items.map((r) => threadItem(r, s)));
      body.append(list);
    }

    more.hidden = s.paged.done;
  };

  more.addEventListener("click", act("Loaded more", load));
  // The calendar cover panel (C09) is optional and shown in the Imbox only.
  const cover = view === "imbox" && !label ? coverPanelEnabled(signal) : Promise.resolve(false);
  // If the list itself fails, the route's error state wins; the preference read is then moot.
  cover.catch(bestEffort);
  await load();

  if (view === "feed" || view === "paper-trail")
    void mailCommand({ _tag: "VisitView", view }).catch(bestEffort);
  show(
    section(
      "view-title",
      title,
      (await cover) ? coverPanel() : null,
      s.paged.items.length ? bulkBar(s) : null,
      body,
      more,
    ),
  );
};

/** Expanded Feed (E05): newsletters rendered in place, lazily, with visit markers and remembered position. */
export const renderFeed = async (signal: AbortSignal): Promise<void> => {
  type FeedItem = {
    thread: ThreadRow;
    latest: { deliveryId: string; renderUrl: string; subject: string; date: number } | null;
  };

  let cursor: string | null = null;
  const list = h("ol", { class: "feed" });
  const more = h("button", { type: "button", class: "more" }, "Load more");
  let previousVisitAt = 0;
  let position: string | null = null;

  const load = async () => {
    const page = await api<{
      items: ReadonlyArray<FeedItem>;
      nextCursor: string | null;
      position: string | null;
      previousVisitAt: number;
    }>("GET", `/v1/mailboxes/${mb()}/feed${query({ cursor, limit: 10 })}`, undefined, signal);

    previousVisitAt = previousVisitAt || page.previousVisitAt;
    position = position ?? page.position;

    for (const item of page.items) {
      const fresh = item.thread.newSinceVisit || (item.latest?.date ?? 0) > previousVisitAt;

      const frame = item.latest
        ? h("iframe", {
            title: item.latest.subject || "Newsletter",
            sandbox: "allow-popups allow-popups-to-escape-sandbox",
            referrerpolicy: "no-referrer",
            loading: "lazy",
            src: item.latest.renderUrl,
          })
        : null;

      const details = h(
        "details",
        { open: true, "data-thread": item.thread.threadId },
        h(
          "summary",
          {},
          fresh ? h("span", { class: "badge" }, "New") : null,
          ` ${item.thread.sender} — ${item.thread.subject || "(no subject)"}`,
        ),
        frame,
        h(
          "a",
          { href: `#/thread/${encodeURIComponent(item.thread.threadId)}` },
          "Open conversation",
        ),
      );

      details.addEventListener("toggle", () => {
        if (details.open)
          void mailCommand({
            _tag: "SetViewPosition",
            view: "feed",
            position: item.thread.threadId,
          }).catch(bestEffort);
      });
      list.append(h("li", {}, details));
    }

    cursor = page.nextCursor;
    more.hidden = cursor === null;
  };

  more.addEventListener("click", act("Loaded more", load));
  await load();
  void mailCommand({ _tag: "VisitView", view: "feed" }).catch(bestEffort);

  const collapseAll = h(
    "button",
    {
      type: "button",
      onclick: () => list.querySelectorAll("details").forEach((d) => (d.open = false)),
    },
    "Collapse all",
  );

  const expandAll = h(
    "button",
    {
      type: "button",
      onclick: () => list.querySelectorAll("details").forEach((d) => (d.open = true)),
    },
    "Expand all",
  );

  show(
    section(
      "view-title",
      "Newsletters",
      h(
        "div",
        { class: "bulk" },
        collapseAll,
        expandAll,
        h("a", { href: "#/mail/feed" }, "List view"),
      ),
      list,
      more,
    ),
  );

  if (position) list.querySelector(`[data-thread="${CSS.escape(position)}"]`)?.scrollIntoView();
};

interface ThreadDetailLite {
  readonly thread: {
    readonly threadId: string;
    readonly subject: string;
    readonly revision: number;
  };
  readonly deliveries: ReadonlyArray<{
    readonly deliveryId: string;
    readonly from: { readonly name?: string; readonly address: string };
    readonly renderUrl: string;
  }>;
}

const sequential = async <R>(
  title: string,
  threadIds: ReadonlyArray<string>,
  signal: AbortSignal,
  onDone: (threadId: string) => Promise<R>,
) => {
  let index = 0;
  const pane = h("div", {});

  const render = async () => {
    if (index >= threadIds.length) {
      pane.replaceChildren(h("p", { class: "empty" }, "All done."));

      return;
    }

    const id = threadIds[index]!;

    const detail = await api<ThreadDetailLite>(
      "GET",
      `/v1/mailboxes/${mb()}/threads/${encodeURIComponent(id)}`,
      undefined,
      signal,
    );

    const latest = detail.deliveries.at(-1);
    pane.replaceChildren(
      h(
        "h2",
        {},
        `${index + 1} of ${threadIds.length}: ${detail.thread.subject || "(no subject)"}`,
      ),
      ...(latest
        ? [
            h("iframe", {
              title: `Latest message from ${latest.from.name || latest.from.address}`,
              sandbox: "allow-popups allow-popups-to-escape-sandbox",
              referrerpolicy: "no-referrer",
              src: latest.renderUrl,
            }),
          ]
        : []),
      h(
        "div",
        { class: "bulk" },
        h(
          "a",
          {
            href: `#/compose?thread=${encodeURIComponent(id)}&afterSend=done&return=${encodeURIComponent(location.hash)}`,
            class: "button primary",
          },
          "Reply",
        ),
        h(
          "button",
          {
            type: "button",
            onclick: act("Done", async () => {
              await onDone(id);
              index++;
              await render();
            }),
          },
          "Done, next",
        ),
        h(
          "button",
          {
            type: "button",
            onclick: async () => {
              index++;
              await render();
            },
          },
          "Skip",
        ),
      ),
    );
    void mailCommand({
      _tag: "MarkSeen",
      threadId: id,
      observedRevision: detail.thread.revision,
    }).catch(bestEffort);
  };

  await render();
  show(section("view-title", title, pane));
};

/** Focus & Reply (E07): Reply Later threads one at a time, distraction-free. */
export const renderFocus = async (signal: AbortSignal): Promise<void> => {
  const queue = await list<{ thread?: ThreadRow; threadId?: string }>(
    `/v1/mailboxes/${mb()}/focus`,
    signal,
  );

  await sequential(
    "Reply Queue",
    queue.map((q) => (q.thread?.threadId ?? q.threadId) as string),
    signal,
    (threadId) => mailCommand({ _tag: "SetAttention", threadId, flag: "replyLater", on: false }),
  );
};

/** Read Together (E10): a fixed batch; new arrivals never reorder it while working through. */
export const renderBatch = async (batchId: string, signal: AbortSignal): Promise<void> => {
  const batch = await list<{ thread: ThreadRow }>(
    `/v1/mailboxes/${mb()}/batches/${encodeURIComponent(batchId)}`,
    signal,
  );

  await sequential(
    "Read All",
    batch.map((b) => b.thread.threadId),
    signal,
    async () => undefined,
  );
};

export const renderBundle = async (bundleKey: string, signal: AbortSignal): Promise<void> => {
  const rows = await list<ThreadRow>(
    `/v1/mailboxes/${mb()}/bundles/${encodeURIComponent(bundleKey)}`,
    signal,
  );

  const s: ListState = {
    view: "bundle",
    paged: { items: rows, cursor: null, done: true },
    boundary: 0,
    selected: new Set(),
  };

  show(
    section(
      "view-title",
      `Bundle: ${rows[0]?.sender ?? bundleKey}`,
      h(
        "ul",
        { class: "threads" },
        rows.map((r) => threadItem(r, s)),
      ),
    ),
  );
};

/** Unified view across the principal's mailboxes with identity badges (E19). */
export const renderUnified = async (view: string, signal: AbortSignal): Promise<void> => {
  type Row = {
    mailboxId: string;
    identity: { address: string; name: string | null } | null;
    thread: ThreadRow;
  };

  let cursor: string | null = null;
  const list = h("ul", { class: "threads" });
  const more = h("button", { type: "button", class: "more" }, "Load more");

  const load = async () => {
    const page = await api<{ items: ReadonlyArray<Row>; cursor: string | null }>(
      "GET",
      `/v1/unified/views/${encodeURIComponent(view)}${query({ cursor })}`,
      undefined,
      signal,
    );

    for (const r of page.items) {
      list.append(
        h(
          "li",
          { class: r.thread.newForYou ? "thread unseen" : "thread" },
          h(
            "a",
            {
              href: `#/thread/${encodeURIComponent(r.thread.threadId)}?mailbox=${encodeURIComponent(r.mailboxId)}`,
            },
            h("span", { class: "from" }, r.thread.sender),
            h("span", { class: "subject" }, r.thread.subject || "(no subject)"),
            h(
              "span",
              { class: "snippet" },
              h("span", { class: "badge" }, r.identity?.address ?? r.mailboxId),
            ),
          ),
        ),
      );
    }

    cursor = page.cursor;
    more.hidden = cursor === null;
  };

  more.addEventListener("click", act("Loaded more", load));
  await load();

  if (!list.children.length) list.append(h("li", { class: "empty" }, "Nothing here."));
  show(section("view-title", `All accounts: ${view}`, list, more));
  announce(`${list.children.length} conversations`);
};
