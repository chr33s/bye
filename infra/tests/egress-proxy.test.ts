import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { hostAllowed, proxyEnv, startEgressProxy } from "../policies/egress-proxy.ts";

const run = promisify(execFile);

describe("§13 deployment egress inspection", () => {
  it("matches exact hosts and wildcard subdomains only", () => {
    expect(hostAllowed("api.cloudflare.com:443", ["api.cloudflare.com"])).toBe(true);
    expect(hostAllowed("evil-cloudflare.com", ["*.cloudflare.com"])).toBe(false);
    expect(hostAllowed("x.cloudflare.com", ["*.cloudflare.com"])).toBe(true);
    expect(hostAllowed("api.axiom.co", ["api.cloudflare.com"])).toBe(false);
  });

  it("a real Node process behind the proxy reaches allowed hosts and is blocked (and recorded) on others", async () => {
    const upstream = createServer((_req, res) => res.end("ok"));
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
    const upPort = (upstream.address() as { port: number }).port;
    const proxy = await startEgressProxy(["127.0.0.1"]);

    try {
      const script = `
        const ok = await fetch("http://127.0.0.1:${upPort}/").then(r => r.status, () => -1);
        const blocked = await fetch("http://telemetry.example.invalid/v1/traces").then(r => r.status, () => -1);
        console.log(JSON.stringify({ ok, blocked }));`;

      const { stdout } = await run(process.execPath, ["--input-type=module", "-e", script], {
        env: { ...process.env, ...proxyEnv(proxy.port) },
      });

      const result = JSON.parse(stdout.trim()) as { ok: number; blocked: number };
      expect(result.ok).toBe(200);
      expect(result.blocked).not.toBe(200);
      expect(proxy.report().denied).toContain("telemetry.example.invalid");
      expect(proxy.report().allowed).toContain("127.0.0.1");
    } finally {
      await proxy.close();
      upstream.close();
    }
  }, 30_000);
});
