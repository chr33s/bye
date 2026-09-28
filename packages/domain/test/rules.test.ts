import { Predicate } from "effect";
import { describe, expect, it } from "vitest";
import {
  advanceNewsletterRecipientOutcome,
  advanceObserved,
  applyConsent,
  bearerMatches,
  checkOperation,
  type ConsentRecord,
  escapeHtml,
  missingEventCoverage,
  NEWSLETTER_OPERATIONS,
  type NewsletterCapabilities,
  newsletterEligible,
  type OperationCapability,
  retryDecision,
  retryDelayMs,
  timingSafeEqual,
} from "@bye/domain";

describe("constant-time comparison and bearer auth", () => {
  it("timingSafeEqual compares whole strings, including length and multibyte content", () => {
    expect(timingSafeEqual("secret", "secret")).toBe(true);
    expect(timingSafeEqual("", "")).toBe(true);
    expect(timingSafeEqual("secret", "secreT")).toBe(false);
    expect(timingSafeEqual("secret", "secret2")).toBe(false);
    expect(timingSafeEqual("secret2", "secret")).toBe(false);
    expect(timingSafeEqual("", "x")).toBe(false);
    // A prefix padded with NULs must not match: the length itself is part of the comparison.
    expect(timingSafeEqual("ab", "ab\0")).toBe(false);
    expect(timingSafeEqual("café", "café")).toBe(true);
    expect(timingSafeEqual("café", "cafe")).toBe(false);
  });

  it("bearerMatches needs the Bearer scheme and a configured, long-enough secret", () => {
    expect(bearerMatches("Bearer s3cret", "s3cret")).toBe(true);
    // Both sides are trimmed.
    expect(bearerMatches("Bearer   s3cret  ", " s3cret\n")).toBe(true);
    // Unset or empty secrets never open a route, even for an empty token.
    expect(bearerMatches("Bearer ", "")).toBe(false);
    expect(bearerMatches("Bearer x", null)).toBe(false);
    expect(bearerMatches("Bearer x", undefined)).toBe(false);
    expect(bearerMatches("Bearer    ", "   ")).toBe(false);
    // Too-short secrets are rejected even when the token matches.
    expect(bearerMatches("Bearer short", "short", 32)).toBe(false);
    expect(bearerMatches(`Bearer ${"k".repeat(32)}`, "k".repeat(32), 32)).toBe(true);
    // Missing header, wrong scheme or case, or no space after the scheme.
    expect(bearerMatches(null, "s3cret")).toBe(false);
    expect(bearerMatches(undefined, "s3cret")).toBe(false);
    expect(bearerMatches("", "s3cret")).toBe(false);
    expect(bearerMatches("s3cret", "s3cret")).toBe(false);
    expect(bearerMatches("Basic s3cret", "s3cret")).toBe(false);
    expect(bearerMatches("bearer s3cret", "s3cret")).toBe(false);
    expect(bearerMatches("Bearers3cret", "s3cret")).toBe(false);
    // Whitespace-only token.
    expect(bearerMatches("Bearer    ", "s3cret")).toBe(false);
    expect(bearerMatches("Bearer s3cre", "s3cret")).toBe(false);
  });

  it("escapeHtml escapes every markup-significant character exactly once", () => {
    expect(escapeHtml(`<a href="x" title='y'>&amp;</a>`)).toBe(
      "&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;amp;&lt;/a&gt;",
    );
    expect(escapeHtml("plain text ✓")).toBe("plain text ✓");
    expect(escapeHtml("")).toBe("");
  });
});

const capability = (over: Partial<OperationCapability> = {}): OperationCapability => ({
  supported: true,
  idempotency: null,
  reconciliation: false,
  ...over,
});

const caps = (
  over: Partial<Record<(typeof NEWSLETTER_OPERATIONS)[number], OperationCapability>> = {},
): NewsletterCapabilities => ({
  name: "Acme",
  apiVersion: "1",
  operations: {
    ...(Object.fromEntries(
      NEWSLETTER_OPERATIONS.map((op) => [op, capability()]),
    ) as NewsletterCapabilities["operations"]),
    ...over,
  },
});

