import { describe, expect, it } from "vitest";
import {
  type AuthorizeParams,
  ControlDeviceAuth,
  ControlDirectory,
  DEVICE_ABSOLUTE_TTL_MS,
  DEVICE_CODE_TTL_MS,
  DEVICE_IDLE_TTL_MS,
  DeviceAuthError,
  pkceChallenge,
} from "@bye/platform-cloudflare";
import { MemoryD1, TestClock } from "@bye/testing";

// Browser-mediated desktop sign-in: authorization code + PKCE S256, rotating refresh credentials,
// idle/absolute session expiry, and revocation (RFC 6749, 7636, 8252, 7009, 9700).

const VERIFIER = "v".repeat(43) + "-._~0123456789";
const OTHER_VERIFIER = "w".repeat(64);

const setup = async () => {
  const d1 = MemoryD1.migrated();
  const clock = new TestClock();
  const directory = new ControlDirectory(d1, clock);
  const ana = await directory.provisionPersonalAccount({
    address: "ana@bye.test",
    displayName: "Ana",
  });
  const bob = await directory.provisionPersonalAccount({
    address: "bob@bye.test",
    displayName: "Bob",
  });
  const params: AuthorizeParams = {
    responseType: "code",
    clientId: "bye-desktop",
    redirectUri: "http://127.0.0.1:49152/oauth/callback",
    codeChallenge: await pkceChallenge(VERIFIER),
    codeChallengeMethod: "S256",
    state: "s".repeat(32),
    deviceName: "Ana's laptop",
  };
  return { d1, clock, ana, bob, params, devices: new ControlDeviceAuth(d1, clock) };
};

const errorCode = async (p: Promise<unknown>) => {
  try {
    await p;
    return "ok";
  } catch (e) {
    return e instanceof DeviceAuthError ? e.code : String(e);
  }
};

const syncCode = (f: () => unknown) => errorCode(Promise.resolve().then(f));

