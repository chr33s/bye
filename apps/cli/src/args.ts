import type { JsonValue } from "./json.ts";
import {
  Cause,
  Console,
  Context,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Path,
  Predicate,
  Stdio,
  Terminal,
} from "effect";
import {
  CliConfig as ParserConfig,
  CliError,
  Command,
  Flag,
  GlobalFlag,
} from "effect/unstable/cli";
import { ChildProcessSpawner } from "effect/unstable/process";
import type {
  CalendarCommandInput,
  MailboxCommandInput,
  QueryParams,
  RequestBody,
} from "@bye/native-shared";
import { CliApi, type CliConfig } from "./client.ts";
import type { InstanceDeps } from "./instance.ts";

// Command-line parsing (effect/unstable/cli) and the request helpers every CLI command module
// shares (X02). Commands are typed against @bye/contracts; every write carries a fresh command ID
// so retries are idempotent and server audit logs attribute the action to this credential.

export const VERSION = "0.2.0";

export class UsageError extends Error {
  override readonly name = "UsageError";
}

/** The effective target has no credential: fail locally, with nothing sent over the network. */
export class NotSignedIn extends Error {
  override readonly name = "NotSignedIn";
  constructor(config: CliConfig) {
    super(
      `not signed in to ${config.apiUrl} (${config.source}); run \`bye login --api ${config.apiUrl} --token <token>\``,
    );
  }
}

// ---- flags ----

/** An optional string flag, `undefined` when absent. */
export const opt = (name: string) =>
  Flag.String(name).pipe(Flag.optional, Flag.map(Option.getOrUndefined));

/** An optional integer flag, `undefined` when absent. */
export const optInt = (name: string) =>
  Flag.Int(name).pipe(Flag.optional, Flag.map(Option.getOrUndefined));

/** A switch that defaults to off. */
export const bool = (name: string) => Flag.Boolean(name).pipe(Flag.withDefault(false));

/** An optional ISO-8601 instant, as epoch milliseconds. */
export const instant = (name: string) =>
  Flag.String(name).pipe(
    Flag.filter(
      (value) => !Number.isNaN(Date.parse(value)),
      () => "an ISO-8601 time",
    ),
    Flag.map(Date.parse),
    Flag.optional,
    Flag.map(Option.getOrUndefined),
  );

const setting = <const Id extends string, A>(id: Id, flag: Flag.Flag<A>, description: string) =>
  GlobalFlag.Setting(id)({ flag: flag.pipe(Flag.withDescription(description)) });

export const Json = setting("json", bool("json"), "Machine-readable output");

export const Yes = setting("yes", bool("yes"), "Confirm a consequential action");

export const Verbose = setting("verbose", bool("verbose"), "Print the effective target to stderr");

export const MailboxFlag = setting(
  "mailbox",
  opt("mailbox"),
  "Mailbox ID (default: the saved one)",
);

export const CalendarFlag = setting(
  "calendar",
  opt("calendar"),
  "Calendar space ID (default: the saved one)",
);

const ROOT_HELP = [
  "bye — mail and calendar from the terminal",
  "",
  "Target precedence: BYE_API (this invocation only), then the saved default, then hosted on first use.",
  "Exit codes: 0 ok, 1 failure, 2 usage, 3 unauthenticated, 4 forbidden, 5 not found, 6 conflict/too-late, 7 rate limited, 8 unavailable",
].join("\n");

/** The `bye` command over the given subcommands, with the global flags every command accepts. */
export const root = (subcommands: ReadonlyArray<Command.Command.Any>) =>
  Command.make("bye").pipe(
    Command.withDescription(ROOT_HELP),
    Command.withSubcommands(subcommands as [Command.Command.Any, ...Array<Command.Command.Any>]),
    Command.withGlobalFlags([Json, Yes, Verbose, MailboxFlag, CalendarFlag]),
  );

/** A command group with no action of its own (`bye mail`, `bye cal`, …). */
export const group = <const Name extends string>(
  name: Name,
  summary: string,
  subcommands: ReadonlyArray<Command.Command.Any>,
) =>
  Command.make(name).pipe(
    Command.withDescription(summary),
    Command.withSubcommands(subcommands as [Command.Command.Any, ...Array<Command.Command.Any>]),
  );

