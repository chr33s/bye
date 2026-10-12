import { Effect, Option, Predicate, Schema } from "effect";
import {
  CORE,
  type MethodDefinition,
  methodError,
  type SetError,
  setError,
  utcDate,
} from "@bye/jmap";
import { isForbiddenProxyTarget } from "@bye/mail-codec";
import { encryptWebPush } from "@bye/platform-cloudflare";
import type { CoreEnv } from "./env.ts";

// JMAP PushSubscription (RFC 8620 §7.2; spec.md §16.5, A3, T09). Subscriptions belong to the
// user and the credential that made them; a callback receives StateChange pushes only after it
// echoes the verification code. Callback URLs pass destination validation (SSRF defenses) both
// at creation and at every delivery.

/** Longest subscription lifetime; clients re-extend (RFC 8620 §7.2 `expires`). */
export const PUSH_MAX_LIFETIME_MS = 7 * 24 * 3600 * 1000;

export const PUSH_TIMEOUT_MS = 10_000;

const MAX_SUBSCRIPTIONS_PER_USER = 20;

const PRIVATE_V4 = [
  /^10\./,
  /^127\./,
  /^0\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
  /^(22[4-9]|2[3-5]\d)\./,
];

/**
 * Destination validation for push callbacks: HTTPS on the default port, a public DNS name (no IP
 * literals, no single-label, loopback, link-local or internal names) and no embedded credentials.
 */
export const validPushUrl = (raw: string): boolean => {
  let url: URL;

  try {
    url = new URL(raw);
  } catch {
    return false;
  }

  if (isForbiddenProxyTarget(raw)) return false;

  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443"))
    return false;
  const host = url.hostname.toLowerCase();

  if (
    host.startsWith("[") ||
    /^\d+\.\d+\.\d+\.\d+$/.test(host) ||
    PRIVATE_V4.some((r) => r.test(host))
  )
    return false;

  if (
    !host.includes(".") ||
    /(^|\.)(localhost|local|internal|intranet|lan|home|corp|arpa)$/.test(host)
  )
    return false;

  return raw.length <= 2048;
};

interface SubscriptionRow {
  readonly id: string;
  readonly user_id: string;
  readonly session_id: string;
  readonly device_client_id: string;
  readonly url: string;
  readonly keys_json: string | null;
  readonly verification_code: string;
  readonly verified_at: number | null;
  readonly expires_at: number;
  readonly types: string | null;
}

const Keys = Schema.Struct({ p256dh: Schema.String, auth: Schema.String });

const decodeKeys = Schema.decodeUnknownOption(Keys);

const toObject = (r: SubscriptionRow): Schema.JsonObject => ({
  id: r.id,
  deviceClientId: r.device_client_id,
  // The URL and keys are write-only after creation (RFC 8620 §7.2.1).
  verificationCode: null,
  expires: utcDate(Number(r.expires_at)),
  types: r.types === null ? null : (JSON.parse(r.types) as Array<string>),
});

/** POST a JSON payload to a callback, encrypted (RFC 8291) when the client gave keys. */
const post = async (
  fetcher: typeof fetch,
  url: string,
  payload: Schema.JsonObject,
  keys: string | null,
): Promise<boolean> => {
  if (!validPushUrl(url)) return false;
  const body = new Uint8Array(new TextEncoder().encode(JSON.stringify(payload)));
  const k = keys === null ? Option.none() : decodeKeys(JSON.parse(keys));

  const encrypted = Option.isSome(k);
  const content = Option.isSome(k) ? await encryptWebPush(k.value, body) : body;

  const headers = new Headers({ ttl: "86400", urgency: "normal" });

  if (encrypted) {
    headers.set("content-encoding", "aes128gcm");
    headers.set("content-type", "application/octet-stream");
  } else headers.set("content-type", "application/json; charset=utf-8");

  try {
    const response = await fetcher(url, {
      method: "POST",
      headers,
      body: content,
      redirect: "manual",
      signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
    });

    return response.ok;
  } catch {
    return false;
  }
};

/**
 * Deliver one account's StateChange to the verified, unexpired subscriptions of its users. Each
 * user gets its own states: they bind that principal's visibility generation (A3).
 */