describe("device sign-in: authorization code + PKCE", () => {
  it("validateAuthorize rejects bad clients, redirects, response types, PKCE and state", async () => {
    const { devices, params } = await setup();
    expect(devices.validateAuthorize(params).client.clientId).toBe("bye-desktop");
    expect(
      devices.validateAuthorize({ ...params, redirectUri: "bye://oauth/callback" }).client.clientId,
    ).toBe("bye-desktop");
    const cases: ReadonlyArray<readonly [Partial<AuthorizeParams>, string]> = [
      [{ clientId: "evil" }, "invalid_client"],
      [{ redirectUri: "http://localhost:49152/oauth/callback" }, "invalid_request"],
      [{ redirectUri: "http://127.0.0.1:49152/other" }, "invalid_request"],
      [{ redirectUri: "http://127.0.0.1:49152/oauth/callback?x=1" }, "invalid_request"],
      [{ redirectUri: "https://127.0.0.1/oauth/callback" }, "invalid_request"],
      [{ clientId: "bye-mobile", redirectUri: params.redirectUri }, "invalid_request"],
      [{ responseType: "token" }, "invalid_request"],
      [{ codeChallengeMethod: "plain" }, "invalid_request"],
      [{ codeChallenge: "short" }, "invalid_request"],
      [{ state: "tooshort" }, "invalid_request"],
      [{ state: "s".repeat(257) }, "invalid_request"],
    ];
    for (const [patch, code] of cases)
      expect(await syncCode(() => devices.validateAuthorize({ ...params, ...patch }))).toBe(code);
  });

  it("issueCode validates first and stores only a hash bound to client, redirect and challenge", async () => {
    const { devices, params, ana, d1, clock } = await setup();
    expect(await errorCode(devices.issueCode(ana.userId, { ...params, state: "" }))).toBe(
      "invalid_request",
    );
    expect(await d1.prepare("SELECT COUNT(*) AS n FROM oauth_codes").first()).toEqual({ n: 0 });

    const code = await devices.issueCode(ana.userId, { ...params, deviceName: "x".repeat(300) });
    const row = await d1
      .prepare(
        "SELECT code_hash, user_id, client_id, redirect_uri, code_challenge, device_name, expires_at FROM oauth_codes",
      )
      .first<Record<string, unknown>>();
    expect(row).toMatchObject({
      user_id: ana.userId,
      client_id: "bye-desktop",
      redirect_uri: params.redirectUri,
      code_challenge: params.codeChallenge,
      expires_at: clock.now() + DEVICE_CODE_TTL_MS,
    });
    expect(row?.code_hash).not.toBe(code);
    expect(String(row?.device_name)).toHaveLength(120);
  });

  it("exchanges a code once for a working device session", async () => {
    const { devices, params, ana } = await setup();
    const code = await devices.issueCode(ana.userId, params);
    const exchange = {
      code,
      codeVerifier: VERIFIER,
      redirectUri: params.redirectUri,
      clientId: "bye-desktop",
    };
    const tokens = await devices.exchangeCode(exchange);
    expect(tokens).toMatchObject({ token_type: "Bearer", expires_in: 900, scope: "mail calendar" });
    const who = await devices.authenticateAccess(tokens.access_token);
    expect(who?.userId).toBe(ana.userId);
    expect((await devices.listSessions(ana.userId)).map((s) => s.deviceName)).toEqual([
      "Ana's laptop",
    ]);

    // Replaying the code fails and revokes the session it issued (RFC 6749 §4.1.2).
    expect(await errorCode(devices.exchangeCode(exchange))).toBe("invalid_grant");
    expect(await devices.authenticateAccess(tokens.access_token)).toBeNull();
    expect(await devices.listSessions(ana.userId)).toEqual([]);
    expect(
      await errorCode(
        devices.refresh({ refreshToken: tokens.refresh_token, clientId: "bye-desktop" }),
      ),
    ).toBe("invalid_grant");
  });

  it("rejects a PKCE mismatch and burns the code so the right verifier cannot follow", async () => {
    const { devices, params, ana } = await setup();
    const code = await devices.issueCode(ana.userId, params);
    const base = { code, redirectUri: params.redirectUri, clientId: "bye-desktop" };
    expect(await errorCode(devices.exchangeCode({ ...base, codeVerifier: "bad" }))).toBe(
      "invalid_request",
    );
    expect(await errorCode(devices.exchangeCode({ ...base, codeVerifier: OTHER_VERIFIER }))).toBe(
      "invalid_grant",
    );
    expect(await errorCode(devices.exchangeCode({ ...base, codeVerifier: VERIFIER }))).toBe(
      "invalid_grant",
    );
    expect(await devices.listSessions(ana.userId)).toEqual([]);
  });

  it("binds the code to its client and redirect, and expires it", async () => {
    const { devices, params, ana, clock } = await setup();
    const exchange = async (patch: { redirectUri?: string; clientId?: string }) =>
      errorCode(
        devices.exchangeCode({
          code: await devices.issueCode(ana.userId, params),
          codeVerifier: VERIFIER,
          redirectUri: params.redirectUri,
          clientId: "bye-desktop",
          ...patch,
        }),
      );
    expect(await exchange({ redirectUri: "http://127.0.0.1:1/oauth/callback" })).toBe(
      "invalid_grant",
    );
    expect(await exchange({ clientId: "bye-mobile" })).toBe("invalid_grant");
    expect(await exchange({ clientId: "evil" })).toBe("invalid_client");
    expect(
      await errorCode(
        devices.exchangeCode({
          code: "unknown",
          codeVerifier: VERIFIER,
          redirectUri: params.redirectUri,
          clientId: "bye-desktop",
        }),
      ),
    ).toBe("invalid_grant");

    const code = await devices.issueCode(ana.userId, params);
    clock.advance(DEVICE_CODE_TTL_MS + 1);
    expect(
      await errorCode(
        devices.exchangeCode({
          code,
          codeVerifier: VERIFIER,
          redirectUri: params.redirectUri,
          clientId: "bye-desktop",
        }),
      ),
    ).toBe("invalid_grant");
    expect(await devices.listSessions(ana.userId)).toEqual([]);
  });
});

