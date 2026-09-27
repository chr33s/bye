import type { KernelClock } from "../durable/kernel.ts";
import { randomToken } from "./crypto.ts";
import { audit, type D1Like, primary, q } from "./d1.ts";
import { guardD1 } from "./errors.ts";
import { validLocalPart } from "./directory.ts";
import { reject } from "@bye/contracts";

// Custom-domain onboarding (O01, §11 Domains). A resumable state machine; every step is
// re-entrant and records diagnostics. DNS changes are planned, shown, and never delete or
// overwrite existing records without an explicit, separately confirmed cutover.

export type DomainOnboardingState =
  | "requested"
  | "ownership-proven"
  | "zone-authorized"
  | "dns-configured"
  | "inbound-tested"
  | "outbound-tested"
  | "active"
  | "removing"
  | "removed";

export const DOMAIN_SEQUENCE: ReadonlyArray<DomainOnboardingState> = [
  "requested",
  "ownership-proven",
  "zone-authorized",
  "dns-configured",
  "inbound-tested",
  "outbound-tested",
  "active",
];

export const nextDomainState = (
  state: DomainOnboardingState,
): DomainOnboardingState | undefined => {
  const i = DOMAIN_SEQUENCE.indexOf(state);
  return i >= 0 && i < DOMAIN_SEQUENCE.length - 1 ? DOMAIN_SEQUENCE[i + 1] : undefined;
};

export type DnsRecordType = "MX" | "TXT" | "CNAME";

export interface DnsRecord {
  readonly type: DnsRecordType;
  readonly name: string;
  readonly content: string;
  readonly priority?: number;
}

export type DnsOperation =
  | { readonly op: "create"; readonly record: DnsRecord; readonly purpose: string }
  | {
      readonly op: "update";
      readonly from: DnsRecord;
      readonly to: DnsRecord;
      readonly purpose: string;
    }
  | { readonly op: "keep"; readonly record: DnsRecord; readonly purpose: string }
  /** Requires explicit user confirmation; never applied automatically. */
  | {
      readonly op: "conflict";
      readonly existing: DnsRecord;
      readonly desired: DnsRecord;
      readonly purpose: string;
    };

export interface MailDnsProfile {
  readonly mxHosts: ReadonlyArray<{ readonly host: string; readonly priority: number }>;
  readonly spfInclude: string;
  readonly dkimSelector: string;
  readonly dkimPublicKey: string;
  readonly dmarcReportAddress: string;
}

export const DEFAULT_MAIL_DNS: Omit<MailDnsProfile, "dkimPublicKey"> = {
  mxHosts: [
    { host: "route1.mx.cloudflare.net", priority: 10 },
    { host: "route2.mx.cloudflare.net", priority: 20 },
    { host: "route3.mx.cloudflare.net", priority: 30 },
  ],
  spfInclude: "_spf.mx.cloudflare.net",
  dkimSelector: "bye1",
  dmarcReportAddress: "dmarc-reports@bye.email",
};

const isSpf = (r: DnsRecord) => r.type === "TXT" && /^"?v=spf1\b/i.test(r.content);
const isDmarc = (r: DnsRecord) => r.type === "TXT" && /^"?v=DMARC1\b/i.test(r.content);
const unquote = (s: string) => s.replace(/^"|"$/g, "");
const sameName = (a: string, b: string) =>
  a.toLowerCase().replace(/\.$/, "") === b.toLowerCase().replace(/\.$/, "");

/**
 * Plan DNS changes for a domain, preserving existing records:
 * - an existing SPF record gains our include rather than being replaced;
 * - an existing DMARC policy is kept (we never weaken a customer's policy);
 * - MX records for another provider are reported as a conflict needing a tested cutover.
 */
