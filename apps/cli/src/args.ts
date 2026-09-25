import { Effect } from "effect";
import type { CalendarCommandInput, MailboxCommandInput, QueryParams } from "@bye/native-shared";
import { CliApi } from "./client.ts";

// Argument parsing and the request helpers every CLI command module shares (X02). Commands are
// typed against @bye/contracts; every write carries a fresh command ID so retries are idempotent
// and server audit logs attribute the action to this credential.

export interface ParsedArgs {
  readonly positionals: ReadonlyArray<string>;
  readonly flags: Readonly<Record<string, string | true>>;
}

export class UsageError extends Error {
  override readonly name = "UsageError";
}

const BOOLEAN_FLAGS = new Set([
  "json",
  "yes",
  "off",
  "help",
  "all",
  "seen",
  "new",
  "pin",
  "select",
  "verbose",
]);

export const parseArgs = (argv: ReadonlyArray<string>): ParsedArgs => {
  const positionals: Array<string> = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq > 0) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--") && !BOOLEAN_FLAGS.has(arg.slice(2))) {
          flags[arg.slice(2)] = next;
          i++;
        } else {
          flags[arg.slice(2)] = true;
        }
      }
    } else {
      positionals.push(arg);
    }
  }
  return { positionals, flags };
};

export interface CommandContext {
  readonly args: ParsedArgs;
  readonly newCommandId: () => string;
  /** True when the user explicitly confirmed a consequential action. */
  readonly confirmed: boolean;
}

export interface CommandSpec {
  readonly path: ReadonlyArray<string>;
  readonly summary: string;
  readonly usage: string;
  /** Consequential actions require --yes (or interactive confirmation) and a matching credential scope. */
  readonly consequential?: boolean;
  readonly run: (ctx: CommandContext) => Effect.Effect<unknown, unknown, CliApi>;
}

/** A string-valued flag (boolean flags read as absent). */
export const flag = (ctx: CommandContext, name: string): string | undefined => {
  const value = ctx.args.flags[name];
  return typeof value === "string" ? value : undefined;
};

/** A required positional argument. */
export const required = (ctx: CommandContext, index: number, name: string): string => {
  const value = ctx.args.positionals[index];
  if (value === undefined) throw new UsageError(`missing <${name}>`);
  return value;
};

/** The selected mailbox: `--mailbox`, else the saved default. */
export const mailbox = (ctx: CommandContext) =>
  Effect.gen(function* () {
    const api = yield* CliApi;
    const id = flag(ctx, "mailbox") ?? api.config.mailboxId;
    if (!id)
      throw new UsageError("no mailbox selected: pass --mailbox or run `bye login --mailbox <id>`");
    return id;
  });

/** The selected calendar space: `--calendar`, else the saved default. */
export const calendar = (ctx: CommandContext) =>
  Effect.gen(function* () {
    const api = yield* CliApi;
    const id = flag(ctx, "calendar") ?? api.config.calendarId;
    if (!id)
      throw new UsageError(
        "no calendar selected: pass --calendar or run `bye login --calendar <id>`",
      );
    return id;
  });

export const get = (path: string, query?: QueryParams) =>
  Effect.flatMap(CliApi, (api) => api.request("GET", path, undefined, query));

export const post = (path: string, body: unknown) =>
  Effect.flatMap(CliApi, (api) => api.request("POST", path, body));

export const del = (path: string, query?: QueryParams) =>
  Effect.flatMap(CliApi, (api) => api.request("DELETE", path, undefined, query));

/** GET below the selected mailbox or calendar space (`/v1/mailboxes/:id…`, `/v1/calendars/:id…`). */
export const scoped = (
  ctx: CommandContext,
  kind: "mailboxes" | "calendars",
  suffix: string,
  query?: QueryParams,
) =>
  Effect.flatMap(kind === "mailboxes" ? mailbox(ctx) : calendar(ctx), (id) =>
    get(`/v1/${kind}/${encodeURIComponent(id)}${suffix}`, query),
  );

/** A typed mailbox command against an explicit mailbox (shared with the TUI). */
export const mailboxCommand = (
  mailboxId: string,
  commandId: string,
  command: MailboxCommandInput,
) => post(`/v1/mailboxes/${encodeURIComponent(mailboxId)}/commands`, { commandId, ...command });

/** A typed mailbox command against the selected mailbox. */
export const mailCommand = (ctx: CommandContext, command: MailboxCommandInput) =>
  Effect.flatMap(mailbox(ctx), (id) => mailboxCommand(id, ctx.newCommandId(), command));

/** A typed calendar command against the selected calendar space. */
export const calendarCommand = (ctx: CommandContext, command: CalendarCommandInput) =>
  Effect.flatMap(calendar(ctx), (id) =>
    post(`/v1/calendars/${encodeURIComponent(id)}/commands`, {
      schemaVersion: 1,
      command: { commandId: ctx.newCommandId(), ...command },
    }),
  );
