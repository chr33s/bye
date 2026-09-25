import type { KeyValueStore } from "../drafts.ts";
import { sameCredentialDestinations, type ValidatedInstance } from "./discovery.ts";

// Saved instances and the selected one (spec §10 Instance selection). Only
// validated, non-secret configuration lives here; credentials are in OS secure storage, keyed by the
// instance key. Records are keyed by normalized base URL + validated issuer; display names and
// account emails never identify an instance.

export const HOSTED_INSTANCE_URL = "https://app.bye.email";
const REGISTRY_KEY = "bye:instances";

interface RegistryState {
  readonly v: 1;
  readonly instances: ReadonlyArray<ValidatedInstance>;
  readonly selected: string | null;
}

export class InstanceConflictError extends Error {
  override readonly name = "InstanceConflictError";
  constructor(readonly existingKey: string) {
    super("another saved server already uses this issuer with different sign-in endpoints");
  }
}

export interface SaveResult {
  /** Instance keys whose credentials and account state must be discarded (destination changed). */
  readonly invalidated: ReadonlyArray<string>;
}

export class InstanceRegistry {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly kv: KeyValueStore) {}

  /** Registry writes are serialized so concurrent saves can't drop each other's records. */
  private serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async read(): Promise<RegistryState> {
    try {
      const s = JSON.parse((await this.kv.getItem(REGISTRY_KEY)) ?? "null") as RegistryState | null;
      if (s && s.v === 1 && Array.isArray(s.instances)) return s;
    } catch {
      // unreadable configuration: start empty rather than guess
    }
    return { v: 1, instances: [], selected: null };
  }

  private write(state: RegistryState): Promise<void> {
    return this.kv.setItem(REGISTRY_KEY, JSON.stringify(state));
  }

  async list(): Promise<ReadonlyArray<ValidatedInstance>> {
    return (await this.read()).instances;
  }

  async get(key: string): Promise<ValidatedInstance | null> {
    return (await this.read()).instances.find((i) => i.key === key) ?? null;
  }

  /** The selected instance; never substitutes another one (no fallback to hosted). */
  async selected(): Promise<ValidatedInstance | null> {
    const s = await this.read();
    return s.instances.find((i) => i.key === s.selected) ?? null;
  }

  /**
   * Save a freshly validated instance (after the user confirmed it). A changed issuer or credential
   * endpoint for the same base URL replaces the record and reports the old key as invalidated;
   * a different base URL claiming a saved issuer with other endpoints is refused.
   */
  save(instance: ValidatedInstance, options: { select?: boolean } = {}): Promise<SaveResult> {
    return this.serial(async () => {
      const s = await this.read();
      const invalidated: Array<string> = [];
      for (const other of s.instances) {
        if (other.baseUrl === instance.baseUrl) {
          if (other.key !== instance.key || !sameCredentialDestinations(other, instance))
            invalidated.push(other.key);
        } else if (other.issuer === instance.issuer) {
          const { baseUrl: _a, key: _b, ...rest } = other;
          if (
            !sameCredentialDestinations(
              { ...rest, baseUrl: instance.baseUrl, key: instance.key },
              instance,
            )
          )
            throw new InstanceConflictError(other.key);
        }
      }
      const instances = [...s.instances.filter((i) => i.baseUrl !== instance.baseUrl), instance];
      const selected =
        options.select || (s.selected !== null && invalidated.includes(s.selected))
          ? instance.key
          : s.selected;
      await this.write({ v: 1, instances, selected });
      return { invalidated };
    });
  }

  select(key: string): Promise<void> {
    return this.serial(async () => {
      const s = await this.read();
      if (!s.instances.some((i) => i.key === key)) throw new Error("unknown instance");
      await this.write({ ...s, selected: key });
    });
  }

  /** Forget the configuration only; the caller clears credentials and account state. */
  remove(key: string): Promise<void> {
    return this.serial(async () => {
      const s = await this.read();
      await this.write({
        v: 1,
        instances: s.instances.filter((i) => i.key !== key),
        selected: s.selected === key ? null : s.selected,
      });
    });
  }
}

// ---- per-instance / per-account local state ----

/** Scope for one account on one instance: server account IDs are only unique per instance. */
export const accountScope = (instanceKey: string, userId: string): string =>
  `${instanceKey}#${userId}`;

