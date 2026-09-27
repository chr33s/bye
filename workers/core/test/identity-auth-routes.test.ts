import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  base32Decode,
  type CborValue,
  cborEncode,
  concatBytes,
  ControlAuth,
  ControlCommerce,
  ControlDirectory,
  hotp,
  rawToDer,
  sha256,
  sha256Hex,
  signBillingPayload,
  toBase64Url,
  totpStep,
  utf8,
} from "@bye/platform-cloudflare";
import { handleFetch } from "../src/api.ts";
import { kernelClock } from "../src/durable-host.ts";
import { authConfig } from "../src/services.ts";
import { type Harness, makeHarness, enablePersonalMail } from "./harness.ts";

// HTTP wiring for identity/security settings (TOTP, passkeys, support access, referrals), the signed
// provider webhooks, and the unauthenticated /auth/* routes (recovery, logout, passkey sign-in,
// forwarding confirmation, checkout status, rate limits) over in-memory bindings.

(globalThis as { FixedLengthStream?: unknown }).FixedLengthStream = class extends TransformStream {
  constructor(_length: number) {
    super();
  }
};

const ctx = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
} as unknown as ExecutionContext;

interface Account {
  readonly userId: string;
  readonly organizationId: string;
  readonly address: string;
  readonly cookie: string;
}

const auth = async (h: Harness) =>
  new ControlAuth(h.env.DIRECTORY, kernelClock, await authConfig(h.env));

const signup = async (h: Harness, address: string, steppedUp = true): Promise<Account> => {
  const account = await new ControlDirectory(h.env.DIRECTORY, kernelClock).provisionPersonalAccount(
    { address, displayName: address.split("@")[0]! },
  );
  const session = await (await auth(h)).issueSession(account.userId, "test", steppedUp);
  return { ...account, address, cookie: `__Host-session=${session.token}` };
};

/** A second, non-stepped-up browser session for the same user. */
const plainSession = async (h: Harness, a: Account): Promise<Account> => ({
  ...a,
  cookie: `__Host-session=${(await (await auth(h)).issueSession(a.userId, "other", false)).token}`,
});

const call = async (
  h: Harness,
  a: Account | null,
  method: string,
  path: string,
  json?: unknown,
  headers: Record<string, string> = {},
) => {
  const response = await handleFetch(
    new Request(`${h.env.APP_ORIGIN}${path}`, {
      method,
      headers: {
        ...(a ? { cookie: a.cookie } : {}),
        ...(method === "GET" ? {} : { origin: h.env.APP_ORIGIN }),
        ...(json !== undefined ? { "content-type": "application/json" } : {}),
        ...headers,
      },
      ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
    }),
    h.env,
    ctx,
  );
  const text = await response.text();
  const type = response.headers.get("content-type") ?? "";
  return {
    status: response.status,
    headers: response.headers,
    text,
    body: type.includes("json") && text ? JSON.parse(text) : null,
  };
};

/** Raw POST (webhooks): no cookie, no origin, exact body bytes. */
const post = async (h: Harness, path: string, body: string, headers: Record<string, string>) => {
  const response = await handleFetch(
    new Request(`${h.env.APP_ORIGIN}${path}`, { method: "POST", headers, body }),
    h.env,
    ctx,
  );
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
};

const cookieOf = (headers: Headers) => (headers.get("set-cookie") ?? "").split(";")[0]!.trim();

