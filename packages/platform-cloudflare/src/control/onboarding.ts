import type { KernelClock } from "../durable/kernel.ts";
import type { CloudflareApi } from "./cloudflare.ts";
import { type D1Like, primary, q } from "./d1.ts";
import {
  ControlDomains,
  DEFAULT_MAIL_DNS,
  type DnsOperation,
  type DnsRecord,
  type DnsRecordType,
  type DomainDiagnostic,
  type DomainRow,
  type MailDnsProfile,
  planMailDns,
} from "./domains.ts";
import { reject } from "@bye/contracts";

// Resumable customer-domain onboarding steps (O01, §11 Domains). Each step is idempotent so a
// Workflow can retry it; state lives in D1 (`domains.state`). DNS changes are applied only through
// the scoped zone API (when the operator authorized it) and never delete or overwrite a foreign
// record: conflicts are reported and block advancement until the customer resolves them.

export type Resolver = (name: string, type: DnsRecordType) => Promise<ReadonlyArray<DnsRecord>>;

export interface OnboardingDeps {
  readonly api: CloudflareApi | null;
  readonly resolve: Resolver;
  readonly profile: MailDnsProfile;
  /** Worker receiving customer-zone mail via an Email Routing catch-all rule. */
  readonly workerName: string | null;
}

export const mailDnsProfile = (dkimPublicKey: string | undefined): MailDnsProfile => ({
  ...DEFAULT_MAIL_DNS,
  dkimPublicKey: dkimPublicKey ?? "",
});

const relevantNames = (domain: string, profile: MailDnsProfile) =>
  [
    [domain, "MX"],
    [domain, "TXT"],
    [`_bye-verification.${domain}`, "TXT"],
    [`${profile.dkimSelector}._domainkey.${domain}`, "TXT"],
    [`_dmarc.${domain}`, "TXT"],
  ] as const;

export interface DnsStepResult {
  readonly domain: DomainRow;
  readonly applied: ReadonlyArray<DnsOperation>;
  readonly conflicts: ReadonlyArray<DnsOperation>;
  readonly diagnostics: ReadonlyArray<DomainDiagnostic>;
}

export class DomainOnboarding {
  readonly domains: ControlDomains;

  constructor(
    readonly db: D1Like,
    readonly clock: KernelClock,
    readonly deps: OnboardingDeps,
  ) {
    this.domains = new ControlDomains(db, clock);
  }

  /** Public DNS answers for every record the profile manages. */
  async observe(domain: string): Promise<ReadonlyArray<DnsRecord>> {
    const answers: Array<DnsRecord> = [];
    for (const [name, type] of relevantNames(domain, this.deps.profile))
      answers.push(...(await this.deps.resolve(name, type)));
    return answers;
  }

  /** Change preview shown to the customer before anything is applied. */
  async preview(domainId: string): Promise<{
    readonly domain: DomainRow;
    readonly plan: ReadonlyArray<DnsOperation>;
    readonly diagnostics: unknown;
  }> {
    const d = await this.domains.get(domainId);
    const existing = await this.observe(d.name);
    const diag = await q(
      primary(this.db),
      "SELECT last_diagnostics FROM domains WHERE id = ?",
      domainId,
    ).first<{ last_diagnostics: string | null }>();
    return {
      domain: d,
      plan: planMailDns(d.name, existing, this.deps.profile, d.verification_token),
      diagnostics: diag?.last_diagnostics ? (JSON.parse(diag.last_diagnostics) as unknown) : null,
    };
  }

  async proveOwnership(domainId: string, actorId: string): Promise<DomainRow> {
    const d = await this.domains.get(domainId);
    return this.domains.proveOwnership(
      domainId,
      actorId,
      await this.deps.resolve(`_bye-verification.${d.name}`, "TXT"),
    );
  }

