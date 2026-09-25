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