export const planMailDns = (
  domain: string,
  existing: ReadonlyArray<DnsRecord>,
  profile: MailDnsProfile,
  verificationToken: string,
): ReadonlyArray<DnsOperation> => {
  const ops: Array<DnsOperation> = [];
  const at = (name: string) => existing.filter((r) => sameName(r.name, name));

  const verification: DnsRecord = {
    type: "TXT",
    name: `_bye-verification.${domain}`,
    content: `bye-verification=${verificationToken}`,
  };
  const existingVerification = at(verification.name).find(
    (r) => r.type === "TXT" && unquote(r.content) === verification.content,
  );
  ops.push(
    existingVerification
      ? { op: "keep", record: existingVerification, purpose: "ownership" }
      : { op: "create", record: verification, purpose: "ownership" },
  );

  const existingMx = at(domain).filter((r) => r.type === "MX");
  const foreignMx = existingMx.find(
    (r) => !profile.mxHosts.some((h) => sameName(h.host, r.content)),
  );
  for (const mx of profile.mxHosts) {
    const desired: DnsRecord = {
      type: "MX",
      name: domain,
      content: mx.host,
      priority: mx.priority,
    };
    const match = existingMx.find((r) => sameName(r.content, mx.host));
    if (match) ops.push({ op: "keep", record: match, purpose: "inbound" });
    else if (foreignMx)
      ops.push({ op: "conflict", existing: foreignMx, desired, purpose: "inbound" });
    else ops.push({ op: "create", record: desired, purpose: "inbound" });
  }

  const spf = at(domain).filter(isSpf);
  const desiredSpf: DnsRecord = {
    type: "TXT",
    name: domain,
    content: `v=spf1 include:${profile.spfInclude} ~all`,
  };
  if (spf.length > 1) {
    ops.push({
      op: "conflict",
      existing: spf[0]!,
      desired: desiredSpf,
      purpose: "spf (multiple SPF records are invalid)",
    });
  } else if (spf.length === 1) {
    const current = unquote(spf[0]!.content);
    if (current.includes(`include:${profile.spfInclude}`))
      ops.push({ op: "keep", record: spf[0]!, purpose: "spf" });
    else {
      const merged = current.replace(/^v=spf1/i, `v=spf1 include:${profile.spfInclude}`);
      ops.push({
        op: "update",
        from: spf[0]!,
        to: { type: "TXT", name: domain, content: merged },
        purpose: "spf",
      });
    }
  } else {
    ops.push({ op: "create", record: desiredSpf, purpose: "spf" });
  }

  const dkimName = `${profile.dkimSelector}._domainkey.${domain}`;
  const dkimDesired: DnsRecord = {
    type: "TXT",
    name: dkimName,
    content: `v=DKIM1; k=rsa; p=${profile.dkimPublicKey}`,
  };
  const dkim = at(dkimName).find((r) => r.type === "TXT");
  if (!dkim) ops.push({ op: "create", record: dkimDesired, purpose: "dkim" });
  else if (unquote(dkim.content) === dkimDesired.content)
    ops.push({ op: "keep", record: dkim, purpose: "dkim" });
  else
    ops.push({
      op: "conflict",
      existing: dkim,
      desired: dkimDesired,
      purpose: "dkim selector in use",
    });

  const dmarcName = `_dmarc.${domain}`;
  const dmarc = at(dmarcName).find(isDmarc);
  ops.push(
    dmarc
      ? { op: "keep", record: dmarc, purpose: "dmarc" }
      : {
          op: "create",
          record: {
            type: "TXT",
            name: dmarcName,
            content: `v=DMARC1; p=quarantine; rua=mailto:${profile.dmarcReportAddress}`,
          },
          purpose: "dmarc",
        },
  );
  return ops;
};

/** How a domain's current mail setup relates to the proposed Bye configuration. */
export type MailSetupKind = "new" | "existing-provider" | "conflicted";

export interface MailSetupClassification {
  /**
   * `new`: no foreign MX, Bye can configure inbound mail after one confirmation.
   * `existing-provider`: MX points at another provider; switching needs an explicit cutover.
   * `conflicted`: a non-MX conflict (several SPF records, DKIM selector in use) blocks setup.
   */
  readonly kind: MailSetupKind;
  /** Recognized provider behind the current MX records, or a description of the host. */
  readonly provider: string | null;
  readonly currentMx: ReadonlyArray<DnsRecord>;
  /** Non-MX conflicts the customer must resolve; never applied automatically. */
  readonly conflicts: ReadonlyArray<DnsOperation>;
  /** Replacing the current MX (and routing) needs the separate cutover confirmation. */
  readonly requiresCutover: boolean;
}

const MAIL_PROVIDERS: ReadonlyArray<readonly [RegExp, string]> = [
  [/(^|\.)(google|googlemail)\.com$/i, "Google Workspace"],
  [/(^|\.)outlook\.com$/i, "Microsoft 365"],
  [/(^|\.)messagingengine\.com$/i, "Fastmail"],
  [/(^|\.)zoho\.(com|eu|in)$/i, "Zoho Mail"],
  [/(^|\.)(protonmail\.ch|proton\.me)$/i, "Proton Mail"],
  [/(^|\.)icloud\.com$/i, "iCloud Mail"],
  [/(^|\.)mimecast\.com$/i, "Mimecast"],
  [/(^|\.)pphosted\.com$/i, "Proofpoint"],
  [/(^|\.)secureserver\.net$/i, "GoDaddy"],
  [/(^|\.)mx\.cloudflare\.net$/i, "Cloudflare Email Routing"],
];

/** Best-effort name of the provider the MX records point at (display only). */
export const detectMailProvider = (mx: ReadonlyArray<DnsRecord>): string | null => {
  if (mx.length === 0) return null;
  const hosts = mx.map((r) => r.content.toLowerCase().replace(/\.$/, ""));
  for (const [pattern, name] of MAIL_PROVIDERS) if (hosts.some((h) => pattern.test(h))) return name;
  return `another mail provider (${hosts[0]})`;
};

/** A Cloudflare Email Routing rule (catch-all or address rule), recorded exactly. */
export interface EmailRoutingRule {
  readonly enabled: boolean;
  readonly name?: string;
  readonly matchers: ReadonlyArray<{
    readonly type: string;
    readonly field?: string;
    readonly value?: string;
  }>;
  readonly actions: ReadonlyArray<{
    readonly type: string;
    readonly value?: ReadonlyArray<string>;
  }>;
}

/** The zone's Email Routing state, as read through the zone API. */
export interface RoutingState {
  readonly enabled: boolean;
  readonly catchAll: EmailRoutingRule | null;
  /** Address rules (not the catch-all). */
  readonly rules: ReadonlyArray<EmailRoutingRule>;
}

