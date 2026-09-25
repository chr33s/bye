import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { Schema } from "effect";
import {
  cloudflareApi,
  dohResolver,
  DomainOnboarding,
  mailDnsProfile,
  type OnboardingDeps,
} from "@bye/platform-cloudflare";
import { kernelClock } from "../durable-host.ts";
import type { CoreEnv } from "../env.ts";
import { decodeParams, promiseStep } from "./common.ts";

// O01: resumable onboarding requested → ownership-proven → zone-authorized → dns-configured →
// inbound-tested → outbound-tested → active. Zone authorization is an explicit, separately approved
// operator/admin step (the Workflow waits for its event). Every step is idempotent in D1, so retries
// and redeploys resume where they stopped. DNS changes go only through the scoped onboarding token
// and never delete or overwrite a foreign record.

export const DomainParams = Schema.Struct({
  v: Schema.Literal(1),
  domainId: Schema.String,
  actorId: Schema.String,
});
export type DomainParams = typeof DomainParams.Type;

const DnsResult = Schema.Struct({ applied: Schema.Number, conflicts: Schema.Number });

export type ZoneAuthorizationMethod = "service-zone" | "delegated-token" | "manual-records";

export const onboardingDeps = (
  env: CoreEnv,
  method: ZoneAuthorizationMethod | null,
  fetchFn: typeof fetch = fetch,
): OnboardingDeps => ({
  // Zone automation only when the operator authorized API access to this zone.
  api:
    method !== "manual-records" && env.CF_DNS_API_TOKEN
      ? cloudflareApi(env.CF_DNS_API_TOKEN, (u, i) => fetchFn(u, i))
      : null,
  resolve: dohResolver((u, i) => fetchFn(u, i)),
  profile: mailDnsProfile(env.MAIL_DKIM_PUBLIC_KEY),
  workerName: env.MAIL_WORKER_NAME || null,
});

export class ProvisionDomainWorkflow extends WorkflowEntrypoint<CoreEnv, DomainParams> {
  override async run(event: Readonly<WorkflowEvent<DomainParams>>, step: WorkflowStep) {
    const { domainId, actorId } = decodeParams(DomainParams)(event.payload);
    const onboarding = (method: ZoneAuthorizationMethod | null) =>
      new DomainOnboarding(this.env.DIRECTORY, kernelClock, onboardingDeps(this.env, method));
    await promiseStep(
      step,
      "v1:prove-ownership",
      Schema.Boolean,
      async () => {
        await onboarding(null).proveOwnership(domainId, actorId);
        return true;
      },
      { retries: { limit: 30, delay: "2 minutes", backoff: "linear" } },
    );
    const authorized = await step.waitForEvent<{ method: ZoneAuthorizationMethod }>(
      "v1:zone-authorized",
      { type: "zone-authorized", timeout: "7 days" },
    );
    const method = authorized.payload.method;
    await promiseStep(step, "v1:authorize-zone", Schema.Boolean, async () => {
      await onboarding(method).domains.authorizeZone(domainId, actorId, { method });
      return true;
    });
    const dns = await promiseStep(
      step,
      "v1:configure-dns",
      DnsResult,
      async () => {
        const r = await onboarding(method).configureDns(domainId, actorId);
        // Throwing keeps the step retrying until the customer resolves conflicts / DNS propagates.
        if (r.domain.state === "zone-authorized")
          throw new Error(
            `dns not ready: ${r.diagnostics
              .filter((d) => d.status === "fail")
              .map((d) => d.check)
              .join(",")}`,
          );
        return { applied: r.applied.length, conflicts: r.conflicts.length };
      },
      { retries: { limit: 72, delay: "10 minutes", backoff: "constant" } },
    );
    await promiseStep(
      step,
      "v1:inbound-test",
      Schema.Boolean,
      async () => {
        const r = await onboarding(method).testInbound(domainId, actorId);
        if (!r.passed) throw new Error(`inbound not ready: ${r.detail}`);
        return true;
      },
      { retries: { limit: 36, delay: "10 minutes", backoff: "constant" } },
    );
    await promiseStep(
      step,
      "v1:outbound-test",
      Schema.Boolean,
      async () => {
        const r = await onboarding(method).testOutbound(domainId, actorId);
        if (!r.passed) throw new Error("outbound authentication not aligned");
        return true;
      },
      { retries: { limit: 36, delay: "10 minutes", backoff: "constant" } },
    );
    await promiseStep(step, "v1:activate", Schema.Boolean, async () => {
      await onboarding(method).activate(domainId, actorId);
      return true;
    });
    return { domainId, state: "active", applied: dns.applied };
  }
}
