import { handleFetch } from "./api.ts";
import { handleQueueBatch } from "./consumers.ts";
import type { CoreEnv } from "./env.ts";
import { handleInbound } from "./inbound.ts";
import { handleScheduled } from "./scheduled.ts";

// MailCore entrypoint: the single host for every authority namespace and Workflow class (§15.3).
// Native handlers are thin adapters around application Effects (§7.4).

export {
  CalendarDO,
  IngressJournalDO,
  MailboxDO,
  SearchShardDO,
  SharedSpaceDO,
} from "./objects.ts";
export {
  EraseWorkflow,
  ExportWorkflow,
  FanoutWorkflow,
  ProvisionDomainWorkflow,
  ReindexWorkflow,
} from "./workflows.ts";
export { PublicGateway } from "./gateway.ts";
export { ScannerContainer } from "./scan.ts";
export { MimeContainer } from "./mime.ts";
export { ProbeDO, ProbeWorkflow } from "./probe.ts";

export default {
  fetch: (request, env, ctx) => handleFetch(request, env, ctx),
  email: async (message, env) => {
    await handleInbound(message, env);
  },
  queue: (batch, env) => handleQueueBatch(batch, env),
  scheduled: (controller, env) => handleScheduled(controller, env),
} satisfies ExportedHandler<CoreEnv>;
