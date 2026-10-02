import { resolve } from "node:path";
import { Predicate, Schema } from "effect";
import { HOSTED_NAMESPACES } from "./inventory.ts";
import type { WorkerMetadata } from "./metadata.ts";
import { normalizedBindings, normalizeObservability } from "./normalize-worker.ts";
import { canonical } from "./plan-normalize.ts";
import type { CommandRunner } from "./command.ts";
import {
  assertBoundary,
  assertNoSecrets,
  decode,
  ResourceMap,
  Snapshot,
  type Resource,
} from "./schemas.ts";

const ObjectRecord = Schema.Record(Schema.String, Schema.Json);

type JsonValue = Schema.Schema.Type<typeof Schema.Json>;

type ApiRecord = Schema.Schema.Type<typeof ObjectRecord>;

interface WorkerSettings extends Record<string, Schema.Schema.Type<typeof Schema.Json>> {}

export const record = (value: JsonValue | undefined): ApiRecord => decode(ObjectRecord, value);

export const stringField = (value: ApiRecord, key: string): string => {
  const item = value[key];

  if (!Predicate.isString(item) || !item) throw new Error(`Cloudflare response is missing ${key}`);

  return item;
};

export const rows = (value: JsonValue | undefined, key?: string): ReadonlyArray<ApiRecord> => {
  const input = key === undefined ? value : record(value)[key];

  if (!Array.isArray(input)) throw new Error("Cloudflare list response has an unexpected shape");

  return input.map(record);
};

/** The generated CLI drops pagination metadata. Drain pages explicitly; never assume page one is complete. */
export const paged = async (
  runner: CommandRunner,
  args: ReadonlyArray<string>,
): Promise<ReadonlyArray<ApiRecord>> => {
  const all: Array<ApiRecord> = [];
  const seen = new Set<string>();

  for (let page = 1; page <= 200; page++) {
    const batch = rows(await runner.json([...args, "--page", String(page), "--per-page", "50"]));

    for (const item of batch) {
      const fingerprint = JSON.stringify(item);

      if (seen.has(fingerprint)) throw new Error("Cloudflare pagination repeated a row");
      seen.add(fingerprint);
      all.push(item);
    }

    if (batch.length < 50) return all;
  }

  throw new Error("Cloudflare pagination exceeded the reviewed bound");
};

export const findUnique = (
  list: ReadonlyArray<ApiRecord>,
  field: string,
  identity: string,
): ApiRecord | undefined => {
  const matches = list.filter((item) => item[field] === identity);

  if (matches.length > 1) throw new Error(`ambiguous Cloudflare ${field} identity`);

  return matches[0];
};

/** Project only known non-secret binding identities; never serialize the raw Worker version. */
export const bindingIdentities = (
  value: JsonValue | undefined,
): ReadonlyArray<Readonly<Record<string, string>>> =>
  rows(value).map((binding) => {
    const name = stringField(binding, "name");
    const type = stringField(binding, "type");

    const fields = {
      d1: ["id"],
      kv_namespace: ["namespace_id"],
      r2_bucket: ["bucket_name"],
      queue: ["queue_name"],
      durable_object_namespace: ["class_name", "script_name", "namespace_id"],
      workflow: ["workflow_name", "class_name", "script_name"],
      service: ["service", "entrypoint"],
      secret_text: [],
      secret_key: [],
      plain_text: [],
      ratelimit: ["namespace_id"],
      send_email: [],
      assets: [],
    } satisfies Readonly<Record<string, ReadonlyArray<string>>>;

    if (!(type in fields)) throw new Error(`uncharacterized Worker binding type ${type}`);
    const allowed = fields[type as keyof typeof fields];

    if (allowed === undefined) throw new Error(`uncharacterized Worker binding type ${type}`);

    return {
      name,
      type,
      ...Object.fromEntries(
        allowed.flatMap((key) => {
          const item = binding[key];

          return item === undefined ? [] : [[key, decode(Schema.NonEmptyString, item)]];
        }),
      ),
    };
  });