export interface ScopedKeyValueStore extends KeyValueStore {
  readonly scope: string;
  /** Remove every key written through this scope. */
  clear(): Promise<void>;
}

interface WriteState {
  queue: Promise<void>;
  generation: number;
}

// Handles for the same account share one queue, including handles created only to clear it.
const scopeWrites = new WeakMap<KeyValueStore, Map<string, WriteState>>();
const instanceWrites = new WeakMap<KeyValueStore, Map<string, WriteState>>();

const writesFor = (
  states: WeakMap<KeyValueStore, Map<string, WriteState>>,
  kv: KeyValueStore,
  key: string,
): WriteState => {
  let entries = states.get(kv);
  if (!entries) {
    entries = new Map();
    states.set(kv, entries);
  }
  let state = entries.get(key);
  if (!state) {
    state = { queue: Promise.resolve(), generation: 0 };
    entries.set(key, state);
  }
  return state;
};

const serialWrite = <T>(state: WriteState, run: () => Promise<T>): Promise<T> => {
  const next = state.queue.then(run, run);
  state.queue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
};

/**
 * Namespace a key-value store (drafts, UI state, caches) to one scope. Keys are tracked so sign-out
 * and removal can clear exactly this scope's data, and nothing from another instance/account.
 */
export const scopedStore = (
  kv: KeyValueStore,
  scope: string,
  instanceKey?: string,
): ScopedKeyValueStore => {
  const prefix = `bye:scope:${scope}::`;
  const index = `${prefix}__keys`;
  const state = writesFor(scopeWrites, kv, scope);
  const instanceState = instanceKey ? writesFor(instanceWrites, kv, instanceKey) : null;
  const generation = state.generation;
  const instanceGeneration = instanceState?.generation;
  const current = () =>
    generation === state.generation && instanceGeneration === instanceState?.generation;
  const keys = async (): Promise<Array<string>> => {
    try {
      return JSON.parse((await kv.getItem(index)) ?? "[]") as Array<string>;
    } catch {
      return [];
    }
  };
  return {
    scope,
    getItem: async (key) => {
      if (instanceState) await instanceState.queue;
      return serialWrite(state, async () => (current() ? kv.getItem(prefix + key) : null));
    },
    setItem: async (key, value) => {
      if (!current()) return;
      if (instanceKey) await rememberScope(kv, instanceKey, scope, instanceGeneration);
      await serialWrite(state, async () => {
        if (!current()) return;
        const known = await keys();
        if (!known.includes(key)) await kv.setItem(index, JSON.stringify([...known, key]));
        await kv.setItem(prefix + key, value);
      });
    },
    removeItem: (key) =>
      serialWrite(state, async () => {
        if (current()) await kv.removeItem(prefix + key);
      }),
    clear: () => {
      if (!current()) return Promise.resolve();
      state.generation++;
      return serialWrite(state, async () => {
        for (const key of await keys()) await kv.removeItem(prefix + key);
        await kv.removeItem(index);
      });
    },
  };
};

/** Clear every scope that belongs to an instance (all its accounts), given the scopes in use. */
export const INSTANCE_SCOPES_KEY = (instanceKey: string) => `bye:instance-scopes:${instanceKey}`;

export const rememberScope = (
  kv: KeyValueStore,
  instanceKey: string,
  scope: string,
  generation = writesFor(instanceWrites, kv, instanceKey).generation,
): Promise<void> => {
  const state = writesFor(instanceWrites, kv, instanceKey);
  return serialWrite(state, async () => {
    if (generation !== state.generation) return;
    const key = INSTANCE_SCOPES_KEY(instanceKey);
    const known = JSON.parse((await kv.getItem(key)) ?? "[]") as Array<string>;
    if (!known.includes(scope)) await kv.setItem(key, JSON.stringify([...known, scope]));
  });
};

export const clearInstanceState = (kv: KeyValueStore, instanceKey: string): Promise<void> => {
  const state = writesFor(instanceWrites, kv, instanceKey);
  state.generation++;
  return serialWrite(state, async () => {
    const key = INSTANCE_SCOPES_KEY(instanceKey);
    let known: Array<string> = [];
    try {
      known = JSON.parse((await kv.getItem(key)) ?? "[]") as Array<string>;
    } catch {
      known = [];
    }
    for (const scope of known) await scopedStore(kv, scope).clear();
    await kv.removeItem(key);
  });
};
