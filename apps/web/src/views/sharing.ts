import type { JsonObject } from "@bye/native-shared/json";
import { escapeHtml } from "@bye/domain";
import { degrade } from "../core/degrade.ts";
import { api, list, apiRaw, query } from "../api.ts";
import { act, field, formatDate, h, section, show, table, text } from "../core/dom.ts";
import { mb, state, withStepUp } from "../core/state.ts";
import { textToHtml } from "../lib/compose.ts";

// Collaboration (O03–O05, E14) and World publishing (P01, P02). Public links always show a preview
// of exactly what becomes visible before they are created (§10); Bcc, private notes and comments
// never appear in it.

interface SharedThread {
  readonly subject?: string;
  readonly messages?: ReadonlyArray<JsonObject>;
}

export const renderSpaces = async (signal: AbortSignal): Promise<void> => {
  const spaces = await list<JsonObject>("/v1/spaces", signal).catch(degrade([]));

  const org = h(
    "select",
    { "aria-label": "Organization" },
    (state.me?.organizationIds ?? []).map((id) => h("option", { value: id }, id)),
  );

  show(
    section(
      "spaces-title",
      "Shared spaces",
      table(
        "Spaces",
        spaces,
        [
          [
            "Space",
            (s) =>
              h(
                "a",
                { href: `#/spaces/${encodeURIComponent(text(s.spaceId ?? s.id))}` },
                text(s.name ?? s.spaceId ?? s.id),
              ),
          ],
          ["Kind", (s) => text(s.kind)],
          ["Role", (s) => text(s.role)],
        ],
        "You're not in any shared spaces yet.",
      ),
      h(
        "form",
        {
          class: "bulk",
          onsubmit: act(
            "Space created",
            () => withStepUp(() => api("POST", "/v1/spaces", { organizationId: org.value })),
            () => void renderSpaces(signal),
          ),
        },
        org,
        h("button", { type: "submit" }, "New space"),
      ),
    ),
  );
};

