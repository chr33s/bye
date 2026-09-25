import { flag, get, post, required, type CommandSpec } from "./args.ts";

// Operator commands (§6 DLQ inspect/replay, §12 reindex/erasure). They call the /v1/ops routes,
// which accept only the environment's OPS_TOKEN — run them with BYE_TOKEN set to that token.

export const OPS_COMMANDS: ReadonlyArray<CommandSpec> = [
  {
    path: ["ops", "dlq", "list"],
    summary: "List dead-lettered queue messages (operator token)",
    usage: "bye ops dlq list [--state held|replayed|discarded|obsolete] [--limit n]",
    run: (ctx) => get("/v1/ops/dlq", { state: flag(ctx, "state"), limit: flag(ctx, "limit") }),
  },
  {
    path: ["ops", "dlq", "replay"],
    summary: "Re-validate a dead letter against source state and re-enqueue it if still needed",
    usage: "bye ops dlq replay <id> --yes",
    consequential: true,
    run: (ctx) => post(`/v1/ops/dlq/${encodeURIComponent(required(ctx, 0, "id"))}/replay`, {}),
  },
  {
    path: ["ops", "dlq", "discard"],
    summary: "Discard a held dead letter with a note",
    usage: "bye ops dlq discard <id> [--note text] --yes",
    consequential: true,
    run: (ctx) =>
      post(`/v1/ops/dlq/${encodeURIComponent(required(ctx, 0, "id"))}/discard`, {
        note: flag(ctx, "note") ?? "discarded via cli",
      }),
  },
  {
    path: ["ops", "reindex"],
    summary: "Rebuild a mailbox's search shard from authoritative state",
    usage: "bye ops reindex <mailboxId> --yes",
    consequential: true,
    run: (ctx) => post("/v1/ops/reindex", { mailboxId: required(ctx, 0, "mailboxId") }),
  },
  {
    path: ["ops", "erase"],
    summary: "Start account erasure (tombstones first, then the checkpointed workflow)",
    usage: "bye ops erase <userId> [--reason text] --yes",
    consequential: true,
    run: (ctx) =>
      post("/v1/ops/erasure", {
        userId: required(ctx, 0, "userId"),
        reason: flag(ctx, "reason") ?? "operator",
      }),
  },
  {
    path: ["ops", "tombstones", "replay"],
    summary: "Re-apply erasure tombstones (run after any restore)",
    usage: "bye ops tombstones replay --yes",
    consequential: true,
    run: () => post("/v1/ops/tombstones/replay", {}),
  },
];