  /**
   * Apply the plan through the zone API (create/update only; conflicts are never auto-applied),
   * then verify the public answers. Without zone access the customer publishes the records and
   * this step only verifies them.
   */
  async configureDns(domainId: string, actorId: string): Promise<DnsStepResult> {
    const d = await this.domains.get(domainId);
    const applied: Array<DnsOperation> = [];
    let conflicts: ReadonlyArray<DnsOperation> = [];
    if (this.deps.api && (d.state === "zone-authorized" || d.state === "ownership-proven")) {
      const zone = await this.deps.api.findZone(d.name);
      if (!zone) return reject("conflict", "zone not accessible with the onboarding token");
      const lookups = relevantNames(d.name, this.deps.profile).map(([name]) =>
        this.deps.api!.listDns(zone.id, name),
      );
      // bounded: the fixed set of mail DNS names for one domain
      const existing = (await Promise.all(lookups)).flat();
      const unique = [...new Map(existing.map((r) => [r.id, r])).values()];
      const plan = planMailDns(d.name, unique, this.deps.profile, d.verification_token);
      conflicts = plan.filter((op) => op.op === "conflict");
      for (const op of plan) {
        if (op.op === "create") {
          await this.deps.api.createDns(zone.id, op.record);
          applied.push(op);
        } else if (op.op === "update") {
          const target = unique.find(
            (r) =>
              r.type === op.from.type && r.name === op.from.name && r.content === op.from.content,
          );
          if (target) {
            await this.deps.api.updateDns(zone.id, target.id, op.to);
            applied.push(op);
          }
        }
      }
    }
    if (d.state !== "zone-authorized") return { domain: d, applied, conflicts, diagnostics: [] };
    const { domain, diagnostics } = await this.domains.confirmDns(
      domainId,
      actorId,
      await this.observe(d.name),
      this.deps.profile,
    );
    return { domain, applied, conflicts, diagnostics };
  }

  /**
   * Inbound readiness: public MX answers point only at the service, and (with zone access) Email
   * Routing is enabled with the catch-all delivering to MailCore. Aliases stay in D1.
   */
  async testInbound(
    domainId: string,
    actorId: string,
  ): Promise<{ readonly domain: DomainRow; readonly passed: boolean; readonly detail: string }> {
    const d = await this.domains.get(domainId);
    if (d.state !== "dns-configured")
      return { domain: d, passed: d.state !== "zone-authorized", detail: `state ${d.state}` };
    const mx = await this.deps.resolve(d.name, "MX");
    const ours = mx.filter((r) =>
      this.deps.profile.mxHosts.some((h) => h.host === r.content.toLowerCase()),
    );
    if (ours.length === 0 || ours.length !== mx.length)
      return { domain: d, passed: false, detail: "MX records do not point only at the service" };
    if (this.deps.api && this.deps.workerName) {
      const zone = await this.deps.api.findZone(d.name);
      if (!zone) return { domain: d, passed: false, detail: "zone not accessible" };
      if (!(await this.deps.api.emailRoutingEnabled(zone.id)))
        await this.deps.api.enableEmailRouting(zone.id);
      if ((await this.deps.api.catchAllWorker(zone.id)) !== this.deps.workerName)
        await this.deps.api.catchAllToWorker(zone.id, this.deps.workerName);
    }
    return {
      domain: await this.domains.recordInboundTest(domainId, actorId, true),
      passed: true,
      detail: "MX and routing verified",
    };
  }

  /** Outbound authentication alignment from published SPF/DKIM/DMARC. */
  async testOutbound(
    domainId: string,
    actorId: string,
  ): Promise<{ readonly domain: DomainRow; readonly passed: boolean }> {
    const d = await this.domains.get(domainId);
    if (d.state !== "inbound-tested")
      return { domain: d, passed: ["outbound-tested", "active"].includes(d.state) };
    const answers = await this.observe(d.name);
    const txt = (name: string) =>
      answers
        .filter((r) => r.type === "TXT" && r.name.toLowerCase() === name.toLowerCase())
        .map((r) => r.content);
    const spfPass = txt(d.name).some(
      (c) => /^v=spf1\b/i.test(c) && c.includes(`include:${this.deps.profile.spfInclude}`),
    );
    const dkimAligned =
      this.deps.profile.dkimPublicKey !== "" &&
      txt(`${this.deps.profile.dkimSelector}._domainkey.${d.name}`).some((c) =>
        c.includes(`p=${this.deps.profile.dkimPublicKey}`),
      );
    const dmarc = txt(`_dmarc.${d.name}`).find((c) => /^v=DMARC1\b/i.test(c));
    const dmarcPass = dmarc !== undefined;
    if (!spfPass || !dkimAligned || !dmarcPass) return { domain: d, passed: false };
    return {
      domain: await this.domains.recordOutboundTest(domainId, actorId, {
        dkimAligned,
        spfPass,
        dmarcPass,
      }),
      passed: true,
    };
  }

  async activate(domainId: string, actorId: string): Promise<DomainRow> {
    const d = await this.domains.get(domainId);
    return d.state === "active" ? d : this.domains.activate(domainId, actorId);
  }
}
