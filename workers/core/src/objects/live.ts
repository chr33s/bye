// Live change-hint sockets shared by the mailbox, calendar and shared-space authorities (§8).
// Sockets carry only sequence hints; clients catch up through each authority's changes API.
// Authorization happens in the API Worker, which tags the socket with the verified credential
// (`x-bye-credential`) so revoking that credential closes exactly its sockets.

type SocketState = {
  acceptWebSocket(ws: WebSocket, tags?: Array<string>): void;
  getWebSockets(tag?: string): Array<WebSocket>;
};

/** Accept a hibernating socket tagged with the API-verified credential; send the current seq. */
export const acceptLiveSocket = (ctx: SocketState, request: Request, seq: number): Response => {
  if (request.headers.get("upgrade") !== "websocket")
    return new Response("expected websocket", { status: 426 });
  const pair = new WebSocketPair();
  const tag = request.headers.get("x-bye-credential");
  ctx.acceptWebSocket(pair[1], tag ? [`cred:${tag.slice(0, 128)}`] : []);
  pair[1].send(JSON.stringify({ seq }));

  return new Response(null, { status: 101, webSocket: pair[0] });
};

/** Send the latest sequence to every open socket (a small invalidation, never data). */
export const broadcastSeq = (ctx: SocketState, seq: number): void => {
  for (const socket of ctx.getWebSockets()) {
    try {
      socket.send(JSON.stringify({ seq }));
    } catch {
      // closed sockets are cleaned up by the runtime
    }
  }
};

/** Close sockets for a revoked credential (or all, when none is given). */
export const closeLiveSockets = (ctx: SocketState, credentialId?: string): number => {
  const sockets = credentialId ? ctx.getWebSockets(`cred:${credentialId}`) : ctx.getWebSockets();

  for (const ws of sockets) {
    try {
      ws.close(4401, "session revoked");
    } catch {
      // already closed
    }
  }

  return sockets.length;
};
