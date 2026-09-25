import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ControlAuth, ControlDirectory } from "@bye/platform-cloudflare";
import { handleFetch } from "../src/api.ts";
import { kernelClock } from "../src/durable-host.ts";
import {
  eraseCalendarContent,
  eraseUserRows,
  reseedTombstones,
  startErasure,
  TOMBSTONE_LEDGER_PREFIX,
  writeTombstone,
} from "../src/erasure.ts";
import { AUDIT_RETENTION_DAYS, PRUNE_PAGE, pruneLedgers } from "../src/scheduled.ts";
import { authConfig } from "../src/services.ts";
import { type Harness, installWebSocketPair, makeHarness } from "./harness.ts";

// Erasure row/credential cleanup, tombstone ledger reseeding, daily ledger retention (§12) and
// credential-scoped live socket closing (§8) over the in-memory bindings.

const ctx = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
} as unknown as ExecutionContext;
const DAY = 24 * 3600_000;

const account = async (h: Harness, address: string) => {
  const a = await new ControlDirectory(h.env.DIRECTORY, kernelClock).provisionPersonalAccount({
    address,
    displayName: address.split("@")[0]!,
  });
  const auth = new ControlAuth(h.env.DIRECTORY, kernelClock, await authConfig(h.env));
  const session = await auth.issueSession(a.userId, "laptop", true);
  const token = await auth.createApiToken(a.userId, { kind: "cli", label: "cli" });
  return { ...a, session: session.token, apiToken: token.token };
};

const get = async (h: Harness, path: string, headers: Record<string, string>) =>
  (await handleFetch(new Request(`${h.env.APP_ORIGIN}${path}`, { headers }), h.env, ctx)).status;

const count = async (h: Harness, sql: string, ...binds: Array<unknown>) =>
  (await h.d1
    .prepare(sql)
    .bind(...binds)
    .first<{ n: number }>())!.n;

