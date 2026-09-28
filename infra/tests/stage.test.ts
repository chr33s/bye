import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { accountForStage, classifyStage, requireStage } from "../resources/stage.ts";
import { guard } from "../policies/guard-stage.ts";

const optOut = { ALCHEMY_TELEMETRY_DISABLED: "1", DO_NOT_TRACK: "1", NO_TRACK: "1" };

describe("stage classes", () => {
  it("accepts only the four validated stage classes", () => {
    expect(requireStage("prod")).toEqual({ name: "prod", class: "prod", persistent: true });
    expect(requireStage("staging").persistent).toBe(true);
    expect(requireStage("preview-17")).toEqual({
      name: "preview-17",
      class: "preview",
      persistent: false,
    });
    expect(requireStage("dev-a1b2c3").class).toBe("dev");

    for (const bad of [
      "production",
      "preview-0",
      "preview-x",
      "dev-alice",
      "dev-ABCDEF",
      "PROD",
      "",
      "dev-a1b2c3/../prod",
      "staging2",
    ]) {
      expect(classifyStage(bad)._tag, bad).toBe("Invalid");
    }
  });

  it("separates production and nonproduction accounts", () => {
    const accounts = { prod: "acct-prod", nonprod: "acct-dev" };
    expect(accountForStage(requireStage("prod"), accounts)).toBe("acct-prod");
    expect(accountForStage(requireStage("preview-3"), accounts)).toBe("acct-dev");
  });

  it("guards destroy to non-persistent stages and requires telemetry opt-outs", () => {
    expect(guard("destroy", "preview-3", optOut)).toEqual([]);
    expect(guard("destroy", "prod", optOut)).toContain("refusing to destroy persistent stage prod");
    expect(guard("destroy", "staging", optOut)).toContain(
      "refusing to destroy persistent stage staging",
    );
    expect(guard("dev", "dev-abc123def456", optOut)).toEqual([]);
    expect(guard("dev", "preview-3", optOut)).toContain(
      "alchemy dev runs only on dev-<id> stages, not preview-3",
    );
    expect(guard("dev", "prod", optOut)).toContain(
      "alchemy dev runs only on dev-<id> stages, not prod",
    );
    expect(guard("deploy", "preview-3", {})).toContain(
      "set ALCHEMY_TELEMETRY_DISABLED before running alchemy",
    );
    expect(guard("deploy", "prod", optOut)).toContain(
      "prod deploys run only from CI or the onboarding service (one serialized writer per shared stage)",
    );
    expect(guard("deploy", "staging", optOut)).toContain(
      "staging deploys run only from CI or the onboarding service (one serialized writer per shared stage)",
    );
    expect(guard("deploy", "prod", { ...optOut, CI: "true" })).toContain(
      "production deploys require a verified release manifest (release-manifest.ts verify)",
    );
    expect(
      guard("deploy", "prod", { ...optOut, CI: "true", BYE_RELEASE_MANIFEST_VERIFIED: "1" }),
    ).toEqual([]);
    expect(guard("deploy", "staging", { ...optOut, CI: "true" })).toEqual([]);
    expect(guard("deploy", "dev-abcd1234", optOut)).toEqual([]);
  });

  it("every STAGE the CI workflow deploys is a valid stage (incl. the steady two-deploy job)", () => {
    const ci = readFileSync(join(import.meta.dirname, "../../.github/workflows/ci.yml"), "utf8");

    // Substitute GitHub expressions with representative values, then validate every STAGE line.
    const sample = (expr: string) =>
      expr
        .replace(/\$\{\{\s*github\.run_id\s*\}\}/g, "18094567123")
        .replace(/\$\{\{\s*github\.event\.pull_request\.number\s*\}\}/g, "42")
        .replace(/\$\{\{\s*inputs\.stage\s*\}\}/g, "staging");

    const stages = [...ci.matchAll(/^\s+STAGE:\s*(.+)$/gm)].map((m) => sample(m[1]!.trim()));
    expect(stages.length).toBeGreaterThanOrEqual(3);

    for (const stage of stages) expect(classifyStage(stage)._tag, stage).toBe("Valid");
    const steady = /\n  steady:[\s\S]*?\n  [a-z-]+:\n/.exec(ci)?.[0] ?? "";
    const steadyStage = sample(/STAGE:\s*(.+)/.exec(steady)?.[1]?.trim() ?? "");
    expect(classifyStage(steadyStage)).toMatchObject({
      _tag: "Valid",
      stage: { persistent: false },
    });
    // Its teardown passes the same guards the pipeline runs.
    expect(guard("destroy", steadyStage, optOut)).toEqual([]);
    expect(guard("deploy", steadyStage, { ...optOut, CI: "true" })).toEqual([]);
  });

  it("[§15.6] the steady teardown: a rejected destroy plan blocks the destroy; an unavailable one falls back to the guarded destroy", () => {
    const ci = readFileSync(join(import.meta.dirname, "../../.github/workflows/ci.yml"), "utf8");

    const gate = ci.slice(
      ci.indexOf("id: destroy-gate"),
      ci.indexOf("- name: Tear down ephemeral stage"),
    );

    expect(gate).toContain("if: always()");
    // Only a failed check writes `rejected`; a failed export writes `unavailable` and exits 0.
    expect(gate.indexOf("gate=unavailable")).toBeLessThan(gate.indexOf("exit 0"));
    expect(gate).toMatch(/check:plan --mode destroy[\s\S]*gate=rejected[\s\S]*exit 1/);
    const destroy = ci.slice(ci.indexOf("- name: Tear down ephemeral stage"));
    expect(destroy).toMatch(/if: always\(\) && steps\.destroy-gate\.outputs\.gate != 'rejected'/);
    // The fallback is safe because destroy:preview itself refuses persistent stages.
    const pkg = readFileSync(join(import.meta.dirname, "../../package.json"), "utf8");
    expect(pkg).toMatch(/"destroy:preview": "[^"]*guard-stage\.ts destroy/);
  });
});