/** Every live field is independently recovered; missing metadata blocks planning rather than becoming noop. */
export const discover = async (
  runner: CommandRunner,
  input: ResourceMap,
  metadata?: WorkerMetadata,
): Promise<Snapshot> => {
  const map = decode(ResourceMap, input);
  assertBoundary(map, map.stage, map.accountId);
  const resources: Array<Resource> = [];
  const blockers: Array<string> = [];
  const executionState: WorkerSettings = {};

  const add = (
    logicalId: string,
    type: string,
    identity: Record<string, string>,
    settings: Resource["settings"] = {},
    extra: Partial<Resource> = {},
  ) => {
    resources.push({ logicalId, type, stage: map.stage, identity, settings, ...extra });
  };

  const d1 = await paged(runner, ["d1", "list"]);

  const databaseNames = Object.fromEntries(
    d1.map((database) => [stringField(database, "uuid"), stringField(database, "name")]),
  );

  for (const [logicalId, expected] of Object.entries(map.d1)) {
    const live = findUnique(d1, "uuid", expected.id);

    if (live)
      add(logicalId, "Cloudflare.D1.Database", {
        id: stringField(live, "uuid"),
        name: stringField(live, "name"),
      });
    else if (findUnique(d1, "name", expected.name))
      throw new Error(`D1 identity mismatch for ${logicalId}`);
  }

  for (const [logicalId, expected] of Object.entries(map.d1)) {
    if (!findUnique(d1, "uuid", expected.id)) continue;

    const pending = rows(
      await runner.json([
        "d1",
        "migrations",
        "list",
        expected.id,
        "--dir",
        resolve(import.meta.dirname, "../migrations/d1"),
      ]),
    );

    executionState[`${logicalId}PendingMigrations`] = pending
      .map((migration) => stringField(migration, "Name"))
      .sort();
  }

  const kv = await paged(runner, ["kv", "namespaces", "list"]);

  for (const [logicalId, expected] of Object.entries(map.kv)) {
    if (expected.id.startsWith("pending:") && findUnique(kv, "title", expected.id.slice(8)))
      blockers.push(`${logicalId}: pending KV title already exists; review/adopt its identity`);

    const live = findUnique(kv, "id", expected.id);

    if (live) add(logicalId, "Cloudflare.KV.Namespace", { id: stringField(live, "id") });
  }

  const buckets: Array<ApiRecord> = [];
  let cursor: string | undefined;
  const cursors = new Set<string>();

  for (let page = 0; page < 200; page++) {
    const args = ["r2", "buckets", "list"];

    if (cursor) args.push("--cursor", cursor);
    const result = record(await runner.json(args));
    buckets.push(...rows(result.buckets));

    if (!result.cursor) break;
    cursor = stringField(result, "cursor");

    if (cursors.has(cursor) || page === 199)
      throw new Error("R2 pagination is incomplete/repeated");
    cursors.add(cursor);
  }

  for (const [logicalId, expected] of Object.entries(map.r2)) {
    if (!findUnique(buckets, "name", expected.name)) continue;

    const lifecycle = record(
      await runner.json(["r2", "buckets", "lifecycle", "get", expected.name]),
    );

    const managed = record(
      await runner.json(["r2", "buckets", "domains", "managed", "list", expected.name]),
    );

    const custom = rows(
      await runner.json(["r2", "buckets", "domains", "custom", "list", expected.name]),
      "domains",
    );

    if (custom.some((domain) => domain.enabled !== false))
      blockers.push(`${logicalId}: unexpected R2 public custom domain requires reviewed removal`);

    const rules = rows(lifecycle.rules).map((rule) =>
      Object.fromEntries(
        Object.entries(rule).filter(([key, value]) => !(key === "enabled" && value === true)),
      ),
    );

    add(
      logicalId,
      "Cloudflare.R2.Bucket",
      { name: expected.name },
      {
        lifecycleRules: rules,
        publicAccess:
          decode(Schema.Boolean, managed.enabled) ||
          custom.some((domain) => domain.enabled !== false),
      },
    );
  }

  const queues = rows(await runner.json(["queues", "list"]));

  if (queues.length >= 100)
    blockers.push(
      "Queue enumeration reached the beta API's review bound; targeted absence proof required",
    );
  const queueTriggers: Array<Resource["settings"]> = [];

  for (const [logicalId, expected] of Object.entries(map.queues)) {
    const live = findUnique(queues, "queue_id", expected.id);

    if (!live) {
      if (findUnique(queues, "queue_name", expected.name))
        throw new Error(`Queue identity mismatch for ${logicalId}`);
      continue;
    }

    add(logicalId, "Cloudflare.Queues.Queue", {
      id: stringField(live, "queue_id"),
      name: stringField(live, "queue_name"),
    });
    const consumers = rows(await runner.json(["queues", "consumers", "list", expected.id]));

    if (consumers.length > 1) throw new Error(`ambiguous Queue consumer for ${logicalId}`);

    if (!consumers[0]) continue;
    const consumer = consumers[0];
    const policy = record(consumer.settings);

    let settings: Resource["settings"] = {
      maxBatchSize: decode(Schema.Number, policy.batch_size),
      maxBatchTimeout: decode(Schema.Number, policy.max_wait_time_ms) / 1000,
      maxRetries: decode(Schema.Number, policy.max_retries),
      maxConcurrency: decode(Schema.Number, policy.max_concurrency),
      retryDelay: decode(Schema.Number, policy.retry_delay),
    };

    if (consumer.dead_letter_queue)
      settings = { ...settings, deadLetterQueue: stringField(consumer, "dead_letter_queue") };
    add(
      `${logicalId}Consumer`,
      "Cloudflare.Queues.Consumer",
      { queueId: expected.id, hostWorker: stringField(consumer, "script_name") },
      settings,
    );
    queueTriggers.push({ type: "queue", name: expected.name, ...settings });
  }

  const workflows = await paged(runner, ["workflows", "list"]);

  for (const [logicalId, expected] of Object.entries(map.workflows)) {
    const live = findUnique(workflows, "name", expected.name);

    if (!live) continue;

    if (live.script_deleted) throw new Error(`Workflow ${logicalId} has a deleted host`);
    add(logicalId, "Cloudflare.Workflow", {
      name: stringField(live, "name"),
      exportName: stringField(live, "class_name"),
      hostWorker: stringField(live, "script_name"),
    });
  }

  const namespaces = await paged(runner, ["durable-objects", "namespaces", "list"]);
  const containers = rows(await runner.json(["containers", "applications", "list"]));

  for (const namespace of HOSTED_NAMESPACES) {
    const hostWorker = map.workers[namespace.hostWorker]?.name;

    if (!hostWorker) throw new Error("namespace has no resolved host Worker");

    const matches = namespaces.filter(
      (item) => item.class === namespace.className && item.script === hostWorker,
    );

    if (matches.length > 1) throw new Error(`ambiguous namespace ${namespace.logicalId}`);
    const live = matches[0];

    if (!live) continue;

    if (live.use_sqlite !== true)
      throw new Error(`namespace ${namespace.logicalId} has unverified SQLite storage`);
    const namespaceId = stringField(live, "id");

    if (
      map.durableObjects?.[namespace.logicalId]?.namespaceId &&
      map.durableObjects[namespace.logicalId]!.namespaceId !== namespaceId
    )
      throw new Error("namespace ID differs from adoption");
    const identity = { namespaceId, className: namespace.className, hostWorker, storage: "sqlite" };
    const expected = map.containers[namespace.logicalId];

    if (!expected) {
      add(namespace.logicalId, "Cloudflare.DurableObject", identity);
      continue;
    }

    const application = findUnique(containers, "name", expected.name);

    if (!application) {
      blockers.push(`${namespace.logicalId}: Container application is missing for a live DO`);
      continue;
    }

    const id = stringField(application, "id");
    const durableObjects = record(application.durable_objects);

    if (durableObjects.namespace_id !== namespaceId)
      throw new Error("Container namespace attachment differs from live bindings");
    const configuration = record(application.configuration);
    add(
      namespace.logicalId,
      "Cloudflare.Container",
      { ...identity, name: expected.name, applicationId: id },
      {
        schedulingPolicy: stringField(application, "scheduling_policy"),
        instanceType: stringField(configuration, "instance_type"),
        maxInstances: decode(Schema.Number, application.max_instances),
        image: stringField(configuration, "image"),
      },
    );
  }

  const workers = await paged(runner, ["workers", "list"]);
  const domains = metadata ? (await metadata.domains()).map(record) : [];
  const routeScripts = new Set<string>();

  if (metadata) {
    const zones = await paged(runner, ["zones", "list", "--account-id", map.accountId]);

    for (const zone of zones) {
      if (stringField(record(zone.account), "id") !== map.accountId)
        throw new Error("route discovery crossed account boundary");

      for (const route of (await metadata.routes(stringField(zone, "id"))).map(record))
        if (route.script !== null && route.script !== undefined)
          routeScripts.add(decode(Schema.NonEmptyString, route.script));
    }
  }

  for (const [logicalId, expected] of Object.entries(map.workers)) {
    const live = findUnique(workers, "name", expected.name);

    if (!live) continue;

    if (!metadata) {
      blockers.push(`${logicalId}: reviewed legacy Worker metadata adapter is required`);
      continue;
    }

    const deployments = rows(
      await runner.json(["workers", "deployments", "list", "--worker", expected.name]),
      "deployments",
    );

    if (!deployments[0]) throw new Error(`Worker ${logicalId} has no active deployment`);
    const versions = rows(deployments[0].versions);

    if (versions.length !== 1 || versions[0]?.percentage !== 100)
      throw new Error(`Worker ${logicalId} is not at a single stable version`);

    const inventory = await paged(runner, [
      "workers",
      "versions",
      "list",
      "--worker-id",
      expected.name,
    ]);

    executionState[`${logicalId}Versions`] = inventory
      .map((item) => stringField(item, "id"))
      .sort();
    executionState[`${logicalId}ActiveVersions`] = versions.map((item) => ({
      id: stringField(item, "version_id"),
      percentage: decode(Schema.Number, item.percentage),
    }));

    const version = record(
      await runner.json([
        "workers",
        "versions",
        "get",
        stringField(versions[0], "version_id"),
        "--worker-id",
        stringField(live, "id"),
      ]),
    );

    const raw = record(await metadata.settings(expected.name));
    const env = normalizedBindings(version.bindings ?? raw.bindings, expected.name, databaseNames);

    if (["MailCore", "SigMirror"].includes(logicalId) && !version.exports && !raw.exports) {
      blockers.push(`${logicalId}: live exports metadata must be recovered before adoption`);
      continue;
    }

    const exports = record(version.exports ?? raw.exports ?? {});

    const ownedExports = Object.fromEntries(
      Object.entries(exports).map(([className, value]) => {
        const declaration = record(value);
        const state = declaration.state;

        if (state && state !== "created") throw new Error("unreviewed live DO lifecycle operation");

        let selected = Object.fromEntries(
          Object.entries(declaration).filter(([key]) => key !== "state"),
        );

        if (declaration.container) {
          const namespace = HOSTED_NAMESPACES.find(
            (item) => item.className === className && item.hostWorker === logicalId,
          );

          if (!namespace) throw new Error("unowned Container export");
          selected = { ...selected, container: namespace.logicalId };
        }

        return [className, selected];
      }),
    );

    const cron = record(await metadata.schedules(expected.name));
    const subdomain = record(await metadata.subdomain(expected.name));
    const workerDomains = domains.filter((domain) => domain.service === expected.name);

    if (routeScripts.has(expected.name))
      blockers.push(`${logicalId}: routes require an explicit reviewed route inventory`);

    const triggers = rows(cron.schedules).map((schedule) => ({
      type: "scheduled",
      schedule: stringField(schedule, "cron"),
    }));

    const settings: WorkerSettings = {
      name: expected.name,
      compatibilityDate: stringField(version, "compatibility_date"),
      compatibilityFlags: decode(Schema.Array(Schema.String), version.compatibility_flags),
      workersDev: decode(Schema.Boolean, subdomain.enabled),
      previewUrls: decode(Schema.Boolean, subdomain.previews_enabled),
      logpush: decode(Schema.Boolean, live.logpush),
      observability: normalizeObservability(raw.observability ?? live.observability),
      domains: workerDomains.map((domain) => stringField(domain, "hostname")).sort(),
      env,
      exports: ownedExports,
      triggers: (logicalId === "MailCore" ? [...triggers, ...queueTriggers] : triggers).sort(
        (a, b) => canonical(a).localeCompare(canonical(b)),
      ),
    };

    if (raw.assets)
      settings.assets = {
        runWorkerFirst: decode(Schema.Json, record(record(raw.assets).config).run_worker_first),
      };

    if (logicalId === "MailCore" && !raw.assets)
      blockers.push("MailCore: deployed assets configuration is missing");

    const references = Object.values(env).flatMap((binding) => {
      const object = record(binding);

      if (object.type !== "worker") return [];
      const target = stringField(object, "worker");

      return [
        {
          stage: map.stage,
          logicalId:
            Object.entries(map.workers).find(([, worker]) => worker.name === target)?.[0] ?? target,
        },
      ];
    });

    add(logicalId, "Cloudflare.Worker", { name: expected.name }, settings, {
      bindings: Object.keys(env).sort(),
      references,
    });

    if (logicalId === "MailCore" && env.TRANSACTIONAL_EMAIL)
      add("TransactionalEmail", "Cloudflare.Email.SendEmail", { hostWorker: expected.name });

    let limiters: Array<[string, string]> = [];

    if (logicalId === "MailCore") limiters = [["AuthRateLimit", "AUTH_RATE_LIMIT"]];

    if (logicalId === "PublicSite")
      limiters = [
        ["PublicRateLimit", "PUBLIC_RATE_LIMIT"],
        ["SubscribeRateLimit", "SUBSCRIBE_RATE_LIMIT"],
      ];

    for (const [id, binding] of limiters)
      if (env[binding!])
        add(id!, "Cloudflare.RateLimit", {
          hostWorker: expected.name,
          namespace: stringField(record(env[binding!]), "namespace"),
        });
  }

  const snapshot = decode(Snapshot, {
    format: "bye.cf-discovery.v1",
    stage: map.stage,
    accountId: map.accountId,
    resources,
    blockers,
    executionState,
  });

  assertNoSecrets(snapshot);

  return snapshot;
};
