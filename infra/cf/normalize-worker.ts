import { Schema } from "effect";
import { record, rows, stringField } from "./discover.ts";
import { decode, JsonObject, type Resource } from "./schemas.ts";
import { digest } from "./plan-normalize.ts";

/** Product binding encodings -> config-owned fields. Plaintext is hashed, secret values never inspected. */
export const normalizedBindings = (
  input: Schema.Schema.Type<typeof Schema.Json> | undefined,
  hostWorker: string,
  databaseNames: Readonly<Record<string, string>>,
) =>
  decode(
    JsonObject,
    Object.fromEntries(
      rows(input)
        .map((binding) => {
          const name = stringField(binding, "name");
          const type = stringField(binding, "type");
          let result: Resource["settings"];

          switch (type) {
            case "plain_text":
              result = { type: "text", digest: digest(decode(Schema.String, binding.text)) };
              break;
            case "secret_text":
            case "secret_key":
              result = { type: "secret" };
              break;
            case "d1": {
              const id = stringField(binding, "id");

              if (!databaseNames[id])
                throw new Error("D1 Worker binding is not in the resolved resource inventory");
              result = { type: "d1", id, name: databaseNames[id] };
              break;
            }

            case "kv_namespace":
              result = { type: "kv", id: stringField(binding, "namespace_id") };
              break;
            case "r2_bucket":
              result = { type: "r2", name: stringField(binding, "bucket_name") };
              break;
            case "queue":
              result = { type: "queue", name: stringField(binding, "queue_name") };
              break;
            case "durable_object_namespace": {
              if (binding.script_name && binding.script_name !== hostWorker)
                throw new Error("unexpected remote DO host");
              result = {
                type: "unsafe:durable_object_namespace",
                class_name: stringField(binding, "class_name"),
              };
              break;
            }

            case "workflow":
              result = {
                type: "workflow",
                name: stringField(binding, "workflow_name"),
                worker: binding.script_name ? stringField(binding, "script_name") : hostWorker,
                exportName: stringField(binding, "class_name"),
              };
              break;
            case "service":
              result = { type: "worker", worker: stringField(binding, "service") };

              if (binding.entrypoint)
                result = { ...result, exportName: stringField(binding, "entrypoint") };
              break;
            case "ratelimit":
              result = {
                type: "rate-limit",
                namespace: stringField(binding, "namespace_id"),
                simple: decode(JsonObject, binding.simple),
              };
              break;
            case "send_email":
              if (binding.destination_address || binding.allowed_destination_addresses)
                throw new Error(
                  "send-email destination restrictions require explicit owned configuration",
                );
              result = { type: "send-email" };

              if (binding.allowed_sender_addresses)
                result = {
                  ...result,
                  allowedSenderAddresses: decode(
                    Schema.Array(Schema.String),
                    binding.allowed_sender_addresses,
                  ),
                };
              break;
            case "assets":
              return [name, null];
            default:
              throw new Error(`unsupported live Worker binding ${type}`);
          }

          return [name, result];
        })
        .filter(([, value]) => value !== null),
    ),
  );

export const normalizeObservability = (
  input: Schema.Schema.Type<typeof Schema.Json> | undefined,
) => {
  const value = record(input);
  const logs = record(value.logs);
  const traces = record(value.traces);

  return {
    enabled: decode(Schema.Boolean, value.enabled),
    headSamplingRate: decode(Schema.Number, value.head_sampling_rate),
    logs: {
      enabled: decode(Schema.Boolean, logs.enabled),
      invocationLogs: decode(Schema.Boolean, logs.invocation_logs),
      persist: decode(Schema.Boolean, logs.persist),
    },
    traces: { enabled: decode(Schema.Boolean, traces.enabled) },
  };
};
