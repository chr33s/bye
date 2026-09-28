import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { CONTAINER_LIMITS, parseToLines } from "./parse.ts";

// POST /parse?receivedAt=<ms> with the raw message → application/x-ndjson (see parse.ts).
// Stateless: nothing is written to disk; bodies above the limit are refused before parsing.

const PORT = Number(process.env.PORT ?? "8080");

const MAX_BYTES = Number(process.env.MIME_MAX_BYTES ?? String(CONTAINER_LIMITS.maxBytes));

const TIMEOUT_MS = Number(process.env.MIME_TIMEOUT_MS ?? "60000");

const readBounded = (req: IncomingMessage, max: number): Promise<Uint8Array | null> =>
  new Promise((resolve, reject) => {
    const chunks: Array<Buffer> = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      if (size > max) return;
      size += c.length;

      // Stop buffering but keep the socket open so the 413 can still be delivered; the handler
      // closes the connection once the response is flushed.
      if (size > max) resolve(null);
      else chunks.push(c);
    });
    req.on("end", () => resolve(new Uint8Array(Buffer.concat(chunks))));
    req.on("error", reject);
  });

export const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
  const url = new URL(req.url ?? "/", "http://mime");

  if (req.method === "GET" && url.pathname === "/health") {
    res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');

    return;
  }

  if (req.method !== "POST" || url.pathname !== "/parse") {
    res.writeHead(404).end();

    return;
  }

  if (Number(req.headers["content-length"] ?? "0") > MAX_BYTES) {
    req.resume();
    res.writeHead(413, { "content-type": "application/json" }).end('{"error":"too large"}');

    return;
  }

  const bytes = await readBounded(req, MAX_BYTES);

  if (!bytes) {
    res
      .writeHead(413, { "content-type": "application/json", connection: "close" })
      .end('{"error":"too large"}', () => req.destroy());

    return;
  }

  const receivedAt = Number(url.searchParams.get("receivedAt") ?? Date.now());
  res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-store" });

  for (const line of parseToLines(bytes, receivedAt)) {
    if (!res.write(`${line}\n`)) await new Promise((r) => res.once("drain", r));
  }

  res.end();
};

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("server.mjs")) {
  const server = createServer((req, res) => {
    const timer = setTimeout(() => res.destroy(), TIMEOUT_MS);
    handler(req, res)
      .finally(() => clearTimeout(timer))
      .catch(() => res.destroy());
  });

  server.listen(PORT, () =>
    console.log(JSON.stringify({ level: "info", op: "mime.listen", port: PORT })),
  );
}
