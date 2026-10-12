import { Effect, Layer, Match, Option, Result, type Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  BYE,
  buildSession,
  CORE,
  decodeState,
  dispatch,
  encodeState,
  evaluatePointer,
  expandTemplate,
  JmapBatch,
  MAIL,
  MAIL_METHODS,
  MAIL_REGISTRY,
  type MailReadQuery,
  type MailReadResult,
  MailStore,
  METHOD_REGISTRY,
  methodRegistry,
  parseEmailFilter,
  parseEmailSort,
  parseRequest,
  queryDigest,
  ref,
  resolveReferences,
  sameStateLineage,
  sendBatch,
} from "@bye/jmap";

// Protocol core (spec.md §16 D1 T01): request parsing, ordered dispatch, result references,
// method errors, state tokens and the implementation registry, against an in-memory read port.

const run = <A>(effect: Effect.Effect<A, never, MailStore>, reads: Array<MailReadQuery> = []) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(
        Layer.succeed(MailStore, {
          accounts: new Map([
            [
              "acc1",
              {
                accountId: "acc1",
                restoreGeneration: 0,
                visibilityGeneration: 0,
                isReadOnly: true,
              },
            ],
          ]),
          read: (_accountId, query) => {
            reads.push(query);

            return Effect.succeed(fake(query));
          },
        }),
      ),
    ),
  );

const state = { revision: "7" };

const fake = (query: MailReadQuery): MailReadResult =>
  Match.value(query).pipe(
    Match.tagsExhaustive({
      State: (): MailReadResult => ({ _tag: "State", state }),
      MailboxGet: (): MailReadResult => ({ _tag: "MailboxGet", state, list: [], notFound: [] }),
      EmailGet: (q): MailReadResult => ({
        _tag: "EmailGet",
        state,
        list: q.ids.flatMap((id) => (id === "missing" ? [] : [{ id, threadId: `t-${id}` }])),
        notFound: q.ids.filter((id) => id === "missing"),
      }),
      EmailQuery: (q): MailReadResult => ({
        _tag: "EmailQuery",
        state,
        ids: ["e1", "e2"],
        position: 0,
        total: q.calculateTotal ? 2 : null,
        anchorFound: true,
      }),
      ThreadGet: (q): MailReadResult => ({
        _tag: "ThreadGet",
        state,
        list: q.ids.map((id) => ({ id, emailIds: ["e1"] })),
        notFound: [],
      }),
      Changes: (q): MailReadResult =>
        q.base === state.revision
          ? { _tag: "Changes", state, created: [], updated: [], destroyed: [], nextCursor: null }
          : { _tag: "Refused", type: "cannotCalculateChanges", description: "" },
      ObjectGet: (): MailReadResult => ({ _tag: "ObjectGet", state, list: [], notFound: [] }),
      Snippets: (q): MailReadResult => ({
        _tag: "Snippets",
        list: q.ids.map((emailId) => ({ emailId, subject: null, preview: null })),
        notFound: [],
      }),
      SubmissionQuery: (): MailReadResult => ({
        _tag: "SubmissionQuery",
        state,
        ids: [],
        position: 0,
        total: null,
        anchorFound: true,
      }),
    }),
  );

const request = (
  methodCalls: ReadonlyArray<readonly [string, Schema.JsonObject, string]>,
  using: ReadonlyArray<string> = [CORE, MAIL],
) => {
  const parsed = parseRequest(JSON.stringify({ using, methodCalls }));

  if (Result.isFailure(parsed)) throw new Error(parsed.failure.detail);

  return parsed.success;
};

const responses = async (
  methodCalls: ReadonlyArray<readonly [string, Schema.JsonObject, string]>,
  using?: ReadonlyArray<string>,
) => {
  const out = await run(dispatch(MAIL_REGISTRY, request(methodCalls, using), "s0"));

  if (Result.isFailure(out)) throw new Error(out.failure.detail);

  return out.success.methodResponses;
};

