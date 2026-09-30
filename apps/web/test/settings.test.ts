// Settings, Security and Devices views (E19, E22–E24, A03, X01, X02): preferences, push on this
// browser, away replies, forwarding and identities, security factors and tokens, against a fake API.
import type { JsonObject } from "@bye/native-shared/json";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  button,
  type Call,
  fakeApi,
  jsdom,
  live,
  main,
  ok,
  submit,
  type,
  until,
} from "./harness.ts";

const { applyTheme, renderDevices, renderSecurity, renderSettings } =
  await import("../src/views/settings.ts");

const { state } = await import("../src/core/state.ts");

type Route = Parameters<typeof fakeApi>[0];

const prefs = {
  preferences: { theme: "dark", density: "compact", undoWindowMs: 30_000 },
  notifications: { quietHours: null, devices: { d1: { enabled: true } } },
  away: { enabled: false, startAt: null, endAt: null, subject: "Away", text: "", cooldownMs: 0 },
};

const settingsApi =
  (extra: Route = () => undefined): Route =>
  async (method, path, body) =>
    (await extra(method, path, body)) ??
    (path.endsWith("/preferences")
      ? ok(prefs)
      : path.endsWith("/identities")
        ? ok({
            items: [
              {
                identityId: "i1",
                address: "me@x.test",
                name: null,
                kind: "hosted",
                verified: true,
                isDefault: true,
              },
              {
                identityId: "i2",
                address: "alt@x.test",
                name: null,
                kind: "hosted",
                verified: true,
                isDefault: false,
              },
              {
                identityId: "i3",
                address: "ext@y.test",
                name: null,
                kind: "external",
                verified: false,
                isDefault: false,
              },
            ],
          })
        : path.endsWith("/forwarding")
          ? ok({ items: [{ address: "fwd@y.test", verified: false }] })
          : path.endsWith("/quota")
            ? ok({ limitBytes: 10 * 1024 * 1024, usedBytes: 2 * 1024 * 1024 })
            : path === "/v1/push/subscriptions" && method === "GET"
              ? ok({
                  items: [
                    { id: "dev1", kind: "webpush", label: "Firefox", enabled: true, createdAt: 1 },
                  ],
                })
              : method !== "GET"
                ? ok({ ok: true })
                : undefined);

let calls: Array<Call>;

const signal = () => new AbortController().signal;

const commands = () =>
  calls.filter((c) => c.path === "/v1/mailboxes/mbx/commands").map((c) => c.body as JsonObject);

const command = (tag: string) => commands().find((c) => c._tag === tag);

const labelled = <T extends HTMLElement>(label: string): T => {
  const el = [...main().querySelectorAll("label")].find((l) => l.firstChild?.textContent === label);

  if (!el) throw new Error(`No field ${label}`);

  return el.querySelector<T>("input, select, textarea")!;
};

/** Pretend this browser supports push, with an optional live subscription. */
const pushBrowser = (
  subscription: { endpoint: string; unsubscribe: () => Promise<boolean> } | null,
) => {
  Object.defineProperty(jsdom.window.navigator, "serviceWorker", {
    configurable: true,
    value: {
      getRegistration: async () => ({ pushManager: { getSubscription: async () => subscription } }),
    },
  });
  Object.defineProperty(jsdom.window, "PushManager", { configurable: true, value: class {} });
};

beforeEach(() => {
  state.mailboxId = "mbx";
  state.me = null;
  localStorage.clear();
  calls = fakeApi(settingsApi());
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete (jsdom.window.navigator as { serviceWorker?: unknown }).serviceWorker;
  delete (jsdom.window as { PushManager?: unknown }).PushManager;
});

