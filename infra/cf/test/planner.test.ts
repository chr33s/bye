// Schema.Struct values are plain records; tsgolint treats schema-derived interfaces as class instances.
/* oxlint-disable typescript/no-misused-spread */
import { describe, expect, it } from "vitest";
import { physicalName, workerName } from "../naming.ts";
import { adopt } from "../adoption.ts";
import { desiredResources } from "../desired.ts";
import { planResources } from "../plan.ts";
import { canonical, canonicalPlan, digest, exportPlan } from "../plan-normalize.ts";
import { fixtureMap, fixtureEnv, fixtureSnapshot } from "./fixtures.ts";
import { assertNoSecrets } from "../schemas.ts";
import { adoptionResourceMap, validateResourceMap } from "../resource-map.ts";
import type { Resource } from "../schemas.ts";

describe("immutable resource names and boundaries", () => {
  it("freezes naming v1 and separates every stage/install", () => {
    expect(physicalName("prod", "Directory")).toMatch(/^bye-prod-directory-[a-f0-9]{10}$/);
    expect(physicalName("prod", "Directory")).toBe(physicalName("prod", "Directory"));
    expect(
      new Set(
        ["prod", "staging", "preview-1", "dev-abcdef"].map((stage) =>
          physicalName(stage, "Directory"),
        ),
      ).size,
    ).toBe(4);
    expect(physicalName("prod", "Directory", "bye-first")).not.toBe(
      physicalName("prod", "Directory", "bye-second"),
    );
    expect(workerName("prod", "MailCore", "bye-first")).toBe("bye-first");
    expect(workerName("prod", "PublicSite", "bye-first")).toBe("bye-first-site");
    expect(workerName("prod", "RenderOrigin", "bye-first")).toBe("bye-first-render");
    expect(() => physicalName("main", "Directory")).toThrow();
    expect(() => physicalName("prod", "../Directory")).toThrow();
    expect(() => physicalName("prod", "Directory", "bad name")).toThrow();
    expect(physicalName("dev-abcdefghijklmnop", "A".repeat(100))).toHaveLength(63);
    expect(physicalName("dev-abcdefghijklmnop", "A".repeat(100))).not.toBe(
      physicalName("dev-abcdefghijklmnop", `${"A".repeat(99)}B`),
    );
  });
  it("validates stage/account, duplicate IDs, excess keys and secret payloads", () => {
    const map = fixtureMap();
    expect(validateResourceMap(map, map.stage, map.accountId)).toEqual(map);
    expect(() => validateResourceMap(map, "prod", map.accountId)).toThrow();
    expect(() => validateResourceMap(map, map.stage, "other")).toThrow();
    expect(() =>
      validateResourceMap({ ...map, apiToken: "secret" }, map.stage, map.accountId),
    ).toThrow();
    expect(() =>
      validateResourceMap(
        { ...map, kv: { ...map.kv, Duplicate: map.kv.ConfigCache } },
        map.stage,
        map.accountId,
      ),
    ).toThrow();
    expect(() => assertNoSecrets({ type: "secret_text", text: "hidden" })).toThrow();
    expect(() => assertNoSecrets({ nested: { api_token: "hidden" } })).toThrow();
    expect(() => assertNoSecrets({ env: { SESSION_KEY: { type: "secret" } } })).not.toThrow();
  });
});