export const renderSpace = async (
  spaceId: string,
  threadId: string | undefined,
  signal: AbortSignal,
): Promise<void> => {
  const id = encodeURIComponent(spaceId);
  const reload = () => void renderSpace(spaceId, threadId, signal);

  const [members, threads, collections, grants] = await Promise.all([
    list<JsonObject>(`/v1/spaces/${id}/members`, signal).catch(degrade([])),
    list<JsonObject>(`/v1/spaces/${id}/threads`, signal).catch(degrade([])),
    list<JsonObject>(`/v1/spaces/${id}/collections`, signal).catch(degrade([])),
    list<JsonObject>(`/v1/spaces/${id}/grants`, signal).catch(degrade([])),
  ]);

  const memberId = h("input", { "aria-label": "User ID to add" });
  const collectionName = h("input", { "aria-label": "Collection name" });
  let threadPane: HTMLElement | null = null;

  if (threadId) {
    const tid = encodeURIComponent(threadId);

    const [thread, comments, links] = await Promise.all([
      api<SharedThread>("GET", `/v1/spaces/${id}/threads/${tid}`, undefined, signal).catch(
        degrade<SharedThread>({}),
      ),
      list<JsonObject>(`/v1/spaces/${id}/threads/${tid}/comments`, signal).catch(degrade([])),
      list<JsonObject>(`/v1/spaces/${id}/threads/${tid}/public-links`, signal).catch(degrade([])),
    ]);

    const comment = h("textarea", {
      rows: "3",
      "aria-label": "Private comment (never sent to recipients)",
    });

    threadPane = h(
      "article",
      { "aria-labelledby": "shared-thread-title" },
      h("h2", { id: "shared-thread-title" }, thread.subject ?? "(no subject)"),
      h(
        "ol",
        {},
        (thread.messages ?? []).map((m) =>
          h(
            "li",
            {},
            h("strong", {}, text((m.from as JsonObject | undefined)?.address ?? m.from)),
            ` · ${formatDate(m.sentAt as number)} — `,
            text(m.snippet),
          ),
        ),
      ),
      h("h3", {}, "Team comments"),
      h(
        "ul",
        {},
        comments.map((c) => h("li", {}, h("strong", {}, text(c.authorId)), `: ${text(c.body)}`)),
      ),
      h(
        "form",
        {
          class: "compose",
          onsubmit: act(
            "Comment added",
            () => api("POST", `/v1/spaces/${id}/threads/${tid}/comments`, { body: comment.value }),
            reload,
          ),
        },
        comment,
        h("button", { type: "submit" }, "Comment"),
      ),
      h("h3", {}, "Public links"),
      table(
        "Public links",
        links,
        [
          ["Created", (l) => formatDate(l.createdAt as number)],
          ["Expires", (l) => formatDate(l.expiresAt as number)],
          ["Future replies", (l) => (l.includeFuture ? "included" : "no")],
          [
            "",
            (l) =>
              h(
                "button",
                {
                  type: "button",
                  class: "danger",
                  onclick: act(
                    "Link revoked",
                    () =>
                      api(
                        "DELETE",
                        `/v1/spaces/${id}/public-links/${encodeURIComponent(text(l.linkId ?? l.id))}`,
                      ),
                    reload,
                  ),
                },
                "Revoke",
              ),
          ],
        ],
        "No public links.",
      ),
      h(
        "a",
        { href: `#/public-link${query({ space: spaceId, thread: threadId })}`, class: "button" },
        "Create public link…",
      ),
    );
  }

  show(
    section(
      "space-title",
      `Space ${spaceId}`,
      h("h2", {}, "Threads"),
      table(
        "Shared threads",
        threads,
        [
          [
            "Subject",
            (t) =>
              h(
                "a",
                { href: `#/spaces/${id}/threads/${encodeURIComponent(text(t.id ?? t.threadId))}` },
                text(t.subject || "(no subject)"),
              ),
          ],
          [
            "Messages",
            (t) => text(t.messageCount ?? (t.messages as unknown[] | undefined)?.length ?? ""),
          ],
        ],
        "Nothing shared yet. Open a thread in your mailbox and choose Share.",
      ),
      threadPane,
      h("h2", {}, "Members"),
      table("Members", members, [
        ["Member", (m) => text(m.userId)],
        ["Role", (m) => text(m.role)],
        [
          "",
          (m) =>
            h(
              "button",
              {
                type: "button",
                class: "danger",
                onclick: act(
                  "Removed",
                  () =>
                    withStepUp(() =>
                      api(
                        "DELETE",
                        `/v1/spaces/${id}/members/${encodeURIComponent(text(m.userId))}`,
                      ),
                    ),
                  reload,
                ),
              },
              "Remove",
            ),
        ],
      ]),
      h(
        "form",
        {
          class: "bulk",
          onsubmit: act(
            "Member added",
            () =>
              withStepUp(() =>
                api("PUT", `/v1/spaces/${id}/members/${encodeURIComponent(memberId.value)}`, {
                  role: "member",
                }),
              ),
            reload,
          ),
        },
        memberId,
        h("button", { type: "submit" }, "Add member"),
      ),
      h("h2", {}, "Collections"),
      h(
        "ul",
        {},
        collections.map((c) => h("li", {}, text(c.name))),
      ),
      h(
        "form",
        {
          class: "bulk",
          onsubmit: act(
            "Collection created",
            () => api("POST", `/v1/spaces/${id}/collections`, { name: collectionName.value }),
            reload,
          ),
        },
        collectionName,
        h("button", { type: "submit" }, "New collection"),
      ),
      h("h2", {}, "Access grants"),
      table(
        "Grants",
        grants,
        [
          ["Resource", (g) => `${text(g.resourceKind ?? g.kind)} ${text(g.resourceId)}`],
          ["Grantee", (g) => text(g.grantee)],
          [
            "",
            (g) =>
              h(
                "button",
                {
                  type: "button",
                  class: "danger",
                  onclick: act(
                    "Access revoked",
                    () =>
                      withStepUp(() =>
                        api(
                          "DELETE",
                          `/v1/spaces/${id}/grants/${encodeURIComponent(text(g.id ?? g.grantId))}`,
                        ),
                      ),
                    reload,
                  ),
                },
                "Revoke",
              ),
          ],
        ],
        "No grants.",
      ),
    ),
  );
};

