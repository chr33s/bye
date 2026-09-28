// Onboarding records on Durable Object storage (hosted service, infra/onboarding/spec.md §42).
// One OnboardingDO holds every record, so the per-installation writer lock and the single-use
// OAuth state are plain read-then-write sequences: a Durable Object runs one event at a time and
// its storage calls are ordered, so no other request interleaves between them.
import type { PendingAuthorization } from "./oauth.ts";
import {
  newest,
  type Approval,
  type Installation,
  type OnboardingEvent,
  type OnboardingStore,
  type Operation,
  type Review,
} from "./store.ts";

/** The subset of `DurableObjectStorage` this store uses (a Map-backed fake in tests). */
export interface KeyValueStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  list<T>(options: {
    readonly prefix: string;
    readonly reverse?: boolean;
    readonly limit?: number;
  }): Promise<Map<string, T>>;
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

const key = (kind: string, id: string) => {
  if (!SAFE_ID.test(id)) throw new Error(`invalid ${kind} id`);

  return `${kind}:${id}`;
};

/** Operation keys group by installation. */
const operationKey = (installationId: string, id: string) =>
  `${key("operation", installationId)}:${key("id", id).slice("id:".length)}`;

/** Event keys sort by installation, then by a zero-padded sequence number. */
const eventKey = (installationId: string, seq: number) =>
  `${key("event", installationId)}:${String(seq).padStart(12, "0")}`;

export class DurableObjectStore implements OnboardingStore {
  private readonly storage: KeyValueStorage;
  private appends: Promise<void> = Promise.resolve();
  constructor(storage: KeyValueStorage) {
    this.storage = storage;
  }

  private async get<T>(kind: string, id: string): Promise<T | null> {
    return SAFE_ID.test(id) ? ((await this.storage.get<T>(key(kind, id))) ?? null) : null;
  }
  private async all<T>(kind: string): Promise<Array<T>> {
    return [...(await this.storage.list<T>({ prefix: `${kind}:` })).values()];
  }
  /** Secondary index: `<index>:<value>` → installation id. */
  private async byIndex(index: string, value: string): Promise<Installation | null> {
    const id = await this.storage.get<string>(`${index}:${value}`);

    return id === undefined ? null : this.getInstallation(id);
  }

