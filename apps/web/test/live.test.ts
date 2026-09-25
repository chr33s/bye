import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Change notifications (§8 Synchronization) with a fake WebSocket, fake timers and an in-memory
// localStorage; the changes API is mocked at the shared client.
const request = vi.hoisted(() => vi.fn());
vi.mock("../src/api.ts", () => ({ client: { request } }));

const { connectLive } = await import("../src/live.ts");

class FakeSocket {
  static opened: Array<FakeSocket> = [];
  onopen: (() => void) | null = null;
  onmessage: (() => void) | null = null;
  onclose: (() => void) | null = null;
  closed = false;
  constructor(readonly url: URL) {
    FakeSocket.opened.push(this);
  }
  close() {
    this.closed = true;
  }
}

const page = (cursor: number, changes: ReadonlyArray<unknown> = [], expired = false) => ({
  cursor,
  expired,
  changes,
});

describe("connectLive", () => {
  let storage: Map<string, string>;

  beforeEach(() => {
    vi.useFakeTimers();
    storage = new Map();
    FakeSocket.opened = [];
    request.mockReset();
    vi.stubGlobal("WebSocket", FakeSocket);
    vi.stubGlobal("location", new URL("https://app.bye.test/#/mail"));
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => void storage.set(k, v),
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const socket = (i = -1) => FakeSocket.opened.at(i)!;

  it("[X01] resumes from the persisted cursor and persists the next one", async () => {
    storage.set("bye:cursor:mbx_1", "41");
    request.mockResolvedValue(page(45, [{ kind: "thread" }]));
    const onChange = vi.fn();
    const stop = connectLive("mbx_1", onChange);
    expect(socket().url.href).toBe("wss://app.bye.test/v1/live?mailbox=mbx_1&cursor=41");
    socket().onopen?.();
    await vi.waitFor(() => expect(storage.get("bye:cursor:mbx_1")).toBe("45"));
    expect(request).toHaveBeenCalledWith("GET", "/v1/changes", undefined, {
      query: { mailbox: "mbx_1", cursor: 41 },
    });
    expect(onChange).toHaveBeenCalledTimes(1);

    // The next catch-up asks from the new cursor; an empty page is not a change.
    request.mockResolvedValue(page(45));
    socket().onmessage?.();
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    expect(request.mock.calls[1]?.[3]).toEqual({ query: { mailbox: "mbx_1", cursor: 45 } });
    expect(onChange).toHaveBeenCalledTimes(1);
    stop();
  });

  it("[X01] an expired cursor triggers a full refresh even with no changes", async () => {
    request.mockResolvedValue(page(900, [], true));
    const onChange = vi.fn();
    const stop = connectLive("mbx_1", onChange);
    socket().onopen?.();
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    expect(storage.get("bye:cursor:mbx_1")).toBe("900");
    stop();
  });

  it("[X01] a failed catch-up keeps the cursor and does not signal a change", async () => {
    storage.set("bye:cursor:mbx_1", "7");
    request.mockRejectedValue(new TypeError("offline"));
    const onChange = vi.fn();
    const stop = connectLive("mbx_1", onChange);
    socket().onopen?.();
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(onChange).not.toHaveBeenCalled();
    expect(storage.get("bye:cursor:mbx_1")).toBe("7");
    stop();
  });

  it("[X01] reconnects with exponential backoff capped at 60s, reset by a successful open", () => {
    request.mockResolvedValue(page(0));
    const stop = connectLive("mbx_1", () => undefined);
    const delays: Array<number> = [];
    for (let i = 0; i < 8; i++) {
      const before = FakeSocket.opened.length;
      socket().onclose?.();
      let waited = 0;
      while (FakeSocket.opened.length === before) {
        vi.advanceTimersByTime(1000);
        waited += 1000;
      }
      delays.push(waited);
    }
    expect(delays).toEqual([2000, 4000, 8000, 16_000, 32_000, 60_000, 60_000, 60_000]);

    socket().onopen?.();
    const before = FakeSocket.opened.length;
    socket().onclose?.();
    vi.advanceTimersByTime(1999);
    expect(FakeSocket.opened.length).toBe(before);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.opened.length).toBe(before + 1);
    stop();
  });

  it("[X01] stop closes the socket, cancels polling and never reconnects", () => {
    request.mockResolvedValue(page(0));
    const stop = connectLive("mbx_1", () => undefined);
    vi.advanceTimersByTime(60_000);
    expect(request).toHaveBeenCalledTimes(1);
    stop();
    expect(socket().closed).toBe(true);
    socket().onclose?.();
    vi.advanceTimersByTime(10 * 60_000);
    expect(FakeSocket.opened).toHaveLength(1);
    expect(request).toHaveBeenCalledTimes(1);
  });
});
