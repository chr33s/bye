import { Option, Predicate, Schema } from "effect";

// Opaque state tokens (spec.md §16 C1). A token binds the account, the data type, the restore
// generation, the principal visibility generation and a monotonic revision; query states also bind
// the normalized query and the canonical index generation. Revisions travel as decimal strings so
// no value loses precision, and no timestamp or process epoch stands in for a revision.

export interface StateDomain {
  readonly accountId: string;
  readonly type: string;
  readonly restoreGeneration: number;
  /** Principal visibility/ACL generation; 0 where the type has no principal-scoped visibility. */
  readonly visibilityGeneration: number;
  /** Writer epoch (C3): the projection and the core never share a revision lineage. */
  readonly writerEpoch?: number;
  readonly revision: bigint;
  /**
   * Intermediate `/changes` position (C1 pagination): changes in (base, revision] for object IDs
   * after `cursor` are still to be returned. Absent on complete states.
   */
  readonly page?: { readonly base: bigint; readonly cursor: string };
}

export interface QueryStateDomain extends StateDomain {
  /** Digest of the normalized filter/sort/collapse parameters (`queryDigest`). */
  readonly query: string;
  readonly indexGeneration: number;
}

const TOKEN_VERSION = "1";

const Token = Schema.Struct({
  v: Schema.Literal(TOKEN_VERSION),
  a: Schema.String,
  t: Schema.String,
  g: Schema.Number,
  p: Schema.Number,
  r: Schema.String,
  q: Schema.optional(Schema.String),
  i: Schema.optional(Schema.Number),
  b: Schema.optional(Schema.String),
  e: Schema.optional(Schema.Number),
  c: Schema.optional(Schema.String),
});

const REVISION = /^(0|[1-9][0-9]{0,30})$/;

const decodeToken = Schema.decodeUnknownOption(Schema.fromJsonString(Token));

const base64url = (text: string): string =>
  btoa(String.fromCharCode(...new TextEncoder().encode(text)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");

const unbase64url = (token: string): Option.Option<string> => {
  if (!/^[A-Za-z0-9_-]{1,2048}$/.test(token)) return Option.none();

  try {
    const binary = atob(token.replaceAll("-", "+").replaceAll("_", "/"));

    return Option.some(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
        Uint8Array.from(binary, (c) => c.charCodeAt(0)),
      ),
    );
  } catch {
    return Option.none();
  }
};

export const encodeState = (domain: StateDomain): string =>
  base64url(
    JSON.stringify({
      v: TOKEN_VERSION,
      a: domain.accountId,
      t: domain.type,
      g: domain.restoreGeneration,
      p: domain.visibilityGeneration,
      r: domain.revision.toString(),
      e: domain.writerEpoch ?? 0,
      ...(domain.page ? { b: domain.page.base.toString(), c: domain.page.cursor } : undefined),
    }),
  );

export const encodeQueryState = (domain: QueryStateDomain): string =>
  base64url(
    JSON.stringify({
      v: TOKEN_VERSION,
      a: domain.accountId,
      t: domain.type,
      g: domain.restoreGeneration,
      p: domain.visibilityGeneration,
      r: domain.revision.toString(),
      e: domain.writerEpoch ?? 0,
      q: domain.query,
      i: domain.indexGeneration,
    }),
  );

/** Decode a state token; none for anything this server didn't mint. */
export const decodeState = (token: string): Option.Option<StateDomain> =>
  Option.flatMap(unbase64url(token), (text) =>
    Option.flatMap(decodeToken(text), (t) =>
      REVISION.test(t.r) && (t.b === undefined || (REVISION.test(t.b) && t.c !== undefined))
        ? Option.some(
            t.b === undefined
              ? {
                  accountId: t.a,
                  type: t.t,
                  restoreGeneration: t.g,
                  visibilityGeneration: t.p,
                  writerEpoch: t.e ?? 0,
                  revision: BigInt(t.r),
                }
              : {
                  accountId: t.a,
                  type: t.t,
                  restoreGeneration: t.g,
                  visibilityGeneration: t.p,
                  writerEpoch: t.e ?? 0,
                  revision: BigInt(t.r),
                  page: { base: BigInt(t.b), cursor: t.c ?? "" },
                },
          )
        : Option.none(),
    ),
  );

/**
 * Whether `since` names exactly the same account, type and generations as `current`, so its
 * revision is comparable. A token from another generation can never be compared (C1, C2).
 */
export const sameStateLineage = (since: StateDomain, current: StateDomain): boolean =>
  since.accountId === current.accountId &&
  since.type === current.type &&
  since.restoreGeneration === current.restoreGeneration &&
  since.visibilityGeneration === current.visibilityGeneration &&
  (since.writerEpoch ?? 0) === (current.writerEpoch ?? 0);

/** Canonical JSON (sorted keys), so equivalent queries normalize to the same digest. */
export const canonicalJson = (value: Schema.Json): string => {
  if (Array.isArray(value))
    return `[${(value as ReadonlyArray<Schema.Json>).map(canonicalJson).join(",")}]`;

  if (Predicate.isObject(value)) {
    const record = value as Schema.JsonObject;

    return `{${Object.keys(record)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k]!)}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
};

/** Stable digest of normalized query parameters (two FNV-1a lanes; identity, not a MAC). */
export const queryDigest = (value: Schema.Json): string => {
  const text = canonicalJson(value);
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ text.length;

  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x5bd1e995);
  }

  return `${(a >>> 0).toString(16).padStart(8, "0")}${(b >>> 0).toString(16).padStart(8, "0")}`;
};