/** Whether an enabled rule delivers mail somewhere other than the MailCore Worker. */
const deliversElsewhere = (rule: EmailRoutingRule | null, workerName: string | null): boolean =>
  rule !== null &&
  rule.enabled &&
  rule.actions.some(
    (a) =>
      a.type === "forward" ||
      (a.type === "worker" && (workerName === null || !(a.value ?? []).includes(workerName))),
  );

/** The catch-all delivers somewhere other than MailCore (replacing it hijacks that mail). */
export const catchAllElsewhere = (routing: RoutingState | null, workerName: string | null) =>
  routing !== null && deliversElsewhere(routing.catchAll, workerName);

/**
 * Classifies a planned change set (`planMailDns`) against the current MX records and, when known,
 * the zone's Email Routing rules. MX pointing at Cloudflare Email Routing is still an existing
 * provider when the routing forwards mail elsewhere (or, without zone access, when the rules can't
 * be read): switching it to Bye needs the same explicit cutover confirmation as a foreign MX.
 */
export const classifyMailSetup = (
  domain: string,
  existing: ReadonlyArray<DnsRecord>,
  plan: ReadonlyArray<DnsOperation>,
  profile: MailDnsProfile,
  routing: RoutingState | null = null,
  workerName: string | null = null,
): MailSetupClassification => {
  const currentMx = existing.filter((r) => r.type === "MX" && sameName(r.name, domain));
  const foreign = currentMx.filter(
    (r) => !profile.mxHosts.some((h) => sameName(h.host, r.content)),
  );
  const routedByCloudflare = currentMx.length > 0 && foreign.length === 0;
  const forwarding =
    routedByCloudflare &&
    (routing === null
      ? true
      : // Rules count even while Email Routing is off: enabling it would put them back in force.
        deliversElsewhere(routing.catchAll, workerName) ||
        routing.rules.some((r) => deliversElsewhere(r, workerName)));
  const conflicts = plan.filter((op) => op.op === "conflict" && op.purpose !== "inbound");
  const existingProvider = foreign.length > 0 || forwarding;
  return {
    kind: conflicts.length > 0 ? "conflicted" : existingProvider ? "existing-provider" : "new",
    provider:
      foreign.length > 0
        ? detectMailProvider(foreign)
        : forwarding
          ? routing === null
            ? "Cloudflare Email Routing (its current rules are not visible to Bye)"
            : "Cloudflare Email Routing forwarding"
          : detectMailProvider(currentMx),
    currentMx,
    conflicts,
    requiresCutover: existingProvider,
  };
};

/**
 * Mail configuration recorded before any cutover write, for "Restore previous mail setup".
 * `routing` is null when it could not be read (no zone API access).
 */
export interface MailSnapshot {
  readonly capturedAt: number;
  readonly mx: ReadonlyArray<DnsRecord>;
  readonly spf: ReadonlyArray<DnsRecord>;
  readonly dkim: ReadonlyArray<DnsRecord>;
  readonly dmarc: ReadonlyArray<DnsRecord>;
  readonly routing: RoutingState | null;
}

export const snapshotMailDns = (
  domain: string,
  records: ReadonlyArray<DnsRecord>,
  profile: MailDnsProfile,
  routing: MailSnapshot["routing"],
  capturedAt: number,
): MailSnapshot => {
  const strip = (r: DnsRecord): DnsRecord => ({
    type: r.type,
    name: r.name,
    content: unquote(r.content),
    ...(r.priority !== undefined ? { priority: r.priority } : {}),
  });
  const at = (name: string) => records.filter((r) => sameName(r.name, name)).map(strip);
  return {
    capturedAt,
    mx: at(domain).filter((r) => r.type === "MX"),
    spf: at(domain).filter(isSpf),
    dkim: at(`${profile.dkimSelector}._domainkey.${domain}`).filter((r) => r.type === "TXT"),
    dmarc: at(`_dmarc.${domain}`).filter(isDmarc),
    routing,
  };
};

/** How Bye changed a zone's mail setup; rollback restores through the same path. */
export type MailWriteMode = "api" | "manual";

export type ZoneAuthMethod = "service-zone" | "delegated-token" | "manual-records";

/** Installation binding and cutover record of a domain (infra/onboarding/spec.md §12, §15). */
export interface DomainMailLink {
  readonly installAccountId: string | null;
  readonly installZoneId: string | null;
  readonly cutoverConfirmedAt: number | null;
  readonly snapshot: MailSnapshot | null;
  /** Recorded zone authorization; a restarted Workflow resumes from it. */
  readonly zoneAuthMethod: ZoneAuthMethod | null;
  readonly writeMode: MailWriteMode | null;
  /** After a manual-records rollback: the setup the customer still has to restore by hand. */
  readonly restorePending: MailSnapshot | null;
  /** End-to-end inbound check address and when a message to it reached MailCore. */
  readonly inboundProbe: { readonly address: string; readonly receivedAt: number | null } | null;
}

/** Local part prefix of the inbound verification address (`bye-verify-<token>@<domain>`). */
export const INBOUND_PROBE_PREFIX = "bye-verify-";

const probeToken = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");

