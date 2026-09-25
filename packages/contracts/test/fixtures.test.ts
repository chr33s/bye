import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { decodePropagatePayload } from "../src/index.ts";
import {
  CURRENT_FIXTURE_VERSION,
  exportedSchemas,
  FIXTURE_ROOT,
  fixtureSchemaName,
  goldenSamples,
  uncoveredMembers,
  unionMembers,
} from "./fixtures/generate.ts";

// §7.5: previous records (queue events, commands, HTTP responses, webhook payloads) keep decoding
// and round-trip byte-for-byte after any library or contract change. Fixtures in fixtures/v*/ are
// frozen goldens; a failing decode means a stored/queued/in-flight record would be rejected.

const versions = readdirSync(FIXTURE_ROOT)
  .filter((d) => /^v\d+$/.test(d))
  .sort();
const schemas = new Map(exportedSchemas());
const unions = [...schemas].filter(([, schema]) => unionMembers(schema).length > 0);
/** Schemas deliberately retired after an expand→migrate→contract cycle (name → reason). */
const RETIRED: Readonly<Record<string, string>> = {
  SubscriptionFeedbackEvent:
    "spec.md §5.5: the per-message subscription transport webhook is replaced by the authenticated NewsletterProvider event intake (/webhooks/newsletter); nothing stores or queues this payload",
};

describe("[A04] contract fixtures (§7.5)", () => {
  it("every exported schema has a current golden fixture (run `pnpm fixtures:contracts`)", () => {
    const current = new Set(
      readdirSync(join(FIXTURE_ROOT, CURRENT_FIXTURE_VERSION)).map(fixtureSchemaName),
    );
    expect([...schemas.keys()].filter((n) => !current.has(n))).toEqual([]);
  });

  for (const version of versions) {
    for (const file of readdirSync(join(FIXTURE_ROOT, version))
      .filter((f) => f.endsWith(".json"))
      .sort()) {
      const name = fixtureSchemaName(file);
      const label = file.replace(/\.json$/, "");
      // Retired schemas are reported as skipped, not silently passed.
      it.skipIf(RETIRED[name] !== undefined)(
        `${version}/${label} still decodes and round-trips`,
        () => {
          const schema = schemas.get(name);
          expect(
            schema,
            `${name} was removed or renamed; keep it or record it in RETIRED`,
          ).toBeDefined();
          const decode = Schema.decodeUnknownSync(schema as never) as unknown as (
            u: unknown,
          ) => unknown;
          const encode = Schema.encodeUnknownSync(schema as never) as unknown as (
            u: unknown,
          ) => unknown;
          for (const sample of JSON.parse(
            readFileSync(join(FIXTURE_ROOT, version, file), "utf8"),
          ) as Array<unknown>) {
            const decoded = decode(sample);
            expect(JSON.parse(JSON.stringify(encode(decoded)))).toEqual(sample);
          }
        },
      );
    }
  }

  it("covers the unions under test (the member check is not vacuous)", () => {
    expect(unions.map(([name]) => name)).toEqual(
      expect.arrayContaining(["PropagatePayload", "QueueMessage", "CalendarCommand"]),
    );
    expect(unionMembers(schemas.get("PropagatePayload")!)).toHaveLength(17);
    expect(unionMembers(schemas.get("QueueMessage")!)).toHaveLength(5);
  });

  for (const [name, schema] of unions) {
    it(`${name}: every union member has a golden (run \`pnpm fixtures:contracts\`)`, () => {
      expect(uncoveredMembers(schema, goldenSamples(name)).map((m) => m.label)).toEqual([]);
    });

    it(`${name}: rejects records that were never valid (the fixtures are not vacuous)`, () => {
      const decode = Schema.decodeUnknownSync(schema as never) as unknown as (
        u: unknown,
      ) => unknown;
      expect(() => decode("__never_a_member__")).toThrow();
      expect(() => decode({})).toThrow();
      // Corrupt each golden's discriminant(s): the union must not fall back to another member.
      for (const sample of goldenSamples(name)) {
        if (sample === null || typeof sample !== "object") continue;
        const corrupted = Object.fromEntries(
          Object.entries(sample).map(([k, v]) =>
            ["type", "topic", "kind", "op", "_tag"].includes(k) ? [k, "__never__"] : [k, v],
          ),
        );
        if (JSON.stringify(corrupted) !== JSON.stringify(sample))
          expect(() => decode(corrupted), JSON.stringify(sample)).toThrow();
      }
    });
  }

  it("QueueMessage rejects unknown versions and types", () => {
    const queue = schemas.get("QueueMessage")!;
    const decode = Schema.decodeUnknownSync(queue as never) as unknown as (u: unknown) => unknown;
    expect(() => decode({ schemaVersion: 2, type: "dispatch" })).toThrow();
    expect(() => decode({ schemaVersion: 1, type: "unknown-type", eventId: "e" })).toThrow();
  });
});

describe("decodePropagatePayload (lenient v1 reader)", () => {
  it("the payload's own topic wins over the envelope topic", () => {
    const result = decodePropagatePayload({
      topic: "scan",
      payload: { topic: "probe.echo", probeId: "p1", key: "k", uploadId: "u" },
    });
    expect(result).toEqual({ ok: true, payload: { topic: "probe.echo", probeId: "p1" } });
  });

  it("falls back to the envelope topic when the payload has none", () => {
    expect(decodePropagatePayload({ topic: "scan", payload: { key: "k", uploadId: "u" } })).toEqual(
      { ok: true, payload: { topic: "scan", key: "k", uploadId: "u" } },
    );
  });

  it("reports the payload topic when the payload does not match it", () => {
    const result = decodePropagatePayload({
      topic: "probe.echo",
      payload: { topic: "scan", probeId: "p1" },
    });
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ ok: false, topic: "scan" });
  });

  it("rejects non-object payloads and unknown topics", () => {
    expect(decodePropagatePayload({ topic: "probe.echo", payload: null })).toMatchObject({
      ok: false,
      topic: "probe.echo",
    });
    expect(decodePropagatePayload({ topic: "nope", payload: {} })).toMatchObject({
      ok: false,
      topic: "nope",
    });
  });
});
