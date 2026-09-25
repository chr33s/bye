import { describe, expect, it } from "vitest";
import { SecureStoreError, type SecureSessionStore } from "../src/auth/store.ts";
import type { KeyValueStore } from "../src/drafts.ts";
import { DraftStore } from "../src/drafts.ts";
import { hmacSha256, open, seal, sealedStore, secureStoreKey } from "../src/sealed-store.ts";

const memory = (): KeyValueStore & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return {
    data,
    getItem: async (k) => data.get(k) ?? null,
    setItem: async (k, v) => void data.set(k, v),
    removeItem: async (k) => void data.delete(k),
  };
};

const secure = (): SecureSessionStore & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return {
    data,
    read: async (k) => {
      const v = data.get(k);
      if (v === undefined) throw new SecureStoreError("MissingCredential");
      return v;
    },
    write: async (k, v) => void data.set(k, v),
    remove: async (k) => void data.delete(k),
  };
};

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const key = new Uint8Array(32).fill(7);

describe("sealed draft storage", () => {
  it("HMAC-SHA256 matches RFC 4231 test case 2", () => {
    const mac = hmacSha256(
      new TextEncoder().encode("Jefe"),
      new TextEncoder().encode("what do ya want for nothing?"),
    );
    expect(hex(mac)).toBe("5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
  });

  it("round-trips unicode and rejects tampering, moved records and other keys", () => {
    const text = "Hi Bob — naïve café 🎉 ".repeat(20);
    const sealed = seal(key, "bye:drafts:a", text);
    expect(sealed).not.toContain("Bob");
    expect(open(key, "bye:drafts:a", sealed)).toBe(text);
    expect(open(key, "bye:drafts:b", sealed)).toBeNull();
    expect(open(new Uint8Array(32).fill(8), "bye:drafts:a", sealed)).toBeNull();
    const flipped = sealed.slice(0, 20) + (sealed[20] === "A" ? "B" : "A") + sealed.slice(21);
    expect(open(key, "bye:drafts:a", flipped)).toBeNull();
    expect(seal(key, "k", "same")).not.toBe(seal(key, "k", "same"));
  });

  it("stores drafts as ciphertext with a key kept in the secure store", async () => {
    const kv = memory();
    const vault = secure();
    const drafts = new DraftStore(sealedStore(kv, secureStoreKey(vault)));
    await drafts.save({
      localId: "l1",
      mailboxId: "mbx_1",
      draftId: null,
      baseRevision: 0,
      threadId: null,
      content: { to: [], cc: [], bcc: [], subject: "Secret plans", text: "body" },
      state: "local",
      updatedAt: 1,
    } as never);
    expect([...kv.data.values()].join()).not.toContain("Secret plans");
    expect(vault.data.size).toBe(1);
    expect((await drafts.list())[0]?.content.subject).toBe("Secret plans");
    // A fresh process reuses the stored key.
    const again = new DraftStore(sealedStore(kv, secureStoreKey(vault)));
    expect(await again.list()).toHaveLength(1);
  });

  it("re-seals legacy plaintext on read and never falls back to plaintext", async () => {
    const kv = memory();
    kv.data.set("bye:drafts", '["l1"]');
    const store = sealedStore(kv, secureStoreKey(secure()));
    expect(await store.getItem("bye:drafts")).toBe('["l1"]');
    expect(kv.data.get("bye:drafts")).toMatch(/^s1\./);
    const broken: SecureSessionStore = {
      read: () => Promise.reject(new SecureStoreError("StorageUnavailable")),
      write: () => Promise.reject(new SecureStoreError("StorageUnavailable")),
      remove: async () => undefined,
    };
    const denied = sealedStore(memory(), secureStoreKey(broken));
    await expect(denied.setItem("k", "v")).rejects.toBeInstanceOf(SecureStoreError);
  });
});
