import {
  ACCOUNT_REGISTRY,
  type MailAccount,
  type MailReadQuery,
  type MailReadResult,
  MailStore,
  type MailStoreService,
  type MailWriteCommand,
  type MailWriteResult,
  methodError,
  runCall,
} from "@bye/jmap";
import { Effect, Layer, Match, type Schema } from "effect";
import type { KernelClock } from "../durable/kernel.ts";
import type { Sql } from "../durable/sql.ts";
import type { MailboxJmap } from "../mailbox/jmap.ts";
import { JmapCore, type PreparedContent, type Viewer } from "./core.ts";
import { PRINCIPAL_SCOPED } from "./history.ts";
import { type IngestPorts, JmapIngest } from "./ingest.ts";
import { JmapMigration } from "./migration.ts";
import { JmapObjects, type ObjectPorts, type PreparedSubmission } from "./objects.ts";

// One account's JMAP entry point inside its authority (spec.md §16.2): the standard method
// handlers run here, next to the storage, over either the read-only legacy projection (not yet
// migrated) or the JMAP core (C3 state `jmap`). Each call is one consistent synchronous pass.

/** Content the API host prepared for this call's creations, keyed by creation ID (§4). */
export interface PreparedCall {
  readonly emails: ReadonlyArray<readonly [creationId: string, content: PreparedContent]>;
  readonly submissions: ReadonlyArray<readonly [creationId: string, content: PreparedSubmission]>;
}

export interface JmapCallInput {
  readonly principalId: string;
  readonly accountId: string;
  /** From the recovery registry outside this snapshot (C2). */
  readonly restoreGeneration: number;
  readonly name: string;
  readonly args: Schema.JsonObject;
  readonly using: ReadonlyArray<string>;
  readonly createdIds: ReadonlyArray<readonly [string, string]>;
  readonly callId: string;
  readonly prepared?: PreparedCall;
  /** The credential may destroy only drafts (its scopes, checked by the API host). */
  readonly draftsOnlyDestroy?: boolean;
  /** The credential may move mail into Trash (it holds `delete`). Defaults to true. */
  readonly mayTrash?: boolean;
}

/** Plain objects (not tuples): they cross Durable Object RPC without losing their shape. */
/** Types whose objects live in Mailboxes, so their visibility follows Mailbox rights. */
const MAIL_TYPES: ReadonlySet<string> = new Set(["Email", "Thread", "Mailbox"]);

export interface JmapCallOutput {
  readonly responses: ReadonlyArray<{ readonly name: string; readonly args: Schema.JsonObject }>;
  readonly createdIds: { readonly [creationId: string]: string };
}

export class JmapAccount {
  readonly core: JmapCore;
  readonly objects: JmapObjects;
  readonly ingest: JmapIngest;
  readonly migration: JmapMigration;

  constructor(
    sql: Sql,
    clock: KernelClock,
    private readonly projection: MailboxJmap,
    objectPorts: ObjectPorts,
    ingestPorts: IngestPorts,
    schedule: (kind: string, key: string, dueAt: number) => void = () => undefined,
  ) {
    this.core = new JmapCore(sql, clock, schedule);
    this.objects = new JmapObjects(this.core, objectPorts);
    this.ingest = new JmapIngest(this.core, ingestPorts);
    this.migration = new JmapMigration(this.core);
  }

  /** The JMAP core is this account's mail authority (C3 activated). */
  active(): boolean {
    return this.core.mode() === "jmap";
  }

  /** Account description for a principal; null when the principal can't discover it (A3). */
  account(principalId: string, accountId: string, restoreGeneration: number): MailAccount | null {
    if (!this.active())
      return {
        accountId,
        restoreGeneration,
        visibilityGeneration: 0,
        writerEpoch: this.core.epoch(),
        isReadOnly: true,
        profile: "projection",
      };

    if (!this.core.hasAnyGrant(principalId)) return null;

    return {
      accountId,
      restoreGeneration,
      visibilityGeneration: this.core.visibilityGeneration(principalId),
      writerEpoch: this.core.epoch(),
      isReadOnly: false,
      profile: "core",
    };
  }

