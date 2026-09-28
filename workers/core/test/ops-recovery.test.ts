import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ControlDirectory,
  ControlAuth,
  ControlSharedRegistry,
  CATALOG_SHARDS,
} from "@bye/platform-cloudflare";
import { handleFetch } from "../src/api.ts";
import { GC_DELAY_MS, pinBlob, recordGcIntent, sweepBlobGc } from "../src/blobgc.ts";
import { handleQueueBatch, handleQueueMessage } from "../src/consumers.ts";
import { kernelClock } from "../src/durable-host.ts";
import {
  replayTombstones,
  startErasure,
  replayTombstonesFor,
  replayUnverifiedTombstones,
} from "../src/erasure.ts";
import { setMetricSink } from "../src/metrics.ts";
import {
  DAILY_CRON,
  handleScheduled,
  reconcileCatalog,
  reportMetadataHealth,
  SHARDS_PER_RUN,
} from "../src/scheduled.ts";
import {
  type Harness,
  makeHarness,
  inboundMessage,
  rfc822,
  executionContext,
  mockAs,
  type StepResult,
} from "./harness.ts";
import { authConfig } from "../src/services.ts";
import { handleInbound } from "../src/inbound.ts";
import { ReindexWorkflow } from "../src/workflows/reindex.ts";
import { MAILBOX_METADATA_BUDGET_BYTES } from "../src/objects/mailbox.ts";
import {
  pendingPropagation,
  replayPendingPropagation,
  propagateDelivery,
} from "../src/topics/shared.ts";

// Operator recovery (§6, §12): DLQ capture + validated replay, delayed reference-aware blob GC,
// erasure with tombstone replay after restore, and cron branching.

const ctx = executionContext;

const OPS = "ops-token-0123456789abcdef0123456789abcdef";

const opsCall = async <BodyValue>(
  h: Harness,
  method: string,
  path: string,
  body?: BodyValue,
  token: string | null = OPS,
) => {
  const headers = new Headers();

  if (token) headers.set("authorization", `Bearer ${token}`);

  if (body !== undefined) headers.set("content-type", "application/json");

  const r = await handleFetch(
    new Request(
      `${h.env.APP_ORIGIN}${path}`,
      body !== undefined ? { method, headers, body: JSON.stringify(body) } : { method, headers },
    ),
    h.env,
    ctx,
  );

  const text = await r.text();

  return { status: r.status, body: text ? JSON.parse(text) : null };
};

const dlqBatch = (queue: string, bodies: ReadonlyArray<unknown>) => {
  const acked: Array<number> = [];
  const retried: Array<number> = [];

  const batch: MessageBatch<unknown> = mockAs({
    queue,
    messages: bodies.map((body, i) => ({
      id: `m${i}`,
      timestamp: new Date(),
      body,
      attempts: 5,
      ack: () => void acked.push(i),
      retry: () => void retried.push(i),
    })),
    ackAll: () => undefined,
    retryAll: () => undefined,
  });

  return { batch, acked, retried };
};

