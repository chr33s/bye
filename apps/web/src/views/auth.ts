import { recoverWithCode, signInWithPasskey, signUpWithPasskey } from "../auth.ts";
import { errorMessage, h } from "../core/dom.ts";
import { state } from "../core/state.ts";

// Sign-in, sign-up and recovery (A03). Passkeys only; recovery uses single-use codes and never
// needs access to the locked mailbox.

/**
 * Desktop sign-in hands off to this origin with `?next=/oauth/authorize?…` (A03/X01). Only that
 * same-origin path is honoured, so `next` can never become an open redirect.
 */
export const continueAuthorization = (): boolean => {
  const next = new URLSearchParams(location.search).get("next");
  if (!next || !next.startsWith("/oauth/authorize?")) return false;
  location.assign(new URL(next, location.origin).toString());
  return true;
};

/**
 * Onboarding setup link (`/#bootstrap=<token>`, infra/onboarding): read once, then removed from
 * the address bar and history so the single-use token doesn't linger.
 */
let bootstrapToken: string | null = null;
const takeBootstrapToken = (): string | null => {
  const m = /^#bootstrap=([A-Za-z0-9_-]{32,128})$/.exec(location.hash);
  if (m) {
    bootstrapToken = m[1]!;
    history.replaceState(null, "", `${location.pathname}${location.search}`);
  }
  return bootstrapToken;
};

export const signInScreen = (onSignedIn: () => void): HTMLElement => {
  const status = h("p", { role: "status", "aria-live": "polite" });
  const attempt = (label: string, fn: () => Promise<unknown>) => async (event?: Event) => {
    event?.preventDefault();
    status.textContent = `${label}…`;
    try {
      await fn();
      if (continueAuthorization()) return;
      state.me = null;
      location.hash = "#/mail/imbox";
      onSignedIn();
    } catch (error) {
      status.textContent = errorMessage(error);
    }
  };
  const address = h("input", {
    type: "email",
    name: "address",
    autocomplete: "username webauthn",
    required: true,
  });
  const name = h("input", { name: "displayName", autocomplete: "name" });
  const turnstile = h("div", {
    class: "cf-turnstile",
    "data-sitekey":
      document.querySelector<HTMLMetaElement>('meta[name="turnstile-sitekey"]')?.content ?? "",
  });
  const bootstrap = takeBootstrapToken();
  const domain = location.hostname.replace(/^app\./, "");
  if (bootstrap) address.placeholder = `you@${domain}`;
  const recoveryAddress = h("input", { type: "email", name: "recoveryAddress", required: true });
  const recoveryCode = h("input", { name: "code", autocomplete: "one-time-code", required: true });
  return h(
    "section",
    { class: "auth", "aria-labelledby": "auth-title" },
    h("h1", { id: "auth-title" }, "Sign in"),
    h(
      "button",
      {
        type: "button",
        class: "primary",
        onclick: attempt("Waiting for your passkey", signInWithPasskey),
      },
      "Sign in with a passkey",
    ),
    h(
      "form",
      {
        onsubmit: attempt("Creating your account", () =>
          signUpWithPasskey(
            address.value,
            name.value,
            (turnstile.querySelector("input") as HTMLInputElement | null)?.value ?? "",
            bootstrap ?? undefined,
          ),
        ),
      },
      h("h2", {}, bootstrap ? "Set up this instance" : "New here?"),
      bootstrap
        ? h(
            "p",
            {},
            `Create the first account. It becomes this instance's operator. Use an address on ${domain}.`,
          )
        : null,
      h("label", {}, "Address", address),
      h("label", {}, "Name", name),
      bootstrap ? null : turnstile,
      h("button", { type: "submit" }, "Create account with a passkey"),
    ),
    h(
      "form",
      {
        onsubmit: attempt("Recovering", () =>
          recoverWithCode(recoveryAddress.value, recoveryCode.value),
        ),
      },
      h("h2", {}, "Lost your passkey?"),
      h("label", {}, "Address", recoveryAddress),
      h("label", {}, "Recovery code", recoveryCode),
      h("button", { type: "submit" }, "Recover account"),
    ),
    status,
  );
};
