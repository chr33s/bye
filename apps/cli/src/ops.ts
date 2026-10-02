import { Option } from "effect";
import { Argument, Flag } from "effect/cli";
import { action, get, group, opt, optInt, post } from "./args.ts";

// Operator commands (§6 DLQ inspect/replay, §12 reindex/erasure). They call the /v1/ops routes,
// which accept only the environment's OPS_TOKEN — run them with BYE_TOKEN set to that token.

const DLQ_STATES = ["held", "replayed", "discarded", "obsolete"] as const;

const id = Argument.String("id");

export const OPS_COMMANDS = [
  group("ops", "Operator commands (run with BYE_TOKEN set to the environment's OPS_TOKEN)", [
    group("dlq", "Dead-lettered queue messages", [
      action(
        "list",
        { summary: "List dead-lettered queue messages (operator token)" },
        { state: Flag.Literals("state", DLQ_STATES).pipe(Flag.optional), limit: optInt("limit") },
        ({ state, limit }) => get("/v1/ops/dlq", { state: Option.getOrUndefined(state), limit }),
      ),
      action(
        "replay",
        {
          summary:
            "Re-validate a dead letter against source state and re-enqueue it if still needed",
          consequential: true,
        },
        { id },
        ({ id }) => post(`/v1/ops/dlq/${encodeURIComponent(id)}/replay`, {}),
      ),
      action(
        "discard",
        { summary: "Discard a held dead letter with a note", consequential: true },
        { id, note: opt("note") },
        ({ id, note }) =>
          post(`/v1/ops/dlq/${encodeURIComponent(id)}/discard`, {
            note: note ?? "discarded via cli",
          }),
      ),
    ]),
    action(
      "reindex",
      { summary: "Rebuild a mailbox's search shard from authoritative state", consequential: true },
      { mailboxId: Argument.String("mailboxId") },
      ({ mailboxId }) => post("/v1/ops/reindex", { mailboxId }),
    ),
    action(
      "erase",
      {
        summary: "Start account erasure (tombstones first, then the checkpointed workflow)",
        consequential: true,
      },
      { userId: Argument.String("userId"), reason: opt("reason") },
      ({ userId, reason }) => post("/v1/ops/erasure", { userId, reason: reason ?? "operator" }),
    ),
    group("tombstones", "Erasure tombstones", [
      action(
        "replay",
        { summary: "Re-apply erasure tombstones (run after any restore)", consequential: true },
        {},
        () => post("/v1/ops/tombstones/replay", {}),
      ),
    ]),
  ]),
];
