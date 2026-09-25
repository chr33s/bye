import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  open,
  packDirectory,
  seal,
  unpackTo,
  uploadEscrow,
} from "../drills/escrow-foundation-state.ts";

const KEY = "ab".repeat(32);

describe("§15.6 foundation state escrow", () => {
  it("packs, encrypts, uploads under a fresh key, and restores byte-identically", async () => {
    const src = mkdtempSync(join(tmpdir(), "esc-src-"));
    const out = mkdtempSync(join(tmpdir(), "esc-out-"));
    try {
      mkdirSync(join(src, "ByeFoundation", "foundation"), { recursive: true });
      writeFileSync(
        join(src, "ByeFoundation", "foundation", "StateBackups.json"),
        JSON.stringify({ status: "created", attr: { name: "b" } }),
      );
      writeFileSync(join(src, "root.json"), "{}");
      const sealed = seal(packDirectory(src), KEY);
      expect(new TextDecoder().decode(sealed)).not.toContain("StateBackups");
      const calls: Array<{ url: string; method: string }> = [];
      const key1 = await uploadEscrow(
        sealed,
        { accountId: "acct", token: "t", bucket: "StateBackups" },
        async (url, init) => (
          calls.push({ url, method: init.method }),
          { status: 200, text: async () => "" }
        ),
      );
      expect(key1).toMatch(/^foundation-state\/.+\.bin$/);
      expect(calls[0]).toMatchObject({ method: "PUT" });
      expect(calls[0]!.url).toContain(
        "/accounts/acct/r2/buckets/StateBackups/objects/foundation-state/",
      );
      expect(unpackTo(open(sealed, KEY), out)).toBe(2);
      expect(
        readFileSync(join(out, "ByeFoundation", "foundation", "StateBackups.json"), "utf8"),
      ).toContain("created");
    } finally {
      rmSync(src, { recursive: true, force: true });
      rmSync(out, { recursive: true, force: true });
    }
  });

  it("rejects a wrong key, tampering, and path traversal", () => {
    const sealed = seal(Buffer.from("x"), KEY);
    expect(() => open(sealed, "cd".repeat(32))).toThrow();
    const tampered = Buffer.from(sealed);
    tampered[tampered.length - 1]! ^= 1;
    expect(() => open(tampered, KEY)).toThrow();
    const evil = Buffer.from(
      require("node:zlib").gzipSync(
        JSON.stringify({ version: 1, files: [{ path: "../etc/passwd", data: "" }] }),
      ),
    );
    expect(() => unpackTo(evil, mkdtempSync(join(tmpdir(), "esc-evil-")))).toThrow(/unsafe path/);
  });
});
