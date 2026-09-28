// Private ClamAV signature mirror (§3.1 Containers, §10). Scanner containers point freshclam's
// PrivateMirror at this Worker, reached only through a service binding intercepted inside the
// container runtime, so scanners need no internet egress. The Worker itself never calls out.
//
//   GET/HEAD /<name>            read (If-None-Match, If-Modified-Since, single Range)
//   GET/HEAD /<token>/<name>    read when READ_TOKEN is set (unguessable path prefix)
//   PUT      /w/<name>          write a database file (Bearer WRITE_TOKEN)
//   DELETE   /w/<name>          prune a file (Bearer WRITE_TOKEN)
//   GET      /w/_manifest       name → size/etag for the mirror job (Bearer WRITE_TOKEN)
//   GET|PUT  /w/_state          cvdupdate state.json, so rate-limit state survives job runs

import { bearerMatches, timingSafeEqual } from "@bye/domain";

export interface MirrorObject {
  readonly size: number;
  readonly etag: string;
  readonly httpEtag: string;
  readonly uploaded: Date;
  readonly body?: ReadableStream;
}

/** Narrow R2 surface used by the mirror (tests supply an in-memory implementation). */
export interface MirrorBucket {
  head(key: string): Promise<MirrorObject | null>;
  get(
    key: string,
    options?: { range?: { offset: number; length?: number } | { suffix: number } },
  ): Promise<(MirrorObject & { body: ReadableStream }) | null>;
  put(
    key: string,
    value: ReadableStream | ArrayBuffer | string,
    options?: { httpMetadata?: { contentType?: string } },
  ): Promise<MirrorObject | null | void>;
  delete(key: string): Promise<void>;
  list(options: { prefix: string; cursor?: string; limit?: number }): Promise<{
    objects: ReadonlyArray<{ key: string; size: number; etag: string }>;
    truncated: boolean;
    cursor?: string;
  }>;
}

export interface MirrorEnv {
  readonly SIGNATURES: MirrorBucket;
  readonly WRITE_TOKEN: string;
  readonly READ_TOKEN?: string;
}

// Constants live here, not in index.ts: workerd treats every export of the entry module as an
// entrypoint, and rejects non-handler values (a number or string) at startup.

/** Internal hostname the containers use; outbound HTTP to it is intercepted, never resolved. */
export const MIRROR_HOST = "sigmirror.internal";

/** Upper bound on one job run (a cold full download is ~300 MB). */
export const JOB_TIMEOUT_MS = 30 * 60_000;

/** Database file names freshclam and cvdupdate use; nothing else is ever stored or served. */
const DB_NAME = /^[a-z][a-z0-9_]{0,63}(-[0-9]{1,8})?\.(cvd|cld|cdiff|dat|txt)(\.sign)?$/;

const STATE_KEY = "_state/state.json";

const MAX_OBJECT_BYTES = 512 * 1024 * 1024;

export const isDatabaseName = (name: string): boolean => DB_NAME.test(name) && !name.includes("..");

const dbKey = (name: string) => `db/${name}`;

const contentTypeFor = (name: string): string =>
  name.endsWith(".txt") ? "text/plain; charset=utf-8" : "application/octet-stream";

export { timingSafeEqual };

const authorized = (request: Request, env: MirrorEnv): boolean => {
  // A write token under 32 characters counts as unset: the mirror then refuses every write.
  return bearerMatches(request.headers.get("authorization"), env.WRITE_TOKEN, 32);
};

const text = (status: number, body = "") =>
  // Null-body statuses (204/304) must not carry a body, even an empty one: the constructor throws.
  new Response(status === 204 || status === 304 ? null : body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });

type Range = { offset: number; length?: number } | { suffix: number };

/** Parse a single `bytes=` range; multi-range requests are served whole (RFC 9110 permits this). */
export const parseRange = (header: string | null, size: number): Range | "unsatisfiable" | null => {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());

  if (!m) return null;
  const [, a, b] = m;

  if (a === "" && b === "") return null;

  if (a === "") {
    const suffix = Number(b);

    return suffix === 0 ? "unsatisfiable" : { suffix: Math.min(suffix, size) };
  }

  const start = Number(a);

  if (start >= size) return "unsatisfiable";
  const end = b === "" ? size - 1 : Math.min(Number(b), size - 1);

  if (end < start) return null;

  return { offset: start, length: end - start + 1 };
};

const rangeBounds = (range: Range, size: number) =>
  "suffix" in range
    ? { start: size - range.suffix, end: size - 1 }
    : { start: range.offset, end: range.offset + (range.length ?? size - range.offset) - 1 };