describe("erasure", () => {
  let h: Harness;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2026, 8, 25, 12));
    h = makeHarness();
  });
  afterEach(() => vi.useRealTimers());

  it("[§12] eraseUserRows revokes every credential, deletes passkeys and push devices, and purges exports", async () => {
    const ana = await account(h, "ana@bye.test");
    const bob = await account(h, "bob@bye.test");
    for (const u of [ana, bob]) {
      await h.d1
        .prepare(
          "INSERT INTO passkeys (credential_id, user_id, public_key_jwk, created_at) VALUES (?, ?, '{}', ?)",
        )
        .bind(`pk_${u.userId}`, u.userId, Date.now())
        .run();
      await h.d1
        .prepare(
          "INSERT INTO push_devices (id, user_id, kind, endpoint, created_at) VALUES (?, ?, 'webpush', ?, ?)",
        )
        .bind(`pd_${u.userId}`, u.userId, `https://push.example/${u.userId}`, Date.now())
        .run();
      await h.buckets.EXPORTS.put(`t/${u.userId}/export/e1/all.mbox`, "mbox");
    }
    const cookie = (u: typeof ana) => ({ cookie: `__Host-session=${u.session}` });
    const bearer = (u: typeof ana) => ({ authorization: `Bearer ${u.apiToken}` });
    expect(await get(h, "/v1/security/sessions", cookie(ana))).toBe(200);
    expect(await get(h, `/v1/mailboxes/${ana.mailboxId}/views/imbox`, bearer(ana))).toBe(200);

    await eraseUserRows(h.env, ana.userId);

    // Sessions and API tokens stop authenticating; the rows record the revocation.
    expect(await get(h, "/v1/security/sessions", cookie(ana))).toBe(401);
    expect(await get(h, `/v1/mailboxes/${ana.mailboxId}/views/imbox`, bearer(ana))).toBe(401);
    expect(
      await count(
        h,
        "SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND revoked_at IS NULL",
        ana.userId,
      ),
    ).toBe(0);
    expect(
      await count(
        h,
        "SELECT COUNT(*) AS n FROM api_tokens WHERE user_id = ? AND revoked_at IS NULL",
        ana.userId,
      ),
    ).toBe(0);
    expect(await count(h, "SELECT COUNT(*) AS n FROM passkeys WHERE user_id = ?", ana.userId)).toBe(
      0,
    );
    expect(
      await count(h, "SELECT COUNT(*) AS n FROM push_devices WHERE user_id = ?", ana.userId),
    ).toBe(0);
    expect(h.buckets.EXPORTS.objects.has(`t/${ana.userId}/export/e1/all.mbox`)).toBe(false);

    // Another user's credentials, devices and exports are untouched.
    expect(await get(h, "/v1/security/sessions", cookie(bob))).toBe(200);
    expect(await get(h, `/v1/mailboxes/${bob.mailboxId}/views/imbox`, bearer(bob))).toBe(200);
    expect(await count(h, "SELECT COUNT(*) AS n FROM passkeys WHERE user_id = ?", bob.userId)).toBe(
      1,
    );
    expect(
      await count(h, "SELECT COUNT(*) AS n FROM push_devices WHERE user_id = ?", bob.userId),
    ).toBe(1);
    expect(h.buckets.EXPORTS.objects.has(`t/${bob.userId}/export/e1/all.mbox`)).toBe(true);
  });

  it("[§12] startErasure is idempotent per user: a second start reuses the one workflow instance", async () => {
    const ana = await account(h, "ana@bye.test");
    const first = await startErasure(h.env, ana.userId, "closure");
    const second = await startErasure(h.env, ana.userId, "operator");
    expect(second.instanceId).toBe(first.instanceId);
    expect(h.workflows.ERASE_ACCOUNT?.map((w) => w.id)).toEqual([`erase-${ana.userId}`]);
    // Only the "already exists" failure is tolerated; any other create failure propagates.
    (h.env as { ERASE_ACCOUNT: unknown }).ERASE_ACCOUNT = {
      create: async () => {
        throw new Error("workflows unavailable");
      },
    };
    await expect(startErasure(h.env, ana.userId, "again")).rejects.toThrow(/unavailable/);
  });

  it("[§12] reseedTombstones restores D1 tombstones from the R2 ledger across list pages", async () => {
    await writeTombstone(h.env, "user", "usr_a", Date.now() - DAY);
    await writeTombstone(h.env, "space-member", "spc_1:usr_a", Date.now() - DAY);
    // More ledger entries than one list page (1000) so the key cursor is followed.
    for (let i = 0; i < 1001; i++)
      await h.buckets.ORIGINALS.put(
        `${TOMBSTONE_LEDGER_PREFIX}mailbox/${encodeURIComponent(`mbx_${String(i).padStart(4, "0")}`)}`,
        "{}",
      );
    // A D1 restore to before the erasure lost every row.
    await h.d1.prepare("DELETE FROM erasure_tombstones").run();
    expect(await reseedTombstones(h.env)).toBe(1003);
    expect(await count(h, "SELECT COUNT(*) AS n FROM erasure_tombstones")).toBe(1003);
    const row = await h.d1
      .prepare(
        "SELECT resource_id, erased_at FROM erasure_tombstones WHERE resource_kind = 'space-member'",
      )
      .first<{ resource_id: string; erased_at: number }>();
    // IDs are decoded from the key; erased_at comes from the ledger object's upload time.
    expect(row).toEqual({ resource_id: "spc_1:usr_a", erased_at: Date.now() });
    // Idempotent: nothing new on a second pass.
    expect(await reseedTombstones(h.env)).toBe(0);
  });

  it("[§12] eraseCalendarContent erases the calendar authority, its config and its live sockets", async () => {
    const ana = await account(h, "ana@bye.test");
    const calendar = h.env.CALENDARS.getByName(ana.calendarId);
    await calendar.provision({
      ownerId: ana.userId,
      selfAddresses: ["ana@bye.test"],
      defaultZone: "UTC",
    });
    expect(await calendar.mayObserve(ana.userId)).toBe(true);
    const ws = installWebSocketPair();
    try {
      const instance = h.namespaces.CALENDARS.instance(ana.calendarId);
      await instance.fetch(
        new Request("https://do/live", {
          headers: { upgrade: "websocket", "x-bye-credential": "ses_1" },
        }),
      );
      expect(await eraseCalendarContent(h.env, ana.calendarId)).toBe(true);
      expect(ws.created[0]!.closed).toEqual({ code: 4401, reason: "session revoked" });
      // Unprovisioned afterwards: no access, no live endpoint, no stored tables or config.
      expect(await calendar.mayObserve(ana.userId)).toBe(false);
      expect((await instance.fetch(new Request("https://do/live"))).status).toBe(404);
      const state = h.namespaces.CALENDARS.state(ana.calendarId);
      expect(state.storage.kv.get("config")).toBeUndefined();
      expect(
        state.storage.db
          .prepare(
            "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
          )
          .get(),
      ).toEqual({ n: 0 });
    } finally {
      ws.restore();
    }
  });
});

