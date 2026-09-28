import { normalizeAddress } from "@bye/domain";
import type { KernelClock } from "../durable/kernel.ts";
import { randomToken, sha256Hex } from "./crypto.ts";
import {
  audit,
  auditIfChanged,
  changesOf,
  type D1Like,
  type D1StatementLike,
  primary,
  q,
} from "./d1.ts";
import { catalogShard } from "./directory.ts";
import { TRIAL_DAYS } from "./commerce.ts";
import { reject } from "@bye/contracts";
import { guardD1 } from "./errors.ts";

// Team administration (O02) and account types (A01). Every change writes an audit entry in the
// same atomic batch. Callers enforce step-up before invoking administrative mutations.

export type OrgRole = "owner" | "admin" | "member";

/** A verified organization administrator (see `verifiedActor`); mutations take this, not an ID. */
export interface OrgActor {
  readonly userId: string;
  readonly role: "owner" | "admin";
}

export type OrgKind = "personal" | "domain" | "family";

export type ReassignmentPolicy = "retain" | "reassign-to-admin" | "forward-then-close";

export interface OrgMemberView {
  readonly userId: string;
  readonly address: string;
  readonly role: OrgRole;
  readonly status: "active" | "suspended" | "removed";
}

type SeatUsage = { limit: number; used: number; entitled: number | null };

/** Every seat under both the admin's limit and the purchased entitlement is taken. */
const seatsFull = (seats: SeatUsage): boolean =>
  seats.used >= Math.min(seats.limit, seats.entitled ?? seats.limit);

/** SQL twin of `!seatsFull` for org `?` (bind the org id 4 times), evaluated inside the write. */
const SEAT_AVAILABLE_SQL = `(SELECT COUNT(*) FROM memberships WHERE org_id = ? AND status IN ('active', 'suspended'))
  < MIN((SELECT seat_limit FROM organizations WHERE id = ?), COALESCE((SELECT seats FROM entitlements WHERE org_id = ?), (SELECT seat_limit FROM organizations WHERE id = ?)))`;

/** Outstanding invitations an org may hold at once (each one mailed a third party). */
export const MAX_PENDING_INVITATIONS = 50;

/** Invitations of org `?` still acceptable at time `?` (bind org id, then now). */
const PENDING_INVITATION_SQL =
  "org_id = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?";

/** The member row is not the org's last active owner (bind the org id once). */
const NOT_LAST_ACTIVE_OWNER_SQL = `NOT (role = 'owner' AND status = 'active' AND (SELECT COUNT(*) FROM memberships WHERE org_id = ? AND role = 'owner' AND status = 'active') <= 1)`;

/** True when org `?` has more than one active owner (bind the org id once). */
const OTHER_ACTIVE_OWNER_SQL =
  "(SELECT COUNT(*) FROM memberships WHERE org_id = ? AND role = 'owner' AND status = 'active') > 1";

export class ControlOrganizations {
  constructor(
    readonly db: D1Like,
    readonly clock: KernelClock,
  ) {}

  async membership(
    orgId: string,
    userId: string,
  ): Promise<{ role: OrgRole; status: string } | null> {
    return guardD1("membership", () =>
      q(
        primary(this.db),
        "SELECT role, status FROM memberships WHERE org_id = ? AND user_id = ?",
        orgId,
        userId,
      ).first<{ role: OrgRole; status: string }>(),
    );
  }

  /**
   * Verify an administrator and return the actor the mutations below take. The mutations trust
   * this (the application's `requireOrgAdminAccess` is the one place requests verify it), so a
   * role is read once per action, never re-read inside the adapter.
   */
  async verifiedActor(orgId: string, userId: string): Promise<OrgActor> {
    const m = await this.membership(orgId, userId);

    if (!m || m.status !== "active" || m.role === "member")
      return reject("forbidden", "administrator role required");

    return { userId, role: m.role };
  }