const notModified = (request: Request, object: MirrorObject): boolean => {
  const inm = request.headers.get("if-none-match");

  if (inm !== null)
    return inm.split(",").some((t) => t.trim() === object.httpEtag || t.trim() === "*");
  const ims = request.headers.get("if-modified-since");

  if (ims === null) return false;
  const since = Date.parse(ims);

  // HTTP dates have 1-second resolution.
  return (
    !Number.isNaN(since) && Math.floor(object.uploaded.getTime() / 1000) <= Math.floor(since / 1000)
  );
};

const serve = async (request: Request, env: MirrorEnv, name: string): Promise<Response> => {
  if (!isDatabaseName(name)) return text(404);
  const head = await env.SIGNATURES.head(dbKey(name));

  if (!head) return text(404);

  const headers = {
    "content-type": contentTypeFor(name),
    etag: head.httpEtag,
    "last-modified": head.uploaded.toUTCString(),
    "accept-ranges": "bytes",
    // Short TTL: daily.cvd changes several times a day.
    "cache-control": "private, max-age=300",
  };

  if (notModified(request, head)) return new Response(null, { status: 304, headers });
  const range = parseRange(request.headers.get("range"), head.size);

  if (range === "unsatisfiable")
    return new Response(null, {
      status: 416,
      headers: { ...headers, "content-range": `bytes */${head.size}` },
    });

  if (request.method === "HEAD")
    return new Response(null, {
      status: 200,
      headers: { ...headers, "content-length": String(head.size) },
    });
  const object = await env.SIGNATURES.get(dbKey(name), range ? { range } : {});

  if (!object) return text(404);

  if (!range)
    return new Response(object.body, {
      status: 200,
      headers: { ...headers, "content-length": String(head.size) },
    });
  const { start, end } = rangeBounds(range, head.size);

  return new Response(object.body, {
    status: 206,
    headers: {
      ...headers,
      "content-length": String(end - start + 1),
      "content-range": `bytes ${start}-${end}/${head.size}`,
    },
  });
};

const write = async (request: Request, env: MirrorEnv, name: string): Promise<Response> => {
  if (!authorized(request, env)) return text(401, "unauthorized");

  if (name === "_manifest" && request.method === "GET") {
    const files: Record<string, { size: number; etag: string }> = {};
    let cursor: string | undefined;

    do {
      const base = { prefix: "db/", limit: 1000 };
      const options = cursor ? { ...base, cursor } : base;

      const page = await env.SIGNATURES.list(options);

      for (const o of page.objects) files[o.key.slice(3)] = { size: o.size, etag: o.etag };
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);

    return Response.json({ files }, { headers: { "cache-control": "no-store" } });
  }

  const key = name === "_state" ? STATE_KEY : isDatabaseName(name) ? dbKey(name) : null;

  if (!key) return text(400, "invalid name");

  if (request.method === "GET") {
    const object = await env.SIGNATURES.get(key);

    return object
      ? new Response(object.body, {
          headers: { "content-type": "application/octet-stream", "cache-control": "no-store" },
        })
      : text(404);
  }

  if (request.method === "DELETE") {
    if (key === STATE_KEY) return text(400, "state cannot be deleted");
    await env.SIGNATURES.delete(key);

    return text(204);
  }

  if (request.method !== "PUT") return text(405);
  const length = Number(request.headers.get("content-length") ?? "NaN");

  if (!Number.isFinite(length) || length < 0 || length > MAX_OBJECT_BYTES || !request.body)
    return text(411, "content-length required");
  await env.SIGNATURES.put(key, request.body, {
    httpMetadata: { contentType: key === STATE_KEY ? "application/json" : contentTypeFor(name) },
  });

  return text(201);
};

export const handleMirror = async (request: Request, env: MirrorEnv): Promise<Response> => {
  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter((p) => p.length > 0);

  if (parts.some((p) => p === "." || p === ".." || p.includes("%") || p.includes("\\")))
    return text(400, "invalid path");

  if (parts[0] === "w" && parts.length === 2) return write(request, env, parts[1]!);

  if (request.method !== "GET" && request.method !== "HEAD") return text(405);

  if (env.READ_TOKEN) {
    if (parts.length !== 2 || !timingSafeEqual(parts[0]!, env.READ_TOKEN)) return text(404);

    return serve(request, env, parts[1]!);
  }

  if (parts.length !== 1) return text(404);

  return serve(request, env, parts[0]!);
};