// ---- invocation ----

/** Where a parsed command runs: the API it calls and where its outcome goes (CLI or TUI). */
export class Invocation extends Context.Service<
  Invocation,
  {
    /** The effective target's API, only built for commands that call it. */
    readonly api: Layer.Layer<CliApi, unknown>;
    readonly newCommandId: () => string;
    readonly verbose: boolean;
    readonly stderr: (text: string) => void;
    readonly succeed: (value: JsonValue, json: boolean) => void;
    readonly fail: (cause: unknown, json: boolean) => void;
    /** Local commands (login, instance, tui) report an exit code directly. */
    readonly exit: (code: number) => void;
    /** This machine's config store, for `bye login` and `bye instance`. */
    readonly instance?: InstanceDeps;
  }
>()("cli/Invocation") {}

/** The API client for a signed-in target (reported on stderr with --verbose). */
export const signedIn = Effect.gen(function* () {
  const api = yield* CliApi;
  const { verbose, stderr } = yield* Invocation;

  if (!api.config.token) return yield* Effect.fail(new NotSignedIn(api.config));

  if (verbose || (yield* Verbose)) stderr(`bye: ${api.config.apiUrl} (${api.config.source})`);

  return api;
});

type Settings = GlobalFlag.Setting.Identifier<"json" | "yes" | "verbose" | "mailbox" | "calendar">;

/** Run a body against the effective target; its value or failure goes to the invocation. */
export const report = <A>(
  body: Effect.Effect<A, unknown, CliApi | Invocation | Settings>,
  done: (value: A, json: boolean) => void,
) =>
  Effect.gen(function* () {
    const invocation = yield* Invocation;
    const json = yield* Json;
    const exit = yield* Effect.exit(Effect.provide(body, invocation.api));

    if (Exit.isSuccess(exit)) done(exit.value, json);
    else invocation.fail(Cause.squash(exit.cause), json);
  });

export interface ActionMeta {
  readonly summary: string;
  /** Consequential actions require --yes (or interactive confirmation) and a matching credential scope. */
  readonly consequential?: boolean;
}

/** An API command: parsed input in, one request (or a few) out, the response printed. */
export const action = <const Name extends string, const Config extends Command.Command.Config>(
  name: Name,
  meta: ActionMeta,
  config: Config,
  run: (
    input: Command.Command.Config.Infer<Config>,
  ) => Effect.Effect<JsonValue, unknown, CliApi | Invocation | Settings>,
) =>
  Command.make(name, config, (input) =>
    Effect.gen(function* () {
      const invocation = yield* Invocation;
      yield* report(
        Effect.gen(function* () {
          if (meta.consequential && !(yield* Yes))
            return yield* Effect.fail(
              new UsageError(`\`${name}\` is a consequential action; re-run with --yes to confirm`),
            );
          yield* signedIn;

          return yield* run(input);
        }),
        invocation.succeed,
      );
    }),
  ).pipe(
    Command.withDescription(`${meta.summary}${meta.consequential ? " [requires --yes]" : ""}`),
  );

// ---- running ----

// The CLI module's platform services back prompts and file-typed params, which bye doesn't use,
// so the interactive --wizard built-in is left out.
const unused = Effect.die("unused");

const environment = Layer.mergeAll(
  ParserConfig.layer({
    builtIns: [GlobalFlag.Help, GlobalFlag.Version, GlobalFlag.Completions, GlobalFlag.LogLevel],
  }),
  FileSystem.layerNoop({}),
  Path.layer,
  Stdio.layerTest({}),
  Layer.succeed(
    Terminal.Terminal,
    Terminal.make({
      columns: Effect.sync(() => process.stdout.columns || 80),
      rows: Effect.sync(() => process.stdout.rows || 24),
      readInput: unused,
      readLine: unused,
      display: () => Effect.void,
    }),
  ),
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() => unused),
  ),
);

export interface Execution {
  /** Help, version and completion text the parser printed. */
  readonly printed: ReadonlyArray<string>;
  /** Set when the arguments didn't parse (the printed help is then for the failing command). */
  readonly usage?: CliError.ShowHelp;
  readonly failure?: unknown;
}

