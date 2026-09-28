import { describe, expect, it } from "vitest";
import { hasCoreDatabases, isMirrorFile, planSync, seedNames } from "../src/sync.ts";

describe("signature mirror job planning", () => {
  const remote = {
    "main.cvd": { size: 10, etag: '"aaa"' },
    "daily.cvd": { size: 5, etag: "bbb" },
    "daily-100.cdiff": { size: 1, etag: "c1" },
    "daily-100.cdiff.sign": { size: 1, etag: "s1" },
    "daily-101.cdiff": { size: 1, etag: "c2" },
  };

  it("[E20] seeds only whole databases so cvdupdate fetches deltas upstream", () => {
    expect(seedNames(remote)).toEqual(["daily.cvd", "main.cvd"]);
  });

  it("[E20] uploads new or changed files, skips identical ones, prunes retired CDIFFs only", () => {
    const plan = planSync(
      [
        { name: "main.cvd", size: 10, md5: "aaa" },
        { name: "daily.cvd", size: 6, md5: "ccc" },
        { name: "daily-101.cdiff", size: 1, md5: "c2" },
        { name: "daily-102.cdiff", size: 1, md5: "c3" },
        { name: "freshclam.dat", size: 1, md5: "x" },
        { name: "notes.exe", size: 1, md5: "y" },
      ],
      remote,
      { succeeded: true },
    );

    expect(plan.upload).toEqual(["daily-102.cdiff", "daily.cvd", "freshclam.dat"]);
    expect(plan.unchanged).toBe(2);
    expect(plan.prune).toEqual(["daily-100.cdiff", "daily-100.cdiff.sign"]);
  });

  const complete = [
    { name: "main.cvd", size: 10, md5: "aaa" },
    { name: "daily.cvd", size: 5, md5: "bbb" },
  ];

  it("[E20] prunes exactly the retired CDIFFs, never whole databases", () => {
    // Local has only the databases: every remote CDIFF (and signature) is retired; CVDs stay.
    expect(planSync(complete, remote, { succeeded: true }).prune).toEqual([
      "daily-100.cdiff",
      "daily-100.cdiff.sign",
      "daily-101.cdiff",
    ]);
    // CLD (uncompressed) databases count as present too.
    expect(
      planSync(
        [
          { name: "main.cld", size: 1, md5: "m" },
          { name: "daily.cld", size: 1, md5: "d" },
          { name: "daily-101.cdiff", size: 1, md5: "c2" },
        ],
        remote,
        { succeeded: true },
      ).prune,
    ).toEqual(["daily-100.cdiff", "daily-100.cdiff.sign"]);
    expect(isMirrorFile("bytecode-339.cvd.sign")).toBe(true);
    expect(isMirrorFile("../x.cvd")).toBe(false);
  });

  it("[E20] never prunes after an empty or partial run (would wipe the mirror)", () => {
    // Empty local directory, even if cvdupdate claimed success.
    expect(planSync([], remote, { succeeded: true }).prune).toEqual([]);
    // Missing daily database.
    expect(planSync([complete[0]!], remote, { succeeded: true }).prune).toEqual([]);
    // Files present, but the update reported errors: keep everything until a clean run.
    const failed = planSync(complete, remote, { succeeded: false });
    expect(failed.prune).toEqual([]);
    expect(failed.unchanged).toBe(2);
    expect(hasCoreDatabases(new Set(["main.cvd", "daily.cld"]))).toBe(true);
    expect(hasCoreDatabases(new Set(["main.cvd", "daily-1.cdiff"]))).toBe(false);
  });
});
