import { describe, expect, it } from "vitest";
import { checkPlan, loadPlan } from "../policies/check-plan.ts";
import {
  canonicalPlan,
  type ExportedPlan,
  normalizePlan,
  resourceIdentities,
} from "../policies/plan-normalize.ts";

const row = (
  logicalId: string,
  resourceType: string,
  action: ExportedPlan["rows"][number]["action"],
  envBindings?: Array<string>,
) => {
  let planRow: ExportedPlan["rows"][number] = {
    fqn: `MailboxPlatform/${logicalId}`,
    logicalId,
    resourceType,
    action,
  };

  if (envBindings) planRow = { ...planRow, envBindings };

  return planRow;
};

const exported = (
  stage: string,
  rows: ExportedPlan["rows"],
  operation: ExportedPlan["operation"] = "deploy",
): ExportedPlan => ({
  format: "bye.plan-export.v1",
  stack: "MailboxPlatform",
  stage,
  operation,
  rows,
});

describe("real Alchemy plan → policy gate (§15.6/§15.10)", () => {
  it("maps Alchemy's own type strings so a real D1 deletion is still caught as protected", () => {
    const plan = normalizePlan(
      exported("prod", [
        row("Directory", "Cloudflare.D1Database", "delete"),
        row("Originals", "Cloudflare.R2.Bucket", "orphaned"),
      ]),
    );

    expect(plan.entries.map((e) => [e.type, e.action])).toEqual([
      ["Cloudflare.D1.Database", "delete"],
      ["Cloudflare.R2.Bucket", "delete"],
    ]);
    const violations = checkPlan("deploy", plan, []);
    expect(violations.some((v) => v.includes("Directory"))).toBe(true);
    expect(violations.some((v) => v.includes("Originals"))).toBe(true);
  });

  it("carries Worker env binding names so public-worker private bindings are rejected", () => {
    const plan = loadPlan(
      exported("prod", [
        row("PublicSite", "Cloudflare.Worker", "update", ["PUBLISHED", "ORIGINALS"]),
      ]),
    );

    expect(checkPlan("deploy", plan, []).some((v) => v.includes("ORIGINALS"))).toBe(true);
  });

  it("steady mode: a second deploy of the same commit must be noop/update only", () => {
    expect(
      checkPlan(
        "steady",
        normalizePlan(
          exported("dev-abcd1234", [
            row("Directory", "Cloudflare.D1Database", "noop"),
            row("MailCore", "Cloudflare.Worker", "update"),
          ]),
        ),
        [],
      ),
    ).toEqual([]);
    expect(
      checkPlan(
        "steady",
        normalizePlan(
          exported("dev-abcd1234", [row("Originals", "Cloudflare.R2.Bucket", "replace")]),
        ),
        [],
      ),
    ).toEqual(["replace Cloudflare.R2.Bucket Originals"]);
  });

  it("drift mode: the deployed stage's plan must be all noop", () => {
    const plan = (action: ExportedPlan["rows"][number]["action"]) =>
      normalizePlan(
        exported("prod", [
          row("Directory", "Cloudflare.D1Database", "noop"),
          row("MailCore", "Cloudflare.Worker", action),
        ]),
      );

    expect(checkPlan("drift", plan("noop"), [])).toEqual([]);
    expect(checkPlan("drift", plan("update"), [])).toEqual([
      "drift: update Cloudflare.Worker MailCore",
    ]);
  });

  it("destroy mode: only preview/dev stages, own resources, no foundation types", () => {
    const ok = normalizePlan(
      exported("preview-42", [row("Originals", "Cloudflare.R2.Bucket", "delete")], "destroy"),
    );

    expect(checkPlan("destroy", ok, [])).toEqual([]);
    expect(
      checkPlan(
        "destroy",
        normalizePlan(
          exported("staging", [row("Originals", "Cloudflare.R2.Bucket", "delete")], "destroy"),
        ),
        [],
      ).length,
    ).toBeGreaterThan(0);
    expect(
      checkPlan(
        "destroy",
        normalizePlan(
          exported(
            "preview-42",
            [row("WafRules", "Cloudflare.Ruleset.Ruleset", "delete")],
            "destroy",
          ),
        ),
        [],
      ),
    ).toEqual(["WafRules (Cloudflare.Ruleset) is foundation-owned"]);
  });

  it("canonical form and identity map are order-independent (artifact digests compare)", () => {
    const a = exported("prod", [
      row("B", "Cloudflare.Worker", "noop"),
      row("A", "Cloudflare.D1Database", "noop"),
    ]);

    const b = exported("prod", [
      row("A", "Cloudflare.D1Database", "noop"),
      row("B", "Cloudflare.Worker", "noop"),
    ]);

    expect(canonicalPlan(a)).toBe(canonicalPlan(b));
    expect(resourceIdentities(a).map((r) => r.type)).toEqual([
      "Cloudflare.D1.Database",
      "Cloudflare.Worker",
    ]);
  });
});
