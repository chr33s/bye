import { describe, expect, it } from "vitest";
import { ByeClient } from "../src/client.ts";
import { DraftStore, type NativeDraft, pushDraft, syncedState } from "../src/drafts.ts";

const queued = { draftId: "drf_1", baseRevision: 2, state: "queued-send" as const };

describe("draft sync", () => {
  it("keeps both drafts when saves overlap", async () => {
    const data = new Map<string, string>();
    const store = new DraftStore({
      getItem: async (key) => data.get(key) ?? null,
      setItem: async (key, value) => void data.set(key, value),
      removeItem: async (key) => void data.delete(key),
    });
    const draft = (localId: string): NativeDraft => ({
      localId,
      mailboxId: "mbx_1",
      draftId: null,
      baseRevision: 0,
      threadId: null,
      content: { to: [], cc: [], bcc: [], subject: localId, text: "", attachments: [] },
      state: "local",
      updatedAt: 1,
    });

    await Promise.all([store.save(draft("one")), store.save(draft("two"))]);
    expect((await store.list()).map((item) => item.localId)).toEqual(["one", "two"]);
  });

  it("[X01] an autosave of a draft queued to send keeps it queued (shared sync core)", async () => {
    const client = new ByeClient({
      origin: "https://app.bye.test",
      cookie: true,
      fetch: async () => ({
        status: 200,
        text: async () => JSON.stringify({ _tag: "Saved", revision: 3 }),
      }),
    });
    const pushed = await pushDraft(
      client,
      {
        mailboxId: "mbx_1",
        draftId: queued.draftId,
        baseRevision: queued.baseRevision,
        threadId: null,
      },
      {
        to: [{ address: "a@example.com" }],
        cc: [],
        bcc: [],
        subject: "s",
        text: "t",
        attachments: [],
      },
    );
    expect(pushed).toEqual({ _tag: "Synced", draftId: "drf_1", revision: 3 });
    expect(syncedState(queued.state)).toBe("queued-send");
    expect(syncedState("local")).toBe("synced");
    const offline = new ByeClient({
      origin: "https://app.bye.test",
      cookie: true,
      fetch: async () => Promise.reject(new TypeError("offline")),
    });
    expect(
      await pushDraft(
        offline,
        { mailboxId: "mbx_1", draftId: null, baseRevision: 0, threadId: null },
        { to: [], cc: [], bcc: [], subject: "", text: "", attachments: [] },
      ),
    ).toEqual({ _tag: "Offline" });
  });
});
