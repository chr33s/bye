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
 * Onboarding setup link (`/#bootstrap=<token>&domain=<zone>`, infra/onboarding): read once, then
 * removed from the address bar and history so the single-use token doesn't linger. `domain` is
 * the address domain chosen in onboarding, for display only; the server enforces it.
 */
export interface BootstrapLink {
  readonly token: string;
  readonly domain: string | null;
}

const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export const parseBootstrapFragment = (hash: string): BootstrapLink | null => {
  if (!hash.startsWith("#bootstrap=")) return null;
  const params = new URLSearchParams(hash.slice(1));
  const token = params.get("bootstrap") ?? "";

  if (!/^[A-Za-z0-9_-]{32,128}$/.test(token)) return null;
  const domain = (params.get("domain") ?? "").toLowerCase();

  return { token, domain: DOMAIN.test(domain) ? domain : null };
};

let bootstrapLink: BootstrapLink | null = null;

const takeBootstrapLink = (): BootstrapLink | null => {
  const parsed = parseBootstrapFragment(location.hash);

  if (parsed) {
    bootstrapLink = parsed;
    history.replaceState(null, "", `${location.pathname}${location.search}`);
  }

  return bootstrapLink;
};

export const signInScreen = (onSignedIn: () => void): HTMLElement => {
  const status = h("p", { role: "status", "aria-live": "polite" });

  const attempt =
    <R>(label: string, fn: () => Promise<R>) =>
    async (event?: Event) => {
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

  const link = takeBootstrapLink();
  const bootstrap = link?.token ?? null;
  const domain = link?.domain ?? location.hostname.replace(/^app\./, "");

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
      h("h2", {}, bootstrap ? "Create your owner account" : "New here?"),
      bootstrap
        ? h(
            "p",
            {},
            `Create the first account. It becomes this instance's operator and owner. Use an address on ${domain}. Incoming email for ${domain} is set up separately, after this step.`,
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
