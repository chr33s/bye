// Composer view (E17/E18/E20): autosave and sync, recipients, send/undo, conflicts, offline queueing,
// snippets, signatures and multipart uploads, rendered in jsdom against a fake API.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  button,
  type Call,
  fakeApi,
  jsdom,
  live,
  main,
  ok,
  settle,
  submit,
  type,
  until,
} from "./harness.ts";

const { renderCompose, uploadFile } = await import("../src/views/compose.ts");

const { state } = await import("../src/core/state.ts");

const identities = [
  {
    identityId: "id_1",
    address: "me@bye.example.test",
    name: "Me",
    isDefault: true,
    verified: true,
    signature: "Cheers, Me",
  },
  {
    identityId: "id_2",
    address: "unverified@bye.example.test",
    name: null,
    isDefault: false,
    verified: false,
    signature: "",
  },
];

type Route = Parameters<typeof fakeApi>[0];

let calls: Array<Call>;

/** The default server: identities and contacts load, drafts create/save, sends queue. */
const server =
  (extra: Route = () => undefined): Route =>
  async (method, path, body) =>
    (await extra(method, path, body)) ??
    (path.endsWith("/identities")
      ? ok({ items: identities })
      : path.endsWith("/contacts")
        ? ok({
            items: [{ name: "Team A", emails: ["a1@x.test", "a2@x.test"], groups: ["Team"] }],
          })
        : method === "POST" && path === "/v1/drafts"
          ? ok({ draftId: "d1", revision: 1 })
          : method === "PATCH" && path.startsWith("/v1/drafts/")
            ? ok({
                _tag: "Saved",
                revision: (body as { expectedRevision: number }).expectedRevision + 1,
              })
            : method === "POST" && path.endsWith("/send")
              ? ok({ _tag: "Queued", sendJobIds: ["j1"], dueAt: 0 })
              : method === "POST" && path.endsWith("/cancel")
                ? ok({ _tag: "Cancelled" })
                : path.includes("/send-jobs/")
                  ? ok({
                      state: "accepted",
                      outcomes: [{ address: "b@x.test", outcome: "delivered", detail: null }],
                    })
                  : undefined);

const form = () => main().querySelector<HTMLFormElement>("form.compose")!;

const input = (name: string) => main().querySelector<HTMLInputElement>(`[name="${name}"]`)!;

const status = () => main().querySelector(".draft-status")!.textContent ?? "";

const render = async (query = "") => {
  await renderCompose(new URLSearchParams(query));
};

const online = (on: boolean) =>
  Object.defineProperty(jsdom.window.navigator, "onLine", { value: on, configurable: true });