  async getInstallation(id: string) {
    return this.get<Installation>("installation", id);
  }
  async installationIds() {
    return (await this.all<Installation>("installation")).map((i) => i.id);
  }
  async installationForOperator(operatorId: string) {
    return this.byIndex("operator", operatorId);
  }
  async installationForTarget(accountId: string, stage: string) {
    return this.byIndex("target", `${accountId}\0${stage}`);
  }
  async putInstallation(i: Installation) {
    const prior = await this.getInstallation(i.id);
    await this.storage.put(key("installation", i.id), i);

    // A re-attach moves the installation to another operator: the old one no longer reaches it.
    if (prior && prior.operatorId !== i.operatorId)
      await this.storage.delete(`operator:${prior.operatorId}`);
    await this.storage.put(`operator:${i.operatorId}`, i.id);

    if (
      prior?.accountId &&
      prior.stage &&
      (prior.accountId !== i.accountId || prior.stage !== i.stage)
    )
      await this.storage.delete(`target:${prior.accountId}\0${prior.stage}`);

    if (i.accountId && i.stage) await this.storage.put(`target:${i.accountId}\0${i.stage}`, i.id);
  }
  async deleteInstallation(id: string) {
    const prior = await this.getInstallation(id);

    if (!prior) return;
    await this.storage.delete(key("installation", id));

    if ((await this.storage.get<string>(`operator:${prior.operatorId}`)) === id)
      await this.storage.delete(`operator:${prior.operatorId}`);

    if (
      prior.accountId &&
      prior.stage &&
      (await this.storage.get<string>(`target:${prior.accountId}\0${prior.stage}`)) === id
    )
      await this.storage.delete(`target:${prior.accountId}\0${prior.stage}`);
  }
  async putPending(p: PendingAuthorization) {
    await this.storage.put(key("pending", p.state), p);
  }
  async takePending(state: string) {
    const p = await this.get<PendingAuthorization>("pending", state);

    if (p) await this.storage.delete(key("pending", state));

    return p;
  }
  async prunePending(now: number) {
    let removed = 0;

    for (const p of await this.all<PendingAuthorization>("pending"))
      if (p.expiresAt < now) {
        await this.storage.delete(key("pending", p.state));
        removed++;
      }

    return removed;
  }
  async putReview(r: Review) {
    await this.storage.put(key("review", r.id), r);
  }
  async getReview(id: string) {
    return this.get<Review>("review", id);
  }
  async putApproval(a: Approval) {
    await this.storage.put(key("approval", a.id), a);
  }
  async getApproval(id: string) {
    return this.get<Approval>("approval", id);
  }
  // Operations live under their installation (`operation:<installation>:<id>`), so a status poll
  // lists one installation's operations, never every operation of every visitor. `opref:<id>`
  // finds an operation by id; `active:<installation>` marks work a restart must recover.
  async putOperation(o: Operation) {
    await this.storage.put(operationKey(o.installationId, o.id), o);
    await this.storage.put(key("opref", o.id), o.installationId);

    if (o.status === "queued" || o.status === "running")
      await this.storage.put(key("active", o.installationId), true);
    else if (
      !(await this.operations(o.installationId)).some(
        (x) => x.status === "queued" || x.status === "running",
      )
    )
      await this.storage.delete(key("active", o.installationId));
  }
  async getOperation(id: string) {
    const installationId = await this.get<string>("opref", id);

    return installationId === null
      ? null
      : ((await this.storage.get<Operation>(operationKey(installationId, id))) ?? null);
  }
  async operations(installationId: string) {
    if (!SAFE_ID.test(installationId)) return [];

    return newest([
      ...(
        await this.storage.list<Operation>({ prefix: `${key("operation", installationId)}:` })
      ).values(),
    ]);
  }
  /** Installations with queued or running operations: all a restart has to recover. */
  async activeInstallationIds(): Promise<ReadonlyArray<string>> {
    return [...(await this.storage.list<boolean>({ prefix: "active:" })).keys()].map((k) =>
      k.slice("active:".length),
    );
  }
  async acquireWriter(installationId: string, operationId: string) {
    const holder = await this.writerHolder(installationId);

    if (holder !== null && holder !== operationId) return holder;
    await this.storage.put(key("lock", installationId), operationId);

    return null;
  }
  async releaseWriter(installationId: string, operationId: string) {
    if ((await this.writerHolder(installationId)) === operationId)
      await this.storage.delete(key("lock", installationId));
  }
  async writerHolder(installationId: string) {
    return this.get<string>("lock", installationId);
  }
  /**
   * Appends in call order. Progress lines are appended without waiting, many at once; the
   * counter read and write must not interleave, or appends that read the same value overwrite
   * each other. A Durable Object's input gate orders other events, not promises of this one.
   */
  async appendEvent(e: OnboardingEvent) {
    const append = this.appends.then(async () => {
      const seqKey = key("eventseq", e.installationId);
      const seq = ((await this.storage.get<number>(seqKey)) ?? 0) + 1;
      await this.storage.put(seqKey, seq);
      await this.storage.put(eventKey(e.installationId, seq), e);

      // Also under the operation, so a status poll reads its tail without the whole log.
      if (e.operationId && SAFE_ID.test(e.operationId))
        await this.storage.put(
          `${key("opevent", e.operationId)}:${String(seq).padStart(12, "0")}`,
          e,
        );
    });

    // A failed append must not wedge the ones after it; its caller still sees the error.
    this.appends = append.catch(() => undefined);

    return append;
  }
  async recentEvents(installationId: string, operationId: string, limit: number) {
    if (!SAFE_ID.test(operationId)) return [];

    const tail = await this.storage.list<OnboardingEvent>({
      prefix: `${key("opevent", operationId)}:`,
      reverse: true,
      limit,
    });

    return [...tail.values()].filter((e) => e.installationId === installationId).reverse();
  }
  async events(installationId: string) {
    if (!SAFE_ID.test(installationId)) return [];

    return [
      ...(
        await this.storage.list<OnboardingEvent>({ prefix: `${key("event", installationId)}:` })
      ).values(),
    ];
  }
}

/** Map-backed KeyValueStorage with DurableObjectStorage's ordering (sorted keys). */
export class MapStorage implements KeyValueStorage {
  readonly data = new Map<string, unknown>();

  async get<T>(k: string) {
    // SAFETY: values are only ever written by this store under the same key kind.
    return structuredClone(this.data.get(k)) as T | undefined;
  }
  async put<T>(k: string, v: T) {
    this.data.set(k, structuredClone(v));
  }
  async delete(k: string) {
    return this.data.delete(k);
  }
  async list<T>({
    prefix,
    reverse = false,
    limit = Infinity,
  }: {
    readonly prefix: string;
    readonly reverse?: boolean;
    readonly limit?: number;
  }) {
    const keys = [...this.data.keys()].filter((k) => k.startsWith(prefix)).sort();

    return new Map(
      (reverse ? keys.reverse() : keys)
        .slice(0, limit)
        // SAFETY: as in get().
        .map((k) => [k, structuredClone(this.data.get(k)) as T]),
    );
  }
}