/** States from which "Restore previous mail setup" applies (zone authorization onwards). */
export const rollbackStates: ReadonlyArray<DomainOnboardingState> = DOMAIN_SEQUENCE.slice(
  DOMAIN_SEQUENCE.indexOf("ownership-proven"),
);

export type DiagnosticStatus = "pass" | "fail" | "warn";

export interface DomainDiagnostic {
  readonly check: "ownership" | "mx" | "spf" | "dkim" | "dmarc";
  readonly status: DiagnosticStatus;
  readonly detail: string;
}

/** Evaluate observed DNS answers against the desired profile. */
export const diagnoseMailDns = (
  domain: string,
  answers: ReadonlyArray<DnsRecord>,
  profile: MailDnsProfile,
  verificationToken: string,
): ReadonlyArray<DomainDiagnostic> => {
  const at = (name: string) => answers.filter((r) => sameName(r.name, name));
  const out: Array<DomainDiagnostic> = [];
  const own = at(`_bye-verification.${domain}`).some(
    (r) => unquote(r.content) === `bye-verification=${verificationToken}`,
  );
  out.push({
    check: "ownership",
    status: own ? "pass" : "fail",
    detail: own ? "verification token found" : "verification TXT record missing",
  });
  const mx = at(domain).filter((r) => r.type === "MX");
  const ours = mx.filter((r) => profile.mxHosts.some((h) => sameName(h.host, r.content)));
  out.push({
    check: "mx",
    status:
      ours.length === profile.mxHosts.length && ours.length === mx.length
        ? "pass"
        : ours.length > 0
          ? "warn"
          : "fail",
    detail:
      ours.length === mx.length && ours.length > 0
        ? "all MX records point to the service"
        : mx.length > ours.length
          ? "other providers' MX records are present"
          : "service MX records missing",
  });
  const spf = at(domain).filter(isSpf);
  out.push({
    check: "spf",
    status:
      spf.length === 1 && unquote(spf[0]!.content).includes(`include:${profile.spfInclude}`)
        ? "pass"
        : "fail",
    detail:
      spf.length > 1
        ? "multiple SPF records"
        : spf.length === 0
          ? "no SPF record"
          : "SPF include check",
  });
  const dkim = at(`${profile.dkimSelector}._domainkey.${domain}`).some((r) =>
    unquote(r.content).includes(`p=${profile.dkimPublicKey}`),
  );
  out.push({
    check: "dkim",
    status: dkim ? "pass" : "fail",
    detail: dkim ? "DKIM key published" : "DKIM key missing or different",
  });
  const dmarc = at(`_dmarc.${domain}`).find(isDmarc);
  const policy = dmarc ? /p=(\w+)/i.exec(unquote(dmarc.content))?.[1]?.toLowerCase() : undefined;
  out.push({
    check: "dmarc",
    status: !dmarc ? "fail" : policy === "none" ? "warn" : "pass",
    detail: dmarc ? `policy ${policy}` : "no DMARC record",
  });
  return out;
};

export interface DomainRow {
  readonly id: string;
  readonly org_id: string;
  readonly name: string;
  readonly state: DomainOnboardingState;
  readonly verification_token: string;
  readonly plus_addressing: number;
  readonly catch_all_mailbox_id: string | null;
}

const DOMAIN_NAME = /^(?=.{1,253}$)(?!-)([a-z0-9-]{1,63}(?<!-)\.)+[a-z]{2,63}$/;

/** How long an unproven domain claim blocks other organizations. */
export const UNPROVEN_CLAIM_TTL_MS = 72 * 3600 * 1000;

export class ControlDomains {
  constructor(
    readonly db: D1Like,
    readonly clock: KernelClock,
  ) {}

  async get(domainId: string): Promise<DomainRow> {
    const d = await guardD1("domain", () =>
      q(
        primary(this.db),
        "SELECT id, org_id, name, state, verification_token, plus_addressing, catch_all_mailbox_id FROM domains WHERE id = ?",
        domainId,
      ).first<DomainRow>(),
    );
    return d ?? reject("not_found", "domain");
  }

  async request(orgId: string, actorId: string, name: string): Promise<DomainRow> {
    const normalized = name.trim().toLowerCase().replace(/\.$/, "");
    if (!DOMAIN_NAME.test(normalized)) reject("bad_request", "invalid domain name");
    const id = this.clock.id("dom");
    const token = randomToken(18);
    const now = this.clock.now();
    // An unproven claim is not exclusive forever: after the proof window, another organization may
    // claim the name, so a squatter cannot block the real owner (O01).
    const prior = await guardD1("domain", () =>
      q(
        primary(this.db),
        "SELECT id, org_id, state, created_at FROM domains WHERE name = ?",
        normalized,
      ).first<{ id: string; org_id: string; state: string; created_at: number }>(),
    );
    if (prior?.org_id === orgId && prior.state === "requested") return this.get(prior.id);
    const expiredClaim =
      prior &&
      prior.state === "requested" &&
      now - Number(prior.created_at) > UNPROVEN_CLAIM_TTL_MS;
    try {
      // Releasing an expired claim, claiming the name and auditing commit together.
      await this.db.batch([
        ...(expiredClaim
          ? [q(this.db, "DELETE FROM domains WHERE id = ? AND state = 'requested'", prior.id)]
          : []),
        // A removed domain keeps its row (audit history, disabled routes) but releases the unique
        // name, so the same or another organization can request it again (O01).
        ...(prior?.state === "removed"
          ? [
              q(
                this.db,
                "UPDATE domains SET name = ? WHERE id = ? AND state = 'removed'",
                `removed:${prior.id}:${normalized}`,
                prior.id,
              ),
            ]
          : []),
        q(
          this.db,
          "INSERT INTO domains (id, org_id, name, state, verification_token, created_at, updated_at) VALUES (?, ?, ?, 'requested', ?, ?, ?)",
          id,
          orgId,
          normalized,
          token,
          now,
          now,
        ),
        audit(this.db, this.clock, {
          orgId,
          actorId,
          action: "domain.request",
          target: id,
          detail: { name: normalized },
        }),
      ]);
    } catch {
      reject("conflict", "domain already claimed");
    }
    return this.get(id);
  }

