import { createInterface } from "node:readline";
import { Effect, type Layer } from "effect";
import type { MailboxCommandInput } from "@bye/native-shared";
import type { MailView } from "@bye/native-shared/views";
import { get, mailboxCommand } from "./args.ts";
import { CliApi } from "./client.ts";

// Minimal keyboard-driven TUI over the same API contracts (X02).
// Views: 1 Imbox, 2 Feed, 3 Paper Trail, 4 Screener, 5 Reply Later, 6 Set Aside; j/k move, s seen, l reply-later, q quit.

// The first six navigable views, in the shared display order (1–6 keys).
const VIEWS = [
  "imbox",
  "feed",
  "paper-trail",
  "screener",
  "reply-later",
  "set-aside",
] as const satisfies ReadonlyArray<MailView>;

interface Row {
  readonly threadId?: string;
  readonly id?: string;
  readonly subject?: string;
  readonly sender?: string;
  readonly revision?: number;
}

export const runTui = async (
  api: Layer.Layer<CliApi>,
  newCommandId: () => string,
): Promise<number> => {
  const run = <A>(effect: Effect.Effect<A, unknown, CliApi>) =>
    Effect.runPromise(effect.pipe(Effect.provide(api)) as Effect.Effect<A, unknown>);
  let view: (typeof VIEWS)[number] = "imbox";
  let rows: ReadonlyArray<Row> = [];
  let index = 0;
  let status = "";

  const load = async () => {
    try {
      const result = (await run(
        Effect.flatMap(CliApi, (client) =>
          get(`/v1/mailboxes/${client.config.mailboxId}/views/${view}`),
        ),
      )) as { items?: ReadonlyArray<Row> };
      rows = result.items ?? [];
      index = Math.min(index, Math.max(0, rows.length - 1));
      status = `${rows.length} threads`;
    } catch (error) {
      status = `load failed: ${String(error)}`;
    }
  };

  const command = async (body: MailboxCommandInput) => {
    try {
      await run(
        Effect.flatMap(CliApi, (client) =>
          mailboxCommand(client.config.mailboxId ?? "", newCommandId(), body),
        ),
      );
      status = `${body._tag} ok`;
    } catch (error) {
      status = `${body._tag} failed: ${String(error)}`;
    }
    await load();
  };

  const render = () => {
    const out: Array<string> = [
      "\x1b[2J\x1b[H",
      VIEWS.map((v, i) => (v === view ? `[${i + 1} ${v}]` : ` ${i + 1} ${v} `)).join(" "),
      "",
    ];
    rows.forEach((row, i) => {
      const from = String(row.sender ?? "");
      const line = `${from.slice(0, 24).padEnd(24)}  ${sanitize(row.subject ?? "(no subject)").slice(0, 70)}`;
      out.push(i === index ? `\x1b[7m> ${line}\x1b[0m` : `  ${line}`);
    });
    out.push(
      "",
      `j/k move · s seen · l reply later · a set aside · r refresh · q quit   ${status}`,
    );
    process.stdout.write(out.join("\n"));
  };

  await load();
  render();
  const rl = createInterface({ input: process.stdin });
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  return new Promise<number>((resolve) => {
    process.stdin.on("data", async (data: Buffer) => {
      const key = data.toString();
      const current = rows[index];
      const threadId = current?.threadId ?? current?.id;
      if (key === "q" || key === "\u0003") {
        if (process.stdin.isTTY) process.stdin.setRawMode(false);
        rl.close();
        process.stdout.write("\n");
        resolve(0);
        return;
      }
      if (key === "j") index = Math.min(rows.length - 1, index + 1);
      else if (key === "k") index = Math.max(0, index - 1);
      else if (/^[1-6]$/.test(key)) {
        view = VIEWS[Number(key) - 1]!;
        index = 0;
        await load();
      } else if (key === "r") await load();
      else if (key === "s" && threadId)
        await command({ _tag: "MarkSeen", threadId, observedRevision: current?.revision ?? 0 });
      else if (key === "l" && threadId)
        await command({ _tag: "SetAttention", flag: "replyLater", threadId, on: true });
      else if (key === "a" && threadId)
        await command({ _tag: "SetAttention", flag: "setAside", threadId, on: true });
      render();
    });
  });
};

/** Strip terminal control sequences from untrusted mail content before printing. */
export const sanitize = (text: string): string =>
  // oxlint-disable-next-line no-control-regex -- intentional control-char match
  text.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
