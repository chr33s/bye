// Offline drafts (X01, §8 Synchronization). Drafts autosave locally and sync with optimistic
// revisions; a conflict keeps both copies instead of last-write-wins. "Queued on this device"
// is never presented as sent until the server records a send intent.
//
// Server sync goes through the shared core in @bye/native-shared/drafts (`pushDraft` +
// `syncedState`), the same as the native composer. The local record differs deliberately: web keeps
// the recipient fields as the raw text the user typed (half-typed addresses, `@group:` tokens,
// invalid entries still being fixed) so an offline reload restores the form exactly; they are
// parsed into contract `MailAddress`es only when content is pushed.

export interface LocalDraft {
  readonly localId: string;
  /**
   * The signed-in user and mailbox that wrote this draft. A browser can be shared: drafts are only
   * ever shown to (and pushed for) the same account, and records without an owner are never shown.
   */
  readonly ownerId?: string;
  readonly mailboxId?: string;
  readonly draftId: string | null;
  readonly baseRevision: number;
  readonly to: string;
  readonly cc: string;
  readonly bcc: string;
  readonly subject: string;
  readonly text: string;
  /** Rich body (sanitized on save); absent for plain-text drafts. */
  readonly html?: string;
  readonly attachments?: ReadonlyArray<{
    readonly uploadId: string;
    readonly filename: string;
    readonly size: number;
    readonly inline?: boolean;
  }>;
  readonly fileLinks?: ReadonlyArray<string>;
  /** Local copies of inline images (upload ID → bytes) so a reopened draft can still show them. */
  readonly inlineImages?: Readonly<Record<string, Blob>>;
  readonly identityId?: string;
  readonly threadId: string | null;
  readonly updatedAt: number;
  readonly state: "local" | "synced" | "conflict" | "queued-send";
  readonly conflictCopy?: Omit<LocalDraft, "conflictCopy">;
}

const DB_NAME = "bye-drafts";
const STORE = "drafts";

const open = (): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: "localId" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

const tx = async <T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> => {
  const db = await open();
  return new Promise((resolve, reject) => {
    const request = fn(db.transaction(STORE, mode).objectStore(STORE));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
};

/** An ownerless draft is never written: it could not be scoped to an account on reload. */
export const saveLocalDraft = (draft: LocalDraft): Promise<IDBValidKey> =>
  draft.ownerId && draft.mailboxId
    ? tx("readwrite", (s) => s.put(draft))
    : Promise.resolve(draft.localId);
export interface DraftOwner {
  readonly userId: string;
  readonly mailboxId: string;
}

/** Only the drafts this account wrote in this mailbox. */
export const draftsOwnedBy = (
  drafts: ReadonlyArray<LocalDraft>,
  owner: DraftOwner,
): Array<LocalDraft> =>
  drafts.filter((d) => d.ownerId === owner.userId && d.mailboxId === owner.mailboxId);

export const loadLocalDrafts = async (owner: DraftOwner): Promise<Array<LocalDraft>> =>
  draftsOwnedBy(await tx("readonly", (s) => s.getAll() as IDBRequest<Array<LocalDraft>>), owner);

/** Remove records written before drafts carried an owner: they can't be attributed to anyone. */
export const pruneUnownedDrafts = async (): Promise<void> => {
  const all = await tx("readonly", (s) => s.getAll() as IDBRequest<Array<LocalDraft>>);
  for (const d of all) if (!d.ownerId) await tx("readwrite", (s) => s.delete(d.localId));
};

/** localStorage key naming the account this browser's local data belongs to. */
export const LOCAL_OWNER_KEY = "bye:owner";

/**
 * What to do with local data when `/v1/me` names `userId`: keep it (same account), claim it (no
 * recorded owner yet: drop unowned drafts), or wipe it (another account's data is here).
 */
export const localOwnerAction = (
  stored: string | null,
  userId: string,
): "keep" | "claim" | "wipe" => (stored === null ? "claim" : stored === userId ? "keep" : "wipe");
export const deleteLocalDraft = (localId: string): Promise<undefined> =>
  tx("readwrite", (s) => s.delete(localId));

/** Merge a server conflict response without discarding either side. */
export const resolveConflict = (
  local: LocalDraft,
  server: { revision: number; to: string; cc: string; bcc: string; subject: string; text: string },
): LocalDraft => ({
  ...local,
  baseRevision: server.revision,
  state: "conflict",
  conflictCopy: { ...local, state: "local" },
  to: server.to,
  cc: server.cc,
  bcc: server.bcc,
  subject: server.subject,
  text: server.text,
});
