import { Predicate } from "effect";
import { describe, expect, it } from "vitest";
import {
  BYE_CAPABILITY,
  cacheKey,
  intentCall,
  isUpgradeRequired,
  JmapClient,
  JmapRequestError,
  memoryCacheStore,
  rebaseIntents,
  translateLegacyCommand,
} from "../src/jmap.ts";
import type { FetchLike } from "../src/client.ts";
import type { JsonObject } from "../src/json.ts";

// First-party JMAP client state (spec.md §16 C4): versioned caches, paged /changes, baseline
// reset on cannotCalculateChanges or cutover, and the offline-intent rebase rules.

const account = (profile: "core" | "projection") => ({
  name: "ana@bye.test",
  isPersonal: true,
  isReadOnly: profile !== "core",
  accountCapabilities: { [BYE_CAPABILITY]: { profile } },
});

/** A scripted server: a session plus a handler per method. */
const server = (
  profile: "core" | "projection",
  handlers: { [method: string]: (args: JsonObject) => JsonObject | null },
) => {
  const calls: Array<string> = [];

  const fetch: FetchLike = async (url, init) => {
    if (url.endsWith("/.well-known/jmap"))
      return {
        status: 200,
        text: async () =>
          JSON.stringify({
            apiUrl: "https://app.test/jmap/api",
            downloadUrl: "",
            uploadUrl: "",
            eventSourceUrl: "",
            state: "s1",
            username: "ana@bye.test",
            capabilities: { "urn:ietf:params:jmap:core": {}, "urn:ietf:params:jmap:mail": {} },
            accounts: { acc: account(profile) },
            primaryAccounts: {},
          }),
      };

    const body = JSON.parse(Predicate.isString(init.body) ? init.body : "{}") as {
      methodCalls: Array<[string, JsonObject, string]>;
    };

    const methodResponses = body.methodCalls.map(([name, args, id]) => {
      calls.push(name);
      const out = handlers[name]?.(args);

      return out === null || out === undefined
        ? ["error", { type: "cannotCalculateChanges" }, id]
        : [name, out, id];
    });

    return {
      status: 200,
      text: async () => JSON.stringify({ methodResponses, sessionState: "s1" }),
    };
  };

  return { fetch, calls };
};

