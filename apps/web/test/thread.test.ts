// Thread view (E11–E15, E19, E20, C09): sandboxed messages, scan-gated attachments, conversation
// actions and the organize panel, rendered in jsdom against a fake API.
import type { JsonObject } from "@bye/native-shared/json";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { button, type Call, fakeApi, live, main, ok, submit, type, until } from "./harness.ts";

const { renderThread } = await import("../src/views/thread.ts");

const { state } = await import("../src/core/state.ts");

const delivery = (overrides: JsonObject = {}) => ({
  deliveryId: "dl_1",
  from: { name: "Ann", address: "ann@x.test" },
  date: Date.UTC(2026, 8, 1),
  renderUrl: "https://render.bye.example.test/r/dl_1",
  attachments: [],
  scan: { status: "clean" },
  ...overrides,
});

const detail = (overrides: JsonObject = {}) => ({
  thread: {
    threadId: "t1",
    subject: "Quarterly plan",
    revision: 4,
    labels: ["work"],
    attention: { unfollowed: false },
  },
  deliveries: [delivery()],
  mergeHistory: [
    { mergeId: "m1", sources: ["t2"], at: 1, undone: false },
    { mergeId: "m0", sources: ["t3", "t4"], at: 0, undone: true },
  ],
  ...overrides,
});

let calls: Array<Call>;

let thread: ReturnType<typeof detail>;

const commands = () =>
  calls.filter((c) => c.path === "/v1/mailboxes/mbx/commands").map((c) => c.body as JsonObject);

const command = (tag: string) => commands().find((c) => c._tag === tag);

const render = () => renderThread("t1", new AbortController().signal);

beforeEach(() => {
  state.mailboxId = "mbx";
  state.calendarId = null;
  state.me = null;
  thread = detail();
  calls = fakeApi((method, path) =>
    path === "/v1/mailboxes/mbx/threads/t1"
      ? ok(thread)
      : path.endsWith("/labels")
        ? ok({
            items: [
              { labelId: "l1", name: "work" },
              { labelId: "l2", name: "later" },
            ],
          })
        : path.endsWith("/workflows")
          ? ok({ items: [{ boardId: "b1", name: "Hiring" }] })
          : path.endsWith("/notes")
            ? ok({ items: [{ noteId: "n1", body: "call back" }] })
            : method === "POST" && path.endsWith("/commands")
              ? ok({ draftId: "drf_9" })
              : undefined,
  );
});

afterEach(() => vi.unstubAllGlobals());

