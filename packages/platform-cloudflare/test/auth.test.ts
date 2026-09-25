import { describe, expect, it } from "vitest";
import {
  base32Decode,
  checkCsrf,
  concatBytes,
  ControlAuth,
  ControlDirectory,
  credentialKindOf,
  type CborValue,
  cborEncode,
  CHALLENGE_TTL_MS,
  derToRaw,
  fromBase64Url,
  hotp,
  rawToDer,
  readCookie,
  sessionCookie,
  sha256,
  sha256Hex,
  SESSION_TTL_MS,
  toBase64Url,
  totpStep,
  utf8,
} from "@bye/platform-cloudflare";
import { MemoryD1, TestClock } from "@bye/testing";
import { Rejection } from "@bye/platform-cloudflare";

const RP = { rpId: "bye.test", origins: ["https://app.bye.test"], requireUserVerification: true };

const setup = async () => {
  const d1 = MemoryD1.migrated();
  const clock = new TestClock();
  const keys = {
    current: 2,
    keys: {
      1: crypto.getRandomValues(new Uint8Array(32)),
      2: crypto.getRandomValues(new Uint8Array(32)),
    },
  };
  const auth = new ControlAuth(d1, clock, { rp: RP, totpKeys: keys, recoveryPepper: "pepper" });
  const dir = new ControlDirectory(d1, clock);
  const account = await dir.provisionPersonalAccount({
    address: "alice@bye.test",
    displayName: "Alice",
  });
  return { d1, clock, auth, dir, account, keys };
};