describe("JmapClient.sync", () => {
  it("downloads a baseline, then pages /changes until hasMoreChanges is false", async () => {
    const store = memoryCacheStore();
    let page = 0;

    const s = server("core", {
      "Email/query": () => ({ ids: ["e1", "e2"] }),
      "Email/get": () => ({ state: "st0", list: [] }),
      "Email/changes": (args) => {
        page++;

        return args["sinceState"] === "st0"
          ? {
              newState: "st0.5",
              hasMoreChanges: true,
              created: ["e3"],
              updated: [],
              destroyed: ["e1"],
            }
          : { newState: "st1", hasMoreChanges: false, created: [], updated: ["e2"], destroyed: [] };
      },
    });

    const client = new JmapClient({
      origin: "https://app.test",
      fetch: s.fetch,
      headers: () => ({}),
      store,
    });

    const first = await client.sync("acc", "Email");
    expect(first).toMatchObject({ reset: true, created: ["e1", "e2"], state: "st0" });

    const second = await client.sync("acc", "Email");
    expect(second).toEqual({
      state: "st1",
      created: ["e3"],
      updated: ["e2"],
      destroyed: ["e1"],
      reset: false,
    });
    expect(page).toBe(2);
    expect(JSON.parse((await store.get(cacheKey("acc", account("core"), "Email")))!)).toEqual({
      state: "st1",
      ids: ["e2", "e3"],
    });
  });

  it("baselines with the first page's state, restarting when the query moves while paging", async () => {
    const all = Array.from({ length: 1_200 }, (_, i) => `e${i}`);
    let queries = 0;
    let gets = 0;

    const s = server("core", {
      "Email/query": (args) => {
        queries++;
        const position = Number(args["position"]);

        // The first pass sees the list change after its first page; later passes are stable.
        return {
          ids: all.slice(position, position + 500),
          queryState: queries === 2 ? "q-moved" : "q1",
        };
      },
      "Email/get": () => ({ state: `st${++gets}`, list: [] }),
    });

    const client = new JmapClient({
      origin: "https://app.test",
      fetch: s.fetch,
      headers: () => ({}),
      store: memoryCacheStore(),
    });

    const r = await client.sync("acc", "Email");

    // Restarted once: the state is the restart's first page (the 4th Email/get), not its last.
    expect(r.state).toBe("st4");
    expect(r.created).toHaveLength(1_200);
    expect(queries).toBe(6);
  });

  it("resets to a baseline when the server can't calculate changes", async () => {
    const store = memoryCacheStore();
    await store.set(
      cacheKey("acc", account("core"), "Mailbox"),
      JSON.stringify({ state: "gone", ids: ["old"] }),
    );

    const s = server("core", {
      "Mailbox/changes": () => null,
      "Mailbox/get": () => ({ state: "m2", list: [{ id: "inbox" }, { id: "trash" }] }),
    });

    const client = new JmapClient({
      origin: "https://app.test",
      fetch: s.fetch,
      headers: () => ({}),
      store,
    });

    expect(await client.sync("acc", "Mailbox")).toMatchObject({
      reset: true,
      created: ["inbox", "trash"],
      state: "m2",
    });
  });

  it("never reads a projection cache against the core model (cache key includes the profile)", () => {
    expect(cacheKey("acc", account("core"), "Email")).not.toBe(
      cacheKey("acc", account("projection"), "Email"),
    );
  });

  it("surfaces problem documents as JmapRequestError", async () => {
    const fetch: FetchLike = async () => ({
      status: 400,
      text: async () =>
        JSON.stringify({ type: "urn:ietf:params:jmap:error:notRequest", detail: "bad" }),
    });

    const client = new JmapClient({
      origin: "https://app.test",
      fetch,
      headers: () => ({}),
      store: memoryCacheStore(),
    });

    await expect(client.sessionResource()).rejects.toBeInstanceOf(JmapRequestError);
  });
});

describe("offline intents (C4)", () => {
  const intent = {
    intentId: "i1",
    accountId: "acc",
    emails: { e1: 3, e2: null },
    action: { type: "archive" },
  };

  it("replays only intents whose exact Email set still exists", () => {
    expect(rebaseIntents([intent], new Set(["e1", "e2"]))).toEqual([{ kind: "replay", intent }]);
    expect(rebaseIntents([intent], new Set(["e1"]))[0]).toMatchObject({
      kind: "review",
      reason: expect.stringContaining("e2"),
    });
    expect(intentCall(intent, "c")).toEqual([
      "EmailAction/apply",
      {
        accountId: "acc",
        emails: { e1: 3, e2: null },
        action: { type: "archive" },
        intentId: "i1",
      },
      "c",
    ]);
  });

  it("translates legacy commands only with a recorded Email set, never re-expanding threads", () => {
    expect(
      translateLegacyCommand({
        commandId: "cmd1",
        mailboxId: "acc",
        command: { _tag: "MoveToTrash", threadIds: ["t1"] },
        snapshot: { t1: ["d1", "d2"] },
      }),
    ).toEqual({
      intent: {
        intentId: "cmd1",
        accountId: "acc",
        emails: { d1: null, d2: null },
        action: { type: "trash" },
      },
    });
    expect(
      translateLegacyCommand({
        commandId: "c",
        mailboxId: "acc",
        command: { _tag: "MoveToTrash", threadIds: ["t1"] },
      }),
    ).toHaveProperty("review");
    expect(
      translateLegacyCommand({
        commandId: "c",
        mailboxId: "acc",
        command: { _tag: "MergeThreads" },
      }),
    ).toHaveProperty("review");
  });

  it("recognizes the upgrade-required refusal", () => {
    expect(
      isUpgradeRequired({ error: { code: "conflict", details: { upgradeRequired: true } } }),
    ).toBe(true);
    expect(isUpgradeRequired({ error: { code: "conflict" } })).toBe(false);
    expect(isUpgradeRequired(null)).toBe(false);
  });
});
