import { readFileSync } from "node:fs";
import { TEST_RUNTIME_MAX_DATE } from "../resources/compat.ts";
import { describe, expect, it } from "vitest";
import { PRIVATE_BINDINGS } from "../resources/bindings.ts";
import { INVENTORY, INVENTORY_GROUPS, PROTECTED_TYPES } from "../resources/inventory.ts";
import { sourceBindingFor } from "../../workers/core/src/dlq.ts";
import {
  QUEUE_NAMES,
  QUEUES,
  Queues,
  DeadLetters,
  CONSUMER_POLICY,
  queueIds,
  declareQueues,
} from "../resources/queues.ts";
import { coreEnv, publicEnvBase, CORE_CRONS, COMPATIBILITY } from "../resources/workers.ts";
import * as Durable from "../resources/durable.ts";
import * as Storage from "../resources/storage.ts";
import { Scanner } from "../resources/scanner.ts";
import { MimeParser } from "../resources/mime.ts";
import {
  ClamSignatures,
  SIGMIRROR_CRONS,
  SigMirrorJob,
  sigMirrorEnv,
} from "../resources/sigmirror.ts";
import { HOSTED_NAMESPACES } from "../migrations/durable/durable-class-migrations.ts";

describe("§15.4 infrastructure inventory", () => {
  it("covers every resource group with a declaration or recorded external owner", () => {
    for (const group of INVENTORY_GROUPS) {
      expect(INVENTORY.filter((e) => e.group === group).length, group).toBeGreaterThan(0);
    }

    for (const entry of INVENTORY.filter((e) => e.owner !== "stack")) {
      expect(entry.note, entry.logicalId).toBeTruthy();
    }

    // A resource may serve several groups, but it is one resource: one type, listed once per group.
    const keys = INVENTORY.map((e) => `${e.group}/${e.logicalId}`);
    expect(new Set(keys).size).toBe(keys.length);
    const typeOf = new Map<string, string>();

    for (const e of INVENTORY) {
      expect(typeOf.get(e.logicalId) ?? e.type, e.logicalId).toBe(e.type);
      typeOf.set(e.logicalId, e.type);
    }

    // Only this stack's resources are bound into its Workers, each under one binding name per host.
    const bound = INVENTORY.filter((e) => e.binding !== undefined);

    for (const e of bound) {
      expect(e.owner, e.logicalId).toBe("stack");
      expect(e.binding, e.logicalId).toMatch(/^[A-Z][A-Z0-9_]*$/);
    }

    const bindingKeys = bound.map((e) => `${e.worker ?? "MailCore"}/${e.binding}`);
    expect(new Set(bindingKeys).size).toBe(bindingKeys.length);
  });

  it("binds every stack-owned bound resource on MailCore to the declared resource", () => {
    const declared = new Map<string, unknown>(
      Object.entries({
        DIRECTORY: Storage.Directory,
        ORIGINALS: Storage.Originals,
        PARTS: Storage.Parts,
        EXPORTS: Storage.Exports,
        PUBLISHED: Storage.Published,
        CONFIG_CACHE: Storage.ConfigCache,
        MAILBOXES: Durable.Mailboxes,
        CALENDARS: Durable.Calendars,
        SHARED_SPACES: Durable.SharedSpaces,
        SEARCH_SHARDS: Durable.SearchShards,
        INGRESS_JOURNALS: Durable.IngressJournals,
        PROVISION_DOMAIN: Durable.ProvisionDomain,
        EXPORT_ACCOUNT: Durable.ExportAccount,
        ERASE_ACCOUNT: Durable.EraseAccount,
        REINDEX: Durable.Reindex,
        FANOUT: Durable.Fanout,
        SCANNER: Scanner,
        MIME_PARSER: MimeParser,
        SIGNATURES: ClamSignatures,
        MIRROR_JOB: SigMirrorJob,
      }),
    );

    const envs = new Map<string, ReadonlyMap<string, unknown>>([
      ["MailCore", new Map(Object.entries(coreEnv))],
      ["SigMirror", new Map(Object.entries(sigMirrorEnv))],
    ]);

    for (const entry of INVENTORY.filter((e) => e.owner === "stack" && e.binding)) {
      const binding = entry.binding as string;
      const env = envs.get(entry.worker ?? "MailCore")!;
      expect(env.get(binding), binding).toBeDefined();

      if (declared.has(binding)) expect(env.get(binding), binding).toBe(declared.get(binding));
    }
  });

  it("keeps every queue's Alchemy logical IDs byte-identical (renaming one replaces the queue)", async () => {
    expect(QUEUE_NAMES).toEqual([
      "Ingest",
      "ParseScan",
      "Index",
      "Dispatch",
      "Notify",
      "Propagate",
      "Publish",
    ]);
    expect(QUEUE_NAMES.flatMap((n) => Object.values(queueIds(n)))).toEqual([
      "Ingest",
      "IngestDLQ",
      "IngestConsumer",
      "IngestDLQConsumer",
      "ParseScan",
      "ParseScanDLQ",
      "ParseScanConsumer",
      "ParseScanDLQConsumer",
      "Index",
      "IndexDLQ",
      "IndexConsumer",
      "IndexDLQConsumer",
      "Dispatch",
      "DispatchDLQ",
      "DispatchConsumer",
      "DispatchDLQConsumer",
      "Notify",
      "NotifyDLQ",
      "NotifyConsumer",
      "NotifyDLQConsumer",
      "Propagate",
      "PropagateDLQ",
      "PropagateConsumer",
      "PropagateDLQConsumer",
      "Publish",
      "PublishDLQ",
      "PublishConsumer",
      "PublishDLQConsumer",
    ]);
    // The resources are constructed with exactly those IDs, in table order.
    const created: Array<string> = [];
    declareQueues((id) => (created.push(id), id));

    expect(created).toEqual([
      ...QUEUE_NAMES.map((n) => queueIds(n).queue),
      ...QUEUE_NAMES.map((n) => queueIds(n).deadLetter),
    ]);
    // stack.ts wires consumers only through queueIds.
    const stack = readFileSync(`${import.meta.dirname}/../stack.ts`, "utf8");
    expect(stack).toContain("Cloudflare.Queues.Consumer(ids.consumer,");
    expect(stack).toContain("Cloudflare.Queues.Consumer(ids.deadLetterConsumer,");

    // DLQ replay resolves every physical name form by exact logical ID, never by substring.
    for (const name of QUEUE_NAMES) {
      const id = name.toLowerCase();

      for (const physical of [
        id,
        `${id}dlq`,
        `mailboxplatform-${id}-prod-abcdefgh23456789`,
        `mailboxplatform-${id}dlq-pr-12-abcdefgh23456789`,
      ])
        expect(sourceBindingFor(physical), physical).toBe(QUEUES[name].binding);
    }

    expect(sourceBindingFor("mailboxplatform-reindexer-prod-x")).toBeNull();
    expect(sourceBindingFor("parse-scan")).toBeNull();
    expect(Object.keys(QUEUES).map((n) => QUEUES[n as keyof typeof QUEUES].binding)).toEqual([
      "INGEST",
      "PARSE_SCAN",
      "INDEX",
      "DISPATCH",
      "NOTIFY",
      "PROPAGATE",
      "PUBLISH",
    ]);
  });

  it("declares a queue, dead-letter queue, bounded consumer policy, and binding per pipeline stage", () => {
    const env = new Map<string, unknown>(Object.entries(coreEnv));

    const bindingFor = new Map<string, string>([
      ["Ingest", "INGEST"],
      ["ParseScan", "PARSE_SCAN"],
      ["Index", "INDEX"],
      ["Dispatch", "DISPATCH"],
      ["Notify", "NOTIFY"],
      ["Propagate", "PROPAGATE"],
      ["Publish", "PUBLISH"],
    ]);

    for (const name of QUEUE_NAMES) {
      expect(Queues[name]).toBeDefined();
      expect(DeadLetters[name]).not.toBe(Queues[name]);
      expect(env.get(bindingFor.get(name) as string)).toBe(Queues[name]);
      const policy = CONSUMER_POLICY[name];
      expect(policy.batchSize).toBeLessThanOrEqual(100);
      expect(policy.maxRetries).toBeGreaterThan(0);
      expect(policy.maxRetries).toBeLessThanOrEqual(10);

      for (const kind of ["Queue", "DLQ", "Consumer"]) {
        const id = kind === "Queue" ? name : `${name}${kind}`;
        expect(
          INVENTORY.some((e) => e.logicalId === id),
          id,
        ).toBe(true);
      }
    }

    // Dispatch keeps a small retry budget: uncertainty is reconciled, not redelivered (§5.2).
    expect(CONSUMER_POLICY.Dispatch.maxRetries).toBeLessThanOrEqual(3);
  });

  it("hosts one namespace per authority class on MailCore; the mirror job on SigMirror", () => {
    // Container-backed classes are Durable Object namespaces too (§15.4 media and scans).
    const inventoried = INVENTORY.filter(
      (e) => e.type === "Cloudflare.DurableObject" || e.type === "Cloudflare.Container",
    )
      .map((e) => e.logicalId)
      .sort();

    expect(HOSTED_NAMESPACES.map((n) => n.logicalId).sort()).toEqual(inventoried);

    for (const n of HOSTED_NAMESPACES)
      expect(n.hostWorker, n.logicalId).toBe(
        n.logicalId === "SigMirrorJob" ? "SigMirror" : "MailCore",
      );
    expect(PROTECTED_TYPES.has("Cloudflare.DurableObject")).toBe(true);
  });

  it("pins compatibility and schedules independent reconciliation", () => {
    // §13 Stage 0: the deployed date is one the pinned test runtime supports, and every Worker
    // declaration uses the same constant.
    expect(COMPATIBILITY.date <= TEST_RUNTIME_MAX_DATE).toBe(true);

    for (const f of ["workers.ts", "sigmirror.ts"]) {
      expect(readFileSync(`${import.meta.dirname}/../resources/${f}`, "utf8")).not.toMatch(
        /compatibility:\s*\{\s*date:/,
      );
    }

    expect(CORE_CRONS.length).toBeGreaterThanOrEqual(1);
  });
});

describe("private signature mirror (§3.1, §10)", () => {
  it("binds the mirror bucket, job container and write token only to SigMirror", () => {
    expect(Object.keys(sigMirrorEnv).sort()).toEqual(["MIRROR_JOB", "SIGNATURES", "WRITE_TOKEN"]);

    for (const key of ["SIGNATURES", "MIRROR_JOB", "WRITE_TOKEN"]) {
      expect(Object.keys(coreEnv)).not.toContain(key);
      expect(Object.keys(publicEnvBase)).not.toContain(key);
    }

    expect(Object.values(coreEnv)).not.toContain(ClamSignatures);
  });

  it("updates at most a few times a day", () => {
    for (const cron of SIGMIRROR_CRONS) {
      const hours = cron.split(" ")[1]!.split(",");
      expect(hours.length).toBeLessThanOrEqual(4);
      expect(cron.split(" ")[0]).not.toBe("*");
    }
  });
});

describe("binding least privilege (§15.5)", () => {
  it("never gives the public worker private mailbox, blob, directory, or secret bindings", () => {
    for (const key of Object.keys(publicEnvBase))
      expect(PRIVATE_BINDINGS as ReadonlyArray<string>).not.toContain(key);
    const values = Object.values(publicEnvBase);

    for (const priv of [
      Storage.Directory,
      Storage.Originals,
      Storage.Parts,
      Storage.Exports,
      Durable.Mailboxes,
      Durable.Calendars,
    ]) {
      expect(values).not.toContain(priv);
    }
  });

  it("binds no management credentials into any worker", () => {
    for (const env of [coreEnv, publicEnvBase]) {
      for (const key of Object.keys(env))
        expect(key).not.toMatch(/CLOUDFLARE_API_TOKEN|CLOUDFLARE_ACCOUNT_ID|ALCHEMY/);
    }
  });
});

describe("SigMirror exposure", () => {
  it("has no public route: workers.dev off and no domain", async () => {
    const source = (await import("node:fs")).readFileSync(
      `${import.meta.dirname}/../resources/sigmirror.ts`,
      "utf8",
    );

    expect(source).toMatch(/workersDev:\s*false/);
    expect(source).not.toMatch(/\bdomain:/);
    expect(source).toMatch(/invocationLogs:\s*false/);
  });
});

describe("scanner signature source (§10)", () => {
  it("defaults to the private mirror and requires a digest-pinned image for the baked fallback", async () => {
    const { scannerSignatureSource } = await import("../resources/scanner.ts");
    expect(scannerSignatureSource({})).toEqual({ mode: "mirror" });
    const image = `ghcr.io/acme/bye/scanner@sha256:${"a".repeat(64)}`;
    expect(scannerSignatureSource({ SCANNER_SIGNATURES: "baked", SCANNER_IMAGE: image })).toEqual({
      mode: "baked",
      image,
    });
    expect(() =>
      scannerSignatureSource({
        SCANNER_SIGNATURES: "baked",
        SCANNER_IMAGE: "ghcr.io/acme/scanner:latest",
      }),
    ).toThrow(/digest/);
    expect(() => scannerSignatureSource({ SCANNER_SIGNATURES: "online" })).toThrow();
  });
});
