import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { checkSource, importsOf } from "../policies/check-boundaries.ts";
import { SKIPPED_DIRS, sourceFiles } from "../policies/fs.ts";
import { checkLockfile, checkManifest, isExactSpecifier } from "../policies/check-versions.ts";

// The repository itself is checked by `pnpm check:versions` and `pnpm check:boundaries` (CI
// verify); these tests pin the detectors, including what they must not flag.

describe("exact dependency pins (§7.1)", () => {
  it("rejects ranges, dist-tags, and mismatched Effect family pins", () => {
    for (const ok of ["4.0.0-rc.117", "2.0.0-beta.79", "1.2.3", "workspace:*"])
      expect(isExactSpecifier(ok), ok).toBe(true);

    for (const bad of [
      "^1.2.3",
      "~1.2.3",
      ">=4.0.0",
      "latest",
      "beta",
      "rc",
      "*",
      "1.x",
      "workspace:^",
    ]) {
      expect(isExactSpecifier(bad), bad).toBe(false);
    }

    const issues = checkManifest(
      "x",
      {
        dependencies: {
          effect: "4.0.0-rc.116",
          "@effect/vitest": "4.0.0-rc.117",
          alchemy: "latest",
        },
      },
      false,
    );

    expect(issues.map((i) => i.message)).toEqual([
      "effect must be 4.0.0-rc.117",
      "alchemy@latest is not an exact pin",
      "alchemy must be 2.0.0-beta.79",
    ]);
  });

  it("detects a second resolved effect version or drifting @effect/* family in the lockfile", () => {
    const lock =
      "packages:\n\n  effect@4.0.0-rc.117:\n    resolution: {}\n\n  effect@4.0.0-rc.116:\n    resolution: {}\n\n  '@effect/sql-d1@4.0.0-rc.116':\n    resolution: {}\n";

    const messages = checkLockfile("lock", lock).map((i) => i.message);
    expect(messages[0]).toMatch(/expected exactly effect@4.0.0-rc.117/);
    expect(messages[1]).toMatch(/@effect\/sql-d1 resolves to 4.0.0-rc.116/);
  });
});

describe("platform import boundaries (§7.5)", () => {
  it("classifies type-only and value imports", () => {
    expect(
      importsOf(
        'import type { X } from "alchemy/Cloudflare";\nimport { Y } from "node:fs";\nconst z = await import("alchemy");',
      ),
    ).toEqual([
      { specifier: "alchemy/Cloudflare", typeOnly: true },
      { specifier: "node:fs", typeOnly: false },
      { specifier: "alchemy", typeOnly: false },
    ]);
  });

  it("rejects management/runtime imports in Workers and impure calls in domain", () => {
    expect(checkSource("workers/core/src/index.ts", 'import * as A from "alchemy";')).toHaveLength(
      1,
    );
    expect(
      checkSource(
        "workers/core/src/index.ts",
        'import type { CoreEnv } from "../../../alchemy.run.ts";',
      ),
    ).toHaveLength(0);
    expect(
      checkSource("workers/core/src/index.ts", 'import { x } from "../../../infra/stack.ts";'),
    ).toHaveLength(1);
    expect(
      checkSource(
        "packages/application/src/a.ts",
        'import { NodeRuntime } from "@effect/platform-node";',
      ),
    ).toHaveLength(1);
    expect(
      checkSource("packages/testing/src/sqlite.ts", 'import { DatabaseSync } from "node:sqlite";'),
    ).toHaveLength(0);
    expect(
      checkSource("packages/domain/src/x.ts", "export const t = () => Date.now();"),
    ).toHaveLength(1);
    expect(
      checkSource(
        "packages/domain/src/x.ts",
        "// Date.now() is forbidden here\nexport const t = 1;",
      ),
    ).toHaveLength(0);
    expect(
      checkSource("packages/domain/src/x.ts", 'import { Effect } from "@effect/platform";'),
    ).toHaveLength(1);
    expect(
      checkSource("workers/core/src/x.ts", "const t = env.CLOUDFLARE_API_TOKEN;"),
    ).toHaveLength(1);
  });
});

describe("shared policy source walker", () => {
  it("skips vendored/generated trees and dot-entries, tolerates dangling symlinks, and sorts", () => {
    const dir = mkdtempSync(join(tmpdir(), "bye-walk-"));

    try {
      for (const f of [
        "src/b.ts",
        "src/a.ts",
        "src/x.test.ts",
        "src/test/t.ts",
        "src/.hidden/h.ts",
        "src/readme.md",
        ...SKIPPED_DIRS.map((d) => `src/${d}/v.ts`),
      ]) {
        mkdirSync(join(dir, f, ".."), { recursive: true });
        writeFileSync(join(dir, f), "");
      }

      symlinkSync(join(dir, "gone"), join(dir, "src", "dangling"));
      const rel = (xs: ReadonlyArray<string>) => xs.map((x) => relative(dir, x));
      expect(rel(sourceFiles(["src", "missing"], { ext: /\.ts$/, root: dir }))).toEqual([
        "src/a.ts",
        "src/b.ts",
        "src/test/t.ts",
        "src/x.test.ts",
      ]);
      expect(rel(sourceFiles(["src"], { ext: /\.ts$/, skip: ["test"], root: dir }))).toEqual([
        "src/a.ts",
        "src/b.ts",
        "src/x.test.ts",
      ]);
      expect(rel(sourceFiles(["src"], { ext: /\.test\.ts$/, root: dir }))).toEqual([
        "src/x.test.ts",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
