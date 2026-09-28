// Durable onboarding records (spec.md §15.11 "Existing stack and installation identity",
// "Safety and operational visibility"). One installation per operator, bound to one account and
// stage before any deployment write. Status and recovery metadata persist here; tokens only ever
// appear sealed, and events never carry secrets, message content or customer payloads.
import type { PendingAuthorization } from "./oauth.ts";
import type { Sealed } from "./seal.ts";

export interface ReleaseRef {
  /** Published release tag, e.g. `v1.2.0`. */
  readonly version: string;
  /** Immutable artifact identity: the tagged commit and its lockfile digest. */
  readonly commit: string;
  readonly lockfileDigest: string;
  /**
   * Hosted releases: the published images, pinned by digest (infra/onboarding/spec.md §45). Part
   * of the release identity, so an approval covers them.
   */
  readonly images?: ReleaseImages;
}

/** Source image references (`ghcr.io/…@sha256:…`) of a hosted release. */
export interface ReleaseImages {
  readonly deployer: string;
  readonly scanner: string;
  readonly mime: string;
  readonly sigmirror: string;
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
  /**
   * Hosted: when the deployer was first provisioned into the account (before the first plan).
   * Also fixes the target; `firstWriteAt` keeps meaning the stack's first apply.
   */
  readonly provisionedAt?: string | null;
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
  /**
   * Resumable execution (hosted, infra/onboarding/spec.md §47): the actions this apply covers, the
   * detached deployer job it runs as (and how many of its lines were recorded), and the apply
   * result once known. A restarted service follows the job instead of marking it interrupted.
   */
  readonly planned?: ReadonlyArray<PlannedAction>;
  readonly job?: { readonly id: string; readonly endpoint: string; readonly next: number };
  readonly applied?: { readonly ok: boolean; readonly aborted: boolean; readonly detail: string };
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
  /** Removes an installation record (only an unbound one is ever deleted, on re-attach). */
  deleteInstallation(id: string): Promise<void>;
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
  /** The last `limit` events of one operation, oldest first (the status view's progress). */
  recentEvents(
    installationId: string,
    operationId: string,
    limit: number,
  ): Promise<ReadonlyArray<OnboardingEvent>>;
}

export const newest = <T extends { readonly createdAt: string }>(xs: ReadonlyArray<T>) =>
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
  async deleteInstallation(id: string) {
    this.installations.delete(id);
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
  async recentEvents(installationId: string, operationId: string, limit: number) {
    return (await this.events(installationId))
      .filter((e) => e.operationId === operationId)
      .slice(-limit);
  }
}
