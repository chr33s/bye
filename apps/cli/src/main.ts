#!/usr/bin/env -S node --experimental-strip-types
import { Effect, Layer } from "effect";
import { cliApiLayer } from "./client.ts";
import { readStored, resolveTarget, writeStored } from "./config.ts";
import type { InstanceDeps } from "./instance.ts";
import { runCli } from "./run.ts";

const newCommandId = () => `cmd_${crypto.randomUUID().replace(/-/g, "")}`;

const main = (): Promise<number> => {
  const stdout = (t: string) => void process.stdout.write(`${t}\n`);
  const stderr = (t: string) => void process.stderr.write(`${t}\n`);

  const instance: InstanceDeps = {
    env: process.env,
    read: readStored,
    write: writeStored,
    fetch: (url, init) => fetch(url, init),
    stdout,
    stderr,
  };

  // The effective target is resolved only for commands that call the API, so `bye login` and
  // `bye instance` still work when BYE_API is invalid or nothing is saved yet.
  const api = Layer.unwrap(
    Effect.tryPromise({
      try: async () =>
        cliApiLayer(resolveTarget(await readStored(), process.env), (input, init) =>
          fetch(input, init),
        ),
      catch: (error) => error,
    }),
  );

  return runCli(process.argv.slice(2), api, {
    stdout,
    stderr,
    newCommandId,
    verbose: process.env.BYE_VERBOSE === "1",
    instance,
  });
};

main().then(
  (code) => process.exit(code),
  (cause: unknown) => {
    process.stderr.write(`fatal: ${cause instanceof Error ? cause.message : String(cause)}\n`);
    process.exit(1);
  },
);
