import { describe, expect, it } from "vitest";
import { missingConfig, requiredConfig, scanConfig } from "../policies/check-config.ts";
import type { ExportedPlan } from "../policies/plan-normalize.ts";
import { buildManifest, configHash, manifestDrift } from "../policies/release-manifest.ts";

const plan = (action: "noop" | "update" = "noop"): ExportedPlan => ({
  format: "bye.plan-export.v1",
  stack: "MailboxPlatform",
  stage: "prod",
  operation: "deploy",
  rows: [
    {
      fqn: "MailboxPlatform/MailCore",
      logicalId: "MailCore",
      resourceType: "Cloudflare.Worker",
      action,
    },
  ],
});

const env = {
  APP_ORIGIN: "https://app.bye.software",
  SESSION_KEY: "s3cret-value",
  CLOUDFLARE_ACCOUNT_ID: "acct",
  STATE_BACKEND: "http",
  BYE_STATE_URL: "https://state",
};

const inputs = { commit: "abc123", lockfile: "lock-v1", env };

describe("release manifest binds the reviewed plan to the deploy (§15.6/§15.10)", () => {
  it("is identical when nothing changed between plan and deploy", () => {
    expect(manifestDrift(buildManifest(plan(), inputs), buildManifest(plan(), inputs))).toEqual([]);
  });

  it("detects plan, lockfile, commit, config and account changes", () => {
    const reviewed = buildManifest(plan(), inputs);
    expect(manifestDrift(reviewed, buildManifest(plan("update"), inputs))).toEqual([
      "planDigest changed since review",
    ]);
    expect(
      manifestDrift(reviewed, buildManifest(plan(), { ...inputs, lockfile: "lock-v2" })),
    ).toEqual(["lockfileDigest changed since review"]);
    expect(manifestDrift(reviewed, buildManifest(plan(), { ...inputs, commit: "def456" }))).toEqual(
      ["commit changed since review"],
    );
    expect(
      manifestDrift(
        reviewed,
        buildManifest(plan(), { ...inputs, env: { ...env, APP_ORIGIN: "https://evil" } }),
      ),
    ).toEqual(["configHash changed since review"]);
    expect(
      manifestDrift(
        reviewed,
        buildManifest(plan(), { ...inputs, env: { ...env, CLOUDFLARE_ACCOUNT_ID: "other" } }),
      ),
    ).toEqual(["accountIdHash changed since review"]);
  });

  it("never embeds secret values: rotating a secret's value does not change the manifest, removing it does", () => {
    const names = [
      { name: "APP_ORIGIN", secret: false, optional: false },
      { name: "SESSION_KEY", secret: true, optional: false },
    ];

    expect(configHash({ ...env, SESSION_KEY: "rotated" }, names)).toBe(configHash(env, names));
    expect(configHash({ ...env, SESSION_KEY: undefined }, names)).not.toBe(configHash(env, names));
    expect(JSON.stringify(buildManifest(plan(), inputs))).not.toContain("s3cret-value");
  });
});

describe("stage config presence (§15.5)", () => {
  it("discovers required names from declarations and ignores defaulted ones", () => {
    expect(
      scanConfig(
        `Config.String("A"), Config.Redacted("B"), Config.String("C").pipe(Config.withDefault("x"))`,
      ),
    ).toEqual([
      { name: "A", secret: false, optional: false },
      { name: "B", secret: true, optional: false },
      { name: "C", secret: false, optional: true },
    ]);
    const required = requiredConfig().map((c) => c.name);

    for (const name of ["APP_ORIGIN", "SESSION_KEY", "PROXY_SIGNING_KEY"])
      expect(required).toContain(name);
  });

  it("reports missing names only, never values", () => {
    const names = [{ name: "A", secret: true, optional: false }];
    expect(missingConfig({}, names)).toEqual(["A"]);
    expect(missingConfig({ A: "  " }, names)).toEqual(["A"]);
    expect(missingConfig({ A: "v" }, names)).toEqual([]);
  });
});
