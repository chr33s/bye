import { Effect, Layer } from "effect";
import { CliOutput, Command } from "effect/unstable/cli";
import { execute, Invocation, NotSignedIn, report, root, signedIn, UsageError } from "./args.ts";
import { CliApi, CliApiError, EXIT, exitCodeFor } from "./client.ts";
import { COMMANDS } from "./commands.ts";
import { TargetError } from "./config.ts";
import { formatOutput } from "./format.ts";
import { type InstanceDeps, LOCAL_COMMANDS } from "./instance.ts";
import { runTui } from "./tui.ts";

export interface RunIO {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly newCommandId: () => string;
  /** Report the effective target on stderr for every API command (BYE_VERBOSE=1). */
  readonly verbose?: boolean;
  /** This machine's config store, for `bye login` and `bye instance`. */
  readonly instance?: InstanceDeps;
}

const tui = Command.make("tui", {}, () =>
  Effect.gen(function* () {
    const invocation = yield* Invocation;
    let api: CliApi["Service"] | undefined;
    yield* report(signedIn, (signedInApi) => {
      api = signedInApi;
    });
    if (api) {
      const layer = Layer.succeed(CliApi, api);
      invocation.exit(yield* Effect.promise(() => runTui(layer, invocation.newCommandId)));
    }
  }),
).pipe(Command.withDescription("Keyboard-only mail and calendar in the terminal"));

const BYE = root([...COMMANDS, ...LOCAL_COMMANDS, tui]);

/** A `-term` before `--` parses as short flags; say how to pass it as text. */
const DASH_HINT = "arguments that start with - (like search exclusions) go after `--`";

/** Execute one CLI invocation against a provided API layer; returns a stable exit code. */
export const runCli = async (
  argv: ReadonlyArray<string>,
  api: Layer.Layer<CliApi, unknown>,
  io: RunIO,
): Promise<number> => {
  let code: number = EXIT.ok;
  const formatter = CliOutput.defaultFormatter();
  const result = await execute(BYE, argv, {
    api,
    newCommandId: io.newCommandId,
    verbose: io.verbose === true,
    stderr: io.stderr,
    ...(io.instance ? { instance: io.instance } : {}),
    succeed: (value, json) => io.stdout(formatOutput(value, json)),
    fail: (failure, json) => {
      if (failure instanceof UsageError) {
        io.stderr(`usage: ${failure.message}`);
        code = EXIT.usage;
      } else if (failure instanceof TargetError) {
        // An invalid BYE_API never falls back to another target.
        io.stderr(failure.message);
        code = EXIT.usage;
      } else if (failure instanceof NotSignedIn) {
        // Unconfigured target: fail locally, no browser prompt and nothing sent over the network.
        io.stderr(failure.message);
        code = EXIT.unauthenticated;
      } else if (failure instanceof CliApiError) {
        io.stderr(
          json
            ? JSON.stringify({
                error: { code: failure.code, message: failure.message, status: failure.status },
              })
            : `error (${failure.code}): ${failure.message}`,
        );
        code = exitCodeFor(failure);
      } else {
        io.stderr(
          `unexpected failure: ${failure instanceof Error ? failure.message : String(failure)}`,
        );
        code = EXIT.failure;
      }
    },
    exit: (exit) => {
      code = exit;
    },
  });
  // Help asked for goes to stdout; help after a usage error goes to stderr, after the errors.
  if (result.usage) {
    if (result.usage.errors.length > 0) {
      io.stderr(formatter.formatErrors(result.usage.errors));
      if (
        result.usage.errors.some((e) => e._tag === "UnrecognizedOption" && /^-[^-]/.test(e.option))
      )
        io.stderr(`hint: ${DASH_HINT}`);
      io.stderr(`see \`${result.usage.commandPath.join(" ")} --help\``);
    } else {
      for (const text of result.printed) io.stdout(text);
    }
    return EXIT.usage;
  }
  for (const text of result.printed) io.stdout(text);
  if (result.failure !== undefined) {
    const failure: unknown = result.failure;
    io.stderr(
      `unexpected failure: ${failure instanceof Error ? failure.message : String(failure)}`,
    );
    return EXIT.failure;
  }
  return code;
};
