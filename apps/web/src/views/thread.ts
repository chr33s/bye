import {
  firstCalendarId,
  fromMessagePayload,
  findThreadInvitations,
  PARTSTAT_LABEL,
  RSVP_CHOICES,
} from "@bye/native-shared/mail-calendar";
import { api, list, apiDownload, client } from "../api.ts";
import { degrade, bestEffort } from "../core/degrade.ts";
import { act, choice, field, formatDate, formatSize, h, show } from "../core/dom.ts";
import { cal, mailCommand, mb, state, withStepUp, zone } from "../core/state.ts";

// Thread view (E11–E15, E19, E20, C09): sandboxed message rendering, attachments gated on scan state,
// rename / merge / unmerge with visible history, labels, notes, clips, workflow boards, redelivery,
// invitation responses and create-event-from-message.

interface Delivery {
  readonly deliveryId: string;
  readonly from: { readonly name?: string; readonly address: string };
  readonly to?: ReadonlyArray<{ readonly name?: string; readonly address: string }>;
  readonly subject?: string;
  readonly date: number;
  readonly renderUrl: string;
  readonly attachments: ReadonlyArray<{
    readonly partId: string;
    readonly filename: string;
    readonly size: number;
    readonly contentType?: string;
  }>;
  readonly scan: { readonly status: string };
  readonly routing?: { readonly hasCalendar?: boolean; readonly calendarMethod?: string | null };
}

interface ThreadDetail {
  readonly thread: {
    readonly threadId: string;
    readonly subject: string;
    readonly revision: number;
    readonly labels?: ReadonlyArray<string>;
    readonly attention?: { readonly unfollowed: boolean };
  };
  readonly deliveries: ReadonlyArray<Delivery>;
  readonly mergeHistory?: ReadonlyArray<{
    readonly mergeId: string;
    readonly sources: ReadonlyArray<string>;
    readonly at: number;
    readonly undone: boolean;
  }>;
}

const SCAN_NOTICE: Readonly<Record<string, string>> = {
  pending: "Scanning attachments…",
  infected: "Attachments blocked: a threat was detected.",
  failed: "Attachments blocked: they couldn't be scanned.",
};

const fromText = (from: Delivery["from"]) => from.name || from.address;
const reload = () => window.dispatchEvent(new HashChangeEvent("hashchange"));

const attachmentList = (d: Delivery): HTMLElement | null => {
  if (d.attachments.length === 0) return null;
  const notice = SCAN_NOTICE[d.scan.status];
  const base = `/v1/mailboxes/${mb()}/deliveries/${encodeURIComponent(d.deliveryId)}/attachments`;
  const list = h(
    "ul",
    { class: "attachments", "aria-label": "Attachments" },
    d.attachments.map((a) => {
      const label = `${a.filename} (${formatSize(a.size)})`;
      if (notice) return h("li", {}, h("span", { "aria-disabled": "true" }, label));
      const previewable = /^(image\/(png|jpeg|gif|webp)|text\/plain)/.test(a.contentType ?? "");
      return h(
        "li",
        {},
        h("a", { href: `${base}/${encodeURIComponent(a.partId)}`, download: a.filename }, label),
        previewable
          ? h(
              "a",
              {
                href: `${base}/${encodeURIComponent(a.partId)}/preview`,
                target: "_blank",
                rel: "noopener noreferrer",
              },
              " Preview",
            )
          : null,
      );
    }),
  );
  const zip =
    !notice && d.attachments.length > 1
      ? h(
          "button",
          {
            type: "button",
            onclick: act("Preparing download", async () => {
              await apiDownload(
                `/v1/mailboxes/${mb()}/attachments/zip`,
                {
                  items: d.attachments.map((a) => ({ deliveryId: d.deliveryId, partId: a.partId })),
                },
                "attachments.zip",
              );
            }),
          },
          "Download all",
        )
      : null;
  return h(
    "div",
    {},
    notice ? h("p", { class: "notice", role: "status" }, notice) : null,
    list,
    zip,
  );
};