/** Software authenticator producing "none" attestation and DER ES256 signatures. */
const authenticator = async () => {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const b64 = (s: string) =>
    Uint8Array.from(
      atob(s.replace(/-/g, "+").replace(/_/g, "/") + "==".slice(0, (4 - (s.length % 4)) % 4)),
      (c) => c.charCodeAt(0),
    );
  const credId = crypto.getRandomValues(new Uint8Array(16));
  let counter = 0;
  const authData = async (
    attested: boolean,
    {
      flags = 0x05,
      rpId = RP.rpId,
      alg = -7,
    }: { flags?: number; rpId?: string; alg?: number } = {},
  ) => {
    const rpHash = await sha256(rpId);
    const count = new Uint8Array(4);
    new DataView(count.buffer).setUint32(0, counter);
    if (!attested) return concatBytes(rpHash, new Uint8Array([flags]), count);
    const cose = cborEncode(
      new Map<CborValue, CborValue>([
        [1, 2],
        [3, alg],
        [-1, 1],
        [-2, b64(jwk.x!)],
        [-3, b64(jwk.y!)],
      ]),
    );
    const idLen = new Uint8Array([0, credId.length]);
    return concatBytes(
      rpHash,
      new Uint8Array([flags | 0x40]),
      count,
      new Uint8Array(16),
      idLen,
      credId,
      cose,
    );
  };
  const clientData = (
    type: string,
    challenge: string,
    origin = RP.origins[0]!,
    extra: Record<string, unknown> = {},
  ) => utf8(JSON.stringify({ type, challenge, origin, ...extra }));
  /** Tamper knobs for negative ceremonies; defaults produce a valid response. */
  interface Tamper {
    readonly type?: string;
    readonly origin?: string;
    readonly crossOrigin?: boolean;
    readonly flags?: number;
    readonly rpId?: string;
  }
  return {
    credentialId: toBase64Url(credId),
    register: async (challenge: string, opts: Tamper & { fmt?: string; alg?: number } = {}) => ({
      clientDataJSON: toBase64Url(
        clientData(
          opts.type ?? "webauthn.create",
          challenge,
          opts.origin,
          opts.crossOrigin === undefined ? {} : { crossOrigin: opts.crossOrigin },
        ),
      ),
      attestationObject: toBase64Url(
        cborEncode(
          new Map<CborValue, CborValue>([
            ["fmt", opts.fmt ?? "none"],
            ["attStmt", new Map()],
            ["authData", await authData(true, opts)],
          ]),
        ),
      ),
    }),
    assert: async (challenge: string, opts: Tamper & { counter?: number } = {}) => {
      counter = opts.counter ?? counter + 1;
      const ad = await authData(false, opts);
      const cd = clientData(
        opts.type ?? "webauthn.get",
        challenge,
        opts.origin,
        opts.crossOrigin === undefined ? {} : { crossOrigin: opts.crossOrigin },
      );
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

const code = (err: unknown) => (err instanceof Rejection ? err.code : String(err));

describe("authentication", () => {
  it("[A03] registers a passkey and signs in with an ES256 assertion; challenges are single-use", async () => {
    const { auth, account } = await setup();
    const device = await authenticator();
    const reg = await auth.beginChallenge("register", account.userId);
    await auth.registerPasskey(account.userId, reg.id, await device.register(reg.challenge));

    const login = await auth.beginChallenge("authenticate");
    const assertion = await device.assert(login.challenge);
    const { token } = await auth.authenticatePasskey(login.id, assertion, "laptop");
    const principal = await auth.principal(await auth.authenticate(token));
    expect(principal.userId).toBe(account.userId);
    expect(principal.mailboxIds).toEqual([account.mailboxId]);
    expect(principal.calendarIds).toEqual([account.calendarId]);

    await expect(auth.authenticatePasskey(login.id, assertion, "replay")).rejects.toSatisfy(
      (e) => code(e) === "unauthenticated",
    );
  });

  it("[A03] rejects wrong origin, bad signature, and signature-counter regression", async () => {
    const { auth, account } = await setup();
    const device = await authenticator();
    const reg = await auth.beginChallenge("register", account.userId);
    await auth.registerPasskey(account.userId, reg.id, await device.register(reg.challenge));

    const c1 = await auth.beginChallenge("authenticate");
    await expect(
      auth.authenticatePasskey(
        c1.id,
        await device.assert(c1.challenge, { origin: "https://evil.test" }),
        "x",
      ),
    ).rejects.toThrow("origin");

    const c2 = await auth.beginChallenge("authenticate");
    const good = await device.assert(c2.challenge, { counter: 5 });
    await auth.authenticatePasskey(c2.id, good, "x");

    const c3 = await auth.beginChallenge("authenticate");
    await expect(
      auth.authenticatePasskey(c3.id, await device.assert(c3.challenge, { counter: 5 }), "clone"),
    ).rejects.toThrow("counter");

    const c4 = await auth.beginChallenge("authenticate");
    const tampered = await device.assert(c4.challenge);
    const raw = derToRaw(fromBase64Url(tampered.signature));
    raw[10] = raw[10]! ^ 1;
    await expect(
      auth.authenticatePasskey(c4.id, { ...tampered, signature: toBase64Url(rawToDer(raw)) }, "x"),
    ).rejects.toThrow("signature");
  });

  it("[A03] the signature counter is compare-and-set: one of two racing same-counter assertions wins", async () => {
    const { auth, account, d1 } = await setup();
    const device = await authenticator();
    const reg = await auth.beginChallenge("register", account.userId);
    await auth.registerPasskey(account.userId, reg.id, await device.register(reg.challenge));
    const c1 = await auth.beginChallenge("authenticate");
    const c2 = await auth.beginChallenge("authenticate");
    // A cloned authenticator: both assertions carry counter 3 and both pass verification against
    // the stored 0, so only the counter CAS can tell them apart.
    const a1 = await device.assert(c1.challenge, { counter: 3 });
    const a2 = await device.assert(c2.challenge, { counter: 3 });
    const results = await Promise.allSettled([
      auth.authenticatePasskey(c1.id, a1, "a"),
      auth.authenticatePasskey(c2.id, a2, "b"),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const sessions = await d1
      .prepare("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?")
      .bind(account.userId)
      .first<{ n: number }>();
    expect(sessions?.n).toBe(1);
  });

  it("[A03] authenticators without a counter (always 0) keep signing in", async () => {
    const { auth, account } = await setup();
    const device = await authenticator();
    const reg = await auth.beginChallenge("register", account.userId);
    await auth.registerPasskey(account.userId, reg.id, await device.register(reg.challenge));
    for (const name of ["a", "b"]) {
      const c = await auth.beginChallenge("authenticate");
      await auth.authenticatePasskey(c.id, await device.assert(c.challenge, { counter: 0 }), name);
    }
  });

  it("[A03] TOTP second factor with replay protection and key rotation", async () => {
    const { auth, account, clock, keys } = await setup();
    const { secret } = await auth.enrollTotp(account.userId);
    const current = () => hotp(base32Decode(secret), totpStep(clock.now()));
    await auth.confirmTotp(account.userId, await current());
    const { session } = await auth.issueSession(account.userId, "phone");
    await expect(auth.stepUpWithTotp(session.id, await current())).rejects.toSatisfy(
      (e) => code(e) === "unauthenticated",
    );
    clock.advance(30_000);
    await auth.stepUpWithTotp(session.id, await current());

    const rotated = new ControlAuth(auth.db, clock, {
      ...auth.config,
      totpKeys: {
        current: 3,
        keys: { ...keys.keys, 3: crypto.getRandomValues(new Uint8Array(32)) },
      },
    });
    expect(await rotated.rotateTotpKeys()).toBe(1);
    clock.advance(30_000);
    await rotated.stepUpWithTotp(session.id, await current());
  });

  it("[A03] recovery codes work without mailbox access, are single-use, and revoke old sessions", async () => {
    const { auth, account } = await setup();
    const codes = await auth.generateRecoveryCodes(account.userId);
    const old = await auth.issueSession(account.userId, "stolen-laptop");
    const recovered = await auth.recoverWithCode(
      "Alice@bye.test",
      codes[3]!.toLowerCase(),
      "new-phone",
    );
    expect(recovered.session.step_up_at).not.toBeNull();
    await expect(auth.authenticate(old.token)).rejects.toSatisfy(
      (e) => code(e) === "unauthenticated",
    );
    await expect(auth.recoverWithCode("alice@bye.test", codes[3]!, "again")).rejects.toThrow(
      "recovery failed",
    );
    await expect(
      auth.recoverWithCode("alice@bye.test", "AAAA-BBBB-CCCC-DDDD", "guess"),
    ).rejects.toThrow("recovery failed");
  });

  it("[A03] recovery also revokes agent/CLI tokens and desktop device sessions (an attacker's footholds)", async () => {
    const { auth, account, clock } = await setup();
    const codes = await auth.generateRecoveryCodes(account.userId);
    const attacker = await auth.issueSession(account.userId, "attacker", true);
    const cli = await auth.createApiToken(attacker.session.user_id, {
      kind: "cli",
      label: "stolen",
    });
    const now = clock.now();
    await auth.db
      .prepare(
        "INSERT INTO device_sessions (id, user_id, client_id, device_name, created_at, last_used_at, idle_expires_at, absolute_expires_at) VALUES ('dvs_1', ?, 'bye-desktop', 'Evil Mac', ?, ?, ?, ?)",
      )
      .bind(account.userId, now, now, now + 86400_000, now + 180 * 86400_000)
      .run();
    await auth.recoverWithCode("alice@bye.test", codes[0]!, "new-phone");
    await expect(auth.authenticate(cli.token)).rejects.toSatisfy(
      (e) => code(e) === "unauthenticated",
    );
    const device = await auth.db
      .prepare("SELECT revoked_at, revoke_reason FROM device_sessions WHERE id = 'dvs_1'")
      .first<{ revoked_at: number | null; revoke_reason: string }>();
    expect(device).toMatchObject({ revoke_reason: "recovery" });
    expect(device?.revoked_at).not.toBeNull();
  });

  it("[A03] rotation revokes the old token; sessions list by device; stepped-up issue stamps now; revocation ends a session", async () => {
    const { auth, account, clock } = await setup();
    const a = await auth.issueSession(account.userId, "laptop");
    const rotated = await auth.rotateSession(a.token);
    await expect(auth.authenticate(a.token)).rejects.toThrow();
    expect((await auth.authenticate(rotated.token)).kind).toBe("session");
    const b = await auth.issueSession(account.userId, "phone", true);
    expect((await auth.listSessions(account.userId)).map((s) => s.device).sort()).toEqual([
      "laptop",
      "phone",
    ]);
    // The step-up window itself is enforced by the application's `requireStepUp` (control-app tests).
    expect(b.session.step_up_at).toBe(clock.now());
    expect(await auth.revokeSession(account.userId, b.session.id)).toBe(true);
    await expect(auth.authenticate(b.token)).rejects.toThrow();
  });

  it("[X02] agent tokens default to read/draft; unknown scopes are bad requests", async () => {
    const { auth, account } = await setup();
    const agent = await auth.createApiToken(account.userId, { kind: "agent", label: "assistant" });
    expect(agent.scopes).toEqual(["read", "draft"]);
    const p = await auth.principal(await auth.authenticate(agent.token));
    expect(p.kind).toBe("agent");
    expect(p.scopes).toEqual(["read", "draft"]);
    // Who may mint consequential scopes (step-up) is decided once, by the `issueApiToken` use case.
    await expect(
      auth.createApiToken(account.userId, {
        kind: "cli",
        label: "cli",
        scopes: ["read", "bogus" as never],
      }),
    ).rejects.toSatisfy((e) => code(e) === "bad_request");
    const cli = await auth.createApiToken(account.userId, {
      kind: "cli",
      label: "cli",
      scopes: ["read", "send"],
    });
    expect(await auth.revokeApiToken(account.userId, cli.id)).toBe(true);
    await expect(auth.authenticate(cli.token)).rejects.toThrow();
  });

  it("[A03] cookies are HTTP-only secure and unsafe cross-origin requests fail CSRF checks", () => {
    const cookie = sessionCookie("tok");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(readCookie(`a=b; __Host-session=tok`, "__Host-session")).toBe("tok");
    const h = (o: Record<string, string>) => ({ get: (n: string) => o[n] ?? null });
    expect(checkCsrf("POST", h({ origin: "https://app.bye.test" }), "https://app.bye.test")).toBe(
      true,
    );
    expect(checkCsrf("POST", h({ origin: "https://evil.test" }), "https://app.bye.test")).toBe(
      false,
    );
    expect(checkCsrf("POST", h({}), "https://app.bye.test")).toBe(false);
    expect(checkCsrf("GET", h({}), "https://app.bye.test")).toBe(true);
  });

  it("uses primary-consistent D1 sessions for authorization reads", async () => {
    const { auth, account, d1 } = await setup();
    const { token } = await auth.issueSession(account.userId, "x");
    d1.sessions.length = 0;
    await auth.principal(await auth.authenticate(token));
    expect(d1.sessions.every((s) => s === "first-primary")).toBe(true);
    expect(d1.sessions.length).toBeGreaterThan(0);
  });

  it("[A03] a recovery code redeems exactly once, even when two redemptions race", async () => {
    const { auth, account, d1 } = await setup();
    const [c] = await auth.generateRecoveryCodes(account.userId, 1);
    const results = await Promise.allSettled([
      auth.recoverWithCode("alice@bye.test", c!, "a"),
      auth.recoverWithCode("alice@bye.test", c!, "b"),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const live = await d1
      .prepare("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND revoked_at IS NULL")
      .bind(account.userId)
      .first<{ n: number }>();
    expect(live?.n).toBe(1);
    const audits = await d1
      .prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'recovery.redeem'")
      .first<{ n: number }>();
    expect(audits?.n).toBe(1);
  });

  it("[A03] credentials dispatch by prefix; a session token that happens to look prefixed still resolves", async () => {
    const { auth, account, d1, clock } = await setup();
    const odd = "bye_looks_like_an_api_token_but_is_a_session";
    const now = clock.now();
    await d1
      .prepare(
        "INSERT INTO sessions (id, user_id, token_hash, device, created_at, last_seen_at, expires_at) VALUES ('ses_odd', ?, ?, 'd', ?, ?, ?)",
      )
      .bind(account.userId, await sha256Hex(odd), now, now, now + 86_400_000)
      .run();
    expect((await auth.authenticate(odd)).kind).toBe("session");
    expect(credentialKindOf(odd)).toBe("api");
    expect(credentialKindOf("bda_x")).toBe("device");
    expect(credentialKindOf("plain")).toBe("session");
    await expect(auth.authenticate("bye_cli_unknown")).rejects.toSatisfy(
      (e) => code(e) === "unauthenticated",
    );
  });

  it("[A03] disabling TOTP deletes and audits atomically, once", async () => {
    const { auth, account, d1 } = await setup();
    await auth.enrollTotp(account.userId);
    expect(await auth.disableTotp(account.userId)).toBe(true);
    expect(await auth.disableTotp(account.userId)).toBe(false);
    const audits = await d1
      .prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'totp.disable'")
      .first<{ n: number }>();
    expect(audits?.n).toBe(1);
  });
});

/** Alice with a registered passkey, plus Bob with his own account and passkey. */
const twoUsers = async () => {
  const ctx = await setup();
  const bob = await ctx.dir.provisionPersonalAccount({
    address: "bob@bye.test",
    displayName: "Bob",
  });
  const aliceKey = await authenticator();
  const bobKey = await authenticator();
  for (const [userId, device] of [
    [ctx.account.userId, aliceKey],
    [bob.userId, bobKey],
  ] as const) {
    const reg = await ctx.auth.beginChallenge("register", userId);
    await ctx.auth.registerPasskey(userId, reg.id, await device.register(reg.challenge));
  }
  return { ...ctx, bob, aliceKey, bobKey };
};

describe("[A03] passkey step-up", () => {
  it("a valid assertion by the session's own passkey stamps step_up_at with now", async () => {
    const { auth, clock, account, aliceKey } = await twoUsers();
    const { token, session } = await auth.issueSession(account.userId, "laptop");
    expect(session.step_up_at).toBeNull();
    clock.advance(60_000);
    const c = await auth.beginChallenge("step-up", account.userId);
    await auth.stepUpWithPasskey(session.id, c.id, await aliceKey.assert(c.challenge));
    const cred = await auth.authenticate(token);
    expect(cred.kind === "session" ? cred.session.step_up_at : undefined).toBe(clock.now());
  });

  it("rejects another user's credential and leaves the session un-stepped", async () => {
    const { auth, account, bobKey } = await twoUsers();
    const { token, session } = await auth.issueSession(account.userId, "laptop");
    const c = await auth.beginChallenge("step-up", account.userId);
    await expect(
      auth.stepUpWithPasskey(session.id, c.id, await bobKey.assert(c.challenge)),
    ).rejects.toSatisfy((e) => code(e) === "forbidden");
    const cred = await auth.authenticate(token);
    expect(cred.kind === "session" ? cred.session.step_up_at : undefined).toBeNull();
  });

  it("a step-up challenge cannot be spent on sign-in", async () => {
    const { auth, account, aliceKey } = await twoUsers();
    const c = await auth.beginChallenge("step-up", account.userId);
    await expect(
      auth.authenticatePasskey(c.id, await aliceKey.assert(c.challenge), "x"),
    ).rejects.toSatisfy((e) => code(e) === "unauthenticated");
  });
});

describe("[A03] credentials are scoped to their owner", () => {
  it("another user cannot revoke a session; the owner's session keeps working", async () => {
    const { auth, account, bob } = await twoUsers();
    const a = await auth.issueSession(account.userId, "laptop");
    expect(await auth.revokeSession(bob.userId, a.session.id)).toBe(false);
    expect((await auth.authenticate(a.token)).kind).toBe("session");
  });

  it("another user cannot revoke an API token; the owner's token keeps working", async () => {
    const { auth, account, bob } = await twoUsers();
    const t = await auth.createApiToken(account.userId, {
      kind: "cli",
      label: "cli",
    });
    expect(await auth.revokeApiToken(bob.userId, t.id)).toBe(false);
    const cred = await auth.authenticate(t.token);
    expect(cred.kind).toBe("cli");
  });

  it("another user cannot remove a passkey; the owner can still sign in with it", async () => {
    const { auth, account, bob, aliceKey } = await twoUsers();
    await expect(auth.removePasskey(bob.userId, aliceKey.credentialId)).rejects.toSatisfy(
      (e) => code(e) === "not_found",
    );
    expect((await auth.listPasskeys(account.userId)).map((p) => p.id)).toEqual([
      aliceKey.credentialId,
    ]);
    const c = await auth.beginChallenge("authenticate");
    const { session } = await auth.authenticatePasskey(
      c.id,
      await aliceKey.assert(c.challenge),
      "x",
    );
    expect(session.user_id).toBe(account.userId);
  });
});

describe("[A03] expiry", () => {
  it("a session is valid through SESSION_TTL_MS and rejected one millisecond later", async () => {
    const { auth, account, clock } = await setup();
    const { token, session } = await auth.issueSession(account.userId, "laptop");
    clock.advance(SESSION_TTL_MS);
    expect((await auth.authenticate(token)).kind).toBe("session");
    clock.advance(1);
    await expect(auth.authenticate(token)).rejects.toSatisfy((e) => code(e) === "unauthenticated");
    // Step-up on an expired session is refused too.
    const c = await auth.beginChallenge("step-up", account.userId);
    await expect(auth.stepUpWithPasskey(session.id, c.id, {} as never)).rejects.toSatisfy(
      (e) => code(e) === "unauthenticated",
    );
  });

  it("a challenge older than CHALLENGE_TTL_MS is rejected", async () => {
    const { auth, clock, aliceKey } = await twoUsers();
    const c = await auth.beginChallenge("authenticate");
    clock.advance(CHALLENGE_TTL_MS + 1);
    await expect(
      auth.authenticatePasskey(c.id, await aliceKey.assert(c.challenge), "x"),
    ).rejects.toThrow("challenge invalid or expired");
  });
});

describe("[A03] WebAuthn ceremony verification rejects", () => {
  const registering = async () => {
    const { auth, account } = await setup();
    const device = await authenticator();
    const attempt = async (
      build: (challenge: string) => Promise<{ clientDataJSON: string; attestationObject: string }>,
    ) => {
      const reg = await auth.beginChallenge("register", account.userId);
      return auth.registerPasskey(account.userId, reg.id, await build(reg.challenge));
    };
    return { auth, account, device, attempt };
  };

  it.each([
    ["an assertion-typed clientData", { type: "webauthn.get" }, "unexpected ceremony type"],
    ["a cross-origin ceremony", { crossOrigin: true }, "cross-origin"],
    ["an rpIdHash for another RP", { rpId: "evil.test" }, "rpId hash mismatch"],
    ["missing user presence", { flags: 0x04 }, "user presence required"],
    ["missing user verification", { flags: 0x01 }, "user verification required"],
    ["non-none attestation", { fmt: "packed" }, "only 'none' attestation"],
    ["a non-ES256 key", { alg: -257 }, "only ES256"],
  ] as const)("registration with %s", async (_, opts, message) => {
    const { attempt, device } = await registering();
    await expect(attempt((ch) => device.register(ch, opts))).rejects.toThrow(message);
  });

  it("registration with a malformed CBOR attestation object", async () => {
    const { attempt, device } = await registering();
    for (const bytes of [
      new Uint8Array([0xa1]), // map of one entry, truncated
      new Uint8Array([0xc0, 0x00]), // tagged item
      new Uint8Array([0x01]), // not a map
    ]) {
      await expect(
        attempt(async (ch) => ({
          ...(await device.register(ch)),
          attestationObject: toBase64Url(bytes),
        })),
      ).rejects.toSatisfy((e) => code(e) === "unauthenticated");
    }
  });

  it.each([
    ["a registration-typed clientData", { type: "webauthn.create" }, "unexpected ceremony type"],
    ["a cross-origin ceremony", { crossOrigin: true }, "cross-origin"],
    ["an rpIdHash for another RP", { rpId: "evil.test" }, "rpId hash mismatch"],
    ["missing user presence", { flags: 0x04 }, "user presence required"],
    ["missing user verification", { flags: 0x01 }, "user verification required"],
  ] as const)("assertion with %s", async (_, opts, message) => {
    const { auth, account } = await setup();
    const device = await authenticator();
    const reg = await auth.beginChallenge("register", account.userId);
    await auth.registerPasskey(account.userId, reg.id, await device.register(reg.challenge));
    const c = await auth.beginChallenge("authenticate");
    await expect(
      auth.authenticatePasskey(c.id, await device.assert(c.challenge, opts), "x"),
    ).rejects.toThrow(message);
  });

  it("assertion with a non-DER or truncated DER signature", async () => {
    const { auth, account } = await setup();
    const device = await authenticator();
    const reg = await auth.beginChallenge("register", account.userId);
    await auth.registerPasskey(account.userId, reg.id, await device.register(reg.challenge));
    for (const bad of [
      new Uint8Array([0x31, 0x02, 0x02, 0x00]), // SEQUENCE tag wrong
      new Uint8Array([0x30, 0x04, 0x05, 0x01, 0x01, 0x00]), // INTEGER tag wrong
    ]) {
      const c = await auth.beginChallenge("authenticate");
      const good = await device.assert(c.challenge);
      await expect(
        auth.authenticatePasskey(c.id, { ...good, signature: toBase64Url(bad) }, "x"),
      ).rejects.toSatisfy((e) => code(e) === "unauthenticated");
    }
  });

  it("when the RP does not require user verification, UP alone suffices", async () => {
    const { auth, account } = await setup();
    const lax = new ControlAuth(auth.db, auth.clock, {
      ...auth.config,
      rp: { ...RP, requireUserVerification: false },
    });
    const device = await authenticator();
    const reg = await lax.beginChallenge("register", account.userId);
    await lax.registerPasskey(
      account.userId,
      reg.id,
      await device.register(reg.challenge, { flags: 0x01 }),
    );
    const c = await lax.beginChallenge("authenticate");
    const { session } = await lax.authenticatePasskey(
      c.id,
      await device.assert(c.challenge, { flags: 0x01 }),
      "x",
    );
    expect(session.user_id).toBe(account.userId);
  });
});