describe("daily ledger pruning", () => {
  let h: Harness;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2026, 8, 25, 12));
    h = makeHarness();
  });
  afterEach(() => vi.useRealTimers());

  it("[§12] pruneLedgers drops rows past each retention window and keeps held, unmapped and pending rows", async () => {
    const now = Date.now();
    const ana = await account(h, "ana@bye.test");
    const run = (sql: string, ...binds: Array<unknown>) =>
      h.d1
        .prepare(sql)
        .bind(...binds)
        .run();
    // push_deliveries: 30 days.
    for (const [key, age] of [
      ["old", 31],
      ["new", 29],
    ] as const)
      await run(
        "INSERT INTO push_deliveries (dedupe_key, device_id, delivered_at) VALUES (?, 'd', ?)",
        key,
        now - age * DAY,
      );
    // dead_letters: resolved ones after 90 days; held ones are kept however old.
    for (const [id, state, age] of [
      ["dl_old", "replayed", 91],
      ["dl_new", "discarded", 89],
      ["dl_held", "held", 400],
    ] as const)
      await run(
        "INSERT INTO dead_letters (id, queue, message_type, body, attempts, received_at, state, resolved_at) VALUES (?, 'q', 't', '{}', 1, ?, ?, ?)",
        id,
        now - age * DAY,
        state,
        state === "held" ? null : now - age * DAY,
      );
    // blob_gc_intents: deleted ones after 30 days; retained/pending kept.
    for (const [key, state, age] of [
      ["gc_old", "deleted", 31],
      ["gc_new", "deleted", 29],
      ["gc_pending", "pending", 400],
    ] as const)
      await run(
        "INSERT INTO blob_gc_intents (bucket, object_key, owner_kind, owner_id, reason, requested_at, not_before, state, checked_at) VALUES ('PARTS', ?, 'mailbox', 'm', 'r', 0, 0, ?, ?)",
        key,
        state,
        now - age * DAY,
      );
    // send_unknowns: resolved ones after 90 days; unresolved kept.
    for (const [id, resolved] of [
      ["su_old", now - 91 * DAY],
      ["su_new", now - 89 * DAY],
      ["su_open", null],
    ] as const)
      await run(
        "INSERT INTO send_unknowns (mailbox_id, send_job_id, transport, first_seen_at, resolved_at) VALUES ('m', ?, 't', 0, ?)",
        id,
        resolved,
      );
    // oauth_codes: one day past expiry.
    for (const [hash, expires] of [
      ["oc_old", now - 2 * DAY],
      ["oc_new", now - DAY / 2],
    ] as const)
      await run(
        "INSERT INTO oauth_codes (code_hash, user_id, client_id, redirect_uri, code_challenge, created_at, expires_at) VALUES (?, ?, 'c', 'r', 'x', 0, ?)",
        hash,
        ana.userId,
        expires,
      );
    // newsletter_events: applied after 90 days; unmapped/received kept for review.
    for (const [id, state, age] of [
      ["ne_old", "applied", 91],
      ["ne_new", "applied", 89],
      ["ne_unmapped", "unmapped", 400],
      ["ne_received", "received", 400],
    ] as const)
      await run(
        "INSERT INTO newsletter_events (provider, account, event_id, kind, raw_type, occurred_at, received_at, state) VALUES ('p', 'a', ?, 'k', 'r', 0, ?, ?)",
        id,
        now - age * DAY,
        state,
      );
    // shared_propagation: finished ones after 30 days; pending kept.
    for (const [key, state, age] of [
      ["sp_old", "applied", 31],
      ["sp_dropped", "dropped", 31],
      ["sp_new", "applied", 29],
      ["sp_pending", "pending", 400],
    ] as const)
      await run(
        "INSERT INTO shared_propagation (event_key, space_id, kind, mailbox_id, thread_id, delivery_id, state, created_at, updated_at) VALUES (?, 's', 'reply', 'm', 't', 'd', ?, 0, ?)",
        key,
        state,
        now - age * DAY,
      );

    await pruneLedgers(h.env, now);

    const keys = async (sql: string) =>
      (await h.d1.prepare(sql).all<{ k: string }>()).results.map((r) => r.k).sort();
    expect(await keys("SELECT dedupe_key AS k FROM push_deliveries")).toEqual(["new"]);
    expect(await keys("SELECT id AS k FROM dead_letters")).toEqual(["dl_held", "dl_new"]);
    expect(await keys("SELECT object_key AS k FROM blob_gc_intents")).toEqual([
      "gc_new",
      "gc_pending",
    ]);
    expect(await keys("SELECT send_job_id AS k FROM send_unknowns")).toEqual(["su_new", "su_open"]);
    expect(await keys("SELECT code_hash AS k FROM oauth_codes")).toEqual(["oc_new"]);
    expect(await keys("SELECT event_id AS k FROM newsletter_events")).toEqual([
      "ne_new",
      "ne_received",
      "ne_unmapped",
    ]);
    expect(await keys("SELECT event_key AS k FROM shared_propagation")).toEqual([
      "sp_new",
      "sp_pending",
    ]);
  });
});

