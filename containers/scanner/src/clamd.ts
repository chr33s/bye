import { connect, type Socket } from "node:net";

// clamd INSTREAM protocol (clamd(8)): send `zINSTREAM\0`, then chunks each prefixed with a 4-byte
// big-endian length, then a zero-length chunk. The reply is a single NUL-terminated line:
//   "stream: OK" | "stream: <Signature> FOUND" | "<reason> ERROR"
// Bytes are streamed; the request body is never buffered whole in memory.

export type ScanVerdict =
  | { readonly verdict: "clean" }
  | { readonly verdict: "infected"; readonly signature: string }
  | { readonly verdict: "error"; readonly reason: string };

export const INSTREAM_COMMAND = Buffer.from("zINSTREAM\0", "latin1");

/** clamd's default StreamMaxLength chunking is irrelevant to framing; keep chunks bounded. */
export const MAX_CHUNK = 64 * 1024;

export const frameChunk = (chunk: Uint8Array): Buffer => {
  const header = Buffer.alloc(4);
  header.writeUInt32BE(chunk.byteLength, 0);

  return Buffer.concat([header, Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)]);
};

export const END_FRAME: Buffer = Buffer.alloc(4);

/** Split an arbitrarily sized chunk into bounded frames. */
export function* frames(chunk: Uint8Array): Generator<Buffer> {
  for (let offset = 0; offset < chunk.byteLength; offset += MAX_CHUNK) {
    yield frameChunk(chunk.subarray(offset, Math.min(chunk.byteLength, offset + MAX_CHUNK)));
  }
}

export const parseReply = (raw: string): ScanVerdict => {
  const line = raw.replace(/\0+$/, "").trim();
  const found = /^(?:stream|\S+):\s*(.+)\s+FOUND$/.exec(line);

  if (found) return { verdict: "infected", signature: found[1]!.trim() };

  if (/^(?:stream|\S+):\s*OK$/.test(line)) return { verdict: "clean" };

  return { verdict: "error", reason: line.replace(/\s*ERROR$/, "") || "empty reply" };
};

export interface ScanOptions {
  /** Unix socket path or TCP port of clamd. */
  readonly socket: string | { readonly host: string; readonly port: number };
  readonly timeoutMs: number;
  readonly maxBytes: number;
}

export class ScanLimitExceeded extends Error {
  override readonly name = "ScanLimitExceeded";
}

const connectTo = (target: ScanOptions["socket"]): Socket =>
  target instanceof Object ? connect(target.port, target.host) : connect(target);

/** Stream `body` to clamd and return its verdict. Timeouts and limits produce `error`, never `clean`. */
export const scanStream = async (
  body: AsyncIterable<Uint8Array>,
  options: ScanOptions,
): Promise<ScanVerdict> => {
  const socket = connectTo(options.socket);
  let reply = "";

  const done = new Promise<ScanVerdict>((resolve) => {
    socket.setEncoding("latin1");
    socket.on("data", (data: string) => {
      reply += data;

      if (reply.includes("\0")) {
        resolve(parseReply(reply));
        socket.end();
      }
    });
    socket.on("end", () => resolve(parseReply(reply)));
    socket.on("close", () => resolve({ verdict: "error", reason: "connection closed" }));
    socket.on("error", (error) => resolve({ verdict: "error", reason: `clamd: ${error.message}` }));
  });

  const timer = setTimeout(() => {
    socket.destroy(new Error("timeout"));
  }, options.timeoutMs);

  const write = (buffer: Buffer) =>
    new Promise<void>((resolve, reject) => {
      if (socket.destroyed) return reject(new Error("socket closed"));
      socket.write(buffer, (error) => (error ? reject(error) : resolve()));
    });

  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    await write(INSTREAM_COMMAND);
    let total = 0;

    for await (const chunk of body) {
      total += chunk.byteLength;

      if (total > options.maxBytes)
        throw new ScanLimitExceeded(`body exceeds ${options.maxBytes} bytes`);

      for (const frame of frames(chunk)) await write(frame);
    }

    await write(END_FRAME);

    // The timer destroys the socket on timeout, which resolves `done` with an error verdict.
    return await done;
  } catch (error) {
    socket.destroy();

    return { verdict: "error", reason: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
};

/** clamd liveness: `zPING\0` → `PONG\0`. */
export const ping = (socketPath: ScanOptions["socket"], timeoutMs = 2000): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = connectTo(socketPath);
    const timer = setTimeout(() => (socket.destroy(), resolve(false)), timeoutMs);
    let reply = "";
    socket.on("connect", () => socket.write("zPING\0"));
    socket.on("data", (d) => {
      reply += d.toString("latin1");

      if (reply.includes("\0")) {
        clearTimeout(timer);
        socket.end();
        resolve(reply.startsWith("PONG"));
      }
    });
    socket.on("error", () => (clearTimeout(timer), resolve(false)));
  });