describe("newsletter operation checks", () => {
  it("checkOperation rejects each unmet requirement before any side effect", () => {
    const c = caps({
      "broadcast-send": capability({
        maxRecipients: 100,
        maxEncodedBytes: 1_000,
        preservesHeaders: false,
        enforcesExclusionsAtDispatch: false,
      }),
      "broadcast-cancel": capability({ supported: false }),
      events: capability({ eventCoverage: ["delivered", "hard-bounce"] }),
    });

    expect(checkOperation(c, "broadcast-cancel")).toEqual({
      _tag: "Unsupported",
      operation: "broadcast-cancel",
      detail: "Acme does not support broadcast-cancel",
    });

    const detail = (r: ReturnType<typeof checkOperation>) =>
      Predicate.isTagged(r, "Unsupported") ? r.detail : "ok";

    expect(detail(checkOperation(c, "broadcast-send", { recipients: 101 }))).toBe(
      "101 recipients exceeds 100",
    );
    expect(detail(checkOperation(c, "broadcast-send", { recipients: 100 }))).toBe("ok");
    expect(detail(checkOperation(c, "broadcast-send", { encodedBytes: 1_001 }))).toBe(
      "1001 bytes exceeds 1000",
    );
    expect(detail(checkOperation(c, "broadcast-send", { headers: ["List-Unsubscribe"] }))).toBe(
      "headers would not be preserved",
    );
    expect(detail(checkOperation(c, "broadcast-send", { headers: [] }))).toBe("ok");
    expect(detail(checkOperation(c, "broadcast-send", { exclusionsAtDispatch: true }))).toBe(
      "recipient exclusions are not enforced at dispatch",
    );
    expect(
      detail(
        checkOperation(c, "events", { eventKinds: ["delivered", "complaint", "soft-bounce"] }),
      ),
    ).toBe("no event coverage for complaint, soft-bounce");
    const ok = checkOperation(c, "events", { eventKinds: ["delivered"] });
    expect(ok).toEqual({ _tag: "Ok", capability: c.operations.events });
    // Limits the provider does not declare are not invented.
    expect(checkOperation(c, "contact-sync", { recipients: 1e9, encodedBytes: 1e9 })._tag).toBe(
      "Ok",
    );
  });

  it("missingEventCoverage lists undeclared kinds; no coverage declared means all missing", () => {
    const c = caps({ events: capability({ eventCoverage: ["delivered", "complaint"] }) });
    expect(
      missingEventCoverage(c, ["delivered", "hard-bounce", "complaint", "soft-bounce"]),
    ).toEqual(["hard-bounce", "soft-bounce"]);
    expect(missingEventCoverage(c, [])).toEqual([]);
    expect(missingEventCoverage(caps(), ["delivered"])).toEqual(["delivered"]);
  });
});

describe("ambiguous operation retries", () => {
  const base = {
    idempotency: { scope: "team", windowMs: 60_000 },
    firstAttemptAt: 1_000,
    now: 2_000,
    attempts: 1,
    maxAttempts: 3,
  };

  it("retryDecision only resubmits when nothing was accepted or idempotency still covers it", () => {
    expect(retryDecision({ ...base, outcome: { _tag: "Accepted", providerRef: "p1" } })).toEqual({
      _tag: "Hold",
      reason: "accepted",
    });
    const unknown = { _tag: "Unknown", detail: "timeout" } as const;
    expect(retryDecision({ ...base, outcome: unknown })).toEqual({ _tag: "Retry" });
    expect(retryDecision({ ...base, outcome: unknown, idempotency: null })).toEqual({
      _tag: "Hold",
      reason: "unknown outcome without idempotency",
    });
    // The window is measured from the FIRST attempt and is exclusive at its end.
    expect(retryDecision({ ...base, outcome: unknown, now: 60_999 })).toEqual({ _tag: "Retry" });
    expect(retryDecision({ ...base, outcome: unknown, now: 61_000 })).toEqual({
      _tag: "Hold",
      reason: "idempotency window expired",
    });
    expect(
      retryDecision({
        ...base,
        outcome: { _tag: "NotAccepted", retryable: true, detail: "503" },
        idempotency: null,
      }),
    ).toEqual({ _tag: "Retry" });
    expect(
      retryDecision({ ...base, outcome: { _tag: "NotAccepted", retryable: false, detail: "400" } }),
    ).toEqual({ _tag: "Hold", reason: "rejected" });

    // Exhaustion wins over every retryable outcome.
    for (const outcome of [unknown, { _tag: "NotAccepted", retryable: true, detail: "" } as const])
      expect(retryDecision({ ...base, outcome, attempts: 3 })).toEqual({
        _tag: "Hold",
        reason: "retries exhausted",
      });
  });

  it("retryDelayMs backs off exponentially, capped, and honours retry-after", () => {
    expect(retryDelayMs(0)).toBe(30_000);
    expect(retryDelayMs(1)).toBe(30_000);
    expect(retryDelayMs(2)).toBe(60_000);
    expect(retryDelayMs(3)).toBe(120_000);
    expect(retryDelayMs(7)).toBe(30 * 60_000);
    expect(retryDelayMs(50)).toBe(30 * 60_000);
    expect(retryDelayMs(1, 5 * 60_000)).toBe(5 * 60_000);
    expect(retryDelayMs(3, 1_000)).toBe(120_000);
    // A provider's retry-after is never undercut, even past the backoff cap.
    expect(retryDelayMs(50, 60 * 60_000)).toBe(60 * 60_000);
  });
});

