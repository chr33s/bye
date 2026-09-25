import { describe, expect, it } from "vitest";
import { Effect, Layer, Result } from "effect";
import {
  COMMAND_GUARDS,
  CurrentAuthentication,
  Directory,
  executeMailboxCommand,
  ingestCommit,
  MailboxFacts,
  Principal,
  type PrincipalShape,
  readMailboxView,
} from "@bye/application";
import { LocalMailboxRepositoryLive } from "@bye/platform-cloudflare";
import { makeTestMailbox, summaryFixture } from "@bye/testing";

const principal = (over: Partial<PrincipalShape>): PrincipalShape => ({
  userId: "usr_a",
  sessionId: "ses_a",
  kind: "user",
  scopes: ["read", "draft", "send", "screen", "delete", "admin"],
  mailboxIds: [],
  calendarIds: [],
  organizationIds: [],
  ...over,
});

describe("mailbox use cases (Effect v4)", () => {
  const a = makeTestMailbox("mbx_alice00000000000000000");
  const b = makeTestMailbox("mbx_bob000000000000000000");
  const stores = new Map([
    [a.mailboxId, a.store],
    [b.mailboxId, b.store],
  ]);
  const repo = LocalMailboxRepositoryLive((id) => stores.get(id)!);
  /** Request layer for principal `p`: the repository plus the services command guards read. */
  const as = (
    p: PrincipalShape,
    opts: {
      steppedUp?: boolean;
      canSendAs?: boolean;
      source?: { quarantined: boolean; scan: { allowed: boolean; status: string } } | null;
    } = {},
  ) =>
    Layer.mergeAll(
      repo,
      Layer.succeed(Principal, p),
      Layer.succeed(CurrentAuthentication, {
        principal: p,
        credentialId: p.sessionId,
        steppedUpAt: opts.steppedUp ? Date.now() : null,
      }),
      Layer.succeed(Directory, {
        resolveRecipient: () => Effect.die("unused"),
        canSendAs: () => Effect.succeed(opts.canSendAs ?? true),
        mailboxMaySendAs: () => Effect.succeed(true),
      }),
      Layer.succeed(MailboxFacts, {
        redeliverySource: () =>
          Effect.succeed(
            opts.source === undefined
              ? { quarantined: false, scan: { allowed: true, status: "clean" } }
              : opts.source,
          ),
      }),
    );

  it("[E21] principals are authorized independently: each reads only its own mailbox", async () => {
    const alice = principal({ userId: "usr_a", mailboxIds: [a.mailboxId] });
    const bob = principal({ userId: "usr_b", mailboxIds: [b.mailboxId] });
    const run = (p: PrincipalShape, mailboxId: string) =>
      Effect.runPromise(
        Effect.result(readMailboxView(mailboxId, { view: "imbox" }).pipe(Effect.provide(as(p)))),
      );
    const [r1, r2, r3, r4] = await Promise.all([
      run(alice, a.mailboxId),
      run(bob, b.mailboxId),
      run(alice, b.mailboxId),
      run(bob, a.mailboxId),
    ]);
    expect(Result.isSuccess(r1) && Result.isSuccess(r2)).toBe(true);
    expect(Result.isFailure(r3) && r3.failure._tag).toBe("Forbidden");
    expect(Result.isFailure(r4) && r4.failure._tag).toBe("Forbidden");
  });

  it("[X02] agent credentials default to read/draft; consequential commands need explicit scopes", async () => {
    const agent = principal({
      kind: "agent",
      scopes: ["read", "draft"],
      mailboxIds: [a.mailboxId],
    });
    const send = await Effect.runPromise(
      Effect.result(
        executeMailboxCommand(a.mailboxId, {
          _tag: "Send",
          commandId: "c1",
          draftId: "drf_1",
          expectedRevision: 1,
        }).pipe(Effect.provide(as(agent))),
      ),
    );
    expect(Result.isFailure(send) && send.failure._tag).toBe("Forbidden");
    const draft = await Effect.runPromise(
      executeMailboxCommand(a.mailboxId, {
        _tag: "CreateDraft",
        commandId: "c2",
        content: {
          to: [{ address: "x@y.test" }],
          cc: [],
          bcc: [],
          subject: "s",
          text: "t",
          attachments: [],
        },
      }).pipe(Effect.provide(as(agent))),
    );
    expect(draft).toMatchObject({ revision: 1 });
  });

  it("wire commands are decoded at the boundary; expected rejections map to structured errors", async () => {
    const alice = principal({ mailboxIds: [a.mailboxId] });
    const bad = await Effect.runPromise(
      Effect.result(
        executeMailboxCommand(a.mailboxId, {
          _tag: "MarkSeen",
          commandId: "c3",
          threadId: "x",
        }).pipe(Effect.provide(as(alice))),
      ),
    );
    expect(Result.isFailure(bad) && bad.failure._tag).toBe("SchemaError");
    const missing = await Effect.runPromise(
      Effect.result(
        executeMailboxCommand(a.mailboxId, {
          _tag: "MarkSeen",
          commandId: "c4",
          threadId: "thr_missing",
          observedRevision: 1,
        }).pipe(Effect.provide(as(alice))),
      ),
    );
    expect(Result.isFailure(missing) && missing.failure).toMatchObject({
      _tag: "MailboxRejected",
      code: "not_found",
    });
  });

  it("[E01] ingest commit through the repository applies screening", async () => {
    const committed = await Effect.runPromise(
      ingestCommit(a.mailboxId, {
        ingestionId: "ing_x",
        recipient: "me@bye.test",
        messageKey: "t/k",
        rawSize: 10,
        summary: summaryFixture({ fromAddress: "new@example.com" }),
        safety: { _tag: "Clean" },
        receivedAt: a.clock.now(),
      }).pipe(Effect.provide(repo)),
    );
    expect(committed).toMatchObject({ disposition: "screening", replayed: false });
  });

  it("[§10] command guards: step-up, send-as, redelivery source checks and rule targets", async () => {
    const owner = principal({ mailboxIds: [a.mailboxId] });
    const tagOf = async (
      command: Record<string, unknown>,
      opts: Parameters<typeof as>[1] = {},
      p = owner,
    ) => {
      const r = await Effect.runPromise(
        Effect.result(
          executeMailboxCommand(a.mailboxId, {
            commandId: `g${Math.random().toString(36).slice(2, 10)}`,
            ...command,
          }).pipe(Effect.provide(as(p, opts))),
        ),
      );
      return Result.isFailure(r) ? r.failure._tag : "ok";
    };
    expect(Object.keys(COMMAND_GUARDS).sort()).toEqual([
      "AddForwardingDestination",
      "AddIdentity",
      "PutForwardingRule",
      "PutRule",
      "Redeliver",
    ]);
    // Consequential changes need a recent step-up; hosted identities also need send-as authority.
    expect(await tagOf({ _tag: "AddIdentity", address: "a@bye.test", kind: "hosted" })).toBe(
      "StepUpRequired",
    );
    expect(
      await tagOf(
        { _tag: "AddIdentity", address: "boss@bye.test", kind: "hosted" },
        { steppedUp: true, canSendAs: false },
      ),
    ).toBe("Forbidden");
    expect(await tagOf({ _tag: "AddForwardingDestination", address: "me@example.net" })).toBe(
      "StepUpRequired",
    );
    // Redelivery: both mailboxes authorized, then quarantine/scan/existence of the source.
    const both = principal({ mailboxIds: [a.mailboxId, b.mailboxId] });
    const redeliver = {
      _tag: "Redeliver",
      deliveryId: "dlv_1",
      targetMailboxId: b.mailboxId,
      mode: "copy",
    };
    expect(await tagOf(redeliver)).toBe("Forbidden"); // no send access to the target
    expect(await tagOf(redeliver, { source: null }, both)).toBe("NotFound");
    expect(
      await tagOf(
        redeliver,
        { source: { quarantined: true, scan: { allowed: true, status: "clean" } } },
        both,
      ),
    ).toBe("Forbidden");
    expect(
      await tagOf(
        redeliver,
        { source: { quarantined: false, scan: { allowed: false, status: "pending" } } },
        both,
      ),
    ).toBe("Forbidden");
    // Rule redelivery targets must be mailboxes the principal may send into.
    expect(
      await tagOf({ _tag: "PutRule", conditions: {}, actions: { redeliverTo: b.mailboxId } }),
    ).toBe("Forbidden");
  });
});