/** Software authenticator ("none" attestation, ES256) bound to the harness relying party. */
const authenticator = async (rpId: string, origin: string) => {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  const b64 = (s: string) =>
    Uint8Array.from(
      atob(s.replace(/-/g, "+").replace(/_/g, "/") + "==".slice(0, (4 - (s.length % 4)) % 4)),
      (c) => c.charCodeAt(0),
    );
  const credId = crypto.getRandomValues(new Uint8Array(16));
  let counter = 0;
  const authData = async (attested: boolean) => {
    const count = new Uint8Array(4);
    new DataView(count.buffer).setUint32(0, counter);
    const rpHash = await sha256(rpId);
    if (!attested) return concatBytes(rpHash, new Uint8Array([0x05]), count);
    const cose = cborEncode(
      new Map<CborValue, CborValue>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, b64(jwk.x!)],
        [-3, b64(jwk.y!)],
      ]),
    );
    return concatBytes(
      rpHash,
      new Uint8Array([0x45]),
      count,
      new Uint8Array(16),
      new Uint8Array([0, credId.length]),
      credId,
      cose,
    );
  };
  const clientData = (type: string, challenge: string) =>
    utf8(JSON.stringify({ type, challenge, origin }));
  return {
    credentialId: toBase64Url(credId),
    register: async (challenge: string) => ({
      clientDataJSON: toBase64Url(clientData("webauthn.create", challenge)),
      attestationObject: toBase64Url(
        cborEncode(
          new Map<CborValue, CborValue>([
            ["fmt", "none"],
            ["attStmt", new Map()],
            ["authData", await authData(true)],
          ]),
        ),
      ),
    }),
    assert: async (challenge: string) => {
      counter++;
      const ad = await authData(false);
      const cd = clientData("webauthn.get", challenge);
      const sig = new Uint8Array(
        await crypto.subtle.sign(
          { name: "ECDSA", hash: "SHA-256" },
          pair.privateKey,
          concatBytes(ad, await sha256(cd)),
        ),
      );
      return {
        credentialId: toBase64Url(credId),
        clientDataJSON: toBase64Url(cd),
        authenticatorData: toBase64Url(ad),
        signature: toBase64Url(rawToDer(sig)),
      };
    },
  };
};

const device = (h: Harness) => authenticator(new URL(h.env.APP_ORIGIN).hostname, h.env.APP_ORIGIN);

/** Add a passkey through the settings routes; returns the credential id and the authenticator. */
const addPasskey = async (h: Harness, a: Account, label = "laptop") => {
  const key = await device(h);
  const challenge = await call(h, a, "POST", "/v1/security/passkeys/challenge", {});
  expect(challenge.status).toBe(200);
  const added = await call(h, a, "POST", "/v1/security/passkeys", {
    challengeId: challenge.body.id,
    label,
    response: await key.register(challenge.body.challenge),
  });
  expect(added.status).toBe(201);
  expect(added.body.id).toBe(key.credentialId);
  return { id: added.body.id as string, key };
};

