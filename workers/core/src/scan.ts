import { DurableObject } from "cloudflare:workers";
import type { CoreEnv } from "./env.ts";
import { DANGEROUS_EXTENSIONS, isExecutableContent } from "./safety.ts";

// Upload/attachment scanning (§10). A fast in-isolate pre-filter rejects executables by extension or
// magic bytes; everything else is streamed from R2 to the isolated ClamAV container (§3.1 Containers,
// §15.4 media and scans). The container is stateless and never persists customer bytes.

export const SCANNER_PORT = 8080;

/** Internal hostname scanner containers use for signature updates; intercepted, never resolved. */
export const SIGMIRROR_HOST = "sigmirror.internal";

export const SCAN_TIMEOUT_MS = 90_000;

export const SCAN_MAX_BYTES = 100 * 1024 * 1024;

/** Scanner DO instances used round-robin; bounds concurrency to the container pool (§7.4). */
export const SCANNER_POOL = 8;

/** After this many failed attempts the upload is marked `failed` (fail closed), not retried forever. */
export const SCAN_MAX_ATTEMPTS = 4;

const READY_TIMEOUT_MS = 60_000;

export type ScanOutcome = "clean" | "infected" | "failed";

export interface ScannerResponse {
  readonly verdict: "clean" | "infected" | "error";
  readonly signature?: string;
  readonly reason?: string;
}

/**
 * Container-backed Durable Object class. It owns one scanner container instance, starts it on
 * demand, waits for clamd readiness, and forwards `/scan` requests to the container port.
 */
export class ScannerContainer extends DurableObject<CoreEnv> {
  private async ready(): Promise<Fetcher> {
    const container = this.ctx.container;

    if (!container) throw new Error("scanner container binding missing");

    if (!container.running) {
      // No general egress (§15.4): signatures come either baked into the image or from the private
      // SigMirror, reached only through an intercepted service binding — never the internet.
      container.start({
        enableInternet: false,
        env: { SIGNATURE_MIRROR_URL: `http://${SIGMIRROR_HOST}` },
      });

      if (this.env.SIGMIRROR)
        await container.interceptOutboundHttp(SIGMIRROR_HOST, this.env.SIGMIRROR);
      // Scale to zero when idle.
      await container.setInactivityTimeout(10 * 60_000);
    }

    const port = container.getTcpPort(SCANNER_PORT);
    const deadline = Date.now() + READY_TIMEOUT_MS;

    for (let delay = 250; ; delay = Math.min(delay * 2, 2_000)) {
      try {
        const health = await port.fetch("http://scanner/health");

        if (health.ok) return port;
      } catch {
        // port not open yet
      }

      if (Date.now() > deadline) throw new Error("scanner not ready");
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  override async fetch(request: Request): Promise<Response> {
    const port = await this.ready();

    return port.fetch("http://scanner/scan", {
      method: "POST",
      body: request.body,
      headers: { "content-length": request.headers.get("content-length") ?? "" },
      duplex: "half",
    } as RequestInit);
  }
}

const scannerFor = (env: CoreEnv, key: string) => {
  let h = 0;

  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;

  return env.SCANNER.getByName(`scanner-${h % SCANNER_POOL}`);
};

/**
 * Scan a stored object. Returns the final outcome, or throws for a retryable failure so the
 * queue redelivers; on the last attempt a failure resolves to `failed` (fail closed).
 */
export const scanStoredObject = async (
  env: CoreEnv,
  key: string,
  attempt: number,
  options: { readonly bucket?: "PARTS" | "ORIGINALS"; readonly preFilter?: boolean } = {},
): Promise<{ readonly outcome: ScanOutcome; readonly signature?: string }> => {
  const bucket = env[options.bucket ?? "PARTS"];
  const head = await bucket.head(key);

  if (!head) return { outcome: "failed" };

  if (head.size > SCAN_MAX_BYTES) return { outcome: "failed" };

  // Uploads get a fast extension/magic-byte pre-filter. Whole inbound messages (.eml) go straight to
  // ClamAV, which parses MIME, nested messages, encodings and archives itself.
  if (options.preFilter !== false) {
    if (DANGEROUS_EXTENSIONS.test(head.customMetadata?.filename ?? ""))
      return { outcome: "failed" };
    const prefix = await bucket.get(key, { range: { offset: 0, length: 16 } });

    const bytes = prefix
      ? new Uint8Array(await prefix.arrayBuffer()).slice(0, 16)
      : new Uint8Array();

    if (isExecutableContent(bytes)) return { outcome: "failed" };
  }

  try {
    const object = await bucket.get(key);

    if (!object) return { outcome: "failed" };

    const response = await scannerFor(env, key).fetch(
      new Request("http://scanner/scan", {
        method: "POST",
        body: object.body,
        headers: { "content-length": String(object.size) },
        signal: AbortSignal.timeout(SCAN_TIMEOUT_MS),
        // Streamed request body (never buffered in the isolate).
        duplex: "half",
      } as RequestInit),
    );

    const result = (await response.json()) as ScannerResponse;

    if (result.verdict === "clean") return { outcome: "clean" };

    if (result.verdict === "infected") {
      return result.signature
        ? { outcome: "infected", signature: result.signature }
        : { outcome: "infected" };
    }

    throw new Error(`scanner error: ${result.reason ?? response.status}`);
  } catch (error) {
    if (attempt >= SCAN_MAX_ATTEMPTS) return { outcome: "failed" };
    throw error;
  }
};
