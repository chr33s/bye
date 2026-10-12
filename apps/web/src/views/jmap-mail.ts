import { Predicate } from "effect";
import {
  accountProfile,
  type Invocation,
  JmapClient,
  type JmapSessionResource,
  memoryCacheStore,
} from "@bye/native-shared/jmap";
import type { JsonObject, JsonValue } from "@bye/native-shared/json";
import { announce, formatDate, formatSize, h, section, show } from "../core/dom.ts";

// Mail for accounts served by the JMAP core (spec.md §16 C4). The thread-model views answer
// upgrade-required once an account is migrated; this view reads the same mail through the
// standard API: Mailboxes, Emails, and native actions. Untrusted mail content only ever enters the
// DOM as text (§10): bodies are plain-text body values, never HTML on this origin.

export const jmap = new JmapClient({
  origin: location.origin,
  fetch: (url, init) => fetch(url, { ...init, credentials: "same-origin" } as RequestInit),
  headers: () => ({}),
  store: memoryCacheStore(),
});

/** Each account's JMAP profile, cached for the page's lifetime; failures are not cached. */
const profiles = new Map<string, Promise<"core" | "projection" | null>>();

export const jmapProfile = (accountId: string): Promise<"core" | "projection" | null> => {
  const cached = profiles.get(accountId);

  if (cached) return cached;

  const profile = jmap.sessionResource().then(
    (s: JmapSessionResource) => {
      const account = s.accounts[accountId];

      return account ? accountProfile(account) : null;
    },
    () => {
      profiles.delete(accountId);

      return null;
    },
  );

  profiles.set(accountId, profile);

  return profile;
};

const objectOf = (value: JsonValue | undefined): JsonObject | null =>
  Predicate.isObject(value) && !Array.isArray(value) ? (value as JsonObject) : null;

const listOf = (value: JsonValue | undefined): ReadonlyArray<JsonObject> =>
  Array.isArray(value)
    ? (value as ReadonlyArray<JsonValue>).flatMap((v) => {
        const o = objectOf(v);

        return o ? [o] : [];
      })
    : [];

const str = (value: JsonValue | undefined): string => (Predicate.isString(value) ? value : "");

/** Display form of a JMAP EmailAddress list. */
export const addressLine = (value: JsonValue | undefined): string =>
  listOf(value)
    .map((a) => (str(a["name"]) ? `${str(a["name"])} <${str(a["email"])}>` : str(a["email"])))
    .join(", ");

const call = async (calls: ReadonlyArray<Invocation>): Promise<ReadonlyMap<string, JsonObject>> => {
  const out = await jmap.call(calls);
  const results = new Map<string, JsonObject>();

  for (const [id, [name, args]] of out) {
    if (name === "error") throw new Error(`JMAP ${str(args["type"])}: ${str(args["description"])}`);
    results.set(id, args);
  }

  return results;
};

const mailboxNav = (accountId: string, mailboxes: ReadonlyArray<JsonObject>, current: string) =>
  h(
    "nav",
    { "aria-label": "Mailboxes", class: "jmap-mailboxes" },
    ...mailboxes.map((m) => {
      const id = str(m["id"]);
      const unread = Number(m["unreadEmails"] ?? 0);

      return h(
        "a",
        {
          href: `#/jmap/${encodeURIComponent(id)}`,
          "aria-current": id === current ? "page" : undefined,
        },
        str(m["name"]),
        unread > 0
          ? h("span", { class: "count", "aria-label": `${unread} unread` }, ` ${unread}`)
          : null,
      );
    }),
  );

/** A Mailbox's Emails, newest first, with the Mailbox list beside it. */
export const renderJmapMailbox = async (
  accountId: string,
  mailboxId: string | undefined,
  _signal: AbortSignal,
): Promise<void> => {
  const boxes = await call([["Mailbox/get", { accountId, ids: null }, "m"]]);
  const mailboxes = listOf(boxes.get("m")?.["list"]);
  const current = mailboxId ?? str(mailboxes.find((m) => m["role"] === "inbox")?.["id"]) ?? "";

  const r = await call([
    [
      "Email/query",
      {
        accountId,
        filter: { inMailbox: current },
        sort: [{ property: "receivedAt", isAscending: false }],
        limit: 100,
        calculateTotal: true,
      },
      "q",
    ],
    [
      "Email/get",
      {
        accountId,
        "#ids": { resultOf: "q", name: "Email/query", path: "/ids" },
        properties: ["subject", "from", "receivedAt", "keywords", "preview", "hasAttachment"],
      },
      "g",
    ],
  ]);

  const emails = listOf(r.get("g")?.["list"]);
  const name = str(mailboxes.find((m) => m["id"] === current)?.["name"]) || "Mail";

  show(
    section(
      "jmap-title",
      name,
      mailboxNav(accountId, mailboxes, current),
      emails.length === 0
        ? h("p", {}, "Nothing here.")
        : h(
            "ul",
            { class: "jmap-emails" },
            ...emails.map((e) => {
              const unread = objectOf(e["keywords"])?.["$seen"] !== true;

              return h(
                "li",
                { class: unread ? "unread" : undefined },
                h(
                  "a",
                  { href: `#/jmap/email/${encodeURIComponent(str(e["id"]))}` },
                  h("strong", {}, addressLine(e["from"]) || "(unknown sender)"),
                  " — ",
                  str(e["subject"]) || "(no subject)",
                ),
                h("p", { class: "preview" }, str(e["preview"])),
                h("time", {}, formatDate(Date.parse(str(e["receivedAt"])))),
                e["hasAttachment"] === true
                  ? h("span", { "aria-label": "has attachments" }, " 📎")
                  : null,
              );
            }),
          ),
      h("p", { class: "muted" }, `${Number(r.get("q")?.["total"] ?? emails.length)} messages`),
    ),
  );
};

