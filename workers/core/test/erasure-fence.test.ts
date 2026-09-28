import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { blobKey } from "@bye/application";
import { ControlDirectory } from "@bye/platform-cloudflare";
import { handleQueueMessage } from "../src/consumers.ts";
import { kernelClock } from "../src/durable-host.ts";
import type { CoreEnv } from "../src/env.ts";
import {
  eraseCalendarContent,
  eraseMailboxContent,
  eraseUserRows,
  replayUnverifiedTombstones,
  startErasure,
  writeTombstone,
} from "../src/erasure.ts";
import { quarantineUnprocessable } from "../src/scheduled.ts";
import { type Harness, makeHarness, rfc822, mockAs } from "./harness.ts";

// Erasure completeness and its persistent fence (§12): non-mailbox PARTS namespaces are purged,
// search-shard clears are checked before the catalog is lost, and queued work cannot recreate an
// erased mailbox.

const account = (h: Harness, address: string) =>
  new ControlDirectory(h.env.DIRECTORY, kernelClock).provisionPersonalAccount({
    address,
    displayName: address.split("@")[0]!,
  });

const keys = (h: Harness, bucket: "PARTS" | "ORIGINALS") => [...h.buckets[bucket].objects.keys()];

describe("erasure fence and completeness", () => {
  let h: Harness;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2026, 8, 25, 12));
    h = makeHarness();
  });
  afterEach(() => vi.useRealTimers());

  it("[§12] calendar day photos and private World media are purged; others' objects stay", async () => {
    const ana = await account(h, "ana@bye.test");
    const bob = await account(h, "bob@bye.test");

    for (const u of [ana, bob]) {
      await h.buckets.PARTS.put(`cal/${u.calendarId}/photo/p${"x".repeat(20)}`, "photo");
      await h.buckets.PARTS.put(`t/${u.userId}/world-media/m1`, "media");
    }

    await eraseCalendarContent(h.env, ana.calendarId);
    await eraseUserRows(h.env, ana.userId);
    const left = keys(h, "PARTS");
    expect(left.filter((k) => k.includes(ana.calendarId) || k.includes(ana.userId))).toEqual([]);
    expect(left.filter((k) => k.includes(bob.calendarId) || k.includes(bob.userId))).toHaveLength(
      2,
    );
  });

  it("[§12] a failed shard clear fails the erase step before the catalog is erased, and replay does not verify it", async () => {
    const ana = await account(h, "ana@bye.test");
    await writeTombstone(h.env, "mailbox", ana.mailboxId);
    let failing = true;
    const shards = h.env.SEARCH_SHARDS;

    const env = {
      ...h.env,
      SEARCH_SHARDS: {
        getByName: (name: string) => {
          const real = shards.getByName(name);

          return {
            clear: async () => {
              if (failing) throw new Error("shard unavailable");

              return real.clear();
            },
          };
        },
      },
    } as CoreEnv;

    await expect(eraseMailboxContent(env, ana.mailboxId)).rejects.toThrow("shard unavailable");

    // The authority (and so its shard catalog) was not erased yet.
    const instance = mockAs<{ ctx: DurableObjectState }>(
      h.namespaces.MAILBOXES.instance(ana.mailboxId),
    );

    expect(instance.ctx.storage.kv.get("erased")).toBeUndefined();
    expect(await replayUnverifiedTombstones(env)).toEqual({ replayed: 0 });

    const verified = () =>
      h.d1
        .prepare(
          "SELECT verified_at FROM erasure_tombstones WHERE resource_kind = 'mailbox' AND resource_id = ?",
        )
        .bind(ana.mailboxId)
        .first<{ verified_at: number | null }>();

    expect((await verified())?.verified_at).toBeNull();
    failing = false;
    expect(await replayUnverifiedTombstones(env)).toEqual({ replayed: 1 });
    expect((await verified())?.verified_at).not.toBeNull();
  });

  it("[§12] erasure closes the mailbox and its routes; queued ingest, quarantine and commits cannot recreate it", async () => {
    const ana = await account(h, "ana@bye.test");
    await startErasure(h.env, ana.userId, "test");
    expect(
      await h.d1.prepare("SELECT status FROM mailboxes WHERE id = ?").bind(ana.mailboxId).first(),
    ).toEqual({ status: "closed" });
    expect(
      await h.d1
        .prepare(
          "SELECT COUNT(*) AS n FROM address_routes WHERE mailbox_id = ? AND disabled_at IS NULL",
        )
        .bind(ana.mailboxId)
        .first(),
    ).toEqual({ n: 0 });
    await eraseMailboxContent(h.env, ana.mailboxId);

    // An ingest message queued before erasure whose original is still present writes nothing.
    const ingestionId = "ing_late";
    const objectKey = blobKey.original(ana.mailboxId, ingestionId);
    await h.buckets.ORIGINALS.put(
      objectKey,
      rfc822({
        from: "bob@example.net",
        to: "ana@bye.test",
        subject: "Late",
        body: "late body",
        messageId: "late@example.net",
      }),
    );
    await handleQueueMessage(h.env, {
      schemaVersion: 1,
      type: "ingest",
      eventId: `ingest:${ingestionId}`,
      ingestionId,
      mailboxId: ana.mailboxId,
      recipient: "ana@bye.test",
      envelopeFrom: "bob@example.net",
      objectKey,
      rawSize: 10,
      receivedAt: Date.now(),
    } as never);
    expect(keys(h, "PARTS").filter((k) => k.startsWith(`t/${ana.mailboxId}/`))).toEqual([]);

    // Journal quarantine of an exhausted receipt commits nothing.
    expect(
      await quarantineUnprocessable(h.env, {
        ingestionId: "ing_poison",
        mailboxId: ana.mailboxId,
        recipient: "ana@bye.test",
        envelopeFrom: "bad@example.net",
        objectKey,
        rawSize: 8,
        receivedAt: Date.now(),
      }),
    ).toBe(false);

    // The authority itself keeps a persistent erased marker and refuses deliveries permanently.
    const stub = h.env.MAILBOXES.getByName(ana.mailboxId);
    expect(await stub.commitDelivery({} as never)).toMatchObject({ ok: false, code: "gone" });
    const copy = `t/${ana.mailboxId}/orig/xfer_1.eml`;
    await h.buckets.ORIGINALS.put(copy, "bytes");
    expect(
      await stub.receiveTransfer({ transferId: "xfer_1", messageKey: copy } as never),
    ).toBeNull();
    expect(h.buckets.ORIGINALS.objects.has(copy)).toBe(false);
    expect(
      await h.d1
        .prepare("SELECT COUNT(*) AS n FROM storage_usage WHERE owner_id = ?")
        .bind(ana.mailboxId)
        .first(),
    ).toEqual({ n: 0 });
  });
});
