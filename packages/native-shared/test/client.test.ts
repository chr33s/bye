import { describe, expect, expectTypeOf, it } from "vitest";
import type { MailViewName } from "@bye/contracts";
import { ByeApiError, ByeClient, type FetchLike, weekStart } from "../src/client.ts";
import { DraftStore, type KeyValueStore, syncDraft } from "../src/drafts.ts";
import { MAIL_VIEW_NAV, MAIL_VIEWS, type MailView } from "../src/views.ts";

// The one client for web (cookie), native (device-session bearer) and the CLI (static bearer).

describe("shared client", () => {
  it("[X01] navigable mail views are a subset of the MailViewName contract, labelled once", () => {
    expectTypeOf<MailView>().toExtend<MailViewName>();
    expect(MAIL_VIEW_NAV.every((n) => (MAIL_VIEWS as ReadonlyArray<string>).includes(n.view))).toBe(
      true,
    );
    expect(new Set(MAIL_VIEW_NAV.map((n) => n.key).filter(Boolean)).size).toBe(
      MAIL_VIEW_NAV.filter((n) => n.key).length,
    );
  });

  const harness = (
    respond: (url: string, init: Parameters<FetchLike>[1]) => { status: number; body: unknown },
  ) => {
    const calls: Array<{ url: string; init: Parameters<FetchLike>[1] }> = [];
    let n = 0;

    const client = (token?: string) =>
      new ByeClient({
        origin: "https://app.bye.test",
        token,
        newId: () => `cmd_${++n}`,
        fetch: async (url, init) => {
          calls.push({ url, init });
          const { status, body } = respond(url, init);

          return { status, text: async () => JSON.stringify(body) };
        },
      });

    return { calls, client };
  };

  it("[X01] native clients never use the cookie jar; bearer sessions send the token", async () => {
    const h = harness(() => ({ status: 200, body: {} }));
    await h.client().markSeen("mbx_1", "thr_1", 3);
    expect(h.calls[0]!.init.headers.origin).toBe("https://app.bye.test");
    expect(h.calls[0]!.init.credentials).toBe("omit");
    expect(JSON.parse(h.calls[0]!.init.body as string)).toEqual({
      _tag: "MarkSeen",
      commandId: "cmd_1",
      threadId: "thr_1",
      observedRevision: 3,
    });
    await h.client("tok").view("mbx_1", "imbox");
    expect(h.calls[1]!.init.headers.authorization).toBe("Bearer tok");
    expect(h.calls[1]!.init.credentials).toBe("omit");
    expect(
      () =>
        new ByeClient({
          origin: "http://evil.example",
          fetch: async () => ({ status: 200, text: async () => "" }),
        }),
    ).toThrow();
  });

  it("[X01] web sessions use the same-origin cookie: no bearer, no manual Origin", async () => {
    const calls: Array<Parameters<FetchLike>[1] & { url: string }> = [];

    const web = new ByeClient({
      origin: "https://app.bye.test",
      cookie: true,
      fetch: async (url, init) => (
        calls.push({ url, ...init }),
        { status: 200, text: async () => "{}" }
      ),
    });

    await web.request("POST", "/v1/drafts", { a: 1 });
    expect(calls[0]).toMatchObject({
      url: "https://app.bye.test/v1/drafts",
      credentials: "same-origin",
    });
    expect(calls[0]!.headers.authorization).toBeUndefined();
    expect(calls[0]!.headers.origin).toBeUndefined();
  });

  it("[X02] raw bodies, query strings and API path prefixes", async () => {
    const calls: Array<{ url: string; init: Parameters<FetchLike>[1] }> = [];

    const cli = new ByeClient({
      origin: "http://localhost:8787/api/",
      token: "t",
      headers: { "user-agent": "bye-cli/test" },
      fetch: async (url, init) => (
        calls.push({ url, init }),
        { status: 200, headers: { get: () => "text/vcard" }, text: async () => "BEGIN:VCARD" }
      ),
    });

    expect(
      await cli.raw("PUT", "/v1/uploads/u/parts/1", new Uint8Array(3), "application/octet-stream", {
        query: { mailbox: "mbx_1", skip: undefined },
      }),
    ).toBe("BEGIN:VCARD");
    expect(calls[0]!.url).toBe("http://localhost:8787/api/v1/uploads/u/parts/1?mailbox=mbx_1");
    expect(calls[0]!.init.headers).toMatchObject({
      "content-length": "3",
      "content-type": "application/octet-stream",
      "user-agent": "bye-cli/test",
      authorization: "Bearer t",
    });
    expect(
      () =>
        new ByeClient({
          origin: "http://api.example",
          fetch: async () => ({ status: 200, text: async () => "" }),
        }),
    ).toThrow();
  });

  it("[X01] API errors surface the stable error envelope, details included", async () => {
    const stepUp = new ByeClient({
      origin: "https://app.bye.test",
      cookie: true,
      fetch: async () => ({
        status: 403,
        text: async () =>
          JSON.stringify({
            error: { code: "forbidden", message: "step up", details: { stepUp: true } },
          }),
      }),
    });

    await expect(stepUp.request("POST", "/v1/identities", {})).rejects.toMatchObject({
      status: 403,
      code: "forbidden",
      details: { stepUp: true },
    });

    const h = harness(() => ({
      status: 409,
      body: { error: { code: "too_late", message: "already submitted" } },
    }));

    await expect(h.client().cancelSend("mbx_1", "snd_1")).rejects.toMatchObject(
      new ByeApiError(409, "too_late", "already submitted"),
    );
  });

  it("[X01] offline drafts sync with revisions and keep both copies on conflict", async () => {
    const mem = new Map<string, string>();

    const kv: KeyValueStore = {
      getItem: async (k) => mem.get(k) ?? null,
      setItem: async (k, v) => void mem.set(k, v),
      removeItem: async (k) => void mem.delete(k),
    };

    const store = new DraftStore(kv);

    const content = {
      to: [{ address: "a@example.net" }],
      cc: [],
      bcc: [],
      subject: "Hi",
      text: "long offline text",
      attachments: [],
    };

    const draft = {
      localId: "l1",
      mailboxId: "mbx_1",
      draftId: "drf_1",
      baseRevision: 1,
      threadId: null,
      content,
      state: "local" as const,
      updatedAt: 0,
    };

    await store.save(draft);
    const h = harness(() => ({ status: 200, body: { _tag: "Conflict", currentRevision: 4 } }));

    const merged = await syncDraft(h.client(), draft, async () => ({
      revision: 4,
      content: { ...content, text: "server" },
    }));

    expect(merged.state).toBe("conflict");
    expect(merged.conflictCopy?.text).toBe("long offline text");
    expect(merged.content.text).toBe("server");
    expect((await store.list()).map((d) => d.localId)).toEqual(["l1"]);

    const offline = harness(() => {
      throw new Error("offline");
    });

    expect(
      await syncDraft(offline.client(), { ...draft, draftId: null }, async () => ({
        revision: 0,
        content,
      })),
    ).toMatchObject({ state: "local", draftId: null });
  });

  it("[X01] week views start on Monday", () => {
    // Sunday 27 Sep 2026 belongs to the week of Monday 21 Sep (not the following Monday).
    const start = weekStart(new Date(2026, 8, 27, 15));
    expect([start.getFullYear(), start.getMonth(), start.getDate()]).toEqual([2026, 8, 21]);
    expect([start.getHours(), start.getMinutes(), start.getSeconds()]).toEqual([0, 0, 0]);
    // A Monday is its own week start.
    expect(weekStart(new Date(2026, 8, 21, 9)).getDate()).toBe(21);
  });

  describe("bearer refresh on 401", () => {
    const sessionHarness = (statuses: ReadonlyArray<number>, refreshed: string | null) => {
      const seen: Array<string | undefined> = [];
      let current = "old";
      let refreshes = 0;

      const client = new ByeClient({
        origin: "https://app.bye.test",
        auth: {
          token: async () => current,
          onUnauthorized: async () => {
            refreshes++;

            if (refreshed) current = refreshed;

            return refreshed;
          },
        },
        fetch: async (_url, init) => {
          seen.push(init.headers.authorization);
          const status = statuses[seen.length - 1] ?? 200;

          return {
            status,
            text: async () => JSON.stringify(status === 200 ? { ok: true } : { error: "nope" }),
          };
        },
      });

      return { client, seen, refreshes: () => refreshes };
    };

    it("[X01] refreshes the access token once and retries with the new bearer", async () => {
      const h = sessionHarness([401, 200], "new");
      expect(await h.client.request("GET", "/v1/me")).toEqual({ ok: true });
      expect(h.seen).toEqual(["Bearer old", "Bearer new"]);
      expect(h.refreshes()).toBe(1);
    });

    it("[X01] retries only once: a second 401 surfaces instead of looping", async () => {
      const h = sessionHarness([401, 401, 200], "new");
      await expect(h.client.request("GET", "/v1/me")).rejects.toMatchObject({ status: 401 });
      expect(h.seen).toEqual(["Bearer old", "Bearer new"]);
      expect(h.refreshes()).toBe(1);
    });

    it("[X01] a failed refresh surfaces the 401 without retrying", async () => {
      const h = sessionHarness([401, 200], null);
      await expect(h.client.request("GET", "/v1/me")).rejects.toBeInstanceOf(ByeApiError);
      expect(h.seen).toEqual(["Bearer old"]);
      expect(h.refreshes()).toBe(1);
    });
  });
});
