import { normalizeAddress, timingSafeEqual } from "@bye/domain";
import { type MailboxContext, reject } from "./context.ts";
import { type IdentityRow, toIdentity } from "./rows.ts";
import type { MailboxIdentity } from "./types.ts";

// Sending identities (E19): hosted identities are provisioned by the control plane; external
// send-as addresses prove control with a mailed single-use code.

export const IDENTITY_CHALLENGE_TTL_MS = 24 * 3600_000;

/** Mails a system message (the send-job module); returns undefined when no verified identity can send it. */
export interface SystemMailer {
  createSystemJob(input: {
    readonly to: { readonly name: undefined; readonly address: string };
    readonly subject: string;
    readonly text: string;
    readonly threadId: null;
    readonly headers: Readonly<Record<string, string>>;
    readonly fromAddress: string;
    readonly trafficClass: "transactional";
  }): string | undefined;
}

/** Identity lookups (no side effects); the send-job module depends on these. */
export class IdentityDirectory {
  constructor(protected readonly ctx: MailboxContext) {}

  protected get sql() {
    return this.ctx.sql;
  }

  identity(identityId: string): MailboxIdentity | undefined {
    const r = this.sql.one<IdentityRow>(
      "SELECT * FROM identities WHERE identity_id = ?",
      identityId,
    );
    return r ? toIdentity(r) : undefined;
  }

  identities(): ReadonlyArray<MailboxIdentity> {
    return this.sql
      .all<IdentityRow>("SELECT * FROM identities ORDER BY is_default DESC, address")
      .map(toIdentity);
  }

  byAddress(address: string): MailboxIdentity | undefined {
    const r = this.sql.one<IdentityRow>(
      "SELECT * FROM identities WHERE address = ?",
      normalizeAddress(address),
    );
    return r ? toIdentity(r) : undefined;
  }

  ownAddresses(): ReadonlySet<string> {
    return new Set(
      this.sql
        .all<{ address: string }>(
          "SELECT address FROM identities ORDER BY is_default DESC, address",
        )
        .map((r) => r.address),
    );
  }

  defaultIdentity(): MailboxIdentity | undefined {
    const r = this.sql.one<IdentityRow>(
      "SELECT * FROM identities ORDER BY is_default DESC, address LIMIT 1",
    );
    return r ? toIdentity(r) : undefined;
  }
}

export class MailboxIdentities extends IdentityDirectory {
  constructor(
    ctx: MailboxContext,
    private readonly mailer: SystemMailer,
  ) {
    super(ctx);
  }

  addIdentity(input: {
    readonly address: string;
    readonly name?: string;
    readonly kind: "hosted" | "external";
    readonly signature?: string;
  }): string {
    const address = normalizeAddress(input.address);
    const existing = this.sql.one<{ identity_id: string }>(
      "SELECT identity_id FROM identities WHERE address = ?",
      address,
    );
    if (existing) return existing.identity_id;
    const id = this.ctx.id("idn");
    const first = !this.sql.one("SELECT 1 AS x FROM identities LIMIT 1");
    this.sql.run(
      "INSERT INTO identities (identity_id, address, name, kind, verified, is_default, signature) VALUES (?, ?, ?, ?, ?, ?, ?)",
      id,
      address,
      input.name ?? null,
      input.kind,
      // Hosted identities are provisioned by the control plane; external send-as needs verification.
      input.kind === "hosted",
      first && input.kind === "hosted",
      input.signature ?? "",
    );
    if (input.kind === "external") this.sendChallenge(id, address);
    this.ctx.change("identity", "added", { identityId: id });
    return id;
  }

  /**
   * External send-as proof (E19): a single-use code is mailed to the external address from one of
   * our verified identities over the transactional class; possession of the mailbox proves control.
   */
  private sendChallenge(identityId: string, address: string): void {
    const token = this.ctx.secret(12);
    this.sql.run(
      "UPDATE identities SET challenge_token = ?, challenge_sent_at = ? WHERE identity_id = ?",
      token,
      this.ctx.now(),
      identityId,
    );
    const jobId = this.mailer.createSystemJob({
      to: { name: undefined, address },
      subject: "Confirm you can send from this address",
      text: `Someone asked to send mail as ${address} from their bye mailbox.\n\nIf that was you, enter this code in bye: ${token}\n\nIf not, ignore this message; nothing will be sent as you.`,
      threadId: null,
      headers: { "Auto-Submitted": "auto-generated" },
      fromAddress: this.defaultIdentity()?.address ?? "",
      trafficClass: "transactional",
    });
    if (!jobId)
      reject("conflict", "a verified sending identity is needed to verify an external address");
  }

  resendIdentityChallenge(identityId: string): void {
    const i = this.identity(identityId) ?? reject("not_found", "identity");
    if (i.kind !== "external" || i.verified)
      reject("conflict", "identity does not need verification");
    this.sendChallenge(identityId, i.address);
  }

  verifyIdentity(identityId: string, token: string): { readonly verified: boolean } {
    const r =
      this.sql.one<IdentityRow>("SELECT * FROM identities WHERE identity_id = ?", identityId) ??
      reject("not_found", "identity");
    if (r.verified === 1) return { verified: true };
    const fresh =
      r.challenge_sent_at !== null &&
      this.ctx.now() - Number(r.challenge_sent_at) < IDENTITY_CHALLENGE_TTL_MS;
    if (!r.challenge_token || !fresh || !timingSafeEqual(r.challenge_token, token.trim()))
      return { verified: false };
    this.sql.run(
      "UPDATE identities SET verified = 1, challenge_token = NULL WHERE identity_id = ?",
      identityId,
    );
    this.ctx.change("identity", "verified", { identityId });
    return { verified: true };
  }

  setDefaultIdentity(identityId: string): void {
    const i = this.identity(identityId) ?? reject("not_found", "identity");
    if (!i.verified) reject("forbidden", "identity not verified");
    this.sql.run(
      "UPDATE identities SET is_default = CASE WHEN identity_id = ? THEN 1 ELSE 0 END",
      identityId,
    );
    this.ctx.change("identity", "default", { identityId });
  }
}
