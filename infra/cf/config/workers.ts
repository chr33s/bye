import {
  bindings,
  defineConfig,
  defineContainer,
  exports,
  triggers,
  type CloudflareConfig,
  type WorkerConfig,
} from "cf/config";
import { resolve } from "node:path";
import { COMPATIBILITY } from "../../resources/compat.ts";
import { PRIVATE_BINDINGS } from "../../resources/bindings.ts";
import { domainDefaults, parseDomain } from "../../resources/domain.ts";
import {
  DLQ_CONSUMER_POLICY,
  QUEUE_NAMES,
  QUEUES,
  type ConsumerPolicy,
} from "../../resources/queue-policy.ts";
import { requireStage, mailRoutingZone, accountForStage } from "../../resources/stage.ts";
import { prebuiltImage } from "../../resources/container-images.ts";
import { scannerSignatureSource } from "../../resources/scanner-source.ts";
import { HOSTED_NAMESPACES, DURABLE_BINDINGS, WORKFLOWS } from "../inventory.ts";
import { loadResourceMap, validateResourceMap } from "../resource-map.ts";
import type { ResourceMap } from "../schemas.ts";
import { RUNTIME_CONFIG } from "./runtime.ts";

export const CORE_CRONS = ["*/5 * * * *", "17 3 * * *"] as const;

export const SIGMIRROR_CRONS = ["23 1,9,17 * * *"] as const;

export const RUN_WORKER_FIRST = [
  "/v1/*",
  "/render/*",
  "/img",
  "/auth/*",
  "/oauth/*",
  "/feeds/*",
  "/webhooks/*",
];

// beta.10's native builder always emits script_name, even for a self binding. Its Container
// validator treats that as cross-Worker. Preserve the existing local namespace metadata using
// the documented unsafe binding escape hatch; class lifecycle still belongs to typed exports.
const localDurableBinding = (className: string) => ({
  type: "unsafe:durable_object_namespace" as const,
  class_name: className,
});

export const OBSERVABILITY = {
  enabled: true,
  headSamplingRate: 1,
  logs: { enabled: true, invocationLogs: false, persist: true },
  traces: { enabled: false },
} as const;

// Preserve existing scheduler-managed applications attached to SQLite DO exports.
// The newer durable-object scheduling policy is a different, immutable application identity.
export const CONTAINER_LIMITS = {
  Scanner: { instanceType: "standard-1", maxInstances: 10 },
  MimeParser: { instanceType: "standard-1", maxInstances: 5 },
  SigMirrorJob: { instanceType: "basic", maxInstances: 1 },
} as const;

const queuePolicy = (policy: ConsumerPolicy) => ({
  maxBatchSize: policy.batchSize,
  maxBatchTimeout: policy.maxWaitTimeMs / 1000,
  maxConcurrency: policy.maxConcurrency,
  maxRetries: policy.maxRetries,
  retryDelay: policy.retryDelay,
});

const required = <T>(group: Readonly<Record<string, T>>, logicalId: string): T => {
  const identity = group[logicalId];

  if (!identity) throw new Error(`resolved resource map is missing ${logicalId}`);

  return identity;
};

export const queueTriggers = (map: ResourceMap) =>
  QUEUE_NAMES.flatMap((name) => [
    triggers.queue({
      name: required(map.queues, name).name,
      deadLetterQueue: required(map.queues, `${name}DLQ`).name,
      ...queuePolicy(QUEUES[name].consumer),
    }),
    triggers.queue({
      name: required(map.queues, `${name}DLQ`).name,
      ...queuePolicy(DLQ_CONSUMER_POLICY),
    }),
  ]);

export interface WorkerProject extends CloudflareConfig {
  readonly worker: WorkerConfig;
}

export type WorkerId = "MailCore" | "PublicSite" | "SigMirror" | "RenderOrigin";

export const CONFIG_INPUTS = [
  "STAGE",
  "DOMAIN",
  "APP_DOMAIN",
  "PUBLIC_DOMAIN",
  "MAIL_ZONE",
  "BYE_MX_CUTOVER",
  "BYE_WORKERS_DEV_NAME",
  "SCANNER_SIGNATURES",
  "SCANNER_IMAGE",
  "MIME_IMAGE",
  "SIGMIRROR_IMAGE",
] as const;

/** Do not enumerate the whole environment: even reading secret values is unnecessary here. */
const configValues = (values: Readonly<Record<string, string | undefined>>) =>
  Object.fromEntries([
    ...CONFIG_INPUTS.map((key) => [key, values[key] ?? ""]),
    ...Object.entries(RUNTIME_CONFIG).flatMap(([key, declaration]) =>
      declaration.secret ? [] : [[key, values[key] ?? ""]],
    ),
  ]);

