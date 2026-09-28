import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { ping, scanStream, type ScanOptions, type ScanVerdict } from "./clamd.ts";

// POST /scan streams the request body to clamd and answers {verdict, signature?}. The service holds
// no state and writes nothing to disk: bodies go straight to clamd's socket (§3.1 Containers).

export interface ScannerConfig extends ScanOptions {
  readonly port: number;
}

export const configFromEnv = (env: NodeJS.ProcessEnv): ScannerConfig => ({
  port: Number(env.PORT ?? "8080"),
  socket: env.CLAMD_SOCKET ?? "/tmp/clamd.sock",
  timeoutMs: Number(env.SCAN_TIMEOUT_MS ?? "60000"),
  maxBytes: Number(env.SCAN_MAX_BYTES ?? String(100 * 1024 * 1024)),
});

const reply = (
  res: ServerResponse,
  status: number,
  body: ScanVerdict | { readonly ok: boolean },
) => {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
};

export const handler =
  (config: ScannerConfig) => async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method === "GET" && req.url === "/health") {
      const ok = await ping(config.socket);

      return reply(res, ok ? 200 : 503, { ok });
    }

    if (req.method !== "POST" || req.url !== "/scan")
      return reply(res, 404, { verdict: "error", reason: "not found" });
    const declared = Number(req.headers["content-length"] ?? "0");

    if (declared > config.maxBytes) {
      req.resume();

      return reply(res, 413, { verdict: "error", reason: "too large" });
    }

    const result = await scanStream(req, config);
    // Infected is a successful scan; only transport/limit problems are errors (caller retries or fails closed).
    reply(res, result.verdict === "error" ? 502 : 200, result);
  };

export const startServer = (config: ScannerConfig) => {
  const server = createServer(handler(config));
  server.requestTimeout = config.timeoutMs + 5_000;
  server.listen(config.port);

  return server;
};

if (import.meta.main) {
  startServer(configFromEnv(process.env));
}
