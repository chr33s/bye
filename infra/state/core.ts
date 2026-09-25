// Telemetry-free Alchemy HTTP state backend (spec §15.6, §15.7).
//
// Implements the wire contract of `alchemy/State/HttpStateApi.ts` (StateApi, contract version 5)
// consumed by `makeHttpStateStore` at alchemy@2.0.0-beta.79, so the strict Cloudflare-only profile
// can keep deployment state on Cloudflare with no third-party egress:
//  - no `fetch`, no OTLP/metrics exporters, no outbound sockets; logs carry op + status only
//  - bearer auth with a constant-time comparison against the STATE_TOKEN secret, optionally
//    scoped per stage (a preview/dev token can't read or write prod state; parseStateGrants)
//  - a single SQLite Durable Object serializes every write (single writer per account)
//  - values encrypted at rest with AES-GCM (STATE_ENCRYPTION_KEY, versioned for rotation)
//  - daily encrypted snapshot to a private R2 bucket via DO alarm (restore: RUNBOOK.md)

// Imported by relative path (dependency-free file) so it is part of STATE_WORKER_SOURCES and the
// build hash still identifies every byte of auth logic the deployed Worker runs.
import { bearerMatches, timingSafeEqual } from "../../packages/domain/src/bytes.ts";

/** Contract version reported by `/version`; must equal alchemy's StateApi STATE_STORE_VERSION. */
export const STATE_CONTRACT_VERSION = 5;

export const BACKUP_INTERVAL_MS = 24 * 3600 * 1000;
export const BACKUP_RETENTION = 30;
const MAX_BODY_BYTES = 8 * 1024 * 1024;

export interface SqlCursor {
  toArray(): Array<Record<string, unknown>>;
}

export interface StateStorage {
  readonly sql: { exec(query: string, ...bindings: Array<unknown>): SqlCursor };
  transactionSync<T>(fn: () => T): T;
  getAlarm(): Promise<number | null>;
  setAlarm(at: number): Promise<void>;
}

export interface BackupBucket {
  put(key: string, value: string): Promise<unknown>;
  get?(key: string): Promise<{ text(): Promise<string> } | null>;
  list(options: { prefix: string }): Promise<{ objects: ReadonlyArray<{ key: string }> }>;
  delete(keys: string | Array<string>): Promise<unknown>;
}

export interface StateEnv {
  /**
   * Bearer grants (see `parseStateGrants`): one bare token for every stage, or per-stage tokens
   * such as `prod=<t1>,staging=<t2>,preview-*|dev-*=<t3>` so a nonprod token can't touch prod.
   */
  readonly STATE_TOKEN: string;
  /** `v<n>:<64 hex chars>`, comma-separated; the first entry encrypts, all decrypt. */
  readonly STATE_ENCRYPTION_KEY: string;
  readonly STATE: { getByName(name: string): { fetch(request: Request): Promise<Response> } };
  readonly BACKUPS?: BackupBucket;
  /**
   * Separate operator secret for `/state/admin/*` (snapshot now, restore). Absent → admin routes
   * are disabled. Never the same value as STATE_TOKEN, and never given to CI deploy jobs.
   */
  readonly STATE_ADMIN_TOKEN?: string;
  /** SHA-256 of the reviewed state-Worker source (infra/state/build-hash.ts), bound at deploy. */
  readonly STATE_BUILD_HASH?: string;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

interface Key {
  readonly version: string;
  readonly key: CryptoKey;
}

const hexBytes = (hex: string): Uint8Array<ArrayBuffer> => {
  if (!/^[0-9a-f]{64}$/i.test(hex))
    throw new Error("STATE_ENCRYPTION_KEY entries must be 32-byte hex");
  const out = new Uint8Array(new ArrayBuffer(32));
  for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
};

export const importKeys = async (spec: string): Promise<ReadonlyArray<Key>> =>
  Promise.all(
    spec
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map(async (entry) => {
        const [version, hex] = entry.split(":");
        if (!version || !hex)
          throw new Error("STATE_ENCRYPTION_KEY entries must look like v1:<hex>");
        return {
          version,
          key: await crypto.subtle.importKey("raw", hexBytes(hex), "AES-GCM", false, [
            "encrypt",
            "decrypt",
          ]),
        };
      }),
  );

const b64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));
const unb64 = (s: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(atob(s), (c) => c.charCodeAt(0)) as Uint8Array<ArrayBuffer>;

/** Frame: `<version>.<iv b64>.<ciphertext b64>`; associated data binds the ciphertext to its key. */
export const seal = async (
  keys: ReadonlyArray<Key>,
  aad: string,
  plaintext: string,
): Promise<string> => {
  const k = keys[0];
  if (!k) throw new Error("no encryption key");
  const iv = crypto.getRandomValues(new Uint8Array(new ArrayBuffer(12)));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: enc.encode(aad) },
      k.key,
      enc.encode(plaintext),
    ),
  );
  return `${k.version}.${b64(iv)}.${b64(ct)}`;
};

