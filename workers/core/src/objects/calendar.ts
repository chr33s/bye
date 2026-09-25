import { DurableObject } from "cloudflare:workers";
import type { CalendarAuthorityCommand, CalendarAuthorityQuery } from "@bye/contracts";
import {
  calendarExecute,
  calendarRead,
  CalendarStore,
  type CalendarStoreConfig,
  type RpcResult,
  toRpcSync,
} from "@bye/platform-cloudflare";
import { kernelClock } from "../durable-host.ts";
import type { CoreEnv } from "../env.ts";
import { pointInTimeRestore } from "../restore.ts";
import { flush, nameOf, setAlarmAt } from "./common.ts";
import { acceptLiveSocket, broadcastSeq, closeLiveSockets } from "./live.ts";

/**
 * One account's calendar authority (§3.2, §9). Its RPC surface is `execute` (commands, which
 * commit and then relay outbox/alarm/live hints) and `read` (read models, which change nothing).
 * Access is decided inside, by the authority's policy table, for every message.
 */
export class CalendarDO extends DurableObject<CoreEnv> {
  /** Per-instance identity; changes when the object restarts (used to observe a completed restore). */
  private readonly epoch = crypto.randomUUID();
  private store: CalendarStore | null = null;

  sessionEpoch() {
    return this.epoch;
  }

  /** Operator point-in-time restore (§12); the ops route replays erasure tombstones afterwards. */
  restoreTo(at: number) {
    return pointInTimeRestore(this.ctx, at);
  }

  private open(): CalendarStore {
    if (this.store) return this.store;
    const row = this.ctx.storage.kv.get<CalendarStoreConfig>("config");
    if (!row) throw new Error("calendar not provisioned");
    this.store = CalendarStore.open(this.ctx.storage, kernelClock, row);
    return this.store;
  }

  /**
   * Account erasure (§12): delete every table, the alarm and the provisioning config. Live sockets
   * are closed and the in-memory store dropped, so the next request finds an unprovisioned object.
   */
  async eraseAll(): Promise<void> {
    closeLiveSockets(this.ctx);
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    this.store = null;
  }

  /** Idempotent provisioning; the calendar authority is created before exposure (§6). */
  provision(config: CalendarStoreConfig): void {
    if (!this.ctx.storage.kv.get("config")) this.ctx.storage.kv.put("config", config);
    this.open();
  }

  private async afterCommit(): Promise<void> {
    const store = this.open();
    broadcastSeq(this.ctx, store.kernel.currentSeq());
    await flush(this.env, store.kernel, `calendar:${nameOf(this.ctx)}`);
    await setAlarmAt(this.ctx.storage, store.kernel.nextDueAt());
  }

  /** A command (public or authority-internal). `actor` null: trusted Worker code with no principal. */
  execute(actor: string | null, command: CalendarAuthorityCommand): RpcResult<unknown> {
    const result = toRpcSync(() => calendarExecute(this.open(), actor, command));
    if (result.ok) this.ctx.waitUntil(this.afterCommit());
    return result;
  }

  /** A read model; reads never commit, so nothing is relayed. */
  read(actor: string | null, query: CalendarAuthorityQuery): RpcResult<unknown> {
    return toRpcSync(() => calendarRead(this.open(), actor, query));
  }

  /** Whether the actor may observe this calendar space at all (owns it or holds any grant). */
  mayObserve(actor: string): boolean {
    return this.ctx.storage.kv.get("config") ? this.open().mayObserve(actor) : false;
  }

  /** Mailbox asks whether we organize this UID so an attendee REPLY can bypass the Screener (C04). */
  isOrganizerOf(uid: string): boolean {
    return this.ctx.storage.kv.get("config") ? this.open().isOrganizerOf(uid) : false;
  }

  /** Hibernating change-hint socket (§8); authorized and credential-tagged by the API Worker. */
  override async fetch(request: Request): Promise<Response> {
    if (!this.ctx.storage.kv.get("config")) return new Response("not found", { status: 404 });
    return acceptLiveSocket(this.ctx, request, this.open().kernel.currentSeq());
  }

  override async webSocketMessage(): Promise<void> {
    // Clients never send commands over the socket; mutations use the HTTP API.
  }

  /** Close live sockets for a revoked credential (or all, when none is given). */
  closeSockets(credentialId?: string): number {
    return closeLiveSockets(this.ctx, credentialId);
  }

  /**
   * Cron reconciliation (§6 row 3): fire due jobs whose alarm was lost, relay the outbox, compact
   * change history, and re-arm the alarm. Unprovisioned objects report nothing to do.
   */
  async reconcile(_now: number): Promise<{ readonly nextWake: number | null }> {
    if (!this.ctx.storage.kv.get("config")) return { nextWake: null };
    const store = this.open();
    const due = store.runDueJobs();
    store.kernel.compactChanges(10_000);
    await this.afterCommit();
    await setAlarmAt(this.ctx.storage, due.nextAlarm);
    return { nextWake: store.kernel.nextDueAt() };
  }

  override async alarm(): Promise<void> {
    const result = this.open().runDueJobs();
    await this.afterCommit();
    await setAlarmAt(this.ctx.storage, result.nextAlarm);
  }
}