describe("request parsing (RFC 8620 §3.6.1)", () => {
  it("separates notJSON, notRequest and limit problems", () => {
    const notJson = parseRequest("{");
    const notRequest = parseRequest(JSON.stringify({ using: [CORE] }));

    const tooMany = parseRequest(
      JSON.stringify({
        using: [CORE],
        methodCalls: Array.from({ length: 17 }, (_, i) => ["Core/echo", {}, `c${i}`]),
      }),
    );

    expect(Result.isFailure(notJson) && notJson.failure.type).toBe(
      "urn:ietf:params:jmap:error:notJSON",
    );
    expect(Result.isFailure(notRequest) && notRequest.failure.type).toBe(
      "urn:ietf:params:jmap:error:notRequest",
    );
    expect(Result.isFailure(tooMany) && tooMany.failure.limit).toBe("maxCallsInRequest");
  });

  it("rejects the whole request for an unknown capability", async () => {
    const out = await run(
      dispatch(MAIL_REGISTRY, request([["Core/echo", {}, "a"]], [CORE, "urn:x:nope"]), "s0"),
    );

    expect(Result.isFailure(out) && out.failure.type).toBe(
      "urn:ietf:params:jmap:error:unknownCapability",
    );
  });
});

describe("dispatch (RFC 8620 §3.3–3.7)", () => {
  it("echoes Core/echo and keeps call order and IDs", async () => {
    const out = await responses([
      ["Core/echo", { hello: true }, "a"],
      ["Core/echo", { n: 2 }, "b"],
    ]);

    expect(out).toEqual([
      ["Core/echo", { hello: true }, "a"],
      ["Core/echo", { n: 2 }, "b"],
    ]);
  });

  it("answers unknownMethod for unknown names and for methods outside `using`", async () => {
    const out = await responses(
      [
        ["Nope/get", {}, "a"],
        ["Mailbox/get", { accountId: "acc1" }, "b"],
      ],
      [CORE],
    );

    expect(out.map(([name, args]) => [name, args["type"]])).toEqual([
      ["error", "unknownMethod"],
      ["error", "unknownMethod"],
    ]);
  });

  it("a failed call never aborts the calls after it", async () => {
    const out = await responses([
      ["Email/get", { accountId: "nobody", ids: ["e1"] }, "a"],
      ["Email/get", { accountId: "acc1", ids: ["e1"], properties: ["threadId"] }, "b"],
    ]);

    expect(out[0]).toEqual(["error", { type: "accountNotFound" }, "a"]);
    expect(out[1]![0]).toBe("Email/get");
  });

  it("resolves result references, including `*` over arrays", async () => {
    const reads: Array<MailReadQuery> = [];

    const out = await run(
      dispatch(
        MAIL_REGISTRY,
        request([
          ["Email/query", { accountId: "acc1" }, "q"],
          [
            "Email/get",
            {
              accountId: "acc1",
              "#ids": { resultOf: "q", name: "Email/query", path: "/ids" },
              properties: ["threadId"],
            },
            "g",
          ],
          [
            "Thread/get",
            {
              accountId: "acc1",
              "#ids": { resultOf: "g", name: "Email/get", path: "/list/*/threadId" },
            },
            "t",
          ],
        ]),
        "s0",
      ),
      reads,
    );

    expect(Result.isSuccess(out)).toBe(true);
    expect(reads.at(-1)).toEqual({ _tag: "ThreadGet", ids: ["t-e1", "t-e2"] });
  });

  it("rejects bad references: wrong name, missing call, both forms present", async () => {
    const out = await responses([
      ["Email/query", { accountId: "acc1" }, "q"],
      [
        "Email/get",
        { accountId: "acc1", "#ids": { resultOf: "q", name: "Email/get", path: "/ids" } },
        "a",
      ],
      [
        "Email/get",
        { accountId: "acc1", "#ids": { resultOf: "zz", name: "Email/query", path: "/ids" } },
        "b",
      ],
      [
        "Email/get",
        {
          accountId: "acc1",
          ids: [],
          "#ids": { resultOf: "q", name: "Email/query", path: "/ids" },
        },
        "c",
      ],
      [
        "Email/get",
        { accountId: "acc1", "#ids": { resultOf: "q", name: "Email/query", path: "/nope" } },
        "d",
      ],
    ]);

    expect(out.slice(1).map(([, args]) => args["type"])).toEqual([
      "invalidResultReference",
      "invalidResultReference",
      "invalidArguments",
      "invalidResultReference",
    ]);
  });

  it("passes createdIds through when the request carried them", async () => {
    const parsed = parseRequest(
      JSON.stringify({ using: [CORE], methodCalls: [], createdIds: { k1: "id1" } }),
    );

    const out = await run(dispatch(MAIL_REGISTRY, Result.getOrThrow(parsed), "s0"));

    expect(Result.getOrThrow(out).createdIds).toEqual({ k1: "id1" });
  });

  it("turns a handler defect into serverFail for that call only", async () => {
    const registry = methodRegistry([
      { name: "Core/echo", capability: CORE, handler: () => Effect.die(new Error("boom")) },
    ]);

    const out = await Effect.runPromise(
      dispatch(registry, request([["Core/echo", {}, "a"]], [CORE]), "s0"),
    );

    expect(Result.getOrThrow(out).methodResponses).toEqual([
      ["error", { type: "serverFail" }, "a"],
    ]);
  });

  it("refuses writes on read-only accounts with accountReadOnly", async () => {
    const out = await responses([
      ["Email/set", { accountId: "acc1", update: {} }, "a"],
      ["Mailbox/set", { accountId: "acc1" }, "b"],
      ["Email/import", { accountId: "acc1", emails: {} }, "c"],
    ]);

    expect(out.map(([, args]) => args["type"])).toEqual([
      "accountReadOnly",
      "accountReadOnly",
      "accountReadOnly",
    ]);
  });

  it("validates properties: unknown and unserved properties are invalidArguments", async () => {
    const out = await responses([
      ["Email/get", { accountId: "acc1", ids: ["e1"], properties: ["nope"] }, "a"],
      ["Email/get", { accountId: "acc1", ids: ["e1"], properties: ["bodyValues"] }, "b"],
      ["Email/get", { accountId: "acc1", ids: null }, "c"],
    ]);

    expect(out.map(([, args]) => args["type"])).toEqual([
      "invalidArguments",
      "invalidArguments",
      "requestTooLarge",
    ]);
  });
});

