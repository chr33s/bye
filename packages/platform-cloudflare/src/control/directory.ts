import type { DirectoryRoute } from "@bye/application";
import { reject } from "../durable/rpc.ts";
import { domainOf, normalizeAddress, splitPlusAddress } from "@bye/domain";
import type { KernelClock } from "../durable/kernel.ts";
import { changesOf, type D1Like, primary, q } from "./d1.ts";
import { TRIAL_DAYS } from "./commerce.ts";
import { guardD1 } from "./errors.ts";
import { Rejection } from "@bye/contracts";

// Address directory and resource catalog (§3.2, §5.1 step 1, §6, O01).

/** Recipient routing: the application's `DirectoryRoute` is the one definition. */
export type RecipientResolution = DirectoryRoute;

export type CatalogKind = "mailbox" | "calendar" | "space" | "search" | "ingress" | "world";

export const CATALOG_SHARDS = 64;

/** Stable shard for an authority ID so Cron partitions are deterministic. */
export const catalogShard = (id: string, shards = CATALOG_SHARDS): number => {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return (h >>> 0) % shards;
};

/**
 * Local parts the service itself sends from or must keep for operators (RFC 2142 role addresses,
 * World publishing, system notices). Never assignable to a user on the service domain.
 */
export const RESERVED_LOCAL_PARTS: ReadonlySet<string> = new Set([
  "world",
  "no-reply",
  "noreply",
  "do-not-reply",
  "donotreply",
  "postmaster",
  "abuse",
  "hostmaster",
  "webmaster",
  "mailer-daemon",
  "bounce",
  "bounces",
  "security",
  "admin",
  "administrator",
  "root",
  "support",
  "billing",
  "help",
  "info",
  "sales",
  "privacy",
  "legal",
  "api",
  "app",
  "www",
  "mail",
  "smtp",
  "dmarc",
  "dkim",
]);

/** Syntax for assignable local parts: 1–64 chars of [a-z0-9._-], alphanumeric at both ends, no `..`, no `+` (plus tags). */
export const validLocalPart = (local: string): boolean =>
  /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/.test(local) && !local.includes("..");

/** Validate an address a user may claim on the service domain; fails with `bad_request`/`forbidden`. */
export const assertAssignableServiceAddress = (address: string): void => {
  const at = address.lastIndexOf("@");
  const local = at > 0 ? address.slice(0, at) : "";
  if (!validLocalPart(local)) reject("bad_request", "invalid address");
  if (RESERVED_LOCAL_PARTS.has(local)) reject("forbidden", "address reserved");
};

export interface ProvisionedAccount {
  readonly userId: string;
  readonly organizationId: string;
  readonly mailboxId: string;
  readonly calendarId: string;
  readonly address: string;
}

export class ControlDirectory {
  constructor(
    readonly db: D1Like,
    readonly clock: KernelClock,
  ) {}

  catalogInsert(kind: CatalogKind, id: string) {
    return q(
      this.db,
      "INSERT INTO resource_catalog (kind, id, shard, provisioned_at) VALUES (?, ?, ?, ?) ON CONFLICT (kind, id) DO NOTHING",
      kind,
      id,
      catalogShard(id),
      this.clock.now(),
    );
  }

