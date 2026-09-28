// File-backed onboarding store for the self-hosted Node process (server.ts). The hosted Worker
// uses do-store.ts; both implement OnboardingStore (store.ts).
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
import {
  newest,
  type Approval,
  type Installation,
  type OnboardingEvent,
  type OnboardingStore,
  type Operation,
  type Review,
} from "./store.ts";

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
  private write<T>(kind: string, id: string, value: T) {
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
  async deleteInstallation(id: string) {
    rmSync(this.path("installations", id), { force: true });
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
  async recentEvents(installationId: string, operationId: string, limit: number) {
    return (await this.events(installationId))
      .filter((e) => e.operationId === operationId)
      .slice(-limit);
  }
}
