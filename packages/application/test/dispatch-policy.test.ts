import { describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import {
  decideDispatch,
  type DispatchJobFacts,
  Directory,
  type SendingDecision,
  SendingPolicyService,
} from "../src/index.ts";

// §5.2/§10: the dispatch-time policy decided before a send job is claimed.

const job = (overrides: Partial<DispatchJobFacts> = {}): DispatchJobFacts => ({
  mailboxId: "mbx_1",
  budgetUserId: "usr_1",
  from: "alice@bye.test",
  trafficClass: "personal",
  recipients: ["bob@x.test", "carol@x.test"],
  forwardingScan: null,
  ...overrides,
});

const decide = (
  facts: DispatchJobFacts,
  opts: { maySendAs?: boolean; verdict?: SendingDecision } = {},
) =>
  Effect.runPromise(
    decideDispatch(facts).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(Directory, {
            resolveRecipient: () => Effect.die("unused"),
            canSendAs: () => Effect.die("unused"),
            mailboxMaySendAs: () => Effect.succeed(opts.maySendAs ?? true),
          }),
          Layer.succeed(SendingPolicyService, {
            check: () =>
              Effect.succeed(opts.verdict ?? { allowed: true, suppressed: [], remaining: 10 }),
            release: () => Effect.void,
          }),
        ),
      ),
    ),
  );

describe("[§10] dispatch policy", () => {
  it("forwarding waits for a pending scan and rejects infected or failed originals", async () => {
    expect(
      await decide(job({ trafficClass: "forwarding", forwardingScan: "pending" })),
    ).toMatchObject({ _tag: "Refuse", failure: { kind: "RetryableBeforeAcceptance" } });
    expect(
      await decide(job({ trafficClass: "forwarding", forwardingScan: "infected" })),
    ).toMatchObject({ _tag: "Refuse", failure: { kind: "Rejected" } });
    expect(
      await decide(job({ trafficClass: "forwarding", forwardingScan: "failed" })),
    ).toMatchObject({ _tag: "Refuse", failure: { kind: "Rejected" } });
    expect(
      await decide(job({ trafficClass: "forwarding", forwardingScan: "clean" }), {
        maySendAs: false,
      }),
    ).toMatchObject({ _tag: "Proceed" });
  });

  it("hosted senders must still be authorized for the mailbox; external identities are not re-checked", async () => {
    expect(await decide(job(), { maySendAs: false })).toMatchObject({
      _tag: "Refuse",
      failure: { kind: "Rejected", detail: "sender not authorized" },
    });
    expect(
      await decide(job({ trafficClass: "transactional" }), { maySendAs: false }),
    ).toMatchObject({
      _tag: "Refuse",
      failure: { kind: "Rejected", detail: "sender not authorized" },
    });
    expect(
      await decide(job({ trafficClass: "external-identity" }), { maySendAs: false }),
    ).toMatchObject({ _tag: "Proceed" });
  });

  it("budgets retry; suspensions and fully suppressed sets are rejected", async () => {
    const budget = await decide(job(), {
      verdict: { allowed: false, reason: "budget", scope: "daily", suppressed: [] },
    });
    expect(budget).toMatchObject({
      _tag: "Refuse",
      blockedBy: "budget",
      failure: { kind: "RetryableBeforeAcceptance" },
    });
    const suspended = await decide(job(), {
      verdict: { allowed: false, reason: "suspended", suppressed: [] },
    });
    expect(suspended).toMatchObject({
      _tag: "Refuse",
      blockedBy: "suspended",
      failure: { kind: "Rejected" },
    });
    const suppressed = await decide(job(), {
      verdict: {
        allowed: false,
        reason: "all-suppressed",
        suppressed: ["bob@x.test", "carol@x.test"],
      },
    });
    expect(suppressed).toMatchObject({
      _tag: "Refuse",
      blockedBy: "all-suppressed",
      failure: { kind: "Rejected" },
    });
  });

  it("proceeds with the suppressed recipients normalized for filtering", async () => {
    const decision = await decide(job(), {
      verdict: { allowed: true, suppressed: ["Bob@X.test"], remaining: 5 },
    });
    expect(decision._tag).toBe("Proceed");
    if (decision._tag === "Proceed") expect([...decision.suppressed]).toEqual(["bob@x.test"]);
  });
});