  async createOrganization(
    ownerId: string,
    input: {
      name: string;
      kind: Exclude<OrgKind, "personal">;
      seatLimit: number;
      reassignmentPolicy?: ReassignmentPolicy;
    },
  ): Promise<string> {
    const id = this.clock.id("org");
    const now = this.clock.now();
    await this.db.batch([
      q(
        this.db,
        "INSERT INTO organizations (id, name, kind, seat_limit, reassignment_policy, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        id,
        input.name,
        input.kind,
        input.seatLimit,
        input.reassignmentPolicy ?? "retain",
        now,
      ),
      q(
        this.db,
        "INSERT INTO memberships (org_id, user_id, role, status, created_at, updated_at) VALUES (?, ?, 'owner', 'active', ?, ?)",
        id,
        ownerId,
        now,
        now,
      ),
      // Paid org types start a trial; activation arrives only via signed billing webhooks (A01/A02).
      q(
        this.db,
        "INSERT INTO entitlements (org_id, plan, interval, status, seats, trial_ends_at, updated_at) VALUES (?, ?, 'annual', 'trialing', ?, ?, ?)",
        id,
        input.kind,
        input.seatLimit,
        now + TRIAL_DAYS * 86_400_000,
        now,
      ),
      audit(this.db, this.clock, {
        orgId: id,
        actorId: ownerId,
        action: "org.create",
        target: id,
        detail: { kind: input.kind },
      }),
    ]);

    return id;
  }

  async seats(orgId: string): Promise<SeatUsage> {
    const db = primary(this.db);

    const [org, used, ent] = await Promise.all([
      q(db, "SELECT seat_limit FROM organizations WHERE id = ?", orgId).first<{
        seat_limit: number;
      }>(),
      q(
        db,
        "SELECT COUNT(*) AS n FROM memberships WHERE org_id = ? AND status IN ('active', 'suspended')",
        orgId,
      ).first<{ n: number }>(),
      q(db, "SELECT seats FROM entitlements WHERE org_id = ?", orgId).first<{ seats: number }>(),
    ]);

    if (!org) return reject("not_found", "organization");

    return { limit: org.seat_limit, used: used?.n ?? 0, entitled: ent?.seats ?? null };
  }

  /** Seat limit set by an administrator, bounded by the entitlement and never below current use. */
  async setSeatLimit(orgId: string, actor: OrgActor, limit: number): Promise<SeatUsage> {
    const actorId = actor.userId;

    if (!Number.isInteger(limit) || limit < 1 || limit > 10_000)
      reject("bad_request", "invalid seat limit");
    const seats = await this.seats(orgId);

    if (limit < seats.used) reject("conflict", "seat limit below seats in use");

    if (seats.entitled !== null && limit > seats.entitled)
      reject("conflict", "seat limit exceeds purchased seats");

    // Re-checked in SQL: a member joining (or a seat downgrade) between the read and the write
    // must not leave the limit below use or above the purchased seats.
    const results = await this.db.batch([
      q(
        this.db,
        `UPDATE organizations SET seat_limit = ? WHERE id = ?
           AND ? >= (SELECT COUNT(*) FROM memberships WHERE org_id = ? AND status IN ('active', 'suspended'))
           AND ? <= COALESCE((SELECT seats FROM entitlements WHERE org_id = ?), ?)`,
        limit,
        orgId,
        limit,
        orgId,
        limit,
        orgId,
        limit,
      ),
      auditIfChanged(this.db, this.clock, {
        orgId,
        actorId,
        action: "org.seats",
        target: orgId,
        detail: { from: seats.limit, to: limit },
      }),
    ]);

    if (changesOf(results[0]) === 0) reject("conflict", "seat limit conflicts with seats in use");

    return this.seats(orgId);
  }