describe("settings", () => {
  it("applies only known themes", () => {
    applyTheme("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    applyTheme("neon");
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
  });

  it("[E24] shows current preferences and saves a change as a typed command", async () => {
    await renderSettings(signal());

    expect(labelled<HTMLSelectElement>("Theme").value).toBe("dark");
    expect(labelled<HTMLSelectElement>("Density").value).toBe("compact");
    expect(labelled<HTMLSelectElement>("Undo window").value).toBe("30000");
    expect(main().textContent).toContain("Storage: 2.0 MB of 10.0 MB");

    type(labelled<HTMLSelectElement>("Theme"), "light");
    await until(() => live() === "Saved: done");
    expect(command("SetPreference")).toMatchObject({ key: "theme", value: "light" });
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(localStorage.getItem("bye:theme")).toBe("light");

    type(labelled<HTMLSelectElement>("Undo window"), "5000");
    await until(() => commands().length === 2);
    expect(commands()[1]).toMatchObject({ key: "undoWindowMs", value: 5000 });
  });

  it("still renders when secondary panels fail", async () => {
    calls = fakeApi(
      settingsApi((_m, p) =>
        p.endsWith("/quota") || p.endsWith("/forwarding")
          ? { status: 503, body: { error: { code: "Unavailable", message: "down" } } }
          : undefined,
      ),
    );
    await renderSettings(signal());

    expect(main().textContent).not.toContain("Storage:");
    expect(main().textContent).toContain("No forwarding destinations.");
  });

  it("[E23] saves quiet hours with the viewer's time zone, and clears them when blank", async () => {
    await renderSettings(signal());
    type(labelled<HTMLInputElement>("Quiet from"), "22:00");
    type(labelled<HTMLInputElement>("until"), "07:00");
    submit(button("Save quiet hours").form!);
    await until(() => live() === "Quiet hours saved: done");

    expect(command("SetNotificationSettings")).toMatchObject({
      quietHours: { start: "22:00", end: "07:00", timeZone: expect.any(String) },
      devices: prefs.notifications.devices,
    });
  });

  it("[E23] explains when this browser can't do push", async () => {
    await renderSettings(signal());
    button("Enable push on this device").click();
    await until(() => live().startsWith("Push enabled on this device failed"));
    expect(live()).toContain("doesn't support push");
  });

  it("[E23] turns push off for this browser by its subscription endpoint", async () => {
    const unsubscribe = vi.fn(async () => true);
    pushBrowser({ endpoint: "https://push.test/e1", unsubscribe });
    localStorage.setItem("bye:push-device", "dev1");
    await renderSettings(signal());

    expect(main().textContent).toContain("Firefox (this browser)");
    button("Turn off push on this device").click();
    await until(() => live() === "Push turned off on this device: done");
    expect(calls.find((c) => c.path === "/v1/push/subscriptions/unregister")!.body).toEqual({
      endpoint: "https://push.test/e1",
    });
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(localStorage.getItem("bye:push-device")).toBeNull();
  });

  it("offers Enable when the subscription belongs to a registration that is off", async () => {
    pushBrowser({ endpoint: "https://push.test/e1", unsubscribe: async () => true });
    localStorage.setItem("bye:push-device", "someone-else");
    await renderSettings(signal());

    expect(button("Enable push on this device")).toBeTruthy();
  });

  it("[E22] saves an away reply", async () => {
    await renderSettings(signal());
    const form = button("Save").form!;
    form.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked = true;
    type(form.querySelector("textarea")!, "Back Monday");
    submit(form);
    await until(() => live() === "Away reply saved: done");

    expect(command("SetAway")).toMatchObject({
      enabled: true,
      subject: "Away",
      text: "Back Monday",
      startAt: null,
      endAt: null,
    });
  });

  it("[E19] manages identities: default, verify, resend and add", async () => {
    await renderSettings(signal());
    const identities = main().querySelector('table[aria-label="Identities"]') ?? main();

    expect(identities.textContent).toContain("Default");
    expect(identities.textContent).toContain("Awaiting verification");

    button("Make default").click();
    await until(() => live() === "Default set: done");
    expect(command("SetDefaultIdentity")).toMatchObject({ identityId: "i2" });

    type(labelled<HTMLInputElement>("Verification code"), "123456");
    button("Verify with code").click();
    await until(() => !!command("VerifyIdentity"));
    expect(command("VerifyIdentity")).toMatchObject({ identityId: "i3", token: "123456" });

    button("Resend code").click();
    await until(() => !!command("ResendIdentityChallenge"));

    type(labelled<HTMLInputElement>("Address"), "new@y.test");
    type(labelled<HTMLSelectElement>("Kind"), "external");
    submit(button("Add identity").form!);
    await until(() => live() === "Identity added: done");
    expect(command("AddIdentity")).toMatchObject({ address: "new@y.test", kind: "external" });
  });

  it("adds and verifies a forwarding destination", async () => {
    await renderSettings(signal());
    expect(main().textContent).toContain("Pending");

    type(labelled<HTMLInputElement>("Forward to"), "fwd@y.test");
    submit(button("Add destination").form!);
    await until(() => live() === "Verification sent: done");
    type(labelled<HTMLInputElement>("Code"), "999");
    submit(button("Verify destination").form!);
    await until(() => live() === "Verified: done");

    expect(command("AddForwardingDestination")).toMatchObject({ address: "fwd@y.test" });
    expect(command("VerifyForwardingDestination")).toMatchObject({
      address: "fwd@y.test",
      token: "999",
    });
  });

  it("does not retry a plain 403 as a step-up", async () => {
    calls = fakeApi(
      settingsApi((m, p) =>
        m === "POST" && p.endsWith("/commands")
          ? { status: 403, body: { error: { code: "Forbidden", message: "Not allowed" } } }
          : undefined,
      ),
    );
    await renderSettings(signal());
    type(labelled<HTMLInputElement>("Forward to"), "fwd@y.test");
    submit(button("Add destination").form!);
    await until(() => live().startsWith("Verification sent failed"));

    expect(commands()).toHaveLength(1);
  });
});

describe("security", () => {
  const securityApi: Route = (method, path) =>
    path === "/v1/security"
      ? ok({ totpEnabled: false, recoveryCodesRemaining: 3 })
      : path === "/v1/security/passkeys"
        ? ok({ items: [{ id: "pk1", label: "YubiKey", createdAt: 1, lastUsedAt: null }] })
        : path === "/v1/security/sessions" && method === "GET"
          ? ok({
              items: [
                { id: "s1", device: "Firefox", createdAt: 1, lastSeenAt: 2, current: true },
                { id: "s2", device: "", createdAt: 1, lastSeenAt: 2, current: false },
              ],
            })
          : path === "/v1/support-access" && method === "GET"
            ? ok({ items: [] })
            : path === "/v1/security/totp"
              ? ok({ secret: "JBSWY3DP", otpauthUri: "otpauth://totp/bye?secret=JBSWY3DP" })
              : path === "/v1/security/recovery-codes"
                ? ok({ codes: ["aaaa-bbbb", "cccc-dddd"] })
                : ok({});

  beforeEach(() => {
    calls = fakeApi(securityApi);
  });

  it("[A03] summarises factors and lists passkeys and sessions", async () => {
    await renderSecurity(signal());

    expect(main().textContent).toContain("Two-step codes: off · Recovery codes left: 3");
    expect(main().textContent).toContain("YubiKey");
    expect(main().textContent).toContain("Firefox (this one)");
    expect(main().textContent).toContain("Support can't access your account.");
  });

  it("[A03] sets up an authenticator app and shows recovery codes once", async () => {
    await renderSecurity(signal());
    button("Set up").click();
    await until(() => main().textContent!.includes("JBSWY3DP"));
    expect(main().querySelector<HTMLAnchorElement>('a[href^="otpauth:"]')).not.toBeNull();

    type(
      main().querySelector<HTMLInputElement>('[aria-label="Code from your authenticator app"]')!,
      "123456",
    );
    button("Confirm").click();
    await until(() => live() === "Two-step codes on: done");
    expect(calls.find((c) => c.path === "/v1/security/totp/confirm")!.body).toEqual({
      code: "123456",
    });

    button("Generate recovery codes").click();
    await until(() => main().querySelectorAll(".codes li").length === 2);
    expect(main().textContent).toContain("won't be shown again");
  });

  it("signs out another session and grants time-boxed support access", async () => {
    await renderSecurity(signal());

    const buttons = [...main().querySelectorAll("button")].filter(
      (b) => b.textContent === "Sign out",
    );

    buttons[1]!.click();

    await until(() => live() === "Signed out: done");
    expect(calls.some((c) => c.method === "DELETE" && c.path === "/v1/security/sessions/s2")).toBe(
      true,
    );

    type(
      main().querySelector<HTMLInputElement>('[aria-label="Why support needs access"]')!,
      "billing",
    );
    button("Grant support access (24h)").click();
    await until(() => live() === "Access granted for 24 hours: done");
    expect(calls.find((c) => c.method === "POST" && c.path === "/v1/support-access")!.body).toEqual(
      {
        reason: "billing",
        hours: 24,
      },
    );
  });

  it("offers Turn off when two-step codes are on", async () => {
    calls = fakeApi((m, p) =>
      p === "/v1/security" ? ok({ totpEnabled: true }) : securityApi(m, p, undefined),
    );
    await renderSecurity(signal());
    button("Turn off").click();
    await until(() => live() === "Two-step codes turned off: done");
    expect(calls.some((c) => c.method === "DELETE" && c.path === "/v1/security/totp")).toBe(true);
  });
});

describe("devices and agents", () => {
  beforeEach(() => {
    calls = fakeApi((method, path, body) =>
      path === "/v1/devices"
        ? ok({
            items: [
              {
                id: "dv1",
                clientId: "bye-mobile",
                deviceName: "iPhone app",
                createdAt: 1,
                lastUsedAt: 2,
              },
            ],
          })
        : path === "/v1/tokens" && method === "GET"
          ? ok({ items: [] })
          : path === "/v1/tokens" && method === "POST"
            ? ok({
                id: "tk1",
                token: "bye_secret",
                scopes: (body as { scopes: Array<string> }).scopes,
              })
            : ok({}),
    );
  });

  it("[X01] lists signed-in apps and revokes one", async () => {
    await renderDevices(signal());

    expect(main().textContent).toContain("iPhone app");
    expect(main().textContent).toContain("No tokens.");
    button("Revoke").click();
    await until(() => live() === "Revoked: done");
    expect(calls.some((c) => c.method === "DELETE" && c.path === "/v1/devices/dv1")).toBe(true);
  });

  it("[X02] creates a least-privilege token and shows it once", async () => {
    await renderDevices(signal());
    const form = main().querySelector<HTMLFormElement>('form[aria-label="Create a token"]')!;
    type(form.querySelector<HTMLInputElement>('[name="label"]')!, "CI");
    type(form.querySelector<HTMLSelectElement>('[name="kind"]')!, "agent");
    form.querySelector<HTMLInputElement>('[name="send"]')!.checked = true;
    submit(form);
    await until(() => !!form.querySelector("code.token"));

    expect(calls.find((c) => c.method === "POST")!.body).toEqual({
      kind: "agent",
      label: "CI",
      scopes: ["read", "draft", "send"],
    });
    expect(form.querySelector("code.token")!.textContent).toBe("bye_secret");
    expect(form.textContent).toContain("will not be shown again");
  });
});