const hex = async (secret: string, body: string) => {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return [...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
};

describe("identity and security settings", () => {
  let h: Harness;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2026, 8, 25, 12));
    h = makeHarness();
  });
  afterEach(() => vi.useRealTimers());

  it("[A03] TOTP: enrol needs step-up, a wrong code does not confirm, confirm enables, removal needs step-up", async () => {
    const ana = await signup(h, "ana@bye.test");
    const plain = await plainSession(h, ana);
    const refused = await call(h, plain, "POST", "/v1/security/totp", {});
    expect([refused.status, refused.body.error.code, refused.body.error.details?.stepUp]).toEqual([
      403,
      "forbidden",
      true,
    ]);

    const enrol = await call(h, ana, "POST", "/v1/security/totp", {});
    expect(enrol.status).toBe(201);
    expect(enrol.body.otpauthUri).toContain(encodeURIComponent("app.bye.test:ana@bye.test"));
    expect(enrol.body.otpauthUri).toContain(`secret=${enrol.body.secret}`);
    expect((await call(h, ana, "GET", "/v1/security")).body.totp).toBe("pending");

    const code = await hotp(base32Decode(enrol.body.secret), totpStep(Date.now()));
    const wrong = String((Number(code) + 1) % 1_000_000).padStart(6, "0");
    const bad = await call(h, ana, "POST", "/v1/security/totp/confirm", { code: wrong });
    expect([bad.status, bad.body.error.code]).toEqual([401, "unauthenticated"]);
    const malformed = await call(h, ana, "POST", "/v1/security/totp/confirm", { code: "12345" });
    expect([malformed.status, malformed.body.error.code]).toEqual([400, "bad_request"]);
    expect((await call(h, ana, "GET", "/v1/security")).body.totp).toBe("pending");

    const confirmed = await call(h, ana, "POST", "/v1/security/totp/confirm", { code });
    expect([confirmed.status, confirmed.body]).toEqual([200, { enabled: true }]);
    expect((await call(h, ana, "GET", "/v1/security")).body.totp).toBe("enabled");

    const plainRemove = await call(h, plain, "DELETE", "/v1/security/totp");
    expect([
      plainRemove.status,
      plainRemove.body.error.code,
      plainRemove.body.error.details?.stepUp,
    ]).toEqual([403, "forbidden", true]);
    expect((await call(h, ana, "DELETE", "/v1/security/totp")).body).toEqual({ disabled: true });
    expect((await call(h, ana, "GET", "/v1/security")).body.totp).toBe("none");
    expect((await call(h, ana, "DELETE", "/v1/security/totp")).body).toEqual({ disabled: false });
  });

  it("[A03] passkeys: add needs step-up; delete is by id and scoped to the owner", async () => {
    const ana = await signup(h, "ana@bye.test");
    const bob = await signup(h, "bob@bye.test");
    const plain = await plainSession(h, ana);
    const noStepUp = await call(h, plain, "POST", "/v1/security/passkeys/challenge", {});
    expect([
      noStepUp.status,
      noStepUp.body.error.code,
      noStepUp.body.error.details?.stepUp,
    ]).toEqual([403, "forbidden", true]);

    const first = await addPasskey(h, ana, "laptop");
    const second = await addPasskey(h, ana, "phone");
    const list = await call(h, ana, "GET", "/v1/security/passkeys");
    expect(list.body.items.map((k: { id: string; label: string }) => [k.id, k.label])).toEqual([
      [first.id, "laptop"],
      [second.id, "phone"],
    ]);

    // A register challenge issued to Bob cannot enrol a key on Ana's account.
    const bobChallenge = await call(h, bob, "POST", "/v1/security/passkeys/challenge", {});
    const stolen = await call(h, ana, "POST", "/v1/security/passkeys", {
      challengeId: bobChallenge.body.id,
      response: await (await device(h)).register(bobChallenge.body.challenge),
    });
    expect([stolen.status, stolen.body.error.code]).toEqual([403, "forbidden"]);

    // Bob cannot delete Ana's passkey by id: not found for him, and hers is untouched.
    const cross = await call(h, bob, "DELETE", `/v1/security/passkeys/${first.id}`);
    expect([cross.status, cross.body.error.code]).toEqual([404, "not_found"]);
    const still = await call(h, ana, "GET", "/v1/security/passkeys");
    expect(still.body.items.map((k: { id: string }) => k.id)).toContain(first.id);
    expect(
      await h.d1
        .prepare("SELECT user_id FROM passkeys WHERE credential_id = ?")
        .bind(first.id)
        .first(),
    ).toEqual({ user_id: ana.userId });

    const plainDelete = await call(h, plain, "DELETE", `/v1/security/passkeys/${first.id}`);
    expect([
      plainDelete.status,
      plainDelete.body.error.code,
      plainDelete.body.error.details?.stepUp,
    ]).toEqual([403, "forbidden", true]);
    expect((await call(h, ana, "DELETE", `/v1/security/passkeys/${first.id}`)).body).toEqual({
      removed: true,
    });
    // The last sign-in credential stays unless a recovery code remains.
    const last = await call(h, ana, "DELETE", `/v1/security/passkeys/${second.id}`);
    expect([last.status, last.body.error.code]).toEqual([409, "conflict"]);
    expect((await call(h, ana, "GET", "/v1/security")).body.passkeys).toBe(1);
  });

  it("[§10] support access: granting needs step-up and a bounded duration; only the owner revokes", async () => {
    const ana = await signup(h, "ana@bye.test");
    const bob = await signup(h, "bob@bye.test");
    const plain = await plainSession(h, ana);
    const refused = await call(h, plain, "POST", "/v1/support-access", { reason: "billing" });
    expect([refused.status, refused.body.error.code, refused.body.error.details?.stepUp]).toEqual([
      403,
      "forbidden",
      true,
    ]);
    const tooLong = await call(h, ana, "POST", "/v1/support-access", { reason: "x", hours: 73 });
    expect([tooLong.status, tooLong.body.error.code]).toEqual([400, "bad_request"]);

    const grant = await call(h, ana, "POST", "/v1/support-access", { reason: "billing", hours: 2 });
    expect(grant.status).toBe(201);
    expect(grant.body.expiresAt).toBe(Date.now() + 2 * 3600_000);
    const listed = await call(h, ana, "GET", "/v1/support-access");
    expect(listed.body.items).toEqual([
      expect.objectContaining({ id: grant.body.id, reason: "billing", active: true }),
    ]);
    expect((await call(h, bob, "GET", "/v1/support-access")).body.items).toEqual([]);

    const cross = await call(h, bob, "DELETE", `/v1/support-access/${grant.body.id}`);
    expect([cross.status, cross.body.error.code]).toEqual([404, "not_found"]);
    expect((await call(h, ana, "GET", "/v1/support-access")).body.items[0].active).toBe(true);
    expect((await call(h, ana, "DELETE", `/v1/support-access/${grant.body.id}`)).body).toEqual({
      revoked: true,
    });
    expect((await call(h, ana, "GET", "/v1/support-access")).body.items[0].active).toBe(false);
    // Revoking twice is a 404, not a silent success.
    expect((await call(h, ana, "DELETE", `/v1/support-access/${grant.body.id}`)).status).toBe(404);
  });

  it("[A02] referral: one stable code per user, linked to signup", async () => {
    const ana = await signup(h, "ana@bye.test");
    const bob = await signup(h, "bob@bye.test");
    const first = await call(h, ana, "GET", "/v1/referral");
    expect(first.status).toBe(200);
    expect(first.body.url).toBe(`${h.env.APP_ORIGIN}/signup?ref=${first.body.code}`);
    expect((await call(h, ana, "GET", "/v1/referral")).body.code).toBe(first.body.code);
    expect((await call(h, bob, "GET", "/v1/referral")).body.code).not.toBe(first.body.code);
    expect((await call(h, null, "GET", "/v1/referral")).status).toBe(401);
  });
});