describe("newsletter consent", () => {
  const record = (over: Partial<ConsentRecord>): ConsentRecord => ({
    status: "confirmed",
    revision: 1,
    changedAt: 100,
    consentEvidence: "ev1",
    ...over,
  });

  it("applyConsent confirms with evidence and bumps the revision", () => {
    expect(applyConsent(null, { _tag: "Confirm", evidence: "ev1", at: 100 })).toEqual({
      _tag: "Applied",
      record: { status: "confirmed", revision: 1, changedAt: 100, consentEvidence: "ev1" },
    });
    expect(
      applyConsent(record({ status: "pending", consentEvidence: null }), {
        _tag: "Confirm",
        evidence: "ev2",
        at: 150,
      }),
    ).toEqual({
      _tag: "Applied",
      record: { status: "confirmed", revision: 2, changedAt: 150, consentEvidence: "ev2" },
    });
    expect(applyConsent(record({}), { _tag: "Confirm", evidence: "ev2", at: 200 })).toEqual({
      _tag: "Ignored",
      reason: "unchanged",
    });
  });

  it("applyConsent: unsubscribes always win and clear the consent evidence", () => {
    // Even an unsubscribe timestamped before the confirmation applies.
    expect(
      applyConsent(record({ revision: 4 }), { _tag: "Unsubscribe", source: "provider", at: 50 }),
    ).toEqual({
      _tag: "Applied",
      record: { status: "unsubscribed", revision: 5, changedAt: 50, consentEvidence: null },
    });
    expect(applyConsent(null, { _tag: "Unsubscribe", source: "bye", at: 1 })._tag).toBe("Applied");
    expect(
      applyConsent(record({ status: "unsubscribed" }), {
        _tag: "Unsubscribe",
        source: "bye",
        at: 9,
      }),
    ).toEqual({ _tag: "Ignored", reason: "unchanged" });
  });

  it("applyConsent never reactivates an unsubscribe without new, later consent", () => {
    const unsubscribed = record({ status: "unsubscribed", changedAt: 100, consentEvidence: null });
    expect(applyConsent(unsubscribed, { _tag: "ProviderSubscribed", at: 500 })).toEqual({
      _tag: "Ignored",
      reason: "no-consent",
    });
    expect(applyConsent(null, { _tag: "ProviderSubscribed", at: 500 })).toEqual({
      _tag: "Ignored",
      reason: "no-consent",
    });

    for (const at of [99, 100])
      expect(applyConsent(unsubscribed, { _tag: "Confirm", evidence: "old", at })).toEqual({
        _tag: "Ignored",
        reason: "stale",
      });
    expect(applyConsent(unsubscribed, { _tag: "Confirm", evidence: "new", at: 101 })).toEqual({
      _tag: "Applied",
      record: { status: "confirmed", revision: 2, changedAt: 101, consentEvidence: "new" },
    });
  });

  it("newsletterEligible needs confirmed consent, no restrictions and nothing unresolved", () => {
    const confirmed = record({});
    expect(newsletterEligible(confirmed, [], false)).toBe(true);
    expect(newsletterEligible(null, [], false)).toBe(false);
    expect(newsletterEligible(record({ status: "pending" }), [], false)).toBe(false);
    expect(newsletterEligible(record({ status: "unsubscribed" }), [], false)).toBe(false);
    expect(newsletterEligible(confirmed, [], true)).toBe(false);
    expect(
      newsletterEligible(
        confirmed,
        [{ kind: "hard-bounce", scope: "platform", reason: "550" }],
        false,
      ),
    ).toBe(false);
  });
});

describe("newsletter observation ordering", () => {
  it("advanceObserved never regresses to an earlier broadcast state", () => {
    expect(advanceObserved(null, "draft")).toBe("draft");
    expect(advanceObserved("draft", "scheduled")).toBe("scheduled");
    expect(advanceObserved("sending", "queued")).toBe("sending");
    expect(advanceObserved("scheduled", "sending")).toBe("sending");
    expect(advanceObserved("sending", "sent")).toBe("sent");
    // Terminal states are peers: the first one observed sticks.
    expect(advanceObserved("sent", "cancelled")).toBe("sent");
    expect(advanceObserved("cancelled", "sent")).toBe("cancelled");
    expect(advanceObserved("sent", "draft")).toBe("sent");
  });

  it("advanceNewsletterRecipientOutcome: a late delivery never overwrites a bounce or complaint", () => {
    expect(advanceNewsletterRecipientOutcome(null, "accepted")).toBe("accepted");
    expect(advanceNewsletterRecipientOutcome("accepted", "delivered")).toBe("delivered");
    expect(advanceNewsletterRecipientOutcome("soft-bounce", "delivered")).toBe("delivered");
    expect(advanceNewsletterRecipientOutcome("delivered", "soft-bounce")).toBe("delivered");
    expect(advanceNewsletterRecipientOutcome("hard-bounce", "delivered")).toBe("hard-bounce");
    expect(advanceNewsletterRecipientOutcome("delivered", "complaint")).toBe("complaint");
    expect(advanceNewsletterRecipientOutcome("complaint", "hard-bounce")).toBe("complaint");
    expect(advanceNewsletterRecipientOutcome("hard-bounce", "accepted")).toBe("hard-bounce");
  });
});