/** Pure config factory. Resource maps contain IDs, never application or management credentials. */
export const workerConfig = (
  id: WorkerId,
  input: ResourceMap,
  values: Readonly<Record<string, string | undefined>>,
): WorkerProject => {
  const map = validateResourceMap(input, input.stage, input.accountId);

  const stage = requireStage(map.stage);

  if (values.STAGE && values.STAGE !== stage.name)
    throw new Error("config stage differs from resource map");

  if (values.CLOUDFLARE_ACCOUNT_ID && values.CLOUDFLARE_ACCOUNT_ID !== map.accountId)
    throw new Error("config account differs from resource map");

  const configuredAccount = accountForStage(stage, {
    prod: values.PROD_CLOUDFLARE_ACCOUNT_ID,
    nonprod: values.NONPROD_CLOUDFLARE_ACCOUNT_ID,
  });

  if (configuredAccount && configuredAccount !== map.accountId)
    throw new Error("stage account separation violation");

  if (
    values.PROD_CLOUDFLARE_ACCOUNT_ID &&
    values.PROD_CLOUDFLARE_ACCOUNT_ID === values.NONPROD_CLOUDFLARE_ACCOUNT_ID
  )
    throw new Error("production and nonproduction accounts must differ");
  const inputs = configValues(values);
  const env = { ...inputs, ...domainDefaults({ ...inputs, STAGE: stage.name }) };
  const core = required(map.workers, "MailCore").name;
  const text = (key: string, fallback = "") => bindings.text(env[key] ?? fallback);

  const origin = (key: string) => {
    const value = env[key];

    if (!value || !/^https?:\/\//.test(value) || new URL(value).origin !== value)
      throw new Error(`${key} must be an origin`);

    if (stage.persistent && !value.startsWith("https://"))
      throw new Error(`${key} requires HTTPS on persistent stages`);

    return bindings.text(value);
  };

  const base = {
    name: required(map.workers, id).name,
    compatibilityDate: COMPATIBILITY.date,
    compatibilityFlags: [...COMPATIBILITY.flags],
    workersDev: !stage.persistent || Boolean(env.BYE_WORKERS_DEV_NAME),
    previewUrls: false,
    logpush: false,
    observability: OBSERVABILITY,
  } satisfies Partial<WorkerConfig>;

  const root = resolve(import.meta.dirname, "../../..");
  const bucket = (name: string) => bindings.r2({ name: required(map.r2, name).name });

  if (id === "PublicSite") {
    const worker = {
      ...base,
      entrypoint: resolve(root, "workers/public/src/index.ts"),
      domains: env.PUBLIC_DOMAIN ? [parseDomain(env.PUBLIC_DOMAIN)!] : [],
      env: {
        APP_ORIGIN: origin("APP_ORIGIN"),
        MAIL_ORIGIN: origin("MAIL_RENDER_ORIGIN"),
        PUBLISHED: bucket("Published"),
        PUBLIC_RATE_LIMIT: bindings.rateLimit({
          namespace: "1002",
          simple: { limit: 120, period: 60 },
        }),
        SUBSCRIBE_RATE_LIMIT: bindings.rateLimit({
          namespace: "1003",
          simple: { limit: 5, period: 60 },
        }),
        CORE: bindings.worker({ worker: core, exportName: "PublicGateway" }),
      },
    };

    for (const key of Object.keys(worker.env))
      if (PRIVATE_BINDINGS.some((privateKey) => privateKey === key))
        throw new Error(`private PublicSite binding ${key}`);

    return defineConfig({ accountId: map.accountId, worker });
  }

  if (id === "RenderOrigin") {
    if (!env.BYE_WORKERS_DEV_NAME)
      throw new Error("RenderOrigin is only enabled for onboarding installations");

    return defineConfig({
      accountId: map.accountId,
      worker: {
        ...base,
        entrypoint: resolve(root, "workers/core/src/render-origin.ts"),
        env: { CORE: bindings.worker({ worker: core }) },
      },
    });
  }

  const source = scannerSignatureSource(env);

  const container = (
    logicalId: keyof typeof CONTAINER_LIMITS,
    image: string | undefined,
    context: string,
  ) =>
    defineContainer({
      name: required(map.containers, logicalId).name,
      schedulingPolicy: "default",
      ...CONTAINER_LIMITS[logicalId],
      image: image
        ? { reference: image }
        : {
            dockerfile: resolve(root, context, "Dockerfile"),
            buildContext: resolve(root, context),
          },
    });

  if (id === "SigMirror") {
    const job = container(
      "SigMirrorJob",
      prebuiltImage(env, "SIGMIRROR_IMAGE"),
      "containers/sigmirror",
    );

    return defineConfig({
      accountId: map.accountId,
      containers: [job],
      worker: {
        ...base,
        workersDev: false,
        entrypoint: resolve(root, "workers/sigmirror/src/index.ts"),
        domains: [],
        triggers: SIGMIRROR_CRONS.map((schedule) => triggers.scheduled({ schedule })),
        exports: { SigMirrorJob: exports.durableObject({ storage: "sqlite", container: job }) },
        env: {
          SIGNATURES: bucket("ClamSignatures"),
          WRITE_TOKEN: bindings.secret(),
          MIRROR_JOB: localDurableBinding("SigMirrorJob"),
        },
      },
    });
  }

  const scanner = container(
    "Scanner",
    source.mode === "baked" ? source.image : undefined,
    "containers/scanner",
  );

  const mime = container("MimeParser", prebuiltImage(env, "MIME_IMAGE"), "containers/mime");

  const runtime = Object.fromEntries(
    Object.entries(RUNTIME_CONFIG).map(([key, definition]) => [
      key === "MAIL_RENDER_ORIGIN" ? "MAIL_ORIGIN" : key,
      definition.secret
        ? bindings.secret()
        : key === "APP_ORIGIN" || key === "MAIL_RENDER_ORIGIN"
          ? origin(key)
          : text(key),
    ]),
  );

  if (stage.class === "preview" && !(env.MAIL_SANDBOX_DOMAINS ?? "").trim())
    throw new Error("preview mail sandbox domains are required");
  runtime.MAIL_SANDBOX_DOMAINS = bindings.text(
    stage.class === "preview" ? (env.MAIL_SANDBOX_DOMAINS ?? "") : "",
  );

  if (["prod", "staging"].includes(stage.name) && env.BYE_FAULT_INGRESS)
    throw new Error("ingress fault injection is forbidden on persistent stages");

  const durableExports = Object.fromEntries(
    HOSTED_NAMESPACES.flatMap((namespace) => {
      if (namespace.hostWorker !== id) return [];

      if (namespace.logicalId === "Scanner")
        return [
          [namespace.className, exports.durableObject({ storage: "sqlite", container: scanner })],
        ];

      if (namespace.logicalId === "MimeParser")
        return [
          [namespace.className, exports.durableObject({ storage: "sqlite", container: mime })],
        ];

      return [[namespace.className, exports.durableObject({ storage: "sqlite" })]];
    }),
  );

  const routedZone = mailRoutingZone(stage, env.MAIL_ZONE, env.BYE_MX_CUTOVER);

  return defineConfig({
    accountId: map.accountId,
    containers: [scanner, mime],
    worker: {
      ...base,
      entrypoint: resolve(root, "workers/core/src/index.ts"),
      domains: env.APP_DOMAIN ? [parseDomain(env.APP_DOMAIN)!] : [],
      assets: { runWorkerFirst: [...RUN_WORKER_FIRST] },
      triggers: [
        ...CORE_CRONS.map((schedule) => triggers.scheduled({ schedule })),
        ...queueTriggers(map),
        ...(routedZone ? [triggers.email({ addresses: [`*@${parseDomain(routedZone)}`] })] : []),
      ],
      exports: {
        ...durableExports,
        PublicGateway: exports.worker(),
        ...Object.fromEntries(
          Object.entries(WORKFLOWS).map(([logicalId, workflow]) => [
            workflow.exportName,
            exports.workflow({ name: required(map.workflows, logicalId).name }),
          ]),
        ),
      },
      env: {
        ...runtime,
        DIRECTORY: bindings.d1(required(map.d1, "Directory")),
        CONFIG_CACHE: bindings.kv(required(map.kv, "ConfigCache")),
        ...Object.fromEntries(
          ["Originals", "Parts", "Exports", "Published"].map((name) => [
            name.toUpperCase(),
            bucket(name),
          ]),
        ),
        ...Object.fromEntries(
          QUEUE_NAMES.map((name) => [
            QUEUES[name].binding,
            bindings.queue({ name: required(map.queues, name).name }),
          ]),
        ),
        ...Object.fromEntries(
          HOSTED_NAMESPACES.filter((namespace) => namespace.hostWorker === id).map((namespace) => [
            DURABLE_BINDINGS[namespace.logicalId as keyof typeof DURABLE_BINDINGS],
            localDurableBinding(namespace.className),
          ]),
        ),
        ...Object.fromEntries(
          Object.entries(WORKFLOWS).map(([logicalId, workflow]) => [
            workflow.binding,
            bindings.workflow({
              worker: core,
              name: required(map.workflows, logicalId).name,
              exportName: workflow.exportName,
            }),
          ]),
        ),
        AUTH_RATE_LIMIT: bindings.rateLimit({
          namespace: "1001",
          simple: { limit: 20, period: 60 },
        }),
        TRANSACTIONAL_EMAIL: bindings.sendEmail(),
        SIGMIRROR: bindings.worker({ worker: required(map.workers, "SigMirror").name }),
      },
    },
  });
};

export const projectConfig = (id: WorkerId): CloudflareConfig => {
  const stage = process.env.STAGE;
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const path = process.env.BYE_CF_RESOURCE_MAP;

  if (!stage || !accountId || !path)
    throw new Error("STAGE, CLOUDFLARE_ACCOUNT_ID and BYE_CF_RESOURCE_MAP are required");

  const map = loadResourceMap(path, stage, accountId);

  if (
    [...Object.values(map.d1), ...Object.values(map.kv), ...Object.values(map.queues)].some(
      (identity) => identity.id.startsWith("pending:"),
    )
  )
    throw new Error("Worker builds require provisioned resource IDs");

  return workerConfig(id, map, process.env);
};
