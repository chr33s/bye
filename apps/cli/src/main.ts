#!/usr/bin/env -S node --experimental-strip-types
import { EXIT, makeCliApi } from "./client.ts";
import { findCommand, parseArgs } from "./commands.ts";
import { readStored, resolveTarget, TargetError, writeStored } from "./config.ts";
import { type InstanceDeps, runInstance, runLogin } from "./instance.ts";
import { runCli } from "./run.ts";
import { runTui } from "./tui.ts";

const newCommandId = () => `cmd_${crypto.randomUUID().replace(/-/g, "")}`;

const main = async (): Promise<number> => {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  const stdout = (t: string) => void process.stdout.write(`${t}\n`);
  const stderr = (t: string) => void process.stderr.write(`${t}\n`);
  const deps: InstanceDeps = {
    env: process.env,
    read: readStored,
    write: writeStored,
    fetch: (url, init) => fetch(url, init),
    stdout,
    stderr,
  };
  if (args.positionals[0] === "login") return runLogin(args.flags, deps);
  if (args.positionals[0] === "instance")
    return runInstance(args.positionals.slice(1), args.flags, deps);

  let config;
  try {
    config = resolveTarget(await readStored(), process.env);
  } catch (e) {
    // An invalid BYE_API never falls back to another target.
    stderr(e instanceof TargetError ? e.message : String(e));
    return EXIT.usage;
  }
  // The effective target goes to stderr only on request, never into command output.
  if (args.flags.verbose === true || process.env.BYE_VERBOSE === "1")
    stderr(`bye: ${config.apiUrl} (${config.source})`);
  const wantsApi =
    args.positionals[0] === "tui" ||
    (args.flags.help !== true && findCommand(args.positionals) !== undefined);
  if (wantsApi && !config.token) {
    // Unconfigured target: fail locally, no browser prompt and nothing sent over the network.
    stderr(
      `not signed in to ${config.apiUrl} (${config.source}); run \`bye login --api ${config.apiUrl} --token <token>\``,
    );
    return EXIT.unauthenticated;
  }
  const api = makeCliApi(config, (input, init) => fetch(input, init));
  if (args.positionals[0] === "tui") return runTui(api, newCommandId);
  return runCli(argv, api, { stdout, stderr, newCommandId });
};

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`fatal: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  },
);
