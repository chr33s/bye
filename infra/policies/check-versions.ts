// Exact dependency pins and a single Effect family (§7.1). Run: pnpm check:versions
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const EFFECT_VERSION = "4.0.0-rc.117";

export const ALCHEMY_VERSION = "2.0.0-beta.79";

const EXACT = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export interface VersionIssue {
  readonly file: string;
  readonly message: string;
}

export const isExactSpecifier = (spec: string): boolean =>
  spec === "workspace:*" || EXACT.test(spec);

type Manifest = {
  readonly name?: string;
  readonly packageManager?: string;
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
  readonly peerDependencies?: Record<string, string>;
  readonly optionalDependencies?: Record<string, string>;
};

export const checkManifest = (
  file: string,
  manifest: Manifest,
  isRoot: boolean,
): ReadonlyArray<VersionIssue> => {
  const issues: Array<VersionIssue> = [];
  const sections = [manifest.dependencies, manifest.devDependencies, manifest.optionalDependencies];

  for (const section of sections) {
    for (const [name, spec] of Object.entries(section ?? {})) {
      if (!isExactSpecifier(spec))
        issues.push({ file, message: `${name}@${spec} is not an exact pin` });

      if (name === "effect" && spec !== EFFECT_VERSION)
        issues.push({ file, message: `effect must be ${EFFECT_VERSION}` });

      if (name.startsWith("@effect/") && spec !== EFFECT_VERSION) {
        issues.push({ file, message: `${name} must match effect ${EFFECT_VERSION}` });
      }

      if (name === "alchemy" && spec !== ALCHEMY_VERSION)
        issues.push({ file, message: `alchemy must be ${ALCHEMY_VERSION}` });
    }
  }

  if (isRoot && !/^pnpm@\d+\.\d+\.\d+$/.test(manifest.packageManager ?? "")) {
    issues.push({ file, message: "packageManager must pin an exact pnpm version" });
  }

  return issues;
};

/** Every resolved `effect` and `@effect/*` package in the lockfile must be the pinned release. */
export const checkLockfile = (file: string, lock: string): ReadonlyArray<VersionIssue> => {
  const issues: Array<VersionIssue> = [];
  const effect = new Set<string>();
  const family = new Map<string, Set<string>>();

  for (const m of lock.matchAll(/^ {2}'?((?:@effect\/[a-z0-9-]+)|effect)@(\d[^:(\s']*)/gm)) {
    const name = m[1]!;
    const version = m[2]!;

    if (name === "effect") effect.add(version);
    else family.set(name, (family.get(name) ?? new Set()).add(version));
  }

  if (effect.size !== 1 || !effect.has(EFFECT_VERSION)) {
    issues.push({
      file,
      message: `expected exactly effect@${EFFECT_VERSION}, found ${[...effect].join(", ") || "none"}`,
    });
  }

  for (const [name, versions] of family) {
    const other = [...versions].filter((v) => v !== EFFECT_VERSION);

    if (other.length > 0)
      issues.push({
        file,
        message: `${name} resolves to ${other.join(", ")}; pin to ${EFFECT_VERSION}`,
      });
  }

  return issues;
};

export const workspaceManifests = (root: string): ReadonlyArray<string> => {
  const files = [join(root, "package.json")];

  for (const dir of ["packages", "workers", "apps"]) {
    const base = join(root, dir);

    if (!existsSync(base)) continue;

    for (const entry of readdirSync(base)) {
      const file = join(base, entry, "package.json");

      if (existsSync(file)) files.push(file);
    }
  }

  if (existsSync(join(root, "infra", "package.json")))
    files.push(join(root, "infra", "package.json"));

  return files;
};

export const checkRepository = (root: string): ReadonlyArray<VersionIssue> => {
  const issues: Array<VersionIssue> = [];
  const rootManifest = join(root, "package.json");

  for (const file of workspaceManifests(root)) {
    issues.push(
      ...checkManifest(
        file,
        JSON.parse(readFileSync(file, "utf8")) as Manifest,
        file === rootManifest,
      ),
    );
  }

  const lockfile = join(root, "pnpm-lock.yaml");

  if (!existsSync(lockfile))
    issues.push({ file: lockfile, message: "committed lockfile is required" });
  else issues.push(...checkLockfile(lockfile, readFileSync(lockfile, "utf8")));

  return issues;
};

if (import.meta.main) {
  const issues = checkRepository(process.cwd());

  for (const issue of issues) console.error(`${issue.file}: ${issue.message}`);

  if (issues.length > 0) process.exit(1);
  console.log("versions: exact pins and a single Effect family");
}