describe("ops recovery", () => {
  let h: Harness;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2026, 8, 25, 12));
    h = makeHarness();
    (h.env as { OPS_TOKEN: string }).OPS_TOKEN = OPS;
  });
  afterEach(() => {
    vi.useRealTimers();
    setMetricSink(null);
  });

  it("[§6] operator routes require the OPS_TOKEN bearer and are disabled when it is unset", async () => {
    expect((await opsCall(h, "GET", "/v1/ops/dlq", undefined, null)).status).toBe(401);
    expect((await opsCall(h, "GET", "/v1/ops/dlq", undefined, "wrong")).status).toBe(401);
    expect((await opsCall(h, "GET", "/v1/ops/dlq")).status).toBe(200);
    (h.env as { OPS_TOKEN: string }).OPS_TOKEN = "";
    expect((await opsCall(h, "GET", "/v1/ops/dlq", undefined, "")).status).toBe(401);
  });

  it("[§6] DLQ messages are captured to D1, listed, replayed after validation, or discarded", async () => {
    const dispatch = {
      schemaVersion: 1,
      type: "dispatch",
      eventId: "dispatch:job_x",
      mailboxId: "mbx_missing",
      sendJobId: "job_x",
    };

    const notify = {
      schemaVersion: 1,
      type: "notify",
      eventId: "notify:1",
      userId: "mbx_1",
      kind: "mail.delivery",
    };

    const unrecognisedMessage = { hello: "world" };

    const { batch, acked } = dlqBatch("bye-prod-dispatch-dlq", [
      dispatch,
      notify,
      unrecognisedMessage,
    ]);

    await handleQueueBatch(batch, h.env);
    expect(acked).toEqual([0, 1, 2]);
    const list = await opsCall(h, "GET", "/v1/ops/dlq");
    expect(list.body.deadLetters.map((d: { message_type: string }) => d.message_type)).toEqual([
      "dispatch",
      "notify",
      "unknown",
    ]);
    // Dispatch replay re-validates: the send job is not `ready`, so the letter is obsolete, not re-sent.
    const obsolete = await opsCall(h, "POST", "/v1/ops/dlq/dl_m0/replay");
    expect(obsolete.body._tag).toBe("Obsolete");
    expect(h.queues.DISPATCH.messages).toHaveLength(0);
    // Other kinds are idempotent at the consumer and go back to their source queue.
    expect((await opsCall(h, "POST", "/v1/ops/dlq/dl_m1/replay")).body._tag).toBe("Replayed");
    expect(h.queues.DISPATCH.messages).toHaveLength(1);
    expect((await opsCall(h, "POST", "/v1/ops/dlq/dl_m1/replay")).status).toBe(404);
    expect(
      (await opsCall(h, "POST", "/v1/ops/dlq/dl_m2/discard", { note: "garbage" })).status,
    ).toBe(200);
    expect((await opsCall(h, "GET", "/v1/ops/dlq")).body.deadLetters).toHaveLength(0);
    expect((await opsCall(h, "GET", "/v1/ops/dlq?state=discarded")).body.deadLetters[0].note).toBe(
      "garbage",
    );
  });

  it("[§6] a mixed batch acks the good messages and retries only the poison one", async () => {
    const poison = { schemaVersion: 1, type: "not-a-type" };

    const good = {
      schemaVersion: 1,
      type: "propagate",
      eventId: "p1",
      source: "mailbox:mbx_1",
      target: "x",
      topic: "no-such-topic",
      payload: {},
    };

    const acked: Array<string> = [];
    const retried: Array<string> = [];
    await handleQueueBatch(
      {
        queue: "bye-prod-propagate",
        messages: [good, poison, good].map((body, i) => ({
          id: `m${i}`,
          timestamp: new Date(),
          body,
          attempts: 1,
          ack: () => void acked.push(`m${i}`),
          retry: () => void retried.push(`m${i}`),
        })),
        ackAll: () => undefined,
        retryAll: () => undefined,
      } as never,
      h.env,
    );
    expect(acked).toEqual(["m0", "m2"]);
    expect(retried).toEqual(["m1"]);
  });

  it("[§15.10] the calendar post-deploy probe erases its throwaway calendar authority", async () => {
    (h.env as { PROBE_TOKEN: string }).PROBE_TOKEN = "probe-token-0123456789";

    const res = await handleFetch(
      new Request(`${h.env.APP_ORIGIN}/__probe/calendar/p12345678`, {
        method: "POST",
        headers: { "x-bye-probe-token": "probe-token-0123456789" },
      }),
      h.env,
      ctx as never,
    );

    expect(await res.json()).toMatchObject({ ok: true });
    const storage = h.namespaces.CALENDARS.state("probe-cal-p12345678").storage;
    expect(storage.kv.get("config")).toBeUndefined();
  });

  it("[§6] a by-reference message whose R2 object is gone (already processed) is acked, not retried", async () => {
    const acked: Array<string> = [];
    const retried: Array<string> = [];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      await handleQueueBatch(
        {
          queue: "bye-prod-propagate",
          messages: [
            {
              id: "m0",
              timestamp: new Date(),
              body: { schemaVersion: 1, type: "ref", key: "_queue/evt_gone.json" },
              attempts: 2,
              ack: () => void acked.push("m0"),
              retry: () => void retried.push("m0"),
            },
          ],
          ackAll: () => undefined,
          retryAll: () => undefined,
        } as never,
        h.env,
      );
      expect(acked).toEqual(["m0"]);
      expect(retried).toEqual([]);
      expect(warn.mock.calls.flat().join(" ")).toContain("queue.ref-missing");
    } finally {
      warn.mockRestore();
    }
  });

  it("[§12] blob GC waits for the delay, re-checks references, and never deletes unknown or pinned keys", async () => {
    const put = (bucket: "ORIGINALS" | "PARTS", key: string) => h.buckets[bucket].put(key, "x");
    await put("PARTS", "t/mbx_1/upload/up_failed");
    await put("PARTS", "t/mbx_1/upload/up_draft");
    await put("PARTS", "t/mbx_1/upload/up_pinned");
    await put("ORIGINALS", "weird/key");
    await recordGcIntent(h.env, {
      bucket: "PARTS",
      key: "t/mbx_1/upload/up_failed",
      ownerKind: "mailbox",
      ownerId: "mbx_1",
      reason: "upload-failed",
    });
    await recordGcIntent(h.env, {
      bucket: "PARTS",
      key: "t/mbx_1/upload/up_draft",
      ownerKind: "mailbox",
      ownerId: "mbx_1",
      reason: "retention",
    });
    await recordGcIntent(h.env, {
      bucket: "PARTS",
      key: "t/mbx_1/upload/up_pinned",
      ownerKind: "mailbox",
      ownerId: "mbx_1",
      reason: "upload-aborted",
    });
    await pinBlob(h.env, "PARTS", "t/mbx_1/upload/up_pinned", "space", "spc_1");
    await recordGcIntent(h.env, {
      bucket: "ORIGINALS",
      key: "weird/key",
      ownerKind: "mailbox",
      ownerId: "mbx_1",
      reason: "retention",
    });

    expect(await sweepBlobGc(h.env, Date.now())).toEqual({ deleted: 0, retained: 0 }); // not yet due
    const due = Date.now() + GC_DELAY_MS + 1;
    expect(await sweepBlobGc(h.env, due)).toEqual({ deleted: 1, retained: 3 });
    expect(h.buckets.PARTS.objects.has("t/mbx_1/upload/up_failed")).toBe(false);
    expect(h.buckets.PARTS.objects.has("t/mbx_1/upload/up_draft")).toBe(true);
    expect(h.buckets.PARTS.objects.has("t/mbx_1/upload/up_pinned")).toBe(true);
    expect(h.buckets.ORIGINALS.objects.has("weird/key")).toBe(true);
  });

  it("[§12] the blob-gc topic records a delayed intent instead of deleting", async () => {
    await h.buckets.PARTS.put("t/mbx_1/upload/up_1", "x");
    await handleQueueMessage(h.env, {
      schemaVersion: 1,
      type: "propagate",
      eventId: "gc1",
      source: "mailbox:mbx_1",
      target: "gc",
      topic: "blob-gc",
      payload: { key: "t/mbx_1/upload/up_1", reason: "aborted" },
    });
    expect(h.buckets.PARTS.objects.has("t/mbx_1/upload/up_1")).toBe(true);

    const intent = await h.env.DIRECTORY.prepare(
      "SELECT bucket, reason, not_before FROM blob_gc_intents",
    ).first<{ bucket: string; reason: string; not_before: number }>();

    expect(intent).toMatchObject({
      bucket: "PARTS",
      reason: "upload-aborted",
      not_before: Date.now() + GC_DELAY_MS,
    });
    await sweepBlobGc(h.env, Date.now() + GC_DELAY_MS);
    expect(h.buckets.PARTS.objects.has("t/mbx_1/upload/up_1")).toBe(false);
  });

  it("[§12] erasure writes tombstones first; tombstone replay re-erases content restored from backup", async () => {
    const account = await new ControlDirectory(
      h.env.DIRECTORY,
      kernelClock,
    ).provisionPersonalAccount({ address: "ana@bye.test", displayName: "ana" });

    await h.buckets.ORIGINALS.put(`t/${account.mailboxId}/orig/i1.eml`, "raw");
    await h.buckets.PUBLISHED.put("site/ana/index.html", "<p>hi</p>");
    const world = h.env.SHARED_SPACES.getByName("world:ana");
    expect(
      (
        await world.initWorld({
          authorId: account.userId,
          handle: "ana",
          title: "ana",
          addresses: ["ana@bye.test"],
        })
      ).ok,
    ).toBe(true);

    const started = await opsCall(h, "POST", "/v1/ops/erasure", {
      userId: account.userId,
      reason: "test",
    });

    expect(started.status).toBe(202);
    expect(h.workflows.ERASE_ACCOUNT?.[0]).toMatchObject({
      id: `erase-${account.userId}`,
      params: { v: 1, userId: account.userId, mailboxIds: [account.mailboxId], worldHandle: "ana" },
    });
    // Idempotent per user: the second start reuses the same instance id and creates nothing new.
    const again = await startErasure(h.env, account.userId, "again");
    expect(again.instanceId).toBe(`erase-${account.userId}`);
    expect(h.workflows.ERASE_ACCOUNT).toHaveLength(1);

    const kinds = (
      await h.env.DIRECTORY.prepare(
        "SELECT resource_kind FROM erasure_tombstones ORDER BY resource_kind",
      ).all<{ resource_kind: string }>()
    ).results.map((r) => r.resource_kind);

    expect(kinds).toEqual(["calendar", "mailbox", "user", "world"]);
    // Simulate a restore that brought content back; replay removes it again.
    expect(await replayTombstones(h.env)).toEqual({ replayed: 4 });
    expect(h.buckets.ORIGINALS.objects.has(`t/${account.mailboxId}/orig/i1.eml`)).toBe(false);
    expect(h.buckets.PUBLISHED.objects.has("site/ana/index.html")).toBe(false);
    // The World authority itself is erased and the handle released.
    expect(await world.worldAuthorId()).toEqual({ ok: true, value: null });
    await h.buckets.ORIGINALS.put(`t/${account.mailboxId}/orig/i2.eml`, "restored");
    await opsCall(h, "POST", "/v1/ops/tombstones/replay");
    expect(h.buckets.ORIGINALS.objects.has(`t/${account.mailboxId}/orig/i2.eml`)).toBe(false);
  });

  it("[§12] a released World handle re-claimed by someone else survives replay of the old tombstone", async () => {
    const directory = new ControlDirectory(h.env.DIRECTORY, kernelClock);

    const ana = await directory.provisionPersonalAccount({
      address: "ana@bye.test",
      displayName: "ana",
    });

    const world = h.env.SHARED_SPACES.getByName("world:ana");
    expect(
      (
        await world.initWorld({
          authorId: ana.userId,
          handle: "ana",
          title: "ana",
          addresses: ["ana@bye.test"],
        })
      ).ok,
    ).toBe(true);
    await startErasure(h.env, ana.userId, "closure");
    await replayTombstones(h.env);
    expect(await world.worldAuthorId()).toEqual({ ok: true, value: null });
    expect(
      (
        await world.initWorld({
          authorId: "usr_next",
          handle: "ana",
          title: "next",
          addresses: ["x@bye.test"],
        })
      ).ok,
    ).toBe(true);
    await h.buckets.PUBLISHED.put("site/ana/index.html", "<p>new owner</p>");
    await replayTombstones(h.env);
    expect(await world.worldAuthorId()).toEqual({ ok: true, value: "usr_next" });
    expect(h.buckets.PUBLISHED.objects.has("site/ana/index.html")).toBe(true);
  });

  it("[§12] erasure removes shared-space membership and grants, and replay re-erases a restored membership", async () => {
    const directory = new ControlDirectory(h.env.DIRECTORY, kernelClock);

    const owner = await directory.provisionPersonalAccount({
      address: "owner@bye.test",
      displayName: "owner",
    });

    const ana = await directory.provisionPersonalAccount({
      address: "ana@bye.test",
      displayName: "ana",
    });

    const space = h.env.SHARED_SPACES.getByName("space:spc_team1");
    expect(
      (
        await space.initSpace({
          spaceId: "spc_team1",
          kind: "team",
          organizationId: owner.organizationId,
          ownerId: owner.userId,
        })
      ).ok,
    ).toBe(true);
    expect((await space.setMember(owner.userId, ana.userId, "member")).ok).toBe(true);

    const shared = await space.shareThread({
      actorId: owner.userId,
      sourceMailboxId: owner.mailboxId,
      sourceThreadId: "thr_1",
      subject: "Plan",
      messages: [],
      grantees: [ana.userId],
      includeFuture: false,
    });

    expect(shared.ok).toBe(true);

    const indexed = (
      await h.env.DIRECTORY.prepare(
        "SELECT user_id, role FROM space_memberships WHERE space_id = 'spc_team1' ORDER BY user_id",
      ).all<{ user_id: string; role: string }>()
    ).results;

    expect(indexed.map((r) => r.role).sort()).toEqual(["member", "owner"]);

    await startErasure(h.env, ana.userId, "closure");
    expect(h.workflows.ERASE_ACCOUNT?.at(-1)?.params).toMatchObject({ spaceIds: ["spc_team1"] });

    const tombstones = (
      await h.env.DIRECTORY.prepare(
        "SELECT resource_id FROM erasure_tombstones WHERE resource_kind = 'space-member'",
      ).all<{ resource_id: string }>()
    ).results;

    expect(tombstones.map((t) => t.resource_id)).toEqual([`spc_team1:${ana.userId}`]);

    const memberOf = async (userId: string) => {
      const r = (await space.isMember(userId)) as { ok: boolean; value?: boolean };

      return r.ok && r.value === true;
    };

    await replayTombstones(h.env);
    expect(await memberOf(ana.userId)).toBe(false);
    expect((await space.readThread(ana.userId, (shared as { value: string }).value)).ok).toBe(
      false,
    );
    expect(
      (
        await h.env.DIRECTORY.prepare(
          "SELECT COUNT(*) AS n FROM space_memberships WHERE user_id = ?",
        )
          .bind(ana.userId)
          .first<{ n: number }>()
      )?.n,
    ).toBe(0);

    // A restore that brings the membership back is undone by the next replay.
    await space.setMember(owner.userId, ana.userId, "member");
    expect(await memberOf(ana.userId)).toBe(true);
    await replayTombstones(h.env);
    expect(await memberOf(ana.userId)).toBe(false);
    expect(await memberOf(owner.userId)).toBe(true);
  });

  it("[§12] point-in-time restore arms the bookmark, aborts the object, then replays tombstones", async () => {
    const account = await new ControlDirectory(
      h.env.DIRECTORY,
      kernelClock,
    ).provisionPersonalAccount({ address: "ana@bye.test", displayName: "ana" });

    const inst = mockAs<{
      ctx: {
        storage: {
          getBookmarkForTime?: (t: number) => Promise<string>;
          onNextSessionRestoreBookmark?: (b: string) => Promise<string>;
        };
        abort?: (r?: string) => void;
      };
    }>(h.namespaces.MAILBOXES.instance(account.mailboxId));

    const armed: Array<string> = [];
    let aborted = false;
    inst.ctx.storage.getBookmarkForTime = async (t: number) => `bm-${t}`;
    inst.ctx.storage.onNextSessionRestoreBookmark = async (b: string) => (armed.push(b), b);
    // Simulate the runtime: abort discards the instance; the next call gets a fresh instance (new epoch).
    inst.ctx.abort = () => {
      aborted = true;
      h.namespaces.MAILBOXES.instances.delete(account.mailboxId);
    };

    const at = Date.now() - 3600_000;

    expect(
      (await opsCall(h, "POST", "/v1/ops/restore", { kind: "mailbox", id: account.mailboxId, at }))
        .status,
    ).toBe(400); // no confirm
    expect(
      (
        await opsCall(h, "POST", "/v1/ops/restore", {
          kind: "mailbox",
          id: account.mailboxId,
          at: Date.now() + 1000,
          confirm: account.mailboxId,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await opsCall(h, "POST", "/v1/ops/restore", {
          kind: "mailbox",
          id: account.mailboxId,
          at: Date.now() - 31 * 24 * 3600_000,
          confirm: account.mailboxId,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await opsCall(h, "POST", "/v1/ops/restore", {
          kind: "mailbox",
          id: "../x",
          at,
          confirm: "../x",
        })
      ).status,
    ).toBe(400);

    await startErasure(h.env, account.userId, "closure");

    const r = await opsCall(h, "POST", "/v1/ops/restore", {
      kind: "mailbox",
      id: account.mailboxId,
      at,
      confirm: account.mailboxId,
    });

    expect(r.status).toBe(202);
    expect(r.body).toMatchObject({ bookmark: `bm-${at}`, at });
    expect(r.body.tombstonesReplayed).toBeGreaterThan(0);
    expect(armed).toEqual([`bm-${at}`]);
    // The replay ran only after the restart was observed.
    expect(aborted).toBe(true);

    // A back-end without PITR (local workerd) is reported, not silently ignored.
    const other = await new ControlDirectory(h.env.DIRECTORY, kernelClock).provisionPersonalAccount(
      { address: "bo@bye.test", displayName: "bo" },
    );

    const none = await opsCall(h, "POST", "/v1/ops/restore", {
      kind: "mailbox",
      id: other.mailboxId,
      at,
      confirm: other.mailboxId,
    });

    expect(none.status).toBe(503);
  });

  it("[§12] reindex trigger starts a versioned workflow", async () => {
    expect((await opsCall(h, "POST", "/v1/ops/reindex", { mailboxId: "../etc" })).status).toBe(400);
    const r = await opsCall(h, "POST", "/v1/ops/reindex", { mailboxId: "mbx_1" });
    expect(r.status).toBe(202);
    expect(h.workflows.REINDEX?.[0]?.params).toEqual({ v: 1, mailboxId: "mbx_1" });
  });

  it("[§6/§12] cron branches: 5-minute reconcile vs daily sweeps", async () => {
    const seen: Array<string> = [];
    setMetricSink((m) => void seen.push(m.metric));
    await handleScheduled(
      {
        cron: "*/5 * * * *",
        scheduledTime: Date.now(),
        noRetry: () => undefined,
      } as ScheduledController,
      h.env,
    );
    expect(seen).toContain("reconcile.catalog");
    expect(seen).toContain("ingest.republished");
    expect(seen).not.toContain("blobgc.deleted");
    seen.length = 0;
    await h.buckets.PARTS.put("t/mbx_1/upload/up_old", "x");
    await recordGcIntent(
      h.env,
      {
        bucket: "PARTS",
        key: "t/mbx_1/upload/up_old",
        ownerKind: "mailbox",
        ownerId: "mbx_1",
        reason: "upload-failed",
      },
      Date.now() - GC_DELAY_MS - 1,
    );
    await handleScheduled(
      {
        cron: DAILY_CRON,
        scheduledTime: Date.now(),
        noRetry: () => undefined,
      } as ScheduledController,
      h.env,
    );
    expect(seen).toContain("blobgc.deleted");
    expect(seen).not.toContain("reconcile.catalog");
    expect(h.buckets.PARTS.objects.has("t/mbx_1/upload/up_old")).toBe(false);
  });
});

describe("restore restart wait", () => {
  it("[§12] waits for a new instance epoch and refuses to proceed if the restart is never observed", async () => {
    const { awaitRestart } = await import("../src/restore.ts");
    let calls = 0;
    await awaitRestart(
      async () => (++calls < 3 ? "old" : "new"),
      "old",
      1_000,
      async () => undefined,
    );
    expect(calls).toBe(3);
    let rejectedCalls = 0;
    await awaitRestart(
      async () => {
        if (++rejectedCalls < 2) throw new Error("aborting");

        return "new";
      },
      "old",
      1_000,
      async () => undefined,
    );
    await expect(
      awaitRestart(
        async () => "old",
        "old",
        5,
        (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 2))),
      ),
    ).rejects.toThrow("did not restart");
  });
});