  /**
   * Provision a personal account atomically. Catalog entries are written in the same batch as,
   * and before, the address route that exposes the mailbox to traffic (§6).
   */
  async provisionPersonalAccount(input: {
    address: string;
    displayName: string;
  }): Promise<ProvisionedAccount> {
    const address = normalizeAddress(input.address);
    assertAssignableServiceAddress(address);
    // Any reservation row blocks reassignment, expired or not: `reserved_until` ends the holder's
    // entitlement, but the spec forbids silently recycling addresses (A04/§11), so an expired hold
    // never frees the address for someone else.
    const reserved = await guardD1("reservation", () =>
      q(
        primary(this.db),
        "SELECT 1 AS r FROM address_reservations WHERE address = ?",
        address,
      ).first(),
    );
    if (reserved) reject("conflict", "address unavailable");
    // Personal signup never claims an address on a customer (tenant) domain; those addresses are
    // provisioned by that organization's administrators (O01/O02).
    const tenantDomain = await guardD1("tenant-domain", () =>
      q(primary(this.db), "SELECT 1 AS t FROM domains WHERE name = ?", domainOf(address)).first(),
    );
    if (tenantDomain) reject("forbidden", "address belongs to a customer domain");
    const now = this.clock.now();
    const ids = {
      userId: this.clock.id("usr"),
      organizationId: this.clock.id("org"),
      mailboxId: this.clock.id("mbx"),
      calendarId: this.clock.id("cal"),
    };
    try {
      await this.db.batch([
        q(
          this.db,
          "INSERT INTO users (id, primary_address, display_name, created_at) VALUES (?, ?, ?, ?)",
          ids.userId,
          address,
          input.displayName,
          now,
        ),
        q(
          this.db,
          "INSERT INTO organizations (id, name, kind, seat_limit, created_at) VALUES (?, ?, 'personal', 1, ?)",
          ids.organizationId,
          input.displayName,
          now,
        ),
        q(
          this.db,
          "INSERT INTO memberships (org_id, user_id, role, status, created_at, updated_at) VALUES (?, ?, 'owner', 'active', ?, ?)",
          ids.organizationId,
          ids.userId,
          now,
          now,
        ),
        q(
          this.db,
          "INSERT INTO mailboxes (id, org_id, owner_user_id, kind, created_at) VALUES (?, ?, ?, 'personal', ?)",
          ids.mailboxId,
          ids.organizationId,
          ids.userId,
          now,
        ),
        q(
          this.db,
          "INSERT INTO mailbox_access (mailbox_id, user_id, role, can_send, created_at) VALUES (?, ?, 'owner', 1, ?)",
          ids.mailboxId,
          ids.userId,
          now,
        ),
        q(
          this.db,
          "INSERT INTO calendars (id, owner_user_id, created_at) VALUES (?, ?, ?)",
          ids.calendarId,
          ids.userId,
          now,
        ),
        this.catalogInsert("mailbox", ids.mailboxId),
        this.catalogInsert("calendar", ids.calendarId),
        // New personal accounts start a trial; paid state arrives only via signed webhooks (A02).
        q(
          this.db,
          "INSERT INTO entitlements (org_id, plan, interval, status, seats, trial_ends_at, updated_at) VALUES (?, 'personal', 'annual', 'trialing', 1, ?, ?)",
          ids.organizationId,
          now + TRIAL_DAYS * 86_400_000,
          now,
        ),
        q(
          this.db,
          "INSERT INTO address_routes (address, domain, mailbox_id, kind, created_at) VALUES (?, ?, ?, 'primary', ?)",
          address,
          domainOf(address),
          ids.mailboxId,
          now,
        ),
      ]);
    } catch (e) {
      if (String(e).includes("UNIQUE")) return reject("conflict", "address unavailable");
      return reject("unavailable", "provisioning failed");
    }
    return { ...ids, address };
  }

  /**
   * Release accounts whose signup never finished (A03): signup claims the address before a passkey
   * exists, and the passkey step can only be retried with a short-lived signup token, so an
   * account created before `olderThan` with no credential of any kind can never be used. Its
   * address route is dropped and the account closed with its `primary_address` rewritten (the
   * column is UNIQUE), so the address can be claimed again. Excluded: the instance bootstrap
   * operator and a paid short address. Bounded to `limit` accounts per call; returns the count.
   */
  async releaseAbandonedSignups(olderThan: number, limit = 50): Promise<number> {
    const abandoned = `u.status = 'active' AND u.created_at < ?
      AND NOT EXISTS (SELECT 1 FROM passkeys p WHERE p.user_id = u.id)
      AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.user_id = u.id)
      AND NOT EXISTS (SELECT 1 FROM api_tokens t WHERE t.user_id = u.id)
      AND NOT EXISTS (SELECT 1 FROM device_sessions d WHERE d.user_id = u.id)
      AND NOT EXISTS (SELECT 1 FROM instance_bootstrap b WHERE b.user_id = u.id)
      AND NOT EXISTS (SELECT 1 FROM memberships m JOIN entitlements e ON e.org_id = m.org_id WHERE m.user_id = u.id AND e.short_address = 1)`;
    const candidates = (
      await q(
        primary(this.db),
        `SELECT u.id FROM users u WHERE ${abandoned} ORDER BY u.created_at LIMIT ?`,
        olderThan,
        limit,
      ).all<{ id: string }>()
    ).results;
    let released = 0;
    for (const { id } of candidates) {
      const now = this.clock.now();
      // Conditions re-checked inside the write (a passkey may land between read and write);
      // every follow-on change is keyed to this closure having happened in this batch.
      const closed =
        "EXISTS (SELECT 1 FROM users WHERE id = ? AND status = 'closed' AND closed_at = ?)";
      const results = await this.db.batch([
        q(
          this.db,
          `UPDATE users SET status = 'closed', closed_at = ?, primary_address = 'released:' || id || ':' || primary_address
           WHERE id = ? AND id IN (SELECT u.id FROM users u WHERE ${abandoned})`,
          now,
          id,
          olderThan,
        ),
        q(
          this.db,
          `DELETE FROM address_routes WHERE mailbox_id IN (SELECT id FROM mailboxes WHERE owner_user_id = ? AND kind = 'personal') AND ${closed}`,
          id,
          id,
          now,
        ),
        q(
          this.db,
          `UPDATE mailboxes SET status = 'closed' WHERE owner_user_id = ? AND kind = 'personal' AND ${closed}`,
          id,
          id,
          now,
        ),
        q(
          this.db,
          `INSERT INTO audit_log (id, org_id, actor_id, action, target, detail, created_at) SELECT ?, NULL, 'system', 'signup.released', ?, '{}', ? WHERE ${closed}`,
          this.clock.id("aud"),
          id,
          now,
          id,
          now,
        ),
      ]);
      if (changesOf(results[0]) > 0) released++;
    }
    return released;
  }

