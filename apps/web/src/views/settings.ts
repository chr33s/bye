import type { MailboxCommandInput } from "@bye/native-shared";
import { degrade } from "../core/degrade.ts";
import { api, list } from "../api.ts";
import { addPasskey, logout, urlBase64ToBytes } from "../auth.ts";
import {
  act,
  choice,
  errorMessage,
  field,
  formatDate,
  formatSize,
  h,
  section,
  show,
  table,
  text,
} from "../core/dom.ts";
import { mailCommand, mb, remember, state, withStepUp, zone } from "../core/state.ts";

// Settings (E19, E22, E23, E24, A03, X01, X02): preferences, notifications and push, away replies,
// forwarding, identities, Speakeasy, security (passkeys, TOTP, recovery codes, sessions), device
// sessions, CLI/agent tokens, and support access.

const reload = () => window.dispatchEvent(new HashChangeEvent("hashchange"));

interface Prefs {
  readonly preferences: Readonly<Record<string, unknown>>;
  readonly notifications: {
    readonly quietHours: { start: string; end: string; timeZone: string } | null;
    readonly devices: Readonly<Record<string, { enabled: boolean }>>;
    readonly optIns?: ReadonlyArray<{ kind: string; subject: string }>;
  };
  readonly away: {
    readonly enabled: boolean;
    readonly startAt: number | null;
    readonly endAt: number | null;
    readonly subject: string;
    readonly text: string;
    readonly cooldownMs: number;
  } | null;
}

export const applyTheme = (theme: string | null): void => {
  const t = theme === "light" || theme === "dark" ? theme : null;
  if (t) document.documentElement.setAttribute("data-theme", t);
  else document.documentElement.removeAttribute("data-theme");
};

const select = (
  label: string,
  value: unknown,
  options: ReadonlyArray<readonly [string, string]>,
  onchange: (v: string) => void,
) => {
  const s = h(
    "select",
    { onchange: () => onchange(s.value) },
    options.map(([v, l]) =>
      h("option", { value: v, ...(String(value) === v ? { selected: true } : {}) }, l),
    ),
  );
  return field(label, s);
};

const subscribePush = async (): Promise<void> => {
  if (!("serviceWorker" in navigator) || !("PushManager" in window))
    throw new Error("This browser doesn't support push notifications");
  const { publicKey } = await api<{ publicKey: string }>("GET", "/v1/push/vapid-key");
  if ((await Notification.requestPermission()) !== "granted")
    throw new Error("Notifications were not allowed");
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToBytes(publicKey),
  });
  const json = subscription.toJSON() as {
    endpoint: string;
    keys: { p256dh: string; auth: string };
  };
  await api("POST", "/v1/push/subscriptions", {
    kind: "webpush",
    endpoint: json.endpoint,
    keys: json.keys,
    label: navigator.userAgent.slice(0, 60),
  });
};

