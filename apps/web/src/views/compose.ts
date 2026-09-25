import { pushDraft, syncedState } from "@bye/native-shared/drafts";
import { degrade, bestEffort } from "../core/degrade.ts";
import { api, list, ApiRequestError, apiRaw, client, newCommandId } from "../api.ts";
import { announce, errorMessage, field, formatSize, h, show } from "../core/dom.ts";
import { mailCommand, mb, remember } from "../core/state.ts";
import { type LocalDraft, loadLocalDrafts, resolveConflict, saveLocalDraft } from "../drafts.ts";
import {
  composeBody,
  expandSnippets,
  parseRecipients,
  partRanges,
  type Recipient,
  restoreInlineImages,
  withSignature,
} from "../lib/compose.ts";

// Composer (E17/E18/E20): rich or plain text, recipient suggestions and groups, identities with
// signatures, snippets, multipart uploads (attachments and inline images), large-file links, Send
// Later, a real undo window, and per-recipient outcomes after sending. Drafts autosave locally and
// sync with optimistic revisions; a conflict keeps both copies.

/** Files at or above this size are shared as revocable large-file links, not MIME attachments. */
export const LARGE_FILE_BYTES = 20 * 1024 * 1024;

interface Identity {
  readonly identityId: string;
  readonly address: string;
  readonly name: string | null;
  readonly isDefault: boolean;
  readonly verified: boolean;
  readonly signature: string;
}

const loadSnippets = (): Record<string, string> => {
  try {
    return JSON.parse(remember.get("snippets") ?? "{}") as Record<string, string>;
  } catch {
    return {};
  }
};

/** Reserve → PUT parts → complete (E20). Returns the upload ID once the server verified the size. */
export const uploadFile = async (
  file: File,
  onProgress: (done: number) => void,
): Promise<string> => {
  const reserved = await api<{ uploadId: string; partSize: number }>("POST", "/v1/uploads", {
    mailboxId: mb(),
    commandId: newCommandId(),
    filename: file.name,
    contentType: file.type || "application/octet-stream",
    declaredSize: file.size,
  });
  try {
    let done = 0;
    for (const range of partRanges(file.size, reserved.partSize)) {
      await apiRaw(
        "PUT",
        `/v1/uploads/${encodeURIComponent(reserved.uploadId)}/parts/${range.part}?mailbox=${encodeURIComponent(mb())}`,
        file.slice(range.start, range.end),
        "application/octet-stream",
      );
      done += range.end - range.start;
      onProgress(done);
    }
    await api("POST", `/v1/uploads/${encodeURIComponent(reserved.uploadId)}/complete`, {
      mailboxId: mb(),
      commandId: newCommandId(),
    });
    return reserved.uploadId;
  } catch (error) {
    await api("POST", `/v1/uploads/${encodeURIComponent(reserved.uploadId)}/abort`, {
      mailboxId: mb(),
      commandId: newCommandId(),
    }).catch(bestEffort);
    throw error;
  }
};

const toolbarButton = (label: string, command: string, value?: string) =>
  h(
    "button",
    {
      type: "button",
      title: label,
      "aria-label": label,
      onmousedown: (e) => e.preventDefault(),
      onclick: () => document.execCommand(command, false, value),
    },
    label,
  );

