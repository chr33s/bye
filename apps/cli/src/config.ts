import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { HOSTED_INSTANCE_URL, normalizeInstanceUrl } from "@bye/native-shared/instance";
import type { CliConfig } from "./client.ts";

// CLI configuration (spec §10 CLI). Scoped credentials are stored owner-readable only,
// one entry per normalized instance URL, and are only ever sent to that exact instance.
//
// Effective target precedence:
//   1. BYE_API            invocation-scoped; never rewrites the saved default and uses only
//                         credentials saved for exactly that instance (or BYE_TOKEN)
//   2. saved selection    `bye instance use <url>` or `bye login --api <url>`
//   3. hosted             on first use only (nothing saved)
// An override that fails never falls back to another target.
//
// Addresses must be https. Private-network https targets need BYE_PRIVATE_NETWORK=allow; plain
// http is accepted only for loopback development servers with BYE_INSECURE_LOOPBACK=1.

export type TargetSource = "BYE_API" | "saved" | "hosted";

export interface SavedInstance {
  readonly token?: string | undefined;
  /** Validated issuer, when the instance was added with `bye instance add`. */
  readonly issuer?: string | undefined;
  readonly mailboxId?: string | undefined;
  readonly calendarId?: string | undefined;
}

export interface StoredConfig {
  readonly version: 2;
  readonly selected: string | null;
  readonly instances: Readonly<Record<string, SavedInstance>>;
}

export const EMPTY_CONFIG: StoredConfig = { version: 2, selected: null, instances: {} };

export type TargetEnv = Readonly<Record<string, string | undefined>>;

export class TargetError extends Error {
  override readonly name = "TargetError";
}

const LOOPBACK_HTTP = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?(\/[^?#]*)?$/i;

/** One normalization for every CLI address (the same parser the apps use). */
export const normalizeTarget = (raw: string, env: TargetEnv = {}): string => {
  const input = raw.trim();
  if (env.BYE_INSECURE_LOOPBACK === "1" && LOOPBACK_HTTP.test(input))
    return input.replace(/\/+$/, "").toLowerCase();
  const n = normalizeInstanceUrl(input, {
    privateNetwork: env.BYE_PRIVATE_NETWORK === "allow" ? "allow" : "block",
  });
  if (!n.ok)
    throw new TargetError(`invalid instance address ${JSON.stringify(input)}: ${n.reason}`);
  return n.url;
};

/** v1 files held one `apiUrl` and its token; they become that instance's entry and selection. */
export const migrateConfig = (raw: unknown, env: TargetEnv = {}): StoredConfig => {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  if (o.version === 2 && o.instances && typeof o.instances === "object") {
    return {
      version: 2,
      selected: typeof o.selected === "string" ? o.selected : null,
      instances: o.instances as Record<string, SavedInstance>,
    };
  }
  if (typeof o.apiUrl === "string") {
    let url: string;
    try {
      url = normalizeTarget(o.apiUrl, env);
    } catch {
      return EMPTY_CONFIG; // an unusable old address is dropped with its token, never re-targeted
    }
    const entry: SavedInstance = {
      ...(typeof o.token === "string" ? { token: o.token } : {}),
      ...(typeof o.mailboxId === "string" ? { mailboxId: o.mailboxId } : {}),
      ...(typeof o.calendarId === "string" ? { calendarId: o.calendarId } : {}),
    };
    return { version: 2, selected: url, instances: { [url]: entry } };
  }
  return EMPTY_CONFIG;
};

/** Resolve the effective target and the only credentials allowed for it. */
export const resolveTarget = (stored: StoredConfig, env: TargetEnv): CliConfig => {
  let apiUrl: string;
  let source: TargetSource;
  if (env.BYE_API !== undefined && env.BYE_API !== "") {
    apiUrl = normalizeTarget(env.BYE_API, env);
    source = "BYE_API";
  } else if (stored.selected && stored.instances[stored.selected]) {
    apiUrl = stored.selected;
    source = "saved";
  } else {
    apiUrl = HOSTED_INSTANCE_URL;
    source = "hosted";
  }
  const saved = stored.instances[apiUrl];
  return {
    apiUrl,
    source,
    token: env.BYE_TOKEN || saved?.token,
    mailboxId: env.BYE_MAILBOX || saved?.mailboxId,
    calendarId: env.BYE_CALENDAR || saved?.calendarId,
  };
};

export const configPath = (): string =>
  process.env.BYE_CONFIG ??
  join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "bye", "config.json");

export const readStored = async (): Promise<StoredConfig> => {
  try {
    return migrateConfig(JSON.parse(await readFile(configPath(), "utf8")), process.env);
  } catch {
    return EMPTY_CONFIG;
  }
};

export const loadConfig = async (): Promise<CliConfig> =>
  resolveTarget(await readStored(), process.env);

export const writeStored = async (config: StoredConfig): Promise<void> => {
  const path = configPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
};

/** Merge an instance entry (credentials stay bound to exactly `url`). */
export const withInstance = (
  stored: StoredConfig,
  url: string,
  entry: SavedInstance,
  options: { select?: boolean } = {},
): StoredConfig => ({
  version: 2,
  selected: options.select ? url : stored.selected,
  instances: { ...stored.instances, [url]: { ...stored.instances[url], ...entry } },
});

export const withoutInstance = (stored: StoredConfig, url: string): StoredConfig => {
  const { [url]: _removed, ...rest } = stored.instances;
  return {
    version: 2,
    selected: stored.selected === url ? null : stored.selected,
    instances: rest,
  };
};
