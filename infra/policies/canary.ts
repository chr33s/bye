// Canary policy (§15.9): "routing only a fraction of HTTP traffic is not enough when queue
// consumers, alarms, RPC hosts, and Workflows also changed". MailCore rolls out with Alchemy's
// `version.traffic` (gradual deployment, session-affine); the async-path probes
// (infra/probes/run.ts) gate promotion. Durable Object class migrations cannot ride a gradual
// rollout, so any release that changes the class-migration manifest deploys at 100% with the
// full probe suite and an explicit operator acknowledgement instead.
//
// Usage:
//   canary.ts percent <requested> <changed-files.txt>   → prints the percent to deploy with
//   canary.ts decide <probe-report.json>                → prints "promote" or "rollback" (exit 1 on rollback)
import { readFileSync } from "node:fs";

export const DURABLE_MANIFEST = "infra/migrations/durable/durable-class-migrations.ts";

export const canaryPercent = (
  requested: number,
  changedFiles: ReadonlyArray<string>,
): { readonly percent: number; readonly reason: string } => {
  if (!Number.isFinite(requested) || requested <= 0 || requested >= 100)
    return { percent: 100, reason: "full deploy requested" };
  if (changedFiles.some((f) => f.trim() === DURABLE_MANIFEST))
    return {
      percent: 100,
      reason: "Durable Object class migrations cannot ride a gradual rollout",
    };
  return { percent: Math.round(requested), reason: `canary at ${Math.round(requested)}%` };
};

export interface ProbeReport {
  readonly results: ReadonlyArray<{ readonly name: string; readonly ok: boolean }>;
}

/** Promote only if every probe — including the async paths — passed. */
export const canaryDecision = (report: ProbeReport): "promote" | "rollback" =>
  report.results.length > 0 &&
  report.results.every((r) => r.ok) &&
  ["queue.round-trip", "do.alarm", "workflow.checkpoint"].every((n) =>
    report.results.some((r) => r.name === n && r.ok),
  )
    ? "promote"
    : "rollback";

if (import.meta.main) {
  const [cmd, a, b] = process.argv.slice(2);
  if (cmd === "percent") {
    const changed = b ? readFileSync(b, "utf8").split("\n").filter(Boolean) : [];
    const { percent, reason } = canaryPercent(Number(a), changed);
    console.error(`canary: ${reason}`);
    console.log(String(percent));
  } else if (cmd === "decide" && a) {
    const decision = canaryDecision(JSON.parse(readFileSync(a, "utf8")) as ProbeReport);
    console.log(decision);
    if (decision === "rollback") process.exit(1);
  } else {
    console.error(
      "usage: canary.ts percent <requested> <changed-files> | decide <probe-report.json>",
    );
    process.exit(2);
  }
}
