import { createHash } from "node:crypto";
import { readdirSync, readFileSync, lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { canonical } from "./plan-normalize.ts";
import { assertNoSecrets } from "./schemas.ts";

/** Hash working bytes including new source files, independent of git index and filesystem traversal order. */
export const sourceDigest = (root: string): string => {
  const hash = createHash("sha256");

  const ignored = new Set([
    "node_modules",
    ".git",
    ".alchemy",
    ".cloudflare",
    ".cf",
    "dist",
    "coverage",
    "Pods",
    "build",
    "DerivedData",
    ".DS_Store",
    ".venv",
    "__pycache__",
    "worker-configuration.d.ts",
  ]);

  const visit = (path: string) => {
    const info = lstatSync(path);

    if (info.isSymbolicLink()) throw new Error("source subject contains symlink");

    if (info.isDirectory()) {
      for (const name of readdirSync(path).sort()) {
        if (
          ignored.has(name) ||
          name.startsWith(".env") ||
          name.endsWith(".cf-resources.json") ||
          name.endsWith(".cf-secrets.json")
        )
          continue;
        visit(join(path, name));
      }

      return;
    }

    const name = relative(root, path);

    if (!info.isFile()) throw new Error("source subject contains nonregular file");
    const bytes = readFileSync(path);
    hash.update(`${Buffer.byteLength(name)}:${name}:${bytes.length}:`).update(bytes);
  };

  visit(root);

  return hash.digest("hex");
};

export const writeArtifact = <T>(path: string, input: T): void => {
  assertNoSecrets(input);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${canonical(input)}\n`, { flag: "wx", mode: 0o600 });
};