describe("signed provider webhooks", () => {
  let h: Harness;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2026, 8, 25, 12));
    h = makeHarness();
    enablePersonalMail(h);
  });
  afterEach(() => vi.useRealTimers());

  it("[A02] /webhooks/billing: a valid signature applies once; bad, stale or missing signatures are 401; bad bodies 400; outages 503", async () => {
    const ana = await signup(h, "ana@bye.test");
    const event = JSON.stringify({
      id: "evt_credit_1",
      orgId: ana.organizationId,
      type: "credit.granted",
      cents: 500,
      created: Date.now(),
    });
    const secret = h.env.BILLING_WEBHOOK_SECRET;
    const signed = await signBillingPayload(event, secret, Date.now());
    const ok = await post(h, "/webhooks/billing", event, { "x-billing-signature": signed });
    expect([ok.status, ok.body]).toEqual([200, { applied: true, duplicate: false }]);
    const credits = await h.d1
      .prepare("SELECT credits_cents FROM entitlements WHERE org_id = ?")
      .bind(ana.organizationId)
      .first<{ credits_cents: number }>();
    expect(credits?.credits_cents).toBeGreaterThanOrEqual(500);
    const replay = await post(h, "/webhooks/billing", event, { "x-billing-signature": signed });
    expect(replay.body).toEqual({ applied: false, duplicate: true });

    const tampered = event.replace("500", "50000");
    for (const [body, headers] of [
      [tampered, { "x-billing-signature": signed }],
      [event, {}],
      [
        event,
        { "x-billing-signature": await signBillingPayload(event, "wrong-secret", Date.now()) },
      ],
      // Outside the replay tolerance window.
      [
        event,
        { "x-billing-signature": await signBillingPayload(event, secret, Date.now() - 3600_000) },
      ],
    ] as const) {
      const r = await post(h, "/webhooks/billing", body, headers);
      expect([r.status, r.body.error.code]).toEqual([401, "unauthenticated"]);
    }
    const garbage = "not json";
    const badBody = await post(h, "/webhooks/billing", garbage, {
      "x-billing-signature": await signBillingPayload(garbage, secret, Date.now()),
    });
    expect([badBody.status, badBody.body.error.code]).toEqual([400, "bad_request"]);
    const missingFields = JSON.stringify({ id: "evt_2" });
    const incomplete = await post(h, "/webhooks/billing", missingFields, {
      "x-billing-signature": await signBillingPayload(missingFields, secret, Date.now()),
    });
    expect([incomplete.status, incomplete.body.error.code]).toEqual([400, "bad_request"]);
    const events = await h.d1.prepare("SELECT provider_event_id FROM billing_events").all();
    expect(events.results).toEqual([{ provider_event_id: "evt_credit_1" }]);

    // A storage failure while applying a valid event is retryable (503), not a final 400.
    const later = JSON.stringify({
      id: "evt_credit_2",
      orgId: ana.organizationId,
      type: "credit.granted",
      cents: 100,
      created: Date.now(),
    });
    const prepare = h.d1.prepare.bind(h.d1);
    const spy = vi.spyOn(h.d1, "prepare").mockImplementation((sql: string) => {
      if (/billing_events/.test(sql)) throw new Error("D1 unavailable");
      return prepare(sql);
    });
    const outage = await post(h, "/webhooks/billing", later, {
      "x-billing-signature": await signBillingPayload(later, secret, Date.now()),
    });
    spy.mockRestore();
    expect([outage.status, outage.body.error.code]).toEqual([503, "unavailable"]);
  });

  it("[§5.2] /webhooks/send-events: a dedicated timestamped signature over a send in our ledger is accepted; anything else is refused", async () => {
    const secret = "send-events-secret-0123456789abcdef0123";
    (h.env as { SEND_EVENTS_WEBHOOK_SECRET?: string }).SEND_EVENTS_WEBHOOK_SECRET = secret;
    await h.d1
      .prepare(
        "INSERT INTO send_acceptances (provider_id, mailbox_id, send_job_id, transport, accepted_at) VALUES ('prov_1', 'mbx_1', 'sj_1', 'personal', ?)",
      )
      .bind(Date.now())
      .run();
    const event = (over: Record<string, string> = {}) =>
      JSON.stringify({
        eventId: "pev_1",
        sendJobId: "sj_1",
        mailboxId: "mbx_1",
        recipient: "bob@example.net",
        outcome: "delivered",
        ...over,
      });
    const body = event();
    const signed = (b: string, key = secret, at = Date.now()) =>
      signBillingPayload(b, key, at).then((sig) => ({ "x-bye-signature": sig }));
    const ok = await post(h, "/webhooks/send-events", body, await signed(body));
    expect([ok.status, ok.body]).toEqual([200, { ok: true }]);

    for (const headers of [
      {} as Record<string, string>,
      await signed(body, "wrong-secret-0123456789abcdef0123456789"),
      // Outside the replay window.
      await signed(body, secret, Date.now() - 10 * 60_000),
      { "x-bye-signature": "t=1,v1=not-hex" },
      // The old scheme (bare HMAC with the provider API key) no longer verifies.
      { "x-signature": await hex("pm-key", body) },
    ]) {
      const r = await post(h, "/webhooks/send-events", body, headers);
      expect([r.status, r.body.error.code]).toEqual([401, "unauthenticated"]);
    }
    const invalid = JSON.stringify({ eventId: "pev_2", outcome: "exploded" });
    const r = await post(h, "/webhooks/send-events", invalid, await signed(invalid));
    expect([r.status, r.body.error.code]).toEqual([400, "bad_request"]);

    // The body's mailbox is never trusted: the (mailbox, job) pair must be in our send ledger.
    for (const other of [event({ sendJobId: "sj_unknown" }), event({ mailboxId: "mbx_other" })]) {
      const res = await post(h, "/webhooks/send-events", other, await signed(other));
      expect([res.status, res.body.error.code]).toEqual([404, "not_found"]);
    }

    // A missing or short secret verifies nothing, even a signature made with it.
    (h.env as { SEND_EVENTS_WEBHOOK_SECRET?: string }).SEND_EVENTS_WEBHOOK_SECRET = "short";
    const weak = await post(h, "/webhooks/send-events", body, await signed(body, "short"));
    expect(weak.status).toBe(401);
  });
});