/** Invitation actions (C09): the events this message carried, the current answer, and iTIP replies. */
const invitationPanel = (subject: string, deliveryId: string): HTMLElement => {
  const out = h(
    "div",
    { class: "invitation", role: "group", "aria-label": "Invitation" },
    h("p", {}, "This message contains a calendar invitation."),
  );
  const status = h("p", { role: "status" }, "Looking for the event in your calendar…");
  out.append(status);
  void (async () => {
    try {
      const events = await findThreadInvitations(client, cal(), mb(), deliveryId, subject);
      status.textContent = events.length ? "" : "The event hasn't reached your calendar yet.";
      for (const e of events) {
        const answer = h("span", { class: "muted" }, e.answer ? ` · ${e.answer}` : "");
        out.append(
          h(
            "div",
            { class: "bulk", role: "group", "aria-label": `Respond to ${e.label}` },
            h("span", {}, e.label),
            answer,
            e.cancelled
              ? h("span", {}, " · Cancelled by the organizer")
              : RSVP_CHOICES.map(([partstat, label]) =>
                  h(
                    "button",
                    {
                      type: "button",
                      onclick: act(label, async () => {
                        await client.respondInvitation(
                          cal(),
                          e.eventId,
                          partstat,
                          e.occurrenceKey ?? undefined,
                        );
                        answer.textContent = ` · ${PARTSTAT_LABEL[partstat]}`;
                      }),
                    },
                    label,
                  ),
                ),
          ),
        );
      }
    } catch {
      status.textContent = "Calendar unavailable.";
    }
  })();
  return out;
};

const createEventForm = (threadId: string, subject: string, d: Delivery): HTMLElement => {
  const title = h("input", { value: subject, required: true });
  const start = h("input", { type: "datetime-local", required: true });
  const end = h("input", { type: "datetime-local", required: true });
  return h(
    "details",
    {},
    h("summary", {}, "Create event from this message"),
    h(
      "form",
      {
        class: "compose",
        onsubmit: act("Event created", async () => {
          const { items } = await client.calendars(cal());
          const calendarId = firstCalendarId(items);
          if (!calendarId) throw new Error("Create a calendar first");
          const built = fromMessagePayload({
            calendarId,
            mailboxId: mb(),
            threadId,
            deliveryId: d.deliveryId,
            title: title.value,
            start: start.value,
            end: end.value,
            timeZone: zone(),
          });
          if (!built.ok) throw new Error(built.errors.join("; "));
          await client.createEventFromMessage(cal(), built.body);
        }),
      },
      field("Title", title),
      field("Starts", start),
      field("Ends", end),
      h("button", { type: "submit" }, "Create event"),
    ),
  );
};