  private read(viewer: Viewer, query: MailReadQuery): MailReadResult {
    if (!this.active()) return this.projection.read(query);
    const core = this.core;

    return Match.value(query).pipe(
      Match.tagsExhaustive({
        State: (q): MailReadResult => ({ _tag: "State", state: core.state(q.type, viewer) }),
        MailboxGet: (q): MailReadResult => {
          const all = core.mailboxes(viewer);
          const byId = new Map(all.map((m) => [m.id, m]));

          return {
            _tag: "MailboxGet",
            state: core.state("Mailbox"),
            list: q.ids === null ? all : q.ids.flatMap((id) => byId.get(id) ?? []),
            notFound: q.ids === null ? [] : q.ids.filter((id) => !byId.has(id)),
          };
        },
        EmailGet: (q): MailReadResult => ({
          _tag: "EmailGet",
          state: core.state("Email"),
          ...core.emailGet(viewer, q.ids, q.properties),
        }),
        EmailQuery: (q): MailReadResult => core.query(viewer, q),
        ThreadGet: (q): MailReadResult => {
          const list = core.threads(viewer, q.ids);
          const found = new Set(list.map((t) => t.id));

          return {
            _tag: "ThreadGet",
            state: core.state("Thread"),
            list,
            notFound: q.ids.filter((id) => !found.has(id)),
          };
        },
        Changes: (q): MailReadResult =>
          // History isn't kept per Mailbox: a viewer that can't read the whole account would see
          // other Mailboxes' IDs in it, so it refreshes from /get and /query instead (A3).
          MAIL_TYPES.has(q.type) && core.readable(viewer) !== null
            ? {
                _tag: "Refused",
                type: "cannotCalculateChanges",
                description: "changes are not tracked for a partial view of the account",
              }
            : core.history.changes(
                q.type,
                Number(q.base),
                q.target === null ? null : Number(q.target),
                q.cursor,
                q.limit,
                PRINCIPAL_SCOPED.has(q.type) ? viewer.principalId : undefined,
              ),
        ObjectGet: (q): MailReadResult => this.objects.get(viewer, q.type, q.ids),
        Snippets: (q): MailReadResult => core.snippets(viewer, q.ids, q.terms),
        SubmissionQuery: (q): MailReadResult => this.objects.submissionQuery(viewer, q),
      }),
    );
  }

  private write(
    viewer: Viewer,
    command: MailWriteCommand,
    prepared: PreparedCall | undefined,
  ): MailWriteResult {
    const emails = new Map(prepared?.emails ?? []);
    const submissions = new Map(prepared?.submissions ?? []);

    return Match.value(command).pipe(
      Match.tagsExhaustive({
        Set: (c): MailWriteResult => {
          switch (c.type) {
            case "Mailbox":
              return this.core.mailboxSet(viewer, c);
            case "Email":
              return this.core.emailSet(viewer, c, emails);
            default:
              return this.objects.set(viewer, c, submissions);
          }
        },
        Import: (c): MailWriteResult => this.core.emailImport(viewer, c, emails),
        Native: (c): MailWriteResult => this.core.native(viewer, c),
      }),
    );
  }

  /** The MailStore port for one call by one principal. */
  service(
    input: Pick<
      JmapCallInput,
      | "principalId"
      | "accountId"
      | "restoreGeneration"
      | "prepared"
      | "draftsOnlyDestroy"
      | "mayTrash"
    >,
  ): MailStoreService {
    const viewer: Viewer = {
      principalId: input.principalId,
      draftsOnlyDestroy: input.draftsOnlyDestroy === true,
      mayTrash: input.mayTrash !== false,
    };

    const acct = this.account(input.principalId, input.accountId, input.restoreGeneration);

    return {
      accounts: new Map(acct ? [[input.accountId, acct]] : []),
      read: (_accountId, query) => Effect.sync(() => this.read(viewer, query)),
      write: (_accountId, command) =>
        this.active()
          ? Effect.sync(() => this.write(viewer, command, input.prepared))
          : Effect.fail(methodError("accountReadOnly")),
    };
  }

  /** Run one already-resolved method call for one principal (results reference earlier calls). */
  call(input: JmapCallInput): JmapCallOutput {
    const createdIds = new Map(input.createdIds);

    const responses = Effect.runSync(
      runCall(ACCOUNT_REGISTRY, input.name, input.args, {
        using: new Set(input.using),
        createdIds,
        callId: input.callId,
      }).pipe(Effect.provide(Layer.succeed(MailStore, this.service(input)))),
    );

    return {
      responses: responses.map(([name, args]) => ({ name, args })),
      createdIds: Object.fromEntries(createdIds),
    };
  }
}
