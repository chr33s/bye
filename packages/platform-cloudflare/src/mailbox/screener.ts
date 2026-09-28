import { type Destination, normalizeAddress, type SenderPolicy } from "@bye/domain";
import { type MailboxContext, reject } from "./context.ts";
import type { MailboxDrafts } from "./drafts.ts";
import type { PolicyKind, ThreadLedger } from "./threads.ts";
import type { MailboxViews } from "./views.ts";

// Screener, sender policies and Speakeasy (E01–E03). Every policy write and every disposition
// move goes through the ledger.

export interface ScreenDecision {
  readonly sender: string;
  readonly decision: "allow" | "block";
  readonly destination?: Destination;
  readonly asSeen?: boolean;
  readonly reply?: boolean;
  readonly bundle?: boolean;
  readonly notify?: boolean;
}

type ClearScreenerResult = { readonly cleared: number };

type ScreenResult = {
  readonly moved: number;
  readonly draftIds: ReadonlyArray<string>;
};

export class MailboxScreener {
  constructor(
    private readonly ctx: MailboxContext,
    private readonly ledger: ThreadLedger,
    private readonly views: MailboxViews,
    private readonly drafts: MailboxDrafts,
  ) {}

  private get sql() {
    return this.ctx.sql;
  }

  // ---------------------------------------------------------------- policies (E02)

  setPolicy(kind: PolicyKind, subject: string, policy: SenderPolicy | null): void {
    this.ledger.writePolicy(kind, subject, policy);
  }

  /** Reverse a prior policy decision (E02: users can inspect and reverse decisions). */
  revertPolicy(historyId: string): void {
    const h = this.ledger.historyEntry(historyId) ?? reject("not_found", "history entry");
    this.ledger.writePolicy(h.kind, h.subject, h.prior);
  }

  // ---------------------------------------------------------------- Speakeasy (E03)

  rotateSpeakeasy(): string {
    const code = `hey-${this.ctx.secret(4)}`;
    this.ctx.putSetting("speakeasy", code);
    this.ctx.change("settings", "speakeasy", {});

    return code;
  }

  disableSpeakeasy(): void {
    this.sql.run("DELETE FROM mailbox_settings WHERE key = 'speakeasy'");
  }

  speakeasyMatches(subject: string): boolean {
    const code = this.ctx.setting<string | null>("speakeasy", null);

    return code !== null && subject.toLowerCase().includes(code.toLowerCase());
  }

  // ---------------------------------------------------------------- Screener (E01)

  screenerSenders(): ReadonlyArray<{
    readonly sender: string;
    readonly threads: number;
    readonly latestAt: number;
  }> {
    return this.sql
      .all<{ sender: string; n: number; latest: number }>(
        "SELECT sender, COUNT(*) AS n, MAX(last_activity_at) AS latest FROM threads WHERE disposition = 'screening' AND merged_into IS NULL GROUP BY sender ORDER BY latest DESC",
      )
      .map((r) => ({ sender: r.sender, threads: Number(r.n), latestAt: Number(r.latest) }));
  }

  /**
   * Approve moves pending (and previously screened-out) threads for the sender; `asSeen` approves
   * without surfacing them as new; `reply` returns a reply draft in the same command.
   */
  screen(decisions: ReadonlyArray<ScreenDecision>): ScreenResult {
    let moved = 0;
    const draftIds: Array<string> = [];

    for (const d of decisions) {
      const sender = normalizeAddress(d.sender);

      if (d.decision === "allow") {
        const destination = d.destination ?? "imbox";
        this.ledger.writePolicy("address", sender, {
          decision: "allowed",
          destination,
          labels: [],
          bundle: d.bundle ?? false,
          notify: d.notify ?? false,
        });

        const threads = this.sql.all<{ thread_id: string }>(
          "SELECT thread_id FROM threads WHERE sender = ? AND disposition IN ('screening','screened-out') AND merged_into IS NULL",
          sender,
        );

        for (const t of threads) {
          this.ledger.move(
            t.thread_id,
            "active",
            {
              destination,
              bundleKey: d.bundle ? sender : null,
              newForYou: !d.asSeen,
              seenRevision: d.asSeen ? "revision" : 0,
            },
            null,
          );

          // Invitations held in the Screener only reach the calendar after approval (§9).
          for (const dl of this.views.deliveriesOf(t.thread_id)) {
            if (dl.routing.hasCalendar) {
              this.ctx.kernel.emit("calendar.invitation", this.ctx.mailboxId, {
                deliveryId: dl.deliveryId,
                messageKey: dl.messageKey,
              });
            }
          }

          moved++;
        }

        const first = threads[0];

        if (d.reply && first)
          draftIds.push(
            this.drafts.createReplyDraft(
              first.thread_id,
              "reply",
              this.views.deliveriesOf(first.thread_id),
            ),
          );
      } else {
        this.ledger.writePolicy("address", sender, {
          decision: "blocked",
          destination: "imbox",
          labels: [],
          bundle: false,
          notify: false,
        });

        for (const b of this.sql.all<{ thread_id: string }>(
          "SELECT thread_id FROM threads WHERE sender = ? AND disposition = 'screening'",
          sender,
        )) {
          this.ledger.move(b.thread_id, "screened-out", { newForYou: false }, null);
          moved++;
        }
      }

      this.ctx.change("screener", d.decision, { sender });
    }

    return { moved, draftIds };
  }

  /**
   * Clear the pending list up to a snapshot boundary. Senders stay "unknown": their next message
   * is screened again. Clearing never approves (E01).
   */
  clearScreener(boundary: number): ClearScreenerResult {
    const affected = this.sql.all<{ thread_id: string }>(
      "SELECT thread_id FROM threads WHERE disposition = 'screening' AND activity_seq <= ?",
      boundary,
    );

    for (const a of affected)
      this.ledger.move(a.thread_id, "screened-out", { newForYou: false }, null);
    this.ctx.change("screener", "cleared", { boundary });

    return { cleared: affected.length };
  }
}
