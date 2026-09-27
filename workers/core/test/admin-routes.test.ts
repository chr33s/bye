import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ControlAuth, ControlDirectory, SendingPolicy } from "@bye/platform-cloudflare";
import { handleFetch } from "../src/api.ts";
import { kernelClock } from "../src/durable-host.ts";
import { authConfig } from "../src/services.ts";
import { type Harness, makeHarness } from "./harness.ts";

// Administration routes (admin.ts): platform operator tooling, account closure, team member
// administration, billing checkout/plan/cancel and customer-domain aliases — authorization first.

(globalThis as { FixedLengthStream?: unknown }).FixedLengthStream = class extends TransformStream {
  constructor(_length: number) {
    super();
  }
};

const ctx = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
} as unknown as ExecutionContext;

interface Account {
  readonly userId: string;
  readonly calendarId: string;
  readonly mailboxId: string;
  readonly organizationId: string;
  readonly address: string;
  readonly cookie: string;
}

type Caller = Account | { readonly headers: Record<string, string> };

const signup = async (h: Harness, address: string, steppedUp = true): Promise<Account> => {
  const account = await new ControlDirectory(h.env.DIRECTORY, kernelClock).provisionPersonalAccount(
    { address, displayName: address.split("@")[0]! },
  );
  const session = await new ControlAuth(
    h.env.DIRECTORY,
    kernelClock,
    await authConfig(h.env),
  ).issueSession(account.userId, "test", steppedUp);
  return { ...account, address, cookie: `__Host-session=${session.token}` };
};

/** A second, non-stepped-up cookie session for the same user. */
const plainSession = async (h: Harness, a: Account): Promise<Account> => {
  const session = await new ControlAuth(
    h.env.DIRECTORY,
    kernelClock,
    await authConfig(h.env),
  ).issueSession(a.userId, "plain", false);
  return { ...a, cookie: `__Host-session=${session.token}` };
};

/** A read-only agent bearer token for the same user. */
const readOnlyToken = async (h: Harness, a: Account): Promise<Caller> => {
  const token = await new ControlAuth(
    h.env.DIRECTORY,
    kernelClock,
    await authConfig(h.env),
  ).createApiToken(a.userId, { kind: "agent", label: "ro", scopes: ["read"] });
  return { headers: { authorization: `Bearer ${token.token}` } };
};