export const pushStateChange = async (
  env: Pick<CoreEnv, "DIRECTORY">,
  changedFor: ReadonlyMap<string, { readonly [type: string]: string }>,
  accountId: string,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
): Promise<number> => {
  if (changedFor.size === 0) return 0;

  // One JSON parameter, however many principals hold grants (D1 binds at most 100 values).
  const rows = (
    await env.DIRECTORY.prepare(
      `SELECT * FROM jmap_push_subscriptions WHERE verified_at IS NOT NULL AND expires_at > ?
       AND user_id IN (SELECT value FROM json_each(?))`,
    )
      .bind(now, JSON.stringify([...changedFor.keys()]))
      .all<SubscriptionRow>()
  ).results;

  let sent = 0;

  for (const r of rows) {
    const types = r.types === null ? null : new Set(JSON.parse(r.types) as Array<string>);

    const relevant = Object.fromEntries(
      Object.entries(changedFor.get(r.user_id) ?? {}).filter(
        ([type]) => types === null || types.has(type),
      ),
    );

    if (Object.keys(relevant).length === 0) continue;

    if (
      await post(
        fetcher,
        r.url,
        { "@type": "StateChange", changed: { [accountId]: relevant } },
        r.keys_json,
      )
    )
      sent++;
  }

  return sent;
};

/** Remove every subscription made by a credential (revocation, A3). */
export const revokePushSubscriptions = (env: Pick<CoreEnv, "DIRECTORY">, sessionId: string) =>
  env.DIRECTORY.prepare("DELETE FROM jmap_push_subscriptions WHERE session_id = ?")
    .bind(sessionId)
    .run();

export interface PushCaller {
  readonly userId: string;
  readonly sessionId: string;
  readonly env: Pick<CoreEnv, "DIRECTORY">;
  readonly fetch: typeof fetch;
  readonly waitUntil: (p: Promise<unknown>) => void;
}

const GetArgs = Schema.Struct({
  ids: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
  properties: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
});

const SetArgs = Schema.Struct({
  create: Schema.optional(Schema.NullOr(Schema.Record(Schema.String, Schema.JsonObject))),
  update: Schema.optional(Schema.NullOr(Schema.Record(Schema.String, Schema.JsonObject))),
  destroy: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
});

const ifPresent = <A>(o: Option.Option<A>, f: (a: A) => Effect.Effect<Schema.JsonObject>) =>
  Option.isSome(o) ? f(o.value) : Effect.fail(methodError("invalidArguments"));

const errors = (list: ReadonlyArray<readonly [string, SetError]>): Schema.JsonObject | null =>
  list.length === 0
    ? null
    : Object.fromEntries(
        list.map(([k, e]): readonly [string, Schema.JsonObject] => [
          k,
          e.description ? { type: e.type, description: e.description } : { type: e.type },
        ]),
      );