export const renderCompose = async (params: URLSearchParams): Promise<void> => {
  const drafts = await loadLocalDrafts().catch(degrade([] as Array<LocalDraft>));
  const threadId = params.get("thread");
  const serverDraftId = params.get("draft");
  let draft: LocalDraft = drafts.find(
    (d) =>
      (serverDraftId ? d.draftId === serverDraftId : d.threadId === threadId) &&
      d.state !== "queued-send",
  ) ?? {
    localId: crypto.randomUUID(),
    draftId: serverDraftId,
    baseRevision: 0,
    to: "",
    cc: "",
    bcc: "",
    subject: params.get("subject") ?? "",
    text: [params.get("text"), params.get("url")].filter(Boolean).join("\n\n"),
    threadId,
    updatedAt: Date.now(),
    state: "local",
  };
  if (serverDraftId && draft.baseRevision === 0) {
    try {
      const server = await api<{
        revision: number;
        content: {
          to: Array<Recipient>;
          cc: Array<Recipient>;
          bcc: Array<Recipient>;
          subject: string;
          text: string;
          html?: string;
        };
      }>("GET", `/v1/mailboxes/${mb()}/drafts/${encodeURIComponent(serverDraftId)}`);
      const join = (xs: Array<Recipient>) =>
        xs.map((x) => (x.name ? `${x.name} <${x.address}>` : x.address)).join(", ");
      draft = {
        ...draft,
        baseRevision: server.revision,
        to: join(server.content.to),
        cc: join(server.content.cc),
        bcc: join(server.content.bcc),
        subject: server.content.subject,
        text: server.content.text,
        ...(server.content.html ? { html: server.content.html } : {}),
        state: "synced",
      };
    } catch {
      // offline: keep the local copy
    }
  }

  const [identities, contacts] = await Promise.all([
    list<Identity>(`/v1/mailboxes/${mb()}/identities`).catch(degrade([] as Array<Identity>)),
    list<{ name: string; emails: Array<string>; groups?: Array<string> }>(
      `/v1/mailboxes/${mb()}/contacts?limit=500`,
    ).catch(degrade([])),
  ]);
  const groups: Record<string, Array<Recipient>> = {};
  for (const c of contacts)
    for (const g of c.groups ?? [])
      (groups[g] ??= []).push(...c.emails.map((address) => ({ name: c.name, address })));

  const status = h(
    "p",
    { class: "draft-status", role: "status", "aria-live": "polite" },
    draft.state === "conflict"
      ? "This draft changed on another device; your copy is kept below."
      : "",
  );
  const suggestions = h("datalist", { id: "recipient-suggestions" });
  const recipientInput = (name: "to" | "cc" | "bcc") => {
    const input = h("input", {
      name,
      value: draft[name],
      autocomplete: "off",
      list: "recipient-suggestions",
      "aria-describedby": `${name}-help`,
    });
    input.addEventListener("input", () => {
      update({ [name]: input.value });
      const last = input.value.split(/[,;]/).pop()?.trim() ?? "";
      if (last.length >= 2) {
        void list<{ address: string; name?: string }>(
          `/v1/mailboxes/${mb()}/contacts/suggest?prefix=${encodeURIComponent(last)}`,
        )
          .then((items) =>
            suggestions.replaceChildren(
              ...items.map((s) =>
                h("option", {
                  value: [
                    ...input.value
                      .split(/[,;]/)
                      .slice(0, -1)
                      .map((x) => x.trim())
                      .filter(Boolean),
                    s.name ? `${s.name} <${s.address}>` : s.address,
                  ].join(", "),
                }),
              ),
            ),
          )
          .catch(bestEffort);
      }
    });
    return input;
  };
  const toInput = recipientInput("to");
  const ccInput = recipientInput("cc");
  const bccInput = recipientInput("bcc");
  const subject = h("input", {
    name: "subject",
    value: draft.subject,
    oninput: (e) => update({ subject: (e.target as HTMLInputElement).value }),
  });
  const identity = h(
    "select",
    { "aria-label": "From", onchange: () => update({ identityId: identity.value }) },
    identities
      .filter((i) => i.verified)
      .map((i) =>
        h(
          "option",
          {
            value: i.identityId,
            ...(draft.identityId
              ? draft.identityId === i.identityId
                ? { selected: true }
                : {}
              : i.isDefault
                ? { selected: true }
                : {}),
          },
          i.name ? `${i.name} <${i.address}>` : i.address,
        ),
      ),
  );
  const rich = { on: draft.html !== undefined || remember.get("composer") === "rich" };
  const editor = h("div", {
    class: "editor",
    contenteditable: "true",
    role: "textbox",
    "aria-multiline": "true",
    "aria-label": "Message",
  });
  // Restoring saved rich text: parse into a detached document, then import only sanitized nodes.
  // Saved HTML references inline images as `cid:<uploadId>`; they're shown again from the local
  // copies kept with the draft (object URLs never survive a reload).
  if (draft.html) {
    const safe = composeBody(draft.html).html;
    const doc = new DOMParser().parseFromString(safe, "text/html");
    restoreInlineImages(doc, draft.inlineImages, (blob) => URL.createObjectURL(blob));
    editor.replaceChildren(...[...doc.body.childNodes].map((n) => document.importNode(n, true)));
  } else {
    editor.textContent = draft.text;
  }
  const plain = h("textarea", { name: "text", rows: 14, "aria-label": "Message" }, draft.text);
  const bodyHost = h("div", {});
  const toolbar = h(
    "div",
    { class: "bulk", role: "toolbar", "aria-label": "Formatting" },
    toolbarButton("Bold", "bold"),
    toolbarButton("Italic", "italic"),
    toolbarButton("Bulleted list", "insertUnorderedList"),
    toolbarButton("Numbered list", "insertOrderedList"),
    toolbarButton("Quote", "formatBlock", "blockquote"),
    toolbarButton("Code", "formatBlock", "pre"),
    toolbarButton("Highlight", "hiliteColor", "#fff3a3"),
    h(
      "button",
      {
        type: "button",
        "aria-label": "Link",
        onclick: () => {
          const url = prompt("Link address (https://…)");
          if (url && /^https?:\/\//i.test(url)) document.execCommand("createLink", false, url);
        },
      },
      "Link",
    ),
  );
  const renderBody = () => bodyHost.replaceChildren(...(rich.on ? [toolbar, editor] : [plain]));
  renderBody();
  const modeToggle = h(
    "button",
    {
      type: "button",
      onclick: () => {
        if (rich.on) plain.value = composeBody(editor.innerHTML).text;
        else editor.textContent = plain.value;
        rich.on = !rich.on;
        remember.set("composer", rich.on ? "rich" : "plain");
        renderBody();
      },
    },
    "Switch plain/rich",
  );

  const attachments = h("ul", { class: "attachments", "aria-label": "Attachments" });
  const renderAttachments = () =>
    attachments.replaceChildren(
      ...(draft.attachments ?? []).map((a) =>
        h(
          "li",
          {},
          `${a.filename} (${formatSize(a.size)})${a.inline ? " — inline" : ""} `,
          h(
            "button",
            {
              type: "button",
              "aria-label": `Remove ${a.filename}`,
              onclick: () => {
                update({
                  attachments: (draft.attachments ?? []).filter((x) => x.uploadId !== a.uploadId),
                });
                renderAttachments();
              },
            },
            "Remove",
          ),
        ),
      ),
    );
  renderAttachments();
  const fileInput = h("input", { type: "file", multiple: true, "aria-label": "Attach files" });
  const imageInput = h("input", {
    type: "file",
    accept: "image/png,image/jpeg,image/gif,image/webp",
    "aria-label": "Insert inline image",
  });
  const addFiles = (inline: boolean) => async (event: Event) => {
    const files = [...((event.target as HTMLInputElement).files ?? [])];
    for (const file of files) {
      announce(`Uploading ${file.name}…`);
      const uploadId = await uploadFile(file, (done) =>
        announce(`Uploading ${file.name}: ${Math.round((done / file.size) * 100)}%`),
      ).catch((e: unknown) => {
        announce(`Upload failed: ${errorMessage(e)}`);
        return null;
      });
      if (!uploadId) continue;
      if (file.size >= LARGE_FILE_BYTES && !inline) {
        const link = await mailCommand<{ linkId: string; token: string }>({
          _tag: "CreateFileLink",
          uploadId,
        });
        const url = `${location.origin}/v1/files/${encodeURIComponent(mb())}/${encodeURIComponent(link.token)}`;
        update({ fileLinks: [...(draft.fileLinks ?? []), link.linkId] });
        if (rich.on)
          editor.append(
            h("p", {}, h("a", { href: url }, `${file.name} (${formatSize(file.size)})`)),
          );
        else plain.value += `\n\n${file.name} (${formatSize(file.size)}): ${url}`;
        announce(`${file.name} will be shared as a download link`);
        continue;
      }
      update({
        attachments: [
          ...(draft.attachments ?? []),
          { uploadId, filename: file.name, size: file.size, ...(inline ? { inline: true } : {}) },
        ],
        ...(inline ? { inlineImages: { ...draft.inlineImages, [uploadId]: file } } : {}),
      });
      if (inline) {
        if (!rich.on) modeToggle.click();
        editor.append(
          h("img", { src: URL.createObjectURL(file), alt: file.name, "data-cid": uploadId }),
        );
        update({ html: editorHtml() });
      }
      renderAttachments();
      announce(`${file.name} attached`);
    }
    (event.target as HTMLInputElement).value = "";
  };
  fileInput.addEventListener("change", addFiles(false));
  imageInput.addEventListener("change", addFiles(true));

  const snippets = loadSnippets();
  const snippetName = h("input", { placeholder: "name", "aria-label": "Snippet name" });
  const snippetText = h("input", { placeholder: "text", "aria-label": "Snippet text" });

  let timer: number | undefined;
  const update = (patch: Partial<LocalDraft>) => {
    draft = {
      ...draft,
      ...patch,
      updatedAt: Date.now(),
      state: draft.state === "synced" ? "local" : draft.state,
    };
    clearTimeout(timer);
    timer = window.setTimeout(() => void autosave(), 800);
  };
  // Saved in the same cid: form that is sent, never with local object URLs.
  const editorHtml = () => {
    const clone = editor.cloneNode(true) as HTMLElement;
    clone
      .querySelectorAll("img[data-cid]")
      .forEach((img) => img.setAttribute("src", `cid:${img.getAttribute("data-cid")}`));
    return clone.innerHTML;
  };
  editor.addEventListener("input", () => update({ html: editorHtml() }));
  plain.addEventListener("input", () => {
    const expanded = expandSnippets(plain.value, snippets);
    if (expanded !== plain.value) plain.value = expanded;
    update({ text: plain.value });
  });

  const bodyContent = () => {
    if (!rich.on) return { text: plain.value };
    // Inline images reference their uploads by content ID, never the local object URL.
    return composeBody(editorHtml());
  };
  const content = () => {
    const to = parseRecipients(toInput.value, groups);
    const cc = parseRecipients(ccInput.value, groups);
    const bcc = parseRecipients(bccInput.value, groups);
    const invalid = [...to.invalid, ...cc.invalid, ...bcc.invalid];
    if (invalid.length) throw new Error(`Check these recipients: ${invalid.join(", ")}`);
    const body = bodyContent();
    return {
      to: to.recipients,
      cc: cc.recipients,
      bcc: bcc.recipients,
      subject: subject.value,
      text: body.text,
      ...("html" in body ? { html: body.html } : {}),
      // An inline image deleted from the editor is dropped, not sent as a stray attachment.
      attachments: (draft.attachments ?? [])
        .filter((a) => !a.inline || ("html" in body && body.html.includes(`cid:${a.uploadId}`)))
        .map((a) => a.uploadId),
      ...(draft.fileLinks?.length ? { fileLinks: draft.fileLinks } : {}),
      ...(identity.value ? { identityId: identity.value } : {}),
    };
  };
  const autosave = async (): Promise<boolean> => {
    await saveLocalDraft(draft).catch(bestEffort);
    if (!navigator.onLine) {
      status.textContent = "Saved on this device (offline)";
      return false;
    }
    let c;
    try {
      c = content();
    } catch (error) {
      status.textContent = errorMessage(error);
      return false;
    }
    // The same push/sync core as the native composer: a conflict keeps both copies, and a draft
    // queued to send stays queued after an autosave.
    const pushed = await pushDraft(
      client,
      {
        mailboxId: mb(),
        draftId: draft.draftId,
        baseRevision: draft.baseRevision,
        threadId: draft.threadId,
      },
      c,
    );
    switch (pushed._tag) {
      case "Offline":
        status.textContent = "Saved on this device; will sync when online";
        return false;
      case "Conflict": {
        const join = (xs: ReadonlyArray<Recipient>) => xs.map((x) => x.address).join(", ");
        draft = resolveConflict(draft, {
          revision: pushed.revision,
          to: join(pushed.content.to),
          cc: join(pushed.content.cc),
          bcc: join(pushed.content.bcc),
          subject: pushed.content.subject,
          text: pushed.content.text,
        });
        await saveLocalDraft(draft).catch(bestEffort);
        status.textContent = "This draft changed elsewhere. Both versions are kept.";
        return false;
      }
      case "Synced":
        draft = {
          ...draft,
          draftId: pushed.draftId,
          baseRevision: pushed.revision,
          state: syncedState(draft.state),
        };
        await saveLocalDraft(draft).catch(bestEffort);
        status.textContent = "Draft saved";
        return true;
    }
  };

  const sendLater = h("input", { type: "datetime-local", "aria-label": "Send later at" });
  const individually = h("input", {
    type: "checkbox",
    "aria-label": "Send individually to each recipient",
  });
  const afterSendParam = params.get("afterSend");
  const afterSend = h(
    "select",
    { "aria-label": "After sending" },
    h("option", { value: "none" }, "Keep in place"),
    h(
      "option",
      { value: "done", ...(afterSendParam === "done" ? { selected: true } : {}) },
      "Mark done",
    ),
    h("option", { value: "bubble" }, "Bubble up tomorrow"),
  );
  const outcomes = h("div", { "aria-live": "polite" });

  const watchOutcomes = async (sendJobIds: ReadonlyArray<string>) => {
    for (let attempt = 0; attempt < 20; attempt++) {
      await new Promise((r) => setTimeout(r, 3_000));
      const jobs = await Promise.all(
        sendJobIds.map((id) =>
          api<{
            state: string;
            outcomes?: ReadonlyArray<{ address: string; outcome: string; detail: string | null }>;
            failure?: { detail: string } | null;
          }>("GET", `/v1/mailboxes/${mb()}/send-jobs/${encodeURIComponent(id)}`).catch(bestEffort),
        ),
      );
      outcomes.replaceChildren(
        h(
          "ul",
          { "aria-label": "Delivery status" },
          jobs.flatMap((j) =>
            j
              ? [
                  h("li", {}, `Status: ${j.state}${j.failure ? ` — ${j.failure.detail}` : ""}`),
                  ...(j.outcomes ?? []).map((o) =>
                    h("li", {}, `${o.address}: ${o.outcome}${o.detail ? ` (${o.detail})` : ""}`),
                  ),
                ]
              : [],
          ),
        ),
      );
      if (
        jobs.every((j) => j && ["accepted", "rejected", "cancelled", "unknown"].includes(j.state))
      )
        return;
    }
  };

  const send = async (event: Event) => {
    event.preventDefault();
    const synced = await autosave();
    if (!synced || !draft.draftId) {
      if (!navigator.onLine) {
        draft = { ...draft, state: "queued-send" };
        await saveLocalDraft(draft).catch(bestEffort);
        status.textContent = "Queued on this device — not sent yet";
      }
      return;
    }
    const at = sendLater.value ? Date.parse(sendLater.value) : undefined;
    const after =
      afterSend.value === "done"
        ? { _tag: "MarkDone" }
        : afterSend.value === "bubble"
          ? { _tag: "BubbleUp", at: Date.now() + 24 * 3600_000 }
          : undefined;
    let job;
    try {
      job = await api<
        | { _tag: "Queued"; sendJobIds: Array<string>; dueAt: number }
        | { _tag: "Conflict"; currentRevision: number }
      >("POST", `/v1/drafts/${draft.draftId}/send`, {
        commandId: newCommandId(),
        mailboxId: mb(),
        revision: draft.baseRevision,
        ...(at ? { sendAt: at } : {}),
        ...(individually.checked ? { individually: true } : {}),
        ...(after ? { afterSend: after } : {}),
      });
    } catch (error) {
      status.textContent =
        error instanceof ApiRequestError ? `Couldn't send: ${error.message}` : String(error);
      return;
    }
    if (job._tag === "Conflict") {
      status.textContent = "This draft changed on another device; review it before sending.";
      return;
    }
    const sendJobIds = job.sendJobIds;
    status.replaceChildren(
      at ? `Scheduled for ${new Date(at).toLocaleString()}. ` : "Sending… ",
      h(
        "button",
        {
          type: "button",
          onclick: async () => {
            const results = await Promise.all(
              sendJobIds.map((id) =>
                api<{ _tag: "Cancelled" | "TooLate" }>("POST", `/v1/send-jobs/${id}/cancel`, {
                  commandId: newCommandId(),
                  mailboxId: mb(),
                }),
              ),
            );
            status.textContent = results.every((r) => r._tag === "Cancelled")
              ? "Send cancelled"
              : "Too late to undo — the message was already submitted";
          },
        },
        at ? "Cancel" : "Undo",
      ),
    );
    const back = params.get("return");
    if (back && back.startsWith("#/")) setTimeout(() => (location.hash = back), 1_500);
    else void watchOutcomes(sendJobIds);
  };

  const form = h(
    "form",
    { class: "compose", onsubmit: send, "aria-labelledby": "compose-title" },
    h("h1", { id: "compose-title" }, threadId ? "Reply" : "New message"),
    identities.length ? field("From", identity) : null,
    field("To", toInput),
    h(
      "p",
      { id: "to-help", class: "hint" },
      "Separate with commas. Use @group:Name for a contact group.",
    ),
    h("p", { id: "cc-help", class: "visually-hidden" }, "Carbon copy"),
    h(
      "p",
      { id: "bcc-help", class: "visually-hidden" },
      "Blind copy: hidden from other recipients",
    ),
    field("Cc", ccInput),
    field("Bcc", bccInput),
    suggestions,
    field("Subject", subject),
    h(
      "div",
      { class: "bulk" },
      modeToggle,
      h(
        "button",
        {
          type: "button",
          onclick: () => {
            const sig = identities.find((i) => i.identityId === identity.value)?.signature ?? "";
            if (rich.on) editor.append(h("p", {}, "-- "), h("p", {}, sig));
            else plain.value = withSignature(plain.value, sig);
            update(rich.on ? { html: editor.innerHTML } : { text: plain.value });
          },
        },
        "Insert signature",
      ),
    ),
    bodyHost,
    h(
      "div",
      { class: "bulk" },
      field("Attach files", fileInput),
      field("Inline image", imageInput),
    ),
    attachments,
    h(
      "details",
      {},
      h("summary", {}, "Snippets (type ;;name in plain text)"),
      h(
        "ul",
        {},
        Object.entries(snippets).map(([k, v]) => h("li", {}, `;;${k} → ${v}`)),
      ),
      h(
        "div",
        { class: "bulk" },
        snippetName,
        snippetText,
        h(
          "button",
          {
            type: "button",
            onclick: () => {
              if (!snippetName.value.trim()) return;
              snippets[snippetName.value.trim().toLowerCase()] = snippetText.value;
              remember.set("snippets", JSON.stringify(snippets));
              announce(`Snippet ;;${snippetName.value.trim()} saved on this device`);
            },
          },
          "Save snippet",
        ),
      ),
    ),
    h(
      "div",
      { class: "bulk" },
      field("Send later", sendLater),
      field("Individually", individually),
      field("After sending", afterSend),
    ),
    h("button", { type: "submit", class: "primary" }, "Send"),
    status,
    outcomes,
  );
  show(form);
};
