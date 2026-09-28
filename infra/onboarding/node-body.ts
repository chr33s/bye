// Request bodies for the Node servers (server.ts, deployer/server.ts): read up to a limit, and
// reject (never throw past the caller) when the client aborts mid-upload.
import type { IncomingMessage } from "node:http";

/**
 * The body, or at most `limit + 1` bytes of it: one byte over the limit is enough for the caller
 * to refuse the request without buffering the rest.
 */
export const readBody = async (req: IncomingMessage, limit: number): Promise<Buffer> => {
  const chunks: Array<Buffer> = [];
  let size = 0;

  for await (const c of req) {
    const chunk = c as Buffer;
    chunks.push(chunk);
    size += chunk.length;

    if (size > limit) break;
  }

  return Buffer.concat(chunks).subarray(0, limit + 1);
};