  async organization(
    orgId: string,
    actorId: string,
  ): Promise<{
    id: string;
    name: string;
    kind: OrgKind;
    seatLimit: number;
    reassignmentPolicy: ReassignmentPolicy;
    role: OrgRole;
  }> {
    const m = await this.membership(orgId, actorId);

    if (!m || m.status !== "active") return reject("forbidden", "not a member");

    const o = await q(
      primary(this.db),
      "SELECT id, name, kind, seat_limit, reassignment_policy FROM organizations WHERE id = ?",
      orgId,
    ).first<{
      id: string;
      name: string;
      kind: OrgKind;
      seat_limit: number;
      reassignment_policy: ReassignmentPolicy;
    }>();

    if (!o) return reject("not_found", "organization");

    return {
      id: o.id,
      name: o.name,
      kind: o.kind,
      seatLimit: o.seat_limit,
      reassignmentPolicy: o.reassignment_policy,
      role: m.role,
    };
  }

  async invite(
    orgId: string,
    actor: OrgActor,
    address: string,
    role: Exclude<OrgRole, "owner">,
  ): Promise<{ invitationId: string; token: string }> {
    const actorId = actor.userId;

    if (seatsFull(await this.seats(orgId))) reject("conflict", "no seats available");
    const normalized = normalizeAddress(address);
    const now = this.clock.now();

    // Every invitation mails a third party from the service domain: one outstanding invitation
    // per (org, address), and a bounded number outstanding per org, so the route cannot be used
    // to send repeated or bulk unsolicited mail.
    const pending = await q(
      primary(this.db),
      `SELECT COUNT(*) AS n, COALESCE(SUM(address = ?), 0) AS same FROM invitations WHERE ${PENDING_INVITATION_SQL}`,
      normalized,
      orgId,
      now,
    ).first<{ n: number; same: number }>();

    if ((pending?.same ?? 0) > 0) reject("conflict", "an invitation to this address is pending");

    if ((pending?.n ?? 0) >= MAX_PENDING_INVITATIONS)
      reject("conflict", "too many pending invitations");
    const token = randomToken();
    const id = this.clock.id("inv");

    // Guarded insert: two racing invites cannot both pass the checks above.
    const [inserted] = await this.db.batch([
      q(
        this.db,
        `INSERT INTO invitations (id, org_id, address, role, token_hash, invited_by, expires_at)
         SELECT ?, ?, ?, ?, ?, ?, ?
         WHERE NOT EXISTS (SELECT 1 FROM invitations WHERE ${PENDING_INVITATION_SQL} AND address = ?)
           AND (SELECT COUNT(*) FROM invitations WHERE ${PENDING_INVITATION_SQL}) < ?`,
        id,
        orgId,
        normalized,
        role,
        await sha256Hex(token),
        actorId,
        now + 7 * 86400_000,
        orgId,
        now,
        normalized,
        orgId,
        now,
        MAX_PENDING_INVITATIONS,
      ),
      auditIfChanged(this.db, this.clock, {
        orgId,
        actorId,
        action: "member.invite",
        target: id,
        detail: { role },
      }),
    ]);

    if (changesOf(inserted) === 0) reject("conflict", "an invitation to this address is pending");

    return { invitationId: id, token };
  }

