import { DurableObject } from "cloudflare:workers";
import type { MessageSummary } from "@bye/mail-codec";
import type { CoreEnv } from "./env.ts";

// Exceptional MIME processing (§3.1 Containers, §5.1 step 5). Messages above the in-isolate budget
// are parsed by a bounded, isolated container (containers/mime). Its NDJSON response is consumed
// line by line so the isolate holds at most the metadata plus one decoded part at a time.

export const MIME_PORT = 8080;

/** Above this size the consumer offloads parsing to the container via the ParseScan queue. */
export const MIME_INLINE_MAX_BYTES = 8 * 1024 * 1024;

export const MIME_POOL = 4;

const READY_TIMEOUT_MS = 60_000;

const PARSE_TIMEOUT_MS = 120_000;

export class MimeContainer extends DurableObject<CoreEnv> {
  private async ready(): Promise<Fetcher> {
    const container = this.ctx.container;

    if (!container) throw new Error("mime container binding missing");

    if (!container.running) {
      // Parsing needs no network at all.
      container.start({ enableInternet: false });
      await container.setInactivityTimeout(5 * 60_000);
    }

    const port = container.getTcpPort(MIME_PORT);
    const deadline = Date.now() + READY_TIMEOUT_MS;

    for (let delay = 250; ; delay = Math.min(delay * 2, 2_000)) {
      try {
        if ((await port.fetch("http://mime/health")).ok) return port;
      } catch {
        // not listening yet
      }

      if (Date.now() > deadline) throw new Error("mime container not ready");
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  override async fetch(request: Request): Promise<Response> {
    const port = await this.ready();
    const url = new URL(request.url);

    return port.fetch(`http://mime/parse${url.search}`, {
      method: "POST",
      body: request.body,
      headers: { "content-length": request.headers.get("content-length") ?? "" },
      duplex: "half",
    } as RequestInit);
  }
}

export interface MimeMeta {
  readonly type: "meta";
  readonly summary: MessageSummary;
  readonly body: {
    readonly text: string;
    readonly html: string | null;
    readonly remoteImages: number;
    readonly blockedTrackers: number;
  };
  readonly headers: ReadonlyArray<readonly [string, string]>;
  readonly attachments: ReadonlyArray<{
    readonly partId: string;
    readonly filename: string;
    readonly contentType: string;
    readonly size: number;
    readonly contentId?: string;
  }>;
  readonly truncated: boolean;
  readonly warnings: ReadonlyArray<string>;
}

export interface MimePartLine {
  readonly type: "part";
  readonly partId: string;
  readonly filename: string;
  readonly contentBase64: string;
}

/** Split a byte stream into NDJSON lines without buffering the whole response. */
export async function* ndjsonLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
  let buffered = "";

  for (;;) {
    const { done, value } = await reader.read();

    if (done) break;
    buffered += value;
    let nl: number;

    while ((nl = buffered.indexOf("\n")) >= 0) {
      const line = buffered.slice(0, nl);
      buffered = buffered.slice(nl + 1);

      if (line.trim()) yield line;
    }
  }

  if (buffered.trim()) yield buffered;
}

const fromBase64 = (value: string): Uint8Array =>
  Uint8Array.from(atob(value), (c) => c.charCodeAt(0));

const mimeFor = (env: CoreEnv, key: string) => {
  let h = 0;

  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;

  return env.MIME_PARSER.getByName(`mime-${h % MIME_POOL}`);
};

/**
 * Parse a stored original through the container. `onPart` is called once per attachment, in order,
 * with its decoded bytes; the caller persists it before the next line is read.
 */
export const parseViaContainer = async (
  env: CoreEnv,
  objectKey: string,
  receivedAt: number,
  onPart: (part: {
    readonly partId: string;
    readonly filename: string;
    readonly content: Uint8Array;
  }) => Promise<void>,
): Promise<MimeMeta> => {
  const object = await env.ORIGINALS.get(objectKey);

  if (!object) throw new Error("original missing");

  const response = await mimeFor(env, objectKey).fetch(
    new Request(`http://mime/parse?receivedAt=${receivedAt}`, {
      method: "POST",
      body: object.body,
      headers: { "content-length": String(object.size) },
      signal: AbortSignal.timeout(PARSE_TIMEOUT_MS),
      duplex: "half",
    } as RequestInit),
  );

  if (!response.ok || !response.body) throw new Error(`mime container http ${response.status}`);
  let meta: MimeMeta | null = null;

  for await (const line of ndjsonLines(response.body)) {
    const record = JSON.parse(line) as MimeMeta | MimePartLine;

    if (record.type === "meta") meta = record;
    else if (record.type === "part") {
      if (!meta) throw new Error("mime protocol: part before meta");
      await onPart({
        partId: record.partId,
        filename: record.filename,
        content: fromBase64(record.contentBase64),
      });
    }
  }

  if (!meta) throw new Error("mime protocol: missing meta");

  return meta;
};
