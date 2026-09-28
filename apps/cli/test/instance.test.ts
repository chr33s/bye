import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  EMPTY_CONFIG,
  EXIT,
  migrateConfig,
  resolveTarget,
  runInstance,
  runLogin,
  type StoredConfig,
  TargetError,
} from "@bye/cli";
import type { ProbeFetch } from "@bye/native-shared/instance";
import { readStored, writeStored } from "../src/config.ts";

// CLI parity (spec §10 NA05): precedence, effective-target reporting, and
// credentials that never leave the instance they were saved for.

const A = "https://a.example";
const B = "https://b.example";
const saved: StoredConfig = {
  version: 2,
  selected: A,
  instances: { [A]: { token: "tok_a", mailboxId: "mbx_a" }, [B]: { token: "tok_b" } },
};

describe("CLI target precedence", () => {
  it("BYE_API wins for this invocation, with only its own credential", () => {
    expect(resolveTarget(saved, { BYE_API: "https://B.example/" })).toMatchObject({
      apiUrl: B,
      source: "BYE_API",
      token: "tok_b",
      mailboxId: undefined,
    });
    // An unknown override gets no borrowed credential and no fallback.
    expect(resolveTarget(saved, { BYE_API: "https://c.example" })).toMatchObject({
      apiUrl: "https://c.example",
      token: undefined,
    });
    expect(() => resolveTarget(saved, { BYE_API: "http://c.example" })).toThrow(TargetError);
    expect(() => resolveTarget(saved, { BYE_API: "https://10.0.0.5" })).toThrow(TargetError);
    expect(
      resolveTarget(saved, { BYE_API: "https://10.0.0.5", BYE_PRIVATE_NETWORK: "allow" }).apiUrl,
    ).toBe("https://10.0.0.5");
    expect(
      resolveTarget(saved, { BYE_API: "http://localhost:8787", BYE_INSECURE_LOOPBACK: "1" }).apiUrl,
    ).toBe("http://localhost:8787");
  });

  it("then the saved default, then hosted on first use", () => {
    expect(resolveTarget(saved, {})).toMatchObject({ apiUrl: A, source: "saved", token: "tok_a" });
    expect(resolveTarget(EMPTY_CONFIG, {})).toMatchObject({
      apiUrl: "https://app.bye.software",
      source: "hosted",
      token: undefined,
    });
    expect(resolveTarget(EMPTY_CONFIG, { BYE_TOKEN: "t" }).token).toBe("t");
  });

  it("migrates a v1 file into one instance entry without re-targeting its token", () => {
    expect(migrateConfig({ apiUrl: "https://A.example/", token: "tok", mailboxId: "m" })).toEqual({
      version: 2,
      selected: A,
      instances: { [A]: { token: "tok", mailboxId: "m" } },
    });
    // The old dev default is not https: dropped rather than silently sent elsewhere.
    expect(migrateConfig({ apiUrl: "http://localhost:8787", token: "tok" })).toEqual(EMPTY_CONFIG);
  });
});

const deps = (initial: StoredConfig, env: Record<string, string> = {}, fetch?: ProbeFetch) => {
  let config = initial;
  const out: Array<string> = [];
  const err: Array<string> = [];
  return {
    get config() {
      return config;
    },
    out,
    err,
    deps: {
      env,
      read: async () => config,
      write: async (c: StoredConfig) => void (config = c),
      fetch: fetch ?? (async () => ({ status: 404, text: async () => "" })),
      stdout: (t: string) => void out.push(t),
      stderr: (t: string) => void err.push(t),
    },
  };
};