/** Share a mailbox thread's selected messages into a space (O04). */
export const renderShare = async (params: URLSearchParams, signal: AbortSignal): Promise<void> => {
  const threadId = params.get("thread") ?? "";

  const [spaces, detail] = await Promise.all([
    list<JsonObject>("/v1/spaces", signal).catch(degrade([])),
    api<{
      thread: { subject: string };
      deliveries: ReadonlyArray<{
        deliveryId: string;
        from: { address: string };
        date: number;
        snippet?: string;
      }>;
    }>("GET", `/v1/mailboxes/${mb()}/threads/${encodeURIComponent(threadId)}`, undefined, signal),
  ]);

  const space = h(
    "select",
    { "aria-label": "Space" },
    spaces.map((s) =>
      h("option", { value: text(s.spaceId ?? s.id) }, text(s.name ?? s.spaceId ?? s.id)),
    ),
  );

  const boxes = detail.deliveries.map((d) =>
    h("input", { type: "checkbox", value: d.deliveryId, checked: true }),
  );

  const future = h("input", { type: "checkbox" });
  const grantees = h("input", { "aria-label": "Also grant to (user IDs, comma-separated)" });
  show(
    section(
      "share-title",
      `Share “${detail.thread.subject || "(no subject)"}”`,
      h(
        "p",
        { class: "muted" },
        "Only the selected messages are shared. Bcc recipients and your private notes are never included.",
      ),
      h(
        "form",
        {
          class: "compose",
          onsubmit: act(
            "Shared",
            () =>
              withStepUp(() =>
                api<string>("POST", "/v1/shared-threads", {
                  spaceId: space.value,
                  mailboxId: mb(),
                  threadId,
                  messageRefs: boxes.filter((b) => b.checked).map((b) => b.value),
                  grantees: grantees.value
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean),
                  includeFuture: future.checked,
                }),
              ),
            () => (location.hash = `#/spaces/${encodeURIComponent(space.value)}`),
          ),
        },
        field("Space", space),
        h(
          "fieldset",
          {},
          h("legend", {}, "Messages"),
          detail.deliveries.map((d, i) =>
            h("label", {}, boxes[i]!, ` ${d.from.address} · ${new Date(d.date).toLocaleString()}`),
          ),
        ),
        h("label", {}, future, " Include future replies"),
        field("Grant to", grantees),
        h("button", { type: "submit", class: "primary" }, "Share"),
      ),
    ),
  );
};

/** Public link (O05): preview exactly what becomes public, then create with optional expiry. */
export const renderPublicLink = async (
  params: URLSearchParams,
  signal: AbortSignal,
): Promise<void> => {
  const spaceId = params.get("space") ?? "";
  const threadId = params.get("thread") ?? "";

  const preview = await api<{
    subject?: string;
    messages?: ReadonlyArray<{ from?: { address?: string }; sentAt?: number; snippet?: string }>;
  }>(
    "GET",
    `/v1/spaces/${encodeURIComponent(spaceId)}/threads/${encodeURIComponent(threadId)}/public-preview`,
    undefined,
    signal,
  );

  const future = h("input", { type: "checkbox" });
  const expires = h("input", { type: "date", "aria-label": "Expires on (optional)" });
  const result = h("div", { role: "status", "aria-live": "polite" });
  show(
    section(
      "publiclink-title",
      "Create a public link",
      h("p", {}, "Anyone with the link will see exactly this:"),
      h(
        "blockquote",
        {},
        h("strong", {}, preview.subject ?? "(no subject)"),
        h(
          "ol",
          {},
          (preview.messages ?? []).map((m) =>
            h("li", {}, `${m.from?.address ?? ""} · ${formatDate(m.sentAt)} — ${m.snippet ?? ""}`),
          ),
        ),
      ),
      h(
        "form",
        {
          class: "compose",
          onsubmit: act("Link created", async () => {
            const r = await withStepUp(() =>
              api<{ url: string }>("POST", "/v1/public-links", {
                spaceId,
                threadId,
                includeFuture: future.checked,
                expiresAt: expires.value ? Date.parse(`${expires.value}T23:59:59`) : undefined,
              }),
            );

            result.replaceChildren(
              h("p", {}, "Share this link. You can revoke it any time:"),
              h("code", { class: "token" }, r.url),
            );
          }),
        },
        h("label", {}, future, " Also show future replies"),
        field("Expires", expires),
        h("button", { type: "submit", class: "primary" }, "Create link"),
      ),
      result,
    ),
  );
};

