import type { JsonObject, JsonValue } from "@bye/native-shared/json";
import { Predicate } from "effect";

export type { JsonObject, JsonValue };

export const isJsonObject = (value: JsonValue | undefined): value is JsonObject =>
  Predicate.isObject(value);

export const isJsonArray = (value: JsonValue | undefined): value is ReadonlyArray<JsonValue> =>
  Array.isArray(value);