describe("bye instance", () => {
  it("show reports the effective target without changing the saved default", async () => {
    const d = deps(saved, { BYE_API: B });
    expect(await runInstance(["show"], { json: true }, d.deps)).toBe(EXIT.ok);
    expect(JSON.parse(d.out[0]!)).toEqual({
      url: B,
      source: "BYE_API",
      credential: "saved",
      issuer: null,
      savedDefault: A,
    });
    expect(d.config.selected).toBe(A);
  });

  it("add validates the instance first and stores its issuer; failures save nothing", async () => {
    const doc = {
      schema: "bye.instance/1",
      baseUrl: "https://c.example",
      issuer: "https://c.example",
      api: { min: 1, max: 1 },
      capabilities: ["device-session", "authorization-response-iss"],
      clients: [{ clientId: "bye-cli", redirectUris: [] }],
    };
    const meta = {
      issuer: "https://c.example",
      authorization_endpoint: "https://c.example/oauth/authorize",
      token_endpoint: "https://c.example/oauth/token",
      code_challenge_methods_supported: ["S256"],
      authorization_response_iss_parameter_supported: true,
    };
    const seen: Array<Record<string, string>> = [];
    const fetch: ProbeFetch = async (url, init) => {
      seen.push(init.headers);
      const body =
        url === "https://c.example/.well-known/bye-instance"
          ? doc
          : url === "https://c.example/.well-known/oauth-authorization-server"
            ? meta
            : null;
      return { status: body ? 200 : 404, text: async () => JSON.stringify(body) };
    };
    const d = deps(saved, {}, fetch);
    expect(await runInstance(["add", "https://C.example"], {}, d.deps)).toBe(EXIT.ok);
    expect(d.config.instances["https://c.example"]).toEqual({ issuer: "https://c.example" });
    expect(d.config.selected).toBe(A);
    expect(seen.every((h) => !("authorization" in h))).toBe(true);

    const bad = deps(saved);
    expect(await runInstance(["add", "https://d.example"], {}, bad.deps)).toBe(EXIT.failure);
    expect(bad.config).toBe(saved);
  });

  it("add accepts a loopback http dev server with BYE_INSECURE_LOOPBACK=1, as BYE_API does", async () => {
    const base = "http://localhost:1337";
    const doc = {
      schema: "bye.instance/1",
      baseUrl: base,
      issuer: base,
      api: { min: 1, max: 1 },
      capabilities: ["device-session", "authorization-response-iss"],
      clients: [{ clientId: "bye-cli", redirectUris: [] }],
    };
    const meta = {
      issuer: base,
      authorization_endpoint: `${base}/oauth/authorize`,
      token_endpoint: `${base}/oauth/token`,
      code_challenge_methods_supported: ["S256"],
      authorization_response_iss_parameter_supported: true,
    };
    const fetch: ProbeFetch = async (url) => {
      const body =
        url === `${base}/.well-known/bye-instance`
          ? doc
          : url === `${base}/.well-known/oauth-authorization-server`
            ? meta
            : null;
      return { status: body ? 200 : 404, text: async () => JSON.stringify(body) };
    };
    const strict = deps(EMPTY_CONFIG, {}, fetch);
    expect(await runInstance(["add", base], {}, strict.deps)).toBe(EXIT.usage);
    const d = deps(EMPTY_CONFIG, { BYE_INSECURE_LOOPBACK: "1" }, fetch);
    expect(await runInstance(["add", base], {}, d.deps)).toBe(EXIT.ok);
    expect(d.config.instances[base]).toEqual({ issuer: base });
  });

  it("use and remove act on saved instances only; login binds a token to one instance", async () => {
    const d = deps(saved);
    expect(await runInstance(["use", "https://x.example"], {}, d.deps)).toBe(EXIT.usage);
    expect(await runInstance(["use", B], {}, d.deps)).toBe(EXIT.ok);
    expect(d.config.selected).toBe(B);
    expect(await runInstance(["remove", B], {}, d.deps)).toBe(EXIT.ok);
    expect(d.config.instances[B]).toBeUndefined();
    expect(d.config.selected).toBeNull();
    expect(await runLogin({ api: "https://e.example/", token: "tok_e" }, d.deps)).toBe(EXIT.ok);
    expect(d.config.selected).toBe("https://e.example");
    expect(d.config.instances[A]!.token).toBe("tok_a");
    expect(d.config.instances["https://e.example"]!.token).toBe("tok_e");
  });
});

describe("config file", () => {
  let dir: string;
  let previous: string | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "bye-cli-config-"));
    previous = process.env.BYE_CONFIG;
  });
  afterEach(async () => {
    if (previous === undefined) delete process.env.BYE_CONFIG;
    else process.env.BYE_CONFIG = previous;
    await rm(dir, { recursive: true, force: true });
  });

  it("[NA05] a missing or corrupt config file reads as empty instead of failing", async () => {
    process.env.BYE_CONFIG = join(dir, "missing.json");
    expect(await readStored()).toEqual(EMPTY_CONFIG);
    const corrupt = join(dir, "corrupt.json");
    await writeFile(corrupt, '{"version": 2, "instances": {');
    process.env.BYE_CONFIG = corrupt;
    expect(await readStored()).toEqual(EMPTY_CONFIG);
  });

  it.skipIf(process.platform === "win32")(
    "[NA05] saved credentials are owner-only: 0600 file in a 0700 directory, round-tripped",
    async () => {
      const path = join(dir, "nested", "bye", "config.json");
      process.env.BYE_CONFIG = path;
      await writeStored(saved);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect((await stat(join(dir, "nested", "bye"))).mode & 0o777).toBe(0o700);
      expect(JSON.parse(await readFile(path, "utf8"))).toEqual(saved);
      expect(await readStored()).toEqual(saved);

      // A pre-existing, world-readable file is tightened on the next write.
      const loose = join(dir, "loose.json");
      await writeFile(loose, "{}", { mode: 0o644 });
      process.env.BYE_CONFIG = loose;
      await writeStored(saved);
      expect((await stat(loose)).mode & 0o777).toBe(0o600);
    },
  );
});
