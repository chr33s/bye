import { Predicate } from "effect";
import {
  fromBase64Url,
  openWithKey,
  RESEND_API,
  RESEND_WEBHOOK_EVENTS,
  randomToken,
  sealWithKey,
  type VersionedKeys,
} from "@bye/platform-cloudflare";
import type { CoreEnv } from "./env.ts";

// Runtime newsletter provider configuration (infra/onboarding/spec.md §21–§28). An instance operator
// connects Resend after deployment by entering one API key; Bye creates (or recovers) the webhook
// itself and stores the key and the webhook signing secret sealed with NEWSLETTER_CONFIG_SEAL_KEY.
// Plaintext credentials exist only inside the request or task that needs them: never in KV,
// logs, metrics, error strings or API responses. NEWSLETTER_QUALIFIED stays a deployment gate that
// no request can set.

export const NEWSLETTER_WEBHOOK_PATH = "/webhooks/newsletter";

export type NewsletterConfigStatus = "unconfigured" | "ready" | "blocked" | "needs-attention";

/** What any signed-in user may learn about the instance's newsletter provider. No secrets. */
export interface NewsletterConfigView {
  readonly provider: "resend";
  readonly status: NewsletterConfigStatus;
  readonly qualified: boolean;
  readonly canConfigure: boolean;
  readonly configuredAt?: number;
  readonly detail?: string;
}

/** Decrypted runtime credentials: only ever held for the duration of one request or task. */
export interface RuntimeNewsletterCredentials {
  readonly provider: "resend";
  readonly account: string;
  readonly apiKey: string;
  readonly webhookSecret: string;
}

export type RuntimeNewsletterConfig =
  | { readonly _tag: "None" }
  | { readonly _tag: "Present"; readonly credentials: RuntimeNewsletterCredentials }
  /** A runtime row exists but cannot be used; the legacy env config is never consulted instead. */
  | { readonly _tag: "Unusable"; readonly reason: string };

interface ConfigRow {
  readonly provider: string;
  readonly account_ref: string;
  readonly provider_webhook_id: string | null;
  readonly key_version: number;
  readonly api_key_iv: string;
  readonly api_key_ciphertext: string;
  readonly webhook_secret_iv: string;
  readonly webhook_secret_ciphertext: string;
  readonly status: string;
  readonly created_at: number;
}

type Field = "api_key" | "webhook_secret";

/** NEWSLETTER_CONFIG_SEAL_KEY: 32 bytes, base64url (as onboarding generates it). */
export const newsletterSealKeys = (env: Pick<CoreEnv, "NEWSLETTER_CONFIG_SEAL_KEY">) => {
  const raw = (env.NEWSLETTER_CONFIG_SEAL_KEY ?? "").trim();

  if (!raw) return null;

  try {
    const bytes = fromBase64Url(raw.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""));

    return bytes.byteLength === 32
      ? ({ current: 1, keys: { 1: new Uint8Array(bytes) } } satisfies VersionedKeys)
      : null;
  } catch {
    return null;
  }
};

// The sealing primitive has no associated data, so each plaintext carries its table/field context
// and opening checks it: a ciphertext moved into another column (or table) does not decrypt as that
// column's value.
const context = (field: Field) => `newsletter_provider_config.${field}`;

export const sealField = async (keys: VersionedKeys, field: Field, value: string) =>
  sealWithKey(
    keys,
    new TextEncoder().encode(
      JSON.stringify({ c: context(field), v: value }),
    ) as Uint8Array<ArrayBuffer>,
  );

export const openField = async (
  keys: VersionedKeys,
  field: Field,
  sealed: { keyVersion: number; iv: string; ciphertext: string },
): Promise<string> => {
  const plain = JSON.parse(new TextDecoder().decode(await openWithKey(keys, sealed))) as {
    c?: unknown;
    v?: unknown;
  };

  if (plain.c !== context(field) || !Predicate.isString(plain.v))
    throw new Error("sealed value belongs to another field");

  return plain.v;
};

const readRow = (env: CoreEnv) =>
  env.DIRECTORY.withSession("first-primary")
    .prepare(
      "SELECT provider, account_ref, provider_webhook_id, key_version, api_key_iv, api_key_ciphertext, webhook_secret_iv, webhook_secret_ciphertext, status, created_at FROM newsletter_provider_config WHERE id = 'default'",
    )
    .first<ConfigRow>();

/**
 * The runtime configuration, decrypted, or why it is unusable. A present row is authoritative even
 * when it cannot be opened: the caller must not fall back to (or mix with) the env configuration.
 */
