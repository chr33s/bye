// Private ClamAV signature mirror (§3.1 Containers, §10, §15.4 media and scans).
//
//   SigMirrorJob (Container, cron-started) ── internet: database.clamav.net only ──▶ cvdupdate
//        │  writes via intercepted http://sigmirror.internal (no R2 credentials in the container)
//        ▼
//   SigMirror Worker ── R2 ClamSignatures (private)
//        ▲  reads via intercepted http://sigmirror.internal (service binding; no routes, no workers.dev)
//   Scanner containers (enableInternet: false, SCANNER_SIGNATURES=mirror)
//
// The mirror job is the single audited egress point for signatures; scanners have none.
import * as Cloudflare from "alchemy/Cloudflare";
import { Config } from "effect";
import type { SigMirrorJob as SigMirrorJobClass } from "../../workers/sigmirror/src/index.ts";
import { COMPATIBILITY } from "./compat.ts";
import { prebuiltImage } from "./container-images.ts";
import { devServer } from "./dev.ts";
import type { StageInfo } from "./stage.ts";

/** ClamAV asks mirrors to update a few times a day at most; off-peak minute, three runs/day. */
export const SIGMIRROR_CRONS = ["23 1,9,17 * * *"] as const;

/** Private signature store. Holds only public ClamAV databases, but is never publicly readable. */
export const ClamSignatures = Cloudflare.R2.Bucket("ClamSignatures", {
  forceDestroy: false,
  publicAccess: false,
});

const image = prebuiltImage(process.env, "SIGMIRROR_IMAGE");

/** cvdupdate job image; one instance at a time (the DO is a singleton named "mirror"). */
export const SigMirrorJob = Cloudflare.Container<SigMirrorJobClass>("SigMirrorJob", {
  ...(image ? { image } : { context: "./containers/sigmirror" }),
  className: "SigMirrorJob",
  instanceType: "basic",
  maxInstances: 1,
});

export const sigMirrorEnv = {
  SIGNATURES: ClamSignatures,
  MIRROR_JOB: SigMirrorJob,
  // Shared with the job container at start; never bound to MailCore or the public site.
  WRITE_TOKEN: Config.Redacted("SIGMIRROR_WRITE_TOKEN"),
};

export const makeSigMirror = (_stage: StageInfo) =>
  Cloudflare.Worker("SigMirror", {
    main: "./workers/sigmirror/src/index.ts",
    compatibility: COMPATIBILITY,
    ...devServer("SigMirror"),
    // Reachable only through service bindings (MailCore's scanner containers) — never publicly.
    workersDev: false,
    crons: [...SIGMIRROR_CRONS],
    logpush: false,
    observability: {
      enabled: true,
      headSamplingRate: 1,
      logs: { enabled: true, invocationLogs: false, persist: true },
      traces: { enabled: false },
    },
    env: sigMirrorEnv,
  });