  /**
   * Resolve an envelope recipient: exact alias → plus-address fallback → tenant catch-all.
   * Unknown → Rejected. Directory errors → TransientFailure (§5.1).
   */
  async resolveRecipient(recipient: string): Promise<RecipientResolution> {
    try {
      return await this.resolveUnsafe(recipient);
    } catch (e) {
      if (e instanceof Rejection && e.code !== "unavailable") throw e;
      return { _tag: "TransientFailure", detail: "directory unavailable" };
    }
  }

  private async resolveUnsafe(recipient: string): Promise<RecipientResolution> {
    const db = primary(this.db);
    const address = normalizeAddress(recipient);
    const route = (a: string) =>
      q(
        db,
        "SELECT r.mailbox_id, m.status FROM address_routes r JOIN mailboxes m ON m.id = r.mailbox_id WHERE r.address = ? AND r.disabled_at IS NULL",
        a,
      ).first<{ mailbox_id: string; status: string }>();
    const deliverable = (r: { mailbox_id: string; status: string } | null) =>
      r !== null && r.status !== "closed";

    const exact = await route(address);
    if (deliverable(exact))
      return { _tag: "Deliver", mailboxId: exact!.mailbox_id, via: "exact", plusTag: undefined };

    const domainName = domainOf(address);
    const domain = await q(
      db,
      "SELECT state, plus_addressing, catch_all_mailbox_id FROM domains WHERE name = ?",
      domainName,
    ).first<{ state: string; plus_addressing: number; catch_all_mailbox_id: string | null }>();
    // Service-owned domains (no domains row) always allow plus-addressing.
    const plusAllowed = domain === null || domain.plus_addressing === 1;
    const { base, tag } = splitPlusAddress(address);
    if (tag !== undefined && plusAllowed) {
      const baseRoute = await route(base);
      if (deliverable(baseRoute))
        return { _tag: "Deliver", mailboxId: baseRoute!.mailbox_id, via: "plus", plusTag: tag };
    }

    const reservation = await q(
      db,
      "SELECT forwarding_to, forwarding_verified_at, forwarding_until FROM address_reservations WHERE address = ?",
      address,
    ).first<{
      forwarding_to: string | null;
      forwarding_verified_at: number | null;
      forwarding_until: number | null;
    }>();
    if (reservation) {
      const now = this.clock.now();
      if (
        reservation.forwarding_to &&
        reservation.forwarding_verified_at !== null &&
        (reservation.forwarding_until === null || reservation.forwarding_until > now)
      ) {
        return { _tag: "Forward", to: reservation.forwarding_to, reason: "closure-forwarding" };
      }
      return { _tag: "Rejected", reason: "closed" };
    }

    if (domain !== null) {
      if (domain.state !== "active") return { _tag: "Rejected", reason: "domain-inactive" };
      if (domain.catch_all_mailbox_id) {
        const m = await q(
          db,
          "SELECT status FROM mailboxes WHERE id = ?",
          domain.catch_all_mailbox_id,
        ).first<{ status: string }>();
        if (m && m.status !== "closed")
          return {
            _tag: "Deliver",
            mailboxId: domain.catch_all_mailbox_id,
            via: "catch-all",
            plusTag: undefined,
          };
      }
    }
    return { _tag: "Rejected", reason: "unknown-recipient" };
  }

