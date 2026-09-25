import { probeInstance, type ProbeFetch, PROBE_ERRORS } from "@bye/native-shared/instance";
import { EXIT } from "./client.ts";
import {
  normalizeTarget,
  resolveTarget,
  type StoredConfig,
  type TargetEnv,
  TargetError,
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

export const INSTANCE_HELP = [
  "  bye instance [show]            effective target, where it came from, and whether a credential is saved",
  "  bye instance list              saved instances",
  "  bye instance add <url> [--select] [--token t]   validate a compatible instance and save it",
  "  bye instance use <url>         make a saved instance the default",
  "  bye instance remove <url>      forget an instance and its credential on this machine",
  "  bye login --api <url> --token <token> [--mailbox id] [--calendar id]",
  "",
  "Target precedence: BYE_API (this invocation only), then the saved default, then hosted on first use.",
];

type Flags = Readonly<Record<string, string | boolean>>;
const str = (flags: Flags, k: string) =>
  typeof flags[k] === "string" ? (flags[k] as string) : undefined;

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
  await deps.write(
    withInstance(
      stored,
      url,
      {
        ...(token ? { token } : {}),
        ...(mailboxId ? { mailboxId } : {}),
        ...(calendarId ? { calendarId } : {}),
      },
      { select: true },
    ),
  );
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
  const out = (value: unknown, text: string) =>
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
        privateNetwork: deps.env.BYE_PRIVATE_NETWORK === "allow" ? "allow" : "block",
      });
      if (result._tag !== "Valid") {
        deps.stderr(
          result._tag === "Moved"
            ? `not added: ${url} points to ${result.location ?? "another address"}; validate that address separately`
            : result._tag === "Unreachable"
              ? `not added: ${url} is unreachable (${result.detail})`
              : `not added: ${PROBE_ERRORS[result.reason]}${result.detail ? ` (${result.detail})` : ""}`,
        );
        return result._tag === "Unreachable" ? EXIT.unavailable : EXIT.failure;
      }
      const previous = stored.instances[url];
      // A changed issuer means new authorization: the old credential is not carried over.
      const keep = previous?.issuer === undefined || previous.issuer === result.instance.issuer;
      const token = str(flags, "token");
      const next = withInstance(
        keep ? stored : withoutInstance(stored, url),
        url,
        { issuer: result.instance.issuer, ...(token ? { token } : {}) },
        { select: flags.select === true || stored.selected === null },
      );
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
      deps.stderr(`unknown instance command: ${sub}\n\n${INSTANCE_HELP.join("\n")}`);
      return EXIT.usage;
  }
};
