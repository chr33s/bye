import { describe, expect, it } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { commandEnv, parseJson, readCommand, redact } from "../command.ts";
import { bindingIdentities, findUnique, paged } from "../discover.ts";
import {
  approvalDigest,
  directoryDigest,
  verifyFreshApproval,
  type ApprovalInputs,
} from "../evidence.ts";
import { withSecretsFile } from "../secrets.ts";

describe("cf command boundary", () => {
  it("parses only JSON and never exposes malformed output", () => {
    expect(parseJson('{"result":[]}')).toEqual({ result: [] });
    expect(() => parseJson('banner\n{"result":[]}')).toThrow("valid JSON");
    expect(() => parseJson("secret-token-is-in-invalid-output")).toThrow("valid JSON");
  });
  it("allowlists environments and rejects every write/local simulation command", () => {
    const env = commandEnv({
      PATH: "/bin",
      CLOUDFLARE_API_TOKEN: "test-token",
      CLOUDFLARE_ACCOUNT_ID: "account",
      STATE_BACKEND: "http",
      BYE_STATE_TOKEN: "old-token",
      SESSION_KEY: "private",
      ALCHEMY_PASSWORD: "private",
    });

    expect(env).toMatchObject({
      CF_SEND_TELEMETRY: "false",
      DO_NOT_TRACK: "1",
      CLOUDFLARE_ACCOUNT_ID: "account",
    });
    expect(Object.keys(env)).not.toContain("SESSION_KEY");
    expect(Object.keys(env)).not.toContain("BYE_STATE_TOKEN");
    expect(readCommand(["d1", "list"])).toBe(true);

    for (const command of [
      ["d1", "delete", "id"],
      ["workers", "deployments", "create"],
      ["d1", "list", "--local"],
      ["d1", "list", "--dry-run"],
    ])
      expect(readCommand(command)).toBe(false);
    expect(
      redact("bearer abcdefghijklmnop value=test-token short=abc", ["test-token", "abc"]),
    ).not.toContain("test-token");
    expect(redact("small=abc", ["abc"])).toBe("small=[redacted]");
  });
  it("drains pagination and blocks repeated/incomplete pages", async () => {
    const calls: ReadonlyArray<string>[] = [];

    const result = await paged(
      {
        async json(args) {
          calls.push(args);

          return args.includes("1")
            ? Array.from({ length: 50 }, (_, i) => ({ id: String(i) }))
            : [{ id: "50" }];
        },
      },
      ["d1", "list"],
    );

    expect(result).toHaveLength(51);
    expect(calls).toHaveLength(2);
    await expect(
      paged(
        {
          async json() {
            return Array.from({ length: 50 }, (_, i) => ({ id: String(i) }));
          },
        },
        ["d1", "list"],
      ),
    ).rejects.toThrow("repeated");
    expect(() => findUnique([{ id: "same" }, { id: "same" }], "id", "same")).toThrow("ambiguous");
  });
  it("projects non-secret live binding IDs and refuses uncharacterized types", () => {
    const bindings = bindingIdentities([
      { name: "SESSION_KEY", type: "secret_text", text: "never-export-me" },
      { name: "DIRECTORY", type: "d1", id: "database-id", created_at: "ignored" },
    ]);

    expect(bindings).toEqual([
      { name: "SESSION_KEY", type: "secret_text" },
      { name: "DIRECTORY", type: "d1", id: "database-id" },
    ]);
    expect(() => bindingIdentities([{ name: "NEW", type: "unknown" }])).toThrow("uncharacterized");
  });
});

describe("release evidence and secret file lifecycle", () => {
  it("invalidates approval on live identity, migration, source, account or plan changes", () => {
    const inputs: ApprovalInputs = {
      stage: "prod",
      accountId: "account",
      releaseCommit: "a".repeat(40),
      sourceDigest: "b".repeat(64),
      lockDigest: "c".repeat(64),
      migrationDigest: "d".repeat(64),
      resourceMapDigest: "e".repeat(64),
      discoveryDigest: "f".repeat(64),
      configDigest: "1".repeat(64),
      configVersion: "0.22.0",
      plan: { stack: "MailboxPlatform", stage: "prod", entries: [] },
    };

    const approved = approvalDigest(inputs);
    expect(() => verifyFreshApproval(approved, inputs)).not.toThrow();

    for (const key of [
      "migrationDigest",
      "sourceDigest",
      "resourceMapDigest",
      "discoveryDigest",
    ] as const)
      expect(() => verifyFreshApproval(approved, { ...inputs, [key]: "2".repeat(64) })).toThrow(
        "approved digest",
      );
    expect(() => verifyFreshApproval(approved, { ...inputs, accountId: "another" })).toThrow(
      "approved digest",
    );
  });
  it("hashes paths/bytes and refuses symlinks or secret artifacts", () => {
    const directory = mkdtempSync(join(tmpdir(), "bye-cf-artifact-test-"));

    try {
      writeFileSync(join(directory, "config.json"), "{}");
      const before = directoryDigest(directory);
      writeFileSync(join(directory, "config.json"), '{"changed":true}');
      expect(directoryDigest(directory)).not.toBe(before);
      symlinkSync(join(directory, "config.json"), join(directory, "link"));
      expect(() => directoryDigest(directory)).toThrow("symlink");
      rmSync(join(directory, "link"));
      writeFileSync(join(directory, ".env"), "SECRET=value");
      expect(() => directoryDigest(directory)).toThrow("secrets file");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it("writes 0600 secrets and removes files/directories on success and failure", async () => {
    let path = "";
    await withSecretsFile({ SESSION_KEY: "test" }, async (created) => {
      path = created;
      expect(statSync(created).mode & 0o777).toBe(0o600);
      expect(statSync(dirname(created)).mode & 0o777).toBe(0o700);
      expect(JSON.parse(readFileSync(created, "utf8"))).toEqual({ SESSION_KEY: "test" });
    });
    expect(existsSync(path)).toBe(false);
    await expect(
      withSecretsFile({ SESSION_KEY: "test" }, async (created) => {
        path = created;
        throw new Error("upload failed");
      }),
    ).rejects.toThrow("upload failed");
    expect(existsSync(dirname(path))).toBe(false);
    await expect(
      withSecretsFile({ CLOUDFLARE_API_TOKEN: "private" }, async () => {}),
    ).rejects.toThrow("management credentials");
  });
});