const apply = async (accountId: string, emailId: string, action: JsonObject): Promise<boolean> => {
  const r = await call([
    [
      "EmailAction/apply",
      { accountId, emails: { [emailId]: null }, action, intentId: crypto.randomUUID() },
      "a",
    ],
  ]);

  return objectOf(objectOf(r.get("a")?.["results"])?.[emailId])?.["ok"] === true;
};

/** One Email: headers, the plain-text body and attachments; opening marks it read. */
export const renderJmapEmail = async (
  accountId: string,
  emailId: string,
  _signal: AbortSignal,
): Promise<void> => {
  const r = await call([
    [
      "Email/get",
      {
        accountId,
        ids: [emailId],
        properties: [
          "subject",
          "from",
          "to",
          "cc",
          "receivedAt",
          "keywords",
          "mailboxIds",
          "textBody",
          "bodyValues",
          "attachments",
        ],
        fetchTextBodyValues: true,
      },
      "g",
    ],
  ]);

  const email = listOf(r.get("g")?.["list"])[0];

  if (!email) {
    show(section("jmap-title", "Message not found", h("p", {}, "It may have been deleted.")));

    return;
  }

  if (objectOf(email["keywords"])?.["$seen"] !== true)
    void apply(accountId, emailId, { type: "seen", value: true }).catch(() => undefined);
  const values = objectOf(email["bodyValues"]) ?? {};

  const body = listOf(email["textBody"])
    .map((p) => str(objectOf(values[str(p["partId"])])?.["value"]))
    .join("\n\n");

  const session = await jmap.sessionResource();

  const download = (part: JsonObject) =>
    session.downloadUrl
      .replace("{accountId}", encodeURIComponent(accountId))
      .replace("{blobId}", encodeURIComponent(str(part["blobId"])))
      .replace("{name}", encodeURIComponent(str(part["name"]) || "attachment"))
      .replace("{type}", encodeURIComponent(str(part["type"]) || "application/octet-stream"));

  const action = (label: string, payload: JsonObject, then: string) =>
    h(
      "button",
      {
        type: "button",
        onclick: () =>
          void apply(accountId, emailId, payload).then((ok) => {
            announce(ok ? then : "That didn't work; the message may have changed.");

            if (ok) history.back();
          }),
      },
      label,
    );

  show(
    section(
      "jmap-title",
      str(email["subject"]) || "(no subject)",
      h(
        "dl",
        { class: "jmap-headers" },
        h("dt", {}, "From"),
        h("dd", {}, addressLine(email["from"])),
        h("dt", {}, "To"),
        h("dd", {}, addressLine(email["to"])),
        addressLine(email["cc"])
          ? [h("dt", {}, "Cc"), h("dd", {}, addressLine(email["cc"]))]
          : null,
        h("dt", {}, "Received"),
        h("dd", {}, formatDate(Date.parse(str(email["receivedAt"])))),
      ),
      h(
        "div",
        { class: "actions" },
        action("Archive", { type: "archive" }, "Archived"),
        action("Trash", { type: "trash" }, "Moved to Trash"),
        action("Mark unread", { type: "seen", value: false }, "Marked unread"),
      ),
      h("pre", { class: "jmap-body" }, body),
      listOf(email["attachments"]).length > 0
        ? h(
            "ul",
            { class: "jmap-attachments", "aria-label": "Attachments" },
            ...listOf(email["attachments"]).map((p) =>
              h(
                "li",
                {},
                h(
                  "a",
                  { href: download(p), download: str(p["name"]) || "attachment" },
                  str(p["name"]) || "attachment",
                ),
                ` (${formatSize(Number(p["size"] ?? 0))})`,
              ),
            ),
          )
        : null,
    ),
  );
};
