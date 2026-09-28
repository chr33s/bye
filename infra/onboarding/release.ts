// Pinned release (spec.md §15.11 "Pin a published Bye release to an immutable artifact
// identity"). A published release is a git tag; its identity is the tagged commit plus the
// lockfile digest. The deploy workspace must be a clean checkout of exactly that commit, so a
// retry can never pick up newer code.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Option, Schema } from "effect";
import type { ReleaseRef } from "./store.ts";

/**
 * Release-controlled qualification evidence shipped in the pinned checkout
 * (`infra/release/qualification.json`), e.g. `{ "newsletter": "EVIDENCE.md#1 2026-10 staging" }`.
 * Only the release owner sets it (it is part of the tagged commit); users never can.
 */
export interface ReleaseQualification {
  /** Evidence reference for newsletter dispatch (becomes NEWSLETTER_QUALIFIED); null = not qualified. */
  readonly newsletter: string | null;
}

export const QUALIFICATION_FILE = "infra/release/qualification.json";

const decodeQualification = Schema.decodeUnknownOption(
  Schema.Struct({ newsletter: Schema.optional(Schema.String) }),
);

const EVIDENCE_REF = /^[A-Za-z0-9 ._:#/()-]{1,200}$/;

/** Reads the release's qualification evidence; anything missing or malformed means "not qualified". */
export const releaseQualification = (dir: string): ReleaseQualification => {
  const file = join(dir, QUALIFICATION_FILE);

  if (!existsSync(file)) return { newsletter: null };

  try {
    const v = Option.getOrUndefined(decodeQualification(JSON.parse(readFileSync(file, "utf8"))));
    const ref = v?.newsletter?.trim() ?? "";

    return { newsletter: EVIDENCE_REF.test(ref) ? ref : null };
  } catch {
    return { newsletter: null };
  }
};

export interface ResolvedRelease {
  readonly ref: ReleaseRef;
  /** Checkout the executor runs in. */
  readonly dir: string;
  /** Qualification evidence of this exact release; absent = none. */
  readonly qualification?: ReleaseQualification;
}

const git = (dir: string, args: ReadonlyArray<string>) =>
  execFileSync("git", ["-C", dir, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();

export type ReleaseResolution =
  | { readonly ok: true; readonly release: ResolvedRelease }
  | { readonly ok: false; readonly reason: string };

export const resolveRelease = (dir: string, version: string): ReleaseResolution => {
  if (!/^v\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version))
    return { ok: false, reason: `release ${version} is not a published version tag` };

  try {
    const tagged = git(dir, ["rev-parse", "--verify", `refs/tags/${version}^{commit}`]);
    const head = git(dir, ["rev-parse", "HEAD"]);

    if (tagged !== head)
      return {
        ok: false,
        reason: `release checkout is not at ${version} (${tagged.slice(0, 12)})`,
      };

    if (git(dir, ["status", "--porcelain", "--untracked-files=no"]) !== "")
      return { ok: false, reason: "release checkout has local modifications" };

    const lockfileDigest = createHash("sha256")
      .update(readFileSync(join(dir, "pnpm-lock.yaml")))
      .digest("hex");

    return {
      ok: true,
      release: {
        ref: { version, commit: head, lockfileDigest },
        dir,
        qualification: releaseQualification(dir),
      },
    };
  } catch {
    return { ok: false, reason: `release ${version} is not available in the release checkout` };
  }
};

/** Migration IDs the release ships: D1 files and Durable Object class-migration tags per host. */
export const releaseMigrations = async (dir: string): Promise<ReadonlyArray<string>> => {
  const d1Dir = join(dir, "infra/migrations/d1");

  const d1 = existsSync(d1Dir)
    ? readdirSync(d1Dir)
        .filter((f) => f.endsWith(".sql"))
        .map((f) => `d1:${f}`)
    : [];

  const manifest = join(dir, "infra/migrations/durable/durable-class-migrations.ts");
  let durable: Array<string> = [];

  if (existsSync(manifest)) {
    const mod = (await import(pathToFileURL(manifest).href)) as {
      CLASS_MIGRATIONS_BY_HOST?: Readonly<Record<string, ReadonlyArray<{ tag: string }>>>;
    };

    durable = Object.entries(mod.CLASS_MIGRATIONS_BY_HOST ?? {}).flatMap(([host, steps]) =>
      steps.map((s) => `do:${host}:${s.tag}`),
    );
  }

  return [...d1, ...durable].sort();
};
