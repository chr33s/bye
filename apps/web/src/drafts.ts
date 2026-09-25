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

export const saveLocalDraft = (draft: LocalDraft): Promise<IDBValidKey> =>
  tx("readwrite", (s) => s.put(draft));
export const loadLocalDrafts = (): Promise<Array<LocalDraft>> =>
  tx("readonly", (s) => s.getAll() as IDBRequest<Array<LocalDraft>>);
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
