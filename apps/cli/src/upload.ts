import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { Effect } from "effect";
import { flag, mailbox, post, type CommandSpec, UsageError } from "./args.ts";
import { CliApi } from "./client.ts";

// `bye upload <file>`: multipart upload through /v1/uploads (E20). The server verifies the stored
// size and scans the upload before it can be attached or linked.

export const UPLOAD_COMMANDS: ReadonlyArray<CommandSpec> = [
  {
    path: ["upload"],
    summary: "Upload a file for attachments or a large-file link; prints the upload ID",
    usage: "bye upload <file> [--type content/type]",
    run: (ctx) =>
      Effect.gen(function* () {
        const file = ctx.args.positionals[0];
        if (!file) throw new UsageError("missing <file>");
        const mailboxId = yield* mailbox(ctx);
        const api = yield* CliApi;
        const bytes = new Uint8Array(yield* Effect.promise(() => readFile(file)));
        const reserved = (yield* post("/v1/uploads", {
          mailboxId,
          commandId: ctx.newCommandId(),
          filename: basename(file),
          contentType: flag(ctx, "type") ?? "application/octet-stream",
          declaredSize: bytes.byteLength,
        })) as { uploadId: string; partSize: number };
        for (
          let offset = 0, part = 1;
          offset < bytes.byteLength;
          offset += reserved.partSize, part++
        ) {
          yield* api.putBytes(
            `/v1/uploads/${reserved.uploadId}/parts/${part}`,
            bytes.subarray(offset, offset + reserved.partSize),
            { mailbox: mailboxId },
          );
        }
        return yield* post(`/v1/uploads/${reserved.uploadId}/complete`, {
          mailboxId,
          commandId: ctx.newCommandId(),
        });
      }),
  },
];
