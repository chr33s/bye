import { PROBE_TTL_SECONDS, probeKey } from "../probe.ts";
import type { TopicHandlers } from "./types.ts";

// Queue round-trip probe: propagate queue → consumer → KV marker the operator probe polls.
export const probeTopics: TopicHandlers<"probe.echo"> = {
  "probe.echo": async ({ env, payload }) => {
    const id = payload.probeId;
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) return;
    await env.CONFIG_CACHE.put(probeKey("queue", id), String(Date.now()), {
      expirationTtl: PROBE_TTL_SECONDS,
    });
  },
};
