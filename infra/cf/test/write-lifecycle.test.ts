import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { deploymentEngine } from "../dispatch.ts";
import { operationAllowed } from "../operations.ts";
import { assertReleaseConfig } from "../release-config.ts";
import { newResourceMap } from "../resource-map.ts";
import { desiredResources } from "../desired.ts";
import { planResources } from "../plan.ts";
import { fixtureEnv } from "./fixtures.ts";
import { provision } from "../provision.ts";
import { destroy, destructionSubject } from "../destroy.ts";
import { foundationPlan, applyFoundation, type OwnedRule } from "../foundation.ts";
import { digest } from "../plan-normalize.ts";
import { fixtureMap, fixtureSnapshot } from "./fixtures.ts";
import type { Resource } from "../schemas.ts";
import { httpWriterLocks } from "../locks.ts";
import { childEnv } from "../../onboarding/executor.ts";
import { approvalCovers } from "../../onboarding/review.ts";
import type { ApprovalSubject } from "../../onboarding/store.ts";

const storage: Resource = {
  logicalId: "Directory",
  stage: "dev-abcdef",
  type: "Cloudflare.D1.Database",
  identity: { id: "old", name: "bye-directory" },
  settings: {},
};

const noopLease = { async assertHeld() {}, async release() {} };

describe("explicit opt-in and account operations", () => {
  it("preserves shared-stage writers, webhook strength and mail preview attestation", () => {
    expect(() => assertReleaseConfig("staging", { STAGE: "staging" })).toThrow("CI");
    expect(() =>
      assertReleaseConfig("prod", { STAGE: "prod", CI: "true", BILLING_WEBHOOK_SECRET: "short" }),
    ).toThrow("shorter");
    expect(() =>
      assertReleaseConfig("staging", {
        STAGE: "staging",
        CI: "true",
        NEWSLETTER_API_KEY: "provider",
      }),
    ).toThrow("PROVIDER_SENT_PREVIEWS");
  });
  it("plans undeployed staging and production as creates only with explicit initial review", () => {
    for (const stage of ["staging", "prod"]) {
      expect(() => newResourceMap(stage, "a".repeat(32))).toThrow("initial-stage");
      const map = newResourceMap(stage, "a".repeat(32), undefined, true);

      const plan = planResources({
        stage,
        accountId: map.accountId,
        desired: desiredResources(map, fixtureEnv),
        discovery: fixtureSnapshot([], stage),
      });

      expect(plan.entries.length).toBeGreaterThan(40);
      expect(plan.entries.every((entry) => entry.action === "create")).toBe(true);
    }
  });
  it("defaults to the rollback path, rejects misspelled engines and dangerous command switches", () => {
    expect(deploymentEngine(undefined)).toBe("alchemy");
    expect(deploymentEngine("cf")).toBe("cf");
    expect(() => deploymentEngine("CF")).toThrow();
    expect(
      operationAllowed(["workers", "deployments", "create", "--bypass-deployment-checks"]),
    ).toBe(false);
    expect(operationAllowed(["zones", "delete", "zone"])).toBe(false);
    expect(operationAllowed(["d1", "delete", "id", "--force"])).toBe(true);
  });
  it("resolves generated IDs from approved creates and rejects persistent provisioning", async () => {
    const map = fixtureMap();
    const calls: Array<ReadonlyArray<string>> = [];

    const input = {
      plan: {
        stage: map.stage,
        stack: "MailboxPlatform",
        entries: [
          {
            logicalId: storage.logicalId,
            type: storage.type,
            stage: storage.stage,
            action: "create" as const,
          },
        ],
      },
      desired: [storage],
      map,
      beforeWrite: async () => {},
      runner: {
        async run(operation: { args: ReadonlyArray<string> }) {
          calls.push(operation.args);

          return JSON.stringify({ uuid: "new-id", name: storage.identity.name });
        },
      },
    };

    expect((await provision(input)).d1.Directory?.id).toBe("new-id");
    expect(calls).toEqual([["d1", "create", "--name", "bye-directory"]]);
    await expect(
      provision({ ...input, plan: { ...input.plan, stage: "prod" }, map: fixtureMap("prod") }),
    ).rejects.toThrow("initial-install");
  });
  it("requires valid shared lock credentials and refuses authority lease loss", async () => {
    expect(() =>
      httpWriterLocks({ origin: "http://locks.test", credential: "c".repeat(32) }),
    ).toThrow("HTTPS");
    const paths: Array<string> = [];

    const locks = httpWriterLocks({
      origin: "https://locks.test",
      credential: "c".repeat(32),
      fetcher: async (url) => {
        paths.push(
          url instanceof URL
            ? url.pathname
            : new URL(url instanceof Request ? url.url : url).pathname,
        );

        return new Response(null, { status: paths.length === 2 ? 409 : 200 });
      },
    });

    const lease = await locks.acquire("key", "owner");
    await expect(lease.assertHeld()).rejects.toThrow("assert");
    await lease.release();
    expect(paths).toEqual(["/cf-locks/acquire", "/cf-locks/assert", "/cf-locks/release"]);
  });
});

