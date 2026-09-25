// Control-plane database, content buckets, and the config cache (§15.4 Control plane,
// Content storage, Protection and caching). Deployment code only; never imported by Workers
// except as `import type`.
import * as Cloudflare from "alchemy/Cloudflare";

export const Directory = Cloudflare.D1.Database("Directory", {
  migrations: "./infra/migrations/d1",
});

const ABORT_STALE_MULTIPART = {
  id: "abort-stale-multipart",
  abortMultipartUploadsTransition: { condition: { type: "Age" as const, maxAge: 7 * 24 * 3600 } },
};

/** Immutable original MIME. No lifecycle deletion: retention and GC are application-owned (§12). */
export const Originals = Cloudflare.R2.Bucket("Originals", {
  forceDestroy: false,
  publicAccess: false,
});

/** Extracted parts, normalized bodies, uploads. Multipart uploads abandoned for a week are aborted. */
export const Parts = Cloudflare.R2.Bucket("Parts", {
  forceDestroy: false,
  publicAccess: false,
  lifecycleRules: [ABORT_STALE_MULTIPART],
});

/** User exports; retention is enforced by the export workflow, not by a bucket rule. */
export const Exports = Cloudflare.R2.Bucket("Exports", {
  forceDestroy: false,
  publicAccess: false,
  lifecycleRules: [ABORT_STALE_MULTIPART],
});

/** Explicitly published copies only (§11 Publishing). Never the original private object. */
export const Published = Cloudflare.R2.Bucket("Published", {
  forceDestroy: false,
  publicAccess: false,
});

/** Versioned, non-sensitive configuration hints. Never sessions, grants, or policy (§3.1). */
export const ConfigCache = Cloudflare.KV.Namespace("ConfigCache");