describe("live plan classification and cutover policy", () => {
  const baseline = (stage = "dev-abcdef") => desiredResources(fixtureMap(stage), fixtureEnv);

  const run = (
    desired: ReadonlyArray<Resource>,
    live: ReadonlyArray<Resource>,
    stage = "dev-abcdef",
  ) =>
    planResources({
      stage,
      accountId: "a".repeat(32),
      desired,
      discovery: fixtureSnapshot(live, stage),
    });

  it("classifies create/update/replace/delete/noop from identity and owned settings", () => {
    const desired = baseline();
    expect(run(desired, []).entries.every((entry) => entry.action === "create")).toBe(true);
    expect(run(desired, desired).entries.every((entry) => entry.action === "noop")).toBe(true);

    const live = desired.map((resource) => {
      if (resource.logicalId === "Directory")
        return { ...resource, identity: { ...resource.identity, id: "previous-id" } };

      if (resource.logicalId === "Parts") return { ...resource, settings: {} };

      return resource;
    });

    const plan = run(desired, [
      ...live,
      {
        logicalId: "OldBucket",
        type: "Cloudflare.R2.Bucket",
        stage: "dev-abcdef",
        identity: { name: "owned-old-bucket" },
        settings: {},
      },
    ]);

    expect(plan.entries.find((e) => e.logicalId === "Directory")?.action).toBe("replace");
    expect(plan.entries.find((e) => e.logicalId === "Parts")?.action).toBe("update");
    expect(plan.entries.find((e) => e.logicalId === "OldBucket")?.action).toBe("delete");
  });
  it("blocks read failure, incomplete discovery and ambiguous logical/physical ownership", () => {
    const desired = baseline();
    expect(() => run(desired, [...desired, desired[0]!])).toThrow("ambiguous");
    expect(() => run([...desired, { ...desired[0]!, logicalId: "Duplicate" }], desired)).toThrow(
      "ambiguous",
    );
    expect(() =>
      planResources({
        stage: "dev-abcdef",
        accountId: "a".repeat(32),
        desired,
        discovery: { ...fixtureSnapshot(desired), blockers: ["unknown exports"] },
      }),
    ).toThrow("discovery blocked");
  });
  it("requires exact approval for persistent Queue/Worker destruction", () => {
    const desired = baseline("prod");

    const changed = desired.map((r) =>
      r.logicalId === "Ingest" ? { ...r, identity: { ...r.identity, id: "replacement" } } : r,
    );

    expect(() => run(changed, desired, "prod")).toThrow("decommission");
    expect(() =>
      planResources({
        stage: "prod",
        accountId: "a".repeat(32),
        desired: changed,
        discovery: fixtureSnapshot(desired, "prod"),
        decommissions: [
          {
            stage: "prod",
            logicalId: "Ingest",
            action: "replace",
            approvedBy: "operator",
            ticket: "MIG-1",
          },
        ],
      }),
    ).not.toThrow();
  });
  it("adopts exact identities and forbids replacing them even with a decommission", () => {
    const desired = baseline("staging");
    const adoption = adopt(fixtureSnapshot(desired, "staging"), "staging", "a".repeat(32));
    expect(adoptionResourceMap(adoption)).toEqual(fixtureMap("staging"));

    const missingNamespaceId = desired.map((resource) => {
      if (resource.logicalId !== "Mailboxes") return resource;
      const { namespaceId: _namespaceId, ...identity } = resource.identity;

      return { ...resource, identity };
    });

    expect(() =>
      adopt(fixtureSnapshot(missingNamespaceId, "staging"), "staging", "a".repeat(32)),
    ).toThrow("incompatible");

    const changed = desired.map((r) =>
      r.logicalId === "Directory" ? { ...r, identity: { ...r.identity, id: "replacement" } } : r,
    );

    expect(() =>
      planResources({
        stage: "staging",
        accountId: "a".repeat(32),
        desired: changed,
        discovery: fixtureSnapshot(desired, "staging"),
        adoption,
        decommissions: [
          {
            stage: "staging",
            logicalId: "Directory",
            action: "replace",
            approvedBy: "ops",
            ticket: "MIG-2",
          },
        ],
      }),
    ).toThrow("blocks cutover");
    expect(() =>
      adopt(
        fixtureSnapshot(
          desired.filter((r) => r.logicalId !== "Directory"),
          "staging",
        ),
        "staging",
        "a".repeat(32),
      ),
    ).toThrow("missing");
    expect(() =>
      adopt(
        fixtureSnapshot(
          desired.map((r) =>
            r.logicalId === "Mailboxes"
              ? { ...r, identity: { ...r.identity, hostWorker: "other" } }
              : r,
          ),
          "staging",
        ),
        "staging",
        "a".repeat(32),
      ),
    ).toThrow("incompatible");
  });
  it("blocks private PublicSite bindings, cross-stage writes and persistent trigger removals", () => {
    const desired = baseline("prod");
    expect(() =>
      run(
        desired.map((r) =>
          r.logicalId === "PublicSite" ? { ...r, bindings: [...r.bindings!, "DIRECTORY"] } : r,
        ),
        desired,
        "prod",
      ),
    ).toThrow("private binding");
    expect(() =>
      run(
        desired.map((r) => (r.logicalId === "Directory" ? { ...r, stage: "staging" } : r)),
        desired,
        "prod",
      ),
    ).toThrow();
    expect(() =>
      run(
        desired.map((r) =>
          r.logicalId === "MailCore" ? { ...r, settings: { ...r.settings, triggers: [] } } : r,
        ),
        desired,
        "prod",
      ),
    ).toThrow("lifecycle migration");
  });
});

describe("canonical evidence and compatibility adapter", () => {
  it("sorts object keys, plan rows and binding names without losing domains", () => {
    expect(digest({ b: 2, a: 1 })).toBe(digest({ a: 1, b: 2 }));
    expect(canonical({ b: [2, 1], a: 1 })).not.toBe(canonical({ b: [1, 2], a: 1 }));

    const entries = [
      {
        logicalId: "PublicSite",
        type: "Cloudflare.Worker",
        action: "noop" as const,
        stage: "prod",
        bindings: ["CORE", "PUBLISHED"],
      },
      {
        logicalId: "Directory",
        type: "Cloudflare.D1.Database",
        action: "noop" as const,
        stage: "prod",
      },
    ];

    const plan = { stack: "MailboxPlatform", stage: "prod", entries };
    expect(canonicalPlan(plan)).toBe(
      canonicalPlan({
        ...plan,
        entries: [...entries]
          .reverse()
          .map((e) => (e.bindings ? { ...e, bindings: [...e.bindings].reverse() } : e)),
      }),
    );
    expect(
      exportPlan(plan, { PublicSite: ["public.example.test"] }).rows.find(
        (r) => r.logicalId === "PublicSite",
      )?.domains,
    ).toEqual(["public.example.test"]);
    expect(() => canonical({ unsupported: undefined })).toThrow();
  });
});
