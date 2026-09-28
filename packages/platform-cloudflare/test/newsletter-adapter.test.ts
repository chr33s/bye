import { checkOperation, retryDecision } from "@bye/domain";
import {
  classifyResendStatus,
  makeResendNewsletterProvider,
  makeTransportRouter,
  mapResendEvent,
  parseTrafficClasses,
  RESEND_CAPABILITIES,
  SVIX_TOLERANCE_MS,
  type TransportAdapter,
  verifySvix,
} from "@bye/platform-cloudflare";
import { CLOUDFLARE_TRANSACTIONAL_CAPABILITIES } from "@bye/domain";
import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";

// spec.md §5.3–5.5: routing/capability gates and the Resend adapter's outcome classification.

const submission = (trafficClass: "transactional" | "personal" | "subscription") => ({
  sendJobId: "job_1",
  identityId: "id_1",
  from: "a@bye.test",
  contentKey: "k",
  envelopeRecipients: ["r@example.net"],
  trafficClass,
  bytes: 10,
});

describe("traffic-class routing", () => {
  let called = 0;

  const adapter: TransportAdapter = {
    capabilities: {
      ...CLOUDFLARE_TRANSACTIONAL_CAPABILITIES,
      trafficClasses: ["transactional", "personal", "subscription"],
    },
    submit: () => {
      called++;

      return Effect.succeed({ providerId: "p" });
    },
  };

  it("rejects disabled classes and all newsletter traffic before any provider call", async () => {
    const router = makeTransportRouter([adapter], parseTrafficClasses("transactional"));
    const personal = await Effect.runPromiseExit(router.submit(submission("personal")));
    const newsletter = await Effect.runPromiseExit(router.submit(submission("subscription")));
    expect(Exit.isFailure(personal) && JSON.stringify(personal.cause)).toContain("not enabled");
    expect(Exit.isFailure(newsletter) && JSON.stringify(newsletter.cause)).toContain(
      "NewsletterProvider",
    );
    expect(called).toBe(0);
    expect(
      Exit.isSuccess(await Effect.runPromiseExit(router.submit(submission("transactional")))),
    ).toBe(true);
    expect(called).toBe(1);
  });

  it("an empty stage configuration enables transactional mail only", () => {
    expect([...parseTrafficClasses("")]).toEqual(["transactional"]);
    expect([...parseTrafficClasses("personal, bogus,subscription")]).toEqual(["personal"]);
  });
});

describe("Resend adapter", () => {
  it("declares per-operation limits and rejects unmet requirements before side effects", () => {
    expect(checkOperation(RESEND_CAPABILITIES, "broadcast-schedule")._tag).toBe("Unsupported");
    expect(
      checkOperation(RESEND_CAPABILITIES, "broadcast-create", { headers: ["List-Id"] })._tag,
    ).toBe("Unsupported");
    expect(
      checkOperation(RESEND_CAPABILITIES, "broadcast-send", { exclusionsAtDispatch: true })._tag,
    ).toBe("Ok");
    // No provider idempotency for broadcasts: an unknown send is held, never retried.
    const idem = RESEND_CAPABILITIES.operations["broadcast-send"].idempotency;
    expect(
      retryDecision({
        outcome: { _tag: "Unknown", detail: "timeout" },
        idempotency: idem,
        firstAttemptAt: 0,
        now: 1,
        attempts: 1,
        maxAttempts: 5,
      })._tag,
    ).toBe("Hold");
  });

  it("classifies 429 as not accepted and 5xx/transport errors as unknown", async () => {
    expect(classifyResendStatus(429, "")._tag).toBe("NotAccepted");
    expect(classifyResendStatus(502, "")._tag).toBe("Unknown");
    expect(classifyResendStatus(422, "")).toMatchObject({ _tag: "NotAccepted", retryable: false });

    const provider = makeResendNewsletterProvider(
      { apiKey: "k", webhookSecret: "whsec_AA==", account: "a" },
      async () => {
        throw new Error("reset");
      },
    );

    expect(await Effect.runPromise(provider.sendBroadcast("bc_1", "op", null))).toEqual({
      _tag: "Unknown",
      detail: "Error",
    });
    // Provider-side scheduling and custom headers are refused locally, never sent.
    expect((await Effect.runPromise(provider.sendBroadcast("bc_1", "op", 5)))._tag).toBe(
      "NotAccepted",
    );
    expect(
      (
        await Effect.runPromise(
          provider.createBroadcast({
            operationId: "op",
            audience: { audienceId: "s" },
            name: "n",
            from: "f",
            subject: "s",
            html: "h",
            text: "t",
            headers: { "List-Id": "x" },
          }),
        )
      )._tag,
    ).toBe("NotAccepted");
  });

  it("maps events conservatively: account-wide contact flags are provider scope, unknown types unmapped", () => {
    expect(
      mapResendEvent("e", {
        type: "contact.updated",
        created_at: "2026-09-26T00:00:00Z",
        data: { email: "A@Example.net", unsubscribed: true },
      }),
    ).toMatchObject({ kind: "contact-unsubscribed", scope: "provider", address: "a@example.net" });
    expect(
      mapResendEvent("e", {
        type: "email.bounced",
        data: { to: ["x@y.z"], broadcast_id: "bc", bounce: { type: "Permanent" } },
      }),
    ).toMatchObject({ kind: "hard-bounce", broadcastRef: "bc" });
    expect(
      mapResendEvent("e", { type: "email.bounced", data: { bounce: { type: "Transient" } } }).kind,
    ).toBe("soft-bounce");
    expect(mapResendEvent("e", { type: "email.opened", data: {} }).kind).toBe("informational");
    expect(mapResendEvent("e", { type: "domain.created", data: {} }).kind).toBe("unmapped");
  });
});

