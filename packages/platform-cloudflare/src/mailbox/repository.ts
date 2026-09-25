import {
  type MailboxDeliveryCommit,
  type MailboxDeliveryCommitted,
  MailboxRejected,
  MailboxRepository,
  MailboxUnavailable,
} from "@bye/application";
import type { MailboxCommand, MailViewPage, MailViewQuery } from "@bye/contracts";
import { Effect, Layer } from "effect";
import { applyMailboxCommand } from "./commands.ts";
import { type RpcResult, toRpcSync } from "../durable/rpc.ts";
import { guardMailboxRead, type MailboxReadQuery } from "./reads.ts";
import type { MailboxStore } from "./store.ts";

/** MailboxDO RPC results use the platform-wide envelope (durable/rpc.ts). */
export type MailboxRpcResult<A> = RpcResult<A>;

/** The RPC surface a MailboxDO exposes; each method runs one synchronous local transaction. */
export interface MailboxRpc {
  execute(command: MailboxCommand): MailboxRpcResult<unknown> | Promise<MailboxRpcResult<unknown>>;
  view(
    query: MailViewQuery,
  ): MailboxRpcResult<MailViewPage> | Promise<MailboxRpcResult<MailViewPage>>;
  thread(threadId: string): MailboxRpcResult<unknown> | Promise<MailboxRpcResult<unknown>>;
  changes(
    cursor: number,
  ):
    | MailboxRpcResult<{ changes: ReadonlyArray<unknown>; cursor: number; expired: boolean }>
    | Promise<
        MailboxRpcResult<{ changes: ReadonlyArray<unknown>; cursor: number; expired: boolean }>
      >;
  commitDelivery(
    input: MailboxDeliveryCommit,
  ):
    | MailboxRpcResult<MailboxDeliveryCommitted>
    | Promise<MailboxRpcResult<MailboxDeliveryCommitted>>;
  read(query: MailboxReadQuery): MailboxRpcResult<unknown> | Promise<MailboxRpcResult<unknown>>;
}

/** The same surface, answered synchronously by a local store. */
export type LocalMailboxRpc = {
  readonly [K in keyof MailboxRpc]: (
    ...args: Parameters<MailboxRpc[K]>
  ) => Awaited<ReturnType<MailboxRpc[K]>>;
};

const guard = toRpcSync;

/** Build the RPC handlers a MailboxDO class delegates to. */
export const makeMailboxRpcHandlers = (store: MailboxStore): LocalMailboxRpc => ({
  execute: (command) => guard(() => applyMailboxCommand(store, command) ?? null),
  view: (query) =>
    guard((): MailViewPage =>
      store.views.listView({
        view: query.view,
        ...(query.label ? { label: query.label } : {}),
        ...(query.cursor ? { cursor: query.cursor } : {}),
        ...(query.limit ? { limit: query.limit } : {}),
      }),
    ),
  thread: (threadId) => guard(() => store.views.getThread(threadId)),
  changes: (cursor) => guard(() => store.changes(cursor)),
  commitDelivery: (input) =>
    guard(() => {
      const r = store.ingest.commitDelivery(input);
      return {
        deliveryId: r.deliveryId,
        threadId: r.threadId,
        disposition: r.disposition,
        replayed: r.replayed,
      };
    }),
  read: (query) => guardMailboxRead(store, query),
});

const lift = <A>(op: string, f: () => MailboxRpcResult<A> | Promise<MailboxRpcResult<A>>) =>
  Effect.tryPromise({
    try: async () => await f(),
    catch: (e) =>
      new MailboxUnavailable({
        detail: `${op}: ${e instanceof Error ? e.message : "rpc failure"}`,
      }),
  }).pipe(
    Effect.flatMap((r) =>
      r.ok
        ? Effect.succeed(r.value)
        : Effect.fail(
            new MailboxRejected({
              code: r.code,
              message: r.message,
              ...(r.details ? { details: r.details } : {}),
            }),
          ),
    ),
  );

/** MailboxRepository over per-mailbox RPC stubs (DO namespace `getByName(mailboxId)` in Workers). */
export const makeRpcMailboxRepository = (stubFor: (mailboxId: string) => MailboxRpc) =>
  MailboxRepository.of({
    execute: (id, command) => lift("execute", () => stubFor(id).execute(command)),
    view: (id, query) => lift("view", () => stubFor(id).view(query)),
    thread: (id, threadId) => lift("thread", () => stubFor(id).thread(threadId)),
    changes: (id, cursor) => lift("changes", () => stubFor(id).changes(cursor)),
    commitDelivery: (id, input) => lift("commitDelivery", () => stubFor(id).commitDelivery(input)),
    // The query's shape is validated by the authority (unknown tags are rejected there).
    read: (id, query) => lift("read", () => stubFor(id).read(query as MailboxReadQuery)),
  });

export const RpcMailboxRepositoryLive = (stubFor: (mailboxId: string) => MailboxRpc) =>
  Layer.succeed(MailboxRepository, makeRpcMailboxRepository(stubFor));

/** In-process repository over local stores (tests, single-isolate tools). */
export const LocalMailboxRepositoryLive = (stores: (mailboxId: string) => MailboxStore) =>
  RpcMailboxRepositoryLive((id) => makeMailboxRpcHandlers(stores(id)));
