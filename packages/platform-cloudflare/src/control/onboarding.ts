import type { KernelClock } from "../durable/kernel.ts";
import type { CloudflareApi, CloudflareDnsRecord } from "./cloudflare.ts";
import { type D1Like, primary, q } from "./d1.ts";
import {
  catchAllElsewhere,
  classifyMailSetup,
  ControlDomains,
  DOMAIN_SEQUENCE,
  type DomainOnboardingState,
  type RoutingState,
  rollbackStates,
  DEFAULT_MAIL_DNS,
  type DomainMailLink,
  type MailSetupClassification,
  type MailSnapshot,
  snapshotMailDns,
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
// record without the explicit cutover confirmation: conflicts are reported and block advancement
// until the customer resolves them.

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

export interface MailInspection {
  readonly domain: DomainRow;
  readonly link: DomainMailLink;
  /** `zone-api`: authoritative zone records and routing rules; `public-dns`: DoH answers only. */
  readonly source: "zone-api" | "public-dns";
  readonly zoneId: string | null;
  readonly records: ReadonlyArray<DnsRecord>;
  readonly routing: RoutingState | null;
  readonly plan: ReadonlyArray<DnsOperation>;
  readonly classification: MailSetupClassification;
}

export interface MailPreview {
  readonly domain: DomainRow;
  readonly plan: ReadonlyArray<DnsOperation>;
  readonly diagnostics: unknown;
  readonly classification: MailSetupClassification;
  readonly source: MailInspection["source"];
  /**
   * After zone authorization: the current provider (foreign MX, or routing forwarding elsewhere)
   * is still in place and no switch was confirmed, so setup is held until the admin confirms.
   */
  readonly cutoverPending: boolean;
  readonly link: Omit<DomainMailLink, "snapshot"> & { readonly hasSnapshot: boolean };
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

  /** The zone the API reaches for this domain, refusing one other than the installation's. */
  private async zoneFor(
    d: DomainRow,
    link: DomainMailLink,
  ): Promise<{ readonly id: string; readonly name: string } | null> {
    const zone = await this.deps.api!.findZone(d.name);
    if (zone && link.installZoneId !== null && zone.id !== link.installZoneId)
      return reject("conflict", "zone does not match the installation's Cloudflare zone");
    return zone;
  }

  private async zoneRecords(
    zoneId: string,
    domain: string,
  ): Promise<ReadonlyArray<CloudflareDnsRecord>> {
    const names = [...new Set(relevantNames(domain, this.deps.profile).map(([name]) => name))];
    const lookups = names.map((n) => this.deps.api!.listDns(zoneId, n));
    // bounded: the fixed set of mail DNS names for one domain
    const existing = (await Promise.all(lookups)).flat();
    return [...new Map(existing.map((r) => [r.id, r])).values()];
  }

  private async routingState(zoneId: string): Promise<RoutingState> {
    const api = this.deps.api!;
    return {
      enabled: await api.emailRoutingEnabled(zoneId),
      catchAll: await api.catchAllRule(zoneId),
      rules: await api.routingRules(zoneId),
    };
  }

  /**
   * One read of the current mail setup. With zone access the records and Email Routing rules come
   * from the zone API (authoritative, not a possibly stale public answer); otherwise from DoH.
   */
  async inspect(domainId: string): Promise<MailInspection> {
    const domain = await this.domains.get(domainId);
    const link = await this.domains.mailLink(domainId);
    const zone = this.deps.api ? await this.zoneFor(domain, link) : null;
    const records = zone
      ? await this.zoneRecords(zone.id, domain.name)
      : await this.observe(domain.name);
    const routing = zone ? await this.routingState(zone.id) : null;
    const plan = planMailDns(domain.name, records, this.deps.profile, domain.verification_token);
    return {
      domain,
      link,
      source: zone ? "zone-api" : "public-dns",
      zoneId: zone?.id ?? null,
      records,
      routing,
      plan,
      classification: classifyMailSetup(
        domain.name,
        records,
        plan,
        this.deps.profile,
        routing,
        this.deps.workerName,
      ),
    };
  }

  /** The snapshot recorded before any write, from an inspection (no second lookup). */
  snapshotOf(inspection: MailInspection): MailSnapshot {
    return snapshotMailDns(
      inspection.domain.name,
      inspection.records,
      this.deps.profile,
      inspection.routing,
      this.clock.now(),
    );
  }

  async snapshot(domainId: string): Promise<MailSnapshot> {
    return this.snapshotOf(await this.inspect(domainId));
  }

  /** Change preview shown to the customer before anything is applied. */
  async preview(domainId: string, inspection?: MailInspection): Promise<MailPreview> {
    const i = inspection ?? (await this.inspect(domainId));
    const { snapshot, ...link } = i.link;
    const diag = await q(
      primary(this.db),
      "SELECT last_diagnostics FROM domains WHERE id = ?",
      domainId,
    ).first<{ last_diagnostics: string | null }>();
    const authorized =
      DOMAIN_SEQUENCE.indexOf(i.domain.state) >= DOMAIN_SEQUENCE.indexOf("zone-authorized") &&
      i.domain.state !== "active";
    return {
      domain: i.domain,
      plan: i.plan,
      diagnostics: diag?.last_diagnostics ? (JSON.parse(diag.last_diagnostics) as unknown) : null,
      classification: i.classification,
      source: i.source,
      cutoverPending:
        authorized && link.cutoverConfirmedAt === null && i.classification.requiresCutover,
      link: { ...link, hasSnapshot: snapshot !== null },
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
   * this step only verifies them. A confirmed cutover adds Bye's MX first and only then removes
   * the previous provider's, so the domain is never left without MX.
   */
  async configureDns(domainId: string, actorId: string): Promise<DnsStepResult> {
    const d = await this.domains.get(domainId);
    const applied: Array<DnsOperation> = [];
    let conflicts: ReadonlyArray<DnsOperation> = [];
    if (this.deps.api && (d.state === "zone-authorized" || d.state === "ownership-proven")) {
      let link = await this.domains.mailLink(domainId);
      const zone = await this.zoneFor(d, link);
      if (!zone) return reject("conflict", "zone not accessible with the onboarding token");
      const unique = await this.zoneRecords(zone.id, d.name);
      // Nothing is written before the previous configuration is on record.
      if (link.snapshot === null)
        link = await this.domains.recordCutover(
          domainId,
          actorId,
          snapshotMailDns(
            d.name,
            unique,
            this.deps.profile,
            await this.routingState(zone.id),
            this.clock.now(),
          ),
          false,
        );
      const plan = planMailDns(d.name, unique, this.deps.profile, d.verification_token);
      // A foreign MX is replaced only after the separate, explicit cutover confirmation; every
      // other conflict (SPF, DKIM) still needs the customer.
      const cutover = link.cutoverConfirmedAt !== null;
      conflicts = plan.filter(
        (op) => op.op === "conflict" && !(cutover && op.purpose === "inbound"),
      );
      const wrote = () => this.domains.recordWriteMode(domainId, "api");
      if (cutover && plan.some((op) => op.op === "conflict" && op.purpose === "inbound")) {
        // Create Bye's MX first (skipping any already present from an interrupted attempt)...
        for (const op of plan)
          if (op.op === "conflict" && op.purpose === "inbound") {
            const present = unique.some(
              (r) =>
                r.type === "MX" && r.content.toLowerCase() === op.desired.content.toLowerCase(),
            );
            if (!present) {
              await wrote();
              await this.deps.api.createDns(zone.id, op.desired);
            }
            applied.push({ op: "create", record: op.desired, purpose: "inbound (cutover)" });
          }
        // ...then remove the previous provider's.
        const foreign = unique.filter(
          (r) =>
            r.type === "MX" &&
            r.name.toLowerCase() === d.name &&
            !this.deps.profile.mxHosts.some((h) => h.host === r.content.toLowerCase()),
        );
        for (const r of foreign) await this.deps.api.deleteDns(zone.id, r.id);
      }
      for (const op of plan) {
        if (op.op === "create") {
          await wrote();
          await this.deps.api.createDns(zone.id, op.record);
          applied.push(op);
        } else if (op.op === "update") {
          const target = unique.find(
            (r) =>
              r.type === op.from.type && r.name === op.from.name && r.content === op.from.content,
          );
          if (target) {
            await wrote();
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
   * Inbound readiness: public MX answers point only at the service, and
   * - with zone access: Email Routing is enabled with the catch-all delivering to MailCore (an
   *   existing catch-all delivering elsewhere is replaced only after a confirmed cutover);
   * - without it (manual records): a message sent to the domain's `bye-verify-<token>@` address
   *   actually reached MailCore through the zone's MX and routing. MX alone is not evidence: the
   *   catch-all may be missing or deliver elsewhere.
   * Aliases stay in D1.
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
    const link = await this.domains.mailLink(domainId);
    if (this.deps.api && this.deps.workerName) {
      const zone = await this.zoneFor(d, link);
      if (!zone) return { domain: d, passed: false, detail: "zone not accessible" };
      const routing = await this.routingState(zone.id);
      if (catchAllElsewhere(routing, this.deps.workerName) && link.cutoverConfirmedAt === null)
        return {
          domain: d,
          passed: false,
          detail: "the catch-all rule delivers mail elsewhere; confirm the switch to Bye",
        };
      if (!routing.enabled) {
        await this.domains.recordWriteMode(domainId, "api");
        await this.deps.api.enableEmailRouting(zone.id);
      }
      if ((await this.deps.api.catchAllWorker(zone.id)) !== this.deps.workerName) {
        await this.domains.recordWriteMode(domainId, "api");
        await this.deps.api.catchAllToWorker(zone.id, this.deps.workerName);
      }
      return {
        domain: await this.domains.recordInboundTest(domainId, actorId, true),
        passed: true,
        detail: "MX and routing verified",
      };
    }
    if (link.inboundProbe?.receivedAt == null)
      return {
        domain: d,
        passed: false,
        detail: link.inboundProbe
          ? `waiting for a test message to ${link.inboundProbe.address}`
          : "no inbound verification address; authorize the zone again",
      };
    return {
      domain: await this.domains.recordInboundTest(domainId, actorId, true),
      passed: true,
      detail: "MX verified and a test message reached Bye",
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

  /**
   * Whether "Restore previous mail setup" can run, and how, checked before anything is stopped
   * or written. `api` when Bye itself wrote through the zone API and still has that access;
   * otherwise `manual` (the recorded setup is kept for the customer to restore by hand).
   */
  async rollbackPlan(domainId: string): Promise<{
    readonly mode: "api" | "manual";
    readonly state: DomainOnboardingState;
  }> {
    const d = await this.domains.get(domainId);
    if (!rollbackStates.includes(d.state))
      return reject("conflict", `domain is ${d.state}; nothing to restore`);
    const link = await this.domains.mailLink(domainId);
    if (link.snapshot === null) return reject("conflict", "no recorded mail setup to restore");
    if (link.writeMode !== "api" || !this.deps.api) return { mode: "manual", state: d.state };
    if (!(await this.zoneFor(d, link)))
      return reject("conflict", "zone not accessible with the onboarding token");
    return { mode: "api", state: d.state };
  }

  /**
   * "Restore previous mail setup" (infra/onboarding/spec.md §12 state 6): puts the recorded MX, SPF,
   * DKIM, DMARC and Email Routing state back through the path the change was made. Only records
   * Bye added or changed are touched; mailboxes, address routes and mail already accepted stay,
   * and the application deployment is not involved. In manual mode the recorded setup is kept on
   * the domain (`restore_pending`) and returned for the customer to restore by hand.
   */
  async rollback(
    domainId: string,
    actorId: string,
  ): Promise<{
    readonly domain: DomainRow;
    readonly restored: ReadonlyArray<string>;
    readonly manual: MailSnapshot | null;
  }> {
    const plan = await this.rollbackPlan(domainId);
    const d = await this.domains.get(domainId);
    const link = await this.domains.mailLink(domainId);
    const snap = link.snapshot!;
    const restored: Array<string> = [];
    if (plan.mode === "manual") {
      const domain = await this.domains.rewindAfterRollback(
        domainId,
        actorId,
        { manual: true, snapshot: snap },
        { expected: plan.state, restorePending: snap },
      );
      return { domain, restored, manual: snap };
    }
    const api = this.deps.api!;
    const zone = (await this.zoneFor(d, link))!;
    const profile = this.deps.profile;
    const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
    const ours = (host: string) => profile.mxHosts.some((h) => same(h.host, host));
    // MX: recreate the recorded ones first, then remove service MX that were not there before.
    const mx = (await api.listDns(zone.id, d.name)).filter((r) => r.type === "MX");
    for (const s of snap.mx)
      if (!mx.some((r) => same(r.content, s.content))) {
        await api.createDns(zone.id, s);
        restored.push(`restored MX ${s.content}`);
      }
    for (const r of mx)
      if (ours(r.content) && !snap.mx.some((s) => same(s.content, r.content))) {
        await api.deleteDns(zone.id, r.id);
        restored.push(`removed MX ${r.content}`);
      }
    // SPF: back to the recorded record (or none).
    const spf = (await api.listDns(zone.id, d.name)).filter(
      (r) => r.type === "TXT" && /^"?v=spf1\b/i.test(r.content),
    );
    const before = snap.spf[0];
    for (const r of spf) {
      if (before && r.content.replace(/^"|"$/g, "") === before.content) continue;
      if (!r.content.includes(`include:${profile.spfInclude}`)) continue;
      if (before) await api.updateDns(zone.id, r.id, before);
      else await api.deleteDns(zone.id, r.id);
      restored.push(before ? "restored SPF" : "removed SPF");
    }
    // DKIM and DMARC: remove only what Bye added (records present before are kept as they were).
    const dkimName = `${profile.dkimSelector}._domainkey.${d.name}`;
    if (snap.dkim.length === 0)
      for (const r of await api.listDns(zone.id, dkimName))
        if (r.type === "TXT" && r.content.includes(`p=${profile.dkimPublicKey}`)) {
          await api.deleteDns(zone.id, r.id);
          restored.push("removed DKIM");
        }
    if (snap.dmarc.length === 0)
      for (const r of await api.listDns(zone.id, `_dmarc.${d.name}`))
        if (r.type === "TXT" && r.content.includes(`mailto:${profile.dmarcReportAddress}`)) {
          await api.deleteDns(zone.id, r.id);
          restored.push("removed DMARC");
        }
    // Email Routing: the recorded catch-all rule exactly (forward, drop or worker), and enablement.
    if (snap.routing) {
      const current = await api.catchAllRule(zone.id);
      if (JSON.stringify(current) !== JSON.stringify(snap.routing.catchAll)) {
        if (snap.routing.catchAll === null) await api.disableCatchAll(zone.id);
        else await api.putCatchAll(zone.id, snap.routing.catchAll);
        restored.push("restored catch-all rule");
      }
      if (!snap.routing.enabled && (await api.emailRoutingEnabled(zone.id))) {
        await api.disableEmailRouting(zone.id);
        restored.push("disabled Email Routing");
      }
    }
    const domain = await this.domains.rewindAfterRollback(
      domainId,
      actorId,
      { restored },
      { expected: plan.state, restorePending: null },
    );
    return { domain, restored, manual: null };
  }

  async activate(domainId: string, actorId: string): Promise<DomainRow> {
    const d = await this.domains.get(domainId);
    return d.state === "active" ? d : this.domains.activate(domainId, actorId);
  }
}