/** Parse argv against a command tree and run the selected command. */
export const execute = async (
  command: ReturnType<typeof root>,
  argv: ReadonlyArray<string>,
  invocation: Invocation["Service"],
): Promise<Execution> => {
  const printed: Array<string> = [];

  const capture: Console.Console = Object.assign(Object.create(console), {
    log: (...parts: ReadonlyArray<unknown>) => void printed.push(parts.join(" ")),
    error: (...parts: ReadonlyArray<unknown>) => void printed.push(parts.join(" ")),
  });

  const exit = await Effect.runPromiseExit(
    Command.runWith(command, { version: VERSION, renderErrors: false })(argv).pipe(
      Effect.provideService(Invocation, invocation),
      Effect.provideService(Console.Console, capture),
      Effect.provide(environment),
    ) as Effect.Effect<void, unknown>,
  );

  if (Exit.isSuccess(exit)) return { printed };
  const failure = Cause.squash(exit.cause);

  return CliError.isCliError(failure) && Predicate.isTagged(failure, "ShowHelp")
    ? { printed, usage: failure }
    : { printed, failure };
};

// ---- requests ----

/** The selected mailbox: `--mailbox`, else the saved default. */
export const mailbox = Effect.gen(function* () {
  const api = yield* CliApi;
  const id = (yield* MailboxFlag) ?? api.config.mailboxId;

  if (!id)
    return yield* Effect.fail(
      new UsageError("no mailbox selected: pass --mailbox or run `bye login --mailbox <id>`"),
    );

  return id;
});

/** The selected calendar space: `--calendar`, else the saved default. */
export const calendar = Effect.gen(function* () {
  const api = yield* CliApi;
  const id = (yield* CalendarFlag) ?? api.config.calendarId;

  if (!id)
    return yield* Effect.fail(
      new UsageError("no calendar selected: pass --calendar or run `bye login --calendar <id>`"),
    );

  return id;
});

/** A fresh command ID for one write. */
export const commandId = Effect.map(Invocation, (i) => i.newCommandId());

export const get = (path: string, query?: QueryParams) =>
  Effect.flatMap(CliApi, (api) => api.request("GET", path, undefined, query));

export const post = (path: string, body: RequestBody) =>
  Effect.flatMap(CliApi, (api) => api.request("POST", path, body));

export const patch = (path: string, body: RequestBody) =>
  Effect.flatMap(CliApi, (api) => api.request("PATCH", path, body));

export const del = (path: string, query?: QueryParams) =>
  Effect.flatMap(CliApi, (api) => api.request("DELETE", path, undefined, query));

/** GET below the selected mailbox or calendar space (`/v1/mailboxes/:id…`, `/v1/calendars/:id…`). */
export const scoped = (kind: "mailboxes" | "calendars", suffix: string, query?: QueryParams) =>
  Effect.flatMap(kind === "mailboxes" ? mailbox : calendar, (id) =>
    get(`/v1/${kind}/${encodeURIComponent(id)}${suffix}`, query),
  );

/** A typed mailbox command against an explicit mailbox. */
export const mailboxCommand = (
  mailboxId: string,
  commandId: string,
  command: MailboxCommandInput,
) =>
  // Commands are typed by the contract; only `SetPreference.value` is open, and it is JSON on the wire.
  post(`/v1/mailboxes/${encodeURIComponent(mailboxId)}/commands`, {
    commandId,
    ...command,
  } as RequestBody);

/** A typed mailbox command against the selected mailbox. */
export const mailCommand = (command: MailboxCommandInput) =>
  Effect.gen(function* () {
    const id = yield* mailbox;

    return yield* mailboxCommand(id, yield* commandId, command);
  });

/** A typed calendar command against the selected calendar space. */
export const calendarCommand = (command: CalendarCommandInput) =>
  Effect.gen(function* () {
    const id = yield* calendar;

    return yield* post(`/v1/calendars/${encodeURIComponent(id)}/commands`, {
      schemaVersion: 1,
      command: { commandId: yield* commandId, ...command },
    });
  });
