import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EXIT, type FetchLike, makeCliApi, runCli } from "@bye/cli";
import { invoke } from "../src/commands.ts";
import { sanitize } from "../src/tui.ts";

interface Call {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

const harness = (respond: (call: Call) => { status: number; body: unknown }) => {
  const calls: Array<Call> = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const call = {
      url,
      method: init.method,
      headers: init.headers,
      body: init.body === undefined ? undefined : JSON.parse(init.body as string),
    };
    calls.push(call);
    const { status, body } = respond(call);
    return {
      status,
      headers: { get: () => "application/json" },
      text: async () => JSON.stringify(body),
    };
  };
  const out: Array<string> = [];
  const err: Array<string> = [];
  let n = 0;
  const run = (argv: Array<string>, token: string | undefined = "tok_agent") =>
    runCli(
      argv,
      makeCliApi(
        { apiUrl: "https://api.test", token, mailboxId: "mbx_1", calendarId: "cal_1" },
        fetchImpl,
      ),
      {
        stdout: (t) => out.push(t),
        stderr: (t) => err.push(t),
        newCommandId: () => `cmd_${++n}`,
      },
    );
  return { calls, out, err, run };
};

describe("CLI", () => {
  it("[X02] parses flags anywhere, booleans and -- separators", async () => {
    const h = harness(() => ({ status: 200, body: {} }));
    expect(await h.run(["--json", "mail", "trash", "--mailbox", "mbx_2", "--", "-odd-id"])).toBe(
      EXIT.ok,
    );
    expect(h.calls[0]!.url).toBe("https://api.test/v1/mailboxes/mbx_2/commands");
    expect(h.calls[0]!.body).toMatchObject({ _tag: "MoveToTrash", threadIds: ["-odd-id"] });
    // A `-term` before `--` is a flag, not text: a usage error with a hint, nothing sent.
    expect(await h.run(["search", "invoice", "-spam"])).toBe(EXIT.usage);
    expect(h.err.join("\n")).toContain("go after `--`");
    expect(h.calls).toHaveLength(1);
  });

  it("[X02] prints help on request and with no command", async () => {
    const h = harness(() => ({ status: 200, body: {} }));
    expect(await h.run(["--help"])).toBe(EXIT.ok);
    expect(h.out.join("\n")).toContain("mail");
    expect(await h.run(["mail", "view", "--help"])).toBe(EXIT.ok);
    expect(await h.run([])).toBe(EXIT.usage);
    expect(h.calls).toHaveLength(0);
  });

  it("[X02] lists a view with bearer credentials and machine-readable JSON output", async () => {
    const h = harness(() => ({
      status: 200,
      body: { items: [{ threadId: "thr_1", subject: "Hi" }], cursor: "c1" },
    }));
    expect(await h.run(["mail", "view", "imbox", "--limit", "5", "--json"])).toBe(EXIT.ok);
    expect(h.calls[0]!.url).toBe("https://api.test/v1/mailboxes/mbx_1/views/imbox?limit=5");
    expect(h.calls[0]!.headers.authorization).toBe("Bearer tok_agent");
    expect(JSON.parse(h.out[0]!)).toEqual({
      items: [{ threadId: "thr_1", subject: "Hi" }],
      cursor: "c1",
    });
  });

  it("[X02] renders human tables with control characters stripped", async () => {
    const h = harness(() => ({
      status: 200,
      body: { items: [{ threadId: "thr_1", subject: "evil\u001b[31m\nsubject" }] },
    }));
    await h.run(["mail", "view", "feed"]);
    expect(h.out[0]).toContain("thr_1");
    expect(h.out[0]).not.toContain("\u001b");
    // oxlint-disable-next-line no-control-regex -- intentional control-char match
    expect(sanitize("a\u001b]0;pwn\u0007b")).not.toMatch(/[\u0000-\u001f]/);
  });

  it("[X02] requires --yes for consequential actions and sends an idempotent command ID", async () => {
    const h = harness(() => ({ status: 200, body: { sendJobId: "snd_1", state: "undo-window" } }));
    expect(await h.run(["draft", "send", "drf_1", "--revision", "3"])).toBe(EXIT.usage);
    expect(h.calls).toHaveLength(0);
    expect(await h.run(["draft", "send", "drf_1", "--revision", "3", "--yes"])).toBe(EXIT.ok);
    expect(h.calls[0]!.body).toMatchObject({ commandId: "cmd_1", revision: 3, mailboxId: "mbx_1" });
  });

  it("[X02] maps API errors to stable exit codes", async () => {
    const cases: Array<[number, string, number]> = [
      [401, "unauthenticated", EXIT.unauthenticated],
      [403, "forbidden", EXIT.forbidden],
      [404, "not_found", EXIT.notFound],
      [409, "too_late", EXIT.conflict],
      [429, "rate_limited", EXIT.rateLimited],
      [503, "unavailable", EXIT.unavailable],
    ];
    for (const [status, code, exit] of cases) {
      const h = harness(() => ({ status, body: { error: { code, message: code } } }));
      expect(await h.run(["send", "cancel", "snd_1", "--json"])).toBe(exit);
      expect(JSON.parse(h.err[0]!).error.code).toBe(code);
    }
  });

  it("[X02] a read/draft-scoped agent credential is refused sending by the server and reports forbidden", async () => {
    const h = harness((call) =>
      call.url.includes("/send")
        ? { status: 403, body: { error: { code: "forbidden", message: "missing scope send" } } }
        : { status: 200, body: {} },
    );
    expect(
      await h.run(["draft", "create", "--to", "a@example.com", "--subject", "s", "--body", "b"]),
    ).toBe(EXIT.ok);
    expect(await h.run(["draft", "send", "drf_1", "--yes"])).toBe(EXIT.forbidden);
    expect(h.err.at(-1)).toContain("missing scope send");
  });

  it("[X02] covers mail, screening, workflows, search and calendar commands", async () => {
    const h = harness(() => ({ status: 200, body: {} }));
    await h.run(["screen", "approve", "a@example.com", "--to", "feed", "--yes"]);
    await h.run(["workflow", "add", "brd_1", "thr_1"]);
    await h.run(["search", "--", '"exact', 'phrase"', "-spam", "from:a@example.com"]);
    await h.run([
      "cal",
      "events",
      "--from",
      "2026-09-01T00:00:00Z",
      "--to",
      "2026-09-08T00:00:00Z",
    ]);
    await h.run(["mail", "follow-up", "thr_1", "--at", "2026-10-01T09:00:00Z"]);
    expect(h.calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      "POST /v1/mailboxes/mbx_1/commands",
      "POST /v1/mailboxes/mbx_1/commands",
      "GET /v1/mailboxes/mbx_1/search",
      "GET /v1/calendars/cal_1/events",
      "POST /v1/mailboxes/mbx_1/commands",
    ]);
    expect(h.calls[0]!.body).toMatchObject({
      _tag: "Screen",
      decisions: [{ sender: "a@example.com", decision: "allow", destination: "feed" }],
    });
    expect(h.calls[1]!.body).toMatchObject({
      _tag: "AddToBoard",
      boardId: "brd_1",
      threadId: "thr_1",
    });
    expect(new URL(h.calls[2]!.url).searchParams.get("q")).toBe(
      '"exact phrase" -spam from:a@example.com',
    );
  });

  it("[X02] calendar events are created with wall-clock time and IANA zone", async () => {
    const h = harness(() => ({ status: 200, body: {} }));
    await h.run([
      "cal",
      "add",
      "--calendar-id",
      "c1",
      "--title",
      "Standup",
      "--start",
      "2026-10-01T09:00",
      "--end",
      "2026-10-01T09:15",
      "--tz",
      "Europe/London",
    ]);
    expect(h.calls[0]!.url).toBe("https://api.test/v1/calendars/cal_1/commands");
    expect(h.calls[0]!.body).toMatchObject({
      schemaVersion: 1,
      command: {
        type: "CreateEvent",
        calendarId: "c1",
        data: { summary: "Standup" },
        start: {
          kind: "timed",
          tzid: "Europe/London",
          local: { year: 2026, month: 10, day: 1, hour: 9, minute: 0 },
        },
      },
    });
  });

  it("[X02] rejects unknown commands and missing arguments with usage exit", async () => {
    const h = harness(() => ({ status: 200, body: {} }));
    expect(await h.run(["frobnicate"])).toBe(EXIT.usage);
    expect(await h.run(["mail", "view", "nope"])).toBe(EXIT.usage);
    expect(await h.run(["mail", "follow-up", "thr_1", "--at", "not-a-date"])).toBe(EXIT.usage);
    // An invalid destination is a usage error before anything is sent (it used to reach the server).
    expect(await h.run(["screen", "approve", "a@example.com", "--to", "bogus", "--yes"])).toBe(
      EXIT.usage,
    );
    // Missing selection flags are usage errors too, never a request with an empty ID.
    const noFetch: FetchLike = async () => {
      throw new Error("no request expected");
    };
    expect(
      await runCli(
        ["mail", "view", "imbox"],
        makeCliApi(
          { apiUrl: "https://api.test", token: "tok", mailboxId: undefined, calendarId: undefined },
          noFetch,
        ),
        { stdout: () => undefined, stderr: () => undefined, newCommandId: () => "cmd" },
      ),
    ).toBe(EXIT.usage);
    expect(h.calls).toEqual([]);
  });

  it("[X02] parity commands: focus, batches, trash, policies, send jobs, planning, timer and feeds", async () => {
    const h = harness(() => ({ status: 200, body: { items: [] } }));
    expect(await h.run(["mail", "focus", "--json"])).toBe(EXIT.ok);
    expect(await h.run(["mail", "batch", "--new", "--json"])).toBe(EXIT.ok);
    expect(await h.run(["mail", "trash", "thr_1", "thr_2", "--json"])).toBe(EXIT.ok);
    expect(await h.run(["policy", "clear", "spam.example", "--json"])).toBe(EXIT.usage);
    expect(await h.run(["policy", "clear", "spam.example", "--yes", "--json"])).toBe(EXIT.ok);
    expect(await h.run(["send", "show", "sj_1", "--json"])).toBe(EXIT.ok);
    expect(
      await h.run(["cal", "task", "add", "Call", "the", "bank", "--date", "2026-10-01", "--json"]),
    ).toBe(EXIT.ok);
    expect(await h.run(["cal", "timer", "start", "Writing", "--json"])).toBe(EXIT.ok);
    expect(await h.run(["cal", "feeds", "create", "--label", "Phone", "--yes", "--json"])).toBe(
      EXIT.ok,
    );
    expect(await h.run(["cal", "task", "add", "x", "--date", "tomorrow"])).toBe(EXIT.usage);
    const byUrl = h.calls.map(
      (c) => [c.method, c.url.replace("https://api.test", "").split("?")[0], c.body] as const,
    );
    expect(byUrl[0]).toEqual(["GET", "/v1/mailboxes/mbx_1/focus", undefined]);
    expect(byUrl[1]![2]).toMatchObject({ _tag: "CreateBatch", threadIds: "new-for-you" });
    expect(byUrl[2]![2]).toMatchObject({ _tag: "MoveToTrash", threadIds: ["thr_1", "thr_2"] });
    expect(byUrl[3]![2]).toMatchObject({
      _tag: "SetPolicy",
      kind: "domain",
      subject: "spam.example",
      policy: null,
    });
    expect(byUrl[4]!.slice(0, 2)).toEqual(["GET", "/v1/mailboxes/mbx_1/send-jobs/sj_1"]);
    expect(byUrl[5]![2]).toMatchObject({
      schemaVersion: 1,
      command: {
        type: "AddWeekTask",
        title: "Call the bank",
        date: { year: 2026, month: 10, day: 1 },
        firstWeekday: 1,
      },
    });
    expect(byUrl[6]![2]).toMatchObject({ command: { type: "StartTimer", label: "Writing" } });
    expect(byUrl[7]).toEqual([
      "POST",
      "/v1/calendars/cal_1/feed-tokens",
      { schemaVersion: 1, commandId: expect.any(String), calendarIds: ["cal_1"], label: "Phone" },
    ]);
    expect(h.calls).toHaveLength(8);
  });
});

