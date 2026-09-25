import type { ByeClient } from "./client.ts";
import type { MailDraftContent } from "@bye/contracts";

// Offline drafts for native clients (§8): saved locally first, synced with optimistic revisions.
// A conflict keeps both versions; "queued on this device" is never presented as sent.

export interface KeyValueStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export interface NativeDraft {
  readonly localId: string;
  readonly mailboxId: string;
  readonly draftId: string | null;
  readonly baseRevision: number;
  readonly threadId: string | null;
  readonly content: MailDraftContent;
  readonly state: "local" | "synced" | "conflict" | "queued-send";
  readonly conflictCopy?: MailDraftContent;
  readonly updatedAt: number;
}

const INDEX = "bye:drafts";

export class DraftStore {
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly kv: KeyValueStore) {}

  private serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.queue.then(run, run);
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private async ids(): Promise<Array<string>> {
    return JSON.parse((await this.kv.getItem(INDEX)) ?? "[]") as Array<string>;
  }

  list(): Promise<Array<NativeDraft>> {
    return this.serial(async () => {
      const ids = await this.ids();
      const drafts = await Promise.all(
        ids.map(
          async (id) =>
            JSON.parse((await this.kv.getItem(`${INDEX}:${id}`)) ?? "null") as NativeDraft | null,
        ),
      );
      return drafts.filter((d): d is NativeDraft => d !== null);
    });
  }

  save(draft: NativeDraft): Promise<void> {
    return this.serial(async () => {
      const ids = new Set(await this.ids());
      ids.add(draft.localId);
      await this.kv.setItem(`${INDEX}:${draft.localId}`, JSON.stringify(draft));
      await this.kv.setItem(INDEX, JSON.stringify([...ids]));
    });
  }

  remove(localId: string): Promise<void> {
    return this.serial(async () => {
      const ids = (await this.ids()).filter((id) => id !== localId);
      await this.kv.removeItem(`${INDEX}:${localId}`);
      await this.kv.setItem(INDEX, JSON.stringify(ids));
    });
  }
}

export type DraftState = NativeDraft["state"];

/** Outcome of pushing a local draft's content to the server. Offline is an outcome, not an error. */
export type DraftPush =
  | { readonly _tag: "Synced"; readonly draftId: string; readonly revision: number }
  | { readonly _tag: "Conflict"; readonly revision: number; readonly content: MailDraftContent }
  | { readonly _tag: "Offline" };

/**
 * Push local content with the optimistic revision (§8): create the server draft on first sync,
 * otherwise save against `baseRevision`; a conflict fetches the server copy so the caller can keep
 * both. Shared by the web and native composers so their sync semantics cannot drift.
 */
export const pushDraft = async (
  client: ByeClient,
  draft: {
    readonly mailboxId: string;
    readonly draftId: string | null;
    readonly baseRevision: number;
    readonly threadId: string | null;
  },
  content: MailDraftContent,
  fetchServer: (draftId: string) => Promise<{ revision: number; content: MailDraftContent }> = (
    id,
  ) => client.getDraft(draft.mailboxId, id),
): Promise<DraftPush> => {
  try {
    if (!draft.draftId) {
      const created = await client.createDraft(
        draft.mailboxId,
        content,
        draft.threadId ?? undefined,
      );
      return { _tag: "Synced", draftId: created.draftId, revision: created.revision };
    }
    const saved = await client.saveDraft(
      draft.mailboxId,
      draft.draftId,
      draft.baseRevision,
      content,
    );
    if (saved._tag === "Saved")
      return { _tag: "Synced", draftId: draft.draftId, revision: saved.revision };
    const server = await fetchServer(draft.draftId);
    return { _tag: "Conflict", revision: server.revision, content: server.content };
  } catch {
    return { _tag: "Offline" };
  }
};

/** State after a successful sync: a draft queued to send stays queued — never shown as merely saved. */
export const syncedState = (state: DraftState): DraftState =>
  state === "queued-send" ? "queued-send" : "synced";

/** Push a native draft to the server; returns the new local state (never throws for offline). */
export const syncDraft = async (
  client: ByeClient,
  draft: NativeDraft,
  fetchServer: (draftId: string) => Promise<{ revision: number; content: MailDraftContent }>,
): Promise<NativeDraft> => {
  if (draft.state === "conflict") return draft;
  const pushed = await pushDraft(client, draft, draft.content, fetchServer);
  switch (pushed._tag) {
    case "Offline":
      return draft;
    case "Conflict":
      return {
        ...draft,
        state: "conflict",
        conflictCopy: draft.content,
        content: pushed.content,
        baseRevision: pushed.revision,
      };
    case "Synced":
      return {
        ...draft,
        draftId: pushed.draftId,
        baseRevision: pushed.revision,
        state: syncedState(draft.state),
      };
  }
};
