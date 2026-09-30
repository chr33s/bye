// Collaboration (O03–O05) and World publishing (P01, P02) views: spaces, sharing a thread, public
// links previewed before creation, and blog posts, against a fake API.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { button, type Call, fakeApi, live, main, ok, submit, type, until } from "./harness.ts";

const { renderPublicLink, renderShare, renderSpace, renderSpaces, renderWorld } =
  await import("../src/views/sharing.ts");

const { state } = await import("../src/core/state.ts");

let calls: Array<Call>;

const signal = () => new AbortController().signal;

const sent = (method: string, path: string) =>
  calls.find((c) => c.method === method && c.path === path)?.body;

beforeEach(() => {
  state.mailboxId = "mbx";
  state.me = { organizationIds: ["org_1"] } as never;
  location.hash = "";
});

afterEach(() => vi.unstubAllGlobals());

describe("spaces", () => {
  it("[O03] lists spaces and creates one for the chosen organization", async () => {
    calls = fakeApi((method, path) =>
      path === "/v1/spaces" && method === "GET"
        ? ok({ items: [{ spaceId: "sp1", name: "Design", kind: "team", role: "owner" }] })
        : ok({}),
    );
    await renderSpaces(signal());

    expect(main().querySelector<HTMLAnchorElement>('a[href="#/spaces/sp1"]')!.textContent).toBe(
      "Design",
    );
    submit(button("New space").form!);
    await until(() => live() === "Space created: done");
    expect(sent("POST", "/v1/spaces")).toEqual({ organizationId: "org_1" });
  });

  it("shows an empty state when spaces can't load", async () => {
    calls = fakeApi(() => ({
      status: 503,
      body: { error: { code: "Unavailable", message: "x" } },
    }));
    await renderSpaces(signal());

    expect(main().textContent).toContain("You're not in any shared spaces yet.");
  });

  it("[O04] shows a shared thread with private comments and manages its links and members", async () => {
    calls = fakeApi((method, path) =>
      method !== "GET"
        ? ok({})
        : path === "/v1/spaces/sp1/members"
          ? ok({ items: [{ userId: "u2", role: "member" }] })
          : path === "/v1/spaces/sp1/threads"
            ? ok({ items: [{ id: "st1", subject: "", messageCount: 2 }] })
            : path === "/v1/spaces/sp1/collections"
              ? ok({ items: [{ name: "Launch" }] })
              : path === "/v1/spaces/sp1/grants"
                ? ok({ items: [] })
                : path === "/v1/spaces/sp1/threads/st1"
                  ? ok({
                      subject: "Launch plan",
                      messages: [
                        { from: { address: "ann@x.test" }, sentAt: 1, snippet: "Draft attached" },
                      ],
                    })
                  : path === "/v1/spaces/sp1/threads/st1/comments"
                    ? ok({ items: [{ authorId: "u2", body: "LGTM" }] })
                    : path === "/v1/spaces/sp1/threads/st1/public-links"
                      ? ok({
                          items: [
                            { linkId: "pl1", createdAt: 1, expiresAt: null, includeFuture: true },
                          ],
                        })
                      : undefined,
    );
    await renderSpace("sp1", "st1", signal());

    expect(main().querySelector('a[href="#/spaces/sp1/threads/st1"]')!.textContent).toBe(
      "(no subject)",
    );
    const pane = main().querySelector('[aria-labelledby="shared-thread-title"]')!;
    expect(pane.textContent).toContain("Launch plan");
    expect(pane.textContent).toContain("ann@x.test");
    expect(pane.textContent).toContain("u2: LGTM");
    expect(pane.textContent).toContain("included");
    expect(pane.querySelector<HTMLAnchorElement>("a.button")!.getAttribute("href")).toBe(
      "#/public-link?space=sp1&thread=st1",
    );

    type(pane.querySelector("textarea")!, "Ship it");
    submit(button("Comment", pane).form!);
    await until(() => live() === "Comment added: done");
    expect(sent("POST", "/v1/spaces/sp1/threads/st1/comments")).toEqual({ body: "Ship it" });

    button("Revoke", pane).click();
    await until(() => live() === "Link revoked: done");
    expect(
      calls.some((c) => c.method === "DELETE" && c.path === "/v1/spaces/sp1/public-links/pl1"),
    ).toBe(true);

    type(main().querySelector<HTMLInputElement>('[aria-label="User ID to add"]')!, "u3");
    submit(button("Add member").form!);
    await until(() => live() === "Member added: done");
    expect(sent("PUT", "/v1/spaces/sp1/members/u3")).toEqual({ role: "member" });

    type(main().querySelector<HTMLInputElement>('[aria-label="Collection name"]')!, "Q4");
    submit(button("New collection").form!);
    await until(() => live() === "Collection created: done");
    expect(sent("POST", "/v1/spaces/sp1/collections")).toEqual({ name: "Q4" });
  });

  it("[O04] shares only the selected messages of a thread", async () => {
    calls = fakeApi((method, path) =>
      path === "/v1/spaces"
        ? ok({ items: [{ spaceId: "sp1", name: "Design" }] })
        : path === "/v1/mailboxes/mbx/threads/t1"
          ? ok({
              thread: { subject: "Plan" },
              deliveries: [
                { deliveryId: "d1", from: { address: "a@x.test" }, date: 1 },
                { deliveryId: "d2", from: { address: "b@x.test" }, date: 2 },
              ],
            })
          : method === "POST"
            ? ok("st1")
            : undefined,
    );
    await renderShare(new URLSearchParams("thread=t1"), signal());

    expect(main().querySelector("h1")!.textContent).toBe("Share “Plan”");
    expect(main().textContent).toContain(
      "Bcc recipients and your private notes are never included",
    );
    const boxes = main().querySelectorAll<HTMLInputElement>('fieldset input[type="checkbox"]');
    boxes[1]!.checked = false;
    type(main().querySelector<HTMLInputElement>('[aria-label^="Also grant to"]')!, " u2, ,u3 ");
    submit(button("Share").form!);
    await until(() => location.hash === "#/spaces/sp1");

    expect(sent("POST", "/v1/shared-threads")).toEqual({
      spaceId: "sp1",
      mailboxId: "mbx",
      threadId: "t1",
      messageRefs: ["d1"],
      grantees: ["u2", "u3"],
      includeFuture: false,
    });
  });
});