describe("CLI review fixes", () => {
  it("[X02] human output of untrusted text is terminal-safe and keeps its lines", async () => {
    const h = harness(() => ({
      status: 200,
      body: { text: "hi\u001b]0;pwned\u0007\u001b[31m red\nsecond\u202e line" },
    }));
    expect(await h.run(["mail", "text", "dl/1"])).toBe(EXIT.ok);
    // IDs are path segments, never extra path.
    expect(new URL(h.calls[0]!.url).pathname).toBe("/v1/mailboxes/mbx_1/deliveries/dl%2F1/text");
    expect(h.out[0]).toBe("text: hi red\nsecond line");
  });

  it("[X02] invalid event windows are usage errors; follow-ups count from the send time", async () => {
    const h = harness(() => ({ status: 200, body: {} }));
    expect(await h.run(["cal", "events", "--from", "garbage"])).toBe(EXIT.usage);
    expect(h.calls).toHaveLength(0);
    const at = "2030-01-01T00:00:00Z";
    expect(
      await h.run(["draft", "send", "drf_1", "--at", at, "--after", "follow-up", "--yes"]),
    ).toBe(EXIT.ok);
    expect(h.calls[0]!.body).toMatchObject({
      sendAt: Date.parse(at),
      afterSend: { _tag: "BubbleUp", at: Date.parse(at) + 86_400_000, condition: "always" },
    });
  });

  it("[E09] the earlier bubble names still work as aliases", async () => {
    const h = harness(() => ({ status: 200, body: {} }));
    expect(await h.run(["mail", "bubble", "thr_1", "--at", "2026-10-01T09:00:00Z"])).toBe(EXIT.ok);
    expect(await h.run(["draft", "send", "drf_1", "--after", "bubble-no-reply", "--yes"])).toBe(
      EXIT.ok,
    );
    expect(h.calls[0]!.body).toMatchObject({ _tag: "BubbleUp" });
    expect(h.calls[1]!.body).toMatchObject({
      afterSend: { _tag: "BubbleUp", condition: "if-no-reply" },
    });
  });

  it("[X02] the TUI's calls skip absent flags instead of sending the text undefined", async () => {
    const h = harness(() => ({ status: 200, body: {} }));
    await invoke(
      "cal respond",
      ["evt_1", "accept"],
      { occurrence: undefined },
      {
        api: makeCliApi(
          { apiUrl: "https://api.test", token: "t", mailboxId: "mbx_1", calendarId: "cal_1" },
          async (url, init) => {
            h.calls.push({
              url,
              method: init.method,
              headers: init.headers,
              body: JSON.parse(init.body as string),
            });
            return {
              status: 200,
              headers: { get: () => "application/json" },
              text: async () => "{}",
            };
          },
        ),
        newCommandId: () => "cmd_1",
      },
    );
    expect((h.calls[0]!.body as { command: object }).command).not.toHaveProperty("occurrenceKey");
  });
});

