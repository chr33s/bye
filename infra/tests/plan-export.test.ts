// plan-export maps the Alchemy engine's plan snapshot to reviewable rows. The engine itself needs
// cloud credentials, so its `Stack.plan` is replaced by a fixed snapshot here.
import { Effect, Layer } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

const planned = vi.hoisted(() => ({ requests: [] as Array<unknown> }));
vi.mock("alchemy/Alchemist", () => ({
  layer: () => Layer.empty,
  Stack: {
    plan: (request: unknown) => {
      planned.requests.push(request);
      return Effect.succeed({
        stack: { name: "MailboxPlatform", stage: "dev-ci" },
        resources: [
          {
            fqn: "MailboxPlatform/MailCore",
            logicalId: "MailCore",
            resourceType: "Cloudflare.Worker",
            action: "update",
          },
          {
            fqn: "MailboxPlatform/Site",
            logicalId: "Site",
            resourceType: "Cloudflare.Worker",
            action: "create",
          },
          {
            fqn: "MailboxPlatform/Db",
            logicalId: "Db",
            resourceType: "Cloudflare.D1Database",
            action: "noop",
          },
          {
            fqn: "MailboxPlatform/Gone",
            logicalId: "Gone",
            resourceType: "Cloudflare.Worker",
            action: "delete",
          },
        ],
        native: {
          resources: {
            "MailboxPlatform/MailCore": {
              resource: { Type: "Cloudflare.Worker" },
              props: { env: { DB: {}, SESSION_KEY: "secret-value" } },
            },
            "MailboxPlatform/Site": { resource: { Type: "Cloudflare.Worker" }, props: {} },
            "MailboxPlatform/Db": {
              resource: { Type: "Cloudflare.D1Database" },
              props: { env: { NOT_A_WORKER: 1 } },
            },
          },
        },
      });
    },
  },
}));

const { exportPlan } = await import("../policies/plan-export.ts");

describe("plan export", () => {
  beforeEach(() => {
    planned.requests = [];
  });

  it("[§15.10] plans the given stage and operation through the stack entrypoint", async () => {
    await exportPlan("dev-ci", "destroy");
    expect(planned.requests).toEqual([
      { target: { entrypoint: "alchemy.run.ts", stage: "dev-ci" }, operation: "destroy" },
    ]);
  });

  it("[§15.10] keeps one row per resource, with Worker env binding names but never values", async () => {
    const plan = await exportPlan("dev-ci", "deploy");
    expect(plan).toEqual({
      format: "bye.plan-export.v1",
      stack: "MailboxPlatform",
      stage: "dev-ci",
      operation: "deploy",
      rows: [
        {
          fqn: "MailboxPlatform/MailCore",
          logicalId: "MailCore",
          resourceType: "Cloudflare.Worker",
          action: "update",
          envBindings: ["DB", "SESSION_KEY"],
        },
        // A Worker without env, a non-Worker with env, and a resource missing from the native
        // graph carry no envBindings.
        {
          fqn: "MailboxPlatform/Site",
          logicalId: "Site",
          resourceType: "Cloudflare.Worker",
          action: "create",
        },
        {
          fqn: "MailboxPlatform/Db",
          logicalId: "Db",
          resourceType: "Cloudflare.D1Database",
          action: "noop",
        },
        {
          fqn: "MailboxPlatform/Gone",
          logicalId: "Gone",
          resourceType: "Cloudflare.Worker",
          action: "delete",
        },
      ],
    });
    expect(JSON.stringify(plan)).not.toContain("secret-value");
  });
});