  /**
   * Binds the onboarding-selected zone as this organization's customer domain without asking for
   * the name again (infra/onboarding/spec.md §15). Onboarding already established that the connected
   * Cloudflare account holds the zone, so the ownership step is satisfied by that link instead of
   * a TXT record. The domain can never be re-linked to another account or zone. Reuses an existing
   * row of the same organization (re-entrant).
   */
  async requestFromInstallation(
    orgId: string,
    actorId: string,
    link: { readonly name: string; readonly accountId: string; readonly zoneId: string },
  ): Promise<DomainRow> {
    const name = link.name.trim().toLowerCase().replace(/\.$/, "");
    if (!DOMAIN_NAME.test(name)) reject("bad_request", "invalid domain name");
    if (!link.accountId || !link.zoneId) reject("conflict", "installation zone is not recorded");
    const prior = await guardD1("domain", () =>
      q(
        primary(this.db),
        "SELECT id, org_id, state, install_account_id, install_zone_id FROM domains WHERE name = ?",
        name,
      ).first<{
        id: string;
        org_id: string;
        state: string;
        install_account_id: string | null;
        install_zone_id: string | null;
      }>(),
    );
    const mine = prior !== null && prior.org_id === orgId && prior.state !== "removed";
    if (
      mine &&
      ((prior.install_zone_id !== null && prior.install_zone_id !== link.zoneId) ||
        (prior.install_account_id !== null && prior.install_account_id !== link.accountId))
    )
      reject("conflict", "domain is bound to a different Cloudflare account or zone");
    const row = mine ? await this.get(prior.id) : await this.request(orgId, actorId, name);
    await this.db.batch([
      q(
        this.db,
        "UPDATE domains SET install_account_id = ?, install_zone_id = ?, updated_at = ? WHERE id = ? AND install_zone_id IS NULL",
        link.accountId,
        link.zoneId,
        this.clock.now(),
        row.id,
      ),
      audit(this.db, this.clock, {
        orgId,
        actorId,
        action: "domain.installation-link",
        target: row.id,
        detail: { accountId: link.accountId, zoneId: link.zoneId },
      }),
    ]);
    return row.state === "requested"
      ? this.advance(row, "requested", actorId, {
          method: "installation-zone",
          accountId: link.accountId,
          zoneId: link.zoneId,
        })
      : row;
  }

  async mailLink(domainId: string): Promise<DomainMailLink> {
    const r = await guardD1("domain", () =>
      q(
        primary(this.db),
        "SELECT name, install_account_id, install_zone_id, cutover_confirmed_at, cutover_snapshot, zone_auth_method, mail_write_mode, restore_pending, inbound_probe_token, inbound_probe_at FROM domains WHERE id = ?",
        domainId,
      ).first<{
        name: string;
        install_account_id: string | null;
        install_zone_id: string | null;
        cutover_confirmed_at: number | null;
        cutover_snapshot: string | null;
        zone_auth_method: string | null;
        mail_write_mode: string | null;
        restore_pending: string | null;
        inbound_probe_token: string | null;
        inbound_probe_at: number | null;
      }>(),
    );
    if (!r) return reject("not_found", "domain");
    return {
      installAccountId: r.install_account_id,
      installZoneId: r.install_zone_id,
      cutoverConfirmedAt: r.cutover_confirmed_at === null ? null : Number(r.cutover_confirmed_at),
      snapshot: r.cutover_snapshot ? (JSON.parse(r.cutover_snapshot) as MailSnapshot) : null,
      zoneAuthMethod: (r.zone_auth_method as ZoneAuthMethod | null) ?? null,
      writeMode: (r.mail_write_mode as MailWriteMode | null) ?? null,
      restorePending: r.restore_pending ? (JSON.parse(r.restore_pending) as MailSnapshot) : null,
      inboundProbe: r.inbound_probe_token
        ? {
            address: `${INBOUND_PROBE_PREFIX}${r.inbound_probe_token}@${r.name}`,
            receivedAt: r.inbound_probe_at === null ? null : Number(r.inbound_probe_at),
          }
        : null,
    };
  }