describe("verified preview destruction", () => {
  const scenario = () => {
    const snapshot = fixtureSnapshot([storage]);

    const records = [
      {
        stage: storage.stage,
        logicalId: storage.logicalId,
        action: "delete" as const,
        approvedBy: "operator",
        ticket: "preview-cleanup",
      },
    ];

    let reads = 0;
    const calls: Array<ReadonlyArray<string>> = [];
    const statuses: Array<string> = [];

    const input = {
      engine: "cf",
      stage: storage.stage,
      accountId: snapshot.accountId,
      owner: "test",
      approvedDigest: digest(destructionSubject(snapshot, records)),
      decommissions: records,
      discover: async () => (++reads === 1 ? snapshot : fixtureSnapshot([])),
      locks: { acquire: async () => noopLease },
      runner: {
        run: async (operation: { args: ReadonlyArray<string> }) => {
          calls.push(operation.args);

          return "null";
        },
      },
      record: async (result: { status: string }) => {
        statuses.push(result.status);
      },
    };

    return { input, calls, statuses, snapshot };
  };

  it("verifies absence after delete instead of trusting exit code", async () => {
    const s = scenario();
    await destroy(s.input);
    expect(s.calls).toEqual([["d1", "delete", "old", "--force"]]);
    expect(s.statuses).toEqual(["complete"]);
  });
  it("marks a success-exit-without-deletion as unknown and never replays the delete", async () => {
    const s = scenario();
    s.input.discover = async () => s.snapshot;
    await expect(destroy(s.input)).rejects.toThrow("unverified");
    expect(s.calls).toHaveLength(1);
    expect(s.statuses).toEqual(["unknown"]);
  });
  it("rejects stale approval and persistent stages before deletion", async () => {
    const s = scenario();
    await expect(destroy({ ...s.input, approvedDigest: "stale" })).rejects.toThrow("differs");
    await expect(destroy({ ...s.input, stage: "prod" })).rejects.toThrow("persistent");
    expect(s.calls).toEqual([]);
  });
});

describe("foundation ownership", () => {
  it("updates only the adopted Bye rule and verifies it, preserving unrelated rules", async () => {
    const rule: OwnedRule = {
      zoneId: "zone-id",
      zoneName: "example.test",
      rulesetId: "ruleset-id",
      ruleId: "rule-id",
      reference: "bye-waf-probes",
      phase: "http_request_firewall_custom",
      settings: { action: "block", expression: "true", enabled: true },
    };

    let expression = "false";
    const calls: Array<ReadonlyArray<string>> = [];

    const operations = {
      read: {
        async json(args: ReadonlyArray<string>): Promise<Schema.Schema.Type<typeof Schema.Json>> {
          if (args[0] === "zones") return { id: rule.zoneId, name: rule.zoneName };

          return {
            phase: rule.phase,
            rules: [
              { id: rule.ruleId, ref: rule.reference, action: "block", expression, enabled: true },
              { id: "unowned", ref: "outside", expression: "true" },
            ],
          };
        },
      },
      write: {
        async run(operation: { args: ReadonlyArray<string> }) {
          calls.push(operation.args);
          expression = "true";

          return "null";
        },
      },
    };

    const changes = await foundationPlan(operations, [rule]);
    expect(changes[0]?.action).toBe("update");
    await applyFoundation({
      engine: "cf",
      desired: [rule],
      approvedDigest: digest(changes),
      operations,
      beforeWrite: async () => {},
    });
    expect(calls[0]?.slice(0, 5)).toEqual([
      "rulesets",
      "account-rulesets",
      "rules",
      "update",
      rule.ruleId,
    ]);
    expect(calls[0]).toContain("--zone");
    expect(calls).toHaveLength(1);
    await expect(foundationPlan(operations, [{ ...rule, reference: "unowned" }])).rejects.toThrow(
      "reviewed Bye",
    );
  });
});

describe("onboarding cf approval boundary", () => {
  it("strips legacy state and telemetry values from the opt-in child while preserving account isolation", () => {
    const ctx = {
      installationId: "install",
      releaseDir: "/release",
      homeDir: "/private/install",
      stage: "staging",
      accountId: "account",
      apiToken: "oauth",
      config: { APP_ORIGIN: "https://app.test", BYE_STATE_TOKEN: "old", STATE_BACKEND: "http" },
      signal: new AbortController().signal,
    };

    const env = childEnv(ctx, {
      BYE_DEPLOY_ENGINE: "cf",
      BYE_CF_LOCK_URL: "https://locks.test",
      BYE_CF_LOCK_CREDENTIAL: "private",
      CLOUDFLARE_API_TOKEN: "wrong",
    });

    expect(env.CLOUDFLARE_API_TOKEN).toBe("oauth");
    expect(env.BYE_DEPLOY_ENGINE).toBe("cf");
    expect(env.BYE_CF_RESOURCE_MAP).toBe("/private/install/resolved.cf-resources.json");
    expect(env.BYE_STATE_TOKEN).toBeUndefined();
    expect(env.STATE_BACKEND).toBeUndefined();
    expect(env.ALCHEMY_TELEMETRY_DISABLED).toBeUndefined();
    expect(env.CF_SEND_TELEMETRY).toBe("false");
  });
  it("requires new approval when cf resource/config/discovery digests change", () => {
    const approved: ApprovalSubject = {
      installationId: "install",
      accountId: "account",
      stage: "staging",
      release: { version: "v1", commit: "a".repeat(40), lockfileDigest: "b".repeat(64) },
      configHash: "config",
      actions: [],
      migrations: [],
      cfApprovalDigest: "a".repeat(64),
    };

    expect(approvalCovers(approved, { ...approved, cfApprovalDigest: "b".repeat(64) })).toContain(
      "cf release inputs changed; reconcile and review again",
    );
  });
});