export const loadRuntimeNewsletterConfig = async (
  env: CoreEnv,
): Promise<RuntimeNewsletterConfig> => {
  const row = await readRow(env);

  if (!row) return { _tag: "None" };

  if (row.status !== "ready")
    return { _tag: "Unusable", reason: "newsletter provider needs attention" };

  if (row.provider !== "resend")
    return { _tag: "Unusable", reason: `unknown newsletter provider ${row.provider}` };
  const keys = newsletterSealKeys(env);

  if (!keys) return { _tag: "Unusable", reason: "newsletter configuration key unavailable" };

  try {
    const apiKey = await openField(keys, "api_key", {
      keyVersion: row.key_version,
      iv: row.api_key_iv,
      ciphertext: row.api_key_ciphertext,
    });

    const webhookSecret = await openField(keys, "webhook_secret", {
      keyVersion: row.key_version,
      iv: row.webhook_secret_iv,
      ciphertext: row.webhook_secret_ciphertext,
    });

    return {
      _tag: "Present",
      credentials: { provider: "resend", account: row.account_ref, apiKey, webhookSecret },
    };
  } catch {
    // Never the error text: it could echo key material.
    return { _tag: "Unusable", reason: "newsletter credentials could not be opened" };
  }
};

const qualified = (env: CoreEnv) => (env.NEWSLETTER_QUALIFIED ?? "").trim() !== "";

const sandboxed = (env: CoreEnv) => (env.MAIL_SANDBOX_DOMAINS ?? "").trim() !== "";

/** Legacy deployment configuration (CI/operator-managed stages): complete or absent. */
export const legacyNewsletterEnv = (env: CoreEnv) => (env.NEWSLETTER_PROVIDER ?? "").trim() !== "";

/** Why nothing can be configured right now (release, stage or installation), or null. */
const setupBlocker = (env: CoreEnv): string | null =>
  sandboxed(env)
    ? "newsletters are disabled in sandboxed stages"
    : !qualified(env)
      ? "newsletters are not qualified for this release"
      : newsletterSealKeys(env) === null
        ? "this installation cannot store newsletter credentials"
        : null;

/**
 * Safe status projection for `GET /v1/newsletter/config`. A stored row is trial-opened to tell a
 * usable configuration from one that needs repair; nothing decrypted leaves this function.
 */
export const newsletterConfigView = async (
  env: CoreEnv,
  isOperator: boolean,
): Promise<NewsletterConfigView> => {
  const q = qualified(env);
  const base = { provider: "resend" as const, qualified: q };
  const row = await readRow(env);

  if (row) {
    const usable = Predicate.isTagged(await loadRuntimeNewsletterConfig(env), "Present");

    if (usable)
      return {
        ...base,
        status: "ready",
        canConfigure: false,
        configuredAt: Number(row.created_at),
      };
    // Unusable credentials must not lock the instance out: an operator may repair them, unless
    // nothing can be stored at all (then the installation itself is blocked).
    const blocked = setupBlocker(env);

    return {
      ...base,
      status: blocked ? "blocked" : "needs-attention",
      canConfigure: isOperator && blocked === null,
      configuredAt: Number(row.created_at),
      detail: blocked ?? "the stored newsletter credentials cannot be used; reconnect Resend",
    };
  }

  if (legacyNewsletterEnv(env)) return { ...base, status: "ready", canConfigure: false };
  const blocked = setupBlocker(env);

  if (blocked) return { ...base, status: "blocked", canConfigure: false, detail: blocked };

  const pending = await env.DIRECTORY.prepare(
    "SELECT detail FROM newsletter_provider_reconcile ORDER BY created_at DESC LIMIT 1",
  ).first<{ detail: string }>();

  return pending
    ? {
        ...base,
        status: "needs-attention",
        canConfigure: isOperator,
        detail: pending.detail,
      }
    : { ...base, status: "unconfigured", canConfigure: isOperator };
};

// ---- setup ----

export type ConfigureResult =
  | { readonly _tag: "Ready"; readonly configuredAt: number }
  | {
      readonly _tag: "Rejected";
      readonly code: "bad_request" | "conflict" | "forbidden" | "unavailable";
      readonly message: string;
    }
  | { readonly _tag: "NeedsAttention"; readonly message: string };

type Fetch = typeof fetch;

interface ResendWebhook {
  readonly id: string;
  readonly endpoint: string;
}

const RESEND_KEY = /^re_[A-Za-z0-9_-]{8,200}$/;