  /**
   * Records how zone authorization was given (so a restarted Workflow resumes without waiting for
   * the event again) and issues a fresh inbound verification address for this attempt.
   */
  async recordAuthorization(
    domainId: string,
    actorId: string,
    method: ZoneAuthMethod,
  ): Promise<DomainMailLink> {
    const d = await this.get(domainId);
    await this.db.batch([
      q(
        this.db,
        "UPDATE domains SET zone_auth_method = ?, inbound_probe_token = ?, inbound_probe_at = NULL, mail_write_mode = COALESCE(mail_write_mode, ?), updated_at = ? WHERE id = ?",
        method,
        probeToken(),
        method === "manual-records" ? "manual" : null,
        this.clock.now(),
        d.id,
      ),
      audit(this.db, this.clock, {
        orgId: d.org_id,
        actorId,
        action: "domain.zone.authorize",
        target: d.id,
        detail: { method },
      }),
    ]);
    return this.mailLink(d.id);
  }

  /** Bye wrote DNS or Email Routing itself; once `api`, it stays `api` until a rollback. */
  async recordWriteMode(domainId: string, mode: MailWriteMode): Promise<void> {
    await q(
      this.db,
      "UPDATE domains SET mail_write_mode = CASE WHEN mail_write_mode = 'api' THEN 'api' ELSE ? END WHERE id = ?",
      mode,
      domainId,
    ).run();
  }

  /**
   * A message to `bye-verify-<token>@<domain>` reached MailCore: proof the zone's MX and routing
   * deliver to Bye. Returns whether the address matched a domain's current verification token.
   */
  async recordInboundProbe(address: string): Promise<boolean> {
    const at = address.trim().toLowerCase().lastIndexOf("@");
    if (at <= 0) return false;
    const local = address.trim().toLowerCase().slice(0, at);
    const domain = address
      .trim()
      .toLowerCase()
      .slice(at + 1);
    if (!local.startsWith(INBOUND_PROBE_PREFIX)) return false;
    const token = local.slice(INBOUND_PROBE_PREFIX.length);
    if (!/^[a-f0-9]{24}$/.test(token)) return false;
    const r = await q(
      this.db,
      "UPDATE domains SET inbound_probe_at = COALESCE(inbound_probe_at, ?) WHERE name = ? AND inbound_probe_token = ? AND state != 'removed'",
      this.clock.now(),
      domain,
      token,
    ).run();
    return r.meta.changes > 0;
  }

  /** The customer restored their previous setup by hand (after a manual-records rollback). */
  async acknowledgeRestore(domainId: string, actorId: string): Promise<DomainMailLink> {
    const d = await this.get(domainId);
    await this.db.batch([
      q(
        this.db,
        "UPDATE domains SET restore_pending = NULL, updated_at = ? WHERE id = ?",
        this.clock.now(),
        d.id,
      ),
      audit(this.db, this.clock, {
        orgId: d.org_id,
        actorId,
        action: "domain.mail.restore-acknowledged",
        target: d.id,
      }),
    ]);
    return this.mailLink(d.id);
  }

  /**
   * Records the pre-change snapshot (the first one wins until a rollback clears it; a setup still
   * waiting to be restored by hand is kept as the snapshot, never replaced by Bye's own records)
   * and, when the admin confirmed replacing the current provider, the cutover confirmation.
   */
  async recordCutover(
    domainId: string,
    actorId: string,
    snapshot: MailSnapshot,
    confirmed: boolean,
  ): Promise<DomainMailLink> {
    const d = await this.get(domainId);
    await this.db.batch([
      q(
        this.db,
        "UPDATE domains SET cutover_snapshot = COALESCE(cutover_snapshot, restore_pending, ?), restore_pending = NULL, cutover_confirmed_at = CASE WHEN ? THEN COALESCE(cutover_confirmed_at, ?) ELSE cutover_confirmed_at END, updated_at = ? WHERE id = ?",
        JSON.stringify(snapshot),
        confirmed ? 1 : 0,
        this.clock.now(),
        this.clock.now(),
        d.id,
      ),
      audit(this.db, this.clock, {
        orgId: d.org_id,
        actorId,
        action: confirmed ? "domain.cutover.confirm" : "domain.mail.snapshot",
        target: d.id,
      }),
    ]);
    return this.mailLink(d.id);
  }

  /**
   * After "Restore previous mail setup": the domain returns to `ownership-proven` and setup can be
   * started again (a fresh Workflow; `workflow_instance` is cleared). Mailboxes, address routes and
   * accepted mail are untouched; the snapshot, confirmation, authorization and write mode are
   * cleared (kept in the audit log). A manual-records rollback keeps the recorded setup in
   * `restore_pending` until the customer confirms they restored it. Fails when the state moved
   * since `expected` was read, so a restore is never reported against a state it did not see.
   */
  async rewindAfterRollback(
    domainId: string,
    actorId: string,
    detail: unknown,
    options: {
      readonly expected: DomainOnboardingState;
      readonly restorePending: MailSnapshot | null;
    },
  ): Promise<DomainRow> {
    const d = await this.get(domainId);
    if (!rollbackStates.includes(d.state))
      reject("conflict", `domain is ${d.state}; nothing to restore`);
    const r = await q(
      this.db,
      "UPDATE domains SET state = 'ownership-proven', cutover_confirmed_at = NULL, cutover_snapshot = NULL, restore_pending = ?, zone_auth_method = NULL, mail_write_mode = NULL, inbound_probe_token = NULL, inbound_probe_at = NULL, workflow_instance = NULL, updated_at = ? WHERE id = ? AND state = ?",
      options.restorePending === null ? null : JSON.stringify(options.restorePending),
      this.clock.now(),
      d.id,
      options.expected,
    ).run();
    if (r.meta.changes !== 1)
      reject("conflict", "the domain changed while its mail setup was being restored; try again");
    await audit(this.db, this.clock, {
      orgId: d.org_id,
      actorId,
      action: "domain.mail.rollback",
      target: d.id,
      detail,
    }).run();
    return this.get(d.id);
  }