describe("CLI raw exports", () => {
  it("[E16] contacts export prints the vCard body verbatim", async () => {
    const vcard = "BEGIN:VCARD\r\nVERSION:4.0\r\nFN:Ana\r\nEND:VCARD\r\n";
    const out: Array<string> = [];
    const fetchImpl: FetchLike = async () => ({
      status: 200,
      headers: { get: () => "text/vcard" },
      text: async () => vcard,
    });
    const code = await runCli(
      ["contacts", "export"],
      makeCliApi(
        { apiUrl: "https://api.test", token: "t", mailboxId: "mbx_1", calendarId: undefined },
        fetchImpl,
      ),
      {
        stdout: (t) => out.push(t),
        stderr: () => undefined,
        newCommandId: () => "cmd_1",
      },
    );
    expect(code).toBe(0);
    expect(out[0]).toBe(vcard);
  });
});

describe("CLI upload", () => {
  it("[E20] uploads a file in parts and completes with the server-verified size", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bye-cli-"));
    const file = join(dir, "notes.txt");
    await writeFile(file, "x".repeat(25));
    const calls: Array<{ method: string; url: string; size?: number }> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({
        method: init.method,
        url,
        ...(init.body instanceof Uint8Array ? { size: init.body.byteLength } : {}),
      });
      const body = url.endsWith("/v1/uploads")
        ? { uploadId: "upl_1", partSize: 10 }
        : { state: "complete" };
      return {
        status: 200,
        headers: { get: () => "application/json" },
        text: async () => JSON.stringify(body),
      };
    };
    const code = await runCli(
      ["upload", file],
      makeCliApi(
        { apiUrl: "https://api.test", token: "t", mailboxId: "mbx_1", calendarId: undefined },
        fetchImpl,
      ),
      {
        stdout: () => undefined,
        stderr: () => undefined,
        newCommandId: () => "cmd_1",
      },
    );
    expect(code).toBe(0);
    expect(
      calls.map((c) => `${c.method} ${new URL(c.url).pathname} ${c.size ?? ""}`.trim()),
    ).toEqual([
      "POST /v1/uploads",
      "PUT /v1/uploads/upl_1/parts/1 10",
      "PUT /v1/uploads/upl_1/parts/2 10",
      "PUT /v1/uploads/upl_1/parts/3 5",
      "POST /v1/uploads/upl_1/complete",
    ]);
  });
});
