import { DurableObject } from "cloudflare:workers";
import { handleMirror, JOB_TIMEOUT_MS, MIRROR_HOST, type MirrorEnv } from "./mirror.ts";

// SigMirror Worker. Hosts the private ClamAV mirror (R2) and the scheduled mirror job, a
// cvdupdate container that is the single audited internet-egress point for signatures.
// No routes or workers.dev: scanners reach it only through an intercepted service binding.

export interface SigMirrorEnv extends MirrorEnv {
  readonly SIGNATURES: R2Bucket & MirrorEnv["SIGNATURES"];
  readonly MIRROR_JOB: DurableObjectNamespace<SigMirrorJob>;
}

/**
 * Container-backed DO that runs one cvdupdate pass. Internet is enabled only for this container
 * (ClamAV's CDN); its writes go to this Worker through `interceptOutboundHttp`, so the write token
 * never crosses the public internet and the job needs no R2 credentials.
 */
export class SigMirrorJob extends DurableObject<SigMirrorEnv> {
  async run(): Promise<{ readonly started: boolean }> {
    const container = this.ctx.container;

    if (!container) throw new Error("mirror job container binding missing");

    if (container.running) return { started: false };
    // Everything that can fail runs before the container starts, and the alarm is armed first, so
    // a failed run never leaves an unbounded container behind.
    const self = (this.ctx.exports as { default?: Fetcher }).default;

    if (!self)
      throw new Error(
        "ctx.exports loopback unavailable; enable the enable_ctx_exports compatibility flag",
      );
    // The job exits on completion; the alarm bounds a hung run.
    await this.ctx.storage.setAlarm(Date.now() + JOB_TIMEOUT_MS);
    container.start({
      enableInternet: true,
      env: { MIRROR_URL: `http://${MIRROR_HOST}`, WRITE_TOKEN: this.env.WRITE_TOKEN },
    });

    try {
      await container.interceptOutboundHttp(MIRROR_HOST, self);
    } catch (e) {
      await container.destroy(e instanceof Error ? e : new Error(String(e)));
      throw e;
    }

    return { started: true };
  }

  override async alarm(): Promise<void> {
    if (this.ctx.container?.running)
      await this.ctx.container.destroy(new Error("mirror job exceeded time limit"));
  }
}

export default {
  fetch: (request, env) => handleMirror(request, env),
  // A few runs a day at an off-peak minute, per ClamAV's mirror guidance; cvdupdate also honours
  // Retry-After and If-Modified-Since from state persisted in the mirror.
  scheduled: async (_controller, env) => {
    await env.MIRROR_JOB.getByName("mirror").run();
  },
} satisfies ExportedHandler<SigMirrorEnv>;
