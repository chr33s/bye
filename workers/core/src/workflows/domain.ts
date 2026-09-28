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
import { zoneApiToken } from "../zone-token.ts";
import { decodeParams, promiseStep } from "./common.ts";

// O01: resumable onboarding requested → ownership-proven → zone-authorized → dns-configured →
// inbound-tested → outbound-tested → active. Zone authorization is an explicit, separately approved
// operator/admin step: it is recorded in D1 and, for an instance already waiting, also sent as an
// event. A new instance (retry, restart after rollback or a timed-out wait) resumes from the
// recorded authorization instead of waiting for an event nobody will send again. Every step is
// idempotent in D1, so retries and redeploys resume where they stopped. DNS changes go only
// through the scoped onboarding token and never delete or overwrite a foreign record without the
// explicit cutover confirmation. The zone token is the deployment's CF_DNS_API_TOKEN or, for the
// installation's own zone, the owner-entered token (zone-token.ts), decrypted inside each step.

export const DomainParams = Schema.Struct({
  v: Schema.Literal(1),
  domainId: Schema.String,
  actorId: Schema.String,
});

export type DomainParams = typeof DomainParams.Type;

const DnsResult = Schema.Struct({ applied: Schema.Number, conflicts: Schema.Number });

export type ZoneAuthorizationMethod = "service-zone" | "delegated-token" | "manual-records";

/**
 * `token`: the zone token resolved for this domain (`zoneApiToken`), or null. Zone automation only
 * when the operator authorized API access to this zone and a token reaches it.
 */
export const onboardingDeps = (
  env: CoreEnv,
  method: ZoneAuthorizationMethod | null,
  token: string | null,
  fetchFn: typeof fetch = fetch,
): OnboardingDeps => ({
  api: method !== "manual-records" && token ? cloudflareApi(token, (u, i) => fetchFn(u, i)) : null,
  resolve: dohResolver((u, i) => fetchFn(u, i)),
  profile: mailDnsProfile(env.MAIL_DKIM_PUBLIC_KEY),
  workerName: env.MAIL_WORKER_NAME || null,
});

/** Builds the onboarding deps for a domain, resolving (and decrypting) its zone token now. */
export const onboardingDepsFor = async (
  env: CoreEnv,
  domainName: string | null,
  method: ZoneAuthorizationMethod | null,
  fetchFn: typeof fetch = fetch,
): Promise<OnboardingDeps> =>
  onboardingDeps(
    env,
    method,
    method === "manual-records" ? null : await zoneApiToken(env, domainName),
    fetchFn,
  );

/**
 * The zone authorization a (re)started Workflow can resume from: the recorded method, or — for a
 * domain already past `ownership-proven` from before the method was recorded — the automation
 * available for it (`automated`: a zone token reaches the domain). Null = not authorized yet.
 */
export const recordedAuthorization = (
  link: { readonly zoneAuthMethod: ZoneAuthorizationMethod | null },
  state: string,
  automated: boolean,
): ZoneAuthorizationMethod | null => {
  if (link.zoneAuthMethod !== null) return link.zoneAuthMethod;

  const authorized = [
    "zone-authorized",
    "dns-configured",
    "inbound-tested",
    "outbound-tested",
    "active",
  ];

  if (!authorized.includes(state)) return null;

  return automated ? "service-zone" : "manual-records";
};

const Method = Schema.NullOr(
  Schema.Literals(["service-zone", "delegated-token", "manual-records"]),
);

export class ProvisionDomainWorkflow extends WorkflowEntrypoint<CoreEnv, DomainParams> {
  override async run(event: Readonly<WorkflowEvent<DomainParams>>, step: WorkflowStep) {
    const { domainId, actorId } = decodeParams(DomainParams)(event.payload);

    // The token is resolved (and decrypted) inside each step and dropped with it: step results
    // and Workflow state never hold it.
    const nameOf = async () =>
      (
        await this.env.DIRECTORY.withSession("first-primary")
          .prepare("SELECT name FROM domains WHERE id = ?")
          .bind(domainId)
          .first<{ name: string }>()
      )?.name ?? null;

    const onboarding = async (method: ZoneAuthorizationMethod | null) =>
      new DomainOnboarding(
        this.env.DIRECTORY,
        kernelClock,
        await onboardingDepsFor(this.env, await nameOf(), method),
      );

    await promiseStep(
      step,
      "v1:prove-ownership",
      Schema.Boolean,
      async () => {
        await (await onboarding(null)).proveOwnership(domainId, actorId);

        return true;
      },
      { retries: { limit: 30, delay: "2 minutes", backoff: "linear" } },
    );

    const recorded = await promiseStep(step, "v1:recorded-authorization", Method, async () => {
      const ob = await onboarding(null);

      return recordedAuthorization(
        await ob.domains.mailLink(domainId),
        (await ob.domains.get(domainId)).state,
        (await zoneApiToken(this.env, await nameOf())) !== null,
      );
    });

    const method: ZoneAuthorizationMethod =
      recorded ??
      (
        await step.waitForEvent<{ method: ZoneAuthorizationMethod }>("v1:zone-authorized", {
          type: "zone-authorized",
          timeout: "7 days",
        })
      ).payload.method;

    await promiseStep(step, "v1:authorize-zone", Schema.Boolean, async () => {
      await (await onboarding(method)).domains.authorizeZone(domainId, actorId, { method });

      return true;
    });

    const dns = await promiseStep(
      step,
      "v1:configure-dns",
      DnsResult,
      async () => {
        const r = await (await onboarding(method)).configureDns(domainId, actorId);

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
        const r = await (await onboarding(method)).testInbound(domainId, actorId);

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
        const r = await (await onboarding(method)).testOutbound(domainId, actorId);

        if (!r.passed) throw new Error("outbound authentication not aligned");

        return true;
      },
      { retries: { limit: 36, delay: "10 minutes", backoff: "constant" } },
    );
    await promiseStep(step, "v1:activate", Schema.Boolean, async () => {
      await (await onboarding(method)).activate(domainId, actorId);

      return true;
    });

    return { domainId, state: "active", applied: dns.applied };
  }
}
