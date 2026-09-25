import { client } from "./api.ts";

// Change notifications (§8 Synchronization): hibernating DO WebSocket as an optimization,
// HTTP changes API as the reliable path. Cursor per resource; expired cursor → full refresh.

export const connectLive = (mailboxId: string, onChange: () => void): (() => void) => {
  const key = `bye:cursor:${mailboxId}`;
  let cursor = Number(localStorage.getItem(key) ?? "0");
  let socket: WebSocket | null = null;
  let stopped = false;
  let backoff = 1000;

  const catchUp = async () => {
    // A failed catch-up is skipped, not surfaced: the next socket message or reconnect retries it.
    const page = await client
      .request<{ cursor: number; expired: boolean; changes: ReadonlyArray<unknown> }>(
        "GET",
        "/v1/changes",
        undefined,
        { query: { mailbox: mailboxId, cursor } },
      )
      .catch(() => null);
    if (!page) return;
    if (page.expired || page.changes.length > 0) onChange();
    cursor = page.cursor;
    localStorage.setItem(key, String(cursor));
  };

  const open = () => {
    if (stopped) return;
    const url = new URL(
      `/v1/live?mailbox=${encodeURIComponent(mailboxId)}&cursor=${cursor}`,
      location.href,
    );
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    socket = new WebSocket(url);
    socket.onopen = () => {
      backoff = 1000;
      void catchUp();
    };
    socket.onmessage = () => void catchUp();
    socket.onclose = () => {
      if (!stopped) setTimeout(open, (backoff = Math.min(backoff * 2, 60_000)));
    };
  };

  const poll = setInterval(() => void catchUp().catch(() => undefined), 60_000);
  open();
  return () => {
    stopped = true;
    clearInterval(poll);
    socket?.close();
  };
};
