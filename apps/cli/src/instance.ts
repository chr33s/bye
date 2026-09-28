import type { RequestBody } from "@bye/native-shared";
import { probeInstance, type ProbeFetch, PROBE_ERRORS } from "@bye/native-shared/instance";
import { Effect, Match, Predicate } from "effect";
import { Argument, Command } from "effect/unstable/cli";
import { bool, CalendarFlag, Invocation, Json, MailboxFlag, opt } from "./args.ts";
import { EXIT } from "./client.ts";
import {
  normalizeTarget,
  resolveTarget,
  type SavedInstance,
  type StoredConfig,
  type TargetEnv,
  TargetError,
  targetOptions,
  withInstance,
  withoutInstance,
} from "./config.ts";

// `bye login` and `bye instance …`: the CLI side of instance selection (spec §10 CLI).
// These are local configuration commands; they print to stdout only what was asked for, so the
// effective target never leaks into another command's machine-readable output.

export const CLI_CLIENT_ID = "bye-cli";

export interface InstanceDeps {
  readonly env: TargetEnv;
  readonly read: () => Promise<StoredConfig>;
  readonly write: (config: StoredConfig) => Promise<void>;
  readonly fetch: ProbeFetch;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

type Flags = Readonly<Record<string, string | boolean>>;

const str = (flags: Flags, k: string) => (Predicate.isString(flags[k]) ? flags[k] : undefined);

export const runLogin = async (flags: Flags, deps: InstanceDeps): Promise<number> => {
  const stored = await deps.read();
  const current = resolveTarget(stored, { ...deps.env, BYE_API: undefined, BYE_TOKEN: undefined });
  let url: string;

  try {
    url = str(flags, "api") ? normalizeTarget(str(flags, "api")!, deps.env) : current.apiUrl;
  } catch (e) {
    deps.stderr((e as Error).message);

    return EXIT.usage;
  }

  const token = str(flags, "token");
  const mailboxId = str(flags, "mailbox");
  const calendarId = str(flags, "calendar");

  const entry: SavedInstance = {
    token: token || undefined,
    mailboxId: mailboxId || undefined,
    calendarId: calendarId || undefined,
  };

  await deps.write(withInstance(stored, url, entry, { select: true }));
  deps.stdout(`saved (${url})`);

  return EXIT.ok;
};

export const runInstance = async (
  positionals: ReadonlyArray<string>,
  flags: Flags,
  deps: InstanceDeps,
): Promise<number> => {
  const [sub = "show", target] = positionals;
  const json = flags.json === true;
  const stored = await deps.read();

  const out = (value: RequestBody, text: string) =>
    deps.stdout(json ? JSON.stringify(value, null, 2) : text);

  const need = (): string | null => {
    if (!target) {
      deps.stderr(`usage: bye instance ${sub} <url>`);

      return null;
    }

    try {
      return normalizeTarget(target, deps.env);
    } catch (e) {
      deps.stderr((e as Error).message);

      return null;
    }
  };

  switch (sub) {
    case "show": {
      let effective;

      try {
        effective = resolveTarget(stored, deps.env);
      } catch (e) {
        deps.stderr(e instanceof TargetError ? e.message : String(e));

        return EXIT.usage;
      }

      const saved = stored.instances[effective.apiUrl];

      const value = {
        url: effective.apiUrl,
        source: effective.source,
        credential: deps.env.BYE_TOKEN ? "BYE_TOKEN" : saved?.token ? "saved" : "none",
        issuer: saved?.issuer ?? null,
        savedDefault: stored.selected,
      };

      out(
        value,
        [
          `${value.url} (${value.source})`,
          `credential: ${value.credential}`,
          ...(value.issuer ? [`issuer: ${value.issuer}`] : []),
          ...(value.source === "BYE_API" ? [`saved default: ${stored.selected ?? "none"}`] : []),
        ].join("\n"),
      );

      return EXIT.ok;
    }

    case "list": {
      const items = Object.entries(stored.instances).map(([url, i]) => ({
        url,
        selected: url === stored.selected,
        credential: Boolean(i.token),
        issuer: i.issuer ?? null,
      }));

      out(
        { items },
        items.length
          ? items
              .map(
                (i) =>
                  `${i.selected ? "*" : " "} ${i.url}${i.credential ? "" : "  (no credential)"}`,
              )
              .join("\n")
          : "no saved instances",
      );

      return EXIT.ok;
    }

    case "add": {
      const url = need();

      if (!url) return EXIT.usage;

      const result = await probeInstance(url, {
        fetch: deps.fetch,
        clientId: CLI_CLIENT_ID,
        redirectUri: null,
        ...targetOptions(deps.env),
      });

      if (!Predicate.isTagged(result, "Valid")) {
        const message = Match.value(result).pipe(
          Match.tag(
            "Moved",
            (moved) =>
              `not added: ${url} points to ${moved.location ?? "another address"}; validate that address separately`,
          ),
          Match.tag("Unreachable", (down) => `not added: ${url} is unreachable (${down.detail})`),
          Match.orElse(
            (invalid) =>
              `not added: ${PROBE_ERRORS[invalid.reason]}${invalid.detail ? ` (${invalid.detail})` : ""}`,
          ),
        );

        deps.stderr(message);

        return Predicate.isTagged(result, "Unreachable") ? EXIT.unavailable : EXIT.failure;
      }

      const previous = stored.instances[url];
      // A changed issuer means new authorization: the old credential is not carried over.
      const keep = previous?.issuer === undefined || previous.issuer === result.instance.issuer;
      const token = str(flags, "token");

      const added: SavedInstance = { issuer: result.instance.issuer, token: token || undefined };

      const next = withInstance(keep ? stored : withoutInstance(stored, url), url, added, {
        select: flags.select === true || stored.selected === null,
      });

      await deps.write(next);
      out(
        { url, issuer: result.instance.issuer, selected: next.selected === url },
        `added ${url}${result.instance.issuer !== url ? ` (sign-in: ${result.instance.issuer})` : ""}${next.selected === url ? " and selected it" : ""}`,
      );

      return EXIT.ok;
    }

    case "use": {
      const url = need();

      if (!url) return EXIT.usage;

      if (!stored.instances[url]) {
        deps.stderr(`${url} isn't saved; run \`bye instance add ${url}\` first`);

        return EXIT.usage;
      }

      await deps.write({ ...stored, selected: url });
      out({ selected: url }, `default: ${url}`);

      return EXIT.ok;
    }

    case "remove": {
      const url = need();

      if (!url) return EXIT.usage;

      if (!stored.instances[url]) {
        deps.stderr(`${url} isn't saved`);

        return EXIT.notFound;
      }

      await deps.write(withoutInstance(stored, url));
      out(
        { removed: url },
        `removed ${url} and its credential from this machine (the account on the server is unchanged)`,
      );

      return EXIT.ok;
    }

    default:
      deps.stderr(`unknown instance command: ${sub}`);

      return EXIT.usage;
  }
};

// ---- commands ----

/** Run a local command with this machine's config store; it reports its own exit code. */
const local = (run: (deps: InstanceDeps, json: boolean) => Promise<number>) =>
  Effect.gen(function* () {
    const invocation = yield* Invocation;
    const json = yield* Json;
    const deps = invocation.instance;

    if (!deps) {
      invocation.stderr("instance configuration isn't available here");

      return invocation.exit(EXIT.failure);
    }

    invocation.exit(yield* Effect.promise(() => run(deps, json)));
  });

const flags = (entries: Record<string, string | boolean | undefined>): Flags =>
  Object.fromEntries(
    Object.entries(entries).filter(([, v]) => v !== undefined && v !== false),
  ) as Flags;

const url = Argument.String("url");

const show = (name: string) =>
  Command.make(name, {}, () => local((deps, json) => runInstance(["show"], flags({ json }), deps)));

export const LOCAL_COMMANDS = [
  Command.make("login", { api: opt("api"), token: opt("token") }, ({ api, token }) =>
    Effect.gen(function* () {
      const mailbox = yield* MailboxFlag;
      const calendar = yield* CalendarFlag;
      yield* local((deps) => runLogin(flags({ api, token, mailbox, calendar }), deps));
    }),
  ).pipe(
    Command.withDescription(
      "Save a credential for an instance and select it (--api <url> --token <token> [--mailbox id] [--calendar id])",
    ),
  ),
  show("instance").pipe(
    Command.withDescription(
      "Instances: the effective target, where it came from, and whether a credential is saved",
    ),
    Command.withSubcommands([
      show("show").pipe(
        Command.withDescription(
          "Effective target, where it came from, and whether a credential is saved",
        ),
      ),
      Command.make("list", {}, () =>
        local((deps, json) => runInstance(["list"], flags({ json }), deps)),
      ).pipe(Command.withDescription("Saved instances")),
      Command.make(
        "add",
        { url, select: bool("select"), token: opt("token") },
        ({ url, select, token }) =>
          local((deps, json) => runInstance(["add", url], flags({ json, select, token }), deps)),
      ).pipe(Command.withDescription("Validate a compatible instance and save it")),
      Command.make("use", { url }, ({ url }) =>
        local((deps, json) => runInstance(["use", url], flags({ json }), deps)),
      ).pipe(Command.withDescription("Make a saved instance the default")),
      Command.make("remove", { url }, ({ url }) =>
        local((deps, json) => runInstance(["remove", url], flags({ json }), deps)),
      ).pipe(Command.withDescription("Forget an instance and its credential on this machine")),
    ]),
  ),
];
