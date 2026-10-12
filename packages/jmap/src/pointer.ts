import { Option, Predicate, type Schema } from "effect";

// JSON Pointer evaluation for result references (RFC 8620 §3.7): RFC 6901 plus the `*` token,
// which maps the rest of the pointer over an array and flattens array results one level.

type Json = Schema.Json;

const unescape = (token: string): string => token.replaceAll("~1", "/").replaceAll("~0", "~");

const step = (value: Json, tokens: ReadonlyArray<string>): Option.Option<Json> => {
  if (tokens.length === 0) return Option.some(value);
  const [head, ...rest] = tokens as [string, ...Array<string>];

  if (Array.isArray(value)) {
    if (head === "*") {
      const out: Array<Json> = [];

      for (const item of value as ReadonlyArray<Json>) {
        const mapped = step(item, rest);

        if (Option.isNone(mapped)) return Option.none();

        if (Array.isArray(mapped.value)) out.push(...(mapped.value as ReadonlyArray<Json>));
        else out.push(mapped.value);
      }

      return Option.some(out);
    }

    if (!/^(0|[1-9][0-9]*)$/.test(head)) return Option.none();
    const item = (value as ReadonlyArray<Json>)[Number(head)];

    return item === undefined ? Option.none() : step(item, rest);
  }

  if (Predicate.isObject(value)) {
    const key = unescape(head);
    const record = value as Schema.JsonObject;

    return Object.hasOwn(record, key) ? step(record[key]!, rest) : Option.none();
  }

  return Option.none();
};

/** Evaluate `path` against `value`; none when any token doesn't resolve. */
export const evaluatePointer = (value: Json, path: string): Option.Option<Json> => {
  if (path === "") return Option.some(value);

  if (!path.startsWith("/")) return Option.none();

  return step(value, path.slice(1).split("/"));
};