describe("[§13 Stage 0] Workflow checkpoint/resume", () => {
  (globalThis as { FixedLengthStream?: unknown }).FixedLengthStream = class extends (
    TransformStream
  ) {
    constructor(_length: number) {
      super();
    }
  };

  /**
   * A durable-step runtime stand-in: completed steps are checkpointed as JSON (what Workflows
   * persists); a checkpointed step returns its stored value without running its body again.
   * `crashAt` simulates the isolate dying just before that step starts.
   */
  const runtime = () => {
    const checkpoints = new Map<string, unknown>();
    const executed: Array<string> = [];
    let crashAt: string | null = null;

    const step = {
      do: async (name: string, ...args: ReadonlyArray<unknown>) => {
        if (checkpoints.has(name)) return checkpoints.get(name);

        if (name === crashAt) throw new Error(`runtime crashed before ${name}`);
        executed.push(name);
        const value = await (args.at(-1) as () => Promise<StepResult>)();
        checkpoints.set(name, JSON.parse(JSON.stringify(value)));

        return checkpoints.get(name);
      },
      sleep: async () => undefined,
    };

    return { step, checkpoints, executed, crashBefore: (name: string | null) => (crashAt = name) };
  };

  let h: Harness;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2026, 8, 25, 12));
    h = makeHarness();
  });
  afterEach(() => vi.useRealTimers());

  it("a run that crashes mid-way resumes from its checkpoints: completed steps' side effects never repeat", async () => {
    const ana = await new ControlDirectory(h.env.DIRECTORY, kernelClock).provisionPersonalAccount({
      address: "ana@bye.test",
      displayName: "ana",
    });

    for (const i of [1, 2]) {
      await handleInbound(
        inboundMessage(
          "bob@example.net",
          "ana@bye.test",
          rfc822({
            from: "bob@example.net",
            to: "ana@bye.test",
            subject: `M${i}`,
            body: "hi",
            messageId: `m${i}@example.net`,
          }),
        ),
        h.env,
      );
    }

    await h.drain();

    const sent: Array<number> = [];
    const index = mockAs<{ sendBatch(b: ReadonlyArray<unknown>): Promise<void> }>(h.env.INDEX);
    const realSend = index.sendBatch.bind(index);
    index.sendBatch = async (batch) => (sent.push(batch.length), realSend(batch));
    let clears = 0;

    const shards = h.env.SEARCH_SHARDS as {
      getByName(n: string): { clear(): Promise<void> };
    };

    const realGet = shards.getByName.bind(shards);
    shards.getByName = (n: string) => {
      const stub = realGet(n);

      return new Proxy(stub, {
        get: (t, p) => (p === "clear" ? async () => (clears++, t.clear()) : t[p as keyof typeof t]),
      });
    };

    const rt = runtime();

    const event = {
      payload: { v: 1, mailboxId: ana.mailboxId },
      instanceId: "ri-crash",
      timestamp: new Date(),
    };

    const workflow = new ReindexWorkflow({} as never, h.env);
    rt.crashBefore("v1:other-docs");
    await expect(workflow.run(event as never, rt.step as never)).rejects.toThrow(/crashed/);
    expect(rt.executed).toEqual(["v1:clear", "v1:deliveries:0"]);
    expect({ clears, sent }).toEqual({ clears: 1, sent: [2] });
    // The checkpoints hold the Schema encoding, not live objects.
    expect(rt.checkpoints.get("v1:deliveries:0")).toEqual({ next: null, count: 2 });

    // Restart: same instance, same checkpoint store, code redeployed (a fresh Workflow object).
    rt.crashBefore(null);

    const result = (await new ReindexWorkflow({} as never, h.env).run(
      event as never,
      rt.step as never,
    )) as { enqueued: number };

    expect(rt.executed).toEqual(["v1:clear", "v1:deliveries:0", "v1:other-docs", "v1:pin-spaces"]);
    expect({ clears, sent }).toEqual({ clears: 1, sent: [2] }); // nothing before the crash ran twice
    expect(result.enqueued).toBe(2);
  });

  it("a legacy instance with no `v` resumes; a payload from an unknown future version is refused", async () => {
    const rt = runtime();

    const ana = await new ControlDirectory(h.env.DIRECTORY, kernelClock).provisionPersonalAccount({
      address: "ana@bye.test",
      displayName: "ana",
    });

    await expect(
      new ReindexWorkflow({} as never, h.env).run(
        { payload: { mailboxId: ana.mailboxId } } as never,
        rt.step as never,
      ),
    ).resolves.toMatchObject({ v: 1 });
    await expect(
      new ReindexWorkflow({} as never, h.env).run(
        { payload: { v: 9, mailboxId: ana.mailboxId } } as never,
        runtime().step as never,
      ),
    ).rejects.toThrow(/v=9/);
  });
});