describe("unauthenticated auth routes", () => {
  let h: Harness;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2026, 8, 25, 12));
    h = makeHarness();
  });
  afterEach(() => vi.useRealTimers());

  it("[A03] /auth/logout revokes the session: the old cookie is unusable afterwards", async () => {
    const ana = await signup(h, "ana@bye.test");
    const other = await plainSession(h, ana);
    expect((await call(h, ana, "GET", "/v1/me")).status).toBe(200);
    const out = await call(h, ana, "POST", "/auth/logout");
    expect(out.status).toBe(200);
    expect(out.headers.get("set-cookie")).toMatch(/__Host-session=;|Max-Age=0/i);
    const after = await call(h, ana, "GET", "/v1/me");
    expect([after.status, after.body.error.code]).toEqual([401, "unauthenticated"]);
    // Only the logged-out session ends; the user's other session keeps working.
    expect((await call(h, other, "GET", "/v1/me")).status).toBe(200);
    // Logging out without (or with a dead) cookie is harmless.
    expect((await call(h, null, "POST", "/auth/logout")).status).toBe(200);
    expect((await call(h, ana, "POST", "/auth/logout")).status).toBe(200);
  });

  it("[A03] /auth/recover: a single-use code signs in and revokes every existing credential", async () => {
    const ana = await signup(h, "ana@bye.test");
    const codes = (await call(h, ana, "POST", "/v1/security/recovery-codes", {})).body
      .codes as Array<string>;
    const token = await call(h, ana, "POST", "/v1/tokens", { kind: "cli", label: "laptop" });
    expect(token.status).toBe(201);

    const wrong = await call(h, null, "POST", "/auth/recover", {
      address: "ana@bye.test",
      code: "AAAA-BBBB-CCCC-DDDD",
    });
    expect([wrong.status, wrong.body.error.code]).toEqual([401, "unauthenticated"]);
    const unknown = await call(h, null, "POST", "/auth/recover", {
      address: "nobody@bye.test",
      code: codes[0],
    });
    // Unknown addresses are indistinguishable from wrong codes.
    expect([unknown.status, unknown.body]).toEqual([wrong.status, wrong.body]);

    const recovered = await call(h, null, "POST", "/auth/recover", {
      address: "ANA@bye.test",
      code: codes[0]!.toLowerCase(),
    });
    expect(recovered.status).toBe(200);
    const fresh = { ...ana, cookie: cookieOf(recovered.headers) };
    expect((await call(h, fresh, "GET", "/v1/me")).body.userId).toBe(ana.userId);
    expect((await call(h, ana, "GET", "/v1/me")).status).toBe(401);
    expect(
      (
        await h.d1
          .prepare("SELECT revoked_at FROM api_tokens WHERE id = ?")
          .bind(token.body.id)
          .first<{ revoked_at: number | null }>()
      )?.revoked_at,
    ).not.toBeNull();
    const reused = await call(h, null, "POST", "/auth/recover", {
      address: "ana@bye.test",
      code: codes[0],
    });
    expect(reused.status).toBe(401);
    expect((await call(h, fresh, "GET", "/v1/security")).body.recoveryCodesRemaining).toBe(
      codes.length - 1,
    );
  });

  it("[A03] /auth/passkey/register binds the ceremony to its user; /auth/passkey/login signs in once per challenge", async () => {
    const directory = new ControlDirectory(h.env.DIRECTORY, kernelClock);
    const ana = await directory.provisionPersonalAccount({
      address: "ana@bye.test",
      displayName: "A",
    });
    const bob = await directory.provisionPersonalAccount({
      address: "bob@bye.test",
      displayName: "B",
    });
    const key = await device(h);
    const challenge = await (await auth(h)).beginChallenge("register", ana.userId);
    const response = await key.register(challenge.challenge);
    // A register challenge bound to Ana cannot enrol a key for Bob.
    const hijack = await call(h, null, "POST", "/auth/passkey/register", {
      userId: bob.userId,
      challengeId: challenge.id,
      response,
    });
    expect([hijack.status, hijack.body.error.code]).toEqual([401, "unauthenticated"]);
    const fresh = await (await auth(h)).beginChallenge("register", ana.userId);
    const registered = await call(h, null, "POST", "/auth/passkey/register", {
      userId: ana.userId,
      challengeId: fresh.id,
      response: await key.register(fresh.challenge),
    });
    expect(registered.status).toBe(201);
    const session = { ...ana, address: "ana@bye.test", cookie: cookieOf(registered.headers) };
    expect((await call(h, session, "GET", "/v1/me")).body.userId).toBe(ana.userId);
    expect((await call(h, null, "POST", "/auth/passkey/register", {})).status).toBe(400);

    const login = await call(h, null, "POST", "/auth/challenge", { purpose: "authenticate" });
    expect(login.status).toBe(200);
    const assertion = await key.assert(login.body.challenge);
    const signedIn = await call(h, null, "POST", "/auth/passkey/login", {
      challengeId: login.body.id,
      response: assertion,
    });
    expect(signedIn.status).toBe(200);
    const cookie = cookieOf(signedIn.headers);
    expect((await call(h, { ...session, cookie }, "GET", "/v1/me")).body.userId).toBe(ana.userId);
    // Replaying the same challenge (single-use) fails.
    const replay = await call(h, null, "POST", "/auth/passkey/login", {
      challengeId: login.body.id,
      response: await key.assert(login.body.challenge),
    });
    expect([replay.status, replay.body.error.code]).toEqual([401, "unauthenticated"]);
    // An unknown credential fails the same way.
    const other = await call(h, null, "POST", "/auth/challenge", { purpose: "authenticate" });
    const stranger = await device(h);
    const bad = await call(h, null, "POST", "/auth/passkey/login", {
      challengeId: other.body.id,
      response: await stranger.assert(other.body.challenge),
    });
    expect([bad.status, bad.body.error.code]).toEqual([401, "unauthenticated"]);
  });

  it("[A03] session-issuing routes refuse cross-site and non-JSON posts (login CSRF)", async () => {
    const ana = await signup(h, "ana@bye.test");
    const codes = (await call(h, ana, "POST", "/v1/security/recovery-codes", {})).body
      .codes as Array<string>;
    const recover = JSON.stringify({ address: "ana@bye.test", code: codes[0] });
    const attempts: Array<Record<string, string>> = [
      // A hostile page's auto-submitted text/plain form (no preflight).
      { origin: "https://evil.example", "content-type": "text/plain" },
      { origin: "https://evil.example", "content-type": "application/json" },
      // Origin withheld by referrer policy: only Sec-Fetch-Site same-origin passes.
      { "sec-fetch-site": "cross-site", "content-type": "application/json" },
      {},
      // Same origin, but not JSON.
      { origin: h.env.APP_ORIGIN, "content-type": "text/plain" },
      { origin: h.env.APP_ORIGIN, "content-type": "application/x-www-form-urlencoded" },
    ];
    for (const path of ["/auth/recover", "/auth/passkey/login", "/auth/passkey/register"]) {
      for (const headers of attempts) {
        const r = await handleFetch(
          new Request(`${h.env.APP_ORIGIN}${path}`, { method: "POST", headers, body: recover }),
          h.env,
          ctx,
        );
        expect([path, headers, r.status]).toEqual([path, headers, 403]);
        expect(r.headers.get("set-cookie")).toBeNull();
      }
    }
    // The code was never spent: a same-origin JSON recovery (even without Origin) still works.
    const ok = await handleFetch(
      new Request(`${h.env.APP_ORIGIN}/auth/recover`, {
        method: "POST",
        headers: {
          "sec-fetch-site": "same-origin",
          "content-type": "application/json; charset=utf-8",
        },
        body: recover,
      }),
      h.env,
      ctx,
    );
    expect(ok.status).toBe(200);
    expect(ok.headers.get("set-cookie")).toMatch(/__Host-session=/);
  });

  it("[§10] consent form posts read a capped body: an oversized one is refused, not buffered", async () => {
    const ana = await signup(h, "ana@bye.test");
    for (const path of ["/device", "/oauth/authorize"]) {
      // 1 MiB offered in 1 KiB chunks; count how much of it the handler pulls.
      let pulled = 0;
      const chunk = new TextEncoder().encode("a".repeat(1024));
      const body = new ReadableStream<Uint8Array>({
        start: (c) => c.enqueue(new TextEncoder().encode("user_code=ABCD&decision=allow&pad=")),
        pull: (c) => {
          if (pulled >= 1024 * 1024) return c.close();
          pulled += chunk.byteLength;
          c.enqueue(chunk);
        },
      });
      const r = await handleFetch(
        new Request(`${h.env.APP_ORIGIN}${path}`, {
          method: "POST",
          headers: {
            cookie: ana.cookie,
            origin: h.env.APP_ORIGIN,
            "content-type": "application/x-www-form-urlencoded",
          },
          // A stream has no content-length: only the reader's cap bounds it.
          body,
          duplex: "half",
        } as RequestInit),
        h.env,
        ctx,
      );
      expect([path, r.status]).toEqual([path, 400]);
      expect(pulled).toBeLessThan(64 * 1024);
    }
  });

  it("[A04] /auth/forwarding/confirm verifies the emailed token for that address only", async () => {
    const ana = await signup(h, "ana@bye.test");
    const token = "forwarding-token-123";
    await h.d1
      .prepare(
        "INSERT INTO address_reservations (address, user_id, reason, reserved_until, forwarding_until, forwarding_to, created_at) VALUES (?, ?, 'closure-hold', ?, ?, ?, ?)",
      )
      .bind(
        "ana@bye.test",
        ana.userId,
        Date.now() + 86400_000,
        Date.now() + 86400_000,
        `ana@example.net#${await sha256Hex(`${h.env.SESSION_KEY}:${token}`)}`,
        Date.now(),
      )
      .run();
    const verified = () =>
      h.d1
        .prepare(
          "SELECT forwarding_to, forwarding_verified_at FROM address_reservations WHERE address = ?",
        )
        .bind("ana@bye.test")
        .first<{ forwarding_to: string; forwarding_verified_at: number | null }>();
    const wrong = await call(
      h,
      null,
      "GET",
      `/auth/forwarding/confirm?address=ana@bye.test&token=nope`,
    );
    expect(wrong.status).toBe(400);
    expect(wrong.text).toContain("invalid or expired");
    const otherAddress = await call(
      h,
      null,
      "GET",
      `/auth/forwarding/confirm?address=bob@bye.test&token=${token}`,
    );
    expect(otherAddress.status).toBe(400);
    expect((await verified())?.forwarding_verified_at).toBeNull();

    const ok = await call(
      h,
      null,
      "GET",
      `/auth/forwarding/confirm?address=ana@bye.test&token=${token}`,
    );
    expect(ok.status).toBe(200);
    expect(ok.text).toContain("Forwarding confirmed");
    expect(await verified()).toEqual({
      forwarding_to: "ana@example.net",
      forwarding_verified_at: Date.now(),
    });
    // The token is spent: the stored hash is gone, so the same link no longer verifies.
    expect(
      (await call(h, null, "GET", `/auth/forwarding/confirm?address=ana@bye.test&token=${token}`))
        .status,
    ).toBe(400);
  });

  it("[A02] /auth/checkout/status answers only for the signed return link", async () => {
    const commerce = new ControlCommerce(h.env.DIRECTORY, kernelClock, null, h.env.SESSION_KEY);
    await h.d1
      .prepare(
        "INSERT INTO checkout_sessions (id, org_id, user_id, purpose, plan, interval, seats, address, referral_code, status, created_at, expires_at) VALUES ('chk_1', NULL, NULL, 'short-address', 'short-address', 'annual', 1, 'ab@bye.test', NULL, 'open', ?, ?)",
      )
      .bind(Date.now(), Date.now() + 3600_000)
      .run();
    const sig = await commerce.returnSignature("chk_1");
    const ok = await call(h, null, "GET", `/auth/checkout/status?checkout=chk_1&sig=${sig}`);
    expect([ok.status, ok.body]).toEqual([200, { status: "open", purpose: "short-address" }]);
    vi.setSystemTime(Date.now() + 2 * 3600_000);
    expect(
      (await call(h, null, "GET", `/auth/checkout/status?checkout=chk_1&sig=${sig}`)).body.status,
    ).toBe("expired");
    for (const query of [
      `checkout=chk_1&sig=${"0".repeat(sig.length)}`,
      "checkout=chk_1",
      `checkout=chk_2&sig=${sig}`,
      `checkout=chk_missing&sig=${await commerce.returnSignature("chk_missing")}`,
    ]) {
      const r = await call(h, null, "GET", `/auth/checkout/status?${query}`);
      expect([query, r.status, r.body.error.code]).toEqual([query, 403, "forbidden"]);
    }
  });

  it("[A03] per-IP rate limits refuse challenge, sign-in, recovery, signup, registration and step-up before any work", async () => {
    const ana = await signup(h, "ana@bye.test");
    const denied = new Set<string>();
    h.rateLimit.deny = (key) => [...denied].some((prefix) => key.startsWith(prefix));
    const ip = { "cf-connecting-ip": "203.0.113.9" };
    const cases: Array<[string, string, unknown, Account | null]> = [
      ["auth:", "/auth/challenge", { purpose: "authenticate" }, null],
      ["login:", "/auth/passkey/login", {}, null],
      ["recover:", "/auth/recover", { address: "ana@bye.test", code: "x" }, null],
      ["signup:", "/auth/signup", { address: "new@bye.test", turnstile: "t" }, null],
      ["checkout:", "/auth/short-address/checkout", { address: "ab@bye.test" }, null],
      ["signup-challenge:", "/auth/signup/challenge", { userId: "usr_x", signupToken: "t" }, null],
      ["register:", "/auth/passkey/register", { userId: "usr_x" }, null],
      ["stepup:", "/auth/step-up/totp", { code: "123456" }, ana],
    ];
    for (const [prefix, path, body, who] of cases) {
      denied.clear();
      denied.add(prefix);
      h.rateLimit.keys.length = 0;
      const r = await call(h, who, "POST", path, body, ip);
      expect([path, r.status, r.body.error.code]).toEqual([path, 429, "rate_limited"]);
      expect(h.rateLimit.keys.some((k) => k.startsWith(prefix))).toBe(true);
      if (prefix !== "stepup:") expect(h.rateLimit.keys).toContain(`${prefix}203.0.113.9`);
    }
    // Nothing was created by the refused signup.
    expect(
      await h.d1.prepare("SELECT 1 AS x FROM users WHERE primary_address = 'new@bye.test'").first(),
    ).toBeNull();
    // Allowed again: the challenge route answers normally.
    denied.clear();
    expect((await call(h, null, "POST", "/auth/challenge", {}, ip)).status).toBe(200);
  });
});
