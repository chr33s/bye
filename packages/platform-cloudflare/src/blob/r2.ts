import { type BlobObject, BlobStore, BlobStoreFailure } from "@bye/application";
import { Effect, Layer } from "effect";

/** Narrow R2 bucket surface used by the application (§7.1: adapters depend on narrow bindings). */
export interface R2BucketLike {
  put(
    key: string,
    value: ReadableStream<Uint8Array> | Uint8Array | string,
    options?: { httpMetadata?: { contentType?: string } },
  ): Promise<{ key: string; size: number } | null>;
  get(key: string): Promise<{
    key: string;
    size: number;
    httpMetadata?: { contentType?: string };
    body: ReadableStream<Uint8Array>;
    arrayBuffer(): Promise<ArrayBuffer>;
  } | null>;
  head(key: string): Promise<{ size: number } | null>;
  delete(key: string): Promise<void>;
}

const wrap = <A>(op: string, key: string, f: () => Promise<A>) =>
  // Keys are tenant-scoped opaque IDs; failure details never include object contents.
  Effect.tryPromise({
    try: f,
    catch: (e) =>
      new BlobStoreFailure({ op, detail: `${key}: ${e instanceof Error ? e.message : "error"}` }),
  });

export const makeR2BlobStore = (bucket: R2BucketLike) =>
  BlobStore.of({
    put: (key, body, meta) =>
      wrap("put", key, async () => {
        const r = await bucket.put(
          key,
          body,
          meta?.contentType ? { httpMetadata: { contentType: meta.contentType } } : undefined,
        );
        if (!r) throw new Error("precondition failed");
        return { key: r.key, size: r.size };
      }),
    get: (key) =>
      wrap("get", key, async (): Promise<BlobObject | null> => {
        const o = await bucket.get(key);
        return o
          ? {
              key: o.key,
              size: o.size,
              contentType: o.httpMetadata?.contentType,
              body: o.body,
              bytes: async () => new Uint8Array(await o.arrayBuffer()),
            }
          : null;
      }),
    head: (key) =>
      wrap("head", key, async () => {
        const h = await bucket.head(key);
        return h ? { size: h.size } : null;
      }),
    delete: (key) => wrap("delete", key, () => bucket.delete(key)),
  });

export const R2BlobStoreLive = (bucket: R2BucketLike) =>
  Layer.succeed(BlobStore, makeR2BlobStore(bucket));
