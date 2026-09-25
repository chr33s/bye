import { describe, expect, it } from "vitest";
import { PRIVATE_BINDINGS } from "../resources/bindings.ts";
import { INVENTORY } from "../resources/inventory.ts";
import {
  type DecommissionRecord,
  evaluatePlan,
  type Plan,
  type PlanEntry,
} from "../policies/plan-policy.ts";

const coreBindings = INVENTORY.filter((e) => e.owner === "stack" && e.binding).map(
  (e) => e.binding as string,
);

const baseline = (
  stage: string,
  action: PlanEntry["action"] = "noop",
): ReadonlyArray<PlanEntry> => [
  {
    logicalId: "MailCore",
    type: "Cloudflare.Worker",
    action: "update",
    stage,
    bindings: [...coreBindings, "SESSION_KEY"],
  },
  {
    logicalId: "PublicSite",
    type: "Cloudflare.Worker",
    action: "update",
    stage,
    bindings: ["APP_ORIGIN", "PUBLISHED", "CORE"],
  },
  { logicalId: "Originals", type: "Cloudflare.R2.Bucket", action, stage },
  { logicalId: "Directory", type: "Cloudflare.D1.Database", action, stage },
  { logicalId: "Mailboxes", type: "Cloudflare.DurableObject", action, stage },
];

const check = (plan: Plan, decommissions: ReadonlyArray<DecommissionRecord> = []) =>
  evaluatePlan({ plan, decommissions, privateBindings: PRIVATE_BINDINGS });

describe("plan policy", () => {
  it("passes a second production deploy that only updates code and noops persistent resources", () => {
    expect(check({ stack: "MailboxPlatform", stage: "prod", entries: baseline("prod") })).toEqual({
      ok: true,
      violations: [],
    });
  });

  it("rejects replacing an R2 bucket in production", () => {
    const entries = baseline("prod").map((e) =>
      e.logicalId === "Originals" ? { ...e, action: "replace" as const } : e,
    );
    const result = check({ stack: "MailboxPlatform", stage: "prod", entries });
    expect(result.ok).toBe(false);
    expect(result.violations).toContainEqual({
      _tag: "UnapprovedDestruction",
      logicalId: "Originals",
      type: "Cloudflare.R2.Bucket",
      action: "replace",
    });
  });

  it("rejects deleting D1, DO namespaces, workflows, email routing, or state backend in production", () => {
    for (const [logicalId, type] of [
      ["Directory", "Cloudflare.D1.Database"],
      ["Mailboxes", "Cloudflare.DurableObject"],
      ["Fanout", "Cloudflare.Workflow"],
      ["MailRouting", "Cloudflare.Email.Routing"],
      ["StateStore", "Cloudflare.StateStore"],
    ] as const) {
      const result = check({
        stack: "MailboxPlatform",
        stage: "prod",
        entries: [{ logicalId, type, action: "delete", stage: "prod" }],
      });
      expect(result.violations.map((v) => v._tag)).toContain("UnapprovedDestruction");
    }
  });

  it("accepts an approved decommission record for the exact stage, resource, and action", () => {
    const entries = baseline("prod").map((e) =>
      e.logicalId === "Originals" ? { ...e, action: "delete" as const } : e,
    );
    const record: DecommissionRecord = {
      stage: "prod",
      logicalId: "Originals",
      action: "delete",
      approvedBy: "ops-lead",
      ticket: "OPS-1",
    };
    expect(check({ stack: "MailboxPlatform", stage: "prod", entries }, [record]).ok).toBe(true);
    expect(
      check({ stack: "MailboxPlatform", stage: "prod", entries }, [
        { ...record, action: "replace" },
      ]).ok,
    ).toBe(false);
    expect(
      check({ stack: "MailboxPlatform", stage: "prod", entries }, [{ ...record, stage: "staging" }])
        .ok,
    ).toBe(false);
  });

  it("allows preview teardown of its own resources", () => {
    expect(
      check({
        stack: "MailboxPlatform",
        stage: "preview-42",
        entries: baseline("preview-42", "delete"),
      }).ok,
    ).toBe(true);
  });

  it("rejects a preview plan that references or mutates production resources", () => {
    const entries: ReadonlyArray<PlanEntry> = [
      ...baseline("preview-42"),
      {
        logicalId: "IngestConsumer",
        type: "Cloudflare.Queues.Consumer",
        action: "create",
        stage: "preview-42",
        references: [{ stage: "prod", logicalId: "Ingest" }],
      },
      { logicalId: "Originals", type: "Cloudflare.R2.Bucket", action: "delete", stage: "prod" },
    ];
    const tags = check({ stack: "MailboxPlatform", stage: "preview-42", entries }).violations.map(
      (v) => v._tag,
    );
    expect(tags).toContain("CrossStageReference");
    expect(tags).toContain("CrossStageMutation");
  });

  it("rejects private bindings on the public worker and missing core bindings", () => {
    const entries: ReadonlyArray<PlanEntry> = [
      {
        logicalId: "MailCore",
        type: "Cloudflare.Worker",
        action: "update",
        stage: "staging",
        bindings: ["DIRECTORY"],
      },
      {
        logicalId: "PublicSite",
        type: "Cloudflare.Worker",
        action: "update",
        stage: "staging",
        bindings: ["PUBLISHED", "ORIGINALS", "SESSION_KEY"],
      },
    ];
    const violations = check({ stack: "MailboxPlatform", stage: "staging", entries }).violations;
    expect(violations).toContainEqual({
      _tag: "PrivateBindingOnPublic",
      worker: "PublicSite",
      binding: "ORIGINALS",
    });
    expect(violations).toContainEqual({
      _tag: "PrivateBindingOnPublic",
      worker: "PublicSite",
      binding: "SESSION_KEY",
    });
    expect(violations).toContainEqual({
      _tag: "MissingBinding",
      worker: "MailCore",
      binding: "MAILBOXES",
    });
  });

  it("rejects invalid stage names and changed resource identities", () => {
    expect(
      check({ stack: "MailboxPlatform", stage: "feature/x", entries: [] }).violations[0]?._tag,
    ).toBe("InvalidStage");
    const result = check({
      stack: "MailboxPlatform",
      stage: "prod",
      entries: [
        {
          logicalId: "Originals",
          type: "Cloudflare.KV.Namespace",
          action: "update",
          stage: "prod",
        },
      ],
    });
    expect(result.violations.map((v) => v._tag)).toContain("UnexpectedResourceType");
  });
});
