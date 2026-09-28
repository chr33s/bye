import { describe, expect, it } from "vitest";
import {
  ControlDeviceAuth,
  ControlDirectory,
  DeviceAuthError,
  normalizeUserCode,
} from "@bye/platform-cloudflare";
import { MemoryD1, TestClock } from "@bye/testing";

// Device-authorization grant (DS10, RFC 8628) at the control-plane store.

const setup = async () => {
  const d1 = MemoryD1.migrated();
  const clock = new TestClock();

  const account = await new ControlDirectory(d1, clock).provisionPersonalAccount({
    address: "ana@bye.test",
    displayName: "Ana",
  });

  return { d1, clock, account, devices: new ControlDeviceAuth(d1, clock) };
};

const errorCode = async (p: Promise<unknown>) => {
  try {
    await p;

    return "ok";
  } catch (e) {
    return e instanceof DeviceAuthError ? e.code : String(e);
  }
};

describe("[DS10] device-authorization grant", () => {
  it("issues an unambiguous user code and a single-use device session after approval", async () => {
    const { devices, clock, account, d1 } = await setup();

    const started = await devices.startDeviceAuthorization({
      clientId: "bye-cli",
      deviceName: "build box",
    });

    expect(started.user_code).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
    expect(started.interval).toBe(5);
    expect(started.expires_in).toBe(600);

    const poll = () =>
      devices.pollDeviceCode({ deviceCode: started.device_code, clientId: "bye-cli" });

    expect(await errorCode(poll())).toBe("authorization_pending");
    // Polling faster than the interval is told to slow down, and the interval grows.
    expect(await errorCode(poll())).toBe("slow_down");

    // The approval page accepts the code in any case, with or without the hyphen.
    expect(
      await devices.pendingUserCode(started.user_code.toLowerCase().replace("-", " ")),
    ).toEqual({ clientId: "bye-cli", deviceName: "build box" });
    expect(
      await devices.decideUserCode(account.userId, normalizeUserCode(started.user_code), true),
    ).toBe(true);
    expect(await devices.decideUserCode(account.userId, started.user_code, true)).toBe(false); // already decided

    clock.advance(11_000);
    const tokens = await poll();
    expect(tokens.access_token).toMatch(/^bda_/);
    expect(tokens.refresh_token).toMatch(/^bdr_/);
    expect(await devices.authenticateAccess(tokens.access_token)).toMatchObject({
      userId: account.userId,
    });

    const session = await d1
      .prepare("SELECT client_id, device_name FROM device_sessions WHERE user_id = ?")
      .bind(account.userId)
      .first();

    expect(session).toEqual({ client_id: "bye-cli", device_name: "build box" });
    // Single use: redeeming the same device code again yields expired_token, never a second session.
    expect(await errorCode(poll())).toBe("expired_token");

    // Only hashes are stored.
    const stored = await d1
      .prepare("SELECT device_code_hash, user_code_hash FROM device_codes")
      .first<{ device_code_hash: string; user_code_hash: string }>();

    expect(stored?.device_code_hash).not.toBe(started.device_code);
    expect(stored?.user_code_hash).not.toContain(normalizeUserCode(started.user_code));
  });

  it("denial, expiry, client binding and unknown clients", async () => {
    const { devices, clock, account } = await setup();

    const denied = await devices.startDeviceAuthorization({
      clientId: "bye-desktop",
      deviceName: "",
    });

    await devices.decideUserCode(account.userId, denied.user_code, false);
    expect(
      await errorCode(
        devices.pollDeviceCode({ deviceCode: denied.device_code, clientId: "bye-desktop" }),
      ),
    ).toBe("access_denied");

    const other = await devices.startDeviceAuthorization({ clientId: "bye-cli", deviceName: "" });
    expect(
      await errorCode(
        devices.pollDeviceCode({ deviceCode: other.device_code, clientId: "bye-desktop" }),
      ),
    ).toBe("invalid_grant");
    expect(
      await errorCode(devices.pollDeviceCode({ deviceCode: "nope", clientId: "bye-cli" })),
    ).toBe("invalid_grant");

    clock.advance(11 * 60_000);
    expect(await devices.pendingUserCode(other.user_code)).toBeNull();
    expect(await devices.decideUserCode(account.userId, other.user_code, true)).toBe(false);
    expect(
      await errorCode(
        devices.pollDeviceCode({ deviceCode: other.device_code, clientId: "bye-cli" }),
      ),
    ).toBe("expired_token");

    expect(
      await errorCode(devices.startDeviceAuthorization({ clientId: "evil", deviceName: "" })),
    ).toBe("invalid_client");
  });
});
