// Registry-to-registry image copy over the OCI distribution API (infra/onboarding/spec.md §44).
// Cloudflare Containers run images only from the account's own registry, and neither the hosted
// Worker nor the deployer container can run Docker, so a pinned release image is copied blob by
// blob and its manifest byte for byte: the digest in the target equals the pinned digest.
// Blobs stream through (a layer can be larger than a Worker's memory).
import { createHash } from "node:crypto";
import { type ImageRef, parseImageRef } from "./images.ts";
import type { Fetch } from "./oauth.ts";
import { encode } from "./seal.ts";

/** Single-platform manifest types; an index must be resolved to its linux/amd64 entry upstream. */
export const MANIFEST_TYPES = [
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
] as const;

const INDEX_TYPES = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
];

export interface RegistryCredentials {
  readonly username: string;
  readonly password: string;
}

export class RegistryError extends Error {}

interface Descriptor {
  readonly mediaType?: string;
  readonly digest: string;
  readonly size: number;
}

interface Manifest {
  readonly mediaType?: string;
  readonly config?: Descriptor;
  readonly layers?: ReadonlyArray<Descriptor>;
}

const basic = (c: RegistryCredentials) =>
  `Basic ${encode(Buffer.from(`${c.username}:${c.password}`), "base64")}`;

/** `Bearer realm="…",service="…",scope="…"` → its parameters. */
const challenge = (header: string | null) => {
  const m = /^Bearer\s+(.*)$/i.exec(header ?? "");

  if (!m) return null;
  const params = new Map<string, string>();

  for (const p of m[1]!.matchAll(/([a-z]+)="([^"]*)"/gi)) params.set(p[1]!.toLowerCase(), p[2]!);

  return params.has("realm") ? params : null;
};

/**
 * One registry repository. Answers a Bearer challenge with a token from its realm (anonymously,
 * or with the credentials), otherwise sends the credentials as Basic auth.
 */
export const repository = (
  fetcher: Fetch,
  ref: Pick<ImageRef, "registry" | "repository">,
  credentials: RegistryCredentials | null,
) => {
  const base = `https://${ref.registry}/v2/${ref.repository}`;
  let auth: string | null = credentials ? basic(credentials) : null;

  const call = async (path: string, init: RequestInit = {}, retry = true): Promise<Response> => {
    const url = path.startsWith("https://") ? path : `${base}${path}`;
    const headers = new Headers(init.headers);

    if (auth) headers.set("authorization", auth);
    const r = await fetcher(url, { ...init, headers });

    // A streamed body was consumed by this attempt and can't be sent again; copyBlob retries
    // those from the source, and its next call picks up a fresh token.
    if (r.status !== 401 || !retry || init.body instanceof ReadableStream) return r;
    const params = challenge(r.headers.get("www-authenticate"));

    if (!params) return r;
    const token = new URL(params.get("realm")!);

    for (const k of ["service", "scope"]) {
      const v = params.get(k);

      if (v) token.searchParams.set(k, v);
    }

    const t = await fetcher(token.href, {
      headers: credentials ? { authorization: basic(credentials) } : {},
    });

    if (!t.ok) throw new RegistryError(`${ref.registry} refused a token (${t.status})`);
    const body = (await t.json()) as { token?: string; access_token?: string };
    const bearer = body.token ?? body.access_token;

    if (!bearer) throw new RegistryError(`${ref.registry} returned no token`);
    auth = `Bearer ${bearer}`;

    return call(path, init, false);
  };

  return { call, base };
};

const sha256 = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

/**
 * A request body of known length. Workers send a plain stream chunked, which registries may
 * refuse for a monolithic upload; `FixedLengthStream` (Workers only) sends Content-Length.
 */
const sizedPut = (body: ReadableStream<Uint8Array>, size: number): RequestInit => {
  const headers = { "content-type": "application/octet-stream", "content-length": String(size) };

  const Fixed = (globalThis as { FixedLengthStream?: new (n: number) => TransformStream })
    .FixedLengthStream;

  if (Fixed) return { method: "PUT", headers, body: body.pipeThrough(new Fixed(size)) };

  // SAFETY: `duplex` is required by Node's fetch for stream bodies and absent from the DOM type.
  return { method: "PUT", headers, body, duplex: "half" } as RequestInit;
};

/** Blobs of one image copied at a time: layers are large, and registries throttle uploads. */
export const BLOB_CONCURRENCY = 3;

type Repository = ReturnType<typeof repository>;

