import { api, list, apiDownload, apiRaw, query } from "../api.ts";
import { degrade } from "../core/degrade.ts";
import {
  act,
  choice,
  field,
  formatDate,
  formatSize,
  h,
  section,
  show,
  table,
  text,
} from "../core/dom.ts";
import { mailCommand, mb } from "../core/state.ts";

// Organization screens (E02, E11–E16, E20): contacts and groups with vCard import/export and sender
// history, labels, rules, workflow boards, collections, notes, clips, sender policies with history
// and revert, the attachment library and revocable large-file links.

const reload = () => window.dispatchEvent(new HashChangeEvent("hashchange"));
const csv = (value: string) =>
  value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

interface Contact {
  readonly contactId: string;
  readonly name: string;
  readonly emails: ReadonlyArray<string>;
  readonly notes: string;
  readonly groups: ReadonlyArray<string>;
}

export const renderContacts = async (
  params: URLSearchParams,
  signal: AbortSignal,
): Promise<void> => {
  const q = params.get("q") ?? "";
  const contacts = await list<Contact>(`/v1/mailboxes/${mb()}/contacts${query({ q })}`, signal);
  const search = h("input", { type: "search", value: q, "aria-label": "Search contacts" });
  const name = h("input", { required: true });
  const emails = h("input", { required: true, placeholder: "a@example.com, b@example.com" });
  const groups = h("input", { placeholder: "Family, Work" });
  const notes = h("textarea", { rows: 2 });
  const vcard = h("input", { type: "file", accept: ".vcf,text/vcard" });
  const history = h("div", { "aria-live": "polite" });
  const groupNames = [...new Set(contacts.flatMap((c) => c.groups))].sort();
  show(
    section(
      "contacts-title",
      "Contacts",
      h(
        "form",
        {
          role: "search",
          onsubmit: (e) => (
            e.preventDefault(),
            (location.hash = `#/contacts?q=${encodeURIComponent(search.value)}`)
          ),
        },
        search,
        h("button", { type: "submit" }, "Search"),
      ),
      groupNames.length
        ? h(
            "p",
            {},
            "Groups: ",
            groupNames.map((g) =>
              h("a", { href: `#/contacts?q=${encodeURIComponent(g)}`, class: "label" }, g),
            ),
          )
        : null,
      table("Contacts", contacts, [
        ["Name", (c) => text(c.name)],
        ["Addresses", (c) => c.emails.join(", ")],
        ["Groups", (c) => c.groups.join(", ")],
        ["Notes", (c) => text(c.notes)],
        [
          "",
          (c) => [
            h(
              "button",
              {
                type: "button",
                onclick: act("Loaded history", async () => {
                  const address = c.emails[0] ?? "";
                  const items = await list<{ threadId: string; subject: string; date: number }>(
                    `/v1/mailboxes/${mb()}/senders/${encodeURIComponent(address)}/history`,
                  );
                  history.replaceChildren(
                    h("h2", {}, `History with ${address}`),
                    h(
                      "ul",
                      {},
                      items.map((i) =>
                        h(
                          "li",
                          {},
                          h(
                            "a",
                            { href: `#/thread/${encodeURIComponent(i.threadId)}` },
                            `${formatDate(i.date)} — ${i.subject || "(no subject)"}`,
                          ),
                        ),
                      ),
                    ),
                  );
                }),
              },
              "History",
            ),
            h(
              "button",
              {
                type: "button",
                class: "danger",
                onclick: act(
                  "Deleted",
                  () => mailCommand({ _tag: "DeleteContact", contactId: c.contactId }),
                  reload,
                ),
              },
              "Delete",
            ),
          ],
        ],
      ]),
      history,
      h(
        "form",
        {
          class: "compose",
          onsubmit: act(
            "Contact saved",
            () =>
              mailCommand({
                _tag: "PutContact",
                name: name.value,
                emails: csv(emails.value),
                notes: notes.value,
                groups: csv(groups.value),
              }),
            reload,
          ),
        },
        h("h2", {}, "Add contact"),
        field("Name", name),
        field("Addresses", emails),
        field("Groups", groups),
        field("Notes", notes),
        h("button", { type: "submit" }, "Save contact"),
      ),
      h(
        "div",
        { class: "bulk" },
        h(
          "a",
          {
            href: `/v1/mailboxes/${mb()}/contacts/export.vcf`,
            download: "contacts.vcf",
            class: "button",
          },
          "Export vCard",
        ),
        field("Import vCard", vcard),
        h(
          "button",
          {
            type: "button",
            onclick: act(
              "Imported",
              async () => {
                const file = vcard.files?.[0];
                if (!file) throw new Error("Choose a .vcf file");
                await apiRaw(
                  "POST",
                  `/v1/mailboxes/${mb()}/contacts/import`,
                  await file.text(),
                  "text/vcard",
                );
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

export const renderLabels = async (signal: AbortSignal): Promise<void> => {
  const labels = await list<{
    labelId: string;
    name: string;
    color: string | null;
    threads: number;
  }>(`/v1/mailboxes/${mb()}/labels`, signal);
  const name = h("input", { required: true });
  show(
    section(
      "labels-title",
      "Labels",
      table("Labels", labels, [
        [
          "Label",
          (l) => h("a", { href: `#/label/${encodeURIComponent(text(l.name))}` }, text(l.name)),
        ],
        ["Conversations", (l) => text(l.threads)],
        [
          "",
          (l) => [
            h(
              "button",
              {
                type: "button",
                onclick: act(
                  "Renamed",
                  async () => {
                    const next = prompt("New name", text(l.name));
                    if (next)
                      await mailCommand({ _tag: "RenameLabel", labelId: l.labelId, name: next });
                  },
                  reload,
                ),
              },
              "Rename",
            ),
            h(
              "button",
              {
                type: "button",
                class: "danger",
                onclick: act(
                  "Deleted",
                  () => mailCommand({ _tag: "DeleteLabel", labelId: l.labelId }),
                  reload,
                ),
              },
              "Delete",
            ),
          ],
        ],
      ]),
      h(
        "form",
        {
          onsubmit: act(
            "Label created",
            () => mailCommand({ _tag: "CreateLabel", name: name.value }),
            reload,
          ),
        },
        field("New label", name),
        h("button", { type: "submit" }, "Create"),
      ),
    ),
  );
};

export const renderRules = async (signal: AbortSignal): Promise<void> => {
  const rules = await list<{
    ruleId: string;
    conditions: Record<string, unknown>;
    actions: Record<string, unknown>;
    enabled: boolean;
  }>(`/v1/mailboxes/${mb()}/rules`, signal);
  const from = h("input", { placeholder: "sender@example.com" });
  const fromDomain = h("input", { placeholder: "example.com" });
  const subject = h("input", { placeholder: "contains…" });
  const labels = h("input", { placeholder: "Receipts, Travel" });
  const destination = h(
    "select",
    {},
    h("option", { value: "" }, "Keep destination"),
    h("option", { value: "imbox" }, "Inbox"),
    h("option", { value: "feed" }, "Newsletters"),
    h("option", { value: "paper-trail" }, "Receipts"),
  );
  const bundle = h("input", { type: "checkbox" });
  show(
    section(
      "rules-title",
      "Rules",
      table("Rules", rules, [
        ["When", (r) => text(r.conditions)],
        ["Then", (r) => text(r.actions)],
        ["Enabled", (r) => (r.enabled ? "Yes" : "No")],
        [
          "",
          (r) =>
            h(
              "button",
              {
                type: "button",
                class: "danger",
                onclick: act(
                  "Rule deleted",
                  () => mailCommand({ _tag: "DeleteRule", ruleId: r.ruleId }),
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
          class: "compose",
          onsubmit: act(
            "Rule saved",
            () =>
              mailCommand({
                _tag: "PutRule",
                conditions: {
                  ...(from.value ? { from: from.value } : {}),
                  ...(fromDomain.value ? { fromDomain: fromDomain.value } : {}),
                  ...(subject.value ? { subjectContains: subject.value } : {}),
                },
                actions: {
                  ...(csv(labels.value).length ? { labels: csv(labels.value) } : {}),
                  ...(destination.value
                    ? {
                        destination: choice(
                          destination.value,
                          ["imbox", "feed", "paper-trail"],
                          "imbox",
                        ),
                      }
                    : {}),
                  ...(bundle.checked ? { bundle: true } : {}),
                },
                enabled: true,
              }),
            reload,
          ),
        },
        h("h2", {}, "New rule"),
        field("From address", from),
        field("From domain", fromDomain),
        field("Subject contains", subject),
        field("Add labels", labels),
        field("Destination", destination),
        field("Bundle", bundle),
        h("button", { type: "submit" }, "Save rule"),
      ),
    ),
  );
};

export const renderWorkflows = async (
  boardId: string | undefined,
  signal: AbortSignal,
): Promise<void> => {
  if (boardId) {
    const board = await api<{
      boardId: string;
      name: string;
      stages: ReadonlyArray<{
        stageId: string;
        name: string;
        cards: ReadonlyArray<{ cardId: string; threadId: string; completed: boolean }>;
      }>;
    }>("GET", `/v1/mailboxes/${mb()}/workflows/${encodeURIComponent(boardId)}`, undefined, signal);
    const stageName = h("input", { required: true });
    show(
      section(
        "board-title",
        board.name,
        h(
          "div",
          { class: "board" },
          board.stages.map((stage, i) =>
            h(
              "section",
              { class: "stage", "aria-label": stage.name },
              h(
                "h2",
                {},
                stage.name,
                " ",
                h(
                  "button",
                  {
                    type: "button",
                    "aria-label": `Rename ${stage.name}`,
                    onclick: act(
                      "Renamed",
                      async () => {
                        const next = prompt("Stage name", stage.name);
                        if (next)
                          await mailCommand({
                            _tag: "RenameStage",
                            stageId: stage.stageId,
                            name: next,
                          });
                      },
                      reload,
                    ),
                  },
                  "Rename",
                ),
              ),
              h(
                "ul",
                {},
                stage.cards.map((card, position) =>
                  h(
                    "li",
                    { class: card.completed ? "done" : "" },
                    h(
                      "a",
                      { href: `#/thread/${encodeURIComponent(card.threadId)}` },
                      card.threadId,
                    ),
                    " ",
                    board.stages[i + 1]
                      ? h(
                          "button",
                          {
                            type: "button",
                            onclick: act(
                              "Moved",
                              () =>
                                mailCommand({
                                  _tag: "MoveCard",
                                  cardId: card.cardId,
                                  stageId: board.stages[i + 1]!.stageId,
                                  position,
                                }),
                              reload,
                            ),
                          },
                          `→ ${board.stages[i + 1]!.name}`,
                        )
                      : null,
                    h(
                      "button",
                      {
                        type: "button",
                        onclick: act(
                          card.completed ? "Reopened" : "Completed",
                          () =>
                            mailCommand({
                              _tag: "CompleteCard",
                              cardId: card.cardId,
                              done: !card.completed,
                            }),
                          reload,
                        ),
                      },
                      card.completed ? "Reopen" : "Complete",
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
        h(
          "form",
          {
            onsubmit: act(
              "Stage added",
              () =>
                mailCommand({ _tag: "AddStage", boardId: board.boardId, name: stageName.value }),
              reload,
            ),
          },
          field("New stage", stageName),
          h("button", { type: "submit" }, "Add stage"),
        ),
      ),
    );
    return;
  }
  const boards = await list<{
    boardId: string;
    name: string;
    cards: number;
    enrollAddress: string | null;
  }>(`/v1/mailboxes/${mb()}/workflows`, signal);
  const name = h("input", { required: true });
  const stages = h("input", { value: "To do, Doing, Done" });
  const enroll = h("input", { type: "email", placeholder: "optional: team@example.com" });
  show(
    section(
      "workflows-title",
      "Workflows",
      table("Boards", boards, [
        [
          "Board",
          (b) =>
            h("a", { href: `#/workflows/${encodeURIComponent(text(b.boardId))}` }, text(b.name)),
        ],
        ["Cards", (b) => text(b.cards)],
        ["Auto-enroll", (b) => text(b.enrollAddress ?? "")],
      ]),
      h(
        "form",
        {
          class: "compose",
          onsubmit: act(
            "Board created",
            () =>
              mailCommand({
                _tag: "CreateBoard",
                name: name.value,
                stages: csv(stages.value),
                ...(enroll.value ? { enrollAddress: enroll.value } : {}),
              }),
            reload,
          ),
        },
        h("h2", {}, "New board"),
        field("Name", name),
        field("Stages", stages),
        field("Auto-enroll mail sent to", enroll),
        h("button", { type: "submit" }, "Create board"),
      ),
    ),
  );
};

export const renderCollections = async (
  collectionId: string | undefined,
  signal: AbortSignal,
): Promise<void> => {
  if (collectionId) {
    const data = await api<{
      collection: { name: string };
      items: ReadonlyArray<{
        threadId: string;
        subject?: string;
        date?: number;
        from?: { address: string };
      }>;
    }>(
      "GET",
      `/v1/collections/${encodeURIComponent(collectionId)}?mailbox=${encodeURIComponent(mb())}`,
      undefined,
      signal,
    );
    const threadId = h("input", { placeholder: "thread ID", "aria-label": "Thread to add" });
    show(
      section(
        "collection-title",
        data.collection.name,
        h(
          "ol",
          { class: "timeline" },
          data.items.map((i) =>
            h(
              "li",
              {},
              h(
                "a",
                { href: `#/thread/${encodeURIComponent(i.threadId)}` },
                `${formatDate(i.date)} ${i.from?.address ?? ""} — ${i.subject ?? i.threadId}`,
              ),
            ),
          ),
        ),
        h(
          "form",
          {
            onsubmit: act(
              "Added",
              () =>
                mailCommand({
                  _tag: "SetCollectionItems",
                  collectionId,
                  add: [threadId.value.trim()],
                  remove: [],
                }),
              reload,
            ),
          },
          threadId,
          h("button", { type: "submit" }, "Add conversation"),
        ),
      ),
    );
    return;
  }
  const collections = await list<{ collectionId: string; name: string; threads: number }>(
    `/v1/collections?mailbox=${encodeURIComponent(mb())}`,
    signal,
  );
  const name = h("input", { required: true });
  show(
    section(
      "collections-title",
      "Collections",
      table("Collections", collections, [
        [
          "Collection",
          (c) =>
            h(
              "a",
              { href: `#/collections/${encodeURIComponent(text(c.collectionId))}` },
              text(c.name),
            ),
        ],
        ["Conversations", (c) => text(c.threads)],
      ]),
      h(
        "form",
        {
          onsubmit: act(
            "Collection created",
            () => mailCommand({ _tag: "CreateCollection", name: name.value }),
            reload,
          ),
        },
        field("New collection", name),
        h("button", { type: "submit" }, "Create"),
      ),
      h("p", {}, h("a", { href: "#/spaces" }, "Shared collections live in team spaces.")),
    ),
  );
};

export const renderNotes = async (signal: AbortSignal): Promise<void> => {
  const notes = await list<{
    noteId: string;
    kind: string;
    threadId: string | null;
    body: string;
    updatedAt?: number;
  }>(`/v1/mailboxes/${mb()}/notes`, signal);
  const body = h("textarea", { rows: 3, required: true });
  show(
    section(
      "notes-title",
      "Notes",
      table("Notes", notes, [
        ["Kind", (n) => text(n.kind)],
        ["Note", (n) => text(n.body)],
        [
          "Conversation",
          (n) =>
            n.threadId
              ? h("a", { href: `#/thread/${encodeURIComponent(text(n.threadId))}` }, "Open")
              : "",
        ],
        [
          "",
          (n) =>
            h(
              "button",
              {
                type: "button",
                class: "danger",
                onclick: act(
                  "Deleted",
                  () => mailCommand({ _tag: "DeleteNote", noteId: n.noteId }),
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
          onsubmit: act(
            "Sticky note added",
            () => mailCommand({ _tag: "PutNote", kind: "sticky", body: body.value }),
            reload,
          ),
        },
        field("New Inbox sticky note", body),
        h("button", { type: "submit" }, "Add"),
      ),
    ),
  );
};

export const renderClips = async (params: URLSearchParams, signal: AbortSignal): Promise<void> => {
  const q = params.get("q") ?? "";
  const clips = await list<{ clipId: string; threadId: string; text: string; createdAt: number }>(
    `/v1/mailboxes/${mb()}/clips${query({ q })}`,
    signal,
  );
  const search = h("input", { type: "search", value: q, "aria-label": "Search clips" });
  show(
    section(
      "clips-title",
      "Clips",
      h(
        "form",
        {
          role: "search",
          onsubmit: (e) => (
            e.preventDefault(),
            (location.hash = `#/clips?q=${encodeURIComponent(search.value)}`)
          ),
        },
        search,
        h("button", { type: "submit" }, "Search"),
      ),
      h(
        "ul",
        {},
        clips.map((c) =>
          h(
            "li",
            {},
            h("blockquote", {}, c.text),
            h(
              "a",
              { href: `#/thread/${encodeURIComponent(c.threadId)}` },
              `Source, ${formatDate(c.createdAt)}`,
            ),
          ),
        ),
      ),
    ),
  );
};

export const renderPolicies = async (signal: AbortSignal): Promise<void> => {
  const [policies, history] = await Promise.all([
    list<{
      kind: string;
      subject: string;
      policy: { decision: string; destination: string; notify: boolean; bundle: boolean };
    }>(`/v1/mailboxes/${mb()}/policies`, signal),
    list<{
      historyId: string;
      kind: string;
      subject: string;
      prior: unknown;
      next: unknown;
      at: number;
    }>(`/v1/mailboxes/${mb()}/policies/history`, signal),
  ]);
  const setPolicy = (kind: string, subject: string, decision: string, destination = "imbox") =>
    mailCommand({
      _tag: "SetPolicy",
      kind: choice(kind, ["address", "domain"], "address"),
      subject,
      policy:
        decision === "clear"
          ? null
          : {
              decision: choice(decision, ["allowed", "blocked"], "blocked"),
              destination: choice(destination, ["imbox", "feed", "paper-trail"], "imbox"),
              labels: [],
              bundle: false,
              notify: false,
            },
    });
  const subject = h("input", { required: true, placeholder: "sender@example.com or example.com" });
  const kind = h(
    "select",
    {},
    h("option", { value: "address" }, "Address"),
    h("option", { value: "domain" }, "Domain"),
  );
  const decision = h(
    "select",
    {},
    h("option", { value: "allowed" }, "Allow"),
    h("option", { value: "blocked" }, "Block"),
  );
  const destination = h(
    "select",
    {},
    h("option", { value: "imbox" }, "Inbox"),
    h("option", { value: "feed" }, "Newsletters"),
    h("option", { value: "paper-trail" }, "Receipts"),
  );
  show(
    section(
      "policies-title",
      "Screening decisions",
      table("Sender and domain decisions", policies, [
        ["Sender", (p) => text(p.subject)],
        ["Type", (p) => text(p.kind)],
        ["Decision", (p) => text(p.policy.decision)],
        ["Goes to", (p) => text(p.policy.destination)],
        [
          "",
          (p) => [
            h(
              "button",
              {
                type: "button",
                onclick: act(
                  "Changed",
                  () =>
                    setPolicy(
                      text(p.kind),
                      text(p.subject),
                      p.policy.decision === "blocked" ? "allowed" : "blocked",
                    ),
                  reload,
                ),
              },
              p.policy.decision === "blocked" ? "Allow" : "Block",
            ),
            h(
              "button",
              {
                type: "button",
                onclick: act(
                  "Cleared",
                  () => setPolicy(text(p.kind), text(p.subject), "clear"),
                  reload,
                ),
              },
              "Forget",
            ),
          ],
        ],
      ]),
      h(
        "form",
        {
          class: "bulk",
          onsubmit: act(
            "Saved",
            () => setPolicy(kind.value, subject.value, decision.value, destination.value),
            reload,
          ),
        },
        field("Sender or domain", subject),
        field("Type", kind),
        field("Decision", decision),
        field("Destination", destination),
        h("button", { type: "submit" }, "Save"),
      ),
      h("h2", {}, "History"),
      table("Decision history", history, [
        ["When", (x) => formatDate(x.at)],
        ["Sender", (x) => text(x.subject)],
        ["Before", (x) => text((x.prior as { decision?: string } | null)?.decision ?? "none")],
        ["After", (x) => text((x.next as { decision?: string } | null)?.decision ?? "none")],
        [
          "",
          (x) =>
            h(
              "button",
              {
                type: "button",
                onclick: act(
                  "Reverted",
                  () => mailCommand({ _tag: "RevertPolicy", historyId: x.historyId }),
                  reload,
                ),
              },
              "Revert",
            ),
        ],
      ]),
    ),
  );
};

/** Only scanned-safe files can be downloaded or selected for a zip. */
const downloadable = (scan: string) =>
  scan === "clean" || scan === "not-required" || scan === "legacy";

export const renderAttachments = async (
  params: URLSearchParams,
  signal: AbortSignal,
): Promise<void> => {
  const type = params.get("type") ?? "";
  const from = params.get("from") ?? "";
  const [items, links] = await Promise.all([
    list<{
      deliveryId: string;
      partId: string;
      threadId: string;
      filename: string;
      contentType: string;
      size: number;
      scan: string;
    }>(`/v1/mailboxes/${mb()}/attachments${query({ type, from, limit: 200 })}`, signal),
    list<{ linkId: string; filename: string; expiresAt: number | null; createdAt: number }>(
      `/v1/grants?mailbox=${encodeURIComponent(mb())}`,
      signal,
    ).catch(degrade([])),
  ]);
  const typeInput = h(
    "select",
    { "aria-label": "Type" },
    [
      ["", "All types"],
      ["image/", "Images"],
      ["application/pdf", "PDFs"],
      ["text/", "Text"],
      ["application/", "Documents"],
    ].map(([v, l]) => h("option", { value: v!, ...(v === type ? { selected: true } : {}) }, l!)),
  );
  const fromInput = h("input", { type: "search", value: from, "aria-label": "From sender" });
  const selected = new Set<number>();
  show(
    section(
      "files-title",
      "Files",
      h(
        "form",
        {
          class: "bulk",
          role: "search",
          onsubmit: (e) => (
            e.preventDefault(),
            (location.hash = `#/files${query({ type: typeInput.value, from: fromInput.value })}`)
          ),
        },
        typeInput,
        fromInput,
        h("button", { type: "submit" }, "Filter"),
      ),
      table(
        "Attachments",
        items.map((i, n) => ({ ...i, n })),
        [
          [
            "",
            (i) =>
              downloadable(i.scan)
                ? h("input", {
                    type: "checkbox",
                    "aria-label": `Select ${text(i.filename)}`,
                    onchange: (e) =>
                      (e.target as HTMLInputElement).checked
                        ? selected.add(i.n)
                        : selected.delete(i.n),
                  })
                : text(i.scan),
          ],
          [
            "File",
            (i) =>
              downloadable(i.scan)
                ? h(
                    "a",
                    {
                      href: `/v1/mailboxes/${mb()}/deliveries/${encodeURIComponent(text(i.deliveryId))}/attachments/${encodeURIComponent(text(i.partId))}`,
                      download: text(i.filename),
                    },
                    text(i.filename),
                  )
                : text(i.filename),
          ],
          ["Type", (i) => text(i.contentType)],
          ["Size", (i) => formatSize(i.size)],
          [
            "Conversation",
            (i) => h("a", { href: `#/thread/${encodeURIComponent(text(i.threadId))}` }, "Open"),
          ],
        ],
      ),
      h(
        "button",
        {
          type: "button",
          onclick: act("Preparing download", async () => {
            const chosen = [...selected]
              .map((n) => items[n]!)
              .map((i) => ({ deliveryId: i.deliveryId, partId: i.partId }));
            if (!chosen.length) throw new Error("Select files first");
            await apiDownload(
              `/v1/mailboxes/${mb()}/attachments/zip`,
              { items: chosen },
              "files.zip",
            );
          }),
        },
        "Download selected",
      ),
      h("h2", {}, "Large-file links"),
      table(
        "Shared download links",
        links,
        [
          ["File", (l) => text(l.filename)],
          ["Created", (l) => formatDate(l.createdAt)],
          ["Expires", (l) => (l.expiresAt ? formatDate(l.expiresAt) : "Never")],
          [
            "",
            (l) =>
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
                        `/v1/grants/${encodeURIComponent(text(l.linkId))}?mailbox=${encodeURIComponent(mb())}`,
                      ),
                    reload,
                  ),
                },
                "Revoke",
              ),
          ],
        ],
        "No shared links.",
      ),
    ),
  );
};
