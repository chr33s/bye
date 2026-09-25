import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// MAX_BYTES is read at module load, so the env var is stubbed before the dynamic import.
const LIMIT = 1024;
let server: Server;
let port: number;

beforeAll(async () => {
  vi.stubEnv("MIME_MAX_BYTES", String(LIMIT));
  const { handler } = await import("../src/server.ts");
  server = createServer((req, res) => void handler(req, res).catch(() => res.destroy()));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await new Promise((r) => server.close(r));
});

const post = (
  body: Array<string>,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> =>
  new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, method: "POST", path: "/parse?receivedAt=1", headers },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text }));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    for (const chunk of body) req.write(chunk);
    req.end();
  });

const small = "From: a@example.net\r\nSubject: hi\r\n\r\nhello\r\n";

describe("MIME container body limit", () => {
  it("refuses a declared Content-Length above the limit with 413 before reading", async () => {
    const big = "x".repeat(LIMIT + 1);
    const res = await post([big], { "content-length": String(big.length) });
    expect(res.status).toBe(413);
    expect(JSON.parse(res.body)).toEqual({ error: "too large" });
  });

  it("refuses a chunked body that grows past the limit with 413", async () => {
    const res = await post(
      Array.from({ length: 4 }, () => "x".repeat(LIMIT / 2)),
      { "transfer-encoding": "chunked" },
    );
    expect(res.status).toBe(413);
    expect(JSON.parse(res.body)).toEqual({ error: "too large" });
  });

  it("parses a body at or under the limit", async () => {
    const res = await post([small], { "content-length": String(small.length) });
    expect(res.status).toBe(200);
    const [meta] = res.body
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(meta.type).toBe("meta");
    expect(meta.summary.subject).toBe("hi");
  });
});
