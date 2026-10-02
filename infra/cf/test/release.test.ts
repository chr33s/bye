/* oxlint-disable typescript/no-misused-spread -- Effect Struct interfaces describe plain validated JSON fixtures, not class instances. */
import { describe, expect, it } from "vitest";
import { release, type ReleasePorts, type ReleaseRequest, type ReleaseEvent } from "../release.ts";
import { approvalDigest, type ApprovalInputs } from "../evidence.ts";
import { desiredResources } from "../desired.ts";
import { planResources } from "../plan.ts";
import { digest } from "../plan-normalize.ts";
import { fixtureEnv, fixtureMap, fixtureSnapshot } from "./fixtures.ts";

const scenario = (stage = "dev-abcdef") => {
  const map = fixtureMap(stage);
  const desired = desiredResources(map, fixtureEnv);
  const snapshot = fixtureSnapshot(desired, stage);

  const plan = planResources({
    stage: map.stage,
    accountId: map.accountId,
    desired,
    discovery: snapshot,
  });

  const subject: ApprovalInputs = {
    stage: map.stage,
    accountId: map.accountId,
    releaseCommit: "a".repeat(40),
    sourceDigest: "b".repeat(64),
    lockDigest: "c".repeat(64),
    migrationDigest: "d".repeat(64),
    resourceMapDigest: digest(map),
    discoveryDigest: digest(snapshot),
    configDigest: "e".repeat(64),
    configVersion: "0.22.0",
    plan,
  };

  const calls: Array<string> = [];
  const events: Array<ReleaseEvent> = [];

  const write = async (name: string, before: () => Promise<void>) => {
    await before();
    calls.push(name);
  };

  const ports: ReleasePorts = {
    locks: {
      async acquire() {
        calls.push("lock");

        return {
          async assertHeld() {
            calls.push("assert");
          },
          async release() {
            calls.push("unlock");
          },
        };
      },
    },
    async discover() {
      calls.push("discover");

      return snapshot;
    },
    desired: () => desired,
    async subject(_map, _discovery, freshPlan) {
      return { ...subject, plan: freshPlan };
    },
    async provision(_plan, _desired, resourceMap) {
      calls.push("provision");

      return resourceMap;
    },
    async build() {
      calls.push("build");

      return Object.entries(map.workers).map(([logicalId, identity]) => ({
        logicalId,
        name: identity.name,
        directory: `/build/${logicalId}`,
        digest: "f".repeat(64),
      }));
    },
    async verifyBuild(worker) {
      calls.push(`verify:${worker.logicalId}`);
    },
    async migrate(_map, before) {
      await write("migrate", before);
    },
    async upload(worker, before) {
      await write(`upload:${worker.logicalId}`, before);

      return {
        ...worker,
        versionId: `new-${worker.logicalId}`,
        previousVersionId: `old-${worker.logicalId}`,
      };
    },
    async traffic(worker, versions, before) {
      await write(
        `traffic:${worker.logicalId}:${versions.map((v) => `${v.version_id}=${v.percentage}`).join(",")}`,
        before,
      );
    },
    async triggers(worker, before) {
      await write(`triggers:${worker.logicalId}`, before);
    },
    async reconcile(_plan, _desired, before) {
      await write("reconcile", before);
    },
    async probes() {
      calls.push("probes");

      return {
        results: ["queue.round-trip", "do.alarm", "workflow.checkpoint"].map((name) => ({
          name,
          ok: true,
        })),
      };
    },
    async record(event) {
      events.push(event);
    },
  };

  const request: ReleaseRequest = {
    engine: "cf",
    map,
    approvedDigest: approvalDigest(subject),
    owner: "test",
    canaryPercent: 10,
    durableLifecycleChanged: false,
    acknowledgeLifecycle: false,
  };

  return { request, ports, calls, events, subject, snapshot };
};