  async acceptInvitation(token: string, userId: string): Promise<{ orgId: string; role: OrgRole }> {
    const inv = await guardD1("invite", async () =>
      q(
        primary(this.db),
        "SELECT id, org_id, address, role, expires_at, accepted_at, revoked_at FROM invitations WHERE token_hash = ?",
        await sha256Hex(token),
      ).first<{
        id: string;
        org_id: string;
        address: string;
        role: OrgRole;
        expires_at: number;
        accepted_at: number | null;
        revoked_at: number | null;
      }>(),
    );

    if (
      !inv ||
      inv.accepted_at !== null ||
      inv.revoked_at !== null ||
      inv.expires_at < this.clock.now()
    )
      return reject("not_found", "invitation");

    const user = await q(this.db, "SELECT primary_address FROM users WHERE id = ?", userId).first<{
      primary_address: string;
    }>();

    if (!user || user.primary_address !== inv.address)
      reject("forbidden", "invitation addressed to another account");
    const existing = await this.membership(inv.org_id, userId);

    // An invitation never reactivates a suspended member (that is `reactivate`, by an admin) and
    // never changes an existing member's role.
    if (existing?.status === "suspended") reject("forbidden", "membership suspended");

    if (existing?.status === "active") reject("conflict", "already a member");

    if (seatsFull(await this.seats(inv.org_id))) reject("conflict", "no seats available");
    const now = this.clock.now();

    // The join is conditional in SQL on the invitation still being open, a seat being free, and
    // any existing membership being `removed`; the invitation is consumed only if the join landed.
    const results = await this.db.batch([
      q(
        this.db,
        `INSERT INTO memberships (org_id, user_id, role, status, created_at, updated_at)
         SELECT ?, ?, ?, 'active', ?, ?
         WHERE EXISTS (SELECT 1 FROM invitations WHERE id = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at >= ?)
           AND ${SEAT_AVAILABLE_SQL}
         ON CONFLICT (org_id, user_id) DO UPDATE SET role = excluded.role, status = 'active', updated_at = excluded.updated_at
           WHERE memberships.status = 'removed'`,
        inv.org_id,
        userId,
        inv.role,
        now,
        now,
        inv.id,
        now,
        inv.org_id,
        inv.org_id,
        inv.org_id,
        inv.org_id,
      ),
      q(
        this.db,
        "UPDATE invitations SET accepted_at = ? WHERE id = ? AND accepted_at IS NULL AND changes() > 0",
        now,
        inv.id,
      ),
      auditIfChanged(this.db, this.clock, {
        orgId: inv.org_id,
        actorId: userId,
        action: "member.join",
        target: userId,
        detail: { role: inv.role },
      }),
    ]);

    if (changesOf(results[0]) === 0) reject("conflict", "invitation could not be accepted");

    return { orgId: inv.org_id, role: inv.role };
  }

  private async activeOwners(orgId: string): Promise<number> {
    return (
      (
        await q(
          primary(this.db),
          "SELECT COUNT(*) AS n FROM memberships WHERE org_id = ? AND role = 'owner' AND status = 'active'",
          orgId,
        ).first<{ n: number }>()
      )?.n ?? 0
    );
  }

  private async target(orgId: string, actor: OrgActor, userId: string) {
    const target = await this.membership(orgId, userId);

    if (!target || target.status === "removed") return reject("not_found", "member");

    if (target.role === "owner" && actor.role !== "owner")
      reject("forbidden", "only owners manage owners");

    if (
      target.role === "owner" &&
      target.status === "active" &&
      (await this.activeOwners(orgId)) <= 1
    )
      reject("conflict", "cannot remove or suspend the last owner");

    return target;
  }

  async setRole(orgId: string, actor: OrgActor, userId: string, role: OrgRole): Promise<void> {
    const { userId: actorId, role: actorRole } = actor;
    const target = await this.membership(orgId, userId);

    if (!target || target.status === "removed") return reject("not_found", "member");

    if ((role === "owner" || target.role === "owner") && actorRole !== "owner")
      reject("forbidden", "only owners manage owners");

    if (target.role === "owner" && role !== "owner" && (await this.activeOwners(orgId)) <= 1)
      reject("conflict", "cannot demote the last owner");

    // The last-owner rule is re-checked inside the write: two concurrent demotions of the only
    // two owners cannot both land.
    const results = await this.db.batch([
      q(
        this.db,
        `UPDATE memberships SET role = ?, updated_at = ? WHERE org_id = ? AND user_id = ? AND status != 'removed'
           AND NOT (role = 'owner' AND ? != 'owner' AND NOT ${OTHER_ACTIVE_OWNER_SQL})`,
        role,
        this.clock.now(),
        orgId,
        userId,
        role,
        orgId,
      ),
      auditIfChanged(this.db, this.clock, {
        orgId,
        actorId,
        action: "member.role",
        target: userId,
        detail: { from: target.role, to: role },
      }),
    ]);

    if (changesOf(results[0]) === 0) reject("conflict", "cannot demote the last owner");
  }

