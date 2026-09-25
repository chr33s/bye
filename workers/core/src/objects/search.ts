import { DurableObject } from "cloudflare:workers";
import { type SearchDocument, SearchShard, toRpcSync } from "@bye/platform-cloudflare";
import type { CoreEnv } from "../env.ts";

/** Rebuildable lexical index shard (§8). Holds no authority; every hit is rehydrated. */
export class SearchShardDO extends DurableObject<CoreEnv> {
  private readonly shard: SearchShard;

  constructor(ctx: DurableObjectState, env: CoreEnv) {
    super(ctx, env);
    this.shard = new SearchShard(ctx.storage);
  }

  upsert(doc: SearchDocument) {
    return this.shard.upsert(doc);
  }

  remove(docId: string, version: number) {
    return this.shard.remove(docId, version);
  }

  /** Enveloped: a bad cursor or an oversized query is a `bad_request` for the caller, not a defect. */
  candidates(query: string, options: { readonly limit?: number; readonly cursor?: string }) {
    return toRpcSync(() => this.shard.candidates(query, options));
  }

  setWatermark(seq: number) {
    this.shard.setWatermark(seq);
  }

  health() {
    return { storedBytes: this.shard.storedBytes(), watermark: this.shard.watermark() };
  }

  clear() {
    this.shard.clear();
  }
}