describe("thread view", () => {
  it("[E11] renders each message in a sandboxed, no-referrer iframe and marks the thread seen", async () => {
    await render();

    expect(main().querySelector("h1")!.textContent).toBe("Quarterly plan");
    const frame = main().querySelector("iframe")!;
    expect(frame.getAttribute("sandbox")).toBe("allow-popups allow-popups-to-escape-sandbox");
    expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(frame.getAttribute("src")).toBe("https://render.bye.example.test/r/dl_1");
    expect(frame.title).toBe("Message from Ann");
    await until(() => !!command("MarkSeen"));
    expect(command("MarkSeen")).toMatchObject({ threadId: "t1", observedRevision: 4 });
  });

  it("falls back to a placeholder subject and the sender address", async () => {
    thread = detail({
      thread: { threadId: "t1", subject: "", revision: 1 },
      deliveries: [delivery({ from: { address: "bob@x.test" } })],
    });
    await render();

    expect(main().querySelector("h1")!.textContent).toBe("(no subject)");
    expect(main().querySelector("section.message strong")!.textContent).toBe("bob@x.test");
  });

  it("[E20] links clean attachments with previews for safe types and a zip for several", async () => {
    thread = detail({
      deliveries: [
        delivery({
          attachments: [
            { partId: "p1", filename: "pic.png", size: 2048, contentType: "image/png" },
            { partId: "p2", filename: "doc.pdf", size: 4096, contentType: "application/pdf" },
          ],
        }),
      ],
    });
    await render();

    const links = [...main().querySelectorAll<HTMLAnchorElement>(".attachments a")];
    expect(links.map((a) => a.textContent)).toEqual([
      "pic.png (2 KB)",
      " Preview",
      "doc.pdf (4 KB)",
    ]);
    expect(links[0]!.getAttribute("href")).toBe("/v1/mailboxes/mbx/deliveries/dl_1/attachments/p1");
    expect(links[1]!.rel).toBe("noopener noreferrer");
    expect(button("Download all")).toBeTruthy();
  });

  it.each([
    ["pending", "Scanning attachments…"],
    ["infected", "Attachments blocked: a threat was detected."],
    ["failed", "Attachments blocked: they couldn't be scanned."],
  ])("[E20] blocks attachment links while the scan is %s", async (status, notice) => {
    thread = detail({
      deliveries: [
        delivery({
          scan: { status },
          attachments: [
            { partId: "p1", filename: "a.exe", size: 10, contentType: "application/x-msdownload" },
            { partId: "p2", filename: "b.exe", size: 10 },
          ],
        }),
      ],
    });
    await render();

    expect(main().querySelector(".notice")!.textContent).toBe(notice);
    expect(main().querySelectorAll(".attachments a")).toHaveLength(0);
    expect(main().querySelectorAll('.attachments [aria-disabled="true"]')).toHaveLength(2);
    expect(() => button("Download all")).toThrow();
  });

  it("[E12] opens a reply draft in the composer", async () => {
    await render();
    button("Reply all").click();
    await until(() => location.hash.startsWith("#/compose"));

    expect(command("CreateReplyDraft")).toMatchObject({ threadId: "t1", mode: "reply-all" });
    expect(location.hash).toBe("#/compose?draft=drf_9&thread=t1");
  });

  it("toggles following and marks unseen", async () => {
    await render();
    button("Unfollow").click();
    await until(() => live() === "Unfollowed: done");
    expect(command("SetAttention")).toMatchObject({ flag: "unfollowed", on: true });

    button("Mark unseen").click();
    await until(() => live() === "Marked unseen: done");
    expect(command("MarkUnseen")).toMatchObject({ threadId: "t1" });
  });

  it("offers Follow on an unfollowed thread", async () => {
    thread = detail({
      thread: { threadId: "t1", subject: "S", revision: 1, attention: { unfollowed: true } },
    });
    await render();
    button("Follow").click();
    await until(() => live() === "Following: done");
    expect(command("SetAttention")).toMatchObject({ on: false });
  });

  it("[E13] labels, notes and clips go through typed mailbox commands", async () => {
    await render();
    const aside = main().querySelector("aside.organize")!;

    button("work ×", aside).click();
    await until(() => live() === "Removed work: done");
    expect(command("SetThreadLabels")).toMatchObject({ add: [], remove: ["work"] });

    type(aside.querySelector<HTMLInputElement>('[aria-label="New label"]')!, "urgent");
    submit(button("Add label", aside).form!);
    await until(() => live() === "Labelled: done");
    expect(commands().at(-1)).toMatchObject({ _tag: "SetThreadLabels", add: ["urgent"] });

    type(aside.querySelector<HTMLTextAreaElement>('[aria-label="Private note"]')!, "follow up");
    submit(button("Add note", aside).form!);
    await until(() => live() === "Note saved: done");
    expect(command("PutNote")).toMatchObject({ kind: "thread", threadId: "t1", body: "follow up" });

    button("Delete", aside).click();
    await until(() => live() === "Note deleted: done");
    expect(command("DeleteNote")).toMatchObject({ noteId: "n1" });

    submit(button("Save clip", aside).form!);
    await until(() => live() === "Clipped: done");
    expect(command("CreateClip")).toMatchObject({ deliveryId: "dl_1" });

    submit(button("Add to board", aside).form!);
    await until(() => live() === "Added to workflow: done");
    expect(command("AddToBoard")).toMatchObject({ boardId: "b1", threadId: "t1" });
  });

  it("[E14] renames, restores, merges and unmerges with visible history", async () => {
    await render();
    const aside = main().querySelector("aside.organize")!;

    const history = aside.querySelector('[aria-label="Merge history"]')!;
    expect(history.textContent).toContain("Merged 1 thread(s)");
    expect(history.textContent).toContain("Undone 2 thread(s)");
    expect(history.querySelectorAll("button")).toHaveLength(1);

    type(aside.querySelector<HTMLInputElement>('[aria-label="Subject"]')!, "  ");
    submit(button("Rename", aside).form!);
    await until(() => live() === "Renamed: done");
    expect(command("RenameThread")).toMatchObject({ subject: null });

    type(
      aside.querySelector<HTMLInputElement>('[aria-label="Thread to merge into this one"]')!,
      " t9 ",
    );
    submit(button("Merge", aside).form!);
    await until(() => live() === "Merged: done");
    expect(command("MergeThreads")).toMatchObject({ targetId: "t1", sourceIds: ["t9"] });

    button("Unmerge", aside).click();
    await until(() => live() === "Unmerged: done");
    expect(command("UnmergeThreads")).toMatchObject({ mergeId: "m1" });
  });

  it("[E19] redelivers to another of the user's accounts only when there is one", async () => {
    await render();
    expect(() => button("Redeliver")).toThrow();

    state.me = { mailboxIds: ["mbx", "mbx_2"] } as never;
    await render();
    const aside = main().querySelector("aside.organize")!;
    type(aside.querySelector<HTMLSelectElement>('[aria-label="Redelivery mode"]')!, "move");
    submit(button("Redeliver", aside).form!);
    await until(() => live() === "Redelivered: done");
    expect(command("Redeliver")).toMatchObject({
      deliveryId: "dl_1",
      targetMailboxId: "mbx_2",
      mode: "move",
    });
  });

  it("reports a failed action in the live region", async () => {
    calls = fakeApi((method, path) =>
      path === "/v1/mailboxes/mbx/threads/t1"
        ? ok(thread)
        : method === "POST"
          ? { status: 409, body: { error: { code: "Conflict", message: "Thread changed" } } }
          : ok({ items: [] }),
    );
    await render();
    button("Trash").click();
    await until(() => live().startsWith("Moved to trash failed"));
    expect(live()).toContain("Thread changed");
  });

  it("[C09] shows the invitation panel and reports an unavailable calendar", async () => {
    thread = detail({ deliveries: [delivery({ routing: { hasCalendar: true } })] });
    await render();

    const panel = main().querySelector('[aria-label="Invitation"]')!;
    expect(panel.textContent).toContain("calendar invitation");
    await until(() => panel.textContent!.includes("Calendar unavailable."));
  });

  it("[C09] refuses to create an event without a calendar", async () => {
    state.calendarId = "space_1";
    calls = fakeApi((_m, path) =>
      path === "/v1/mailboxes/mbx/threads/t1"
        ? ok(thread)
        : path.endsWith("/calendars")
          ? ok({ items: [] })
          : ok({ items: [] }),
    );
    await render();
    submit(button("Create event").form!);
    await until(() => live().startsWith("Event created failed"));
    expect(live()).toContain("Create a calendar first");
  });
});