export const renderSettings = async (signal: AbortSignal): Promise<void> => {
  const [prefs, identities, forwarding, quota, push] = await Promise.all([
    api<Prefs>("GET", `/v1/mailboxes/${mb()}/preferences`, undefined, signal),
    list<{
      identityId: string;
      address: string;
      name: string | null;
      kind: string;
      verified: boolean;
      isDefault: boolean;
    }>(`/v1/mailboxes/${mb()}/identities`, signal),
    list<{ address: string; verified: boolean }>(`/v1/mailboxes/${mb()}/forwarding`, signal).catch(
      degrade([]),
    ),
    api<{ limitBytes: number; usedBytes: number }>(
      "GET",
      `/v1/mailboxes/${mb()}/quota`,
      undefined,
      signal,
    ).catch(degrade(null)),
    list<{ id: string; kind: string; label: string; enabled: boolean; createdAt: number }>(
      "/v1/push/subscriptions",
      signal,
    ).catch(degrade([])),
  ]);
  const p = prefs.preferences;
  const setPref =
    (key: Extract<MailboxCommandInput, { _tag: "SetPreference" }>["key"]) => (value: unknown) =>
      act("Saved", () => mailCommand({ _tag: "SetPreference", key, value }))();
  const quietStart = h("input", {
    type: "time",
    value: prefs.notifications.quietHours?.start ?? "",
  });
  const quietEnd = h("input", { type: "time", value: prefs.notifications.quietHours?.end ?? "" });
  const optKind = h(
    "select",
    {},
    h("option", { value: "contact" }, "Contact"),
    h("option", { value: "domain" }, "Domain"),
    h("option", { value: "thread" }, "Conversation"),
  );
  const optSubject = h("input", { placeholder: "address, domain or thread ID" });
  const away = prefs.away;
  const awayOn = h("input", { type: "checkbox", ...(away?.enabled ? { checked: true } : {}) });
  const awayStart = h("input", { type: "datetime-local" });
  const awayEnd = h("input", { type: "datetime-local" });
  const awaySubject = h("input", { value: away?.subject ?? "Away" });
  const awayText = h("textarea", { rows: 3 }, away?.text ?? "");
  const fwdAddress = h("input", { type: "email" });
  const fwdToken = h("input", { placeholder: "verification code" });
  const idAddress = h("input", { type: "email", required: true });
  const idName = h("input", {});
  const idKind = h(
    "select",
    {},
    h("option", { value: "hosted" }, "Address on this account"),
    h("option", { value: "external" }, "External address (send-as)"),
  );
  const verifyToken = h("input", { placeholder: "code from the verification email" });
  show(
    section(
      "settings-title",
      "Settings",
      h("h2", {}, "Appearance and behaviour"),
      h(
        "div",
        { class: "settings" },
        select(
          "Theme",
          p.theme ?? "system",
          [
            ["system", "System"],
            ["light", "Light"],
            ["dark", "Dark"],
          ],
          (v) => {
            applyTheme(v);
            remember.set("theme", v);
            void setPref("theme")(v);
          },
        ),
        select(
          "Density",
          p.density ?? "comfortable",
          [
            ["comfortable", "Comfortable"],
            ["compact", "Compact"],
          ],
          (v) => void setPref("density")(v),
        ),
        select(
          "Remote images",
          p.remoteImages ?? "off",
          [
            ["off", "Don't load"],
            ["proxy", "Load through the privacy proxy"],
          ],
          (v) => void setPref("remoteImages")(v),
        ),
        select(
          "Keyboard shortcuts",
          String(p.shortcuts !== false),
          [
            ["true", "On"],
            ["false", "Off"],
          ],
          (v) => {
            remember.set("shortcuts", v);
            void setPref("shortcuts")(v === "true");
          },
        ),
        select(
          "Undo window",
          String(typeof p.undoWindowMs === "number" ? p.undoWindowMs : 10_000),
          [
            ["5000", "5 seconds"],
            ["10000", "10 seconds"],
            ["30000", "30 seconds"],
          ],
          (v) => void setPref("undoWindowMs")(Number(v)),
        ),
      ),
      quota
        ? h("p", {}, `Storage: ${formatSize(quota.usedBytes)} of ${formatSize(quota.limitBytes)}`)
        : null,
      h("h2", {}, "Notifications"),
      h(
        "p",
        {},
        "Notifications are quiet by default. Opt in for specific people, domains or conversations.",
      ),
      h(
        "form",
        {
          class: "bulk",
          onsubmit: act("Quiet hours saved", () =>
            mailCommand({
              _tag: "SetNotificationSettings",
              quietHours:
                quietStart.value && quietEnd.value
                  ? { start: quietStart.value, end: quietEnd.value, timeZone: zone() }
                  : null,
              devices: prefs.notifications.devices,
            }),
          ),
        },
        field("Quiet from", quietStart),
        field("until", quietEnd),
        h("button", { type: "submit" }, "Save quiet hours"),
      ),
      h(
        "form",
        {
          class: "bulk",
          onsubmit: act("Opted in", () =>
            mailCommand({
              _tag: "SetNotifyOptIn",
              kind: choice(optKind.value, ["contact", "domain", "thread"], "contact"),
              subject: optSubject.value,
              on: true,
            }),
          ),
        },
        field("Notify me about", optKind),
        optSubject,
        h("button", { type: "submit" }, "Opt in"),
      ),
      table(
        "Devices receiving push",
        push,
        [
          ["Device", (d) => text(d.label || d.kind)],
          ["Added", (d) => formatDate(d.createdAt)],
          ["Status", (d) => (d.enabled ? "On" : "Off")],
          [
            "",
            (d) =>
              h(
                "button",
                {
                  type: "button",
                  onclick: act(
                    "Removed",
                    () => api("DELETE", `/v1/push/subscriptions/${encodeURIComponent(text(d.id))}`),
                    reload,
                  ),
                },
                "Remove",
              ),
          ],
        ],
        "No devices yet.",
      ),
      h(
        "button",
        { type: "button", onclick: act("Push enabled on this device", subscribePush, reload) },
        "Enable push on this device",
      ),
      h("h2", {}, "Away reply"),
      h(
        "form",
        {
          class: "compose",
          onsubmit: act("Away reply saved", () =>
            mailCommand({
              _tag: "SetAway",
              enabled: awayOn.checked,
              startAt: awayStart.value ? Date.parse(awayStart.value) : null,
              endAt: awayEnd.value ? Date.parse(awayEnd.value) : null,
              subject: awaySubject.value,
              text: awayText.value,
              cooldownMs: 4 * 24 * 3600_000,
            }),
          ),
        },
        field("On", awayOn),
        field("From", awayStart),
        field("Until", awayEnd),
        field("Subject", awaySubject),
        field("Message", awayText),
        h("button", { type: "submit" }, "Save"),
      ),
      h("h2", {}, "Forwarding"),
      table(
        "Forwarding destinations",
        forwarding,
        [
          ["Address", (f) => text(f.address)],
          ["Verified", (f) => (f.verified ? "Yes" : "Pending")],
        ],
        "No forwarding destinations.",
      ),
      h(
        "form",
        {
          class: "bulk",
          onsubmit: act(
            "Verification sent",
            () =>
              withStepUp(() =>
                mailCommand({ _tag: "AddForwardingDestination", address: fwdAddress.value }),
              ),
            reload,
          ),
        },
        field("Forward to", fwdAddress),
        h("button", { type: "submit" }, "Add destination"),
      ),
      h(
        "form",
        {
          class: "bulk",
          onsubmit: act(
            "Verified",
            () =>
              mailCommand({
                _tag: "VerifyForwardingDestination",
                address: fwdAddress.value,
                token: fwdToken.value,
              }),
            reload,
          ),
        },
        field("Code", fwdToken),
        h("button", { type: "submit" }, "Verify destination"),
      ),
      h("h2", {}, "Sending identities"),
      table("Identities", identities, [
        ["Address", (i) => text(i.address)],
        ["Kind", (i) => text(i.kind)],
        [
          "Status",
          (i) => (i.verified ? (i.isDefault ? "Default" : "Verified") : "Awaiting verification"),
        ],
        [
          "",
          (i) =>
            i.verified
              ? i.isDefault
                ? ""
                : h(
                    "button",
                    {
                      type: "button",
                      onclick: act(
                        "Default set",
                        () => mailCommand({ _tag: "SetDefaultIdentity", identityId: i.identityId }),
                        reload,
                      ),
                    },
                    "Make default",
                  )
              : [
                  h(
                    "button",
                    {
                      type: "button",
                      onclick: act(
                        "Verified",
                        () =>
                          mailCommand({
                            _tag: "VerifyIdentity",
                            identityId: i.identityId,
                            token: verifyToken.value,
                          }),
                        reload,
                      ),
                    },
                    "Verify with code",
                  ),
                  h(
                    "button",
                    {
                      type: "button",
                      onclick: act("Code resent", () =>
                        mailCommand({ _tag: "ResendIdentityChallenge", identityId: i.identityId }),
                      ),
                    },
                    "Resend code",
                  ),
                ],
        ],
      ]),
      field("Verification code", verifyToken),
      h(
        "form",
        {
          class: "bulk",
          onsubmit: act(
            "Identity added",
            () =>
              withStepUp(() =>
                mailCommand({
                  _tag: "AddIdentity",
                  address: idAddress.value,
                  kind: choice(idKind.value, ["hosted", "external"], "hosted"),
                  ...(idName.value ? { name: idName.value } : {}),
                }),
              ),
            reload,
          ),
        },
        field("Address", idAddress),
        field("Name", idName),
        field("Kind", idKind),
        h("button", { type: "submit" }, "Add identity"),
      ),
      h("h2", {}, "Speakeasy"),
      h(
        "div",
        { class: "bulk" },
        h(
          "button",
          {
            type: "button",
            onclick: act("Speakeasy rotated", async () => {
              const r = await mailCommand<{ secret?: string } | string>({
                _tag: "RotateSpeakeasy",
              });
              alert(`New Speakeasy code: ${typeof r === "string" ? r : (r.secret ?? "")}`);
            }),
          },
          "Rotate Speakeasy code",
        ),
        h(
          "button",
          {
            type: "button",
            onclick: act("Speakeasy disabled", () => mailCommand({ _tag: "DisableSpeakeasy" })),
          },
          "Disable",
        ),
      ),
      h(
        "p",
        {},
        h("a", { href: "#/security" }, "Security and sign-in"),
        " · ",
        h("a", { href: "#/devices" }, "Devices and agents"),
        " · ",
        h("a", { href: "#/admin" }, "Account, team and billing"),
      ),
    ),
  );
};

