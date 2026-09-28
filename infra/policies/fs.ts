// The one source-tree walker the repository policies and repo-wide tests share, so every check
// sees the same files and skips the same vendored/generated trees.
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Repository root. */
export const ROOT = join(import.meta.dirname, "../..");

/** Never scanned: dependencies, build output and native vendored/generated trees (CocoaPods, Gradle, Xcode). */
export const SKIPPED_DIRS: ReadonlyArray<string> = [
  "node_modules",
  "dist",
  "Pods",
  "build",
  "DerivedData",
];

export interface SourceFileOptions {
  /** Which file names count (matched against the entry name). */
  readonly ext: RegExp;
  /** Extra directory names to skip, on top of SKIPPED_DIRS and dot-entries. */
  readonly skip?: ReadonlyArray<string>;
  /** Base for relative `dirs` (default ROOT). */
  readonly root?: string;
}

/**
 * Files under `dirs` (relative to `root`) whose names match `ext`: absolute paths, sorted. Missing
 * directories are empty, and entries that can't be stat'ed (dangling symlinks left by a removed
 * pod) are ignored.
 */
export const sourceFiles = (
  dirs: ReadonlyArray<string>,
  { ext, skip = [], root = ROOT }: SourceFileOptions,
): Array<string> => {
  const skipped = new Set([...SKIPPED_DIRS, ...skip]);
  const out: Array<string> = [];

  const walk = (dir: string): void => {
    let entries: Array<string>;

    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }

    for (const entry of entries) {
      if (skipped.has(entry) || entry.startsWith(".")) continue;
      const full = join(dir, entry);
      let isDir: boolean;

      try {
        isDir = statSync(full).isDirectory();
      } catch {
        continue;
      }

      if (isDir) walk(full);
      else if (ext.test(entry)) out.push(full);
    }
  };

  for (const dir of dirs) walk(join(root, dir));

  return out.sort();
};