describe("identity-table retention", () => {
  let h: Harness;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2026, 8, 25, 12));
    h = makeHarness();
  });
  afterEach(() => vi.useRealTimers());

  it("[§12] pruneLedgers bounds audit, challenges, sessions, device credentials and lockouts", async () => {
    const now = Date.now();
    const ana = await account(h, "ana@bye.test");
    const run = (sql: string, ...binds: Array<unknown>) =>
      h.d1
        .prepare(sql)
        .bind(...binds)
        .run();
    // More than one prune page of old audit rows, plus a recent one.
    for (let i = 0; i < PRUNE_PAGE + 5; i++)
      await run(
        "INSERT INTO audit_log (id, actor_id, action, target, created_at) VALUES (?, 'a', 'x', 't', ?)",
        `aud_old_${i}`,
        now - (AUDIT_RETENTION_DAYS + 1) * DAY,
      );
    await run(
      "INSERT INTO audit_log (id, actor_id, action, target, created_at) VALUES ('aud_new', 'a', 'x', 't', ?)",
      now - (AUDIT_RETENTION_DAYS - 1) * DAY,
    );
    for (const [id, expires] of [
      ["chl_old", now - 2 * DAY],
      ["chl_new", now],
    ] as const)
      await run(
        "INSERT INTO auth_challenges (id, purpose, challenge, expires_at) VALUES (?, 'authenticate', 'c', ?)",
        id,
        expires,
      );
    for (const [id, expires, revoked] of [
      ["ses_expired", now - 31 * DAY, null],
      ["ses_revoked", now + DAY, now - 31 * DAY],
      ["ses_recent_revoked", now + DAY, now - DAY],
    ] as const)
      await run(
        "INSERT INTO sessions (id, user_id, token_hash, created_at, last_seen_at, expires_at, revoked_at) VALUES (?, ?, ?, 0, 0, ?, ?)",
        id,
        ana.userId,
        `h_${id}`,
        expires,
        revoked,
      );
    for (const [id, absolute, revoked] of [
      ["dvs_dead", now - 31 * DAY, null],
      ["dvs_live", now + 90 * DAY, null],
    ] as const) {
      await run(
        "INSERT INTO device_sessions (id, user_id, client_id, created_at, last_used_at, idle_expires_at, absolute_expires_at, revoked_at) VALUES (?, ?, 'bye-desktop', 0, 0, ?, ?, ?)",
        id,
        ana.userId,
        absolute,
        absolute,
        revoked,
      );
      await run(
        "INSERT INTO device_refresh_tokens (token_hash, session_id, created_at, rotated_at) VALUES (?, ?, 0, 0)",
        `r_${id}`,
        id,
      );
      await run(
        "INSERT INTO device_access_tokens (token_hash, session_id, expires_at) VALUES (?, ?, ?)",
        `a_${id}`,
        id,
        absolute,
      );
    }
    await run(
      "INSERT INTO auth_lockouts (user_id, kind, failures, window_start, locked_until) VALUES (?, 'totp', 2, ?, NULL)",
      ana.userId,
      now - 2 * DAY,
    );

    await pruneLedgers(h.env, now);

    expect(await count(h, "SELECT COUNT(*) AS n FROM audit_log WHERE id LIKE 'aud_old_%'")).toBe(0);
    expect(await count(h, "SELECT COUNT(*) AS n FROM audit_log WHERE id = 'aud_new'")).toBe(1);
    expect(await count(h, "SELECT COUNT(*) AS n FROM auth_challenges")).toBe(1);
    expect(
      await count(
        h,
        "SELECT COUNT(*) AS n FROM sessions WHERE id IN ('ses_expired', 'ses_revoked')",
      ),
    ).toBe(0);
    expect(
      await count(h, "SELECT COUNT(*) AS n FROM sessions WHERE id = 'ses_recent_revoked'"),
    ).toBe(1);
    expect(await count(h, "SELECT COUNT(*) AS n FROM device_sessions WHERE id = 'dvs_dead'")).toBe(
      0,
    );
    expect(await count(h, "SELECT COUNT(*) AS n FROM device_sessions WHERE id = 'dvs_live'")).toBe(
      1,
    );
    expect(await count(h, "SELECT COUNT(*) AS n FROM device_refresh_tokens")).toBe(1);
    expect(await count(h, "SELECT COUNT(*) AS n FROM auth_lockouts")).toBe(0);
  });
});