describe("changes and state (spec.md §16 C1)", () => {
  it("same-revision tokens have no changes; others cannot be calculated", async () => {
    const [[, got]] = (await responses([["Mailbox/get", { accountId: "acc1" }, "a"]])) as [
      readonly [string, Schema.JsonObject, string],
    ];

    const current = got["state"] as string;

    const out = await responses([
      ["Mailbox/changes", { accountId: "acc1", sinceState: current }, "a"],
      ["Email/changes", { accountId: "acc1", sinceState: current }, "b"],
      ["Mailbox/changes", { accountId: "acc1", sinceState: "garbage" }, "c"],
      ["Email/queryChanges", { accountId: "acc1", sinceQueryState: "x" }, "d"],
      ["Mailbox/changes", { accountId: "acc1", sinceState: current, maxChanges: 0 }, "e"],
    ]);

    expect(out[0]![1]).toMatchObject({
      oldState: current,
      newState: current,
      hasMoreChanges: false,
      created: [],
      updatedProperties: null,
    });
    // A Mailbox token is not an Email token, even at the same revision.
    expect(out.slice(1).map(([, args]) => args["type"])).toEqual([
      "cannotCalculateChanges",
      "cannotCalculateChanges",
      "cannotCalculateChanges",
      "invalidArguments",
    ]);
  });

  it("tokens round-trip without precision loss and bind every lineage field", () => {
    const domain = {
      accountId: "a",
      type: "Email",
      restoreGeneration: 1,
      visibilityGeneration: 2,
      writerEpoch: 3,
      revision: 2n ** 60n + 1n,
    };

    const decoded = Option.getOrThrow(decodeState(encodeState(domain)));

    expect(decoded).toEqual(domain);
    expect(sameStateLineage(decoded, { ...domain, restoreGeneration: 2 })).toBe(false);
    expect(sameStateLineage(decoded, { ...domain, visibilityGeneration: 3 })).toBe(false);
    expect(sameStateLineage(decoded, { ...domain, writerEpoch: 4 })).toBe(false);

    const page = Option.getOrThrow(
      decodeState(encodeState({ ...domain, page: { base: 7n, cursor: "m1" } })),
    );

    expect(page.page).toEqual({ base: 7n, cursor: "m1" });
    expect(Option.isNone(decodeState("!!"))).toBe(true);
    expect(queryDigest({ b: 1, a: [1, { y: 2, x: 1 }] })).toBe(
      queryDigest({ a: [1, { x: 1, y: 2 }], b: 1 }),
    );
  });
});