describe("catalog, metadata probe and propagation", () => {
  (globalThis as { FixedLengthStream?: unknown }).FixedLengthStream = class extends (
    TransformStream
  ) {
    constructor(_length: number) {
      super();
    }
  };

  const ctx = executionContext;

  let n = 0;
  const cmdId = () => `cmd_oc_${(++n).toString(36).padStart(16, "0")}`;

  interface Account {
    readonly userId: string;
    readonly mailboxId: string;
    readonly calendarId: string;
    readonly organizationId: string;
    readonly token: string;
    readonly sessionId: string;
  }

  const signup = async (h: Harness, address: string): Promise<Account> => {
    const account = await new ControlDirectory(
      h.env.DIRECTORY,
      kernelClock,
    ).provisionPersonalAccount({ address, displayName: address.split("@")[0]! });

    await h.env.CALENDARS.getByName(account.calendarId).provision({
      ownerId: account.userId,
      selfAddresses: [address],
      defaultZone: "UTC",
    });

    const session = await new ControlAuth(
      h.env.DIRECTORY,
      kernelClock,
      await authConfig(h.env),
    ).issueSession(account.userId, "t", true);

    const row = await h.d1
      .prepare("SELECT id FROM sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT 1")
      .bind(account.userId)
      .first<{ id: string }>();

    return {
      userId: account.userId,
      mailboxId: account.mailboxId,
      calendarId: account.calendarId,
      organizationId: account.organizationId,
      token: session.token,
      sessionId: row!.id,
    };
  };

  const call = async <JsonValue>(
    h: Harness,
    a: Account | null,
    method: string,
    path: string,
    json?: JsonValue,
    headers: Record<string, string> = {},
  ) => {
    const hdrs = new Headers();

    if (a) hdrs.set("cookie", `__Host-session=${a.token}`);

    if (method !== "GET") hdrs.set("origin", h.env.APP_ORIGIN);

    if (json !== undefined) hdrs.set("content-type", "application/json");

    for (const [k, v] of Object.entries(headers)) hdrs.set(k, v);

    const r = await handleFetch(
      new Request(
        `${h.env.APP_ORIGIN}${path}`,
        json !== undefined
          ? { method, headers: hdrs, body: JSON.stringify(json) }
          : { method, headers: hdrs },
      ),
      h.env,
      ctx,
    );

    return { status: r.status, body: (await r.json().catch(() => null)) as any };
  };

  const allow = (h: Harness, a: Account) =>
    call(h, a, "POST", `/v1/mailboxes/${a.mailboxId}/commands`, {
      commandId: cmdId(),
      _tag: "SetPolicy",
      kind: "domain",
      subject: "example.net",
      policy: {
        decision: "allowed",
        destination: "imbox",
        labels: [],
        bundle: false,
        notify: false,
      },
    });

  const receive = async (
    h: Harness,
    from: string,
    to: string,
    subject: string,
    messageId: string,
    extra = "",
    tolerateRetries = false,
  ) => {
    await handleInbound(
      inboundMessage(
        from,
        to,
        rfc822({
          from,
          to,
          subject,
          body: "hi",
          messageId,
          extraHeaders: extra,
        }),
      ),
      h.env,
    );
    await h.drain(20, { tolerateRetries });
  };

  /** Run the Cron reconciler over every catalog shard (one full rotation). */
  const fullRotation = async (h: Harness, start: number) => {
    const totals = { byKind: {} as Record<string, number>, failures: 0 };

    for (let i = 0; i < CATALOG_SHARDS / SHARDS_PER_RUN; i++) {
      const r = await reconcileCatalog(h.env, start + i * 5 * 60_000);
      totals.failures += r.failures;

      for (const [k, v] of Object.entries(r.byKind)) totals.byKind[k] = (totals.byKind[k] ?? 0) + v;
    }

    return totals;
  };

  let h: Harness;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2026, 8, 26, 12));
    h = makeHarness();
  });
  afterEach(() => vi.useRealTimers());

  it("[§6 row 3] spaces and World authors are catalogued, and one rotation reconciles every kind without failures", async () => {
    const ana = await signup(h, "ana@bye.test");

    const created = await call(h, ana, "POST", "/v1/spaces", {
      organizationId: ana.organizationId,
    });

    expect(created.status).toBe(201);
    expect(
      (
        await call(h, ana, "POST", "/v1/world/posts", {
          from: "ana@bye.test",
          title: "Hi",
          html: "<p>hi</p>",
          text: "hi",
        })
      ).status,
    ).toBe(201);

    const kinds = (
      await h.d1
        .prepare("SELECT kind, id FROM resource_catalog ORDER BY kind")
        .all<{ kind: string; id: string }>()
    ).results;

    expect(kinds).toEqual(
      expect.arrayContaining([
        { kind: "space", id: created.body.spaceId },
        { kind: "world", id: "ana" },
      ]),
    );

    const totals = await fullRotation(h, Date.now());
    expect(totals.failures).toBe(0);
    expect(totals.byKind).toMatchObject({ mailbox: 1, calendar: 1, space: 1, world: 1 });
  });

  it("[§12] the Cron probe records each mailbox's metadata size and level; 50%/70% alert and flag rollover", async () => {
    const ana = await signup(h, "ana@bye.test");
    await fullRotation(h, Date.now());

    const row = await h.d1
      .prepare("SELECT bytes, level FROM authority_storage WHERE kind = 'mailbox' AND id = ?")
      .bind(ana.mailboxId)
      .first<{ bytes: number; level: string }>();

    expect(row?.level).toBe("ok");
    expect(row?.bytes).toBeGreaterThan(0);
    expect(
      await reportMetadataHealth(
        h.env,
        ana.mailboxId,
        Math.ceil(MAILBOX_METADATA_BUDGET_BYTES * 0.55),
      ),
    ).toBe("alert");
    expect(
      await reportMetadataHealth(
        h.env,
        ana.mailboxId,
        Math.ceil(MAILBOX_METADATA_BUDGET_BYTES * 0.75),
      ),
    ).toBe("rollover");

    const flagged = await h.d1
      .prepare("SELECT level FROM authority_storage WHERE id = ?")
      .bind(ana.mailboxId)
      .first<{ level: string }>();

    expect(flagged?.level).toBe("rollover");
  });

  it("[§6 row 6] a propagation whose message is lost stays visibly pending, then the Cron replay applies it", async () => {
    const ana = await signup(h, "ana@bye.test");
    await allow(h, ana);
    await receive(h, "bob@example.net", "ana@bye.test", "Plan", "plan-1@example.net");
    const imbox = await call(h, ana, "GET", `/v1/mailboxes/${ana.mailboxId}/views/imbox`);
    const threadId = imbox.body.items[0].threadId as string;

    const created = await call(h, ana, "POST", "/v1/spaces", {
      organizationId: ana.organizationId,
    });

    const spaceId = created.body.spaceId as string;
    const space = h.env.SHARED_SPACES.getByName(`space:${spaceId}`);

    const shared = (await space.shareThread({
      actorId: ana.userId,
      sourceMailboxId: ana.mailboxId,
      sourceThreadId: threadId,
      subject: "Plan",
      messages: [],
      grantees: [],
      includeFuture: true,
    })) as { ok: boolean; value: string };

    await new ControlSharedRegistry(h.env.DIRECTORY, kernelClock).registerSharedThread({
      mailboxId: ana.mailboxId,
      threadId,
      spaceId,
      sharedThreadId: shared.value,
      includeFuture: true,
    });

    // The space is briefly unavailable and the queue message is then lost (dead-lettered).
    const instance = h.namespaces.SHARED_SPACES.instance(`space:${spaceId}`) as {
      appendReply: (...a: Array<unknown>) => void;
    };

    const real = instance.appendReply.bind(instance);
    instance.appendReply = () => {
      throw new Error("space unavailable");
    };

    await receive(
      h,
      "bob@example.net",
      "ana@bye.test",
      "Re: Plan",
      "plan-2@example.net",
      "In-Reply-To: <plan-1@example.net>",
      true,
    );
    expect(await pendingPropagation(h.env, spaceId)).toBe(1);
    const syncing = await call(h, ana, "GET", `/v1/spaces/${spaceId}/threads/${shared.value}`);
    expect(syncing.body.pendingPropagation).toBe(1);
    expect(syncing.body.messages ?? []).toHaveLength(0);

    instance.appendReply = real;
    // Too recent to replay; after the delay the reconciler re-derives it from source state.
    expect((await replayPendingPropagation(h.env, Date.now())).replayed).toBe(0);
    expect(await replayPendingPropagation(h.env, Date.now() + 11 * 60_000)).toEqual({
      replayed: 1,
      failed: 0,
    });
    const applied = await call(h, ana, "GET", `/v1/spaces/${spaceId}/threads/${shared.value}`);
    expect(applied.body.pendingPropagation).toBe(0);
    expect(applied.body.messages.map((m: { subject: string }) => m.subject)).toEqual(["Re: Plan"]);
    // A second replay is a no-op (idempotent by event ID).
    expect((await replayPendingPropagation(h.env, Date.now() + 30 * 60_000)).replayed).toBe(0);
  });
});

