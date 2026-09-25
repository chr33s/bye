import { describe, expect, it } from "vitest";
import { type LocalDraft, resolveConflict } from "../src/drafts.ts";

const local: LocalDraft = {
  localId: "l1",
  draftId: "drf_1",
  baseRevision: 2,
  to: "a@example.com",
  cc: "",
  bcc: "",
  subject: "Offline edits",
  text: "long offline draft",
  threadId: null,
  updatedAt: 1,
  state: "local",
};

describe("offline drafts", () => {
  it("[X01] a server conflict keeps both copies instead of last-write-wins", () => {
    const merged = resolveConflict(local, {
      revision: 5,
      to: "b@example.com",
      cc: "",
      bcc: "",
      subject: "Other device",
      text: "other",
    });
    expect(merged.state).toBe("conflict");
    expect(merged.baseRevision).toBe(5);
    expect(merged.text).toBe("other");
    expect(merged.conflictCopy?.text).toBe("long offline draft");
  });
});