describe("filters and sorts (RFC 8621 §4.4)", () => {
  it("parses nested operators and the supported conditions", () => {
    const parsed = parseEmailFilter({
      operator: "AND",
      conditions: [
        { inMailbox: "inbox" },
        { operator: "NOT", conditions: [{ hasKeyword: "$Seen" }] },
        { after: "2026-01-01T00:00:00Z" },
      ],
    });

    expect(Result.getOrThrow(parsed)).toEqual({
      _tag: "Operator",
      operator: "AND",
      conditions: [
        { _tag: "Condition", condition: { inMailbox: "inbox" } },
        {
          _tag: "Operator",
          operator: "NOT",
          conditions: [{ _tag: "Condition", condition: { hasKeyword: "$seen" } }],
        },
        { _tag: "Condition", condition: { after: Date.UTC(2026, 0, 1) } },
      ],
    });
  });

  it("names unsupported conditions and sorts instead of ignoring them", () => {
    const filters: ReadonlyArray<Schema.JsonObject> = [
      { text: 5 },
      { header: [] },
      { bogus: 1 },
      { after: "yesterday" },
      { hasKeyword: "bad keyword" },
    ];

    for (const filter of filters)
      expect(Result.isFailure(parseEmailFilter(filter)) && parseEmailFilter(filter)).toMatchObject({
        failure: { type: "unsupportedFilter" },
      });
    expect(Result.isFailure(parseEmailSort([{ property: "nope" }]))).toBe(true);
    expect(Result.isFailure(parseEmailSort([{ property: "hasKeyword" }]))).toBe(true);
    expect(
      Result.getOrThrow(parseEmailSort([{ property: "hasKeyword", keyword: "$Flagged" }])),
    ).toEqual([{ property: "hasKeyword", isAscending: true, keyword: "$flagged" }]);
    expect(Result.getOrThrow(parseEmailSort(null))).toEqual([
      { property: "receivedAt", isAscending: false },
    ]);
  });
});

describe("pointers and references", () => {
  it("evaluates RFC 6901 pointers with escapes and `*`", () => {
    const doc = { "a/b": { "~k": [1, 2] }, list: [{ ids: ["x", "y"] }, { ids: ["z"] }] };

    expect(Option.getOrThrow(evaluatePointer(doc, "/a~1b/~0k/1"))).toBe(2);
    expect(Option.getOrThrow(evaluatePointer(doc, "/list/*/ids"))).toEqual(["x", "y", "z"]);
    expect(Option.isNone(evaluatePointer(doc, "/list/9"))).toBe(true);
    expect(Option.isNone(evaluatePointer(doc, "list"))).toBe(true);
  });

  it("leaves plain arguments untouched", () => {
    expect(Result.getOrThrow(resolveReferences({ a: 1 }, []))).toEqual({ a: 1 });
  });
});

