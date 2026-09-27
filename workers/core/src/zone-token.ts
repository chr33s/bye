import {
  fromBase64Url,
  openWithKey,
  sealWithKey,
  type VersionedKeys,
} from "@bye/platform-cloudflare";
import type { CoreEnv } from "./env.ts";

// Installation zone token (infra/onboarding/spec.md §13 fallback). Onboarding's OAuth grant never
// includes DNS or Email Routing, so an owner who wants Bye to make the incoming-email changes
// itself enters a separately created Cloudflare API token scoped to exactly the installation's
// zone. It is validated against Cloudflare before it is stored, sealed with ZONE_TOKEN_SEAL_KEY,
// and used only for that zone's customer-domain work. Plaintext exists only inside the request or
// Workflow step that needs it: never in KV, logs, error strings, API responses or DO state.

const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";

export type ZoneTokenEnv = Pick<
  CoreEnv,
  | "DIRECTORY"
  | "CF_DNS_API_TOKEN"
  | "ZONE_TOKEN_SEAL_KEY"
  | "INSTALL_ACCOUNT_ID"
  | "INSTALL_ZONE_ID"
  | "INSTALL_ZONE_NAME"
>;

/** ZONE_TOKEN_SEAL_KEY: 32 bytes, base64url (as onboarding generates it). */
export const zoneTokenSealKeys = (env: Pick<CoreEnv, "ZONE_TOKEN_SEAL_KEY">) => {
  const raw = (env.ZONE_TOKEN_SEAL_KEY ?? "").trim();
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

// The sealing primitive has no associated data: the plaintext carries its table/field and zone,
// and opening checks both, so a ciphertext moved elsewhere (or to another zone) does not open.
const CONTEXT = "installation_zone_token.token";

const seal = (keys: VersionedKeys, zoneId: string, token: string) =>
  sealWithKey(
    keys,
    new TextEncoder().encode(
      JSON.stringify({ c: CONTEXT, z: zoneId, v: token }),
    ) as Uint8Array<ArrayBuffer>,
  );

const open = async (
  keys: VersionedKeys,
  zoneId: string,
  sealed: { keyVersion: number; iv: string; ciphertext: string },
): Promise<string> => {
  const plain = JSON.parse(new TextDecoder().decode(await openWithKey(keys, sealed))) as {
    c?: unknown;
    z?: unknown;
    v?: unknown;
  };
  if (plain.c !== CONTEXT || plain.z !== zoneId || typeof plain.v !== "string")
    throw new Error("sealed token belongs to another field or zone");
  return plain.v;
};

interface TokenRow {
  readonly zone_id: string;
  readonly key_version: number;
  readonly token_iv: string;
  readonly token_ciphertext: string;
  readonly configured_by: string;
  readonly created_at: number;
  readonly last_verified_at: number | null;
}

const readRow = (env: Pick<CoreEnv, "DIRECTORY">) =>
  env.DIRECTORY.withSession("first-primary")
    .prepare(
      "SELECT zone_id, key_version, token_iv, token_ciphertext, configured_by, created_at, last_verified_at FROM installation_zone_token WHERE id = 'default'",
    )
    .first<TokenRow>();

/** Whether a token is stored for the installation's zone (nothing is decrypted). */
export const zoneTokenConfigured = async (env: ZoneTokenEnv): Promise<boolean> => {
  const row = await readRow(env).catch(() => null);
  return row !== null && !!env.INSTALL_ZONE_ID && row.zone_id === env.INSTALL_ZONE_ID;
};

const installationZone = (env: ZoneTokenEnv) =>
  (env.INSTALL_ZONE_NAME ?? "").trim().toLowerCase().replace(/\.$/, "");

/**
 * The Cloudflare token for customer-domain automation on `domainName`: the deployment's own
 * CF_DNS_API_TOKEN first; otherwise the stored installation token, but only for the
 * installation's own zone. Null = manual records. Decrypts on every call; callers must not keep it.
 */
export const zoneApiToken = async (
  env: ZoneTokenEnv,
  domainName: string | null,
): Promise<string | null> => {
  if (env.CF_DNS_API_TOKEN) return env.CF_DNS_API_TOKEN;
  const zone = installationZone(env);
  const name = (domainName ?? "").trim().toLowerCase().replace(/\.$/, "");
  if (!zone || !env.INSTALL_ZONE_ID || name !== zone) return null;
  const keys = zoneTokenSealKeys(env);
  if (!keys) return null;
  const row = await readRow(env).catch(() => null);
  if (!row || row.zone_id !== env.INSTALL_ZONE_ID) return null;
  try {
    return await open(keys, row.zone_id, {
      keyVersion: row.key_version,
      iv: row.token_iv,
      ciphertext: row.token_ciphertext,
    });
  } catch {
    return null;
  }
};

/** "zone-api" when some token can automate the installation zone, else "manual-records". */
export const installationAutomation = async (
  env: ZoneTokenEnv,
): Promise<"zone-api" | "manual-records"> =>
  env.CF_DNS_API_TOKEN || (await zoneTokenConfigured(env)) ? "zone-api" : "manual-records";

export class ZoneTokenRejected extends Error {
  readonly _tag = "ZoneTokenRejected" as const;
}

/**
 * Checks a candidate token against Cloudflare before anything is stored: it must be active, see
 * exactly one zone (the installation's), and read that zone's DNS records and Email Routing.
 * Write permissions can only be proven by writing; they are exercised (and reported) at use.
 * Messages never contain the token.
 */
export const validateZoneToken = async (
  env: ZoneTokenEnv,
  token: string,
  fetchFn: typeof fetch = fetch,
): Promise<void> => {
  const zoneId = env.INSTALL_ZONE_ID ?? "";
  const zone = installationZone(env);
  if (!zoneId || !zone) throw new ZoneTokenRejected("this installation has no recorded zone");
  if (!/^[A-Za-z0-9_-]{20,200}$/.test(token))
    throw new ZoneTokenRejected("that does not look like a Cloudflare API token");
  const get = async (path: string) => {
    let r: Response;
    try {
      r = await fetchFn(`${CLOUDFLARE_API}${path}`, {
        headers: { authorization: `Bearer ${token}`, accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new ZoneTokenRejected("Cloudflare could not be reached; try again");
    }
    const body = (await r.json().catch(() => ({}))) as { success?: boolean; result?: unknown };
    return { ok: r.ok && body.success !== false, result: body.result };
  };
  const one = await get(`/zones/${encodeURIComponent(zoneId)}`);
  const z = one.result as { id?: string; name?: string } | null | undefined;
  if (!one.ok || z?.id !== zoneId || (z.name ?? "").toLowerCase() !== zone)
    throw new ZoneTokenRejected(`the token cannot read the zone ${zone}`);
  const list = await get("/zones?per_page=50");
  const zones = Array.isArray(list.result) ? (list.result as Array<{ id?: string }>) : null;
  if (!list.ok || zones === null)
    throw new ZoneTokenRejected("Cloudflare refused to list the token's zones");
  if (zones.length !== 1 || zones[0]!.id !== zoneId)
    throw new ZoneTokenRejected(
      `the token must be limited to ${zone} only (Zone Resources: Include → Specific zone → ${zone}); it can reach ${zones.length} zones`,
    );
  if (!(await get(`/zones/${encodeURIComponent(zoneId)}/dns_records?per_page=1`)).ok)
    throw new ZoneTokenRejected(
      `the token cannot read DNS records on ${zone} (grant Zone → DNS → Edit)`,
    );
  if (!(await get(`/zones/${encodeURIComponent(zoneId)}/email/routing`)).ok)
    throw new ZoneTokenRejected(
      `the token cannot read Email Routing on ${zone} (grant Zone → Email Routing Rules → Edit and Zone → Zone Settings → Edit)`,
    );
};

/** Validates, seals and stores (replacing any previous token). */
export const storeZoneToken = async (
  env: ZoneTokenEnv,
  token: string,
  actorId: string,
  now: number,
  fetchFn: typeof fetch = fetch,
): Promise<void> => {
  const keys = zoneTokenSealKeys(env);
  if (!keys)
    throw new ZoneTokenRejected("this installation cannot store a zone token (no sealing key)");
  await validateZoneToken(env, token, fetchFn);
  const zoneId = env.INSTALL_ZONE_ID!;
  const sealed = await seal(keys, zoneId, token);
  await env.DIRECTORY.prepare(
    `INSERT INTO installation_zone_token (id, zone_id, key_version, token_iv, token_ciphertext, configured_by, created_at, last_verified_at)
     VALUES ('default', ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET zone_id = excluded.zone_id, key_version = excluded.key_version,
       token_iv = excluded.token_iv, token_ciphertext = excluded.token_ciphertext,
       configured_by = excluded.configured_by, created_at = excluded.created_at,
       last_verified_at = excluded.last_verified_at`,
  )
    .bind(zoneId, sealed.keyVersion, sealed.iv, sealed.ciphertext, actorId, now, now)
    .run();
};

export const deleteZoneToken = async (env: Pick<CoreEnv, "DIRECTORY">): Promise<boolean> =>
  ((await env.DIRECTORY.prepare("DELETE FROM installation_zone_token WHERE id = 'default'").run())
    .meta.changes ?? 0) > 0;
