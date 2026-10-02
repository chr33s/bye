import { Schema } from "effect";
import { requireStage } from "../resources/stage.ts";

export const JsonObject = Schema.Record(Schema.String, Schema.Json);

const Identity = Schema.Record(Schema.String, Schema.NonEmptyString);

export const Resource = Schema.Struct({
  logicalId: Schema.NonEmptyString,
  type: Schema.NonEmptyString,
  stage: Schema.NonEmptyString,
  identity: Identity,
  settings: Schema.Record(Schema.String, Schema.Json),
  bindings: Schema.optionalKey(Schema.Array(Schema.String)),
  references: Schema.optionalKey(
    Schema.Array(Schema.Struct({ stage: Schema.String, logicalId: Schema.String })),
  ),
});

export interface Resource extends Schema.Schema.Type<typeof Resource> {}

export const Snapshot = Schema.Struct({
  format: Schema.Literal("bye.cf-discovery.v1"),
  stage: Schema.NonEmptyString,
  accountId: Schema.NonEmptyString,
  resources: Schema.Array(Resource),
  // Missing API coverage is a blocker, never an empty result interpreted as absence.
  blockers: Schema.Array(Schema.String),
  executionState: Schema.optionalKey(JsonObject),
});

export interface Snapshot extends Schema.Schema.Type<typeof Snapshot> {}

export const Adoption = Schema.Struct({
  format: Schema.Literal("bye.cf-adoption.v1"),
  namingVersion: Schema.Literal(1),
  stage: Schema.NonEmptyString,
  accountId: Schema.NonEmptyString,
  resources: Schema.Array(Resource),
});

export interface Adoption extends Schema.Schema.Type<typeof Adoption> {}

export const ResourceMap = Schema.Struct({
  format: Schema.Literal("bye.cf-resources.v1"),
  stage: Schema.NonEmptyString,
  accountId: Schema.NonEmptyString,
  workers: Schema.Record(Schema.String, Schema.Struct({ name: Schema.NonEmptyString })),
  d1: Schema.Record(
    Schema.String,
    Schema.Struct({ id: Schema.NonEmptyString, name: Schema.NonEmptyString }),
  ),
  kv: Schema.Record(Schema.String, Schema.Struct({ id: Schema.NonEmptyString })),
  r2: Schema.Record(Schema.String, Schema.Struct({ name: Schema.NonEmptyString })),
  queues: Schema.Record(
    Schema.String,
    Schema.Struct({ id: Schema.NonEmptyString, name: Schema.NonEmptyString }),
  ),
  workflows: Schema.Record(Schema.String, Schema.Struct({ name: Schema.NonEmptyString })),
  containers: Schema.Record(
    Schema.String,
    Schema.Struct({
      name: Schema.NonEmptyString,
      applicationId: Schema.optionalKey(Schema.NonEmptyString),
    }),
  ),
  durableObjects: Schema.optionalKey(
    Schema.Record(
      Schema.String,
      Schema.Struct({
        namespaceId: Schema.NonEmptyString,
        className: Schema.NonEmptyString,
        hostWorker: Schema.NonEmptyString,
        storage: Schema.Literal("sqlite"),
      }),
    ),
  ),
});

export interface ResourceMap extends Schema.Schema.Type<typeof ResourceMap> {}

/** Refuse extra keys too: a manifest must not become a covert secret store. */
export const decode = <S extends Schema.ConstraintDecoder<unknown, never>, T>(
  schema: S,
  value: T,
): S["Type"] => {
  try {
    return Schema.decodeUnknownSync(schema)(value, { onExcessProperty: "error" });
  } catch {
    throw new Error("Cloudflare artifact/response failed schema validation");
  }
};

export const assertBoundary = (
  value: { readonly stage: string; readonly accountId: string },
  stage: string,
  accountId: string,
): void => {
  requireStage(stage);

  if (!accountId || value.stage !== stage || value.accountId !== accountId)
    throw new Error("resource metadata does not match the selected stage/account");
};

/** Secret bindings have presence/name only. Raw API responses never become artifacts. */
export const assertNoSecrets = <T>(input: T): void => {
  const value = decode(Schema.Json, input);

  if (Array.isArray(value)) {
    value.forEach(assertNoSecrets);

    return;
  }

  if (value === null || !Schema.is(JsonObject)(value)) return;
  const record = value;

  if (
    (record.type === "secret" || record.type === "secret_text" || record.type === "secret_key") &&
    Object.keys(record).some((key) => !["type", "name", "present"].includes(key))
  )
    throw new Error("secret binding contains a value");

  for (const [key, nested] of Object.entries(record)) {
    if (
      /^(secret|secretValue|secret_value|apiToken|api_token|token|password|authorization|private_key)$/i.test(
        key,
      )
    )
      throw new Error("secret values are forbidden in Cloudflare artifacts");
    assertNoSecrets(nested);
  }
};
