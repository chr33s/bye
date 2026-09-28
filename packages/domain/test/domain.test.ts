import { describe, expect, it } from "vitest";
import {
  canTransition,
  checkSubmission,
  CLOUDFLARE_TRANSACTIONAL_CAPABILITIES,
  domainOf,
  encodeId,
  isCancellable,
  isOpaqueId,
  isTerminal,
  mergeOutcome,
  PARITY_LEDGER,
  route,
  SEND_JOB_STATES,
  type SenderPolicy,
  splitPlusAddress,
} from "@bye/domain";

const allow: SenderPolicy = {
  decision: "allowed",
  destination: "feed",
  labels: ["news"],
  bundle: true,
  notify: false,
};

const block: SenderPolicy = { ...allow, decision: "blocked" };

const base = {
  safety: { _tag: "Clean" } as const,
  exact: undefined,
  domain: undefined,
  speakeasy: false,
  knownThread: false,
};

describe("[E01] routing precedence (§4.2)", () => {
  it("safety beats every sender decision, and Speakeasy never bypasses it", () => {
    for (const safety of [
      { _tag: "Malware", reason: "x" },
      { _tag: "Spoofed", reason: "x" },
    ] as const) {
      const d = route({ ...base, safety, exact: allow, speakeasy: true });
      expect(d).toMatchObject({ disposition: "spam", decidedBy: "safety", quarantine: true });
    }

    expect(route({ ...base, safety: { _tag: "Spam", reason: "x" }, exact: allow })).toMatchObject({
      disposition: "spam",
      quarantine: false,
    });
  });

  it("[E02] exact rules override domain defaults in both directions", () => {
    expect(route({ ...base, exact: block, domain: allow })).toMatchObject({
      disposition: "screened-out",
      decidedBy: "exact-block",
    });
    expect(route({ ...base, exact: allow, domain: block })).toMatchObject({
      disposition: "active",
      decidedBy: "exact-allow",
      destination: "feed",
      labels: ["news"],
      bundle: true,
    });
    expect(route({ ...base, domain: block })).toMatchObject({ decidedBy: "domain-block" });
  });

  it("[E03] Speakeasy bypasses only the Screener; unknown senders are screened", () => {
    expect(route({ ...base, speakeasy: true })).toMatchObject({
      disposition: "active",
      decidedBy: "speakeasy",
    });
    expect(route({ ...base, speakeasy: true, domain: block })).toMatchObject({
      decidedBy: "domain-block",
    });
    expect(route(base)).toMatchObject({ disposition: "screening", decidedBy: "screener" });
  });

  it("normalizes addresses and plus-tags", () => {
    expect(domainOf(" Ana@Example.COM ")).toBe("example.com");
    expect(splitPlusAddress("ana+news@x.test")).toEqual({ base: "ana@x.test", tag: "news" });
    expect(splitPlusAddress("+x@x.test")).toEqual({ base: "+x@x.test", tag: undefined });
  });
});

describe("[E18] send-job state machine (§5.2)", () => {
  it("only allows documented transitions; terminal states are final", () => {
    expect(canTransition("undo-window", "ready")).toBe(true);
    expect(canTransition("submitting", "accepted")).toBe(true);
    expect(canTransition("accepted", "ready")).toBe(false);
    expect(canTransition("cancelled", "ready")).toBe(false);

    for (const s of SEND_JOB_STATES)
      if (isTerminal(s)) for (const t of SEND_JOB_STATES) expect(canTransition(s, t)).toBe(false);
  });

  it("cancellation is possible only before Submitting wins", () => {
    expect(SEND_JOB_STATES.filter(isCancellable)).toEqual(["undo-window", "scheduled", "ready"]);
  });

  it("an Unknown submission requires an explicit decision (never auto-retried to accepted without evidence)", () => {
    expect(canTransition("unknown", "accepted")).toBe(true);
    expect(canTransition("unknown", "submitting")).toBe(false);
  });

  it("later provider events never regress a recipient outcome", () => {
    expect(mergeOutcome("delivered", "deferred")).toBe("delivered");
    expect(mergeOutcome("deferred", "bounced")).toBe("bounced");
    expect(mergeOutcome("bounced", "complained")).toBe("complained");
  });
});

describe("transport capability limits (§5.3)", () => {
  it("refuses disallowed traffic classes, oversize messages and recipient lists", () => {
    const caps = CLOUDFLARE_TRANSACTIONAL_CAPABILITIES;
    expect(checkSubmission(caps, "personal", 10, 1)._tag).toBe("TrafficClassNotPermitted");
    expect(checkSubmission(caps, "transactional", caps.maxMessageBytes + 1, 1)._tag).toBe(
      "TooLarge",
    );
    expect(checkSubmission(caps, "transactional", 10, caps.maxRecipients + 1)._tag).toBe(
      "TooManyRecipients",
    );
    expect(checkSubmission(caps, "transactional", 10, 1)._tag).toBe("Ok");
  });
});

describe("opaque identifiers (§4.1)", () => {
  it("encode random bytes into prefixed base32 IDs that never collide across kinds", () => {
    const id = encodeId("MailboxId", new Uint8Array(16).fill(7));
    expect(isOpaqueId("MailboxId", id)).toBe(true);
    expect(isOpaqueId("ThreadId", id)).toBe(false);
    expect(isOpaqueId("MailboxId", "mbx_short")).toBe(false);
  });

  it("the parity ledger has unique, contiguously numbered rows with stages", () => {
    expect(PARITY_LEDGER.length).toBeGreaterThan(0);
    expect(new Set(PARITY_LEDGER.map((r) => r.id)).size).toBe(PARITY_LEDGER.length);
    const families = new Map<string, Array<{ n: number; stage: number }>>();

    for (const row of PARITY_LEDGER) {
      expect(row.id).toMatch(/^[A-Z]\d{2}$/);
      expect(row.capability.trim()).not.toBe("");
      expect(Number.isInteger(row.stage) && row.stage >= 1).toBe(true);
      const rows = families.get(row.id[0]!) ?? [];
      rows.push({ n: Number(row.id.slice(1)), stage: row.stage });
      families.set(row.id[0]!, rows);
    }

    for (const [family, rows] of families) {
      // Numbered 01..n with no gaps, and each capability family ships in a single stage.
      expect(
        rows.map((r) => r.n),
        family,
      ).toEqual(rows.map((_, i) => i + 1));
      expect(new Set(rows.map((r) => r.stage)).size, family).toBe(1);
    }

    // Stages never go backwards through the ledger.
    const stages = PARITY_LEDGER.map((r) => r.stage);
    expect(stages).toEqual([...stages].sort((a, b) => a - b));
  });
});
