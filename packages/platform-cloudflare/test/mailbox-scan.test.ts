import { describe, expect, it } from "vitest";
import {
  deliveryFixture,
  makeTestMailbox,
  openTestMailbox,
  summaryFixture,
  TestClock,
} from "@bye/testing";

const attachment = {
  partId: "2",
  filename: "report.pdf",
  contentType: "application/pdf",
  size: 10,
  contentId: undefined,
  inline: false,
};

describe("MailboxStore whole-message scan state", () => {
  it("[E20] deliveries with attachments start pending and emit exactly one scan event; plain mail needs none", () => {
    const { store, clock } = makeTestMailbox();
    const withFile = store.ingest.commitDelivery(
      deliveryFixture(clock, summaryFixture({ attachments: [attachment] })),
    );
    const plain = store.ingest.commitDelivery(
      deliveryFixture(clock, summaryFixture({ subject: "plain" })),
    );
    expect(store.views.delivery(withFile.deliveryId)?.scan.status).toBe("pending");
    expect(store.ingest.attachmentAccess(withFile.deliveryId)).toEqual({
      allowed: false,
      status: "pending",
    });
    expect(store.views.delivery(plain.deliveryId)?.scan.status).toBe("not-required");
    const scans = store.kernel.pendingOutbox(100).filter((e) => e.topic === "scan-message");
    expect(scans.map((e) => (e.payload as { deliveryId: string }).deliveryId)).toEqual([
      withFile.deliveryId,
    ]);
  });

  it("[E24] an infected verdict quarantines the thread and a late or replayed verdict never downgrades it", () => {
    const { store, clock } = makeTestMailbox();
    const d = store.ingest.commitDelivery(
      deliveryFixture(clock, summaryFixture({ attachments: [attachment] })),
    );
    store.ingest.recordDeliveryScan(d.deliveryId, "infected", "Eicar-Test-Signature");
    store.ingest.recordDeliveryScan(d.deliveryId, "clean");
    const thread = store.views.getThread(d.threadId).thread;
    expect(thread.disposition).toBe("spam");
    expect(thread.quarantined).toBe(true);
    expect(store.views.delivery(d.deliveryId)?.scan).toEqual({
      status: "infected",
      signature: "Eicar-Test-Signature",
    });
    expect(store.ingest.attachmentAccess(d.deliveryId).allowed).toBe(false);
  });

  it("[E20] pending scans are listed for reconciliation once they are old enough", () => {
    const { store, clock } = makeTestMailbox();
    const d = store.ingest.commitDelivery(
      deliveryFixture(clock, summaryFixture({ attachments: [attachment] })),
    );
    expect(store.ingest.pendingScans(clock.now() - 60_000, 10)).toEqual([]);
    clock.advance(20 * 60_000);
    expect(
      store.ingest.pendingScans(clock.now() - 15 * 60_000, 10).map((p) => p.deliveryId),
    ).toEqual([d.deliveryId]);
    store.ingest.recordDeliveryScan(d.deliveryId, "clean");
    expect(store.ingest.pendingScans(clock.now(), 10)).toEqual([]);
  });

  it("[E20] the expand-only migration marks pre-existing deliveries legacy (accessible, not rescanned)", () => {
    const { storage, store, clock } = makeTestMailbox();
    const d = store.ingest.commitDelivery(
      deliveryFixture(clock, summaryFixture({ attachments: [attachment] })),
    );
    // Simulate a row written by the v1 schema, before scanning existed.
    storage.sql.exec(
      "UPDATE deliveries SET scan_status = 'legacy' WHERE delivery_id = ?",
      d.deliveryId,
    );
    const reopened = openTestMailbox(storage, "mbx_test0000000000000000000", new TestClock());
    expect(reopened.ingest.attachmentAccess(d.deliveryId)).toEqual({
      allowed: true,
      status: "legacy",
    });
  });
});
