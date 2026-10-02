import { describe, expect, it } from "vitest";
import { workerConfig, queueTriggers, CONTAINER_LIMITS } from "../config/workers.ts";
import { configuredWorker, desiredResources } from "../desired.ts";
import { PRIVATE_BINDINGS } from "../../resources/bindings.ts";
import { CORE_BINDING_NAMES, CORE_STACK_BINDINGS } from "../../../workers/core/src/env.ts";
import { QUEUE_NAMES, QUEUES, DLQ_CONSUMER_POLICY } from "../../resources/queue-policy.ts";
import {
  CLASS_MIGRATIONS_BY_HOST,
  liveClasses,
} from "../../migrations/durable/durable-class-migrations.ts";
import { fixtureMap, fixtureEnv } from "./fixtures.ts";
import { checkSource } from "../../policies/check-boundaries.ts";
import { coverageGaps, forbiddenScopes } from "../../onboarding/scopes.ts";
import { CF_ONBOARDING_SCOPES } from "../onboarding-scopes.ts";

describe("typed cf Worker configuration", () => {
  it("covers the install surface with cf operations while keeping OAuth verification pending", () => {
    const scopes = CF_ONBOARDING_SCOPES.map((grant) => grant.scope);

    const types = desiredResources(fixtureMap("prod", "bye-test"), {
      ...fixtureEnv,
      BYE_WORKERS_DEV_NAME: "bye-test",
    }).map((resource) => resource.type);

    expect(forbiddenScopes(scopes)).toEqual([]);
    expect(scopes).not.toContain("secrets-store.write");
    expect(CF_ONBOARDING_SCOPES.every((grant) => !grant.verified)).toBe(true);
    expect(
      coverageGaps(types, scopes, CF_ONBOARDING_SCOPES).every((gap) => gap.includes("unverified")),
    ).toBe(true);
    expect(
      coverageGaps(
        types,
        scopes,
        CF_ONBOARDING_SCOPES.map((grant) => ({ ...grant, verified: true })),
      ),
    ).toEqual([]);
  });
  it("allows infra imports in exact config paths while retaining runtime boundaries", () => {
    const source = 'import { projectConfig } from "../../infra/cf/config/workers.ts";';
    expect(checkSource("workers/core/cloudflare.config.ts", source)).toEqual([]);
    expect(checkSource("workers/core/vite.config.ts", source)).toEqual([]);
    expect(checkSource("workers/core/src/cloudflare.config.ts", source)).toHaveLength(1);
    expect(checkSource("workers/core/src/index.ts", source)).toHaveLength(1);
  });

  for (const stage of ["prod", "staging", "preview-123", "dev-abcdef"]) {
    it(`preserves exposure, bindings, current SQLite exports and privacy for ${stage}`, () => {
      const map = fixtureMap(stage);
      const core = configuredWorker(workerConfig("MailCore", map, fixtureEnv));
      const site = configuredWorker(workerConfig("PublicSite", map, fixtureEnv));
      const mirror = configuredWorker(workerConfig("SigMirror", map, fixtureEnv));
      expect(Object.keys(core.env ?? {}).sort()).toEqual(
        [...CORE_BINDING_NAMES, ...CORE_STACK_BINDINGS].sort(),
      );
      expect(core.name).toBe(map.workers.MailCore?.name);
      expect(core.env?.DIRECTORY).toMatchObject({ type: "d1", id: map.d1.Directory?.id });

      for (const name of PRIVATE_BINDINGS) expect(site.env).not.toHaveProperty(name);
      expect(site.env?.CORE).toMatchObject({ worker: core.name, exportName: "PublicGateway" });
      expect(mirror.workersDev).toBe(false);
      expect(mirror.domains).toEqual([]);

      for (const worker of [core, site, mirror]) {
        expect(worker.observability).toMatchObject({
          enabled: true,
          headSamplingRate: 1,
          logs: { invocationLogs: false, persist: true },
          traces: { enabled: false },
        });
        expect(worker.logpush).toBe(false);
        expect(worker.previewUrls).toBe(false);
      }

      expect(core.workersDev).toBe(!["prod", "staging"].includes(stage));

      for (const [id, worker] of [
        ["MailCore", core],
        ["SigMirror", mirror],
      ] as const) {
        const declared = Object.entries(worker.exports ?? {})
          .flatMap(([name, declaration]) => (declaration.type === "durable-object" ? [name] : []))
          .sort();

        expect(declared).toEqual(liveClasses(CLASS_MIGRATIONS_BY_HOST[id]));

        for (const declaration of Object.values(worker.exports ?? {})) {
          if (declaration.type === "durable-object")
            expect(declaration).toMatchObject({ storage: "sqlite" });
          expect(declaration).not.toHaveProperty("renamedTo");
          expect(declaration).not.toHaveProperty("transferredTo");
        }
      }

      expect(core.exports?.ScannerContainer).toMatchObject({
        container: { name: map.containers.Scanner?.name },
      });
      expect(core.exports?.MimeContainer).toMatchObject({
        container: { name: map.containers.MimeParser?.name },
      });
      expect(mirror.exports?.SigMirrorJob).toMatchObject({
        container: { name: map.containers.SigMirrorJob?.name },
      });
      expect(CONTAINER_LIMITS).toEqual({
        Scanner: { instanceType: "standard-1", maxInstances: 10 },
        MimeParser: { instanceType: "standard-1", maxInstances: 5 },
        SigMirrorJob: { instanceType: "basic", maxInstances: 1 },
      });
    });
  }

  it("preserves every queue's batch, retries, timeout, concurrency, delay and DLQ drain", () => {
    const map = fixtureMap();
    const triggers = queueTriggers(map);
    expect(triggers).toHaveLength(14);
    QUEUE_NAMES.forEach((name, index) => {
      const policy = QUEUES[name].consumer;
      expect(triggers[index * 2]).toMatchObject({
        name: map.queues[name]?.name,
        deadLetterQueue: map.queues[`${name}DLQ`]?.name,
        maxBatchSize: policy.batchSize,
        maxBatchTimeout: policy.maxWaitTimeMs / 1000,
        maxRetries: policy.maxRetries,
        maxConcurrency: policy.maxConcurrency,
        retryDelay: policy.retryDelay,
      });
      expect(triggers[index * 2 + 1]).toMatchObject({
        maxBatchSize: DLQ_CONSUMER_POLICY.batchSize,
        maxBatchTimeout: 5,
        maxRetries: 10,
        maxConcurrency: 1,
        retryDelay: 60,
      });
      expect(triggers[index * 2 + 1]).not.toHaveProperty("deadLetterQueue");
    });
  });
  it("requires preview sandboxing and gates email routing independently of config/domain", () => {
    expect(() =>
      workerConfig("MailCore", fixtureMap("preview-1"), {
        ...fixtureEnv,
        MAIL_SANDBOX_DOMAINS: "",
      }),
    ).toThrow("sandbox");

    const triggersFor = (stage: string, approval: string) =>
      configuredWorker(
        workerConfig("MailCore", fixtureMap(stage), {
          ...fixtureEnv,
          MAIL_ZONE: "mail.example.test",
          BYE_MX_CUTOVER: approval,
        }),
      ).triggers;

    expect(triggersFor("prod", "")?.some((t) => t.type === "email")).toBe(false);
    expect(triggersFor("preview-1", "approved")?.some((t) => t.type === "email")).toBe(false);
    expect(triggersFor("prod", "approved")).toContainEqual({
      type: "email",
      addresses: ["*@mail.example.test"],
    });
    expect(() =>
      workerConfig("MailCore", fixtureMap("prod"), { ...fixtureEnv, BYE_FAULT_INGRESS: "throw" }),
    ).toThrow();
  });
  it("never reads secret values while evaluating configuration or writing desired evidence", () => {
    const env = Object.defineProperty({ ...fixtureEnv }, "SESSION_KEY", {
      enumerable: true,
      get: () => {
        throw new Error("secret read");
      },
    });

    // Config values are an input record from the orchestrator. Secret getter must not be touched.
    // An explicit allowlisted config projection replaces spreading all environment entries.
    expect(() => workerConfig("PublicSite", fixtureMap(), env)).not.toThrow();

    const desired = desiredResources(fixtureMap(), {
      ...fixtureEnv,
      SESSION_KEY: "hidden-value",
      PROBE_TOKEN: "hidden-probe",
    });

    expect(JSON.stringify(desired)).not.toContain("hidden-value");
    expect(JSON.stringify(desired)).not.toContain("hidden-probe");
  });
  it("requires resolved identities and refuses account/stage mismatch", () => {
    const map = fixtureMap();
    expect(() => workerConfig("MailCore", map, { ...fixtureEnv, STAGE: "prod" })).toThrow("stage");
    expect(() =>
      workerConfig("MailCore", map, { ...fixtureEnv, CLOUDFLARE_ACCOUNT_ID: "other" }),
    ).toThrow("account");
    expect(() =>
      workerConfig("MailCore", map, {
        ...fixtureEnv,
        PROD_CLOUDFLARE_ACCOUNT_ID: map.accountId,
        NONPROD_CLOUDFLARE_ACCOUNT_ID: map.accountId,
      }),
    ).toThrow("must differ");
    expect(() => workerConfig("RenderOrigin", map, fixtureEnv)).toThrow();
  });
});
