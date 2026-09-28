import { Schema } from "effect";

/** Decode an already-parsed body against a contract schema; `null` when it doesn't conform. */
export const decodeAs = <S extends Schema.Codec<unknown, unknown>, V>(
  schema: S,
  value: V,
): S["Type"] | null => {
  try {
    return Schema.decodeUnknownSync(schema as never)(value) as S["Type"];
  } catch {
    return null;
  }
};

/** Decode a JSON text body against a contract schema; `null` when it is not JSON or doesn't conform. */
export const decodeBody = <S extends Schema.Codec<unknown, unknown>>(
  schema: S,
  body: string,
): S["Type"] | null => {
  let value: unknown;

  try {
    value = JSON.parse(body);
  } catch {
    return null;
  }

  return decodeAs(schema, value);
};