const organizePanel = async (detail: ThreadDetail, signal: AbortSignal): Promise<HTMLElement> => {
  const threadId = detail.thread.threadId;
  const [labels, boards, notes] = await Promise.all([
    list<{ labelId: string; name: string }>(`/v1/mailboxes/${mb()}/labels`, signal).catch(
      degrade([]),
    ),
    list<{ boardId: string; name: string }>(`/v1/mailboxes/${mb()}/workflows`, signal).catch(
      degrade([]),
    ),
    list<{ noteId: string; body: string; updatedAt?: number }>(
      `/v1/mailboxes/${mb()}/notes?threadId=${encodeURIComponent(threadId)}`,
      signal,
    ).catch(degrade([])),
  ]);
  const current = new Set(detail.thread.labels ?? []);
  const labelSelect = h(
    "select",
    { "aria-label": "Label" },
    labels.map((l) => h("option", { value: l.name }, l.name)),
  );
  const newLabel = h("input", { placeholder: "or new label", "aria-label": "New label" });
  const boardSelect = h(
    "select",
    { "aria-label": "Workflow board" },
    boards.map((b) => h("option", { value: b.boardId }, b.name)),
  );
  const noteBody = h("textarea", { rows: 3, "aria-label": "Private note" });
  const clipText = h("textarea", {
    rows: 2,
    "aria-label": "Clip text (paste the passage to keep)",
  });
  const rename = h("input", { value: detail.thread.subject, "aria-label": "Subject" });
  const mergeWith = h("input", {
    placeholder: "thread ID to merge in",
    "aria-label": "Thread to merge into this one",
  });
  const others = (state.me?.mailboxIds ?? []).filter((m) => m !== mb());
  const target = h(
    "select",
    { "aria-label": "Account" },
    others.map((m) => h("option", { value: m }, m)),
  );
  const mode = h(
    "select",
    { "aria-label": "Redelivery mode" },
    h("option", { value: "copy" }, "Copy"),
    h("option", { value: "move" }, "Move"),
  );
  const latest = detail.deliveries.at(-1);
  return h(
    "aside",
    { class: "organize", "aria-label": "Organize this conversation" },
    h("h2", {}, "Labels"),
    h(
      "p",
      {},
      [...current].map((l) =>
        h(
          "button",
          {
            type: "button",
            class: "label",
            title: `Remove ${l}`,
            onclick: act(
              `Removed ${l}`,
              () => mailCommand({ _tag: "SetThreadLabels", threadId, add: [], remove: [l] }),
              reload,
            ),
          },
          `${l} ×`,
        ),
      ),
    ),
    h(
      "form",
      {
        onsubmit: act(
          "Labelled",
          () =>
            mailCommand({
              _tag: "SetThreadLabels",
              threadId,
              add: [newLabel.value.trim() || labelSelect.value].filter(Boolean),
              remove: [],
            }),
          reload,
        ),
      },
      labelSelect,
      newLabel,
      h("button", { type: "submit" }, "Add label"),
    ),
    boards.length ? h("h2", {}, "Workflow") : null,
    boards.length
      ? h(
          "form",
          {
            onsubmit: act("Added to workflow", () =>
              mailCommand({ _tag: "AddToBoard", boardId: boardSelect.value, threadId }),
            ),
          },
          boardSelect,
          h("button", { type: "submit" }, "Add to board"),
        )
      : null,
    h("h2", {}, "Private notes"),
    h(
      "ul",
      {},
      notes.map((n) =>
        h(
          "li",
          {},
          n.body,
          " ",
          h(
            "button",
            {
              type: "button",
              "aria-label": "Delete note",
              onclick: act(
                "Note deleted",
                () => mailCommand({ _tag: "DeleteNote", noteId: n.noteId }),
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
        onsubmit: act(
          "Note saved",
          () => mailCommand({ _tag: "PutNote", kind: "thread", threadId, body: noteBody.value }),
          reload,
        ),
      },
      noteBody,
      h("button", { type: "submit" }, "Add note"),
    ),
    latest ? h("h2", {}, "Clip") : null,
    latest
      ? h(
          "form",
          {
            onsubmit: act("Clipped", () =>
              mailCommand({
                _tag: "CreateClip",
                threadId,
                deliveryId: latest.deliveryId,
                text: clipText.value,
              }),
            ),
          },
          clipText,
          h("button", { type: "submit" }, "Save clip"),
        )
      : null,
    h("h2", {}, "Conversation"),
    h(
      "form",
      {
        onsubmit: act(
          "Renamed",
          () =>
            mailCommand({ _tag: "RenameThread", threadId, subject: rename.value.trim() || null }),
          reload,
        ),
      },
      field("Local subject", rename),
      h("button", { type: "submit" }, "Rename"),
      h(
        "button",
        {
          type: "button",
          onclick: act(
            "Original subject restored",
            () => mailCommand({ _tag: "RenameThread", threadId, subject: null }),
            reload,
          ),
        },
        "Restore original",
      ),
    ),
    h(
      "form",
      {
        onsubmit: act(
          "Merged",
          () =>
            mailCommand({
              _tag: "MergeThreads",
              targetId: threadId,
              sourceIds: [mergeWith.value.trim()],
            }),
          reload,
        ),
      },
      mergeWith,
      h("button", { type: "submit" }, "Merge"),
    ),
    detail.mergeHistory?.length
      ? h(
          "ul",
          { "aria-label": "Merge history" },
          detail.mergeHistory.map((m) =>
            h(
              "li",
              {},
              `${m.undone ? "Undone" : "Merged"} ${m.sources.length} thread(s) on ${formatDate(m.at)} `,
              m.undone
                ? null
                : h(
                    "button",
                    {
                      type: "button",
                      onclick: act(
                        "Unmerged",
                        () => mailCommand({ _tag: "UnmergeThreads", mergeId: m.mergeId }),
                        reload,
                      ),
                    },
                    "Unmerge",
                  ),
            ),
          ),
        )
      : null,
    others.length && latest
      ? h(
          "form",
          {
            onsubmit: act("Redelivered", () =>
              withStepUp(() =>
                mailCommand({
                  _tag: "Redeliver",
                  deliveryId: latest.deliveryId,
                  targetMailboxId: target.value,
                  mode: choice(mode.value, ["copy", "move"], "copy"),
                }),
              ),
            ),
          },
          h("h2", {}, "Send to another account"),
          target,
          mode,
          h("button", { type: "submit" }, "Redeliver"),
        )
      : null,
  );
};

export const renderThread = async (threadId: string, signal: AbortSignal): Promise<void> => {
  const detail = await api<ThreadDetail>(
    "GET",
    `/v1/mailboxes/${mb()}/threads/${encodeURIComponent(threadId)}`,
    undefined,
    signal,
  );
  const t = detail.thread;
  const unfollowed = t.attention?.unfollowed ?? false;
  const replyDraft = (modeName: "reply" | "reply-all" | "forward") =>
    act("Opening draft", async () => {
      const draft = await mailCommand<{ draftId: string } | string>({
        _tag: "CreateReplyDraft",
        threadId,
        mode: modeName,
      });
      const id = typeof draft === "string" ? draft : draft.draftId;
      location.hash = `#/compose?draft=${encodeURIComponent(id)}&thread=${encodeURIComponent(threadId)}`;
    });
  const article = h(
    "article",
    { "aria-labelledby": "thread-title" },
    h("h1", { id: "thread-title" }, t.subject || "(no subject)"),
    h(
      "div",
      { class: "bulk", role: "toolbar", "aria-label": "Conversation actions" },
      h("button", { type: "button", class: "primary", onclick: replyDraft("reply") }, "Reply"),
      h("button", { type: "button", onclick: replyDraft("reply-all") }, "Reply all"),
      h("button", { type: "button", onclick: replyDraft("forward") }, "Forward"),
      h(
        "button",
        {
          type: "button",
          onclick: act(
            "Marked unseen",
            () => mailCommand({ _tag: "MarkUnseen", threadId }),
            reload,
          ),
        },
        "Mark unseen",
      ),
      h(
        "button",
        {
          type: "button",
          onclick: act(
            unfollowed ? "Following" : "Unfollowed",
            () =>
              mailCommand({ _tag: "SetAttention", threadId, flag: "unfollowed", on: !unfollowed }),
            reload,
          ),
        },
        unfollowed ? "Follow" : "Unfollow",
      ),
      h(
        "button",
        {
          type: "button",
          onclick: act(
            "Moved to trash",
            () => mailCommand({ _tag: "MoveToTrash", threadIds: [threadId] }),
            () => history.back(),
          ),
        },
        "Trash",
      ),
      h("a", { href: `#/share?thread=${encodeURIComponent(threadId)}`, class: "button" }, "Share…"),
      h("button", { type: "button", onclick: () => window.print() }, "Print"),
    ),
  );
  for (const d of detail.deliveries) {
    article.append(
      h(
        "section",
        { class: "message", "aria-label": `Message from ${fromText(d.from)}` },
        h(
          "header",
          {},
          h("strong", {}, fromText(d.from)),
          " ",
          h(
            "time",
            { datetime: new Date(d.date).toISOString() },
            new Date(d.date).toLocaleString(),
          ),
        ),
        d.routing?.hasCalendar ? invitationPanel(t.subject, d.deliveryId) : null,
        h("iframe", {
          title: `Message from ${fromText(d.from)}`,
          sandbox: "allow-popups allow-popups-to-escape-sandbox",
          referrerpolicy: "no-referrer",
          loading: "lazy",
          src: d.renderUrl,
        }),
        attachmentList(d),
        createEventForm(threadId, t.subject, d),
      ),
    );
  }
  article.append(await organizePanel(detail, signal));
  show(article);
  void mailCommand({ _tag: "MarkSeen", threadId, observedRevision: t.revision }).catch(bestEffort);
};