describe("device sign-in: refresh, expiry and revocation", () => {
  const signIn = async () => {
    const env = await setup();
    const code = await env.devices.issueCode(env.ana.userId, env.params);
    const tokens = await env.devices.exchangeCode({
      code,
      codeVerifier: VERIFIER,
      redirectUri: env.params.redirectUri,
      clientId: "bye-desktop",
    });
    return { ...env, tokens };
  };

  it("rotates refresh credentials; replaying the old one revokes the session", async () => {
    const { devices, tokens, ana, clock } = await signIn();
    clock.advance(60_000);
    const next = await devices.refresh({
      refreshToken: tokens.refresh_token,
      clientId: "bye-desktop",
    });
    expect(next.refresh_token).not.toBe(tokens.refresh_token);
    expect(next.access_token).not.toBe(tokens.access_token);
    expect((await devices.authenticateAccess(next.access_token))?.userId).toBe(ana.userId);
    expect((await devices.listSessions(ana.userId))[0]?.lastUsedAt).toBe(clock.now());

    // Wrong client does not rotate or revoke.
    expect(
      await errorCode(
        devices.refresh({ refreshToken: next.refresh_token, clientId: "bye-mobile" }),
      ),
    ).toBe("invalid_grant");
    expect(await devices.authenticateAccess(next.access_token)).not.toBeNull();

    expect(
      await errorCode(
        devices.refresh({ refreshToken: tokens.refresh_token, clientId: "bye-desktop" }),
      ),
    ).toBe("invalid_grant");
    // Reuse detection kills the whole session, including the newest credentials.
    expect(await devices.authenticateAccess(next.access_token)).toBeNull();
    expect(
      await errorCode(
        devices.refresh({ refreshToken: next.refresh_token, clientId: "bye-desktop" }),
      ),
    ).toBe("invalid_grant");
    expect(await devices.listSessions(ana.userId)).toEqual([]);
  });

  it("idle expiry: a refresh after the idle window fails", async () => {
    const { devices, tokens, clock } = await signIn();
    clock.advance(DEVICE_IDLE_TTL_MS + 1);
    expect(
      await errorCode(
        devices.refresh({ refreshToken: tokens.refresh_token, clientId: "bye-desktop" }),
      ),
    ).toBe("invalid_grant");
  });

  it("absolute expiry: regular use cannot extend a session past its absolute lifetime", async () => {
    const { devices, tokens, clock, ana } = await signIn();
    let refreshToken = tokens.refresh_token;
    const step = DEVICE_IDLE_TTL_MS - 1;
    let elapsed = 0;
    while (elapsed + step <= DEVICE_ABSOLUTE_TTL_MS) {
      clock.advance(step);
      elapsed += step;
      refreshToken = (await devices.refresh({ refreshToken, clientId: "bye-desktop" }))
        .refresh_token;
    }
    clock.advance(DEVICE_ABSOLUTE_TTL_MS - elapsed + 1);
    expect(await errorCode(devices.refresh({ refreshToken, clientId: "bye-desktop" }))).toBe(
      "invalid_grant",
    );
    expect(await devices.listSessions(ana.userId)).toEqual([]);
  });

  it("absolute expiry is enforced on its own, even if an idle deadline were ever set past it", async () => {
    // Issuance caps the idle deadline at the absolute one, so this branch is defence in depth:
    // simulate a row where that cap was lost and check the absolute lifetime still wins.
    const { devices, tokens, clock, d1 } = await signIn();
    await d1
      .prepare("UPDATE device_sessions SET idle_expires_at = ?")
      .bind(clock.now() + 10 * DEVICE_ABSOLUTE_TTL_MS)
      .run();
    clock.advance(DEVICE_ABSOLUTE_TTL_MS + 1);
    expect(
      await errorCode(
        devices.refresh({ refreshToken: tokens.refresh_token, clientId: "bye-desktop" }),
      ),
    ).toBe("invalid_grant");
  });

  it("revokeToken accepts refresh or access credentials and ignores unknown ones", async () => {
    const { devices, tokens, ana, params } = await signIn();
    await devices.revokeToken("not-a-token");
    expect(await devices.authenticateAccess(tokens.access_token)).not.toBeNull();

    await devices.revokeToken(tokens.refresh_token);
    expect(await devices.authenticateAccess(tokens.access_token)).toBeNull();
    expect(
      await errorCode(
        devices.refresh({ refreshToken: tokens.refresh_token, clientId: "bye-desktop" }),
      ),
    ).toBe("invalid_grant");

    const second = await devices.exchangeCode({
      code: await devices.issueCode(ana.userId, params),
      codeVerifier: VERIFIER,
      redirectUri: params.redirectUri,
      clientId: "bye-desktop",
    });
    await devices.revokeToken(second.access_token);
    expect(await devices.authenticateAccess(second.access_token)).toBeNull();
    expect(
      await errorCode(
        devices.refresh({ refreshToken: second.refresh_token, clientId: "bye-desktop" }),
      ),
    ).toBe("invalid_grant");
    expect(await devices.listSessions(ana.userId)).toEqual([]);
  });

  it("revokeOwnSession is scoped to the owner", async () => {
    const { devices, tokens, ana, bob } = await signIn();
    const [session] = await devices.listSessions(ana.userId);
    expect(await devices.revokeOwnSession(bob.userId, session!.id)).toBe(false);
    expect((await devices.authenticateAccess(tokens.access_token))?.userId).toBe(ana.userId);
    expect(await devices.listSessions(ana.userId)).toHaveLength(1);

    expect(await devices.revokeOwnSession(ana.userId, session!.id)).toBe(true);
    expect(await devices.authenticateAccess(tokens.access_token)).toBeNull();
    expect(await devices.revokeOwnSession(ana.userId, session!.id)).toBe(false);
  });
});