export const open = async (
  keys: ReadonlyArray<Key>,
  aad: string,
  framed: string,
): Promise<string> => {
  const [version, iv, ct] = framed.split(".");
  const k = keys.find((x) => x.version === version);
  if (!k || !iv || !ct) throw new Error("undecryptable state entry");
  return dec.decode(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: unb64(iv), additionalData: enc.encode(aad) },
      k.key,
      unb64(ct),
    ),
  );
};

const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

const noContent = () => new Response(null, { status: 204 });

/** An absent value: alchemy's reference server answers `undefined` with 200 and an empty body. */
const absent = () => new Response(null, { status: 200, headers: { "cache-control": "no-store" } });

const log = (op: string, status: number) => console.log(JSON.stringify({ op, status }));

/**
 * Durable Object holding all deployment state for this account. Every request is handled inside
 * one object, so writes are serialized without a separate lock (the protocol has none).
 */
export class StateStoreObject {
  private keys: Promise<ReadonlyArray<Key>> | null = null;

  constructor(
    private readonly state: {
      readonly storage: StateStorage;
      blockConcurrencyWhile?<T>(fn: () => Promise<T>): Promise<T>;
    },
    private readonly env: Pick<StateEnv, "STATE_ENCRYPTION_KEY" | "BACKUPS">,
  ) {
    this.state.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS entries (
        stack TEXT NOT NULL, stage TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('r', 'o')),
        fqn TEXT NOT NULL, value TEXT NOT NULL, updated_at INTEGER NOT NULL,
        PRIMARY KEY (stack, stage, kind, fqn))`,
    );
    this.state.storage.sql.exec("CREATE TABLE IF NOT EXISTS stacks (stack TEXT PRIMARY KEY)");
    // Deployment writer lease (§15.6 "serialize deployments"). Alchemy's HTTP state protocol has
    // no lock, so CI acquires this lease around plan+deploy for each stack/stage.
    this.state.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS locks (stack TEXT NOT NULL, stage TEXT NOT NULL, holder TEXT NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY (stack, stage))",
    );
  }

  /** Acquire or renew a lease. Returns the current holder when someone else holds an unexpired lease. */
  acquireLock(
    stack: string,
    stage: string,
    holder: string,
    ttlMs: number,
    now = Date.now(),
  ): { readonly ok: boolean; readonly holder: string; readonly expiresAt: number } {
    return this.state.storage.transactionSync(() => {
      const current = this.rows<{ holder: string; expires_at: number }>(
        "SELECT holder, expires_at FROM locks WHERE stack = ? AND stage = ?",
        stack,
        stage,
      )[0];
      if (current && current.holder !== holder && Number(current.expires_at) > now) {
        return { ok: false, holder: current.holder, expiresAt: Number(current.expires_at) };
      }
      const expiresAt = now + Math.min(Math.max(ttlMs, 1_000), 6 * 3600_000);
      this.state.storage.sql.exec(
        "INSERT INTO locks (stack, stage, holder, expires_at) VALUES (?, ?, ?, ?) ON CONFLICT (stack, stage) DO UPDATE SET holder = excluded.holder, expires_at = excluded.expires_at",
        stack,
        stage,
        holder,
        expiresAt,
      );
      return { ok: true, holder, expiresAt };
    });
  }

  /** Release only when held by `holder`; a stale holder can never release someone else's lease. */
  releaseLock(stack: string, stage: string, holder: string): boolean {
    return this.state.storage.transactionSync(() => {
      const current = this.rows<{ holder: string }>(
        "SELECT holder FROM locks WHERE stack = ? AND stage = ?",
        stack,
        stage,
      )[0];
      if (!current || current.holder !== holder) return false;
      this.state.storage.sql.exec("DELETE FROM locks WHERE stack = ? AND stage = ?", stack, stage);
      return true;
    });
  }

  private rows<T>(query: string, ...bindings: Array<unknown>): Array<T> {
    return this.state.storage.sql.exec(query, ...bindings).toArray() as Array<T>;
  }

  private resourceFqns(stack: string, stage: string): Array<string> {
    return this.rows<{ fqn: string }>(
      "SELECT fqn FROM entries WHERE stack = ? AND stage = ? AND kind = 'r' ORDER BY fqn",
      stack,
      stage,
    ).map((r) => r.fqn);
  }

  private cryptoKeys() {
    return (this.keys ??= importKeys(this.env.STATE_ENCRYPTION_KEY));
  }

  private aad = (stack: string, stage: string, kind: string, fqn: string) =>
    `${stack}\u0000${stage}\u0000${kind}\u0000${fqn}`;

  private async read(stack: string, stage: string, kind: "r" | "o", fqn: string): Promise<unknown> {
    const row = this.rows<{ value: string }>(
      "SELECT value FROM entries WHERE stack = ? AND stage = ? AND kind = ? AND fqn = ?",
      stack,
      stage,
      kind,
      fqn,
    )[0];
    return row
      ? JSON.parse(
          await open(await this.cryptoKeys(), this.aad(stack, stage, kind, fqn), row.value),
        )
      : undefined;
  }

  private async write(
    stack: string,
    stage: string,
    kind: "r" | "o",
    fqn: string,
    value: unknown,
  ): Promise<void> {
    const sealed = await seal(
      await this.cryptoKeys(),
      this.aad(stack, stage, kind, fqn),
      JSON.stringify(value),
    );
    this.state.storage.transactionSync(() => {
      this.state.storage.sql.exec(
        "INSERT INTO entries (stack, stage, kind, fqn, value, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (stack, stage, kind, fqn) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        stack,
        stage,
        kind,
        fqn,
        sealed,
        Date.now(),
      );
      this.state.storage.sql.exec("INSERT OR IGNORE INTO stacks (stack) VALUES (?)", stack);
    });
    await this.ensureBackupAlarm();
  }

  private async ensureBackupAlarm(): Promise<void> {
    if (!this.env.BACKUPS) return;
    if ((await this.state.storage.getAlarm()) === null)
      await this.state.storage.setAlarm(Date.now() + BACKUP_INTERVAL_MS);
  }

  /** Encrypted snapshot to a private bucket; entries stay sealed, so the bucket never holds plaintext. */
  async alarm(): Promise<void> {
    await this.snapshot();
    if (this.env.BACKUPS) await this.state.storage.setAlarm(Date.now() + BACKUP_INTERVAL_MS);
  }

  /** Write one snapshot now; returns its key. Used by the alarm and the operator drill. */
  async snapshot(): Promise<string | null> {
    const bucket = this.env.BACKUPS;
    if (!bucket) return null;
    const snapshot = {
      contract: STATE_CONTRACT_VERSION,
      at: Date.now(),
      stacks: this.rows<{ stack: string }>("SELECT stack FROM stacks ORDER BY stack").map(
        (r) => r.stack,
      ),
      entries: this.rows(
        "SELECT stack, stage, kind, fqn, value, updated_at FROM entries ORDER BY stack, stage, kind, fqn",
      ),
    };
    const key = `snapshots/${new Date(snapshot.at).toISOString()}.json`;
    await bucket.put(key, JSON.stringify(snapshot));
    const existing = (await bucket.list({ prefix: "snapshots/" })).objects.map((o) => o.key).sort();
    const expired = existing.slice(0, Math.max(0, existing.length - BACKUP_RETENTION));
    if (expired.length) await bucket.delete(expired);
    return key;
  }

  /** Restore from a snapshot produced by `alarm()` (operator path; see RUNBOOK). */
  restore(snapshot: {
    entries: ReadonlyArray<{
      stack: string;
      stage: string;
      kind: string;
      fqn: string;
      value: string;
      updated_at: number;
    }>;
    stacks: ReadonlyArray<string>;
  }): number {
    return this.state.storage.transactionSync(() => {
      this.state.storage.sql.exec("DELETE FROM entries");
      this.state.storage.sql.exec("DELETE FROM stacks");
      for (const e of snapshot.entries) {
        this.state.storage.sql.exec(
          "INSERT INTO entries (stack, stage, kind, fqn, value, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
          e.stack,
          e.stage,
          e.kind,
          e.fqn,
          e.value,
          e.updated_at,
        );
      }
      for (const s of snapshot.stacks)
        this.state.storage.sql.exec("INSERT INTO stacks (stack) VALUES (?)", s);
      return snapshot.entries.length;
    });
  }

  async fetch(request: Request): Promise<Response> {
    try {
      return await this.handle(request);
    } catch (error) {
      // Errors are mapped here: exceptions lose their class across the DO boundary.
      const status =
        error instanceof BodyTooLarge
          ? 413
          : error instanceof SyntaxError || error instanceof URIError
            ? 400
            : 500;
      return json({ _tag: status === 500 ? "InternalServerError" : "BadRequest" }, status);
    }
  }

  private async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const parts = pathSegments(url.pathname);
    const method = request.method;
    // /state/admin/{snapshot,restore} — operator-only (checked in the Worker entry with STATE_ADMIN_TOKEN).
    if (parts[0] === "state" && parts[1] === "admin" && parts.length === 3 && method === "POST") {
      if (parts[2] === "snapshot") return json({ key: await this.snapshot() });
      if (parts[2] === "restore") {
        const body = (await readBody(request)) as { key?: unknown };
        const bucket = this.env.BACKUPS;
        if (typeof body.key !== "string" || !body.key.startsWith("snapshots/") || !bucket?.get)
          return json({ _tag: "BadRequest" }, 400);
        const object = await bucket.get(body.key);
        if (!object) return json({ _tag: "NotFound" }, 404);
        const snapshot = JSON.parse(await object.text()) as {
          contract: number;
          entries: Parameters<StateStoreObject["restore"]>[0]["entries"];
          stacks: ReadonlyArray<string>;
        };
        if (snapshot.contract !== STATE_CONTRACT_VERSION)
          return json({ _tag: "ContractMismatch", contract: snapshot.contract }, 409);
        return json({ restored: this.restore(snapshot) });
      }
    }
    // /state/locks/:stack/:stage — writer lease (not part of alchemy's protocol; used by CI).
    if (parts[0] === "state" && parts[1] === "locks" && parts.length === 4) {
      const [, , lockStack, lockStage] = parts as [string, string, string, string];
      if (method === "POST") {
        const body = (await readBody(request)) as { holder?: unknown; ttlMs?: unknown };
        if (typeof body.holder !== "string" || body.holder.length === 0 || body.holder.length > 200)
          return json({ _tag: "BadRequest" }, 400);
        const result = this.acquireLock(
          lockStack,
          lockStage,
          body.holder,
          typeof body.ttlMs === "number" ? body.ttlMs : 30 * 60_000,
        );
        return json(result, result.ok ? 200 : 409);
      }
      if (method === "DELETE") {
        const released = this.releaseLock(
          lockStack,
          lockStage,
          url.searchParams.get("holder") ?? "",
        );
        return released ? noContent() : json({ _tag: "NotHolder" }, 409);
      }
    }
    // /state/stacks[/:stack[/stages[/:stage[/resources[/:fqn]|/replaced-resources|/output]]]]
    if (parts[0] !== "state" || parts[1] !== "stacks") return json({ _tag: "NotFound" }, 404);
    const [, , stack, s3, stage, s5, fqnParam] = parts;

    if (parts.length === 2 && method === "GET")
      return json(
        this.rows<{ stack: string }>("SELECT stack FROM stacks ORDER BY stack").map((r) => r.stack),
      );
    if (stack === undefined) return json({ _tag: "NotFound" }, 404);

    if (parts.length === 3 && method === "DELETE") {
      const only = url.searchParams.get("stage");
      this.state.storage.transactionSync(() => {
        if (only === null) {
          this.state.storage.sql.exec("DELETE FROM entries WHERE stack = ?", stack);
          this.state.storage.sql.exec("DELETE FROM stacks WHERE stack = ?", stack);
        } else {
          this.state.storage.sql.exec(
            "DELETE FROM entries WHERE stack = ? AND stage = ?",
            stack,
            only,
          );
        }
      });
      return noContent();
    }
    if (s3 !== "stages") return json({ _tag: "NotFound" }, 404);
    if (parts.length === 4 && method === "GET") {
      return json(
        this.rows<{ stage: string }>(
          "SELECT DISTINCT stage FROM entries WHERE stack = ? AND kind = 'r' ORDER BY stage",
          stack,
        ).map((r) => r.stage),
      );
    }
    if (stage === undefined) return json({ _tag: "NotFound" }, 404);

    if (parts.length === 6 && s5 === "resources" && method === "GET") {
      return json(this.resourceFqns(stack, stage));
    }
    if (parts.length === 6 && s5 === "replaced-resources" && method === "GET") {
      const out: Array<unknown> = [];
      for (const fqn of this.resourceFqns(stack, stage)) {
        const value = (await this.read(stack, stage, "r", fqn)) as { status?: string } | undefined;
        if (value?.status === "replaced") out.push(value);
      }
      return json(out);
    }
    if (parts.length === 6 && s5 === "output") {
      if (method === "GET") {
        const value = await this.read(stack, stage, "o", "");
        return value === undefined ? absent() : json(value);
      }
      if (method === "PUT") {
        const value = await readBody(request);
        await this.write(stack, stage, "o", "", value);
        return json(value);
      }
    }
    if (parts.length === 7 && s5 === "resources" && fqnParam !== undefined) {
      // The client URI-encodes the FQN before placing it in the path; decode that layer too.
      const fqn = decodeURIComponent(fqnParam);
      if (method === "GET") {
        const value = await this.read(stack, stage, "r", fqn);
        return value === undefined ? absent() : json(value);
      }
      if (method === "PUT") {
        const value = await readBody(request);
        await this.write(stack, stage, "r", fqn, value);
        return json(value);
      }
      if (method === "DELETE") {
        this.state.storage.sql.exec(
          "DELETE FROM entries WHERE stack = ? AND stage = ? AND kind = 'r' AND fqn = ?",
          stack,
          stage,
          fqn,
        );
        return noContent();
      }
    }
    return json({ _tag: "NotFound" }, 404);
  }
}

class BodyTooLarge extends Error {}

/** Canonical route segments: empty segments dropped, each percent-decoded (throws URIError). */
const pathSegments = (pathname: string): Array<string> =>
  pathname
    .split("/")
    .filter(Boolean)
    .map((p) => decodeURIComponent(p));

const readBody = async (request: Request): Promise<unknown> => {
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) throw new BodyTooLarge();
  return JSON.parse(text);
};

/** A bearer grant; `stages` null = every stage (a single-token or operator deployment). */
export interface StateGrant {
  readonly token: string;
  readonly stages: ReadonlyArray<string> | null;
}

const SCOPED_GRANT = /^([a-z0-9*|-]+)=([^=]{16,})$/;

/**
 * STATE_TOKEN grammar: comma-separated grants. A bare `<token>` reaches every stage (the legacy
 * single-token form). `<patterns>=<token>` reaches only the listed stages; patterns are
 * `|`-separated exact stage names or `prefix*`. Example:
 * `prod=<t1>,staging=<t2>,preview-*|dev-*=<t3>`. Tokens never contain `,` (base64url keys from
 * `pnpm generate:key` do not); a bare base64 token with `=` padding stays a bare token.
 */
export const parseStateGrants = (spec: string): ReadonlyArray<StateGrant> =>
  spec
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const m = SCOPED_GRANT.exec(entry);
      return m
        ? { token: m[2]!, stages: m[1]!.split("|").filter(Boolean) }
        : { token: entry, stages: null };
    });

export const stageAllowed = (grant: StateGrant, stage: string): boolean =>
  grant.stages === null ||
  grant.stages.some((p) => (p.endsWith("*") ? stage.startsWith(p.slice(0, -1)) : p === stage));

/**
 * The stage a request touches: a name, `list` for stack/stage name listings (names only, any
 * grant), or `all` for whole-stack or unknown operations (unscoped grants only).
 */
export const requestScope = (
  segments: ReadonlyArray<string>,
  method: string,
  url: URL,
): { readonly stage: string } | "list" | "all" => {
  const [, kind, stack, s3, stage] = segments;
  // /state/locks/:stack/:stage
  if (kind === "locks") return segments.length === 4 && s3 !== undefined ? { stage: s3 } : "all";
  if (kind !== "stacks") return "all";
  if (segments.length === 2 && method === "GET") return "list";
  if (stack === undefined) return "all";
  if (segments.length === 3) {
    const only = url.searchParams.get("stage");
    return method === "DELETE" && only !== null ? { stage: only } : "all";
  }
  if (s3 !== "stages") return "all";
  if (segments.length === 4 && method === "GET") return "list";
  return stage === undefined ? "all" : { stage };
};

/** Worker entry: version probe is public; everything under /state requires the bearer token. */
export const handleStateRequest = async (request: Request, env: StateEnv): Promise<Response> => {
  const url = new URL(request.url);
  if (url.pathname === "/version" && request.method === "GET")
    return json({ version: STATE_CONTRACT_VERSION, build: env.STATE_BUILD_HASH ?? null });
  if (!url.pathname.startsWith("/state/")) return json({ _tag: "NotFound" }, 404);
  const authorization = request.headers.get("authorization");
  // Compare against every grant (no early exit), so timing does not reveal which one matched.
  let grant: StateGrant | undefined;
  for (const g of parseStateGrants(env.STATE_TOKEN ?? ""))
    if (bearerMatches(authorization, g.token) && grant === undefined) grant = g;
  if (grant === undefined) {
    log("auth", 401);
    return new Response(null, { status: 401 });
  }
  // Authorize on the same canonical segments the Durable Object routes on:
  // `/state//admin/…` and `/state/%61dmin/…` are admin routes too.
  let segments: Array<string>;
  try {
    segments = pathSegments(url.pathname);
  } catch {
    return json({ _tag: "BadRequest" }, 400);
  }
  const scope = requestScope(segments, request.method, url);
  if (
    grant.stages !== null &&
    scope !== "list" &&
    (scope === "all" || !stageAllowed(grant, scope.stage))
  ) {
    log("scope", 403);
    return new Response(null, { status: 403 });
  }
  if (segments[1]?.toLowerCase() === "admin") {
    const admin = request.headers.get("x-bye-admin-token") ?? "";
    if (!env.STATE_ADMIN_TOKEN || !admin || !timingSafeEqual(admin, env.STATE_ADMIN_TOKEN.trim())) {
      log("admin", 403);
      return new Response(null, { status: 403 });
    }
  }
  const response = await env.STATE.getByName("state").fetch(request);
  log(request.method, response.status);
  return response;
};