/**
 * One blob, streamed from the source into a monolithic upload. A 401 on the upload (the token
 * expired while a large layer streamed) is retried once from the source; the upload request
 * before it re-authenticates.
 */
const copyBlob = async (from: Repository, to: Repository, blob: Descriptor, o: CopyOptions) => {
  if ((await to.call(`/blobs/${blob.digest}`, { method: "HEAD" })).ok) return;

  for (let attempt = 0; ; attempt++) {
    const body = await from.call(`/blobs/${blob.digest}`);

    if (!body.ok || !body.body)
      throw new RegistryError(`${o.source}: blob ${blob.digest} not available (${body.status})`);
    const started = await to.call("/blobs/uploads/", { method: "POST" });
    const location = started.headers.get("location");

    if (started.status !== 202 || !location) {
      await body.body.cancel();
      throw new RegistryError(`${o.target.registry} refused an upload (${started.status})`);
    }

    const upload = new URL(location, `https://${o.target.registry}`);
    upload.searchParams.set("digest", blob.digest);
    const put = await to.call(upload.href, sizedPut(body.body, blob.size));

    if (put.status === 201) return;

    if (put.status === 401 && attempt === 0) continue;
    throw new RegistryError(
      `${o.target.registry} refused blob ${blob.digest.slice(0, 19)} (${put.status})`,
    );
  }
};

export interface CopyOptions {
  readonly fetch: Fetch;
  /** Pinned source, e.g. `ghcr.io/org/bye/mime@sha256:…` (public: pulled anonymously). */
  readonly source: string;
  /** Target registry and repository, e.g. `registry.cloudflare.com` + `<account>/bye-mime`. */
  readonly target: { readonly registry: string; readonly repository: string };
  readonly credentials: RegistryCredentials;
  /** Tag written next to the digest (the release version), so the image is findable. */
  readonly tag?: string;
}

/** Copies a pinned single-platform image; returns the target reference (same digest). */
export const copyImage = async (o: CopyOptions): Promise<string> => {
  const src = parseImageRef(o.source);
  const from = repository(o.fetch, src, null);
  const to = repository(o.fetch, o.target, o.credentials);
  const targetRef = `${o.target.registry}/${o.target.repository}@${src.digest}`;

  const accept = [...MANIFEST_TYPES, ...INDEX_TYPES].join(", ");
  const got = await from.call(`/manifests/${src.digest}`, { headers: { accept } });

  if (!got.ok) throw new RegistryError(`${o.source}: manifest not available (${got.status})`);
  const bytes = new Uint8Array(await got.arrayBuffer());

  if (sha256(bytes) !== src.digest)
    throw new RegistryError(`${o.source}: manifest does not match its pinned digest`);
  const manifest = JSON.parse(encode(bytes, "utf8")) as Manifest;
  const mediaType = manifest.mediaType ?? got.headers.get("content-type") ?? "";

  if (INDEX_TYPES.includes(mediaType))
    throw new RegistryError(
      `${o.source} is a multi-platform index; pin the linux/amd64 image manifest instead`,
    );

  if (!(MANIFEST_TYPES as ReadonlyArray<string>).includes(mediaType) || !manifest.config)
    throw new RegistryError(`${o.source}: unsupported manifest type ${mediaType || "(none)"}`);

  // Already copied (a retry, or another installation's bootstrap in the same account).
  const present = await to.call(`/manifests/${src.digest}`, {
    method: "HEAD",
    headers: { accept },
  });

  if (present.ok) return targetRef;

  const blobs = [manifest.config, ...(manifest.layers ?? [])];

  // bounded: BLOB_CONCURRENCY workers over this image's blobs.
  await Promise.all(
    Array.from({ length: Math.min(BLOB_CONCURRENCY, blobs.length) }, async (_, worker) => {
      for (let i = worker; i < blobs.length; i += BLOB_CONCURRENCY)
        await copyBlob(from, to, blobs[i]!, o);
    }),
  );

  for (const reference of [src.digest, ...(o.tag ? [o.tag] : [])]) {
    const put = await to.call(`/manifests/${reference}`, {
      method: "PUT",
      headers: { "content-type": mediaType },
      body: bytes,
    });

    if (put.status !== 201)
      throw new RegistryError(`${o.target.registry} refused the manifest (${put.status})`);
    const digest = put.headers.get("docker-content-digest");

    if (digest && digest !== src.digest)
      throw new RegistryError(`${o.target.registry} stored the manifest as ${digest}`);
  }

  return targetRef;
};