/** A Resend API call with only the operator's key; errors never carry the key or a body. */
const resendCall =
  (apiKey: string, fetchFn: Fetch, base: string) =>
  async <B>(method: string, path: string, body?: B): Promise<Response | null> => {
    try {
      const init: RequestInit = {
        method,
        headers: {
          authorization: `Bearer ${apiKey}`,
          accept: "application/json",
          "content-type": "application/json",
          "user-agent": "bye-mailcore/1",
        },
        signal: AbortSignal.timeout(15_000),
      };

      if (body !== undefined) init.body = JSON.stringify(body);

      return await fetchFn(`${base}${path}`, init);
    } catch {
      return null;
    }
  };

const readJson = async <T>(r: Response): Promise<T | null> => {
  try {
    return (await r.json()) as T;
  } catch {
    return null;
  }
};

const secretOf = (b: { signing_secret?: unknown } | null) =>
  Predicate.isString(b?.signing_secret) && b.signing_secret.startsWith("whsec_")
    ? b.signing_secret
    : null;

const recordReconcile = async (
  env: CoreEnv,
  endpoint: string,
  webhookId: string | null,
  detail: string,
) => {
  try {
    await env.DIRECTORY.prepare(
      "INSERT INTO newsletter_provider_reconcile (endpoint, provider, provider_webhook_id, detail, created_at) VALUES (?, 'resend', ?, ?, ?) ON CONFLICT (endpoint) DO UPDATE SET provider_webhook_id = excluded.provider_webhook_id, detail = excluded.detail, created_at = excluded.created_at",
    )
      .bind(endpoint, webhookId, detail, Date.now())
      .run();
  } catch {
    // The operator still gets needs-attention in the response; a retry lists and reconciles.
  }

  console.warn(JSON.stringify({ level: "warn", op: "newsletter.config.reconcile", detail }));
};

/**
 * Connect Resend with one API key (infra/onboarding/spec.md §24). Provider mutation and the D1 commit
 * cannot be one transaction, so: an existing Bye webhook for this endpoint is reused when its
 * signing secret is retrievable; a webhook created here is deleted again if persistence fails; and
 * anything uncertain is recorded for the operator instead of retried blindly.
 *
 * Repair: when the stored row can no longer be used (key unavailable, undecryptable, or not
 * `ready`), the same sequence replaces it. The replacement gets a new provider account reference,
 * so work bound to the old credentials stays held for review and is never silently remapped
 * (spec §33). A usable configuration is never replaced here.
 */