const call = async (h: Harness, a: Caller | null, method: string, path: string, json?: unknown) => {
  const response = await handleFetch(
    new Request(`${h.env.APP_ORIGIN}${path}`, {
      method,
      headers: {
        ...(a && "cookie" in a ? { cookie: a.cookie } : {}),
        ...(a && "headers" in a ? a.headers : {}),
        ...(method === "GET" ? {} : { origin: h.env.APP_ORIGIN }),
        ...(json !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
    }),
    h.env,
    ctx,
  );
  const text = await response.text();
  const type = response.headers.get("content-type") ?? "";
  return {
    status: response.status,
    text,
    body: type.includes("json") && text ? JSON.parse(text) : null,
  };
};

/** [status, error code, stepUp marker] — enough to prove WHICH check refused a request. */
const refusal = (r: { status: number; body: any }) => [
  r.status,
  r.body?.error?.code,
  r.body?.error?.details?.stepUp === true,
];

const count = async (h: Harness, sql: string, ...binds: Array<unknown>) =>
  (await h.d1
    .prepare(sql)
    .bind(...binds)
    .first<{ n: number }>())!.n;

describe("admin routes", () => {
  let h: Harness;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2026, 8, 25, 12));
    h = makeHarness();
  });
  afterEach(() => vi.useRealTimers());

  const operator = async () => {
    const op = await signup(h, "op@bye.test");
    (h.env as { OPERATOR_USER_IDS?: string }).OPERATOR_USER_IDS = op.userId;
    return op;
  };

  const signal = (id: string, scope: string, key: string) =>
    h.d1
      .prepare(
        "INSERT INTO sending_signals (id, scope, key, signal, detail, created_at) VALUES (?, ?, ?, 'bounce-rate', '{\"rate\":0.2}', ?)",
      )
      .bind(id, scope, key, Date.now())
      .run();

  describe("platform operator tooling", () => {
    it("[§10] every /v1/operator route refuses a non-operator, even with a fresh step-up", async () => {
      await operator();
      const ana = await signup(h, "ana@bye.test");
      await signal("sig_1", "user", ana.userId);
      for (const [method, path, json] of [
        ["GET", "/v1/operator/signals", undefined],
        ["POST", "/v1/operator/signals/sig_1/review", { resolution: "false-positive" }],
        ["POST", "/v1/operator/suspensions", { scope: "user", key: ana.userId, reason: "x" }],
        ["DELETE", `/v1/operator/suspensions/user/${ana.userId}`, undefined],
        ["POST", "/v1/operator/suppressions", { address: "victim@example.net" }],
        ["DELETE", "/v1/operator/suppressions/victim@example.net", undefined],
        ["POST", "/v1/operator/credits", { orgId: ana.organizationId, cents: 500 }],
        ["POST", "/v1/operator/support-sessions", { grantId: "sgr_1" }],
      ] as const) {
        const r = await call(h, ana, method, path, json);
        expect([method, path, ...refusal(r)]).toEqual([method, path, 403, "forbidden", false]);
      }
      // The signal was not reviewed by the refused call.
      expect(
        await count(h, "SELECT COUNT(*) AS n FROM sending_signals WHERE reviewed_at IS NULL"),
      ).toBe(1);
    });

    it("[§10] an operator's read-only token is refused (operator access needs the admin scope)", async () => {
      const op = await operator();
      const ro = await readOnlyToken(h, op);
      expect(refusal(await call(h, ro, "GET", "/v1/operator/signals"))).toEqual([
        403,
        "forbidden",
        false,
      ]);
    });

    it("[§10] every mutating operator route requires a fresh step-up", async () => {
      const op = await operator();
      const plain = await plainSession(h, op);
      const ana = await signup(h, "ana@bye.test");
      const policy = new SendingPolicy(h.env.DIRECTORY, kernelClock);
      await policy.suspend("user", ana.userId, "auto: bounce rate", "system");
      await policy.suspend("domain", "acme.test", "manual", op.userId);
      await signal("sig_1", "user", ana.userId);
      await h.d1
        .prepare(
          "INSERT INTO suppressions (address, reason, source, created_at) VALUES ('kept@example.net', 'manual', 'test', ?)",
        )
        .bind(Date.now())
        .run();
      for (const [method, path, json] of [
        ["POST", "/v1/operator/signals/sig_1/review", { resolution: "false-positive" }],
        ["POST", "/v1/operator/suspensions", { scope: "user", key: ana.userId, reason: "abuse" }],
        ["DELETE", "/v1/operator/suspensions/domain/acme.test", undefined],
        ["POST", "/v1/operator/suppressions", { address: "victim@example.net" }],
        ["DELETE", "/v1/operator/suppressions/kept@example.net", undefined],
        ["POST", "/v1/operator/credits", { orgId: ana.organizationId, cents: 500 }],
        ["POST", "/v1/operator/support-sessions", { grantId: "sgr_1" }],
      ] as const) {
        const r = await call(h, plain, method, path, json);
        expect([path, ...refusal(r)]).toEqual([path, 403, "forbidden", true]);
      }
      // Nothing was loosened or tightened: both suspensions and the suppression survive.
      expect(
        await count(h, "SELECT COUNT(*) AS n FROM sending_suspensions WHERE lifted_at IS NULL"),
      ).toBe(2);
      expect(await count(h, "SELECT COUNT(*) AS n FROM suppressions")).toBe(1);
    });

    it("[§10] operator happy paths: signals, review, suspend/lift, suppress/unsuppress, credits", async () => {
      const op = await operator();
      const ana = await signup(h, "ana@bye.test");
      await signal("sig_1", "user", ana.userId);
      const open = await call(h, op, "GET", "/v1/operator/signals");
      expect(open.status).toBe(200);
      expect(open.body.items).toEqual([
        expect.objectContaining({
          id: "sig_1",
          scope: "user",
          key: ana.userId,
          detail: { rate: 0.2 },
        }),
      ]);

      // Suspend, then a false-positive review lifts it and closes the signal.
      const suspended = await call(h, op, "POST", "/v1/operator/suspensions", {
        scope: "user",
        key: ana.userId,
        reason: "abuse review",
      });
      expect([suspended.status, suspended.body]).toEqual([201, { suspended: true }]);
      const active = () =>
        count(
          h,
          "SELECT COUNT(*) AS n FROM sending_suspensions WHERE scope = 'user' AND key = ? AND lifted_at IS NULL",
          ana.userId,
        );
      expect(await active()).toBe(1);
      expect(
        (
          await call(h, op, "POST", "/v1/operator/signals/sig_1/review", {
            resolution: "false-positive",
          })
        ).status,
      ).toBe(200);
      expect(await active()).toBe(0);
      expect((await call(h, op, "GET", "/v1/operator/signals")).body.items).toEqual([]);
      // A reviewed (or unknown) signal cannot be reviewed again.
      const again = await call(h, op, "POST", "/v1/operator/signals/sig_1/review", {
        resolution: "confirmed-abuse",
      });
      expect([again.status, again.body.error.code]).toEqual([404, "not_found"]);

      // Lift: true once, then false; an unknown scope is a 400.
      await call(h, op, "POST", "/v1/operator/suspensions", {
        scope: "domain",
        key: "acme.test",
        reason: "spam",
      });
      expect(
        (await call(h, op, "DELETE", "/v1/operator/suspensions/domain/acme.test")).body,
      ).toEqual({
        lifted: true,
      });
      expect(
        (await call(h, op, "DELETE", "/v1/operator/suspensions/domain/acme.test")).body,
      ).toEqual({
        lifted: false,
      });
      const badScope = await call(h, op, "DELETE", "/v1/operator/suspensions/galaxy/x");
      expect([badScope.status, badScope.body.error.code]).toEqual([400, "bad_request"]);

      // Suppress / unsuppress.
      expect(
        (await call(h, op, "POST", "/v1/operator/suppressions", { address: "Victim@Example.net" }))
          .status,
      ).toBe(201);
      expect(
        await count(
          h,
          "SELECT COUNT(*) AS n FROM suppressions WHERE address = 'victim@example.net'",
        ),
      ).toBe(1);
      expect(
        (await call(h, op, "DELETE", "/v1/operator/suppressions/victim@example.net")).body,
      ).toEqual({ removed: true });
      expect(
        (await call(h, op, "DELETE", "/v1/operator/suppressions/victim@example.net")).body,
      ).toEqual({ removed: false });

      // Credits land on the entitlement and in the ledger.
      await h.d1
        .prepare(
          "INSERT OR REPLACE INTO entitlements (org_id, plan, status, credits_cents, updated_at) VALUES (?, 'personal', 'active', 0, 0)",
        )
        .bind(ana.organizationId)
        .run();
      const credit = await call(h, op, "POST", "/v1/operator/credits", {
        orgId: ana.organizationId,
        cents: 750,
      });
      expect([credit.status, credit.body]).toEqual([201, { credited: true }]);
      expect(
        await count(
          h,
          "SELECT credits_cents AS n FROM entitlements WHERE org_id = ?",
          ana.organizationId,
        ),
      ).toBe(750);
      const zero = await call(h, op, "POST", "/v1/operator/credits", {
        orgId: ana.organizationId,
        cents: 0,
      });
      expect([zero.status, zero.body.error.code]).toEqual([400, "bad_request"]);
    });

    it("[§10] support sessions open only under the user's active grant", async () => {
      const op = await operator();
      const ana = await signup(h, "ana@bye.test");
      const grant = await call(h, ana, "POST", "/v1/support-access", {
        reason: "cannot see my mail",
        hours: 2,
      });
      expect(grant.status).toBe(201);
      const grantId = grant.body.id ?? grant.body.grantId;
      const opened = await call(h, op, "POST", "/v1/operator/support-sessions", { grantId });
      expect(opened.status).toBe(201);
      expect(opened.body).toMatchObject({ userId: ana.userId });
      expect(opened.body.token).toEqual(expect.any(String));
      expect(opened.body.expiresAt).toBeLessThanOrEqual(Date.now() + 2 * 3600_000);

      const unknown = await call(h, op, "POST", "/v1/operator/support-sessions", {
        grantId: "sgr_nope",
      });
      expect(refusal(unknown)).toEqual([403, "forbidden", false]);
      // A revoked grant cannot be used either.
      expect((await call(h, ana, "DELETE", `/v1/support-access/${grantId}`)).status).toBe(200);
      const revoked = await call(h, op, "POST", "/v1/operator/support-sessions", { grantId });
      expect(refusal(revoked)).toEqual([403, "forbidden", false]);
    });
  });

  describe("account closure", () => {
    it("[A04] closing an account: read-only tokens refused, step-up required, then closes", async () => {
      const ana = await signup(h, "ana@bye.test");
      const body = { confirmAddress: "ana@bye.test" };
      const ro = await readOnlyToken(h, ana);
      // A token (not an interactive session) is refused outright — never offered a step-up.
      expect(refusal(await call(h, ro, "POST", "/v1/account/close", body))).toEqual([
        403,
        "forbidden",
        false,
      ]);
      const plain = await plainSession(h, ana);
      expect(refusal(await call(h, plain, "POST", "/v1/account/close", body))).toEqual([
        403,
        "forbidden",
        true,
      ]);
      const mismatch = await call(h, ana, "POST", "/v1/account/close", {
        confirmAddress: "someone@bye.test",
      });
      expect([mismatch.status, mismatch.body.error.code]).toEqual([409, "conflict"]);
      expect(
        await count(
          h,
          "SELECT COUNT(*) AS n FROM users WHERE id = ? AND status = 'closed'",
          ana.userId,
        ),
      ).toBe(0);

      const closed = await call(h, ana, "POST", "/v1/account/close", body);
      expect(closed.status).toBe(200);
      expect(closed.body.reserved).toContain("ana@bye.test");
      expect(closed.body.terms).toMatchObject({ plan: null });
      expect(closed.body.forwarding).toEqual([]);
      expect(
        await count(
          h,
          "SELECT COUNT(*) AS n FROM users WHERE id = ? AND status = 'closed'",
          ana.userId,
        ),
      ).toBe(1);
      expect(
        await count(
          h,
          "SELECT COUNT(*) AS n FROM address_routes WHERE address = 'ana@bye.test' AND disabled_at IS NULL",
        ),
      ).toBe(0);
      // The closed account's session no longer works.
      expect((await call(h, ana, "GET", "/v1/me")).status).toBe(401);
    });
  });

  describe("team member administration", () => {
    const team = async () => {
      const owner = await signup(h, "owner@bye.test");
      const org = await call(h, owner, "POST", "/v1/orgs", { kind: "domain", name: "Acme" });
      expect(org.status).toBe(201);
      const orgId = org.body.id as string;
      const join = async (address: string) => {
        const invite = await call(h, owner, "POST", `/v1/orgs/${orgId}/invitations`, {
          address,
          role: "member",
        });
        const member = await signup(h, address);
        expect(
          (await call(h, member, "POST", "/v1/invitations/accept", { token: invite.body.token }))
            .status,
        ).toBe(200);
        return member;
      };
      return { owner, orgId, bob: await join("bob@bye.test"), carol: await join("carol@bye.test") };
    };
    const memberOf = async (orgId: string, owner: Account, userId: string) =>
      ((await call(h, owner, "GET", `/v1/orgs/${orgId}/members`)).body.items as Array<any>).find(
        (m) => m.userId === userId,
      );

    it("[O02] members, strangers and un-stepped-up owners cannot change roles, suspend, reactivate or remove", async () => {
      const { owner, orgId, bob, carol } = await team();
      const eve = await signup(h, "eve@bye.test");
      const plainOwner = await plainSession(h, owner);
      const mutations = [
        ["PATCH", `/v1/orgs/${orgId}/members/${carol.userId}`, { role: "admin" }],
        ["POST", `/v1/orgs/${orgId}/members/${carol.userId}/suspend`, {}],
        ["POST", `/v1/orgs/${orgId}/members/${carol.userId}/reactivate`, {}],
        ["DELETE", `/v1/orgs/${orgId}/members/${carol.userId}`, undefined],
      ] as const;
      for (const [method, path, json] of mutations) {
        for (const [who, caller] of [
          ["member", bob],
          ["stranger", eve],
        ] as const) {
          const r = await call(h, caller, method, path, json);
          expect([who, method, path, ...refusal(r)]).toEqual([
            who,
            method,
            path,
            403,
            "forbidden",
            false,
          ]);
        }
        const r = await call(h, plainOwner, method, path, json);
        expect([method, path, ...refusal(r)]).toEqual([method, path, 403, "forbidden", true]);
      }
      expect(await memberOf(orgId, owner, carol.userId)).toMatchObject({
        role: "member",
        status: "active",
      });
    });

    it("[O02] an admin changes a role, suspends, reactivates and removes a member", async () => {
      const { owner, orgId, bob } = await team();
      const role = await call(h, owner, "PATCH", `/v1/orgs/${orgId}/members/${bob.userId}`, {
        role: "admin",
      });
      expect([role.status, role.body]).toEqual([200, { userId: bob.userId, role: "admin" }]);
      expect(await memberOf(orgId, owner, bob.userId)).toMatchObject({ role: "admin" });

      expect(
        (await call(h, owner, "POST", `/v1/orgs/${orgId}/members/${bob.userId}/suspend`, {}))
          .status,
      ).toBe(200);
      expect(await memberOf(orgId, owner, bob.userId)).toMatchObject({ status: "suspended" });
      // A suspended admin loses admin powers immediately.
      expect((await call(h, bob, "GET", `/v1/orgs/${orgId}/audit`)).status).toBe(403);

      const back = await call(
        h,
        owner,
        "POST",
        `/v1/orgs/${orgId}/members/${bob.userId}/reactivate`,
        {},
      );
      expect([back.status, back.body]).toEqual([200, { userId: bob.userId, status: "active" }]);
      expect(await memberOf(orgId, owner, bob.userId)).toMatchObject({ status: "active" });

      expect(
        (await call(h, owner, "DELETE", `/v1/orgs/${orgId}/members/${bob.userId}`)).status,
      ).toBe(200);
      const removed = await memberOf(orgId, owner, bob.userId);
      expect(removed === undefined || removed.status === "removed").toBe(true);
    });
  });

  describe("billing", () => {
    const provider: Array<{ action: string; [k: string]: unknown }> = [];
    let realFetch: typeof fetch;
    beforeEach(() => {
      provider.length = 0;
      Object.assign(h.env, {
        BILLING_CHECKOUT_URL: "https://billing.example/api",
        BILLING_API_KEY: "billing-key",
      });
      realFetch = globalThis.fetch;
      globalThis.fetch = (async (url: string, init: RequestInit) => {
        if (String(url) !== "https://billing.example/api") return realFetch(url, init);
        const body = JSON.parse(init.body as string) as { action: string };
        provider.push(body);
        return Response.json(
          body.action === "checkout.create" ? { id: "prov_1", url: "https://pay.example/1" } : {},
        );
      }) as typeof fetch;
    });
    afterEach(() => {
      globalThis.fetch = realFetch;
    });

    it("[A02] checkout creates a session whose signed return URL reads its status", async () => {
      const ana = await signup(h, "ana@bye.test");
      const created = await call(h, ana, "POST", "/v1/billing/checkout", {
        plan: "personal",
        interval: "monthly",
      });
      expect(created.status).toBe(201);
      expect(created.body).toEqual({ sessionId: expect.any(String), url: "https://pay.example/1" });
      const request = provider.find((p) => p.action === "checkout.create")!;
      expect(request).toMatchObject({ orgId: ana.organizationId, plan: "personal", seats: 1 });
      const sig = new URL(String(request.successUrl)).searchParams.get("sig")!;
      const status = await call(
        h,
        ana,
        "GET",
        `/v1/billing/checkout/${created.body.sessionId}?sig=${sig}`,
      );
      expect([status.status, status.body]).toEqual([
        200,
        { status: "open", purpose: "subscription" },
      ]);
      // A forged signature (or another session's) proves nothing.
      const forged = await call(
        h,
        ana,
        "GET",
        `/v1/billing/checkout/${created.body.sessionId}?sig=${"0".repeat(64)}`,
      );
      expect(refusal(forged)).toEqual([403, "forbidden", false]);
      // Expired sessions report as expired.
      vi.setSystemTime(Date.now() + 7 * 86400_000);
      expect(
        (await call(h, ana, "GET", `/v1/billing/checkout/${created.body.sessionId}?sig=${sig}`))
          .body.status,
      ).toBe("expired");
    });

    it("[A02] plan change and cancellation: step-up, own org only, recorded in the ledger", async () => {
      const ana = await signup(h, "ana@bye.test");
      const bob = await signup(h, "bob@bye.test");
      await h.d1
        .prepare(
          "INSERT OR REPLACE INTO entitlements (org_id, plan, status, updated_at) VALUES (?, 'personal', 'active', 0)",
        )
        .bind(ana.organizationId)
        .run();
      const change = { orgId: ana.organizationId, plan: "personal", interval: "annual" };
      const cancel = { orgId: ana.organizationId, atPeriodEnd: true };
      // Another customer cannot touch Ana's subscription.
      for (const [path, json] of [
        ["/v1/billing/plan", change],
        ["/v1/billing/cancel", cancel],
        ["/v1/billing/checkout", { ...change, plan: "personal" }],
      ] as const) {
        expect([path, ...refusal(await call(h, bob, "POST", path, json))]).toEqual([
          path,
          403,
          "forbidden",
          false,
        ]);
      }
      const plain = await plainSession(h, ana);
      expect(refusal(await call(h, plain, "POST", "/v1/billing/plan", change))).toEqual([
        403,
        "forbidden",
        true,
      ]);
      expect(refusal(await call(h, plain, "POST", "/v1/billing/cancel", cancel))).toEqual([
        403,
        "forbidden",
        true,
      ]);
      expect(provider).toEqual([]);

      const changed = await call(h, ana, "POST", "/v1/billing/plan", change);
      expect([changed.status, changed.body]).toEqual([202, { requested: true }]);
      expect(provider.at(-1)).toMatchObject({
        action: "subscription.change",
        orgId: ana.organizationId,
        plan: "personal",
        interval: "annual",
        seats: 1,
      });
      const cancelled = await call(h, ana, "POST", "/v1/billing/cancel", cancel);
      expect([cancelled.status, cancelled.body]).toEqual([202, { requested: true }]);
      expect(provider.at(-1)).toMatchObject({
        action: "subscription.cancel",
        orgId: ana.organizationId,
        atPeriodEnd: true,
      });
      expect(
        await count(
          h,
          "SELECT cancel_at_period_end AS n FROM entitlements WHERE org_id = ?",
          ana.organizationId,
        ),
      ).toBe(1);
      const ledger = (await call(h, ana, "GET", "/v1/billing")).body.ledger as Array<{
        kind: string;
      }>;
      expect(ledger.map((l) => l.kind).sort()).toEqual([
        "cancel-requested",
        "plan-change-requested",
      ]);
    });
  });

  describe("customer domains", () => {
    const withDomain = async () => {
      const ana = await signup(h, "ana@bye.test");
      const bob = await signup(h, "bob@bye.test");
      await h.d1
        .prepare(
          "INSERT INTO domains (id, org_id, name, state, verification_token, created_at, updated_at) VALUES ('dom_ana', ?, 'ana-co.test', 'active', 't', 0, 0)",
        )
        .bind(ana.organizationId)
        .run();
      return { ana, bob };
    };

    it("[O01] another organization cannot list, alias or delete a domain", async () => {
      const { ana, bob } = await withDomain();
      for (const [method, path, json] of [
        ["GET", `/v1/orgs/${ana.organizationId}/domains`, undefined],
        ["GET", "/v1/domains/dom_ana/aliases", undefined],
        ["POST", "/v1/domains/dom_ana/aliases", { localPart: "hi", mailboxId: bob.mailboxId }],
        ["DELETE", "/v1/domains/dom_ana/aliases/hi@ana-co.test", undefined],
        ["DELETE", "/v1/domains/dom_ana", undefined],
      ] as const) {
        const r = await call(h, bob, method, path, json);
        expect([method, path, ...refusal(r)]).toEqual([method, path, 403, "forbidden", false]);
      }
      expect(
        await count(
          h,
          "SELECT COUNT(*) AS n FROM domains WHERE id = 'dom_ana' AND state = 'active'",
        ),
      ).toBe(1);
      expect(
        await count(h, "SELECT COUNT(*) AS n FROM address_routes WHERE domain = 'ana-co.test'"),
      ).toBe(0);
    });

    it("[O01] aliases: add to an org mailbox only, list, remove; domain delete needs step-up and disables routes", async () => {
      const { ana, bob } = await withDomain();
      const foreign = await call(h, ana, "POST", "/v1/domains/dom_ana/aliases", {
        localPart: "hi",
        mailboxId: bob.mailboxId,
      });
      expect(refusal(foreign)).toEqual([403, "forbidden", false]);
      const added = await call(h, ana, "POST", "/v1/domains/dom_ana/aliases", {
        localPart: "Hello",
        mailboxId: ana.mailboxId,
      });
      expect([added.status, added.body]).toEqual([201, { address: "hello@ana-co.test" }]);
      const dup = await call(h, ana, "POST", "/v1/domains/dom_ana/aliases", {
        localPart: "hello",
        mailboxId: ana.mailboxId,
      });
      expect([dup.status, dup.body.error.code]).toEqual([409, "conflict"]);
      await call(h, ana, "POST", "/v1/domains/dom_ana/aliases", {
        localPart: "sales",
        mailboxId: ana.mailboxId,
      });
      const listed = await call(h, ana, "GET", "/v1/domains/dom_ana/aliases");
      expect(listed.body.items).toEqual([
        { address: "hello@ana-co.test", mailboxId: ana.mailboxId, kind: "alias", disabled: false },
        { address: "sales@ana-co.test", mailboxId: ana.mailboxId, kind: "alias", disabled: false },
      ]);
      expect(
        (await call(h, ana, "DELETE", "/v1/domains/dom_ana/aliases/hello@ana-co.test")).body,
      ).toEqual({ removed: true });
      const gone = await call(h, ana, "DELETE", "/v1/domains/dom_ana/aliases/hello@ana-co.test");
      expect([gone.status, gone.body.error.code]).toEqual([404, "not_found"]);

      const orgDomains = await call(h, ana, "GET", `/v1/orgs/${ana.organizationId}/domains`);
      expect(orgDomains.status).toBe(200);
      expect(JSON.stringify(orgDomains.body)).toContain("ana-co.test");

      const plain = await plainSession(h, ana);
      // Alias routing changes and onboarding retries need the same fresh step-up as the domain.
      for (const [method, path, json] of [
        ["POST", "/v1/domains/dom_ana/aliases", { localPart: "ops", mailboxId: ana.mailboxId }],
        ["DELETE", "/v1/domains/dom_ana/aliases/sales@ana-co.test", undefined],
        ["POST", "/v1/domains/dom_ana/retry", {}],
        ["DELETE", "/v1/domains/dom_ana", undefined],
      ] as const)
        expect([method, path, ...refusal(await call(h, plain, method, path, json))]).toEqual([
          method,
          path,
          403,
          "forbidden",
          true,
        ]);
      expect(
        await count(
          h,
          "SELECT COUNT(*) AS n FROM address_routes WHERE domain = 'ana-co.test' AND disabled_at IS NULL",
        ),
      ).toBe(1);
      const removed = await call(h, ana, "DELETE", "/v1/domains/dom_ana");
      expect([removed.status, removed.body]).toEqual([200, { disabledRoutes: 1 }]);
      expect(
        await count(
          h,
          "SELECT COUNT(*) AS n FROM address_routes WHERE domain = 'ana-co.test' AND disabled_at IS NULL",
        ),
      ).toBe(0);
      expect(
        JSON.stringify((await call(h, ana, "GET", `/v1/orgs/${ana.organizationId}/domains`)).body),
      ).not.toContain("ana-co.test");
    });
  });
});