export const renderSecurity = async (signal: AbortSignal): Promise<void> => {
  const [status, passkeys, sessions, support] = await Promise.all([
    api<{ totpEnabled?: boolean; recoveryCodesRemaining?: number }>(
      "GET",
      "/v1/security",
      undefined,
      signal,
    ).catch(degrade({} as { totpEnabled?: boolean; recoveryCodesRemaining?: number })),
    list<{ id: string; label: string; createdAt?: number; lastUsedAt?: number | null }>(
      "/v1/security/passkeys",
      signal,
    ).catch(degrade([])),
    list<{ id: string; device: string; createdAt: number; lastSeenAt: number; current: boolean }>(
      "/v1/security/sessions",
      signal,
    ).catch(degrade([])),
    list<{ id: string; reason: string; expiresAt: number }>("/v1/support-access", signal).catch(
      degrade([]),
    ),
  ]);
  const codes = h("div", { "aria-live": "polite" });
  const totpArea = h("div", { "aria-live": "polite" });
  const totpCode = h("input", {
    inputmode: "numeric",
    autocomplete: "one-time-code",
    "aria-label": "Code from your authenticator app",
  });
  const label = h("input", { placeholder: "e.g. YubiKey", "aria-label": "Passkey name" });
  const reason = h("input", { "aria-label": "Why support needs access" });
  show(
    section(
      "security-title",
      "Security",
      h(
        "p",
        {},
        `Two-step codes: ${status.totpEnabled ? "on" : "off"} · Recovery codes left: ${text(status.recoveryCodesRemaining ?? "—")}`,
      ),
      h("h2", {}, "Passkeys and security keys"),
      table("Passkeys", passkeys, [
        ["Name", (k) => text(k.label || "Passkey")],
        ["Added", (k) => formatDate(k.createdAt)],
        ["Last used", (k) => formatDate(k.lastUsedAt)],
        [
          "",
          (k) =>
            h(
              "button",
              {
                type: "button",
                class: "danger",
                onclick: act(
                  "Removed",
                  () =>
                    withStepUp(() =>
                      api("DELETE", `/v1/security/passkeys/${encodeURIComponent(text(k.id))}`),
                    ),
                  reload,
                ),
              },
              "Remove",
            ),
        ],
      ]),
      h(
        "div",
        { class: "bulk" },
        label,
        h(
          "button",
          {
            type: "button",
            onclick: act(
              "Passkey added",
              () =>
                withStepUp(() =>
                  addPasskey(state.me?.userId ?? "", state.me?.userId ?? "account", label.value),
                ),
              reload,
            ),
          },
          "Add passkey",
        ),
      ),
      h("h2", {}, "Authenticator app"),
      totpArea,
      status.totpEnabled
        ? h(
            "button",
            {
              type: "button",
              onclick: act(
                "Two-step codes turned off",
                () => withStepUp(() => api("DELETE", "/v1/security/totp")),
                reload,
              ),
            },
            "Turn off",
          )
        : h(
            "div",
            { class: "bulk" },
            h(
              "button",
              {
                type: "button",
                onclick: act("Scan the code", async () => {
                  const r = await withStepUp(() =>
                    api<{ secret: string; otpauthUri: string }>("POST", "/v1/security/totp", {}),
                  );
                  totpArea.replaceChildren(
                    h("p", {}, "Add this key to your authenticator app, then enter a code:"),
                    h("code", {}, r.secret),
                    h("p", {}, h("a", { href: r.otpauthUri }, "Open in authenticator")),
                  );
                }),
              },
              "Set up",
            ),
            totpCode,
            h(
              "button",
              {
                type: "button",
                onclick: act(
                  "Two-step codes on",
                  () => api("POST", "/v1/security/totp/confirm", { code: totpCode.value }),
                  reload,
                ),
              },
              "Confirm",
            ),
          ),
      h("h2", {}, "Recovery codes"),
      h(
        "p",
        {},
        "Recovery codes let you back in without your mailbox. Generating new codes replaces the old ones.",
      ),
      codes,
      h(
        "button",
        {
          type: "button",
          onclick: act("Recovery codes generated", async () => {
            const r = await withStepUp(() =>
              api<{ codes: ReadonlyArray<string> }>("POST", "/v1/security/recovery-codes", {}),
            );
            codes.replaceChildren(
              h("p", {}, "Save these now — they won't be shown again:"),
              h(
                "ol",
                { class: "codes" },
                r.codes.map((c) => h("li", {}, h("code", {}, c))),
              ),
            );
          }),
        },
        "Generate recovery codes",
      ),
      h("h2", {}, "Browser sessions"),
      table("Sessions", sessions, [
        ["Device", (s) => `${text(s.device) || "Browser"}${s.current ? " (this one)" : ""}`],
        ["Signed in", (s) => formatDate(s.createdAt)],
        ["Last seen", (s) => formatDate(s.lastSeenAt)],
        [
          "",
          (s) =>
            s.current
              ? h(
                  "button",
                  { type: "button", onclick: act("Signing out", () => logout()) },
                  "Sign out",
                )
              : h(
                  "button",
                  {
                    type: "button",
                    onclick: act(
                      "Signed out",
                      () =>
                        api("DELETE", `/v1/security/sessions/${encodeURIComponent(text(s.id))}`),
                      reload,
                    ),
                  },
                  "Sign out",
                ),
        ],
      ]),
      h("h2", {}, "Support access"),
      table(
        "Support access grants",
        support,
        [
          ["Reason", (g) => text(g.reason)],
          ["Expires", (g) => formatDate(g.expiresAt)],
          [
            "",
            (g) =>
              h(
                "button",
                {
                  type: "button",
                  onclick: act(
                    "Revoked",
                    () => api("DELETE", `/v1/support-access/${encodeURIComponent(text(g.id))}`),
                    reload,
                  ),
                },
                "Revoke",
              ),
          ],
        ],
        "Support can't access your account.",
      ),
      h(
        "div",
        { class: "bulk" },
        reason,
        h(
          "button",
          {
            type: "button",
            onclick: act(
              "Access granted for 24 hours",
              () =>
                withStepUp(() =>
                  api("POST", "/v1/support-access", { reason: reason.value, hours: 24 }),
                ),
              reload,
            ),
          },
          "Grant support access (24h)",
        ),
      ),
    ),
  );
};

