import { Predicate } from "effect";
import {
  DEFAULT_MAIL_DNS,
  type DkimKey,
  type ExternalCredential,
  type ExternalCredentialStore,
  importArcSigner,
  importDkimKey,
  makeCloudflarePersonalTransport,
  makeCloudflareTransactionalTransport,
  makeExternalIdentityApiTransport,
  makeSealedForwardingTransport,
  openWithKey,
  parseSandboxDomains,
  parseTrafficClasses,
  sandboxTransport,
  type RawContentSource,
  sealWithKey,
  type SendEmailBindingLike,
  type TransportAdapter,
  type VersionedKeys,
} from "@bye/platform-cloudflare";
import { EmailMessage } from "cloudflare:email";
import { guardedFetch } from "./dns.ts";
import type { CoreEnv } from "./env.ts";

// Transport wiring (§5.3). Each traffic class gets an adapter only when its approval/credentials
// are configured for this environment AND the class is enabled for the stage
// (`MAIL_TRAFFIC_CLASSES`); otherwise the adapter is not built, so the router rejects the class
// rather than silently falling back to the transactional-only Cloudflare binding. Newsletters use
// `NewsletterProvider` (newsletter.ts), never an individual-message adapter.

/**
 * The installation's DKIM key (MAIL_DKIM_PRIVATE_KEY, selector `bye1`), imported on first use per
 * isolate. Empty = personal mail goes out unsigned by Bye. An unusable key fails the submission
 * (retryable) rather than silently sending unsigned mail.
 */
const dkimKeys = new Map<string, Promise<DkimKey>>();

export const dkimKeyFor = (env: Pick<CoreEnv, "MAIL_DKIM_PRIVATE_KEY">) => {
  const pem = env.MAIL_DKIM_PRIVATE_KEY ?? "";

  if (pem.trim() === "") return null;

  return async (): Promise<DkimKey> => {
    let key = dkimKeys.get(pem);

    if (!key) {
      key = importDkimKey(pem, DEFAULT_MAIL_DNS.dkimSelector);
      key.catch(() => dkimKeys.delete(pem));
      dkimKeys.set(pem, key);
    }

    return key;
  };
};

/** Workers `send_email` accepts one envelope recipient per raw message. */
export const sendEmailBinding = (binding: SendEmail): SendEmailBindingLike => ({
  send: async ({ from, to, raw }) => {
    const recipients = Predicate.isString(to) ? [to] : to;

    if (recipients.length !== 1)
      throw new Error("multiple recipients not allowed on the transactional binding");

    const result = await binding.send(
      new EmailMessage(from, recipients[0]!, raw as ReadableStream | string),
    );

    return { messageId: result.messageId };
  },
});

export const contentSource = (env: CoreEnv): RawContentSource => ({
  load: async (key) => (await env.ORIGINALS.get(key))?.body ?? null,
});

const sealKeys = (env: CoreEnv): VersionedKeys | null => {
  if (!env.EXTERNAL_IDENTITY_SEAL_KEY) return null;

  const raw = Uint8Array.from(
    atob(env.EXTERNAL_IDENTITY_SEAL_KEY.replace(/-/g, "+").replace(/_/g, "/")),
    (c) => c.charCodeAt(0),
  );

  return raw.byteLength === 32 ? { current: 1, keys: { 1: raw } } : null;
};

/** Sealed per-identity credentials in D1 (`external_identity_credentials`). */
export const externalCredentialStore = (
  env: CoreEnv,
  mailboxId: string,
): ExternalCredentialStore => ({
  resolve: async (from) => {
    const keys = sealKeys(env);

    if (!keys) return null;

    const row = await env.DIRECTORY.prepare(
      "SELECT provider, endpoint, key_version, iv, ciphertext FROM external_identity_credentials WHERE mailbox_id = ? AND address = ? AND revoked_at IS NULL",
    )
      .bind(mailboxId, from.toLowerCase())
      .first<{
        provider: ExternalCredential["provider"];
        endpoint: string | null;
        key_version: number;
        iv: string;
        ciphertext: string;
      }>();

    if (!row) return null;

    const secret = JSON.parse(
      new TextDecoder().decode(
        await openWithKey(keys, {
          keyVersion: row.key_version,
          iv: row.iv,
          ciphertext: row.ciphertext,
        }),
      ),
    ) as Omit<ExternalCredential, "provider">;

    return row.endpoint
      ? { ...secret, provider: row.provider, endpoint: row.endpoint }
      : { ...secret, provider: row.provider };
  },
  persist: (from, credential) => storeExternalCredential(env, mailboxId, from, credential),
});

