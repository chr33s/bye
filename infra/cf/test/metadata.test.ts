import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { workerMetadata, type WorkerMetadata } from "../metadata.ts";
import { discover } from "../discover.ts";
import { desiredResources } from "../desired.ts";
import { workerConfig, type WorkerId } from "../config/workers.ts";
import { decode, Resource } from "../schemas.ts";
import { fixtureEnv, fixtureMap } from "./fixtures.ts";
import { planResources } from "../plan.ts";
import { normalizedBindings } from "../normalize-worker.ts";
import type { CommandRunner } from "../command.ts";

describe("narrow unsupported cf metadata exception", () => {
  it("only performs reviewed GETs on the explicit account; refuses redirects, arbitrary identities and API failures", async () => {
    const calls: Array<{ url: string; method: string; authorization: string }> = [];

    const metadata = workerMetadata({
      accountId: "a".repeat(32),
      apiToken: "private-token",
      fetcher: async (url, init) => {
        calls.push({
          url: url instanceof URL ? url.href : url instanceof Request ? url.url : url,
          method: init?.method ?? "",
          authorization: new Headers(init?.headers).get("authorization") ?? "",
        });

        return Response.json({ success: true, result: [] });
      },
    });

    await metadata.domains();
    await metadata.routes("zone-id");
    await metadata.settings("bye-test");
    await metadata.schedules("bye-test");
    await metadata.subdomain("bye-test");
    expect(
      calls.every((call) => call.method === "GET" && call.authorization === "Bearer private-token"),
    ).toBe(true);
    expect(calls[0]?.url).toBe(
      `https://api.cloudflare.com/client/v4/accounts/${"a".repeat(32)}/workers/domains`,
    );
    expect(() => metadata.settings("../another-account")).toThrow("identity");

    const failed = workerMetadata({
      accountId: "a".repeat(32),
      apiToken: "private-token",
      fetcher: async () => Response.json({ success: false, result: [] }),
    });

    await expect(failed.domains()).rejects.toThrow("rejected");
  });
  it("hashes plaintext and records secret declarations without reading their values", () => {
    const bindings = normalizedBindings(
      [
        { name: "SECRET", type: "secret_text", text: "never-evidence" },
        { name: "APP_ORIGIN", type: "plain_text", text: "https://example.test" },
      ],
      "bye",
      {},
    );

    expect(bindings.SECRET).toEqual({ type: "secret" });
    expect(JSON.stringify(bindings)).not.toContain("never-evidence");
    expect(JSON.stringify(bindings)).not.toContain("https://example.test");
  });
});

