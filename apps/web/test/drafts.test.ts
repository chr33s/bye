import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  (globalThis as { location?: unknown }).location = new URL("https://app.bye.test/");
});

const { draftsOwnedBy, LOCAL_OWNER_KEY, localOwnerAction, resolveConflict, saveLocalDraft } =
  await import("../src/drafts.ts");

const { bindLocalOwner, onSignedOut } = await import("../src/auth.ts");

type LocalDraft = import("../src/drafts.ts").LocalDraft;

const local: LocalDraft = {
  localId: "l1",
  draftId: "drf_1",
  baseRevision: 2,
  to: "a@example.com",
  cc: "",
  bcc: "",
  subject: "Offline edits",
  text: "long offline draft",
  threadId: null,
  updatedAt: 1,
  state: "local",
};

interface DeleteRequest {
  onsuccess: (() => void) | null;
}

describe("offline drafts", () => {
  it("[X01] a server conflict keeps both copies instead of last-write-wins", () => {
    const merged = resolveConflict(local, {
      revision: 5,
      to: "b@example.com",
      cc: "",
      bcc: "",
      subject: "Other device",
      text: "other",
    });

    expect(merged.state).toBe("conflict");
    expect(merged.baseRevision).toBe(5);
    expect(merged.text).toBe("other");
    expect(merged.conflictCopy?.text).toBe("long offline draft");
  });
});

describe("offline drafts are account-scoped (shared browser)", () => {
  const a = { userId: "usr_a", mailboxId: "mbx_a" };
  const b = { userId: "usr_b", mailboxId: "mbx_b" };
  const mine: LocalDraft = { ...local, localId: "a1", ownerId: a.userId, mailboxId: a.mailboxId };
  const otherMailbox: LocalDraft = { ...mine, localId: "a2", mailboxId: "mbx_other" };
  const legacy: LocalDraft = { ...local, localId: "legacy" };

  it("only the signed-in account's drafts for this mailbox load; ownerless records never do", () => {
    const all = [mine, otherMailbox, legacy];
    expect(draftsOwnedBy(all, a).map((d) => d.localId)).toEqual(["a1"]);
    expect(draftsOwnedBy(all, b)).toEqual([]);
  });

  it("an ownerless draft is never written", async () => {
    await expect(saveLocalDraft(legacy)).resolves.toBe("legacy");
  });

  it("a different account signing in wipes the previous account's local data", () => {
    expect(localOwnerAction(null, a.userId)).toBe("claim");
    expect(localOwnerAction(a.userId, a.userId)).toBe("keep");
    expect(localOwnerAction(a.userId, b.userId)).toBe("wipe");
  });

  describe("bindLocalOwner / onSignedOut", () => {
    let store: Map<string, string>;
    let deleted: Array<string>;
    beforeEach(() => {
      store = new Map();
      deleted = [];

      // A Storage stand-in whose entries are own keys (clearLocalData walks Object.keys).
      const api = {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
      };

      vi.stubGlobal(
        "localStorage",
        new Proxy(api, {
          ownKeys: () => [...store.keys()],
          getOwnPropertyDescriptor: (_t, k) =>
            store.has(String(k))
              ? { configurable: true, enumerable: true, value: store.get(String(k)) }
              : undefined,
        }),
      );
      vi.stubGlobal("sessionStorage", { clear: () => undefined });
      vi.stubGlobal("indexedDB", {
        deleteDatabase: (name: string) => {
          deleted.push(name);
          const request: DeleteRequest = { onsuccess: null };
          queueMicrotask(() => request.onsuccess?.());

          return request;
        },
        open: () => {
          throw new Error("no IndexedDB in this test");
        },
      });
    });
    afterEach(() => vi.unstubAllGlobals());

    it("same account: nothing is cleared", async () => {
      store.set(LOCAL_OWNER_KEY, a.userId);
      await bindLocalOwner(a.userId);
      expect(deleted).toEqual([]);
      expect(store.get(LOCAL_OWNER_KEY)).toBe(a.userId);
    });

    it("another account: the drafts database is deleted before the new owner is recorded", async () => {
      store.set(LOCAL_OWNER_KEY, a.userId);
      store.set("bye:theme", "dark");
      await bindLocalOwner(b.userId);
      expect(deleted).toEqual(["bye-drafts"]);
      expect(store.get(LOCAL_OWNER_KEY)).toBe(b.userId);
      expect(store.has("bye:theme")).toBe(false);
    });

    it("a 401 sign-out of a bound browser clears local data; an unbound one is left alone", async () => {
      await onSignedOut();
      expect(deleted).toEqual([]);
      store.set(LOCAL_OWNER_KEY, a.userId);
      await onSignedOut();
      expect(deleted).toEqual(["bye-drafts"]);
      expect(store.has(LOCAL_OWNER_KEY)).toBe(false);
    });
  });
});
