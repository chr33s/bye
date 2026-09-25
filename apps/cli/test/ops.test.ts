import { describe, expect, it } from "vitest";
import { EXIT, type FetchLike, makeCliApi, runCli } from "@bye/cli";

const harness = () => {
  const calls: Array<{ url: string; method: string; auth: string | undefined; body: unknown }> = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({
      url,
      method: init.method,
      auth: init.headers.authorization,
      body: init.body === undefined ? undefined : JSON.parse(init.body as string),
    });
    const body = url.includes("/replay")
      ? { _tag: "Replayed" }
      : { deadLetters: [{ id: "dl_1", queue: "bye-ingest-dlq", state: "held" }] };
    return {
      status: 200,
      headers: { get: () => "application/json" },
      text: async () => JSON.stringify(body),
    };
  };
  const out: Array<string> = [];
  const err: Array<string> = [];
  const run = (argv: Array<string>) =>
    runCli(
      argv,
      makeCliApi(
        {
          apiUrl: "https://api.test",
          token: "ops-token",
          mailboxId: undefined,
          calendarId: undefined,
        },
        fetchImpl,
      ),
      {
        stdout: (t) => out.push(t),
        stderr: (t) => err.push(t),
        newCommandId: () => "cmd_1",
      },
    );
  return { calls, out, err, run };
};

describe("bye ops", () => {
  it("[§6] lists dead letters with the operator bearer and filters", async () => {
    const h = harness();
    expect(await h.run(["ops", "dlq", "list", "--state", "held", "--json"])).toBe(EXIT.ok);
    expect(h.calls[0]).toMatchObject({ method: "GET", auth: "Bearer ops-token" });
    expect(h.calls[0]!.url).toBe("https://api.test/v1/ops/dlq?state=held");
    expect(h.out.join("")).toContain("dl_1");
  });

  it("[§6] replay is consequential and requires --yes", async () => {
    const h = harness();
    expect(await h.run(["ops", "dlq", "replay", "dl_1"])).toBe(EXIT.usage);
    expect(h.calls).toHaveLength(0);
    expect(await h.run(["ops", "dlq", "replay", "dl_1", "--yes"])).toBe(EXIT.ok);
    expect(h.calls[0]).toMatchObject({
      method: "POST",
      url: "https://api.test/v1/ops/dlq/dl_1/replay",
    });
  });

  it("[§12] reindex and erase send the target IDs", async () => {
    const h = harness();
    await h.run(["ops", "reindex", "mbx_9", "--yes"]);
    await h.run(["ops", "erase", "usr_9", "--reason", "closure", "--yes"]);
    expect(h.calls.map((c) => [c.url, c.body])).toEqual([
      ["https://api.test/v1/ops/reindex", { mailboxId: "mbx_9" }],
      ["https://api.test/v1/ops/erasure", { userId: "usr_9", reason: "closure" }],
    ]);
    expect(await h.run(["ops", "reindex", "--yes"])).toBe(EXIT.usage);
  });
});