describe("public links", () => {
  it("[O05] previews exactly what becomes public, then creates the link with an expiry", async () => {
    calls = fakeApi((method, path) =>
      path === "/v1/spaces/sp1/threads/st1/public-preview"
        ? ok({
            subject: "Launch plan",
            messages: [{ from: { address: "ann@x.test" }, sentAt: 1, snippet: "Hi" }],
          })
        : method === "POST" && path === "/v1/public-links"
          ? ok({ url: "https://bye.example.test/p/abc" })
          : undefined,
    );
    await renderPublicLink(new URLSearchParams("space=sp1&thread=st1"), signal());

    const preview = main().querySelector("blockquote")!;
    expect(preview.textContent).toContain("Launch plan");
    expect(preview.textContent).toContain("ann@x.test");
    expect(calls.every((c) => c.method === "GET")).toBe(true);

    type(
      main().querySelector<HTMLInputElement>('[aria-label="Expires on (optional)"]')!,
      "2026-12-31",
    );
    submit(button("Create link").form!);
    await until(() => !!main().querySelector("code.token"));

    const body = sent("POST", "/v1/public-links") as { expiresAt: number; includeFuture: boolean };
    expect(body).toMatchObject({ spaceId: "sp1", threadId: "st1", includeFuture: false });
    expect(new Date(body.expiresAt).getDate()).toBe(31);
    expect(main().querySelector("code.token")!.textContent).toBe("https://bye.example.test/p/abc");
  });
});

describe("world", () => {
  const worldApi = (method: string, path: string) =>
    path === "/v1/world"
      ? ok({ handle: "ann" })
      : path === "/v1/world/posts"
        ? ok({
            items: [
              { id: "p1", title: "Hello", status: "published", publishedAt: 1, text: "old" },
              { id: "p2", title: "Next", status: "draft", text: "draft body" },
            ],
          })
        : path === "/v1/world/posts/p2/preview"
          ? ok({ title: "<Next>", html: "<p>draft body</p>" })
          : method !== "GET"
            ? ok({})
            : undefined;

  beforeEach(() => {
    calls = fakeApi(worldApi);
  });

  it("[P01] lists posts with publish and unpublish, and links the public page", async () => {
    await renderWorld(undefined, signal());

    expect(main().querySelector("h1")!.textContent).toBe("Blog · @ann");
    expect(main().querySelector<HTMLAnchorElement>('a[href="/@ann/feed.xml"]')).not.toBeNull();

    button("Unpublish").click();
    await until(() => live() === "Unpublished: done");
    button("Publish").click();
    await until(() => live() === "Published: done");
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(
      expect.arrayContaining([
        "POST /v1/world/posts/p1/unpublish",
        "POST /v1/world/posts/p2/publish",
      ]),
    );
  });

  it("[P01] escapes plain-text posts into paragraphs when saving a new draft", async () => {
    await renderWorld(undefined, signal());
    expect(main().querySelector("h2")!.textContent).toBe("New post");

    type(main().querySelector<HTMLInputElement>('[aria-label="Title"]')!, "T");
    type(main().querySelector<HTMLTextAreaElement>('[aria-label="Post (plain text)"]')!, "a < b");
    submit(button("Save draft").form!);
    await until(() => live() === "Draft saved: done");

    const body = sent("POST", "/v1/world/drafts") as { html: string; text: string };
    expect(body.text).toBe("a < b");
    expect(body.html).toContain("a &lt; b");
    expect(body.html).not.toContain("a < b");
  });

  it("[P02] edits a post and previews it in a sandboxed frame", async () => {
    await renderWorld("p2", signal());

    expect(
      main().querySelector<HTMLTextAreaElement>('[aria-label="Post (plain text)"]')!.value,
    ).toBe("draft body");
    button("Preview").click();
    await until(() => !!main().querySelector("iframe"));
    const frame = main().querySelector("iframe")!;
    expect(frame.getAttribute("sandbox")).toBe("");
    expect(frame.getAttribute("srcdoc")).toBe("<h1>&lt;Next&gt;</h1><p>draft body</p>");

    submit(button("Save draft").form!);
    await until(() => live() === "Draft saved: done");
    expect(sent("PUT", "/v1/world/posts/p2")).toMatchObject({ title: "Next", text: "draft body" });
  });

  it("asks for a file before uploading an image or importing subscribers", async () => {
    await renderWorld(undefined, signal());

    button("Upload image").click();
    await until(() => live() === "Image added failed: Choose an image");
    button("Import CSV").click();
    await until(() => live() === "Invitations sent failed: Choose a CSV file");
  });
});