  /**
   * Sending authorization: active user, active membership, can_send access, and the From address
   * routes exactly to the mailbox. A catch-all never grants authority for arbitrary local parts.
   */
  async canSendAs(userId: string, mailboxId: string, from: string): Promise<boolean> {
    const db = primary(this.db);
    const row = await guardD1("canSendAs", () =>
      q(
        db,
        `SELECT 1 AS ok FROM mailbox_access a
         JOIN mailboxes m ON m.id = a.mailbox_id
         JOIN memberships ms ON ms.org_id = m.org_id AND ms.user_id = a.user_id
         JOIN users u ON u.id = a.user_id
         JOIN address_routes r ON r.mailbox_id = m.id AND r.address = ? AND r.disabled_at IS NULL
         WHERE a.user_id = ? AND a.mailbox_id = ? AND a.can_send = 1 AND m.status = 'active' AND ms.status = 'active' AND u.status = 'active'`,
        normalizeAddress(from),
        userId,
        mailboxId,
      ).first<{ ok: number }>(),
    );
    return row !== null;
  }

  /**
   * Dispatch-time check (§5.2): the From address still routes to this active mailbox and at least
   * one active member with send rights remains. Works for personal and extension mailboxes.
   */
  async mailboxMaySendAs(mailboxId: string, from: string): Promise<boolean> {
    const row = await guardD1("mailboxMaySendAs", () =>
      q(
        primary(this.db),
        `SELECT 1 AS ok FROM address_routes r
         JOIN mailboxes m ON m.id = r.mailbox_id
         JOIN mailbox_access a ON a.mailbox_id = m.id AND a.can_send = 1
         JOIN memberships ms ON ms.org_id = m.org_id AND ms.user_id = a.user_id
         JOIN users u ON u.id = a.user_id
         WHERE r.address = ? AND r.mailbox_id = ? AND r.disabled_at IS NULL AND m.status = 'active' AND ms.status = 'active' AND u.status = 'active'
         LIMIT 1`,
        normalizeAddress(from),
        mailboxId,
      ).first<{ ok: number }>(),
    );
    return row !== null;
  }

  /** Current account + membership + resource check for interactive access (§3.2). */
  async canAccessMailbox(userId: string, mailboxId: string): Promise<boolean> {
    const row = await guardD1("canAccessMailbox", () =>
      q(
        primary(this.db),
        `SELECT 1 AS ok FROM mailbox_access a
         JOIN mailboxes m ON m.id = a.mailbox_id
         JOIN memberships ms ON ms.org_id = m.org_id AND ms.user_id = a.user_id
         JOIN users u ON u.id = a.user_id
         WHERE a.user_id = ? AND a.mailbox_id = ? AND m.status = 'active' AND ms.status = 'active' AND u.status = 'active'`,
        userId,
        mailboxId,
      ).first<{ ok: number }>(),
    );
    return row !== null;
  }

  async addAlias(mailboxId: string, address: string): Promise<void> {
    const normalized = normalizeAddress(address);
    const domain = domainOf(normalized);
    const d = await guardD1("alias", () =>
      q(primary(this.db), "SELECT state FROM domains WHERE name = ?", domain).first<{
        state: string;
      }>(),
    );
    if (d !== null && d.state !== "active") reject("conflict", "domain not active");
    // Service-domain aliases obey the same rules as signup; tenant domains are the org's own.
    if (d === null) assertAssignableServiceAddress(normalized);
    const reserved = await q(
      this.db,
      "SELECT 1 AS r FROM address_reservations WHERE address = ?",
      normalized,
    ).first();
    if (reserved) reject("conflict", "address reserved");
    try {
      await q(
        this.db,
        "INSERT INTO address_routes (address, domain, mailbox_id, kind, created_at) VALUES (?, ?, ?, 'alias', ?)",
        normalized,
        domain,
        mailboxId,
        this.clock.now(),
      ).run();
    } catch {
      reject("conflict", "address unavailable");
    }
  }

  async listCatalog(
    kind: CatalogKind,
    shard: number,
    after: string,
    limit: number,
  ): Promise<ReadonlyArray<{ id: string; nextWakeHint: number | null }>> {
    const rows = await guardD1("catalog", () =>
      q(
        this.db,
        "SELECT id, next_wake_hint FROM resource_catalog WHERE shard = ? AND kind = ? AND status = 'active' AND id > ? ORDER BY id LIMIT ?",
        shard,
        kind,
        after,
        limit,
      ).all<{ id: string; next_wake_hint: number | null }>(),
    );
    return rows.results.map((r) => ({ id: r.id, nextWakeHint: r.next_wake_hint }));
  }

  /** Best-effort scheduling hint; the reconciler never depends on it being current. */
  async setWakeHint(kind: CatalogKind, id: string, at: number | null): Promise<void> {
    await q(
      this.db,
      "UPDATE resource_catalog SET next_wake_hint = ? WHERE kind = ? AND id = ?",
      at,
      kind,
      id,
    ).run();
  }
}