beforeEach(() => {
  state.mailboxId = "mbx";
  state.me = null;
  localStorage.clear();
  online(true);
  calls = fakeApi(server());
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("composer", () => {
  it("[E17] renders a new message with verified identities and no reply-only choices", async () => {
    await render("subject=Hi&text=Body&url=https://x.test/a");

    expect(main().querySelector("h1")!.textContent).toBe("New message");
    expect(input("subject").value).toBe("Hi");
    expect(input("text").value).toBe("Body\n\nhttps://x.test/a");
    const from = main().querySelector<HTMLSelectElement>('select[aria-label="From"]')!;
    expect([...from.options].map((o) => o.textContent)).toEqual(["Me <me@bye.example.test>"]);
    const after = main().querySelector<HTMLSelectElement>('select[aria-label="After sending"]')!;
    expect([...after.options].map((o) => o.value)).not.toContain("done");
  });

  it("[E18] sends through a synced draft, then undoes within the window", async () => {
    await render();
    type(input("to"), "b@x.test, @group:Team");
    type(input("subject"), "Plan");
    type(input("text"), "Hello");
    submit(form());
    await until(() => /Sending/.test(status()));

    const created = calls.find((c) => c.path === "/v1/drafts")!.body as {
      content: { to: Array<{ address: string }>; subject: string; text: string };
    };

    expect(created.content.to.map((r) => r.address)).toEqual([
      "b@x.test",
      "a1@x.test",
      "a2@x.test",
    ]);
    expect(created.content).toMatchObject({ subject: "Plan", text: "Hello" });
    expect(calls.find((c) => c.path === "/v1/drafts/d1/send")!.body).toMatchObject({
      mailboxId: "mbx",
      revision: 1,
    });

    button("Undo").click();
    await until(() => status() === "Send cancelled");
    expect(calls.some((c) => c.path === "/v1/send-jobs/j1/cancel")).toBe(true);
  });

  it("reports too late to undo when the job was already submitted", async () => {
    calls = fakeApi(
      server((m, p) =>
        m === "POST" && p.endsWith("/cancel") ? ok({ _tag: "TooLate" }) : undefined,
      ),
    );
    await render();
    type(input("to"), "b@x.test");
    submit(form());
    await until(() => /Sending/.test(status()));
    button("Undo").click();
    await until(() => /Too late/.test(status()));
  });

  it("[E18] shows per-recipient outcomes after the undo window", async () => {
    vi.useFakeTimers();
    await render();
    type(input("to"), "b@x.test");
    submit(form());
    await vi.waitUntil(() => /Sending/.test(status()));
    await vi.advanceTimersByTimeAsync(3_000);

    const outcomes = main().querySelector('[aria-label="Delivery status"]')!;
    expect(outcomes.textContent).toContain("Status: accepted");
    expect(outcomes.textContent).toContain("b@x.test: delivered");
  });

  it("blocks sending to invalid recipients and names them", async () => {
    await render();
    type(input("to"), "not-an-address");
    submit(form());
    await until(() => /Check these recipients/.test(status()));

    expect(status()).toContain("not-an-address");
    expect(calls.some((c) => c.path === "/v1/drafts")).toBe(false);
  });

  it("[X01] queues on the device when offline — never shown as sent", async () => {
    online(false);
    await render();
    type(input("to"), "b@x.test");
    submit(form());
    await until(() => status() === "Queued on this device — not sent yet");

    expect(calls.some((c) => c.method !== "GET")).toBe(false);
  });

  it("stops at a send conflict instead of overwriting", async () => {
    calls = fakeApi(
      server((m, p) =>
        m === "POST" && p.endsWith("/send")
          ? ok({ _tag: "Conflict", currentRevision: 4 })
          : undefined,
      ),
    );
    await render();
    type(input("to"), "b@x.test");
    submit(form());
    await until(() => /review it before sending/.test(status()));
  });

  it("surfaces a refused send", async () => {
    calls = fakeApi(
      server((m, p) =>
        m === "POST" && p.endsWith("/send")
          ? { status: 422, body: { error: { code: "Invalid", message: "Quota exceeded" } } }
          : undefined,
      ),
    );
    await render();
    type(input("to"), "b@x.test");
    submit(form());
    await until(() => /Couldn't send/.test(status()));
  });

  it("[E17] autosaves after typing settles and keeps both copies on a conflict", async () => {
    vi.useFakeTimers();
    calls = fakeApi(
      server((m, p) =>
        m === "PATCH"
          ? ok({ _tag: "Conflict", currentRevision: 3 })
          : m === "GET" && p.includes("/drafts/")
            ? ok({
                revision: 3,
                content: {
                  to: [{ address: "o@x.test" }],
                  cc: [],
                  bcc: [],
                  subject: "Other",
                  text: "other",
                },
              })
            : undefined,
      ),
    );
    await render();
    type(input("to"), "b@x.test");
    await vi.advanceTimersByTimeAsync(800);
    await vi.waitUntil(() => status() === "Draft saved");

    type(input("subject"), "Mine");
    await vi.advanceTimersByTimeAsync(800);
    await vi.waitUntil(() => /Both versions are kept/.test(status()));
    expect(calls.filter((c) => c.path === "/v1/drafts")).toHaveLength(1);
  });

  it("opens a server draft by id", async () => {
    calls = fakeApi(
      server((m, p) =>
        m === "GET" && p === "/v1/mailboxes/mbx/drafts/d9"
          ? ok({
              revision: 7,
              content: {
                to: [{ name: "Bo", address: "bo@x.test" }],
                cc: [{ address: "c@x.test" }],
                bcc: [],
                subject: "Saved",
                text: "draft body",
              },
            })
          : undefined,
      ),
    );
    await render("draft=d9");

    expect(input("to").value).toBe("Bo <bo@x.test>");
    expect(input("cc").value).toBe("c@x.test");
    expect(input("subject").value).toBe("Saved");
    expect(input("text").value).toBe("draft body");
  });

  it("offers reply-only choices on a reply and carries the thread", async () => {
    await render("thread=t1&afterSend=done");

    expect(main().querySelector("h1")!.textContent).toBe("Reply");
    const after = main().querySelector<HTMLSelectElement>('select[aria-label="After sending"]')!;
    expect(after.value).toBe("done");
    type(input("to"), "b@x.test");
    submit(form());
    await until(() => /Sending/.test(status()));
    expect(calls.find((c) => c.path === "/v1/drafts")!.body).toMatchObject({ threadId: "t1" });
    expect(calls.find((c) => c.path.endsWith("/send"))!.body).toHaveProperty("afterSend");
  });

  it("inserts the identity signature once and expands saved snippets", async () => {
    await render();
    type(input("text"), "Hello");
    button("Insert signature").click();
    button("Insert signature").click();
    expect(input("text").value).toBe("Hello\n\n-- \nCheers, Me");

    type(main().querySelector<HTMLInputElement>('[aria-label="Snippet name"]')!, "Addr");
    type(main().querySelector<HTMLInputElement>('[aria-label="Snippet text"]')!, "1 Main St");
    button("Save snippet").click();
    expect(live()).toContain(";;Addr");
    expect(JSON.parse(localStorage.getItem("bye:snippets")!)).toEqual({ addr: "1 Main St" });

    await render();
    type(input("text"), "Ship to ;;addr");
    expect(input("text").value).toBe("Ship to 1 Main St");
  });

  it("switches to rich text and remembers the choice", async () => {
    await render();
    type(input("text"), "plain words");
    button("Switch plain/rich").click();

    const editor = main().querySelector<HTMLElement>(".editor")!;
    expect(editor.textContent).toBe("plain words");
    expect(main().querySelector('[role="toolbar"]')).not.toBeNull();
    expect(localStorage.getItem("bye:composer")).toBe("rich");
  });

  it("suggests contacts as the last recipient is typed", async () => {
    calls = fakeApi(
      server((_m, p) =>
        p.endsWith("/contacts/suggest")
          ? ok({ items: [{ name: "Ann", address: "ann@x.test" }] })
          : undefined,
      ),
    );
    await render();
    type(input("to"), "b@x.test, an");
    await until(() => main().querySelectorAll("#recipient-suggestions option").length === 1);

    expect(main().querySelector<HTMLOptionElement>("#recipient-suggestions option")!.value).toBe(
      "b@x.test, Ann <ann@x.test>",
    );
    expect(calls.some((c) => c.path.includes("prefix=an"))).toBe(true);
  });
});

describe("uploads", () => {
  const file = (size: number) =>
    new jsdom.window.File([new Uint8Array(size)], "a.bin", { type: "" });

  it("[E20] reserves, uploads each part and completes", async () => {
    calls = fakeApi((m, p) =>
      m === "POST" && p === "/v1/uploads" ? ok({ uploadId: "u1", partSize: 4 }) : ok({}),
    );
    const progress: Array<number> = [];

    await expect(uploadFile(file(10), (d) => progress.push(d))).resolves.toBe("u1");
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "POST /v1/uploads",
      "PUT /v1/uploads/u1/parts/1?mailbox=mbx",
      "PUT /v1/uploads/u1/parts/2?mailbox=mbx",
      "PUT /v1/uploads/u1/parts/3?mailbox=mbx",
      "POST /v1/uploads/u1/complete",
    ]);
    expect(progress).toEqual([4, 8, 10]);
    expect(calls[0]!.body).toMatchObject({
      filename: "a.bin",
      contentType: "application/octet-stream",
      declaredSize: 10,
    });
  });

  it("aborts the reservation when a part fails", async () => {
    calls = fakeApi((m, p) =>
      m === "POST" && p === "/v1/uploads"
        ? ok({ uploadId: "u1", partSize: 4 })
        : m === "PUT"
          ? { status: 500, body: { error: { code: "Internal", message: "boom" } } }
          : ok({}),
    );

    await expect(uploadFile(file(10), () => undefined)).rejects.toThrow();
    await settle();
    expect(calls.at(-1)!.path).toBe("/v1/uploads/u1/abort");
  });
});