  private async advance(
    domain: DomainRow,
    from: DomainOnboardingState,
    actorId: string,
    diagnostics?: unknown,
  ): Promise<DomainRow> {
    const to = nextDomainState(from)!;
    if (domain.state !== from) {
      // Re-entrant: a repeated step on an already-advanced domain is a no-op.
      if (DOMAIN_SEQUENCE.indexOf(domain.state) > DOMAIN_SEQUENCE.indexOf(from)) return domain;
      reject("conflict", `domain is ${domain.state}, expected ${from}`);
    }
    await this.db.batch([
      q(
        this.db,
        "UPDATE domains SET state = ?, last_diagnostics = ?, updated_at = ? WHERE id = ? AND state = ?",
        to,
        diagnostics === undefined ? null : JSON.stringify(diagnostics),
        this.clock.now(),
        domain.id,
        from,
      ),
      audit(this.db, this.clock, {
        orgId: domain.org_id,
        actorId,
        action: `domain.${to}`,
        target: domain.id,
      }),
    ]);
    return this.get(domain.id);
  }

  async proveOwnership(
    domainId: string,
    actorId: string,
    txtAnswers: ReadonlyArray<DnsRecord>,
  ): Promise<DomainRow> {
    const d = await this.get(domainId);
    if (d.state !== "requested") return this.advance(d, "requested", actorId);
    const ok = txtAnswers.some(
      (r) =>
        r.type === "TXT" &&
        sameName(r.name, `_bye-verification.${d.name}`) &&
        unquote(r.content) === `bye-verification=${d.verification_token}`,
    );
    if (!ok) reject("conflict", "ownership TXT record not found");
    return this.advance(d, "requested", actorId);
  }

  /** Record that an authorized operational path exists for this zone (§5.4 Domain onboarding gate). */
  async authorizeZone(
    domainId: string,
    actorId: string,
    evidence: { readonly method: "service-zone" | "delegated-token" | "manual-records" },
  ): Promise<DomainRow> {
    return this.advance(await this.get(domainId), "ownership-proven", actorId, evidence);
  }

  async confirmDns(
    domainId: string,
    actorId: string,
    answers: ReadonlyArray<DnsRecord>,
    profile: MailDnsProfile,
  ): Promise<{ domain: DomainRow; diagnostics: ReadonlyArray<DomainDiagnostic> }> {
    const d = await this.get(domainId);
    const diagnostics = diagnoseMailDns(d.name, answers, profile, d.verification_token);
    if (d.state === "zone-authorized" && diagnostics.some((x) => x.status === "fail")) {
      await q(
        this.db,
        "UPDATE domains SET last_diagnostics = ?, updated_at = ? WHERE id = ?",
        JSON.stringify(diagnostics),
        this.clock.now(),
        d.id,
      ).run();
      return { domain: d, diagnostics };
    }
    return { domain: await this.advance(d, "zone-authorized", actorId, diagnostics), diagnostics };
  }

  async recordInboundTest(domainId: string, actorId: string, passed: boolean): Promise<DomainRow> {
    const d = await this.get(domainId);
    if (!passed) reject("conflict", "inbound test failed");
    return this.advance(d, "dns-configured", actorId);
  }

  async recordOutboundTest(
    domainId: string,
    actorId: string,
    result: { dkimAligned: boolean; spfPass: boolean; dmarcPass: boolean },
  ): Promise<DomainRow> {
    const d = await this.get(domainId);
    if (!result.dkimAligned || !result.dmarcPass)
      reject("conflict", "outbound authentication not aligned");
    return this.advance(d, "inbound-tested", actorId, result);
  }

  async activate(domainId: string, actorId: string): Promise<DomainRow> {
    return this.advance(await this.get(domainId), "outbound-tested", actorId);
  }

  async configure(
    domainId: string,
    actorId: string,
    settings: { plusAddressing?: boolean; catchAllMailboxId?: string | null },
  ): Promise<DomainRow> {
    const d = await this.get(domainId);
    if (settings.catchAllMailboxId) {
      const m = await q(
        primary(this.db),
        "SELECT org_id FROM mailboxes WHERE id = ?",
        settings.catchAllMailboxId,
      ).first<{ org_id: string }>();
      if (!m || m.org_id !== d.org_id)
        reject("forbidden", "catch-all mailbox must belong to the domain organization");
    }
    await this.db.batch([
      q(
        this.db,
        "UPDATE domains SET plus_addressing = COALESCE(?, plus_addressing), catch_all_mailbox_id = CASE WHEN ? THEN ? ELSE catch_all_mailbox_id END, updated_at = ? WHERE id = ?",
        settings.plusAddressing === undefined ? null : settings.plusAddressing ? 1 : 0,
        settings.catchAllMailboxId !== undefined,
        settings.catchAllMailboxId ?? null,
        this.clock.now(),
        d.id,
      ),
      audit(this.db, this.clock, {
        orgId: d.org_id,
        actorId,
        action: "domain.configure",
        target: d.id,
        detail: settings,
      }),
    ]);
    return this.get(d.id);
  }

