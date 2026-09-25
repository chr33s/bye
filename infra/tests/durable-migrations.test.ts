const nextTag = (steps: ReadonlyArray<{ readonly tag: string }>) =>
  `v${Math.max(...steps.map((s) => Number(s.tag.slice(1)))) + 1}`;
import { describe, expect, it } from "vitest";
import {
  CLASS_MIGRATIONS,
  CLASS_MIGRATIONS_BY_HOST,
  compareManifests,
  HOSTED_NAMESPACES,
  liveClasses,
} from "../migrations/durable/durable-class-migrations.ts";

describe("Durable Object class migrations (§15.9)", () => {
  it("registers every hosted authority class as a SQLite class", () => {
    for (const [host, steps] of Object.entries(CLASS_MIGRATIONS_BY_HOST)) {
      expect(liveClasses(steps), host).toEqual(
        HOSTED_NAMESPACES.filter((n) => n.hostWorker === host)
          .map((n) => n.className)
          .sort(),
      );
    }
    expect(new Set(HOSTED_NAMESPACES.map((n) => n.hostWorker))).toEqual(
      new Set(Object.keys(CLASS_MIGRATIONS_BY_HOST)),
    );
    expect(CLASS_MIGRATIONS[0]?.newSqliteClasses).toContain("MailboxDO");
  });

  it("accepts appending a new class", () => {
    const next = [
      ...CLASS_MIGRATIONS,
      { tag: nextTag(CLASS_MIGRATIONS), newSqliteClasses: ["ThreadDO"] },
    ];
    expect(compareManifests(CLASS_MIGRATIONS, next)).toEqual([]);
  });

  it("rejects removing, renaming, or rewriting released classes without approval", () => {
    expect(
      compareManifests(CLASS_MIGRATIONS, [{ tag: "v1", newSqliteClasses: ["CalendarDO"] }]).length,
    ).toBeGreaterThan(0);
    const renamed = [
      ...CLASS_MIGRATIONS,
      {
        tag: nextTag(CLASS_MIGRATIONS),
        renamedClasses: [{ from: "MailboxDO", to: "MailboxDOv2" }],
      },
    ];
    expect(compareManifests(CLASS_MIGRATIONS, renamed).map((i) => i.message)).toContain(
      "renaming MailboxDO requires an approved decommission",
    );
    const deleted = [
      ...CLASS_MIGRATIONS,
      { tag: nextTag(CLASS_MIGRATIONS), deletedClasses: ["SearchShardDO"] },
    ];
    expect(compareManifests(CLASS_MIGRATIONS, deleted).length).toBeGreaterThan(0);
    expect(compareManifests(CLASS_MIGRATIONS, deleted, ["SearchShardDO"])).toEqual([]);
    expect(
      compareManifests(CLASS_MIGRATIONS, [...CLASS_MIGRATIONS, { tag: "v1" }]).map(
        (i) => i.message,
      ),
    ).toContain("duplicate migration tags");
  });
});
