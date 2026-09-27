// Durable onboarding records (spec.md §15.11 "Existing stack and installation identity",
// "Safety and operational visibility"). One installation per operator, bound to one account and
// stage before any deployment write. Status and recovery metadata persist here; tokens only ever
// appear sealed, and events never carry secrets, message content or customer payloads.
import {
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import { join } from "node:path";
import type { PendingAuthorization } from "./oauth.ts";
import type { Sealed } from "./seal.ts";

export interface ReleaseRef {
  /** Published release tag, e.g. `v1.2.0`. */
  readonly version: string;
  /** Immutable artifact identity: the tagged commit and its lockfile digest. */
  readonly commit: string;
  readonly lockfileDigest: string;
}

export interface StateRef {
  /** Alchemy state lives in the operator's account (`Cloudflare.state()`), never Bye's. */
  readonly backend: "cloudflare";
  readonly accountId: string;
  readonly stack: "MailboxPlatform";
  readonly stage: string;
}

export type AuthorizationStatus = "none" | "connected" | "expired" | "disconnected";

export interface AuthorizationRecord {
  readonly status: AuthorizationStatus;
  readonly scopes: ReadonlyArray<string>;
  readonly connectedAt: string | null;
  readonly expiresAt: string | null;
  /** Last disconnect outcome, kept after credentials are gone. */
  readonly disconnect?: {
    readonly at: string;
    readonly revocation: string;
    readonly inFlight: string | null;
  };
}

export interface InstanceUrls {
  readonly app: string;
  readonly site: string;
  readonly render: string;
}

/**
 * The user's "Create Bye" click, recorded before planning: consent to exactly this standard
 * installation target. A plan is auto-approved only while it still matches the intent.
 */
export interface InstallIntent {
  readonly id: string;
  readonly installationId: string;
  readonly accountId: string;
  readonly zoneId: string;
  readonly zoneName: string;
  readonly appHostname: string;
  readonly stage: "prod";
  readonly release: ReleaseRef;
  readonly createdAt: string;
  readonly operatorId: string;
}

export interface Installation {
  readonly id: string;
  readonly operatorId: string;
  readonly createdAt: string;
  readonly accountId: string | null;
  readonly accountName: string | null;
  readonly stage: string | null;
  /** BYE_WORKERS_DEV_NAME: fixed at binding so URLs are known before the first write. */
  readonly workerName: string | null;
  readonly stateRef: StateRef | null;
  readonly boundAt: string | null;
  /** Set (and persisted) before the first deployment write; binding is immutable afterwards. */
  readonly firstWriteAt: string | null;
  readonly urls: InstanceUrls | null;
  /** Bye runtime secrets (SESSION_KEY, …), generated once and sealed. */
  readonly runtimeSecrets: Sealed | null;
  /** Cloudflare management tokens, sealed; null when disconnected. */
  readonly credentials: Sealed | null;
  readonly authorization: AuthorizationRecord;
  readonly deployedRelease: ReleaseRef | null;
  readonly appliedMigrations: ReadonlyArray<string>;
  readonly ready: boolean;
  readonly readyAt: string | null;
  /** When the one-time recovery kit was handed out; absent on records from before it existed. */
  readonly recoveryKitIssuedAt?: string | null;
  // Install target (infra/onboarding/spec.md §5): the Cloudflare zone and Bye hostname chosen in the
  // standard flow. Immutable once `firstWriteAt` is set. Absent/null on stage-bound installations.
  readonly zoneId?: string | null;
  readonly zoneName?: string | null;
  /** Bye hostname, e.g. `bye.example.com` (lowercase, no trailing dot). */
  readonly appHostname?: string | null;
  /** Domain for the owner's address (initially the zone); never activates mail routing. */
  readonly ownerAddressDomain?: string | null;
  readonly installIntent?: InstallIntent | null;
  /** Review awaiting the operator because the standard plan could not be auto-approved. */
  readonly pendingReviewId?: string | null;
}

export interface PlannedAction {
  readonly fqn: string;
  readonly logicalId: string;
  readonly type: string;
  readonly action: "create" | "update" | "replace" | "delete";
}

/** Everything an approval covers; its digest is what the operator approved. */
export interface ApprovalSubject {
  readonly installationId: string;
  readonly accountId: string;
  readonly stage: string;
  readonly release: ReleaseRef;
  readonly configHash: string;
  readonly actions: ReadonlyArray<PlannedAction>;
  /** Migrations this deploy would apply (D1 files, DO class-migration tags). */
  readonly migrations: ReadonlyArray<string>;
}

export interface Review {
  readonly id: string;
  readonly installationId: string;
  readonly createdAt: string;
  readonly subject: ApprovalSubject;
  readonly digest: string;
  readonly blockers: ReadonlyArray<string>;
  readonly warnings: ReadonlyArray<string>;
  readonly destructive: ReadonlyArray<PlannedAction>;
}

export interface Approval {
  readonly id: string;
  readonly reviewId: string;
  readonly installationId: string;
  readonly digest: string;
  readonly subject: ApprovalSubject;
  readonly approvedAt: string;
  readonly approvedBy: string;
  /** How it was approved: by the operator on a reviewed plan, or by policy after an install intent. */
  readonly policy?: "operator" | "standard-first-install";
  readonly installIntentId?: string;
}

export type OperationStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "interrupted";

export type OperationStep = "revalidate" | "apply" | "reconcile" | "health" | "done";

export interface ResourceOutcome {
  readonly fqn: string;
  readonly logicalId: string;
  readonly action: PlannedAction["action"];
  readonly outcome: "completed" | "pending" | "uncertain";
}

export interface HealthResult {
  readonly name: string;
  readonly ok: boolean;
  readonly ms: number;
  readonly detail: string;
}

export interface Operation {
  readonly id: string;
  readonly installationId: string;
  readonly kind: "deploy";
  readonly approvalId: string;
  readonly status: OperationStatus;
  readonly step: OperationStep;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly finishedAt: string | null;
  readonly outcomes: ReadonlyArray<ResourceOutcome>;
  readonly health: ReadonlyArray<HealthResult>;
  readonly error: {
    readonly step: OperationStep;
    readonly message: string;
    readonly nextAction: string;
  } | null;
}

export interface OnboardingEvent {
  readonly at: string;
  readonly installationId: string;
  readonly operationId: string | null;
  readonly kind: string;
  readonly detail: string;
}

export interface OnboardingStore {
  getInstallation(id: string): Promise<Installation | null>;
  installationIds(): Promise<ReadonlyArray<string>>;
  installationForOperator(operatorId: string): Promise<Installation | null>;
  installationForTarget(accountId: string, stage: string): Promise<Installation | null>;
  putInstallation(installation: Installation): Promise<void>;
  putPending(pending: PendingAuthorization): Promise<void>;
  /** Single use: returns the record at most once. */
  takePending(state: string): Promise<PendingAuthorization | null>;
  /** Deletes pending authorizations that expired before `now`; returns how many were removed. */
  prunePending(now: number): Promise<number>;
  putReview(review: Review): Promise<void>;
  getReview(id: string): Promise<Review | null>;
  putApproval(approval: Approval): Promise<void>;
  getApproval(id: string): Promise<Approval | null>;
  putOperation(operation: Operation): Promise<void>;
  getOperation(id: string): Promise<Operation | null>;
  operations(installationId: string): Promise<ReadonlyArray<Operation>>;
  /** Per-installation writer lock. Returns null when acquired, else the holder's operation ID. */
  acquireWriter(installationId: string, operationId: string): Promise<string | null>;
  releaseWriter(installationId: string, operationId: string): Promise<void>;
  writerHolder(installationId: string): Promise<string | null>;
  appendEvent(event: OnboardingEvent): Promise<void>;
  events(installationId: string): Promise<ReadonlyArray<OnboardingEvent>>;
}

const newest = <T extends { readonly createdAt: string }>(xs: ReadonlyArray<T>) =>
  [...xs].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

export class MemoryStore implements OnboardingStore {
  readonly installations = new Map<string, Installation>();
  readonly pending = new Map<string, PendingAuthorization>();
  readonly reviews = new Map<string, Review>();
  readonly approvals = new Map<string, Approval>();
  readonly ops = new Map<string, Operation>();
  readonly writers = new Map<string, string>();
  readonly log: Array<OnboardingEvent> = [];

  async getInstallation(id: string) {
    return this.installations.get(id) ?? null;
  }
  async installationIds() {
    return [...this.installations.keys()];
  }
  async installationForOperator(operatorId: string) {
    return [...this.installations.values()].find((i) => i.operatorId === operatorId) ?? null;
  }
  async installationForTarget(accountId: string, stage: string) {
    return (
      [...this.installations.values()].find(
        (i) => i.accountId === accountId && i.stage === stage,
      ) ?? null
    );
  }
  async putInstallation(i: Installation) {
    this.installations.set(i.id, i);
  }
  async putPending(p: PendingAuthorization) {
    this.pending.set(p.state, p);
  }
  async takePending(state: string) {
    const p = this.pending.get(state) ?? null;
    this.pending.delete(state);
    return p;
  }
  async prunePending(now: number) {
    let removed = 0;
    for (const [state, p] of this.pending)
      if (p.expiresAt < now) {
        this.pending.delete(state);
        removed++;
      }
    return removed;
  }
  async putReview(r: Review) {
    this.reviews.set(r.id, r);
  }
  async getReview(id: string) {
    return this.reviews.get(id) ?? null;
  }
  async putApproval(a: Approval) {
    this.approvals.set(a.id, a);
  }
  async getApproval(id: string) {
    return this.approvals.get(id) ?? null;
  }
  async putOperation(o: Operation) {
    this.ops.set(o.id, o);
  }
  async getOperation(id: string) {
    return this.ops.get(id) ?? null;
  }
  async operations(installationId: string) {
    return newest([...this.ops.values()].filter((o) => o.installationId === installationId));
  }
  async acquireWriter(installationId: string, operationId: string) {
    const holder = this.writers.get(installationId);
    if (holder !== undefined && holder !== operationId) return holder;
    this.writers.set(installationId, operationId);
    return null;
  }
  async releaseWriter(installationId: string, operationId: string) {
    if (this.writers.get(installationId) === operationId) this.writers.delete(installationId);
  }
  async writerHolder(installationId: string) {
    return this.writers.get(installationId) ?? null;
  }
  async appendEvent(e: OnboardingEvent) {
    this.log.push(e);
  }
  async events(installationId: string) {
    return this.log.filter((e) => e.installationId === installationId);
  }
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** Leftover `.taken.<pid>` / `.tmp` files older than this are removed by `prunePending`. */
const STRAY_PENDING_MS = 60 * 60_000;

/**
 * One JSON file per record under a private directory (mode 0700/0600), written atomically by
 * rename. The writer lock is an exclusively created file, so it also holds across processes that
 * share the directory; a lock left by a crashed process is released only by `recover()`.
 */
export class FileStore implements OnboardingStore {
  readonly dir: string;
  constructor(dir: string) {
    this.dir = dir;
    for (const sub of ["installations", "pending", "reviews", "approvals", "operations", "locks"])
      mkdirSync(join(dir, sub), { recursive: true, mode: 0o700 });
    mkdirSync(join(dir, "events"), { recursive: true, mode: 0o700 });
  }

  private path(kind: string, id: string) {
    if (!SAFE_ID.test(id)) throw new Error(`invalid ${kind} id`);
    return join(this.dir, kind, `${id}.json`);
  }
  private read<T>(kind: string, id: string): T | null {
    const p = this.path(kind, id);
    return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as T) : null;
  }
  private write(kind: string, id: string, value: unknown) {
    const p = this.path(kind, id);
    const tmp = `${p}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
    renameSync(tmp, p);
  }
  private all<T>(kind: string): Array<T> {
    return readdirSync(join(this.dir, kind))
      .filter((f) => f.endsWith(".json"))
      .map((f) => JSON.parse(readFileSync(join(this.dir, kind, f), "utf8")) as T);
  }

  async getInstallation(id: string) {
    return SAFE_ID.test(id) ? this.read<Installation>("installations", id) : null;
  }
  async installationIds() {
    return this.all<Installation>("installations").map((i) => i.id);
  }
  async installationForOperator(operatorId: string) {
    return this.all<Installation>("installations").find((i) => i.operatorId === operatorId) ?? null;
  }
  async installationForTarget(accountId: string, stage: string) {
    return (
      this.all<Installation>("installations").find(
        (i) => i.accountId === accountId && i.stage === stage,
      ) ?? null
    );
  }
  async putInstallation(i: Installation) {
    this.write("installations", i.id, i);
  }
  async putPending(p: PendingAuthorization) {
    this.write("pending", p.state, p);
  }
  async takePending(state: string) {
    if (!SAFE_ID.test(state)) return null;
    const p = this.path("pending", state);
    const claimed = `${p}.taken.${process.pid}`;
    try {
      renameSync(p, claimed); // atomic: exactly one caller wins
    } catch {
      return null;
    }
    const value = JSON.parse(readFileSync(claimed, "utf8")) as PendingAuthorization;
    rmSync(claimed, { force: true });
    return value;
  }
  /**
   * Pending files hold a PKCE verifier; expired ones are deleted, as are claim and temp files a
   * crashed process left behind (older than the pending TTL window, by mtime).
   */
  async prunePending(now: number) {
    const dir = join(this.dir, "pending");
    let removed = 0;
    for (const f of readdirSync(dir)) {
      const file = join(dir, f);
      try {
        const stale = f.endsWith(".json")
          ? (JSON.parse(readFileSync(file, "utf8")) as PendingAuthorization).expiresAt < now
          : statSync(file).mtimeMs < now - STRAY_PENDING_MS;
        if (stale) {
          rmSync(file, { force: true });
          removed++;
        }
      } catch {
        // Claimed or removed concurrently, or unreadable: a later sweep retries.
      }
    }
    return removed;
  }
  async putReview(r: Review) {
    this.write("reviews", r.id, r);
  }
  async getReview(id: string) {
    return SAFE_ID.test(id) ? this.read<Review>("reviews", id) : null;
  }
  async putApproval(a: Approval) {
    this.write("approvals", a.id, a);
  }
  async getApproval(id: string) {
    return SAFE_ID.test(id) ? this.read<Approval>("approvals", id) : null;
  }
  async putOperation(o: Operation) {
    this.write("operations", o.id, o);
  }
  async getOperation(id: string) {
    return SAFE_ID.test(id) ? this.read<Operation>("operations", id) : null;
  }
  async operations(installationId: string) {
    return newest(
      this.all<Operation>("operations").filter((o) => o.installationId === installationId),
    );
  }
  async acquireWriter(installationId: string, operationId: string) {
    const p = this.path("locks", installationId);
    try {
      const fd = openSync(p, "wx", 0o600);
      writeFileSync(fd, JSON.stringify({ operationId, pid: process.pid }));
      closeSync(fd);
      return null;
    } catch {
      const holder = await this.writerHolder(installationId);
      return holder === operationId ? null : (holder ?? "unknown");
    }
  }
  async releaseWriter(installationId: string, operationId: string) {
    if ((await this.writerHolder(installationId)) === operationId)
      rmSync(this.path("locks", installationId), { force: true });
  }
  async writerHolder(installationId: string) {
    return this.read<{ operationId: string }>("locks", installationId)?.operationId ?? null;
  }
  async appendEvent(e: OnboardingEvent) {
    if (!SAFE_ID.test(e.installationId)) throw new Error("invalid installation id");
    appendFileSync(
      join(this.dir, "events", `${e.installationId}.jsonl`),
      `${JSON.stringify(e)}\n`,
      {
        mode: 0o600,
      },
    );
  }
  async events(installationId: string) {
    if (!SAFE_ID.test(installationId)) return [];
    const p = join(this.dir, "events", `${installationId}.jsonl`);
    if (!existsSync(p)) return [];
    return readFileSync(p, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as OnboardingEvent);
  }
}
