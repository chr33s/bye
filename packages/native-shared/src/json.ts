/** A parsed JSON value: the named result of decoding a wire payload. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | ReadonlyArray<JsonValue>
  | { readonly [key: string]: JsonValue };

/** A parsed JSON object. */
export type JsonObject = { readonly [key: string]: JsonValue };

/** A value about to be serialized as JSON: like `JsonValue`, but optional members may be absent. */
export type JsonInput =
  | string
  | number
  | boolean
  | null
  | undefined
  | ReadonlyArray<JsonInput>
  | { readonly [key: string]: JsonInput };
