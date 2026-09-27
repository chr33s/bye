import { describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import { dispatch, MailTransport, TransportFailure, type Submission } from "@bye/application";
import {
  applyMailboxCommand,
  applyMailboxRead,
  MailboxJobStoreLive,
  type MailboxSendResult,
} from "@bye/platform-cloudflare";
import { cmd, deliveryFixture, makeTestMailbox, summaryFixture } from "@bye/testing";
import { Rejection } from "@bye/platform-cloudflare";

const setup = () => {
  const m = makeTestMailbox();
  const deliver = (
    over: Parameters<typeof summaryFixture>[0] = {},
    extra: Parameters<typeof deliveryFixture>[2] = {},
  ) => {
    m.clock.advance(1000);
    return m.store.ingest.commitDelivery(deliveryFixture(m.clock, summaryFixture(over), extra));
  };
  const draft = (to = "bob@example.com", extra: Record<string, unknown> = {}) =>
    m.store.drafts.createDraft({
      content: {
        to: [{ name: undefined, address: to }],
        cc: [],
        bcc: [],
        subject: "Hi",
        text: "body",
        attachments: [],
        ...extra,
      },
    });
  const queued = (r: MailboxSendResult) => {
    if (r._tag !== "Queued") throw new Error(`expected Queued, got ${r._tag}`);
    return r;
  };
  const ready = (ids: ReadonlyArray<string>) => {
    m.clock.advance(60_000);
    m.store.runDueJobs(m.clock.now());
    return ids;
  };
  return { ...m, deliver, draft, queued, ready };
};

const transportLayer = (
  submit: (
    s: Submission,
  ) => Effect.Effect<{ providerId: string; wireMessageId?: string }, TransportFailure>,
) => Layer.succeed(MailTransport, MailTransport.of({ submit }));

describe("drafts and composer", () => {
  it("[E17] autosave uses optimistic revisions; a stale device gets a conflict, not last-write-wins", () => {
    const m = setup();
    const { draftId } = m.draft();
    const content = m.store.drafts.draft(draftId)!.content;
    expect(m.store.drafts.saveDraft(draftId, 1, { ...content, text: "device A" })).toEqual({
      _tag: "Saved",
      revision: 2,
    });
    const stale = m.store.drafts.saveDraft(draftId, 1, {
      ...content,
      text: "device B offline edit",
    });
    expect(stale._tag).toBe("Conflict");
    expect(m.store.drafts.draft(draftId)!.content.text).toBe("device A");
  });

  it("[E17] reply, reply-all and forward drafts carry recipients, threading headers and identity", () => {
    const m = setup();
    m.store.screener.screen([{ sender: "alice@example.com", decision: "allow" }]);
    const t = m.deliver({
      messageIdHeader: "orig@x",
      cc: [
        { name: "Carol", address: "carol@example.com" },
        { name: "Me", address: "me@bye.test" },
      ],
    });
    const deliveries = m.store.views.getThread(t.threadId).deliveries;
    const reply = m.store.drafts.draft(
      m.store.drafts.createReplyDraft(t.threadId, "reply", deliveries),
    )!;
    expect(reply.content).toMatchObject({
      subject: "Re: Hello",
      inReplyTo: "orig@x",
      references: ["orig@x"],
    });
    const all = m.store.drafts.draft(
      m.store.drafts.createReplyDraft(t.threadId, "reply-all", deliveries),
    )!;
    expect(all.content.cc.map((a) => a.address)).toEqual(["carol@example.com"]);
    const fwd = m.store.drafts.draft(
      m.store.drafts.createReplyDraft(t.threadId, "forward", deliveries),
    )!;
    expect(fwd.content).toMatchObject({
      subject: "Fwd: Hello",
      to: [],
      forwardOf: deliveries[0]!.deliveryId,
    });
  });
});

describe("send intents", () => {
  it("[E18] undo window is a real pre-submission delay; cancellation before Submitting succeeds", () => {
    const m = setup();
    const { draftId } = m.draft();
    const sent = m.queued(m.store.sends.send(draftId, { expectedRevision: 1 }));
    expect(m.store.sends.job(sent.sendJobIds[0]!)!.state).toBe("undo-window");
    expect(m.store.sends.cancelSend(sent.sendJobIds[0]!)).toEqual({ _tag: "Cancelled" });
    expect(m.store.drafts.draft(draftId)!.state).toBe("open");
    m.clock.advance(60_000);
    expect(m.store.runDueJobs(m.clock.now()).ran).toBe(0);
    expect(m.store.sends.claim(sent.sendJobIds[0]!)).toBeNull();
  });

  it("[E18] cancellation racing dispatch: once Submitting wins, cancel reports TooLate", () => {
    const m = setup();
    const { draftId } = m.draft();
    const [id] = m.ready(m.queued(m.store.sends.send(draftId, { expectedRevision: 1 })).sendJobIds);
    expect(m.store.sends.claim(id!)).not.toBeNull();
    expect(m.store.sends.cancelSend(id!)).toEqual({ _tag: "TooLate", state: "submitting" });
  });

  it("[E18] Send Later schedules; double click with same or different keys yields one intent", () => {
    const m = setup();
    const { draftId } = m.draft();
    const at = m.clock.now() + 86_400_000;
    const key = cmd();
    const send = (commandId: string) =>
      m.queued(
        applyMailboxCommand(m.store, {
          _tag: "Send",
          commandId,
          draftId,
          expectedRevision: 1,
          sendAt: at,
        }) as MailboxSendResult,
      );
    const a = send(key);
    const b = send(key);
    const c = send(cmd());
    expect(b.sendJobIds).toEqual(a.sendJobIds);
    expect(c).toMatchObject({ sendJobIds: a.sendJobIds, deduplicated: true });
    expect(m.store.sends.jobs()).toHaveLength(1);
    expect(m.store.sends.job(a.sendJobIds[0]!)).toMatchObject({ state: "scheduled", dueAt: at });
  });

  it("[E18] two devices on one draft: a stale revision cannot send", () => {
    const m = setup();
    const { draftId } = m.draft();
    const content = m.store.drafts.draft(draftId)!.content;
    m.store.drafts.saveDraft(draftId, 1, { ...content, text: "edited on phone" });
    expect(m.store.sends.send(draftId, { expectedRevision: 1 })).toEqual({
      _tag: "Conflict",
      currentRevision: 2,
    });
  });

  it("[E18] same-reply-to-many creates independent messages; per-recipient outcomes tolerate event reordering", () => {
    const m = setup();
    const { draftId } = m.store.drafts.createDraft({
      content: {
        to: [
          { name: undefined, address: "a@x.test" },
          { name: undefined, address: "b@x.test" },
        ],
        cc: [],
        bcc: [{ name: undefined, address: "c@x.test" }],
        subject: "s",
        text: "t",
        attachments: [],
      },
    });
    const ids = m.queued(
      m.store.sends.send(draftId, { expectedRevision: 1, individually: true }),
    ).sendJobIds;
    expect(ids).toHaveLength(3);
    expect(ids.map((id) => m.store.sends.job(id)!.recipients)).toEqual([
      ["a@x.test"],
      ["b@x.test"],
      ["c@x.test"],
    ]);
    m.ready(ids);
    const id = ids[0]!;
    m.store.sends.claim(id);
    m.store.sends.accepted(id, { providerId: "p" });
    m.store.sends.recordRecipientEvent("e2", id, "a@x.test", "bounced", "550 mailbox unknown");
    m.store.sends.recordRecipientEvent("e1", id, "a@x.test", "deferred");
    m.store.sends.recordRecipientEvent("e2", id, "a@x.test", "delivered");
    expect(m.store.sends.job(id)!.outcomes).toEqual([
      { address: "a@x.test", outcome: "bounced", detail: "550 mailbox unknown" },
    ]);
  });

  it("[E18] partial recipient failure is explicit per recipient", () => {
    const m = setup();
    const { draftId } = m.store.drafts.createDraft({
      content: {
        to: [
          { name: undefined, address: "ok@x.test" },
          { name: undefined, address: "bad@x.test" },
        ],
        cc: [],
        bcc: [],
        subject: "s",
        text: "t",
        attachments: [],
      },
    });
    const [id] = m.ready(m.queued(m.store.sends.send(draftId, { expectedRevision: 1 })).sendJobIds);
    m.store.sends.claim(id!);
    m.store.sends.accepted(id!, { providerId: "p" });
    m.store.sends.recordRecipientEvent("x1", id!, "ok@x.test", "delivered");
    m.store.sends.recordRecipientEvent("x2", id!, "bad@x.test", "rejected", "policy");
    expect(m.store.sends.job(id!)!.outcomes.map((o) => o.outcome)).toEqual([
      "rejected",
      "delivered",
    ]);
    expect(m.store.sends.job(id!)!.state).toBe("accepted");
  });

  it("[E18] acceptance records the sent message with visible recipients only (Bcc private) and approves recipients", () => {
    const m = setup();
    const { draftId } = m.draft("bob@example.com", {
      bcc: [{ name: undefined, address: "secret@example.com" }],
    });
    const [id] = m.ready(m.queued(m.store.sends.send(draftId, { expectedRevision: 1 })).sendJobIds);
    expect(m.store.sends.claim(id!)!.envelopeRecipients).toEqual([
      "bob@example.com",
      "secret@example.com",
    ]);
    m.store.sends.accepted(id!, { providerId: "p", wireMessageId: "wire-1@cf" });
    const thread = m.store.views.listView({ view: "everything" }).items[0]!;
    const out = m.store.views.getThread(thread.threadId).deliveries[0]!;
    expect(out).toMatchObject({ direction: "out", messageIdHeader: "wire-1@cf" });
    expect(JSON.stringify(out)).not.toContain("secret@example.com");
    // Bob's reply to the wire Message-ID joins the thread and skips the Screener.
    const reply = m.deliver({ fromAddress: "bob@example.com", inReplyTo: ["wire-1@cf"] });
    expect(reply).toMatchObject({ threadId: thread.threadId, disposition: "active" });
  });

  it("[E02] sending approves new recipients through the canonical policy write and never downgrades a block", () => {
    const m = setup();
    m.store.screener.setPolicy("address", "blocked@example.com", {
      decision: "blocked",
      destination: "imbox",
      labels: [],
      bundle: false,
      notify: false,
    });
    const { draftId } = m.store.drafts.createDraft({
      content: {
        to: [
          { name: undefined, address: "blocked@example.com" },
          { name: undefined, address: "new@example.com" },
        ],
        cc: [],
        bcc: [],
        subject: "s",
        text: "t",
        attachments: [],
      },
    });
    const [id] = m.ready(m.queued(m.store.sends.send(draftId, { expectedRevision: 1 })).sendJobIds);
    m.store.sends.claim(id!);
    m.store.sends.accepted(id!, { providerId: "p" });
    expect(m.store.ledger.policy("address", "blocked@example.com")?.decision).toBe("blocked");
    expect(m.store.ledger.policyHistory("blocked@example.com")).toHaveLength(1);
    expect(m.store.ledger.policy("address", "new@example.com")?.decision).toBe("allowed");
    // The approval is inspectable and reversible like any other decision.
    const [approval] = m.store.ledger.policyHistory("new@example.com");
    expect(approval).toMatchObject({ prior: null, next: { decision: "allowed" } });
    m.store.screener.revertPolicy(approval!.historyId);
    expect(m.store.ledger.policy("address", "new@example.com")).toBeUndefined();
    // A blocked recipient's reply stays screened out.
    expect(m.deliver({ fromAddress: "blocked@example.com" }).disposition).toBe("screened-out");
  });

  it("[E18] transport limits: oversize or too many recipients is refused with a clear error", () => {
    const m = setup();
    const { draftId } = m.draft();
    expect(() =>
      m.store.sends.send(draftId, {
        expectedRevision: 1,
        limits: { maxBytes: 1, maxRecipients: 50 },
      }),
    ).toThrow(/large-file link/);
    expect(() =>
      m.store.sends.send(draftId, {
        expectedRevision: 1,
        limits: { maxBytes: 1e9, maxRecipients: 0 },
      }),
    ).toThrow(/too many recipients/);
    // A failed command stores no receipt; the draft is still sendable.
    expect(m.store.sends.send(draftId, { expectedRevision: 1 })._tag).toBe("Queued");
  });
});

describe("dispatch through Effect v4 layers", () => {
  const run = (m: ReturnType<typeof setup>, id: string, transport: Layer.Layer<MailTransport>) =>
    Effect.runPromise(
      dispatch(id).pipe(
        Effect.provide(Layer.mergeAll(MailboxJobStoreLive(m.store.sends), transport)),
      ),
    );

  it("accepted submissions are recorded once; duplicate dispatch messages are no-ops", async () => {
    const m = setup();
    const { draftId } = m.draft();
    const [id] = m.ready(m.queued(m.store.sends.send(draftId, { expectedRevision: 1 })).sendJobIds);
    let calls = 0;
    const t = transportLayer(() => Effect.sync(() => (calls++, { providerId: "cf-1" })));
    await run(m, id!, t);
    await run(m, id!, t);
    expect(calls).toBe(1);
    expect(m.store.sends.job(id!)).toMatchObject({ state: "accepted", providerId: "cf-1" });
  });

  it("timeout after acceptance becomes Unknown and is never blindly retried", async () => {
    const m = setup();
    const { draftId } = m.draft();
    const [id] = m.ready(m.queued(m.store.sends.send(draftId, { expectedRevision: 1 })).sendJobIds);
    let calls = 0;
    const t = transportLayer(() =>
      Effect.suspend(
        () => (calls++, Effect.fail(new TransportFailure({ kind: "Unknown", detail: "timeout" }))),
      ),
    );
    await run(m, id!, t);
    await run(m, id!, t);
    expect(calls).toBe(1);
    expect(m.store.sends.job(id!)!.state).toBe("unknown");
    m.clock.advance(3_600_000);
    m.store.runDueJobs(m.clock.now());
    expect(m.store.sends.job(id!)!.state).toBe("unknown");
    // Explicit decision after inspecting provider evidence.
    m.store.sends.resolveUnknown(id!, { _tag: "Accepted", providerId: "found-in-logs" });
    expect(m.store.sends.job(id!)!.state).toBe("accepted");
  });

  it("pre-acceptance retryable failures back off via durable jobs; rejections are terminal", async () => {
    const m = setup();
    const { draftId } = m.draft();
    const [id] = m.ready(m.queued(m.store.sends.send(draftId, { expectedRevision: 1 })).sendJobIds);
    await run(
      m,
      id!,
      transportLayer(() =>
        Effect.fail(new TransportFailure({ kind: "RetryableBeforeAcceptance", detail: "503" })),
      ),
    );
    expect(m.store.sends.job(id!)!.state).toBe("ready");
    m.store.kernel.markPublished(m.store.kernel.pendingOutbox(100).map((e) => e.eventId));
    m.clock.advance(31_000);
    expect(m.store.runDueJobs(m.clock.now()).ran).toBe(1);
    expect(m.store.kernel.pendingOutbox(10).map((e) => e.topic)).toContain("dispatch");
    await run(
      m,
      id!,
      transportLayer(() => Effect.fail(new TransportFailure({ kind: "Rejected", detail: "550" }))),
    );
    expect(m.store.sends.job(id!)).toMatchObject({
      state: "rejected",
      failure: { kind: "Rejected", detail: "550" },
    });
    expect(m.store.drafts.draft(draftId)!.state).toBe("open");
  });

  it("crash after claim leaves evidence: reconciler moves stale Submitting to Unknown, not Ready", () => {
    const m = setup();
    const { draftId } = m.draft();
    const [id] = m.ready(m.queued(m.store.sends.send(draftId, { expectedRevision: 1 })).sendJobIds);
    m.store.sends.claim(id!);
    m.clock.advance(15 * 60_000);
    expect(m.store.sends.reconcileStaleSubmissions(m.clock.now(), 10 * 60_000)).toEqual([id]);
    expect(m.store.sends.job(id!)!.state).toBe("unknown");
    expect(m.store.sends.claim(id!)).toBeNull();
  });

  it("a transport defect fails dispatch and leaves the claimed job Submitting for reconciliation", async () => {
    const m = setup();
    const { draftId } = m.draft();
    const [id] = m.ready(m.queued(m.store.sends.send(draftId, { expectedRevision: 1 })).sendJobIds);
    const defect = transportLayer(() => Effect.die(new Error("bug in adapter")));
    const exit = await Effect.runPromiseExit(
      dispatch(id!).pipe(
        Effect.provide(Layer.mergeAll(MailboxJobStoreLive(m.store.sends), defect)),
      ),
    );
    expect(exit._tag).toBe("Failure");
    // The claimed job stays Submitting for reconciliation; it was not marked accepted or failed.
    expect(m.store.sends.job(id!)!.state).toBe("submitting");
  });
});

describe("identities, attachments, automation", () => {
  it("[E19] external send-as requires verification; default identity and idempotent redelivery", () => {
    const m = setup();
    const ext = m.store.identities.addIdentity({ address: "me@gmail.example", kind: "external" });
    expect(() => m.store.identities.setDefaultIdentity(ext)).toThrow(Rejection);
    const { draftId } = m.draft("x@y.test", { identityId: ext });
    expect(() => m.store.sends.send(draftId, { expectedRevision: 1 })).toThrow(/not verified/);
    // A challenge code was mailed to the external address over the transactional class.
    const challenge = m.store.sends
      .jobs("ready")
      .find((j) => j.recipients.includes("me@gmail.example"));
    expect(challenge?.trafficClass).toBe("transactional");
    expect(m.store.identities.verifyIdentity(ext, "wrong-code").verified).toBe(false);
    const code = (
      m.storage.sql
        .exec("SELECT challenge_token FROM identities WHERE identity_id = ?", ext)
        .toArray()[0] as { challenge_token: string }
    ).challenge_token;
    expect(m.store.identities.verifyIdentity(ext, code).verified).toBe(true);
    m.store.identities.setDefaultIdentity(ext);
    expect(m.store.identities.identities()[0]).toMatchObject({ identityId: ext, isDefault: true });
    const [id] = m.ready(m.queued(m.store.sends.send(draftId, { expectedRevision: 1 })).sendJobIds);
    expect(m.store.sends.claim(id!)).toMatchObject({
      from: "me@gmail.example",
      trafficClass: "external-identity",
    });

    m.store.screener.screen([{ sender: "alice@example.com", decision: "allow" }]);
    const t = m.deliver({});
    const deliveryId = m.store.views.getThread(t.threadId).deliveries[0]!.deliveryId;
    const key = cmd();
    const redeliver = () =>
      applyMailboxCommand(m.store, {
        _tag: "Redeliver",
        commandId: key,
        deliveryId,
        targetMailboxId: "mbx_other",
        mode: "copy",
      }) as { transferId: string };
    const x1 = redeliver();
    const x2 = redeliver();
    expect(x1).toEqual(x2);
    expect(m.store.kernel.pendingOutbox(100).filter((e) => e.target === "mbx_other")).toHaveLength(
      1,
    );

    // Target side: authorized transfer bypasses the Screener exactly once.
    const target = makeTestMailbox("mbx_other");
    const input = deliveryFixture(
      target.clock,
      summaryFixture({ fromAddress: "alice@example.com" }),
      { ingestionId: x1.transferId, authorizedTransfer: true },
    );
    expect(target.store.ingest.commitDelivery(input)).toMatchObject({
      disposition: "active",
      decidedBy: "transfer",
    });
    expect(target.store.ingest.commitDelivery(input).replayed).toBe(true);
  });

  it("[E20] uploads reserve quota, verify size, gate sending on scan status, and large-file links are revocable", () => {
    const m = setup();
    m.store.uploads.setQuota(10_000);
    expect(() =>
      m.store.uploads.reserveUpload({
        filename: "big.bin",
        contentType: "application/octet-stream",
        declaredSize: 20_000,
      }),
    ).toThrow(/quota/);
    const u = m.store.uploads.reserveUpload({
      filename: "a.pdf",
      contentType: "application/pdf",
      declaredSize: 5000,
    });
    m.store.uploads.recordUploadPart(u.uploadId, 1, 3000, "e1");
    m.store.uploads.recordUploadPart(u.uploadId, 2, 2000, "e2");
    expect(m.store.uploads.completeUpload(u.uploadId, 5000).state).toBe("complete");
    const { draftId } = m.draft("x@y.test", { attachments: [u.uploadId] });
    expect(() => m.store.sends.send(draftId, { expectedRevision: 1 })).toThrow(
      /attachment not ready/,
    );
    m.store.uploads.setScanResult(u.uploadId, "clean");
    expect(m.store.sends.send(draftId, { expectedRevision: 1 })._tag).toBe("Queued");

    const link = m.store.uploads.createFileLink(u.uploadId, m.clock.now() + 60_000);
    expect(m.store.uploads.resolveFileLink(link.token, m.clock.now())).toMatchObject({
      filename: "a.pdf",
    });
    expect(m.store.uploads.resolveFileLink(`${link.linkId}.wrong`, m.clock.now())).toBeNull();
    expect(m.store.uploads.resolveFileLink(link.token, m.clock.now() + 120_000)).toBeNull();
    m.store.uploads.revokeFileLink(link.linkId);
    expect(m.store.uploads.resolveFileLink(link.token, m.clock.now())).toBeNull();

    const liar = m.store.uploads.reserveUpload({
      filename: "b",
      contentType: "text/plain",
      declaredSize: 100,
    });
    expect(m.store.uploads.completeUpload(liar.uploadId, 101).state).toBe("failed");
  });

  it("[E20] attachment library filters by type, sender and size", () => {
    const m = setup();
    m.store.screener.screen([{ sender: "alice@example.com", decision: "allow" }]);
    m.deliver({
      attachments: [
        {
          partId: "2",
          filename: "photo.jpg",
          contentType: "image/jpeg",
          size: 5000,
          contentId: undefined,
          inline: false,
        },
        {
          partId: "3",
          filename: "logo.png",
          contentType: "image/png",
          size: 10,
          contentId: "c1",
          inline: true,
        },
      ],
    });
    m.deliver({
      attachments: [
        {
          partId: "2",
          filename: "report.pdf",
          contentType: "application/pdf",
          size: 900,
          contentId: undefined,
          inline: false,
        },
      ],
    });
    expect(m.store.uploads.attachments().map((a) => a.filename)).toEqual([
      "report.pdf",
      "photo.jpg",
    ]);
    expect(
      m.store.uploads.attachments({ contentTypePrefix: "image/" }).map((a) => a.filename),
    ).toEqual(["photo.jpg"]);
    expect(m.store.uploads.attachments({ minSize: 1000 })).toHaveLength(1);
  });

  it("[E22] away replies respect schedule, cooldown, automated/list traffic and never answer themselves", () => {
    const m = setup();
    m.store.automation.setAway({
      enabled: true,
      startAt: m.clock.now(),
      endAt: m.clock.now() + 7 * 86_400_000,
      subject: "Away",
      text: "Back soon",
      cooldownMs: 86_400_000,
    });
    m.store.screener.screen([{ sender: "alice@example.com", decision: "allow" }]);
    m.store.screener.setPolicy("domain", "example.com", {
      decision: "allowed",
      destination: "imbox",
      labels: [],
      bundle: false,
      notify: false,
    });
    const autoJobs = () =>
      m.store.sends
        .jobs()
        .filter(
          (j) =>
            m.store.sends.frozenContent(j.sendJobId)!.content.headers?.["Auto-Submitted"] ===
            "auto-replied",
        );
    m.deliver({});
    m.deliver({});
    expect(autoJobs()).toHaveLength(1);
    m.deliver({ fromAddress: "news@example.com", listId: "<n.example.com>" });
    m.deliver({ fromAddress: "bot@example.com", automated: true });
    m.deliver({ fromAddress: "mailer-daemon@example.com" });
    m.deliver({ fromAddress: "spam@example.com" }, { safety: { _tag: "Spam", reason: "score" } });
    expect(autoJobs()).toHaveLength(1);
    m.clock.advance(2 * 86_400_000);
    m.deliver({});
    expect(autoJobs()).toHaveLength(2);
  });

  it("[E22] forwarding only to verified destinations, with loop protection and hop limits", () => {
    const m = setup();
    expect(() =>
      m.store.automation.putForwardingRule({ destination: "me@elsewhere.test", keepCopy: true }),
    ).toThrow(/not verified/);
    // [P0#6] The verification code is mailed to the destination as a transactional system job.
    const { sendJobId } = m.store.automation.addForwardingDestination("me@elsewhere.test");
    const verification = m.store.sends.job(sendJobId)!;
    expect(verification).toMatchObject({
      state: "ready",
      trafficClass: "transactional",
      recipients: ["me@elsewhere.test"],
    });
    const token = (
      m.storage.sql
        .exec("SELECT token FROM forwarding_destinations WHERE address = ?", "me@elsewhere.test")
        .toArray()[0] as { token: string }
    ).token;
    expect(m.store.sends.frozenContent(sendJobId)!.content.text).toContain(token);
    expect(m.store.automation.verifyForwardingDestination("me@elsewhere.test", "wrong")).toBe(
      false,
    );
    expect(m.store.automation.verifyForwardingDestination("me@elsewhere.test", token)).toBe(true);
    m.store.automation.putForwardingRule({ destination: "me@elsewhere.test", keepCopy: true });
    m.store.screener.screen([{ sender: "alice@example.com", decision: "allow" }]);
    m.deliver({});
    const fwd = () => m.store.sends.jobs().filter((j) => j.trafficClass === "forwarding");
    void verification;
    expect(fwd()).toHaveLength(1);
    expect(fwd()[0]).toMatchObject({ state: "ready", recipients: ["me@elsewhere.test"] });
    expect(fwd()[0]!.contentKey).toMatch(/orig/);
    m.deliver({}, { forwardHops: 5 });
    m.store.screener.screen([{ sender: "me@elsewhere.test", decision: "allow" }]);
    m.deliver({ fromAddress: "me@elsewhere.test" });
    expect(fwd()).toHaveLength(1);
  });

  it("[E19/E22] verification codes are never readable by the requesting mailbox", () => {
    const m = setup();
    const { sendJobId } = m.store.automation.addForwardingDestination("victim@elsewhere.test");
    const ext = m.store.identities.addIdentity({ address: "me@gmail.example", kind: "external" });
    const token = (
      m.storage.sql
        .exec(
          "SELECT token FROM forwarding_destinations WHERE address = ?",
          "victim@elsewhere.test",
        )
        .toArray()[0] as { token: string }
    ).token;
    const challenge = (
      m.storage.sql
        .exec("SELECT challenge_token FROM identities WHERE identity_id = ?", ext)
        .toArray()[0] as { challenge_token: string }
    ).challenge_token;
    const raw = m.store.sends.jobs().filter((j) => j.trafficClass === "transactional");
    expect(raw).toHaveLength(2);
    // The send-job reads expose no draft handle; the draft reads refuse the system drafts.
    const listed = (
      applyMailboxRead(m.store, { _tag: "SendJobs" }) as {
        items: ReadonlyArray<{ trafficClass: string; draftId: string; contentKey: string }>;
      }
    ).items.filter((j) => j.trafficClass === "transactional");
    expect(listed.map((j) => j.draftId)).toEqual(["", ""]);
    expect(listed.map((j) => j.contentKey)).toEqual(["", ""]);
    expect(
      (applyMailboxRead(m.store, { _tag: "SendJob", sendJobId }) as { draftId: string }).draftId,
    ).toBe("");
    for (const j of raw) {
      expect(m.store.drafts.draft(j.draftId)).toBeUndefined();
      expect(() => m.store.sends.send(j.draftId, { expectedRevision: 1 })).toThrow(/draft/);
    }
    // A cancelled challenge settles back to 'open' but still never lists as a user draft.
    m.store.sends.cancelSend(sendJobId);
    expect(JSON.stringify(m.store.drafts.drafts())).not.toContain(token);
    // Dispatch still renders from the frozen revision.
    expect(m.store.sends.frozenContent(raw[1]!.sendJobId)!.content.text).toContain(challenge);
    // Acceptance records no outgoing delivery (no snippet) in the requester's threads.
    m.store.sends.claim(raw[1]!.sendJobId);
    m.store.sends.accepted(raw[1]!.sendJobId, { providerId: "p" });
    expect(m.store.sends.job(raw[1]!.sendJobId)!.state).toBe("accepted");
    expect(JSON.stringify(m.store.views.listView({ view: "everything" }))).not.toContain(challenge);
    expect(m.store.views.listView({ view: "everything" }).items).toHaveLength(0);
  });

  it("[E23] notifications are quiet by default with contact/domain/thread opt-in and quiet hours", () => {
    const m = setup();
    m.store.screener.screen([
      { sender: "alice@example.com", decision: "allow" },
      { sender: "bob@example.com", decision: "allow" },
    ]);
    const notifies = () =>
      m.store.kernel.pendingOutbox(1000).filter((e) => e.topic === "notify").length;
    m.deliver({});
    expect(notifies()).toBe(0);
    m.store.automation.setNotifyOptIn("contact", "alice@example.com", true);
    m.deliver({});
    expect(notifies()).toBe(1);
    m.store.automation.setNotifyOptIn("domain", "example.com", true);
    m.deliver({ fromAddress: "bob@example.com" });
    expect(notifies()).toBe(2);
    m.store.automation.setNotificationSettings({
      quietHours: { start: "11:00", end: "13:00", timeZone: "UTC" },
      devices: {},
    });
    m.deliver({});
    expect(notifies()).toBe(2);
    m.store.automation.setPreference("remoteImages", "off");
    expect(m.store.automation.preferences().remoteImages).toBe("off");
  });
});