describe("serialized approved cf release", () => {
  it("orders migrations, uploads, traffic, triggers, probes, promotion and final drift; checks the lease for each write", async () => {
    const s = scenario();
    await release(s.request, s.ports);
    expect(s.calls[0]).toBe("lock");
    expect(s.calls.at(-1)).toBe("unlock");
    expect(s.calls.indexOf("migrate")).toBeLessThan(s.calls.indexOf("upload:MailCore"));
    expect(s.calls.indexOf("upload:PublicSite")).toBeLessThan(
      s.calls.indexOf("traffic:MailCore:new-MailCore=10,old-MailCore=90"),
    );
    expect(s.calls.indexOf("reconcile")).toBeLessThan(s.calls.indexOf("probes"));
    expect(s.calls).toContain("traffic:MailCore:new-MailCore=100");

    for (const [i, call] of s.calls.entries())
      if (/^(migrate|upload:|traffic:|triggers:|reconcile)/.test(call))
        expect(s.calls[i - 1]).toBe("assert");
    expect(s.events.at(-1)?.phase).toBe("promoted");
    expect(s.calls.filter((call) => call === "discover")).toHaveLength(2);
  });
  it("rejects stale approval without invoking a write and releases the authority", async () => {
    const s = scenario();
    await expect(
      release({ ...s.request, approvedDigest: "0".repeat(64) }, s.ports),
    ).rejects.toThrow("differs");
    expect(s.calls).not.toContain("provision");
    expect(s.calls.at(-1)).toBe("unlock");
  });
  it("blocks incomplete discovery and persistent release without adoption before writes", async () => {
    const s = scenario();
    s.ports.discover = async () => ({ ...s.snapshot, blockers: ["missing exports"] });
    await expect(release(s.request, s.ports)).rejects.toThrow("blocked");
    const persistent = { ...s.request, map: fixtureMap("prod") };
    await expect(release(persistent, s.ports)).rejects.toThrow("adoption");
    expect(s.calls).not.toContain("build");
  });
  it("releases a reviewed new persistent stage without an adoption manifest", async () => {
    const s = scenario("staging");
    const empty = fixtureSnapshot([], "staging");

    const freshPlan = planResources({
      stage: "staging",
      accountId: s.request.map.accountId,
      desired: s.ports.desired(s.request.map),
      discovery: empty,
    });

    let reads = 0;
    s.ports.discover = async () => (++reads === 1 ? empty : s.snapshot);
    s.ports.subject = async (_map, discovery, plan) => ({
      ...s.subject,
      discoveryDigest: digest(discovery),
      plan,
    });
    await release(
      {
        ...s.request,
        initialStage: true,
        canaryPercent: 100,
        approvedDigest: approvalDigest({
          ...s.subject,
          discoveryDigest: digest(empty),
          plan: freshPlan,
        }),
      },
      s.ports,
    );
    expect(s.calls).toContain("migrate");
    expect(s.events.at(-1)?.phase).toBe("promoted");
    expect(s.calls.at(-1)).toBe("unlock");
  });
  it("requires full rollout for first deployment before acquiring a lease", async () => {
    const s = scenario();
    await expect(release({ ...s.request, initialStage: true }, s.ports)).rejects.toThrow(
      "full rollout",
    );
    expect(s.calls).toEqual([]);
  });
  it("rejects first-deployment claims when discovery contains an existing resource", async () => {
    const s = scenario();
    await expect(
      release({ ...s.request, initialStage: true, canaryPercent: 100 }, s.ports),
    ).rejects.toThrow("every owned resource");
    expect(s.calls).not.toContain("provision");
    expect(s.calls.at(-1)).toBe("unlock");
  });
  it("stops on a lost migration response and re-reads before any later retry", async () => {
    const s = scenario();
    s.ports.migrate = async (_map, before) => {
      await before();
      throw new Error("lost response");
    };

    await expect(release(s.request, s.ports)).rejects.toThrow("lost response");
    expect(s.calls).not.toContain("upload:MailCore");
    expect(s.calls.filter((call) => call === "discover")).toHaveLength(2);
    expect(s.events.at(-1)?.phase).toBe("unknown");
    expect(s.calls).not.toContain("unlock");
  });
  it("restores prior versions when probes fail, without claiming trigger/settings rollback", async () => {
    const s = scenario();
    s.ports.probes = async () => ({ results: [{ name: "queue.round-trip", ok: false }] });
    await expect(release(s.request, s.ports)).rejects.toThrow("previous traffic restored");
    expect(s.calls).toContain("traffic:MailCore:old-MailCore=100");
    expect(s.calls).not.toContain("traffic:MailCore:new-MailCore=100");
    expect(s.events.at(-1)?.phase).toBe("failed");
  });
  it("does not attempt automatic rollback on an unknown traffic-write outcome", async () => {
    const s = scenario();
    s.ports.traffic = async (_worker, _versions, before) => {
      await before();
      throw new Error("lost traffic response");
    };

    await expect(release(s.request, s.ports)).rejects.toThrow("lost traffic response");
    expect(s.events.at(-1)?.phase).toBe("unknown");
    expect(s.calls).not.toContain("unlock");
    expect(s.calls).not.toContain("probes");
  });
  it("verifies unchanged artifact bytes immediately before uploading", async () => {
    const s = scenario();
    let verifications = 0;
    s.ports.verifyBuild = async () => {
      if (++verifications > 3) throw new Error("artifact changed");
    };

    await expect(release(s.request, s.ports)).rejects.toThrow("artifact changed");
    expect(s.calls).not.toContain("upload:MailCore");
  });
  it("requires acknowledged full rollout for durable lifecycle changes", async () => {
    const s = scenario();
    await expect(release({ ...s.request, durableLifecycleChanged: true }, s.ports)).rejects.toThrow(
      "acknowledged full",
    );
    expect(s.calls).toEqual([]);
  });
  it("refuses to call a release complete when the second plan reports drift", async () => {
    const s = scenario();
    let reads = 0;
    s.ports.discover = async () =>
      ++reads === 1
        ? s.snapshot
        : {
            ...s.snapshot,
            resources: s.snapshot.resources.map((resource) =>
              resource.logicalId === "MailCore"
                ? { ...resource, settings: { ...resource.settings, workersDev: false } }
                : resource,
            ),
          };
    await expect(release(s.request, s.ports)).rejects.toThrow("post-release drift");
    expect(s.events.at(-1)?.phase).toBe("unknown");
    expect(s.calls).not.toContain("unlock");
  });
});
