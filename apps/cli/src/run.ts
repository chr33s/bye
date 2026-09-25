import { Cause, Effect, Exit, Layer } from "effect";
import { CliApi, CliApiError, EXIT, exitCodeFor } from "./client.ts";
import { findCommand, helpText, parseArgs, UsageError } from "./commands.ts";
import { formatOutput } from "./format.ts";

export interface RunIO {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly newCommandId: () => string;
}

/** Execute one CLI invocation against a provided API layer; returns a stable exit code. */
export const runCli = async (
  argv: ReadonlyArray<string>,
  api: Layer.Layer<CliApi>,
  io: RunIO,
): Promise<number> => {
  const args = parseArgs(argv);
  const json = args.flags.json === true;
  if (args.positionals.length === 0 || args.flags.help === true) {
    io.stdout(helpText());
    return args.positionals.length === 0 && args.flags.help !== true ? EXIT.usage : EXIT.ok;
  }
  const match = findCommand(args.positionals);
  if (!match) {
    io.stderr(`unknown command: ${args.positionals.join(" ")}\n\n${helpText()}`);
    return EXIT.usage;
  }
  const { spec, rest } = match;
  if (spec.consequential && args.flags.yes !== true) {
    io.stderr(`\`${spec.path.join(" ")}\` is a consequential action; re-run with --yes to confirm`);
    return EXIT.usage;
  }
  const ctx = {
    args: { positionals: rest, flags: args.flags },
    newCommandId: io.newCommandId,
    confirmed: args.flags.yes === true,
  };
  const exit = await Effect.runPromiseExit(
    Effect.suspend(() => spec.run(ctx)).pipe(Effect.provide(api)) as Effect.Effect<
      unknown,
      unknown
    >,
  );
  if (Exit.isSuccess(exit)) {
    io.stdout(formatOutput(exit.value, json));
    return EXIT.ok;
  }
  const failure = Cause.squash(exit.cause);
  if (failure instanceof UsageError) {
    io.stderr(`usage: ${failure.message}\n  ${spec.usage}`);
    return EXIT.usage;
  }
  if (failure instanceof CliApiError) {
    io.stderr(
      json
        ? JSON.stringify({
            error: { code: failure.code, message: failure.message, status: failure.status },
          })
        : `error (${failure.code}): ${failure.message}`,
    );
    return exitCodeFor(failure);
  }
  io.stderr(`unexpected failure: ${failure instanceof Error ? failure.message : String(failure)}`);
  return EXIT.failure;
};
