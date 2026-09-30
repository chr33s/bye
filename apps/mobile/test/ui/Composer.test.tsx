import { act, fireEvent, render, screen } from "@testing-library/react-native";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type { ByeClient } from "../../../../packages/native-shared/src/client.ts";
import { DraftStore, type KeyValueStore } from "../../../../packages/native-shared/src/drafts.ts";
import { Composer } from "../../../../packages/native-shared/src/ui/Composer.tsx";

const memoryKv = (): KeyValueStore & { data: Map<string, string> } => {
  const data = new Map<string, string>();

  return {
    data,
    getItem: async (k) => data.get(k) ?? null,
    setItem: async (k, v) => void data.set(k, v),
    removeItem: async (k) => void data.delete(k),
  };
};

const fakeClient = (overrides: Record<string, Mock> = {}) => ({
  createDraft: vi.fn(async () => ({ draftId: "d1", revision: 1 })),
  saveDraft: vi.fn(async (_m: string, _d: string, revision: number) => ({
    _tag: "Saved",
    revision: revision + 1,
  })),
  getDraft: vi.fn(),
  send: vi.fn(async () => ({ _tag: "Queued", sendJobIds: ["j1"] })),
  cancelSend: vi.fn(async () => ({ _tag: "Cancelled" })),
  sendJob: vi.fn(async () => ({ state: "accepted", outcomes: [] })),
  ...overrides,
});

const renderComposer = async (client = fakeClient(), seed = {}) => {
  const kv = memoryKv();
  const onDone = vi.fn();
  await render(
    <Composer
      client={client as unknown as ByeClient}
      mailboxId="mbx"
      drafts={new DraftStore(kv)}
      seed={seed}
      onDone={onDone}
    />,
  );

  return { client, kv, onDone };
};

const flush = () => act(async () => void (await vi.advanceTimersByTimeAsync(800)));

describe("Composer", () => {
  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => void vi.useRealTimers());

  it("autosaves locally and to the server after typing settles", async () => {
    const { client, kv } = await renderComposer();

    await fireEvent.changeText(screen.getByLabelText("To"), "a@bye.test, b@bye.test");
    await fireEvent.changeText(screen.getByLabelText("Subject"), "Hello");
    expect(client.createDraft).not.toHaveBeenCalled();

    await flush();
    expect(client.createDraft).toHaveBeenCalledWith(
      "mbx",
      expect.objectContaining({
        to: [{ address: "a@bye.test" }, { address: "b@bye.test" }],
        subject: "Hello",
      }),
      undefined,
    );
    expect(screen.getByText("Draft saved")).toBeTruthy();
    expect(JSON.parse(kv.data.get("bye:drafts")!)).toHaveLength(1);
  });

  it("keeps a draft queued on the device when offline — never shown as sent", async () => {
    const client = fakeClient({
      createDraft: vi.fn(async () => Promise.reject(new Error("offline"))),
    });
    await renderComposer(client, { to: "a@bye.test" });

    await fireEvent.press(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText("Queued on this device — not sent yet")).toBeTruthy();
    expect(client.send).not.toHaveBeenCalled();
  });

  it("sends with the chosen after-send action, then allows undo", async () => {
    const { client, kv } = await renderComposer(fakeClient(), { to: "a@bye.test", threadId: "t1" });

    expect(screen.getByRole("header", { name: "Reply" })).toBeTruthy();
    await fireEvent.press(screen.getByRole("radio", { name: "Mark done" }));
    expect(screen.getByRole("radio", { name: "Mark done" })).toBeChecked();

    await fireEvent.press(screen.getByRole("button", { name: "Send" }));
    expect(client.send).toHaveBeenCalledWith("mbx", "d1", 1, undefined, expect.anything());
    expect(screen.getByText("Sending…")).toBeTruthy();
    expect(JSON.parse(kv.data.get("bye:drafts")!)).toEqual([]);

    await fireEvent.press(screen.getByRole("button", { name: "Undo send" }));
    expect(client.cancelSend).toHaveBeenCalledWith("mbx", "j1");
    expect(screen.getByText("Send cancelled")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Send" })).toBeTruthy();
  });

  it("hides reply-only after-send choices on a new message", async () => {
    await renderComposer();

    expect(screen.getByRole("header", { name: "New message" })).toBeTruthy();
    expect(screen.queryByRole("radio", { name: "Mark done" })).toBeNull();
    expect(screen.getByRole("radio", { name: "Keep in place" })).toBeChecked();
  });

  it("polls send jobs after the undo window and shows the outcome", async () => {
    const client = fakeClient({
      sendJob: vi.fn(async () => ({ state: "rejected", failure: { detail: "mailbox full" } })),
    });
    await renderComposer(client, { to: "a@bye.test" });

    await fireEvent.press(screen.getByRole("button", { name: "Send" }));
    await act(async () => void (await vi.advanceTimersByTimeAsync(3_000)));
    expect(client.sendJob).toHaveBeenCalledWith("mbx", "j1");
    expect(screen.getByText("Not sent: mailbox full")).toBeTruthy();
  });
});