describe("registry and session (spec.md §16 D1)", () => {
  it("every dispatched method is registered with its capability, and host methods stay out of accounts", () => {
    const served = new Map(MAIL_METHODS.map((m) => [m.name, m.capability]));
    const registered = new Map(METHOD_REGISTRY.map((e) => [e.method, e]));

    for (const [name, capability] of served) {
      expect(registered.get(name)?.capability, name).toBe(capability);

      if (name !== "Core/echo") expect(registered.get(name)?.status, name).not.toBe("host");
    }

    for (const [name, entry] of registered)
      if (entry.status !== "host" || name === "Core/echo")
        expect(served.has(name), `${name} is ${entry.status}`).toBe(true);
      else expect(served.has(name), `${name} is host-level`).toBe(false);
  });

  it("labels the profile partial and lists only the principal's accounts", () => {
    const session = buildSession({
      username: "ana@bye.test",
      apiUrl: "https://app/jmap/api",
      downloadUrl: "https://app/jmap/download/{accountId}/{blobId}/{name}?type={type}",
      uploadUrl: "https://app/jmap/upload/{accountId}",
      eventSourceUrl: "https://app/jmap/eventsource?types={types}",
      accounts: [{ accountId: "mbx_1", name: "ana@bye.test", isPersonal: true, isReadOnly: true }],
      primaryAccountId: "mbx_1",
    });

    expect(session.capabilities[BYE]).toEqual({ version: 1, partial: true });
    expect((session.accounts["mbx_1"] as Schema.JsonObject)["accountCapabilities"]).toMatchObject({
      [BYE]: { profile: "read-only-partial", partial: true },
    });

    const core = buildSession({
      username: "ana@bye.test",
      apiUrl: "https://app/jmap/api",
      downloadUrl: "d",
      uploadUrl: "u",
      eventSourceUrl: "e",
      accounts: [
        { accountId: "mbx_1", name: "a", isPersonal: true, isReadOnly: false, profile: "core" },
      ],
      primaryAccountId: "mbx_1",
    });

    expect(core.capabilities[BYE]).toEqual({ version: 1, partial: false });
    expect(Object.keys(core.primaryAccounts)).toEqual(
      expect.arrayContaining([MAIL, "urn:ietf:params:jmap:submission", BYE]),
    );
    expect(Object.keys(session.accounts)).toEqual(["mbx_1"]);
    expect(session.primaryAccounts[MAIL]).toBe("mbx_1");
    expect(
      expandTemplate(session.downloadUrl, {
        accountId: "mbx_1",
        blobId: "raw-x",
        name: "a b.eml",
        type: "message/rfc822",
      }),
    ).toBe("https://app/jmap/download/mbx_1/raw-x/a%20b.eml?type=message%2Frfc822");
  });
});

describe("typed client", () => {
  it("posts one ordered batch and decodes the response", async () => {
    const batch = new JmapBatch();
    const q = batch.call("Email/query", { accountId: "acc1" });
    batch.call("Email/get", { accountId: "acc1", "#ids": { ...ref(q, "Email/query", "/ids") } });
    let sent: Schema.Json = null;

    const response = await Effect.runPromise(
      sendBatch(
        {
          apiUrl: "https://app/jmap/api",
          using: [MAIL],
          fetch: async (req) => {
            sent = (await req.json()) as Schema.Json;

            return new Response(JSON.stringify({ methodResponses: [], sessionState: "s" }));
          },
        },
        batch,
      ),
    );

    expect(response.sessionState).toBe("s");
    expect(sent).toMatchObject({
      using: [CORE, MAIL],
      methodCalls: [
        ["Email/query", { accountId: "acc1" }, "c0"],
        ["Email/get", { "#ids": { resultOf: "c0", path: "/ids" } }, "c1"],
      ],
    });

    const failed = await Effect.runPromiseExit(
      sendBatch(
        {
          apiUrl: "https://app/jmap/api",
          using: [MAIL],
          fetch: async () =>
            new Response(JSON.stringify({ type: "urn:x", detail: "no" }), { status: 400 }),
        },
        new JmapBatch(),
      ),
    );

    expect(failed._tag).toBe("Failure");
  });
});
