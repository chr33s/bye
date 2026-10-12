import type { JsonObject, JsonValue } from "@bye/native-shared/json";
import { beforeEach, describe, expect, it } from "vitest";
import { button, byText, fakeApi, main, ok, until } from "./harness.ts";

// Web mail for migrated accounts (spec.md §16 C4): the JMAP view lists Mailboxes and Emails,
// renders bodies as text only, and applies native actions with intent IDs.

const { addressLine, jmapProfile, renderJmapEmail, renderJmapMailbox } =
  await import("../src/views/jmap-mail.ts");

const BYE = "https://github.com/chr33s/bye/blob/main/spec.md#jmap-capability";

const session = {
  apiUrl: "https://bye.example.test/jmap/api",
  downloadUrl: "https://bye.example.test/jmap/download/{accountId}/{blobId}/{name}?type={type}",
  uploadUrl: "",
  eventSourceUrl: "",
  state: "s1",
  username: "ana@bye.test",
  capabilities: { "urn:ietf:params:jmap:core": {}, "urn:ietf:params:jmap:mail": {}, [BYE]: {} },
  accounts: {
    mbx_1: {
      name: "ana",
      isPersonal: true,
      isReadOnly: false,
      accountCapabilities: { [BYE]: { profile: "core" } },
    },
    mbx_shared: {
      name: "team",
      isPersonal: false,
      isReadOnly: true,
      accountCapabilities: { [BYE]: { profile: "projection" } },
    },
  },
  primaryAccounts: {},
};

const respond = (calls: ReadonlyArray<[string, JsonObject, string]>) =>
  calls.map(([name, _args, id]): [string, JsonValue, string] => {
    switch (name) {
      case "Mailbox/get":
        return [
          name,
          {
            list: [
              { id: "inbox", name: "Imbox", role: "inbox", unreadEmails: 1 },
              { id: "archive", name: "Archive", role: "archive", unreadEmails: 0 },
            ],
          },
          id,
        ];
      case "Email/query":
        return [name, { ids: ["e1"], total: 1 }, id];
      case "Email/get":
        return [
          name,
          {
            list: [
              {
                id: "e1",
                subject: "<b>Lunch</b>",
                from: [{ name: "Carol", email: "carol@example.net" }],
                to: [{ name: null, email: "ana@bye.test" }],
                receivedAt: "2026-10-12T12:00:00Z",
                keywords: {},
                preview: "noon?",
                textBody: [{ partId: "1" }],
                bodyValues: { "1": { value: "<script>alert(1)</script> noon?" } },
                attachments: [
                  { blobId: "B1", name: "plan.pdf", type: "application/pdf", size: 2048 },
                ],
              },
            ],
          },
          id,
        ];
      case "EmailAction/apply":
        return [name, { results: { e1: { ok: true } }, replayed: false }, id];
      default:
        return ["error", { type: "unknownMethod" }, id];
    }
  });

describe("JMAP mail view (web)", () => {
  let calls: ReturnType<typeof fakeApi>;

  beforeEach(() => {
    calls = fakeApi((method, path, body) => {
      if (path === "/.well-known/jmap") return ok(session);

      if (path === "/jmap/api" && method === "POST") {
        const methodCalls = (body as { methodCalls: Array<[string, JsonObject, string]> })
          .methodCalls;

        return ok({ methodResponses: respond(methodCalls), sessionState: "s1" });
      }

      return undefined;
    });
  });

  it("detects a migrated account from the session profile, per account", async () => {
    expect(await jmapProfile("mbx_1")).toBe("core");
    // Another account in the same session answers with its own profile, not the first one's.
    expect(await jmapProfile("mbx_shared")).toBe("projection");
    expect(await jmapProfile("mbx_unknown")).toBeNull();
  });

  it("lists Mailboxes and Emails with unread state", async () => {
    await renderJmapMailbox("mbx_1", undefined, new AbortController().signal);

    expect(byText("h1", "Imbox")).toBeDefined();
    expect(main().querySelector("li.unread")?.textContent).toContain("Carol <carol@example.net>");
    expect(main().querySelector("li.unread")?.textContent).toContain("<b>Lunch</b>");
    expect(main().querySelector('a[href="#/jmap/archive"]')).not.toBeNull();
  });

  it("renders the body as text, marks it read, links attachments and applies actions", async () => {
    await renderJmapEmail("mbx_1", "e1", new AbortController().signal);

    const body = main().querySelector("pre.jmap-body")!;
    expect(body.textContent).toContain("<script>alert(1)</script>");
    expect(main().querySelector("script")).toBeNull();
    expect(main().querySelector<HTMLAnchorElement>(".jmap-attachments a")?.href).toContain(
      "/jmap/download/mbx_1/B1/plan.pdf",
    );

    await until(() => calls.some((c) => JSON.stringify(c.body ?? null).includes('"seen"')));
    button("Archive").click();
    await until(() => calls.some((c) => JSON.stringify(c.body ?? null).includes('"archive"')));
  });

  it("formats address lists", () => {
    expect(
      addressLine([
        { name: "A", email: "a@x" },
        { name: null, email: "b@x" },
      ]),
    ).toBe("A <a@x>, b@x");
    expect(addressLine(null)).toBe("");
  });
});
