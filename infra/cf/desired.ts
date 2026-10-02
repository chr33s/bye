import { Predicate } from "effect";
import type { WorkerConfig } from "cf/config";
import {
  CONTAINER_LIMITS,
  workerConfig,
  type WorkerId,
  type WorkerProject,
} from "./config/workers.ts";
import { HOSTED_NAMESPACES, WORKFLOWS } from "./inventory.ts";
import { decode, Resource, type ResourceMap } from "./schemas.ts";
import { canonical, digest } from "./plan-normalize.ts";

export const MULTIPART_LIFECYCLE = [
  {
    id: "abort-stale-multipart",
    abortMultipartUploadsTransition: { condition: { type: "Age", maxAge: 7 * 24 * 3600 } },
  },
];

export const configuredWorker = (config: WorkerProject): WorkerConfig => config.worker;

/** Account resource/settings inventory plus Worker config. No provider execution or state store. */
export const desiredResources = (
  map: ResourceMap,
  values: Readonly<Record<string, string | undefined>>,
): ReadonlyArray<Resource> => {
  const resources: Array<Resource> = [];

  const add = (
    logicalId: string,
    type: string,
    identity: Record<string, string>,
    settings: Resource["settings"] = {},
    extra: Partial<Resource> = {},
  ) => {
    resources.push({ logicalId, type, stage: map.stage, identity, settings, ...extra });
  };

  for (const [logicalId, identity] of Object.entries(map.d1))
    add(logicalId, "Cloudflare.D1.Database", { ...identity });

  for (const [logicalId, identity] of Object.entries(map.kv))
    add(logicalId, "Cloudflare.KV.Namespace", { ...identity });

  for (const [logicalId, identity] of Object.entries(map.r2))
    add(
      logicalId,
      "Cloudflare.R2.Bucket",
      { ...identity },
      {
        publicAccess: false,
        lifecycleRules: ["Parts", "Exports"].includes(logicalId) ? MULTIPART_LIFECYCLE : [],
      },
    );

  for (const [logicalId, identity] of Object.entries(map.queues))
    add(logicalId, "Cloudflare.Queues.Queue", { ...identity });

  for (const logicalId of [
    "SigMirror",
    "MailCore",
    "PublicSite",
    ...(values.BYE_WORKERS_DEV_NAME ? ["RenderOrigin"] : []),
  ] as ReadonlyArray<WorkerId>) {
    const config = workerConfig(logicalId, map, values);
    const worker = configuredWorker(config);
    const { entrypoint: _entrypoint, env, ...owned } = worker;

    // Containers are represented by stable application/class identities below. Worker export
    // settings use references rather than copying image/build context objects into plan evidence.
    const exports = Object.fromEntries(
      Object.entries(worker.exports ?? {}).map(([name, declaration]) => {
        if (
          declaration.type === "durable-object" &&
          "container" in declaration &&
          declaration.container
        ) {
          const { container: _container, ...rest } = declaration;

          return [
            name,
            {
              ...rest,
              container: HOSTED_NAMESPACES.find((ns) => ns.className === name)?.logicalId ?? name,
            },
          ];
        }

        return [name, declaration];
      }),
    );

    // Runtime text bindings may contain user-provided secrets accidentally. Evidence records
    // only their digest; declared secret bindings never read process values.
    const safeEnv = Object.fromEntries(
      Object.entries(env ?? {}).map(([name, binding]) => [
        name,
        binding.type === "text" ? { type: "text", digest: digest(binding.value) } : binding,
      ]),
    );

    const settings = decode(
      Resource.fields.settings,
      JSON.parse(
        JSON.stringify({
          ...owned,
          triggers: [...(worker.triggers ?? [])].sort((a, b) =>
            canonical(a).localeCompare(canonical(b)),
          ),
          exports,
          env: safeEnv,
        }),
      ),
    );

    add(logicalId, "Cloudflare.Worker", { name: worker.name }, settings, {
      bindings: Object.keys(worker.env ?? {}).sort(),
      references: Object.entries(worker.env ?? {}).flatMap(([, binding]) =>
        binding.type === "worker" && Predicate.isString(binding.worker)
          ? [
              {
                stage: map.stage,
                logicalId:
                  Object.entries(map.workers).find(([, id]) => id.name === binding.worker)?.[0] ??
                  binding.worker,
              },
            ]
          : [],
      ),
    });

    for (const namespace of HOSTED_NAMESPACES.filter(
      (namespace) => namespace.hostWorker === logicalId,
    )) {
      const container = map.containers[namespace.logicalId];

      const expected = {
        hostWorker: worker.name,
        className: namespace.className,
        storage: "sqlite",
      };

      const adopted = map.durableObjects?.[namespace.logicalId];

      if (
        adopted &&
        (adopted.hostWorker !== expected.hostWorker ||
          adopted.className !== expected.className ||
          adopted.storage !== expected.storage)
      )
        throw new Error(`adopted namespace identity conflicts with config: ${namespace.logicalId}`);
      const identity = adopted ? { ...expected, namespaceId: adopted.namespaceId } : expected;

      if (container) {
        const containerIdentity = { ...identity, ...container };
        const limits = CONTAINER_LIMITS[namespace.logicalId as keyof typeof CONTAINER_LIMITS];

        const envName = {
          Scanner: "SCANNER_IMAGE",
          MimeParser: "MIME_IMAGE",
          SigMirrorJob: "SIGMIRROR_IMAGE",
        }[namespace.logicalId];

        add(namespace.logicalId, "Cloudflare.Container", containerIdentity, {
          schedulingPolicy: "default",
          ...limits,
          image: values[envName ?? ""] ?? "build-context",
        });
      } else add(namespace.logicalId, "Cloudflare.DurableObject", identity);
    }

    if (logicalId === "MailCore") {
      for (const [workflowId, workflow] of Object.entries(WORKFLOWS)) {
        const name = map.workflows[workflowId]?.name;

        if (!name) throw new Error(`missing Workflow ${workflowId}`);
        add(workflowId, "Cloudflare.Workflow", {
          name,
          exportName: workflow.exportName,
          hostWorker: worker.name,
        });
      }

      for (const trigger of worker.triggers ?? []) {
        if (trigger.type === "queue") {
          const queue = Object.entries(map.queues).find(
            ([, identity]) => identity.name === trigger.name,
          );

          if (!queue) throw new Error("Queue trigger has no resolved identity");
          const { type: _type, name: _name, ...policy } = trigger;
          add(
            `${queue[0]}Consumer`,
            "Cloudflare.Queues.Consumer",
            { queueId: queue[1].id, hostWorker: worker.name },
            policy,
          );
        }
      }
    }
  }

  // Binding-only inventory remains policy-facing and visible to onboarding scope coverage.
  add("TransactionalEmail", "Cloudflare.Email.SendEmail", {
    hostWorker: map.workers.MailCore!.name,
  });

  for (const limiter of [
    { logicalId: "AuthRateLimit", namespace: "1001", worker: "MailCore" },
    { logicalId: "PublicRateLimit", namespace: "1002", worker: "PublicSite" },
    { logicalId: "SubscribeRateLimit", namespace: "1003", worker: "PublicSite" },
  ])
    add(limiter.logicalId, "Cloudflare.RateLimit", {
      namespace: limiter.namespace,
      hostWorker: map.workers[limiter.worker]!.name,
    });

  return resources;
};