  /**
   * Suspension immediately disables sending and interactive access: principal construction,
   * canSendAs and canAccessMailbox all require an active membership. Inbound mail keeps flowing
   * under the org's retention policy.
   */
  async suspend(orgId: string, actor: OrgActor, userId: string): Promise<void> {
    await this.target(orgId, actor, userId);
    const actorId = actor.userId;
    const now = this.clock.now();

    const results = await this.db.batch([
      q(
        this.db,
        `UPDATE memberships SET status = 'suspended', updated_at = ? WHERE org_id = ? AND user_id = ? AND status != 'removed'
           AND ${NOT_LAST_ACTIVE_OWNER_SQL}`,
        now,
        orgId,
        userId,
        orgId,
      ),
      auditIfChanged(this.db, this.clock, {
        orgId,
        actorId,
        action: "member.suspend",
        target: userId,
      }),
    ]);

    if (changesOf(results[0]) === 0) reject("conflict", "cannot remove or suspend the last owner");
  }

  async reactivate(orgId: string, actor: OrgActor, userId: string): Promise<void> {
    const target = await this.membership(orgId, userId);

    if (!target || target.status !== "suspended") return reject("not_found", "suspended member");

    if (target.role === "owner" && actor.role !== "owner")
      reject("forbidden", "only owners manage owners");
    const actorId = actor.userId;
    await this.db.batch([
      q(
        this.db,
        "UPDATE memberships SET status = 'active', updated_at = ? WHERE org_id = ? AND user_id = ? AND status = 'suspended'",
        this.clock.now(),
        orgId,
        userId,
      ),
      audit(this.db, this.clock, { orgId, actorId, action: "member.reactivate", target: userId }),
    ]);
  }

  /** Remove a member, applying the organization's mailbox reassignment policy to their org mailboxes. */
  async remove(
    orgId: string,
    actor: OrgActor,
    userId: string,
  ): Promise<{ policy: ReassignmentPolicy; mailboxes: ReadonlyArray<string> }> {
    await this.target(orgId, actor, userId);
    const actorId = actor.userId;

    const org = await q(
      primary(this.db),
      "SELECT reassignment_policy FROM organizations WHERE id = ?",
      orgId,
    ).first<{ reassignment_policy: ReassignmentPolicy }>();

    const policy = org?.reassignment_policy ?? "retain";

    const owned = (
      await q(
        this.db,
        "SELECT id FROM mailboxes WHERE org_id = ? AND owner_user_id = ? AND kind = 'personal'",
        orgId,
        userId,
      ).all<{ id: string }>()
    ).results.map((r) => r.id);

    const now = this.clock.now();

    // The removal is conditional on the last-owner rule inside the write; every follow-on change
    // is keyed to that removal having landed in this batch (the member row now `removed` at `now`).
    const removed =
      "EXISTS (SELECT 1 FROM memberships WHERE org_id = ? AND user_id = ? AND status = 'removed' AND updated_at = ?)";

    const removedArgs = [orgId, userId, now];

    const statements: Array<D1StatementLike> = [
      q(
        this.db,
        `UPDATE memberships SET status = 'removed', updated_at = ? WHERE org_id = ? AND user_id = ? AND status != 'removed'
           AND ${NOT_LAST_ACTIVE_OWNER_SQL}`,
        now,
        orgId,
        userId,
        orgId,
      ),
      q(
        this.db,
        `DELETE FROM mailbox_access WHERE user_id = ? AND mailbox_id IN (SELECT id FROM mailboxes WHERE org_id = ?) AND role = 'member' AND ${removed}`,
        userId,
        orgId,
        ...removedArgs,
      ),
    ];

    for (const mailboxId of owned) {
      statements.push(
        q(
          this.db,
          `DELETE FROM mailbox_access WHERE mailbox_id = ? AND user_id = ? AND ${removed}`,
          mailboxId,
          userId,
          ...removedArgs,
        ),
      );

      if (policy === "reassign-to-admin") {
        statements.push(
          q(
            this.db,
            `UPDATE mailboxes SET owner_user_id = ? WHERE id = ? AND ${removed}`,
            actorId,
            mailboxId,
            ...removedArgs,
          ),
          q(
            this.db,
            `INSERT INTO mailbox_access (mailbox_id, user_id, role, can_send, created_at) SELECT ?, ?, 'owner', 1, ? WHERE ${removed} ON CONFLICT DO NOTHING`,
            mailboxId,
            actorId,
            now,
            ...removedArgs,
          ),
        );
      } else {
        statements.push(
          q(
            this.db,
            `UPDATE mailboxes SET status = ? WHERE id = ? AND ${removed}`,
            policy === "forward-then-close" ? "closed" : "suspended",
            mailboxId,
            ...removedArgs,
          ),
        );
      }
    }

    statements.push(
      q(
        this.db,
        `INSERT INTO audit_log (id, org_id, actor_id, action, target, detail, created_at) SELECT ?, ?, ?, 'member.remove', ?, ?, ? WHERE ${removed}`,
        this.clock.id("aud"),
        orgId,
        actorId,
        userId,
        JSON.stringify({ policy, mailboxes: owned }),
        now,
        ...removedArgs,
      ),
    );
    const results = await this.db.batch(statements);

    if (changesOf(results[0]) === 0) reject("conflict", "cannot remove or suspend the last owner");

    return { policy, mailboxes: owned };
  }

