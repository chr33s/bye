import { describe, expect, it } from "vitest";
import { Effect, Exit, Layer } from "effect";
import {
  Authorization,
  Forbidden,
  type OrgRoleName,
  Principal,
  type PrincipalContext,
  requireOperatorAccess,
  requireOrgAdminAccess,
} from "../src/index.ts";

// §7.1: organization-admin and operator checks go through the Authorization service, so the role
// source (D1) and the operator allowlist are swappable facts, not hard-wired calls.

const principal = (overrides: Partial<PrincipalContext> = {}): PrincipalContext => ({
  userId: "usr_1",
  sessionId: "ses_1",
  kind: "user",
  scopes: ["read", "draft", "send", "admin"],
  mailboxIds: [],
  calendarIds: [],
  organizationIds: ["org_1"],
  ...overrides,
});

const provide = <A, E>(
  program: Effect.Effect<A, E, Principal | Authorization>,
  p: PrincipalContext,
  roles: Record<string, OrgRoleName>,
  operators: ReadonlyArray<string>,
) =>
  program.pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(Principal, p),
        Layer.succeed(Authorization, {
          orgRole: (orgId, userId) => Effect.succeed(roles[`${orgId}:${userId}`] ?? null),
          isOperator: (userId) => operators.includes(userId),
        }),
      ),
    ),
  );

const run = <A, E>(
  program: Effect.Effect<A, E, Principal | Authorization>,
  p: PrincipalContext,
  roles: Record<string, OrgRoleName>,
  operators: ReadonlyArray<string> = [],
) => Effect.runPromiseExit(provide(program, p, roles, operators));

/** The typed failure of a denied check (fails the test if the check succeeds). */
const denied = <A, E>(
  program: Effect.Effect<A, E, Principal | Authorization>,
  p: PrincipalContext,
  roles: Record<string, OrgRoleName>,
  operators: ReadonlyArray<string> = [],
) => Effect.runPromise(Effect.flip(provide(program, p, roles, operators)));

describe("[§7.1] Authorization service", () => {
  it("org admin access needs membership, the admin scope and an owner/admin role", async () => {
    expect(
      Exit.isSuccess(
        await run(requireOrgAdminAccess("org_1"), principal(), { "org_1:usr_1": "admin" }),
      ),
    ).toBe(true);
    expect(
      Exit.isSuccess(
        await run(requireOrgAdminAccess("org_1"), principal(), { "org_1:usr_1": "owner" }),
      ),
    ).toBe(true);

    const member = await denied(requireOrgAdminAccess("org_1"), principal(), {
      "org_1:usr_1": "member",
    });

    expect(member).toBeInstanceOf(Forbidden);
    expect(member).toMatchObject({ _tag: "Forbidden", reason: "administrator role required" });
    // Not a member via the principal, whatever the role table says.
    expect(
      await denied(requireOrgAdminAccess("org_2"), principal(), { "org_2:usr_1": "owner" }),
    ).toMatchObject({ _tag: "Forbidden", reason: "not a member of organization" });
    expect(
      await denied(requireOrgAdminAccess("org_1"), principal({ scopes: ["read"] }), {
        "org_1:usr_1": "owner",
      }),
    ).toMatchObject({ _tag: "Forbidden", reason: "missing scope admin" });
    // Billing routes accept "read" scope so a lapsed account can still pay.
    expect(
      Exit.isSuccess(
        await run(requireOrgAdminAccess("org_1", "read"), principal({ scopes: ["read"] }), {
          "org_1:usr_1": "owner",
        }),
      ),
    ).toBe(true);
  });

  it("operator access comes from the service's allowlist", async () => {
    expect(Exit.isSuccess(await run(requireOperatorAccess(), principal(), {}, ["usr_1"]))).toBe(
      true,
    );
    expect(await denied(requireOperatorAccess(), principal(), {}, ["usr_other"])).toMatchObject({
      _tag: "Forbidden",
      reason: "operator only",
    });
    // Operators still need the admin scope.
    expect(
      await denied(requireOperatorAccess(), principal({ scopes: ["read"] }), {}, ["usr_1"]),
    ).toMatchObject({ _tag: "Forbidden", reason: "missing scope admin" });
  });
});