describe("tombstone replay scope", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2026, 8, 25, 12));
  });
  afterEach(() => vi.useRealTimers());

  it("[§12] a single-object restore replays only that object's tombstones; the daily sweep skips verified ones", async () => {
    const h = makeHarness();

    const insert = (kind: string, id: string) =>
      h.d1
        .prepare(
          "INSERT INTO erasure_tombstones (resource_kind, resource_id, erased_at) VALUES (?, ?, ?)",
        )
        .bind(kind, id, Date.now())
        .run();

    await insert("mailbox", "mbx_a");
    await insert("mailbox", "mbx_b");
    await insert("space-member", "spc_1:usr_x");
    await insert("space-member", "spc_10:usr_y");
    expect((await replayTombstonesFor(h.env, "mailbox", "mbx_a")).replayed).toBe(1);
    expect((await replayTombstonesFor(h.env, "space", "spc_1")).replayed).toBe(1);
    // Daily: only the two never-verified tombstones remain; a second sweep does nothing.
    expect((await replayUnverifiedTombstones(h.env)).replayed).toBe(2);
    expect((await replayUnverifiedTombstones(h.env)).replayed).toBe(0);
  });
});

describe("shared propagation cleanup", () => {
  interface Account {
    readonly userId: string;
    readonly mailboxId: string;
    readonly calendarId: string;
    readonly token: string;
  }

  const signup = async (h: Harness, address: string): Promise<Account> => {
    const account = await new ControlDirectory(
      h.env.DIRECTORY,
      kernelClock,
    ).provisionPersonalAccount({ address, displayName: address.split("@")[0]! });

    await h.env.CALENDARS.getByName(account.calendarId).provision({
      ownerId: account.userId,
      selfAddresses: [address],
      defaultZone: "UTC",
    });

    const session = await new ControlAuth(
      h.env.DIRECTORY,
      kernelClock,
      await authConfig(h.env),
    ).issueSession(account.userId, "t", true);

    return {
      userId: account.userId,
      mailboxId: account.mailboxId,
      calendarId: account.calendarId,
      token: session.token,
    };
  };

  let h: Harness;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2026, 8, 26, 12));
    h = makeHarness();
  });
  afterEach(() => vi.useRealTimers());

  it("[§6] a pending propagation whose target no longer applies is dropped, not replayed forever", async () => {
    const ana = await signup(h, "ana@bye.test");
    const now = Date.now();
    await h.d1
      .prepare(
        `INSERT INTO shared_propagation (event_key, space_id, kind, shared_thread_id, mailbox_id, thread_id, delivery_id, state, attempts, created_at, updated_at)
         VALUES ('extension:spc_old:dlv_1', 'spc_old', 'extension', NULL, ?, 'thr_1', 'dlv_1', 'pending', 3, ?, ?)`,
      )
      .bind(ana.mailboxId, now, now)
      .run();
    // The mailbox is no longer an extension of any space and the thread isn't shared.
    await propagateDelivery(h.env, ana.mailboxId, "thr_1", "dlv_1");

    const row = await h.d1
      .prepare("SELECT state FROM shared_propagation WHERE event_key = 'extension:spc_old:dlv_1'")
      .first<{ state: string }>();

    expect(row?.state).toBe("dropped");
  });

  it("[§6] with several live targets, only pending rows of this delivery outside the key list are dropped", async () => {
    const ana = await signup(h, "ana@bye.test");
    await handleInbound(
      inboundMessage(
        "bob@example.net",
        "ana@bye.test",
        rfc822({
          from: "bob@example.net",
          to: "ana@bye.test",
          subject: "Shared",
          body: "hi",
          messageId: "sp1@example.net",
        }),
      ),
      h.env,
    );
    await h.drain();

    const store = mockAs<{
      store: { ctx: { sql: { all<T>(sql: string, ...p: Array<unknown>): Array<T> } } };
    }>(h.namespaces.MAILBOXES.instance(ana.mailboxId)).store;

    const [msg] = store.ctx.sql.all<{ thread_id: string; delivery_id: string }>(
      "SELECT thread_id, delivery_id FROM deliveries",
    );

    const { thread_id: threadId, delivery_id: deliveryId } = msg!;
    // A live extension target and two live include-future shares: three keys bind as one list.
    const registry = new ControlSharedRegistry(h.env.DIRECTORY, kernelClock);
    await registry.registerExtension(ana.mailboxId, "spc_live", "ext@bye.test");
    const now = Date.now();

    for (const [spaceId, sharedThreadId] of [
      ["spc_a", "sth_a"],
      ["spc_b", "sth_b"],
    ] as const)
      await registry.registerSharedThread({
        mailboxId: ana.mailboxId,
        threadId,
        spaceId,
        sharedThreadId,
        includeFuture: true,
      });

    const insert = (
      key: string,
      space: string,
      mailboxId: string,
      delivery: string,
      state: string,
    ) =>
      h.d1
        .prepare(
          `INSERT INTO shared_propagation (event_key, space_id, kind, shared_thread_id, mailbox_id, thread_id, delivery_id, state, attempts, created_at, updated_at)
           VALUES (?, ?, 'reply', NULL, ?, ?, ?, ?, 0, ?, ?)`,
        )
        .bind(key, space, mailboxId, threadId, delivery, state, now, now)
        .run();

    await insert(`reply:spc_a:${deliveryId}`, "spc_a", ana.mailboxId, deliveryId, "pending");
    await insert(`reply:spc_b:${deliveryId}`, "spc_b", ana.mailboxId, deliveryId, "pending");
    await insert(`reply:spc_gone:${deliveryId}`, "spc_gone", ana.mailboxId, deliveryId, "pending");
    await insert(`reply:spc_done:${deliveryId}`, "spc_done", ana.mailboxId, deliveryId, "applied");
    await insert("reply:spc_gone:dlv_other", "spc_gone", ana.mailboxId, "dlv_other", "pending");
    await insert(`reply:spc_gone:${deliveryId}:x`, "spc_gone", "mbx_other", deliveryId, "pending");
    // Live targets are applied (never dropped by the key-list filter); a failing extension is tolerated.
    await propagateDelivery(h.env, ana.mailboxId, threadId, deliveryId).catch(() => undefined);

    const states = Object.fromEntries(
      (
        await h.d1
          .prepare("SELECT event_key, state FROM shared_propagation")
          .all<{ event_key: string; state: string }>()
      ).results.map((r) => [r.event_key, r.state]),
    );

    expect(states[`reply:spc_gone:${deliveryId}`]).toBe("dropped");
    expect(states[`reply:spc_a:${deliveryId}`]).toBe("applied");
    expect(states[`reply:spc_b:${deliveryId}`]).toBe("applied");
    // The extension target was recorded too (its unknown space is a final refusal, not the query).
    expect(states).toHaveProperty([`extension:spc_live:${deliveryId}`]);
    expect(states[`reply:spc_done:${deliveryId}`]).toBe("applied");
    expect(states["reply:spc_gone:dlv_other"]).toBe("pending");
    expect(states[`reply:spc_gone:${deliveryId}:x`]).toBe("pending");
  });
});

