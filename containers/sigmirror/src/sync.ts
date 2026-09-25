// Pure planning for the mirror job: which local files to upload and which remote files to prune.
// Kept separate from process/network code so it is unit-testable.

export interface RemoteFile {
  readonly size: number;
  /** R2 ETag: the hex MD5 of the object for single-part uploads. */
  readonly etag: string;
}

export interface LocalFile {
  readonly name: string;
  readonly size: number;
  readonly md5: string;
}

const DB_NAME = /^[a-z][a-z0-9_]{0,63}(-[0-9]{1,8})?\.(cvd|cld|cdiff|dat|txt)(\.sign)?$/;

export const isMirrorFile = (name: string): boolean => DB_NAME.test(name);

/** Files seeded into cvdupdate's directory before a run, so it only fetches deltas upstream. */
export const seedNames = (remote: Readonly<Record<string, RemoteFile>>): ReadonlyArray<string> =>
  Object.keys(remote)
    .filter((n) => /\.(cvd|cld)(\.sign)?$/.test(n))
    .sort();

export interface SyncPlan {
  readonly upload: ReadonlyArray<string>;
  readonly unchanged: number;
  readonly prune: ReadonlyArray<string>;
}

export interface SyncRun {
  /** cvdupdate reported no errors. A failed or partial run never prunes the mirror. */
  readonly succeeded: boolean;
}

/** A run produced a usable database set: both `main` and `daily` exist locally (CVD or CLD). */
export const hasCoreDatabases = (localNames: ReadonlySet<string>): boolean =>
  ["main", "daily"].every((db) => localNames.has(`${db}.cvd`) || localNames.has(`${db}.cld`));

/**
 * Upload new/changed files; prune remote CDIFFs (and their signatures) that cvdupdate retired
 * locally. Whole databases are never pruned automatically: a missing local CVD means a failed run,
 * not a deletion. Pruning only happens after a successful run that left `main` and `daily` in
 * place — otherwise an empty or partial local directory would wipe every CDIFF from the mirror.
 */
export const planSync = (
  local: ReadonlyArray<LocalFile>,
  remote: Readonly<Record<string, RemoteFile>>,
  run: SyncRun,
): SyncPlan => {
  const upload: Array<string> = [];
  let unchanged = 0;
  const localNames = new Set<string>();
  for (const f of local) {
    if (!isMirrorFile(f.name)) continue;
    localNames.add(f.name);
    const r = remote[f.name];
    if (r && r.size === f.size && r.etag.replace(/"/g, "") === f.md5) unchanged++;
    else upload.push(f.name);
  }
  const prune =
    run.succeeded && hasCoreDatabases(localNames)
      ? Object.keys(remote).filter((n) => /\.cdiff(\.sign)?$/.test(n) && !localNames.has(n))
      : [];
  return { upload: upload.sort(), unchanged, prune: prune.sort() };
};