  // ---- aliases on an active customer domain (O01/O02): exact-address rows in D1, never per-user
  // Email Routing rules; the catch-all Worker route delivers everything to MailCore. ----

  async listAliases(domainId: string): Promise<
    ReadonlyArray<{
      readonly address: string;
      readonly mailboxId: string;
      readonly kind: string;
      readonly disabled: boolean;
    }>
  > {
    const d = await this.get(domainId);
    const rows = await q(
      primary(this.db),
      "SELECT address, mailbox_id, kind, disabled_at FROM address_routes WHERE domain = ? ORDER BY address",
      d.name,
    ).all<{ address: string; mailbox_id: string; kind: string; disabled_at: number | null }>();
    return rows.results.map((r) => ({
      address: r.address,
      mailboxId: r.mailbox_id,
      kind: r.kind,
      disabled: r.disabled_at !== null,
    }));
  }

  async addAlias(
    domainId: string,
    actorId: string,
    input: {
      readonly localPart: string;
      readonly mailboxId: string;
      readonly kind?: "alias" | "extension";
    },
  ): Promise<{ readonly address: string }> {
    const d = await this.get(domainId);
    if (d.state !== "active") reject("conflict", "domain not active");
    const local = input.localPart.trim().toLowerCase();
    if (!validLocalPart(local)) reject("bad_request", "invalid local part");
    const m = await q(
      primary(this.db),
      "SELECT org_id, status FROM mailboxes WHERE id = ?",
      input.mailboxId,
    ).first<{ org_id: string; status: string | null }>();
    if (!m || m.org_id !== d.org_id)
      reject("forbidden", "mailbox must belong to the domain organization");
    const address = `${local}@${d.name}`;
    const reserved = await q(
      primary(this.db),
      "SELECT 1 AS r FROM address_reservations WHERE address = ?",
      address,
    ).first();
    if (reserved) reject("conflict", "address reserved");
    const now = this.clock.now();
    try {
      await this.db.batch([
        // A previously removed alias may be reassigned by the same organization.
        q(
          this.db,
          "DELETE FROM address_routes WHERE address = ? AND disabled_at IS NOT NULL AND domain = ?",
          address,
          d.name,
        ),
        q(
          this.db,
          "INSERT INTO address_routes (address, domain, mailbox_id, kind, created_at) VALUES (?, ?, ?, ?, ?)",
          address,
          d.name,
          input.mailboxId,
          input.kind ?? "alias",
          now,
        ),
        audit(this.db, this.clock, {
          orgId: d.org_id,
          actorId,
          action: "domain.alias.add",
          target: address,
          detail: { mailboxId: input.mailboxId },
        }),
      ]);
    } catch {
      reject("conflict", "address unavailable");
    }
    return { address };
  }

  async removeAlias(domainId: string, actorId: string, address: string): Promise<boolean> {
    const d = await this.get(domainId);
    const a = address.trim().toLowerCase();
    const row = await q(
      primary(this.db),
      "SELECT kind FROM address_routes WHERE address = ? AND domain = ? AND disabled_at IS NULL",
      a,
      d.name,
    ).first<{ kind: string }>();
    if (!row) return false;
    if (row.kind === "primary")
      reject("conflict", "a member's primary address is removed with the member");
    await this.db.batch([
      q(
        this.db,
        "UPDATE address_routes SET disabled_at = ? WHERE address = ?",
        this.clock.now(),
        a,
      ),
      audit(this.db, this.clock, {
        orgId: d.org_id,
        actorId,
        action: "domain.alias.remove",
        target: a,
      }),
    ]);
    return true;
  }

  /**
   * Safe removal: routes are disabled (not deleted), mailboxes and content are untouched, and
   * paid-address reservations remain. Removing a domain is distinct from account deletion.
   */
  async remove(domainId: string, actorId: string): Promise<{ disabledRoutes: number }> {
    const d = await this.get(domainId);
    const now = this.clock.now();
    const count = await q(
      this.db,
      "SELECT COUNT(*) AS n FROM address_routes WHERE domain = ? AND disabled_at IS NULL",
      d.name,
    ).first<{ n: number }>();
    await this.db.batch([
      q(this.db, "UPDATE domains SET state = 'removing', updated_at = ? WHERE id = ?", now, d.id),
      q(
        this.db,
        "UPDATE address_routes SET disabled_at = ? WHERE domain = ? AND disabled_at IS NULL",
        now,
        d.name,
      ),
      q(
        this.db,
        "UPDATE domains SET state = 'removed', catch_all_mailbox_id = NULL, updated_at = ? WHERE id = ?",
        now,
        d.id,
      ),
      audit(this.db, this.clock, {
        orgId: d.org_id,
        actorId,
        action: "domain.remove",
        target: d.id,
        detail: { routes: count?.n ?? 0 },
      }),
    ]);
    return { disabledRoutes: count?.n ?? 0 };
  }
}