/** PushSubscription/get and /set, not account-scoped (RFC 8620 §7.2). */
export const pushMethods = (caller: PushCaller): ReadonlyArray<MethodDefinition<never>> => {
  const db = caller.env.DIRECTORY;

  const mine = () =>
    Effect.promise(
      async () =>
        (
          await db
            .prepare(
              "SELECT * FROM jmap_push_subscriptions WHERE user_id = ? ORDER BY created_at, id",
            )
            .bind(caller.userId)
            .all<SubscriptionRow>()
        ).results,
    );

  return [
    {
      name: "PushSubscription/get",
      capability: CORE,
      handler: (raw) =>
        ifPresent(Schema.decodeUnknownOption(GetArgs)(raw), (args) =>
          Effect.map(mine(), (rows) => {
            const byId = new Map(rows.map((r) => [r.id, toObject(r)]));
            const ids = args.ids ?? rows.map((r) => r.id);

            return {
              list: ids.flatMap((id) => {
                const o = byId.get(id);

                return o ? [o] : [];
              }),
              notFound: ids.filter((id) => !byId.has(id)),
            };
          }),
        ),
    },
    {
      name: "PushSubscription/set",
      capability: CORE,
      handler: (raw, context) =>
        ifPresent(Schema.decodeUnknownOption(SetArgs)(raw), (args) =>
          Effect.promise(async (): Promise<Schema.JsonObject> => {
            const now = Date.now();
            const created: Array<readonly [string, Schema.JsonObject]> = [];
            const notCreated: Array<readonly [string, SetError]> = [];
            const updated: Array<readonly [string, null]> = [];
            const notUpdated: Array<readonly [string, SetError]> = [];
            const destroyed: Array<string> = [];
            const notDestroyed: Array<readonly [string, SetError]> = [];
            const existing = await Effect.runPromise(mine());

            for (const [cid, o] of Object.entries(args.create ?? {})) {
              const url = o["url"];
              const deviceClientId = o["deviceClientId"];

              if (!Predicate.isString(url) || !validPushUrl(url)) {
                notCreated.push([
                  cid,
                  setError("invalidProperties", "url must be a public https URL", ["url"]),
                ]);
                continue;
              }

              if (!Predicate.isString(deviceClientId) || deviceClientId.length > 255) {
                notCreated.push([
                  cid,
                  setError("invalidProperties", undefined, ["deviceClientId"]),
                ]);
                continue;
              }

              if (
                o["keys"] !== undefined &&
                o["keys"] !== null &&
                Option.isNone(decodeKeys(o["keys"]))
              ) {
                notCreated.push([cid, setError("invalidProperties", undefined, ["keys"])]);
                continue;
              }

              if (existing.length + created.length >= MAX_SUBSCRIPTIONS_PER_USER) {
                notCreated.push([cid, setError("overQuota")]);
                continue;
              }

              const types = o["types"];

              if (
                types !== undefined &&
                types !== null &&
                (!Array.isArray(types) || !types.every(Predicate.isString))
              ) {
                notCreated.push([cid, setError("invalidProperties", undefined, ["types"])]);
                continue;
              }

              const requested = Predicate.isString(o["expires"])
                ? Date.parse(o["expires"])
                : Number.NaN;

              const expires = Number.isFinite(requested)
                ? Math.min(requested, now + PUSH_MAX_LIFETIME_MS)
                : now + PUSH_MAX_LIFETIME_MS;

              const id = `psb_${crypto.randomUUID().replaceAll("-", "")}`;
              const code = crypto.randomUUID().replaceAll("-", "");

              const keys =
                o["keys"] === undefined || o["keys"] === null ? null : JSON.stringify(o["keys"]);

              await db
                .prepare(
                  `INSERT INTO jmap_push_subscriptions (id, user_id, session_id, device_client_id, url, keys_json, verification_code, expires_at, types, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                )
                .bind(
                  id,
                  caller.userId,
                  caller.sessionId,
                  deviceClientId,
                  url,
                  keys,
                  code,
                  expires,
                  types ? JSON.stringify(types) : null,
                  now,
                )
                .run();
              caller.waitUntil(
                post(
                  caller.fetch,
                  url,
                  { "@type": "PushVerification", pushSubscriptionId: id, verificationCode: code },
                  keys,
                ),
              );
              context.createdIds.set(cid, id);
              created.push([cid, { id, keys: null, expires: utcDate(expires) }]);
            }

            for (const [id, patch] of Object.entries(args.update ?? {})) {
              const row = existing.find((r) => r.id === id);

              if (!row) {
                notUpdated.push([id, setError("notFound")]);
                continue;
              }

              let ok = true;

              for (const [key, value] of Object.entries(patch)) {
                if (key === "verificationCode") {
                  if (value !== row.verification_code) {
                    notUpdated.push([
                      id,
                      setError("invalidProperties", "verification code mismatch", [
                        "verificationCode",
                      ]),
                    ]);
                    ok = false;
                    break;
                  }

                  await db
                    .prepare("UPDATE jmap_push_subscriptions SET verified_at = ? WHERE id = ?")
                    .bind(now, id)
                    .run();
                } else if (
                  key === "expires" &&
                  Predicate.isString(value) &&
                  Number.isFinite(Date.parse(value))
                ) {
                  await db
                    .prepare("UPDATE jmap_push_subscriptions SET expires_at = ? WHERE id = ?")
                    .bind(Math.min(Date.parse(value), now + PUSH_MAX_LIFETIME_MS), id)
                    .run();
                } else if (
                  key === "types" &&
                  (value === null || (Array.isArray(value) && value.every(Predicate.isString)))
                ) {
                  await db
                    .prepare("UPDATE jmap_push_subscriptions SET types = ? WHERE id = ?")
                    .bind(value === null ? null : JSON.stringify(value), id)
                    .run();
                } else {
                  notUpdated.push([id, setError("invalidProperties", undefined, [key])]);
                  ok = false;
                  break;
                }
              }

              if (ok) updated.push([id, null]);
            }

            for (const id of args.destroy ?? []) {
              const n = (
                await db
                  .prepare("DELETE FROM jmap_push_subscriptions WHERE id = ? AND user_id = ?")
                  .bind(id, caller.userId)
                  .run()
              ).meta.changes;

              if (n > 0) destroyed.push(id);
              else notDestroyed.push([id, setError("notFound")]);
            }

            return {
              created: created.length ? Object.fromEntries(created) : null,
              updated: updated.length ? Object.fromEntries(updated) : null,
              destroyed: destroyed.length ? destroyed : null,
              notCreated: errors(notCreated),
              notUpdated: errors(notUpdated),
              notDestroyed: errors(notDestroyed),
            };
          }),
        ),
    },
  ];
};
