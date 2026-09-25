// Per-recipient send outcome summary (E18). Provider acceptance is never shown as delivery.

export interface SendJobView {
  readonly state: string;
  readonly outcomes?: ReadonlyArray<{
    readonly address: string;
    readonly outcome: string;
    readonly detail: string | null;
  }>;
  readonly failure?: { readonly detail: string } | null;
}

const TERMINAL = new Set(["accepted", "rejected", "cancelled", "unknown"]);
const OUTCOME_LABEL: Readonly<Record<string, string>> = {
  pending: "waiting for the provider",
  delivered: "delivered to the recipient's server",
  deferred: "delayed — the provider is retrying",
  bounced: "bounced",
  rejected: "rejected",
  complained: "reported as spam",
};

export const sendJobsSettled = (jobs: ReadonlyArray<SendJobView>): boolean =>
  jobs.every((j) => TERMINAL.has(j.state));

/** Human lines: one per recipient; honest about Unknown (possibly sent) and provider-only acceptance. */
export const describeSendJobs = (jobs: ReadonlyArray<SendJobView>): ReadonlyArray<string> =>
  jobs.flatMap((job) => {
    if (job.state === "unknown")
      return ["Status unknown — the provider may have accepted it. Check before resending."];
    if (job.state === "rejected")
      return [`Not sent: ${job.failure?.detail ?? "rejected by the provider"}`];
    if (job.state === "cancelled") return ["Cancelled before sending"];
    if (!TERMINAL.has(job.state)) return ["Sending…"];
    const outcomes = job.outcomes ?? [];
    if (outcomes.length === 0) return ["Accepted by the provider (not proof of inbox delivery)"];
    return outcomes.map(
      (o) =>
        `${o.address}: ${OUTCOME_LABEL[o.outcome] ?? o.outcome}${o.detail ? ` (${o.detail})` : ""}`,
    );
  });