export const storeExternalCredential = async (
  env: CoreEnv,
  mailboxId: string,
  address: string,
  credential: ExternalCredential,
): Promise<void> => {
  const keys = sealKeys(env);

  if (!keys) throw new Error("external identity sealing key not configured");
  const { provider, endpoint, ...secret } = credential;

  const sealed = await sealWithKey(
    keys,
    new TextEncoder().encode(JSON.stringify(secret)) as Uint8Array<ArrayBuffer>,
  );

  const now = Date.now();
  await env.DIRECTORY.prepare(
    `INSERT INTO external_identity_credentials (mailbox_id, address, provider, endpoint, key_version, iv, ciphertext, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (mailbox_id, address) DO UPDATE SET provider = excluded.provider, endpoint = excluded.endpoint, key_version = excluded.key_version,
       iv = excluded.iv, ciphertext = excluded.ciphertext, updated_at = excluded.updated_at, revoked_at = NULL`,
  )
    .bind(
      mailboxId,
      address.toLowerCase(),
      provider,
      endpoint ?? null,
      sealed.keyVersion,
      sealed.iv,
      sealed.ciphertext,
      now,
      now,
    )
    .run();
};

export const buildTransportAdapters = async (
  env: CoreEnv,
  mailboxId: string,
  fetchFn: typeof fetch = (u, i) => fetch(u, i),
): Promise<ReadonlyArray<TransportAdapter>> => {
  const content = contentSource(env);
  const f = fetchFn as never;

  const adapters: Array<TransportAdapter> = [
    makeCloudflareTransactionalTransport(sendEmailBinding(env.TRANSACTIONAL_EMAIL), content),
  ];

  // Personal correspondence goes through the same Cloudflare Email Sending binding, only where
  // the stage enables the class (the router rejects it everywhere else).
  if (parseTrafficClasses(env.MAIL_TRAFFIC_CLASSES).has("personal"))
    adapters.push(
      makeCloudflarePersonalTransport(
        sendEmailBinding(env.TRANSACTIONAL_EMAIL),
        content,
        dkimKeyFor(env),
      ),
    );

  if (
    env.FORWARDING_API_KEY &&
    env.FORWARDING_ENDPOINT &&
    env.SRS_SECRET &&
    env.FORWARDING_DOMAIN
  ) {
    const signer = env.ARC_SIGNING_KEY
      ? await importArcSigner(env.ARC_SIGNING_KEY, env.FORWARDING_DOMAIN, env.ARC_SELECTOR || "arc")
      : null;

    adapters.push(
      makeSealedForwardingTransport(
        {
          endpoint: env.FORWARDING_ENDPOINT,
          apiKey: env.FORWARDING_API_KEY,
          srs: { secret: env.SRS_SECRET, domain: env.FORWARDING_DOMAIN },
          signer,
          authservId: `mx.${env.FORWARDING_DOMAIN}`,
        },
        content,
        f,
      ),
    );
  }

  // External identities POST to user-chosen relay/token endpoints: resolve-then-check every
  // request and never follow redirects (registration only checks the URL string).
  if (sealKeys(env))
    adapters.push(
      makeExternalIdentityApiTransport(
        externalCredentialStore(env, mailboxId),
        content,
        guardedFetch(fetchFn) as never,
      ),
    );
  // Preview mail sandbox (§15.8): every adapter may only mail the stage's disposable domains.
  const sandbox = parseSandboxDomains(env.MAIL_SANDBOX_DOMAINS);

  return env.MAIL_SANDBOX_DOMAINS?.trim()
    ? adapters.map((a) => sandboxTransport(a, sandbox))
    : adapters;
};
