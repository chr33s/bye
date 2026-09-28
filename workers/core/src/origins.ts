import type { CoreEnv } from "./env.ts";

// The deployment's origins, derived once from configuration (§11): the app origin is
// `https://app.<service domain>`, the public site lives at `https://<service domain>`, and mail
// renders on MAIL_ORIGIN.

export interface Origins {
  /** Bare service domain, e.g. `bye.software` (World handles, `world@`, `no-reply@`). */
  readonly serviceDomain: string;
  /** Public site origin, e.g. `https://bye.software`. */
  readonly publicOrigin: string;
  readonly appOrigin: string;
  readonly mailOrigin: string;
}

export const origins = (env: Pick<CoreEnv, "APP_ORIGIN" | "MAIL_ORIGIN">): Origins => ({
  serviceDomain: new URL(env.APP_ORIGIN).hostname.replace(/^app\./, ""),
  publicOrigin: env.APP_ORIGIN.replace("://app.", "://"),
  appOrigin: env.APP_ORIGIN,
  mailOrigin: env.MAIL_ORIGIN,
});

export const serviceDomain = (env: Pick<CoreEnv, "APP_ORIGIN">): string =>
  new URL(env.APP_ORIGIN).hostname.replace(/^app\./, "");
export const publicOrigin = (env: Pick<CoreEnv, "APP_ORIGIN">): string =>
  env.APP_ORIGIN.replace("://app.", "://");
