import type { MessageSummary } from "@bye/mail-codec";
import { type MailboxContext, reject } from "./context.ts";
import type { ThreadLedger } from "./threads.ts";

// Linked-account redelivery (E19, E22): an idempotent transfer record propagated through the
// outbox to another authorized mailbox — never an SMTP round trip.

export class MailboxTransfers {
  constructor(
    private readonly ctx: MailboxContext,
    private readonly ledger: ThreadLedger,
  ) {}

  private get sql() {
    return this.ctx.sql;
  }

  /** Explicit redelivery; `move` removes the delivery here (an emptied thread goes to Trash). */
  redeliver(input: {
    readonly deliveryId: string;
    readonly targetMailboxId: string;
    readonly mode: "copy" | "move";
    readonly summary: MessageSummary;
  }): { readonly transferId: string } {
    if (input.targetMailboxId === this.ctx.mailboxId)
      reject("bad_request", "cannot redeliver to the same mailbox");
    const transferId = this.emitTransfer(
      input.deliveryId,
      input.targetMailboxId,
      input.mode,
      input.summary,
    );
    // The original bytes stay referenced by the target (no blob GC here).
    if (input.mode === "move") this.ledger.removeDelivery(input.deliveryId);
    return { transferId };
  }

  /** Transfer record + propagate event. Caller holds the transaction. */
  emitTransfer(
    deliveryId: string,
    targetMailboxId: string,
    mode: "copy" | "move",
    summary: MessageSummary,
  ): string {
    const d =
      this.sql.one<{ message_key: string; raw_size: number }>(
        "SELECT message_key, raw_size FROM deliveries WHERE delivery_id = ?",
        deliveryId,
      ) ?? reject("not_found", "delivery");
    const transferId = this.ctx.id("xfr");
    this.sql.run(
      "INSERT INTO transfers (transfer_id, direction, peer_mailbox, delivery_id, mode, at) VALUES (?, 'out', ?, ?, ?, ?)",
      transferId,
      targetMailboxId,
      deliveryId,
      mode,
      this.ctx.now(),
    );
    this.ctx.kernel.emit("mailbox.redeliver", targetMailboxId, {
      transferId,
      messageKey: d.message_key,
      rawSize: Number(d.raw_size),
      summary,
    });
    this.ctx.change("transfer", "out", { transferId });
    return transferId;
  }
}