/**
 * Devices and agents (X01, X02). Desktop and mobile apps sign in through the browser and appear as
 * device sessions; pasted tokens are only for the CLI and agents (P0 #15).
 */
export const renderDevices = async (signal: AbortSignal): Promise<void> => {
  const [devices, tokens] = await Promise.all([
    list<{
      id: string;
      clientId: string;
      deviceName: string;
      createdAt: number;
      lastUsedAt: number;
    }>("/v1/devices", signal).catch(degrade([])),
    list<{
      id: string;
      kind: string;
      label: string;
      scopes: ReadonlyArray<string>;
      createdAt: number;
      lastUsedAt: number | null;
    }>("/v1/tokens", signal).catch(degrade([])),
  ]);
  const label = h("input", { name: "label", required: true, placeholder: "e.g. Build server CLI" });
  const kind = h(
    "select",
    { name: "kind" },
    h("option", { value: "cli" }, "Command-line tool"),
    h("option", { value: "agent" }, "Agent"),
  );
  const scopeNames = ["read", "draft", "send", "screen", "delete", "calendar", "publish"] as const;
  const boxes = scopeNames.map((scope) =>
    h("input", {
      type: "checkbox",
      name: scope,
      value: scope,
      ...(scope === "read" || scope === "draft" ? { checked: true } : {}),
    }),
  );
  const result = h("div", { role: "status", "aria-live": "polite" });
  const submit = async (event: Event) => {
    event.preventDefault();
    result.textContent = "Creating…";
    try {
      const token = await withStepUp(() =>
        api<{ id: string; token: string; scopes: Array<string> }>("POST", "/v1/tokens", {
          kind: kind.value,
          label: label.value,
          scopes: boxes.filter((b) => b.checked).map((b) => b.value),
        }),
      );
      result.replaceChildren(
        h(
          "p",
          {},
          `Token for "${label.value}" (${token.scopes.join(", ")}). Copy it now — it will not be shown again:`,
        ),
        h("code", { class: "token" }, token.token),
      );
    } catch (error) {
      result.textContent = errorMessage(error);
    }
  };
  show(
    section(
      "devices-title",
      "Devices and agents",
      h("h2", {}, "Signed-in apps"),
      h(
        "p",
        {},
        "Desktop and mobile apps sign in with your passkey in the browser — no token to copy. Revoke any you don't recognise.",
      ),
      table(
        "Device sessions",
        devices,
        [
          ["Device", (d) => text(d.deviceName || d.clientId)],
          ["Signed in", (d) => formatDate(d.createdAt)],
          ["Last used", (d) => formatDate(d.lastUsedAt)],
          [
            "",
            (d) =>
              h(
                "button",
                {
                  type: "button",
                  class: "danger",
                  onclick: act(
                    "Revoked",
                    () => api("DELETE", `/v1/devices/${encodeURIComponent(text(d.id))}`),
                    reload,
                  ),
                },
                "Revoke",
              ),
          ],
        ],
        "No apps signed in.",
      ),
      h("h2", {}, "Command-line tools and agents"),
      table(
        "Tokens",
        tokens,
        [
          ["Name", (t) => text(t.label)],
          ["Kind", (t) => text(t.kind)],
          ["Permissions", (t) => t.scopes.join(", ")],
          ["Last used", (t) => formatDate(t.lastUsedAt)],
          [
            "",
            (t) =>
              h(
                "button",
                {
                  type: "button",
                  class: "danger",
                  onclick: act(
                    "Revoked",
                    () => api("DELETE", `/v1/tokens/${encodeURIComponent(text(t.id))}`),
                    reload,
                  ),
                },
                "Revoke",
              ),
          ],
        ],
        "No tokens.",
      ),
      h(
        "form",
        { class: "compose", onsubmit: submit, "aria-label": "Create a token" },
        field("Name", label),
        field("Used by", kind),
        h(
          "fieldset",
          {},
          h("legend", {}, "Permissions"),
          ...scopeNames.map((scope, i) => h("label", {}, boxes[i]!, ` ${scope}`)),
        ),
        h("button", { type: "submit" }, "Create token"),
        result,
      ),
    ),
  );
};
