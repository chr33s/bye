import type { KernelClock } from "../durable/kernel.ts";
import { inListChunks } from "../durable/sql.ts";
import { type D1Like, primary, q } from "./d1.ts";

// Discovery index for shared resources (O03, O04). The SharedSpaceDO stays the authority for
// content and grants; this D1 registry only answers "which spaces follow this mailbox thread?" and
// "which space holds this extension mailbox's history?" so a delivery can reach its shared targets.

export interface SharedThreadLink {
  readonly spaceId: string;
  readonly sharedThreadId: string;
  readonly includeFuture: boolean;
}

export class ControlSharedRegistry {
  constructor(
    readonly db: D1Like,
    readonly clock: KernelClock,
  ) {}

  async registerSpace(
    spaceId: string,
    orgId: string,
    kind: "team" | "extension",
    createdBy: string,
  ): Promise<void> {
    await q(
      this.db,
      "INSERT INTO spaces (id, org_id, kind, created_by, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING",
      spaceId,
      orgId,
      kind,
      createdBy,
      this.clock.now(),
    ).run();
  }

  async spaceOrg(
    spaceId: string,
  ): Promise<{ readonly orgId: string; readonly kind: string } | null> {
    const r = await q(
      primary(this.db),
      "SELECT org_id, kind FROM spaces WHERE id = ?",
      spaceId,
    ).first<{ org_id: string; kind: string }>();
    return r ? { orgId: r.org_id, kind: r.kind } : null;
  }

  async spacesForOrgs(
    orgIds: ReadonlyArray<string>,
  ): Promise<
    ReadonlyArray<{ readonly id: string; readonly orgId: string; readonly kind: string }>
  > {
    if (orgIds.length === 0) return [];
    // D1 binds at most 100 parameters per statement: bounded IN lists, merged back in order.
    const parts: Array<{
      results: Array<{ id: string; org_id: string; kind: string; created_at: number }>;
    }> = [];
    for (const chunk of inListChunks([...new Set(orgIds)]))
      parts.push(
        await q(
          primary(this.db),
          `SELECT id, org_id, kind, created_at FROM spaces WHERE org_id IN (${chunk.map(() => "?").join(",")}) ORDER BY created_at`,
          ...chunk,
        ).all<{ id: string; org_id: string; kind: string; created_at: number }>(),
      );
    return parts
      .flatMap((p) => p.results)
      .sort((a, b) => Number(a.created_at) - Number(b.created_at))
      .map((r) => ({ id: r.id, orgId: r.org_id, kind: r.kind }));
  }

  async registerSharedThread(input: {
    readonly mailboxId: string;
    readonly threadId: string;
    readonly spaceId: string;
    readonly sharedThreadId: string;
    readonly includeFuture: boolean;
  }): Promise<void> {
    await q(
      this.db,
      `INSERT INTO shared_thread_registry (mailbox_id, thread_id, space_id, shared_thread_id, include_future, created_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (mailbox_id, thread_id, space_id) DO UPDATE SET shared_thread_id = excluded.shared_thread_id, include_future = MAX(include_future, excluded.include_future)`,
      input.mailboxId,
      input.threadId,
      input.spaceId,
      input.sharedThreadId,
      input.includeFuture ? 1 : 0,
      this.clock.now(),
    ).run();
  }

  /** Every space holding content copied from this mailbox (shared threads and extension mail). */
  async spacesHoldingMailbox(mailboxId: string): Promise<ReadonlyArray<string>> {
    const rows = await q(
      primary(this.db),
      "SELECT space_id FROM shared_thread_registry WHERE mailbox_id = ? UNION SELECT space_id FROM extension_spaces WHERE mailbox_id = ? ORDER BY space_id",
      mailboxId,
      mailboxId,
    ).all<{ space_id: string }>();
    return rows.results.map((r) => r.space_id);
  }

  /** Spaces that receive future replies of a mailbox thread (`sharedThreadFor`). */
  async sharedThreadsFor(
    mailboxId: string,
    threadId: string,
  ): Promise<ReadonlyArray<SharedThreadLink>> {
    const rows = await q(
      primary(this.db),
      "SELECT space_id, shared_thread_id, include_future FROM shared_thread_registry WHERE mailbox_id = ? AND thread_id = ?",
      mailboxId,
      threadId,
    ).all<{ space_id: string; shared_thread_id: string; include_future: number }>();
    return rows.results.map((r) => ({
      spaceId: r.space_id,
      sharedThreadId: r.shared_thread_id,
      includeFuture: r.include_future === 1,
    }));
  }

  async registerExtension(mailboxId: string, spaceId: string, address: string): Promise<void> {
    await q(
      this.db,
      "INSERT INTO extension_spaces (mailbox_id, space_id, address, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (mailbox_id) DO UPDATE SET space_id = excluded.space_id, address = excluded.address",
      mailboxId,
      spaceId,
      address.toLowerCase(),
      this.clock.now(),
    ).run();
  }

  async extensionFor(
    mailboxId: string,
  ): Promise<{ readonly spaceId: string; readonly address: string } | null> {
    const r = await q(
      primary(this.db),
      "SELECT space_id, address FROM extension_spaces WHERE mailbox_id = ?",
      mailboxId,
    ).first<{ space_id: string; address: string }>();
    return r ? { spaceId: r.space_id, address: r.address } : null;
  }
}