describe("live socket credential tags", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });

  it("[DS09] closeSockets(credential) closes only that credential's sockets; no credential closes all", async () => {
    const ana = await account(h, "ana@bye.test");
    const calendar = h.env.CALENDARS.getByName(ana.calendarId);
    await calendar.provision({
      ownerId: ana.userId,
      selfAddresses: ["ana@bye.test"],
      defaultZone: "UTC",
    });
    const instance = h.namespaces.CALENDARS.instance(ana.calendarId);
    const ws = installWebSocketPair();
    try {
      for (const cred of ["ses_a", "ses_b", "ses_a", null])
        expect(
          (
            await instance.fetch(
              new Request("https://do/live", {
                headers: { upgrade: "websocket", ...(cred ? { "x-bye-credential": cred } : {}) },
              }),
            )
          ).status,
        ).toBe(200);
      const [a1, b, a2, untagged] = ws.created;
      const state = h.namespaces.CALENDARS.state(ana.calendarId);
      expect(state.getTags(a1!)).toEqual(["cred:ses_a"]);
      expect(state.getTags(untagged!)).toEqual([]);
      // Every socket received the current sequence on accept.
      expect(ws.created.every((s) => s.sent.length === 1)).toBe(true);

      expect(await calendar.closeSockets("ses_a")).toBe(2);
      expect([a1!.closed, a2!.closed]).toEqual([
        { code: 4401, reason: "session revoked" },
        { code: 4401, reason: "session revoked" },
      ]);
      expect([b!.closed, untagged!.closed]).toEqual([null, null]);
      // A credential with no sockets closes nothing (and never falls back to closing all).
      expect(await calendar.closeSockets("ses_unknown")).toBe(0);
      expect(b!.closed).toBeNull();

      // Without a credential every socket is closed; already-closed ones are tolerated.
      expect(await calendar.closeSockets()).toBeGreaterThanOrEqual(2);
      expect([b!.closed?.code, untagged!.closed?.code]).toEqual([4401, 4401]);
    } finally {
      ws.restore();
    }
  });
});