/** World publishing (P01/P02): drafts, preview, publish/unpublish, media, subscribers. */
export const renderWorld = async (
  postId: string | undefined,
  signal: AbortSignal,
): Promise<void> => {
  const reload = () => void renderWorld(postId, signal);

  const [world, posts] = await Promise.all([
    api<JsonObject>("GET", "/v1/world", undefined, signal).catch(degrade<JsonObject>({})),
    list<JsonObject>("/v1/world/posts", signal).catch(degrade([])),
  ]);

  const editing = postId ? posts.find((p) => text(p.id) === postId) : undefined;

  const title = h("input", {
    required: true,
    value: text(editing?.title ?? ""),
    "aria-label": "Title",
  });

  const body = h(
    "textarea",
    { rows: "14", "aria-label": "Post (plain text)" },
    text(editing?.text ?? ""),
  );

  const media = h("input", {
    type: "file",
    accept: "image/png,image/jpeg,image/gif,image/webp",
    "aria-label": "Add an image",
  });

  const csv = h("input", { type: "file", accept: ".csv,text/csv", "aria-label": "Subscriber CSV" });
  const previewPane = h("div", { class: "preview", "aria-live": "polite" });
  const mediaKeys: Array<{ contentKey: string; name: string; contentType: string }> = [];

  // The editor is plain text: it is always escaped into paragraphs, never sent as raw HTML (a "<"
  // in prose must not switch modes). MailCore sanitizes stored HTML regardless.
  const payload = () => ({
    title: title.value,
    html: textToHtml(body.value),
    text: body.value,
    media: mediaKeys,
  });

  show(
    section(
      "world-title",
      `Blog${world.handle ? ` · @${text(world.handle)}` : ""}`,
      world.handle
        ? h(
            "p",
            {},
            h(
              "a",
              { href: `/@${text(world.handle)}`, target: "_blank", rel: "noopener" },
              "View public page",
            ),
            " · ",
            h("a", { href: `/@${text(world.handle)}/feed.xml` }, "RSS"),
          )
        : null,
      table(
        "Posts",
        posts,
        [
          [
            "Title",
            (p) => h("a", { href: `#/world/${encodeURIComponent(text(p.id))}` }, text(p.title)),
          ],
          ["Status", (p) => text(p.status)],
          ["Published", (p) => formatDate(p.publishedAt as number)],
          [
            "",
            (p) =>
              p.status === "published"
                ? h(
                    "button",
                    {
                      type: "button",
                      onclick: act(
                        "Unpublished",
                        () =>
                          withStepUp(() =>
                            api(
                              "POST",
                              `/v1/world/posts/${encodeURIComponent(text(p.id))}/unpublish`,
                              {},
                            ),
                          ),
                        reload,
                      ),
                    },
                    "Unpublish",
                  )
                : h(
                    "button",
                    {
                      type: "button",
                      class: "primary",
                      onclick: act(
                        "Published",
                        () =>
                          withStepUp(() =>
                            api(
                              "POST",
                              `/v1/world/posts/${encodeURIComponent(text(p.id))}/publish`,
                              {},
                            ),
                          ),
                        reload,
                      ),
                    },
                    "Publish",
                  ),
          ],
        ],
        "No posts yet.",
      ),
      h("h2", {}, editing ? "Edit post" : "New post"),
      h(
        "form",
        {
          class: "compose",
          onsubmit: act(
            "Draft saved",
            () =>
              editing
                ? api("PUT", `/v1/world/posts/${encodeURIComponent(postId!)}`, payload())
                : api("POST", "/v1/world/drafts", payload()),
            reload,
          ),
        },
        field("Title", title),
        field("Body", body),
        h(
          "div",
          { class: "bulk" },
          media,
          h(
            "button",
            {
              type: "button",
              onclick: act("Image added", async () => {
                const file = media.files?.[0];

                if (!file) throw new Error("Choose an image");

                const r = await apiRaw<{ contentKey: string; name?: string }>(
                  "PUT",
                  `/v1/world/media${query({ name: file.name })}`,
                  file,
                  file.type,
                );

                mediaKeys.push({
                  contentKey: r.contentKey,
                  name: r.name ?? file.name,
                  contentType: file.type,
                });
                body.value += `\n<img src="media/${file.name}" alt="">`;
              }),
            },
            "Upload image",
          ),
        ),
        h(
          "div",
          { class: "bulk" },
          h("button", { type: "submit" }, "Save draft"),
          editing
            ? h(
                "button",
                {
                  type: "button",
                  onclick: act("Preview ready", async () => {
                    const p = await api<{ html?: string; title?: string }>(
                      "GET",
                      `/v1/world/posts/${encodeURIComponent(postId!)}/preview`,
                    );

                    // Author-controlled HTML is shown in a sandboxed frame, never injected into the app.
                    previewPane.replaceChildren(
                      h("iframe", {
                        title: "Post preview",
                        sandbox: "",
                        srcdoc: `<h1>${escapeHtml(p.title ?? "")}</h1>${p.html ?? ""}`,
                      }),
                    );
                  }),
                },
                "Preview",
              )
            : null,
        ),
      ),
      previewPane,
      h("h2", {}, "Subscribers"),
      h(
        "p",
        { class: "muted" },
        "Imported addresses receive a confirmation email; nobody is subscribed without opting in.",
      ),
      h(
        "div",
        { class: "bulk" },
        csv,
        h(
          "button",
          {
            type: "button",
            onclick: act("Invitations sent", async () => {
              const file = csv.files?.[0];

              if (!file) throw new Error("Choose a CSV file");
              await apiRaw("POST", "/v1/world/subscribers/import", await file.text(), "text/csv");
            }),
          },
          "Import CSV",
        ),
        h(
          "a",
          { href: "/v1/world/subscribers/export", download: "subscribers.csv", class: "button" },
          "Export CSV",
        ),
      ),
    ),
  );
};
