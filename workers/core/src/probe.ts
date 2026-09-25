import {
  DurableObject,
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import type { CoreEnv } from "./env.ts";

// Post-deploy asynchronous probes (§15.10 "Deploy and verify", §15.9 canary): exercise the async
// paths an HTTP-only check would miss — a queue round trip through the propagate consumer, a
// Durable Object alarm firing, and a Workflow step checkpointing. Only reachable with the
// PROBE_TOKEN operator secret (routes/probe.ts); results live in the probe's own storage/KV.

export const PROBE_TTL_SECONDS = 3600;
export const probeKey = (kind: "queue" | "alarm" | "workflow", id: string) => `probe:${kind}:${id}`;

/** Durable Object whose only job is to prove alarms fire after a deploy. */
export class ProbeDO extends DurableObject<CoreEnv> {
  async arm(delayMs: number): Promise<{ readonly armedAt: number; readonly dueAt: number }> {
    const armedAt = Date.now();
    const dueAt = armedAt + Math.min(Math.max(delayMs, 0), 60_000);
    await this.ctx.storage.put("armedAt", armedAt);
    await this.ctx.storage.delete("firedAt");
    await this.ctx.storage.setAlarm(dueAt);
    return { armedAt, dueAt };
  }

  async status(): Promise<{ readonly armedAt: number | null; readonly firedAt: number | null }> {
    return {
      armedAt: (await this.ctx.storage.get<number>("armedAt")) ?? null,
      firedAt: (await this.ctx.storage.get<number>("firedAt")) ?? null,
    };
  }

  override async alarm(): Promise<void> {
    await this.ctx.storage.put("firedAt", Date.now());
  }
}

export interface ProbeParams {
  readonly v: 1;
  readonly probeId: string;
}

/** Two checkpointed steps with a sleep between: proves step persistence and resume. */
export class ProbeWorkflow extends WorkflowEntrypoint<CoreEnv, ProbeParams> {
  override async run(event: Readonly<WorkflowEvent<ProbeParams>>, step: WorkflowStep) {
    if (event.payload.v !== 1)
      throw new Error(`unsupported probe params v${String(event.payload.v)}`);
    const first = await step.do("v1:first", async () => ({ at: Date.now() }));
    await step.sleep("v1:pause", "1 second");
    const second = await step.do("v1:second", async () => ({ at: Date.now(), after: first.at }));
    await this.env.CONFIG_CACHE.put(
      probeKey("workflow", event.payload.probeId),
      JSON.stringify(second),
      { expirationTtl: PROBE_TTL_SECONDS },
    );
    return { v: 1, first: first.at, second: second.at };
  }
}
