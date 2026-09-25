import { once } from "node:events";
import { request } from "node:http";
import { createServer, type Server, type Socket } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { END_FRAME, frameChunk, frames, MAX_CHUNK, parseReply, scanStream } from "../src/clamd.ts";
import { startServer } from "../src/server.ts";

const EICAR = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";

interface FakeClamd {
  readonly server: Server;
  readonly socketPath: string;
  readonly received: Array<Buffer>;
}

/** Minimal clamd: validates INSTREAM framing, reassembles the stream, answers like clamd. */
const fakeClamd = async (behaviour: "normal" | "hang" | "error" = "normal"): Promise<FakeClamd> => {
  const socketPath = join(mkdtempSync(join(tmpdir(), "clamd-")), "clamd.sock");
  const received: Array<Buffer> = [];
  const server = createServer((socket: Socket) => {
    let buffer = Buffer.alloc(0);
    let commandSeen = false;
    const body: Array<Buffer> = [];
    socket.on("data", (data: Buffer) => {
      buffer = Buffer.concat([buffer, data]);
      if (!commandSeen) {
        const nul = buffer.indexOf(0);
        if (nul < 0) return;
        const command = buffer.subarray(0, nul).toString("latin1");
        buffer = buffer.subarray(nul + 1);
        commandSeen = true;
        if (command === "zPING") return void socket.end("PONG\0");
        if (command !== "zINSTREAM") return void socket.end("UNKNOWN COMMAND\0");
      }
      while (buffer.length >= 4) {
        const length = buffer.readUInt32BE(0);
        if (buffer.length < 4 + length) return;
        const chunk = buffer.subarray(4, 4 + length);
        buffer = buffer.subarray(4 + length);
        if (length === 0) {
          const all = Buffer.concat(body);
          received.push(all);
          if (behaviour === "hang") return;
          if (behaviour === "error")
            return void socket.end("INSTREAM size limit exceeded. ERROR\0");
          return void socket.end(
            all.includes(EICAR) ? "stream: Eicar-Test-Signature FOUND\0" : "stream: OK\0",
          );
        }
        body.push(Buffer.from(chunk));
      }
    });
  });
  server.listen(socketPath);
  await once(server, "listening");
  return { server, socketPath, received };
};

async function* chunks(...parts: Array<string | Uint8Array>): AsyncGenerator<Uint8Array> {
  for (const p of parts) yield typeof p === "string" ? new TextEncoder().encode(p) : p;
}

const servers: Array<{ close: () => void }> = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

describe("clamd INSTREAM client", () => {
  it("[E20] frames chunks with 4-byte big-endian lengths and a zero terminator", () => {
    expect([...frameChunk(new Uint8Array([1, 2, 3]))]).toEqual([0, 0, 0, 3, 1, 2, 3]);
    expect([...END_FRAME]).toEqual([0, 0, 0, 0]);
    const big = new Uint8Array(MAX_CHUNK * 2 + 5);
    const out = [...frames(big)];
    expect(out.map((f) => f.readUInt32BE(0))).toEqual([MAX_CHUNK, MAX_CHUNK, 5]);
  });

  it("[E20] parses clean, infected and error replies", () => {
    expect(parseReply("stream: OK\0")).toEqual({ verdict: "clean" });
    expect(parseReply("stream: Win.Test.EICAR_HDB-1 FOUND\0")).toEqual({
      verdict: "infected",
      signature: "Win.Test.EICAR_HDB-1",
    });
    expect(parseReply("INSTREAM size limit exceeded. ERROR\0")).toEqual({
      verdict: "error",
      reason: "INSTREAM size limit exceeded.",
    });
    expect(parseReply("")).toMatchObject({ verdict: "error" });
  });

  it("[E20] streams multi-chunk bodies intact and detects EICAR split across chunks", async () => {
    const clamd = await fakeClamd();
    servers.push(clamd.server);
    const clean = await scanStream(chunks("hello ", "world"), {
      socket: clamd.socketPath,
      timeoutMs: 2000,
      maxBytes: 1024,
    });
    expect(clean).toEqual({ verdict: "clean" });
    expect(clamd.received[0]!.toString()).toBe("hello world");
    const infected = await scanStream(chunks(EICAR.slice(0, 20), EICAR.slice(20)), {
      socket: clamd.socketPath,
      timeoutMs: 2000,
      maxBytes: 1024,
    });
    expect(infected).toEqual({ verdict: "infected", signature: "Eicar-Test-Signature" });
  });

  it("[E20] enforces the size limit and timeout without ever reporting clean", async () => {
    const clamd = await fakeClamd();
    servers.push(clamd.server);
    const tooBig = await scanStream(chunks(new Uint8Array(600), new Uint8Array(600)), {
      socket: clamd.socketPath,
      timeoutMs: 2000,
      maxBytes: 1000,
    });
    expect(tooBig.verdict).toBe("error");
    const hung = await fakeClamd("hang");
    servers.push(hung.server);
    expect(
      (
        await scanStream(chunks("data"), {
          socket: hung.socketPath,
          timeoutMs: 100,
          maxBytes: 1000,
        })
      ).verdict,
    ).toBe("error");
    const failing = await fakeClamd("error");
    servers.push(failing.server);
    expect(
      await scanStream(chunks("data"), {
        socket: failing.socketPath,
        timeoutMs: 1000,
        maxBytes: 1000,
      }),
    ).toMatchObject({ verdict: "error" });
    expect(
      (
        await scanStream(chunks("x"), {
          socket: join(tmpdir(), "missing.sock"),
          timeoutMs: 500,
          maxBytes: 10,
        })
      ).verdict,
    ).toBe("error");
  });

  it("[E20] HTTP /scan returns verdicts and refuses oversized declared bodies", async () => {
    const clamd = await fakeClamd();
    servers.push(clamd.server);
    const server = startServer({
      port: 0,
      socket: clamd.socketPath,
      timeoutMs: 2000,
      maxBytes: 128,
    });
    servers.push(server);
    await once(server, "listening");
    const port = (server.address() as { port: number }).port;
    const post = (body: string) =>
      new Promise<{ status: number; json: unknown }>((resolve, reject) => {
        const req = request(
          {
            port,
            method: "POST",
            path: "/scan",
            headers: { "content-length": Buffer.byteLength(body) },
          },
          (res) => {
            let text = "";
            res.on("data", (d) => (text += d));
            res.on("end", () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(text) }));
          },
        );
        req.on("error", reject);
        req.end(body);
      });
    expect(await post(EICAR)).toEqual({
      status: 200,
      json: { verdict: "infected", signature: "Eicar-Test-Signature" },
    });
    expect(await post("fine")).toEqual({ status: 200, json: { verdict: "clean" } });
    expect((await post("x".repeat(200))).status).toBe(413);
  });
});
