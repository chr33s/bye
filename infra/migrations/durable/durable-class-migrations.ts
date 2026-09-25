// Durable Object namespace/class migration history (§15.9). Distinct from in-object application
// SQL migrations (packages/platform-cloudflare/src/durable/sql.ts `migrate`).
//
// Alchemy beta.78 generates `new_sqlite_classes` for classes newly bound on a host Worker and
// `transferred_classes` when `transferredFrom` is declared. This manifest is the reviewed record
// of what each release expects; infra/tests/durable-migrations.test.ts rejects removals/renames.

export interface ClassMigrationStep {
  readonly tag: string;
  readonly newSqliteClasses?: ReadonlyArray<string>;
  /** Renames require an explicit, data-preserving step and a decommission record. */
  readonly renamedClasses?: ReadonlyArray<{ readonly from: string; readonly to: string }>;
  readonly transferredClasses?: ReadonlyArray<{
    readonly from: string;
    readonly fromScript: string;
    readonly to: string;
  }>;
  readonly deletedClasses?: ReadonlyArray<string>;
}

export interface HostedNamespace {
  readonly logicalId: string;
  readonly className: string;
  readonly hostWorker: string;
}

export const HOSTED_NAMESPACES: ReadonlyArray<HostedNamespace> = [
  { logicalId: "Mailboxes", className: "MailboxDO", hostWorker: "MailCore" },
  { logicalId: "Calendars", className: "CalendarDO", hostWorker: "MailCore" },
  { logicalId: "SharedSpaces", className: "SharedSpaceDO", hostWorker: "MailCore" },
  { logicalId: "SearchShards", className: "SearchShardDO", hostWorker: "MailCore" },
  { logicalId: "IngressJournals", className: "IngressJournalDO", hostWorker: "MailCore" },
  { logicalId: "Scanner", className: "ScannerContainer", hostWorker: "MailCore" },
  { logicalId: "MimeParser", className: "MimeContainer", hostWorker: "MailCore" },
  { logicalId: "Probes", className: "ProbeDO", hostWorker: "MailCore" },
  // Signature mirror job container, hosted on its own Worker (§15.4 media and scans).
  { logicalId: "SigMirrorJob", className: "SigMirrorJob", hostWorker: "SigMirror" },
];

export const CLASS_MIGRATIONS: ReadonlyArray<ClassMigrationStep> = [
  {
    tag: "v1",
    newSqliteClasses: [
      "MailboxDO",
      "CalendarDO",
      "SharedSpaceDO",
      "SearchShardDO",
      "IngressJournalDO",
    ],
  },
  // Container-backed class for the isolated scanner (§15.4 media and scans).
  { tag: "v2", newSqliteClasses: ["ScannerContainer"] },
  // Container-backed class for exceptional MIME processing (§5.1 step 5).
  { tag: "v3", newSqliteClasses: ["MimeContainer"] },
  // Post-deploy alarm probe (§15.10).
  { tag: "v4", newSqliteClasses: ["ProbeDO"] },
];

/** SigMirror's own migration history; class migrations are scoped to their host Worker script. */
export const SIGMIRROR_CLASS_MIGRATIONS: ReadonlyArray<ClassMigrationStep> = [
  { tag: "v1", newSqliteClasses: ["SigMirrorJob"] },
];

export const CLASS_MIGRATIONS_BY_HOST: Readonly<Record<string, ReadonlyArray<ClassMigrationStep>>> =
  {
    MailCore: CLASS_MIGRATIONS,
    SigMirror: SIGMIRROR_CLASS_MIGRATIONS,
  };

/** Classes that must be exported by the host Worker after applying every step. */
export const liveClasses = (steps: ReadonlyArray<ClassMigrationStep>): ReadonlyArray<string> => {
  const live = new Set<string>();
  for (const step of steps) {
    for (const c of step.newSqliteClasses ?? []) live.add(c);
    for (const r of step.renamedClasses ?? []) {
      live.delete(r.from);
      live.add(r.to);
    }
    for (const t of step.transferredClasses ?? []) live.add(t.to);
    for (const d of step.deletedClasses ?? []) live.delete(d);
  }
  return [...live].sort();
};

export interface ManifestIssue {
  readonly message: string;
}

/**
 * Compare a previously released manifest with the current one. Released steps are immutable;
 * classes may not disappear unless a later step deletes them with an approved decommission.
 */
export const compareManifests = (
  released: ReadonlyArray<ClassMigrationStep>,
  current: ReadonlyArray<ClassMigrationStep>,
  approvedDeletions: ReadonlyArray<string> = [],
): ReadonlyArray<ManifestIssue> => {
  const issues: Array<ManifestIssue> = [];
  released.forEach((step, i) => {
    if (JSON.stringify(current[i]) !== JSON.stringify(step)) {
      issues.push({ message: `released migration step ${step.tag} was modified or removed` });
    }
  });
  const tags = current.map((s) => s.tag);
  if (new Set(tags).size !== tags.length) issues.push({ message: "duplicate migration tags" });
  for (const step of current.slice(released.length)) {
    for (const d of step.deletedClasses ?? []) {
      if (!approvedDeletions.includes(d))
        issues.push({ message: `deleting class ${d} requires an approved decommission` });
    }
    for (const r of step.renamedClasses ?? []) {
      if (!approvedDeletions.includes(r.from))
        issues.push({ message: `renaming ${r.from} requires an approved decommission` });
    }
  }
  const before = new Set(liveClasses(released));
  const after = new Set(liveClasses(current));
  for (const c of before) {
    if (!after.has(c) && !approvedDeletions.includes(c))
      issues.push({ message: `class ${c} disappeared` });
  }
  return issues;
};
