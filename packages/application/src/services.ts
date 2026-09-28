import type { QueueMessage } from "@bye/contracts";
import { Context, Effect, Schema } from "effect";

// Infrastructure enters application code only through these services (§7.1).

export class Ids extends Context.Service<
  Ids,
  { readonly make: (prefix: string) => Effect.Effect<string> }
>()("app/Ids") {}

export type Scope =
  | "read"
  | "draft"
  | "send"
  | "screen"
  | "delete"
  | "calendar"
  | "publish"
  | "admin";

export const ALL_SCOPES: ReadonlyArray<Scope> = [
  "read",
  "draft",
  "send",
  "screen",
  "delete",
  "calendar",
  "publish",
  "admin",
];

/** Default agent credentials are read/draft only (§8). */
export const DEFAULT_AGENT_SCOPES: ReadonlyArray<Scope> = ["read", "draft"];

/** Verified principal constructed from credentials, never from client JSON (§3.2). Per-request only. */
export interface PrincipalContext {
  readonly userId: string;
  readonly sessionId: string;
  readonly kind: "user" | "agent" | "cli";
  readonly scopes: ReadonlyArray<Scope>;
  readonly mailboxIds: ReadonlyArray<string>;
  readonly calendarIds: ReadonlyArray<string>;
  readonly organizationIds: ReadonlyArray<string>;
}

export class Principal extends Context.Service<Principal, PrincipalContext>()("app/Principal") {}

export class Forbidden extends Schema.TaggedError<Forbidden>()("Forbidden", {
  reason: Schema.String,
}) {}

export class NotFound extends Schema.TaggedError<NotFound>()("NotFound", {
  resource: Schema.String,
}) {}

export class Conflict extends Schema.TaggedError<Conflict>()("Conflict", {
  reason: Schema.String,
  currentRevision: Schema.optional(Schema.Number),
}) {}

export class Unavailable extends Schema.TaggedError<Unavailable>()("Unavailable", {
  dependency: Schema.String,
  detail: Schema.String,
}) {}

export const requireScope = (scope: Scope) =>
  Effect.gen(function* () {
    const principal = yield* Principal;

    if (!principal.scopes.includes(scope))
      return yield* new Forbidden({ reason: `missing scope ${scope}` });

    return principal;
  });

export const requireMailbox = (mailboxId: string, scope: Scope) =>
  Effect.gen(function* () {
    const principal = yield* requireScope(scope);

    if (!principal.mailboxIds.includes(mailboxId))
      return yield* new Forbidden({ reason: "mailbox not granted" });

    return principal;
  });

export const requireCalendar = (calendarId: string, scope: Scope) =>
  Effect.gen(function* () {
    const principal = yield* requireScope(scope);

    if (!principal.calendarIds.includes(calendarId))
      return yield* new Forbidden({ reason: "calendar not granted" });

    return principal;
  });

export class BlobStoreFailure extends Schema.TaggedError<BlobStoreFailure>()("BlobStoreFailure", {
  op: Schema.String,
  detail: Schema.String,
}) {}

export interface BlobObject {
  readonly key: string;
  readonly size: number;
  readonly contentType: string | undefined;
  readonly body: ReadableStream<Uint8Array>;
  readonly bytes: () => Promise<Uint8Array>;
}

export class BlobStore extends Context.Service<
  BlobStore,
  {
    readonly put: (
      key: string,
      body: ReadableStream<Uint8Array> | Uint8Array | string,
      meta?: { readonly contentType?: string; readonly size?: number },
    ) => Effect.Effect<{ readonly key: string; readonly size: number }, BlobStoreFailure>;
    readonly get: (key: string) => Effect.Effect<BlobObject | null, BlobStoreFailure>;
    readonly head: (
      key: string,
    ) => Effect.Effect<{ readonly size: number } | null, BlobStoreFailure>;
    readonly delete: (key: string) => Effect.Effect<void, BlobStoreFailure>;
  }
>()("app/BlobStore") {}

export class QueueFailure extends Schema.TaggedError<QueueFailure>()("QueueFailure", {
  queue: Schema.String,
  detail: Schema.String,
}) {}

export type QueueName = "ingest" | "dispatch" | "index" | "notify" | "propagate";

/** Small message that stands in for an oversize body stored elsewhere. */
export interface QueueRefBody {
  readonly schemaVersion: 1;
  readonly type: "ref";
  readonly key: string;
}

/** A wire message body: a decoded queue message or a small offload reference. */
export type QueueWireBody = QueueMessage | QueueRefBody;

/** A JSON request payload as received over HTTP or RPC, decoded by the use case that owns it. */
export type RequestPayload = object | string | number | boolean | null | undefined;

export class QueuePublisher extends Context.Service<
  QueuePublisher,
  {
    readonly send: (queue: QueueName, body: QueueWireBody) => Effect.Effect<void, QueueFailure>;
    readonly sendBatch: (
      queue: QueueName,
      bodies: ReadonlyArray<QueueWireBody>,
    ) => Effect.Effect<void, QueueFailure>;
  }
>()("app/QueuePublisher") {}

/** Ingestion ID from an original's key (`t/<scope>/orig/<ingestionId>.eml`); parts are keyed by it. */
export const ingestionIdOf = (messageKey: string): string =>
  /\/orig\/([^/]+)\.eml$/.exec(messageKey)?.[1] ?? "";

/** Tenant-scoped blob keys (§4.1). Keys never embed addresses or subjects. */
export const blobKey = {
  original: (mailboxScope: string, ingestionId: string) =>
    `t/${mailboxScope}/orig/${ingestionId}.eml`,
  part: (mailboxScope: string, messageId: string, partId: string) =>
    `t/${mailboxScope}/part/${messageId}/${partId}`,
  body: (mailboxScope: string, messageId: string) => `t/${mailboxScope}/body/${messageId}.json`,
  upload: (mailboxScope: string, uploadId: string) => `t/${mailboxScope}/upload/${uploadId}`,
  outbound: (mailboxScope: string, sendJobId: string) => `t/${mailboxScope}/out/${sendJobId}.eml`,
  export: (userScope: string, exportId: string, name: string) =>
    `t/${userScope}/export/${exportId}/${name}`,
  published: (authorId: string, postId: string, revision: number, name: string) =>
    `pub/${authorId}/${postId}/${revision}/${name}`,
} as const;