export const configureNewsletterProvider = async (
  env: CoreEnv,
  input: { readonly provider: string; readonly apiKey: string; readonly actorId: string },
  fetchFn: Fetch = (u, i) => fetch(u, i),
  base = RESEND_API,
): Promise<ConfigureResult> => {
  const reject = (code: Extract<ConfigureResult, { _tag: "Rejected" }>["code"], message: string) =>
    ({ _tag: "Rejected", code, message }) as const;

  if (!qualified(env)) return reject("forbidden", "newsletters are not qualified for this release");

  if (sandboxed(env)) return reject("forbidden", "newsletters are disabled in sandboxed stages");
  const keys = newsletterSealKeys(env);

  if (!keys) return reject("unavailable", "this installation cannot store newsletter credentials");

  if (input.provider !== "resend") return reject("bad_request", "unsupported newsletter provider");

  if (!RESEND_KEY.test(input.apiKey)) return reject("bad_request", "that is not a Resend API key");
  const existing = await readRow(env);

  if (
    existing === null
      ? legacyNewsletterEnv(env)
      : Predicate.isTagged(await loadRuntimeNewsletterConfig(env), "Present")
  )
    return reject("conflict", "a newsletter provider is already configured");

  const endpoint = `${env.APP_ORIGIN}${NEWSLETTER_WEBHOOK_PATH}`;
  const call = resendCall(input.apiKey, fetchFn, base);

  // 1. List first: a retry after an uncertain create finds the earlier webhook.
  const listed = await call("GET", "/webhooks");

  if (listed === null)
    return reject("unavailable", "Resend could not be reached; nothing was changed");

  if (listed.status === 401 || listed.status === 403)
    return reject(
      "bad_request",
      "Resend refused this key; create a key with full access (contacts, broadcasts and webhooks)",
    );

  if (!listed.ok)
    return reject("unavailable", `Resend returned ${listed.status}; nothing was changed`);

  const data =
    (await readJson<{ data?: ReadonlyArray<Partial<ResendWebhook>> }>(listed))?.data ?? [];

  const matches = data.filter(
    (w): w is ResendWebhook => Predicate.isString(w.id) && w.endpoint === endpoint,
  );

  let webhookId: string | null = null;
  let secret: string | null = null;
  let created = false;

  for (const w of matches) {
    if (secret === null) {
      const got = await call("GET", `/webhooks/${encodeURIComponent(w.id)}`);
      const s = got?.ok ? secretOf(await readJson(got)) : null;

      if (s) {
        webhookId = w.id;
        secret = s;
        continue;
      }
    }

    // A Bye webhook whose secret Bye cannot recover (or a duplicate) would deliver events nobody
    // can verify: remove it, and stop if its removal can't be confirmed.
    const del = await call("DELETE", `/webhooks/${encodeURIComponent(w.id)}`);

    if (!del || !(del.ok || del.status === 404)) {
      await recordReconcile(
        env,
        endpoint,
        w.id,
        "an existing Resend webhook for this instance could not be reused or removed",
      );

      return {
        _tag: "NeedsAttention",
        message:
          "an existing Resend webhook for this instance could not be reused or removed; retry",
      };
    }
  }

  // 2. Create when none was reusable.
  if (secret === null) {
    const res = await call("POST", "/webhooks", { endpoint, events: [...RESEND_WEBHOOK_EVENTS] });

    if (res !== null && res.status >= 400 && res.status < 500)
      return reject(
        "bad_request",
        res.status === 401 || res.status === 403
          ? "Resend refused this key; it needs webhook management access"
          : `Resend refused the webhook (${res.status})`,
      );
    const body = res?.ok ? await readJson<{ id?: unknown; signing_secret?: unknown }>(res) : null;
    const s = secretOf(body);

    if (!res?.ok || !Predicate.isString(body?.id) || !s) {
      // The webhook may exist now. Never create another blindly: the retry lists and reconciles.
      await recordReconcile(
        env,
        endpoint,
        Predicate.isString(body?.id) ? body.id : null,
        "webhook creation outcome unknown",
      );

      return {
        _tag: "NeedsAttention",
        message: "the Resend webhook may have been created; retry to reconcile it",
      };
    }

    webhookId = body.id;
    secret = s;
    created = true;
  }

  // 3. Seal and persist.
  const now = Date.now();

  try {
    const apiKey = await sealField(keys, "api_key", input.apiKey);
    const hook = await sealField(keys, "webhook_secret", secret);
    const account = `resend_${randomToken(12)}`;
    await env.DIRECTORY.batch([
      // Repair replaces exactly the unusable row read above; a concurrent change makes the insert
      // conflict, so nothing is overwritten unseen.
      ...(existing === null
        ? []
        : [
            env.DIRECTORY.prepare(
              "DELETE FROM newsletter_provider_config WHERE id = 'default' AND created_at = ? AND account_ref = ?",
            ).bind(existing.created_at, existing.account_ref),
          ]),
      env.DIRECTORY.prepare(
        `INSERT INTO newsletter_provider_config (id, provider, account_ref, provider_webhook_id, key_version, api_key_iv, api_key_ciphertext, webhook_secret_iv, webhook_secret_ciphertext, status, configured_by, created_at, updated_at, last_verified_at)
         VALUES ('default', 'resend', ?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?, ?, ?)`,
      ).bind(
        account,
        webhookId,
        apiKey.keyVersion,
        apiKey.iv,
        apiKey.ciphertext,
        hook.iv,
        hook.ciphertext,
        input.actorId,
        now,
        now,
        now,
      ),
      env.DIRECTORY.prepare("DELETE FROM newsletter_provider_reconcile WHERE endpoint = ?").bind(
        endpoint,
      ),
    ]);
  } catch {
    if (created && webhookId) {
      const del = await call("DELETE", `/webhooks/${encodeURIComponent(webhookId)}`);

      if (del && (del.ok || del.status === 404))
        return reject("unavailable", "the configuration could not be saved; nothing was kept");
    }

    await recordReconcile(env, endpoint, webhookId, "the configuration could not be saved");

    return {
      _tag: "NeedsAttention",
      message: "the configuration could not be saved; retry to reconcile the Resend webhook",
    };
  }

  // A repaired row's old webhook (e.g. for a previous endpoint) would deliver events nobody can
  // verify: remove it, or leave a reconcile record when that can't be confirmed.
  const stale = existing?.provider_webhook_id ?? null;

  if (stale && stale !== webhookId) {
    const del = await call("DELETE", `/webhooks/${encodeURIComponent(stale)}`);

    if (!del || !(del.ok || del.status === 404))
      await recordReconcile(
        env,
        `${endpoint}#replaced`,
        stale,
        "the previous Resend webhook could not be removed",
      );
  }

  console.log(
    JSON.stringify({
      level: "info",
      op: "newsletter.config.ready",
      reused: !created,
      repaired: existing !== null,
    }),
  );

  return { _tag: "Ready", configuredAt: now };
};