  async members(orgId: string, actorId: string): Promise<ReadonlyArray<OrgMemberView>> {
    const m = await this.membership(orgId, actorId);

    if (!m || m.status !== "active") return reject("forbidden", "not a member");

    return (
      await q(
        this.db,
        "SELECT m.user_id AS userId, u.primary_address AS address, m.role, m.status FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = ? AND m.status != 'removed' ORDER BY u.primary_address",
        orgId,
      ).all<OrgMemberView>()
    ).results;
  }

  /** Organization audit log; the caller has verified an administrator (`verifiedActor`). */
  async auditLog(
    orgId: string,
    limit = 100,
  ): Promise<
    ReadonlyArray<{ action: string; actor_id: string; target: string; created_at: number }>
  > {
    return (
      await q(
        this.db,
        "SELECT action, actor_id, target, created_at FROM audit_log WHERE org_id = ? ORDER BY created_at DESC, id DESC LIMIT ?",
        orgId,
        limit,
      ).all<{ action: string; actor_id: string; target: string; created_at: number }>()
    ).results;
  }

  /** Create an extension (shared address) mailbox for a domain organization (O03). */
  async createExtensionMailbox(
    orgId: string,
    actor: OrgActor,
    memberIds: ReadonlyArray<string>,
  ): Promise<string> {
    const actorId = actor.userId;
    const id = this.clock.id("mbx");
    const now = this.clock.now();
    await this.db.batch([
      q(
        this.db,
        "INSERT INTO mailboxes (id, org_id, owner_user_id, kind, created_at) VALUES (?, ?, NULL, 'extension', ?)",
        id,
        orgId,
        now,
      ),
      q(
        this.db,
        "INSERT INTO resource_catalog (kind, id, shard, provisioned_at) VALUES ('mailbox', ?, ?, ?) ON CONFLICT DO NOTHING",
        id,
        catalogShard(id),
        now,
      ),
      ...memberIds.map((u) =>
        q(
          this.db,
          "INSERT INTO mailbox_access (mailbox_id, user_id, role, can_send, created_at) VALUES (?, ?, 'member', 1, ?)",
          id,
          u,
          now,
        ),
      ),
      audit(this.db, this.clock, {
        orgId,
        actorId,
        action: "extension.create",
        target: id,
        detail: { members: memberIds.length },
      }),
    ]);

    return id;
  }
}