describe("verifySvix", () => {
  const KEY = new TextEncoder().encode("svix-test-key-0123456789");
  const B64 = btoa(String.fromCharCode(...KEY));
  const NOW = Date.UTC(2026, 8, 25, 12, 0, 0);
  const BODY = '{"type":"email.delivered"}';

  const sign = async (id: string, ts: string, body: string, key = KEY) => {
    const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, [
      "sign",
    ]);

    const mac = new Uint8Array(
      await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(`${id}.${ts}.${body}`)),
    );

    return btoa(String.fromCharCode(...mac));
  };

  const headers = (id: string, ts: string, sig: string) =>
    new Headers({ "svix-id": id, "svix-timestamp": ts, "svix-signature": sig });

  const ts = String(NOW / 1000);

  it("accepts a valid v1 signature with or without the whsec_ prefix", async () => {
    const h = headers("msg_1", ts, `v1,${await sign("msg_1", ts, BODY)}`);
    expect(await verifySvix(`whsec_${B64}`, BODY, h, NOW)).toEqual({ ok: true, id: "msg_1" });
    expect(await verifySvix(B64, BODY, h, NOW)).toEqual({ ok: true, id: "msg_1" });
  });

  it("rejects a bad signature, a tampered body, and a signature under another key", async () => {
    const good = await sign("msg_1", ts, BODY);
    const other = await sign("msg_1", ts, BODY, new TextEncoder().encode("another-key"));

    for (const [sig, body] of [
      [`v1,${other}`, BODY],
      [`v1,${good}`, `${BODY} `],
      [`v2,${good}`, BODY],
      [good, BODY],
    ] as const)
      expect(await verifySvix(`whsec_${B64}`, body, headers("msg_1", ts, sig), NOW)).toEqual({
        ok: false,
        detail: "bad signature",
      });
    // The id is part of the signed content.
    expect(
      await verifySvix(`whsec_${B64}`, BODY, headers("msg_2", ts, `v1,${good}`), NOW),
    ).toMatchObject({ ok: false, detail: "bad signature" });
  });

  it("accepts when any of several space-separated signatures matches (key rotation)", async () => {
    const good = await sign("msg_1", ts, BODY);
    const stale = await sign("msg_1", ts, BODY, new TextEncoder().encode("old-key"));
    const h = headers("msg_1", ts, `v1,${stale} v1a,${good} v1,${good}`);
    expect(await verifySvix(`whsec_${B64}`, BODY, h, NOW)).toEqual({ ok: true, id: "msg_1" });
    const none = headers("msg_1", ts, `v1,${stale} v1a,${good}`);
    expect((await verifySvix(`whsec_${B64}`, BODY, none, NOW)).ok).toBe(false);
  });

  it("rejects timestamps outside the tolerance in either direction, even when correctly signed", async () => {
    const within = String((NOW - SVIX_TOLERANCE_MS) / 1000);
    const hWithin = headers("msg_1", within, `v1,${await sign("msg_1", within, BODY)}`);
    expect((await verifySvix(`whsec_${B64}`, BODY, hWithin, NOW)).ok).toBe(true);

    for (const t of [
      String((NOW - SVIX_TOLERANCE_MS - 1000) / 1000),
      String((NOW + SVIX_TOLERANCE_MS + 1000) / 1000),
      "not-a-number",
    ]) {
      const h = headers("msg_1", t, `v1,${await sign("msg_1", t, BODY)}`);
      expect(await verifySvix(`whsec_${B64}`, BODY, h, NOW)).toEqual({
        ok: false,
        detail: "timestamp outside tolerance",
      });
    }
  });

  it("rejects missing headers, an empty secret, and an undecodable secret", async () => {
    const sig = `v1,${await sign("msg_1", ts, BODY)}`;
    expect(
      await verifySvix(`whsec_${B64}`, BODY, new Headers({ "svix-id": "msg_1" }), NOW),
    ).toEqual({ ok: false, detail: "missing signature" });
    expect(await verifySvix("", BODY, headers("msg_1", ts, sig), NOW)).toEqual({
      ok: false,
      detail: "missing signature",
    });
    expect(await verifySvix("whsec_!!!not base64", BODY, headers("msg_1", ts, sig), NOW)).toEqual({
      ok: false,
      detail: "bad secret",
    });
  });
});