describe("blob GC for sent bodies", () => {
  (globalThis as { FixedLengthStream?: unknown }).FixedLengthStream = class extends (
    TransformStream
  ) {
    constructor(_length: number) {
      super();
    }
  };

  /** Run due mailbox jobs and queues with the provider transport mocked; returns submitted bodies. */

  let h: Harness;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2026, 8, 25, 12));
    h = makeHarness();
  });
  afterEach(() => vi.useRealTimers());

  it("[§12] blob GC deletes a sent message's stored body with its original", async () => {
    await h.buckets.ORIGINALS.put("t/mbx_gone/out/snd_1.eml", "raw");
    await h.buckets.PARTS.put(
      "t/mbx_gone/out/snd_1.json",
      JSON.stringify({ text: "secret", html: null, remoteImages: 0, blockedTrackers: 0 }),
    );
    await recordGcIntent(h.env, {
      bucket: "ORIGINALS",
      key: "t/mbx_gone/out/snd_1.eml",
      ownerKind: "mailbox",
      ownerId: "mbx_gone",
      reason: "retention",
    });
    await sweepBlobGc(h.env, Date.now() + GC_DELAY_MS);
    expect(h.buckets.ORIGINALS.objects.has("t/mbx_gone/out/snd_1.eml")).toBe(false);
    expect(h.buckets.PARTS.objects.has("t/mbx_gone/out/snd_1.json")).toBe(false);
  });
});