const discoveryFixture = () => {
  const map = fixtureMap();
  const desired = desiredResources(map, fixtureEnv);

  const workers = Object.fromEntries(
    Object.entries(map.workers).map(([id, worker]) => [
      worker.name,
      { id, worker: workerConfig(id as WorkerId, map, fixtureEnv).worker },
    ]),
  );

  const binding = (
    name: string,
    value: Schema.Schema.Type<typeof Schema.Json>,
  ): Schema.Schema.Type<typeof Schema.Json> => {
    const object = decode(Resource.fields.settings, value);

    switch (object.type) {
      case "text":
        return { name, type: "plain_text", text: object.value! };
      case "secret":
        return { name, type: "secret_text" };
      case "d1":
        return { name, type: "d1", id: object.id! };
      case "kv":
        return { name, type: "kv_namespace", namespace_id: object.id! };
      case "r2":
        return { name, type: "r2_bucket", bucket_name: object.name! };
      case "queue":
        return { name, type: "queue", queue_name: object.name! };
      case "unsafe:durable_object_namespace":
        return { name, type: "durable_object_namespace", class_name: object.class_name! };
      case "workflow":
        return {
          name,
          type: "workflow",
          workflow_name: object.name!,
          script_name: object.worker!,
          class_name: object.exportName!,
        };
      case "rate-limit":
        return { name, type: "ratelimit", namespace_id: object.namespace!, simple: object.simple! };
      case "send-email":
        return { name, type: "send_email" };
      case "worker": {
        let service = { name, type: "service", service: object.worker! };

        if (object.exportName) return { ...service, entrypoint: object.exportName };

        return service;
      }

      default:
        throw new Error("unsupported fixture binding");
    }
  };

  const json: CommandRunner["json"] = async (
    args,
  ): Promise<Schema.Schema.Type<typeof Schema.Json>> => {
    const command = args.slice(0, 3).join(" ");

    if (command === "d1 migrations list") return [];

    if (command === "workers versions list") return [{ id: workers[args[4]!]!.id }];

    if (command.startsWith("d1 list"))
      return Object.values(map.d1).map((database) => ({ uuid: database.id, name: database.name }));

    if (command === "kv namespaces list")
      return Object.values(map.kv).map((namespace) => ({ id: namespace.id }));

    if (command === "r2 buckets list") return { buckets: Object.values(map.r2) };

    if (command === "r2 buckets lifecycle")
      return {
        rules: desired.find((r) => r.identity.name === args[4])?.settings.lifecycleRules ?? [],
      };

    if (args.slice(0, 4).join(" ") === "r2 buckets domains managed") return { enabled: false };

    if (args.slice(0, 4).join(" ") === "r2 buckets domains custom") return { domains: [] };

    if (command.startsWith("queues list"))
      return Object.values(map.queues).map((queue) => ({
        queue_id: queue.id,
        queue_name: queue.name,
      }));

    if (command === "queues consumers list") {
      const consumer = desired.find(
        (r) => r.type === "Cloudflare.Queues.Consumer" && r.identity.queueId === args[3],
      );

      if (!consumer) return [];
      const settings = consumer.settings;

      const api = {
        script_name: consumer.identity.hostWorker!,
        settings: {
          batch_size: settings.maxBatchSize!,
          max_wait_time_ms: Number(settings.maxBatchTimeout) * 1000,
          max_retries: settings.maxRetries!,
          max_concurrency: settings.maxConcurrency!,
          retry_delay: settings.retryDelay!,
        },
      };

      return settings.deadLetterQueue
        ? [{ ...api, dead_letter_queue: settings.deadLetterQueue }]
        : [api];
    }

    if (command.startsWith("workflows list"))
      return desired
        .filter((r) => r.type === "Cloudflare.Workflow")
        .map((r) => ({
          name: r.identity.name!,
          class_name: r.identity.exportName!,
          script_name: r.identity.hostWorker!,
        }));

    if (command === "durable-objects namespaces list")
      return Object.values(map.durableObjects ?? {}).map((namespace) => ({
        id: namespace.namespaceId,
        class: namespace.className,
        script: namespace.hostWorker,
        use_sqlite: true,
      }));

    if (command === "containers applications list")
      return desired
        .filter((r) => r.type === "Cloudflare.Container")
        .map((r) => ({
          id: r.identity.applicationId!,
          name: r.identity.name!,
          durable_objects: { namespace_id: r.identity.namespaceId! },
          scheduling_policy: r.settings.schedulingPolicy!,
          max_instances: r.settings.maxInstances!,
          configuration: { instance_type: r.settings.instanceType!, image: r.settings.image! },
        }));

    if (command.startsWith("zones list")) return [];

    if (command.startsWith("workers list"))
      return Object.entries(workers).map(([name, item]) => ({ name, id: item.id, logpush: false }));

    if (command === "workers deployments list")
      return {
        deployments: [{ versions: [{ version_id: workers[args[4]!]!.id, percentage: 100 }] }],
      };

    if (command === "workers versions get") {
      const item = Object.values(workers).find((worker) => worker.id === args[3])!;

      return decode(
        Schema.Json,
        JSON.parse(
          JSON.stringify({
            id: item.id,
            compatibility_date: item.worker.compatibilityDate,
            compatibility_flags: [],
            bindings: Object.entries(item.worker.env ?? {}).map(([name, value]) =>
              binding(name, decode(Schema.Json, JSON.parse(JSON.stringify(value)))),
            ),
            exports: item.worker.exports,
          }),
        ),
      );
    }

    throw new Error(`unexpected fixture operation ${command}`);
  };

  const metadata: WorkerMetadata = {
    domains: async () => [],
    routes: async () => [],
    settings: async (name): Promise<Schema.Schema.Type<typeof Schema.Json>> => {
      const worker = workers[name]!.worker;

      const settings = {
        observability: {
          enabled: true,
          head_sampling_rate: 1,
          logs: { enabled: true, invocation_logs: false, persist: true },
          traces: { enabled: false },
        },
      };

      return worker.assets
        ? { ...settings, assets: { config: { run_worker_first: worker.assets.runWorkerFirst! } } }
        : settings;
    },
    schedules: async (name) => ({
      schedules: (workers[name]!.worker.triggers ?? [])
        .filter((trigger) => trigger.type === "scheduled")
        .map((trigger) => ({ cron: trigger.schedule })),
    }),
    subdomain: async (name) => ({
      enabled: workers[name]!.worker.workersDev!,
      previews_enabled: false,
    }),
  };

  return { map, desired, json, metadata };
};

it("normalizes a complete product/Worker inventory to a no-op plan without borrowing desired settings", async () => {
  const fixture = discoveryFixture();
  const snapshot = await discover({ json: fixture.json }, fixture.map, fixture.metadata);
  expect(snapshot.blockers).toEqual([]);

  const plan = planResources({
    stage: fixture.map.stage,
    accountId: fixture.map.accountId,
    desired: fixture.desired,
    discovery: snapshot,
  });

  expect(plan.entries.filter((entry) => entry.action !== "noop")).toEqual([]);
});

it("detects owned routes even when the Worker has no custom domain", async () => {
  const fixture = discoveryFixture();

  const json: CommandRunner["json"] = async (args) =>
    args[0] === "zones"
      ? [{ id: "zone-id", account: { id: fixture.map.accountId } }]
      : fixture.json(args);

  fixture.metadata.routes = async () => [{ script: fixture.map.workers.MailCore!.name }];
  const snapshot = await discover({ json }, fixture.map, fixture.metadata);
  expect(snapshot.blockers).toContain(
    "MailCore: routes require an explicit reviewed route inventory",
  );
});
