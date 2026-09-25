// Deployment egress inspection (§13 "Deployment privacy", §15.7). Runs a command (e.g. the
// pinned `alchemy plan`/`deploy`) behind an allowlisting HTTP(S) proxy and fails if it contacted
// any host outside the approved set — catching telemetry/observability exporters regardless of
// what the CLI flags claim. Node honours the proxy via NODE_USE_ENV_PROXY=1 (Node ≥ 24).
//
// Usage: node --experimental-strip-types infra/policies/egress-proxy.ts [--allow host,...] -- <command> [args...]
// Default allowlist: api.cloudflare.com plus the BYE_STATE_URL host when set.
import { spawn } from "node:child_process";
import { createServer, request as httpRequest, type Server } from "node:http";
import { connect } from "node:net";

export interface EgressReport {
  readonly allowed: ReadonlyArray<string>;
  readonly denied: ReadonlyArray<string>;
}

export const DEFAULT_ALLOW = ["api.cloudflare.com"];

export const hostAllowed = (host: string, allow: ReadonlyArray<string>): boolean => {
  const h = host.toLowerCase().replace(/:\d+$/, "");
  return allow.some((a) => (a.startsWith("*.") ? h.endsWith(a.slice(1)) : h === a));
};

/** Start the proxy; returns its port, the live report and a close function. */
export const startEgressProxy = async (
  allow: ReadonlyArray<string>,
): Promise<{ port: number; report: () => EgressReport; close: () => Promise<void> }> => {
  const allowed = new Set<string>();
  const denied = new Set<string>();
  const server: Server = createServer((req, res) => {
    // Plain-HTTP proxying (absolute-form URL).
    const target = new URL(req.url ?? "", "http://invalid");
    if (!hostAllowed(target.host, allow)) {
      denied.add(target.hostname);
      res.writeHead(403).end("egress denied");
      return;
    }
    allowed.add(target.hostname);
    const upstream = httpRequest(
      {
        host: target.hostname,
        port: target.port || 80,
        path: target.pathname + target.search,
        method: req.method,
        headers: req.headers,
      },
      (u) => {
        res.writeHead(u.statusCode ?? 502, u.headers);
        u.pipe(res);
      },
    );
    upstream.on("error", () => res.writeHead(502).end());
    req.pipe(upstream);
  });
  server.on("connect", (req, clientSocket, head) => {
    const [host = "", port = "443"] = (req.url ?? "").split(":");
    if (!hostAllowed(host, allow)) {
      denied.add(host);
      clientSocket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    allowed.add(host);
    const upstream = connect(Number(port), host, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on("error", () => clientSocket.end());
    clientSocket.on("error", () => upstream.destroy());
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return {
    port,
    report: () => ({ allowed: [...allowed].sort(), denied: [...denied].sort() }),
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
};

export const proxyEnv = (port: number): Record<string, string> => ({
  HTTPS_PROXY: `http://127.0.0.1:${port}`,
  HTTP_PROXY: `http://127.0.0.1:${port}`,
  NODE_USE_ENV_PROXY: "1",
  NO_PROXY: "",
});

if (import.meta.main) {
  const args = process.argv.slice(2);
  const sep = args.indexOf("--");
  const allowIdx = args.indexOf("--allow");
  const extra =
    allowIdx >= 0 && allowIdx < sep ? (args[allowIdx + 1] ?? "").split(",").filter(Boolean) : [];
  const state = process.env.BYE_STATE_URL ? [new URL(process.env.BYE_STATE_URL).hostname] : [];
  const command = args.slice(sep + 1);
  if (sep < 0 || command.length === 0) {
    console.error("usage: egress-proxy.ts [--allow host,...] -- <command> [args...]");
    process.exit(2);
  }
  const proxy = await startEgressProxy([...DEFAULT_ALLOW, ...state, ...extra]);
  const child = spawn(command[0]!, command.slice(1), {
    stdio: "inherit",
    env: { ...process.env, ...proxyEnv(proxy.port) },
  });
  const code = await new Promise<number>((r) => child.on("exit", (c) => r(c ?? 1)));
  await proxy.close();
  const report = proxy.report();
  console.error(
    `egress: allowed=${report.allowed.join(",") || "-"} denied=${report.denied.join(",") || "-"}`,
  );
  process.exit(code !== 0 ? code : report.denied.length > 0 ? 3 : 0);
}