describe("blob pins for shared content", () => {
  (globalThis as { FixedLengthStream?: unknown }).FixedLengthStream = class extends (
    TransformStream
  ) {
    constructor(_length: number) {
      super();
    }
  };

  interface Account {
    readonly userId: string;
    readonly mailboxId: string;
    readonly token: string;
    readonly sessionId: string;
  }

  const signup = async (h: Harness, address: string): Promise<Account> => {
    const account = await new ControlDirectory(
      h.env.DIRECTORY,
      kernelClock,
    ).provisionPersonalAccount({ address, displayName: address.split("@")[0]! });

    const session = await new ControlAuth(
      h.env.DIRECTORY,
      kernelClock,
      await authConfig(h.env),
    ).issueSession(account.userId, "t", true);

    const row = await h.d1
      .prepare("SELECT id FROM sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT 1")
      .bind(account.userId)
      .first<{ id: string }>();

    return {
      userId: account.userId,
      mailboxId: account.mailboxId,
      token: session.token,
      sessionId: row!.id,
    };
  };

  /** Run due mailbox jobs and queues with the provider transport mocked; returns submitted bodies. */

  let h: Harness;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2026, 8, 25, 12));
    h = makeHarness();
  });
  afterEach(() => vi.useRealTimers());

  it("[§12] content copied into a shared space is pinned, so the owner's purge never collects it", async () => {
    const key = "t/mbx_owner/orig/ing_shared.eml";
    await h.buckets.ORIGINALS.put(key, "raw");
    await h.buckets.PARTS.put(
      "t/mbx_owner/body/ing_shared.json",
      JSON.stringify({ text: "plan", html: null, remoteImages: 0, blockedTrackers: 0 }),
    );
    const space = h.env.SHARED_SPACES.getByName("space:spc_pin");
    expect(
      (
        await space.initSpace({
          spaceId: "spc_pin",
          kind: "team",
          organizationId: "org_1",
          ownerId: "usr_owner",
        })
      ).ok,
    ).toBe(true);

    const message = {
      messageRef: "dlv_1",
      from: { address: "bob@example.net" },
      to: [],
      cc: [],
      subject: "Plan",
      snippet: "plan",
      contentKey: key,
      sentAt: Date.now(),
    };

    expect(
      (
        await space.shareThread({
          actorId: "usr_owner",
          sourceMailboxId: "mbx_owner",
          sourceThreadId: "thr_1",
          subject: "Plan",
          messages: [message],
          grantees: [],
          includeFuture: false,
        })
      ).ok,
    ).toBe(true);
    await h.drain();

    const pin = await h.d1
      .prepare(
        "SELECT holder_kind, holder_id FROM blob_pins WHERE bucket = 'ORIGINALS' AND object_key = ?",
      )
      .bind(key)
      .first();

    expect(pin).toEqual({ holder_kind: "space", holder_id: "spc_pin" });
    // The owner trashes and purges the source: the delayed sweep must keep what the space reads.
    await recordGcIntent(h.env, {
      bucket: "ORIGINALS",
      key,
      ownerKind: "mailbox",
      ownerId: "mbx_owner",
      reason: "retention",
    });
    await recordGcIntent(h.env, {
      bucket: "PARTS",
      key: "t/mbx_owner/body/ing_shared.json",
      ownerKind: "mailbox",
      ownerId: "mbx_owner",
      reason: "retention",
    });
    await sweepBlobGc(h.env, Date.now() + GC_DELAY_MS);
    expect(h.buckets.ORIGINALS.objects.has(key)).toBe(true);
    expect(h.buckets.PARTS.objects.has("t/mbx_owner/body/ing_shared.json")).toBe(true);
  });

  it("[§12] a reindex run backfills pins for content shared before spaces pinned their copies", async () => {
    const ana = await signup(h, "ana@bye.test");
    const mine = `t/${ana.mailboxId}/orig/ing_old.eml`;
    const theirs = "t/mbx_other/orig/ing_x.eml";
    const space = h.env.SHARED_SPACES.getByName("space:spc_old");
    await space.initSpace({
      spaceId: "spc_old",
      kind: "team",
      organizationId: "org_1",
      ownerId: ana.userId,
    });

    const msg = (ref: string, contentKey: string) => ({
      messageRef: ref,
      from: { address: "bob@example.net" },
      to: [],
      cc: [],
      subject: "Old",
      snippet: "old",
      contentKey,
      sentAt: Date.now(),
    });

    await space.shareThread({
      actorId: ana.userId,
      sourceMailboxId: ana.mailboxId,
      sourceThreadId: "thr_old",
      subject: "Old",
      messages: [msg("dlv_a", mine), msg("dlv_b", theirs)],
      grantees: [],
      includeFuture: false,
    });
    await h.drain();
    // Simulate data shared before pinning existed.
    await h.d1.prepare("DELETE FROM blob_pins").run();
    const { ControlSharedRegistry } = await import("@bye/platform-cloudflare");
    await new ControlSharedRegistry(h.env.DIRECTORY, kernelClock).registerSharedThread({
      mailboxId: ana.mailboxId,
      threadId: "thr_old",
      spaceId: "spc_old",
      sharedThreadId: "sth_old",
      includeFuture: false,
    });

    const { ReindexWorkflow } = await import("../src/workflows/reindex.ts");

    const step = {
      do: async (_n: string, ...args: ReadonlyArray<unknown>) =>
        (args.at(-1) as () => Promise<StepResult>)(),
    };

    const result = (await new ReindexWorkflow({} as never, h.env).run(
      {
        payload: { v: 1, mailboxId: ana.mailboxId },
        instanceId: "ri-1",
        timestamp: new Date(),
      } as never,
      step as never,
    )) as { pinned: number };

    expect(result.pinned).toBe(1);

    const pins = (
      await h.d1
        .prepare("SELECT object_key, holder_id FROM blob_pins ORDER BY object_key")
        .all<{ object_key: string; holder_id: string }>()
    ).results;

    // Only this mailbox's keys: another mailbox's content is pinned by that mailbox's own reindex.
    expect(pins).toEqual([{ object_key: mine, holder_id: "spc_old" }]);
  });

  it("[§12] reindex pin backfill fails the step (to retry) when a space can't list its keys", async () => {
    const ana = await signup(h, "ana@bye.test");
    const { ControlSharedRegistry } = await import("@bye/platform-cloudflare");
    await new ControlSharedRegistry(h.env.DIRECTORY, kernelClock).registerSharedThread({
      mailboxId: ana.mailboxId,
      threadId: "thr_x",
      spaceId: "spc_down",
      sharedThreadId: "sth_x",
      includeFuture: false,
    });
    const spaces = h.env.SHARED_SPACES as { getByName: (n: string) => object };
    const original = spaces.getByName.bind(spaces);
    spaces.getByName = (name: string) =>
      name.endsWith("spc_down")
        ? { contentKeys: async () => ({ ok: false, error: { code: "unavailable" } }) }
        : original(name);
    const { ReindexWorkflow } = await import("../src/workflows/reindex.ts");

    const step = {
      do: async (_n: string, ...args: ReadonlyArray<unknown>) =>
        (args.at(-1) as () => Promise<StepResult>)(),
    };

    await expect(
      new ReindexWorkflow({} as never, h.env).run(
        {
          payload: { v: 1, mailboxId: ana.mailboxId },
          instanceId: "ri-2",
          timestamp: new Date(),
        } as never,
        step as never,
      ),
    ).rejects.toThrow(/content keys unavailable/);
    spaces.getByName = original;
  });
});
