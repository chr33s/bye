// Golden contract fixtures (§7.5). For every exported Schema in @bye/contracts, write seeded,
// encoded samples to fixtures/v<CURRENT>/<Name>.json — ONLY when the file does not exist yet.
// Existing fixtures are frozen: they are the "previous records" every future release must still
// decode. New schemas get fixtures by running `pnpm fixtures:contracts`.
//
// Random sampling alone may miss members of a union (e.g. 2 of 17 propagate topics), so every
// member of an exported union that no existing golden covers also gets its own frozen file,
// fixtures/v<CURRENT>/<Name>@<member>.json, decoded through the whole union schema.
//
// Usage: node --experimental-strip-types packages/contracts/test/fixtures/generate.ts
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import * as Arbitrary from "effect/unstable/arbitrary/Arbitrary";
import * as Contracts from "../../src/index.ts";

export const CURRENT_FIXTURE_VERSION = "v1";
export const FIXTURE_ROOT = import.meta.dirname;

export const exportedSchemas = (): ReadonlyArray<readonly [string, Schema.Top]> =>
  Object.entries(Contracts as Record<string, unknown>)
    .filter((entry): entry is [string, Schema.Top] => Schema.isSchema(entry[1]))
    .sort(([a], [b]) => a.localeCompare(b));

/** Schema name a fixture file belongs to: `Name.json` or `Name@member.json`. */
export const fixtureSchemaName = (file: string): string => file.replace(/(@[^/]*)?\.json$/, "");

export interface UnionMember {
  /** Filename-safe discriminant: the member's distinguishing literal(s), or the literal itself. */
  readonly label: string;
  readonly schema: Schema.Top;
}

/** Members of a top-level union schema (tagged structs or literals); [] for anything else. */
export const unionMembers = (schema: Schema.Top): ReadonlyArray<UnionMember> => {
  const ast = schema.ast as unknown as { _tag: string; types?: ReadonlyArray<AnyAst> };
  if (ast._tag !== "Union" || !ast.types) return [];
  const literalsOf = (member: AnyAst): Record<string, unknown> =>
    Object.fromEntries(
      (member.propertySignatures ?? [])
        .filter((p) => p.type._tag === "Literal")
        .map((p) => [String(p.name), p.type.literal]),
    );
  const all = ast.types.map(literalsOf);
  // A literal property shared with the same value by every member (e.g. schemaVersion) is not a
  // discriminant; keep only the ones that tell members apart.
  const shared = (key: string, value: unknown) => all.every((l) => key in l && l[key] === value);
  return ast.types.map((member, i) => {
    const raw =
      member._tag === "Literal"
        ? String(member.literal)
        : Object.entries(all[i]!)
            .filter(([k, v]) => !shared(k, v))
            .map(([, v]) => String(v))
            .join("-") || String(i);
    return {
      label: raw.replace(/[^\w.-]/g, "_"),
      schema: Schema.make<Schema.Top>(member as never),
    };
  });
};

interface AnyAst {
  readonly _tag: string;
  readonly literal?: unknown;
  readonly propertySignatures?: ReadonlyArray<{
    readonly name: PropertyKey;
    readonly type: { readonly _tag: string; readonly literal?: unknown };
  }>;
}

/** Every golden sample recorded for `name`, across all versions and member files. */
export const goldenSamples = (name: string): ReadonlyArray<unknown> =>
  readdirSync(FIXTURE_ROOT)
    .filter((d) => /^v\d+$/.test(d))
    .flatMap((version) =>
      readdirSync(join(FIXTURE_ROOT, version))
        .filter((f) => f.endsWith(".json") && fixtureSchemaName(f) === name)
        .flatMap(
          (f) => JSON.parse(readFileSync(join(FIXTURE_ROOT, version, f), "utf8")) as Array<unknown>,
        ),
    );

/** Union members of `schema` that none of the given encoded goldens decodes to. */
export const uncoveredMembers = (
  schema: Schema.Top,
  samples: ReadonlyArray<unknown>,
): ReadonlyArray<UnionMember> => {
  const decode = Schema.decodeUnknownSync(schema as never) as unknown as (u: unknown) => unknown;
  const decoded = samples.flatMap((s) => {
    try {
      return [decode(s)];
    } catch {
      return [];
    }
  });
  return unionMembers(schema).filter((m) => !decoded.some((d) => Schema.is(m.schema as never)(d)));
};

export const sampleEncoded = async (
  name: string,
  schema: Schema.Top,
  count = 3,
): Promise<ReadonlyArray<unknown>> => {
  const encode = Schema.encodeUnknownSync(schema as never) as unknown as (v: unknown) => unknown;
  const decode = Schema.decodeUnknownSync(schema as never) as unknown as (u: unknown) => unknown;
  // Fixtures are exactly what crosses a wire or storage boundary, so keep only samples that
  // survive JSON (e.g. drop NaN/Infinity, which JSON cannot carry).
  const survivesJson = (v: unknown) => {
    try {
      const wire = JSON.parse(JSON.stringify(encode(v)));
      return JSON.stringify(encode(decode(wire))) === JSON.stringify(wire);
    } catch {
      return false;
    }
  };
  const out: Array<unknown> = [];
  for (let attempt = 0; out.length < count && attempt < 20; attempt++) {
    const values = await Effect.runPromise(
      Arbitrary.sampleEffect(Arbitrary.schema(schema), {
        count: count * 3,
        seed: `${name}#${attempt}`,
        size: 4,
      }),
    );
    for (const v of values)
      if (out.length < count && survivesJson(v)) out.push(JSON.parse(JSON.stringify(encode(v))));
  }
  return out;
};

if (import.meta.main) {
  const dir = join(FIXTURE_ROOT, CURRENT_FIXTURE_VERSION);
  mkdirSync(dir, { recursive: true });
  let written = 0;
  for (const [name, schema] of exportedSchemas()) {
    const file = join(dir, `${name}.json`);
    try {
      if (!existsSync(file)) {
        writeFileSync(file, `${JSON.stringify(await sampleEncoded(name, schema), null, 2)}\n`);
        written++;
      }
      // Encode member samples through the whole union so the file is exactly what the union
      // schema would put on the wire.
      const encode = Schema.encodeUnknownSync(schema as never) as unknown as (
        v: unknown,
      ) => unknown;
      const decodeMember = (m: UnionMember) =>
        Schema.decodeUnknownSync(m.schema as never) as unknown as (u: unknown) => unknown;
      for (const member of uncoveredMembers(schema, goldenSamples(name))) {
        const memberFile = join(dir, `${name}@${member.label}.json`);
        if (existsSync(memberFile)) continue;
        const samples = (await sampleEncoded(`${name}@${member.label}`, member.schema, 1)).map(
          (s) => JSON.parse(JSON.stringify(encode(decodeMember(member)(s)))),
        );
        if (samples.length === 0) throw new Error(`no JSON-safe sample for member ${member.label}`);
        writeFileSync(memberFile, `${JSON.stringify(samples, null, 2)}\n`);
        written++;
      }
    } catch (error) {
      console.error(
        `fixtures: ${name}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`,
      );
      process.exitCode = 1;
    }
  }
  console.log(`fixtures: wrote ${written} new file(s) to ${dir}`);
}
