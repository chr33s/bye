import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { Effect } from "effect";
import { Argument } from "effect/unstable/cli";
import { action, commandId, mailbox, opt, post } from "./args.ts";
import { CliApi } from "./client.ts";

// `bye upload <file>`: multipart upload through /v1/uploads (E20). The server verifies the stored
// size and scans the upload before it can be attached or linked.

export const UPLOAD_COMMANDS = [
  action(
    "upload",
    {
      summary:
        "Upload a file for attachments or a large-file link (--type content/type); prints the upload ID",
    },
    { file: Argument.String("file"), type: opt("type") },
    ({ file, type }) =>
      Effect.gen(function* () {
        const mailboxId = yield* mailbox;
        const api = yield* CliApi;
        const bytes = new Uint8Array(yield* Effect.promise(() => readFile(file)));
        const reserved = (yield* post("/v1/uploads", {
          mailboxId,
          commandId: yield* commandId,
          filename: basename(file),
          contentType: type ?? "application/octet-stream",
          declaredSize: bytes.byteLength,
        })) as { uploadId: string; partSize: number };
        for (
          let offset = 0, part = 1;
          offset < bytes.byteLength;
          offset += reserved.partSize, part++
        ) {
          yield* api.putBytes(
            `/v1/uploads/${encodeURIComponent(reserved.uploadId)}/parts/${part}`,
            bytes.subarray(offset, offset + reserved.partSize),
            { mailbox: mailboxId },
          );
        }
        return yield* post(`/v1/uploads/${encodeURIComponent(reserved.uploadId)}/complete`, {
          mailboxId,
          commandId: yield* commandId,
        });
      }),
  ),
];
