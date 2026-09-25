import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { binaryToBytes, mboxEntryText, serializeVCards } from "@bye/mail-codec";
import { Schema } from "effect";
import { recordGcIntent } from "../blobgc.ts";
import { recordUsage } from "../usage.ts";
import type { CoreEnv } from "../env.ts";
import { calendar, mailbox, settle } from "../authorities.ts";
import { decodeParams, PART_BYTES, promiseStep } from "./common.ts";

export const ExportParamsSchema = Schema.Struct({
  v: Schema.Literal(1),
  exportId: Schema.String,
  userId: Schema.String,
  mailboxIds: Schema.Array(Schema.String),
  calendarIds: Schema.Array(Schema.String),
});
export type ExportParams = typeof ExportParamsSchema.Encoded;

/** Exports stay downloadable this long, then become GC intents (§12, A04). */
export const EXPORT_RETENTION_MS = 7 * 24 * 3600_000;

const RETRY = { retries: { limit: 5, delay: "30 seconds", backoff: "exponential" } } as const;

/** Checkpointed MBOX progress (the Schema of what `appendMboxPage` returns). */
const MboxStateSchema = Schema.Struct({
  cursor: Schema.NullOr(Schema.String),
  parts: Schema.Array(Schema.Struct({ partNumber: Schema.Number, etag: Schema.String })),
  carry: Schema.NullOr(Schema.String),
});

/** Serializable MBOX progress carried between Workflow steps. */
export interface MboxState {
  readonly cursor: string | null;
  readonly parts: ReadonlyArray<{ readonly partNumber: number; readonly etag: string }>;
  /** Key of the object holding the tail bytes (< PART_BYTES) not yet uploaded. */
  readonly carry: string | null;
}

/** Append one manifest page to the multipart MBOX. Retry-safe: same input → same parts/carry. */
export const appendMboxPage = async (
  env: CoreEnv,
  mailboxId: string,
  key: string,
  uploadId: string,
  input: MboxState,
  carryOut: string,
  pageSize = 50,
  partBytes = PART_BYTES,
): Promise<MboxState> => {
  const upload = env.EXPORTS.resumeMultipartUpload(key, uploadId);
  const parts = [...input.parts];
  let pending: Array<Uint8Array> = [];
  let size = 0;
  const push = async (bytes: Uint8Array) => {
    let offset = 0;
    while (offset < bytes.byteLength) {
      const take = Math.min(partBytes - size, bytes.byteLength - offset);
      pending.push(bytes.subarray(offset, offset + take));
      size += take;
      offset += take;
      if (size === partBytes) {
        const joined = new Uint8Array(size);
        let o = 0;
        for (const b of pending) joined.set(b, (o += b.byteLength) - b.byteLength);
        const partNumber = parts.length + 1;
        const uploaded = await upload.uploadPart(partNumber, joined);
        parts.push({ partNumber, etag: uploaded.etag });
        pending = [];
        size = 0;
      }
    }
  };
  if (input.carry) {
    const carried = await env.EXPORTS.get(input.carry);
    if (carried) await push(new Uint8Array(await carried.arrayBuffer()));
  }
  const page = await mailbox(env, mailboxId).exportManifestPage(input.cursor, pageSize);
  for (const d of page.deliveries) {
    // One message in memory at a time (≤ the 25 MiB inbound limit), never the whole page.
    const original = await env.ORIGINALS.get(d.messageKey);
    if (original)
      await push(
        binaryToBytes(
          mboxEntryText({
            envelopeFrom: d.from,
            date: d.date,
            bytes: new Uint8Array(await original.arrayBuffer()),
          }),
        ),
      );
  }
  let carry: string | null = null;
  if (size > 0) {
    const joined = new Uint8Array(size);
    let o = 0;
    for (const b of pending) joined.set(b, (o += b.byteLength) - b.byteLength);
    await env.EXPORTS.put(carryOut, joined);
    carry = carryOut;
  }
  return { cursor: page.nextCursor, parts, carry };
};

/** Upload the final tail and complete. Never overwrites an already-completed MBOX with an empty one. */
export const completeMbox = async (
  env: CoreEnv,
  key: string,
  uploadId: string,
  state: MboxState,
): Promise<string> => {
  const existing = await env.EXPORTS.head(key);
  if (existing) return key;
  const upload = env.EXPORTS.resumeMultipartUpload(key, uploadId);
  const parts = [...state.parts];
  if (state.carry) {
    const tail = await env.EXPORTS.get(state.carry);
    if (tail)
      parts.push({
        partNumber: parts.length + 1,
        etag: (await upload.uploadPart(parts.length + 1, new Uint8Array(await tail.arrayBuffer())))
          .etag,
      });
  }
  if (parts.length === 0) {
    await upload.abort().catch(() => undefined);
    await env.EXPORTS.put(key, new Uint8Array(0), {
      httpMetadata: { contentType: "application/mbox" },
    });
  } else {
    await upload.complete(parts);
  }
  return key;
};

/** A04: MBOX mail, vCard contacts, ICS calendars, and a separate notes/settings JSON export. */
export class ExportWorkflow extends WorkflowEntrypoint<CoreEnv, ExportParams> {
  override async run(event: Readonly<WorkflowEvent<ExportParams>>, step: WorkflowStep) {
    const { exportId, userId, mailboxIds, calendarIds } = decodeParams(ExportParamsSchema)(
      event.payload,
    );
    const env = this.env;
    const prefix = `t/${userId}/export/${exportId}`;
    const files: Array<string> = [];

    for (const mailboxId of mailboxIds) {
      // Complete, paged MBOX (§12) with bounded memory: ONE R2 multipart upload for the whole file.
      // Each page step streams messages one at a time and uploads full-size parts; the tail smaller
      // than a part is carried to the next step in a small object keyed by step index, so a retried
      // step reads exactly the same inputs. Nothing is buffered across the whole mailbox.
      const key = `${prefix}/${mailboxId}.mbox`;
      const carryKey = (i: number) => `${prefix}/.carry/${mailboxId}/${String(i).padStart(6, "0")}`;
      const uploadId = await promiseStep(
        step,
        `v1:mbox-begin:${mailboxId}`,
        Schema.String,
        async () =>
          (
            await env.EXPORTS.createMultipartUpload(key, {
              httpMetadata: { contentType: "application/mbox" },
            })
          ).uploadId,
      );
      let state: MboxState = { cursor: null, parts: [], carry: null };
      let index = 0;
      do {
        const input: MboxState = state;
        const i = index++;
        state = await promiseStep(
          step,
          `v1:mbox-page:${mailboxId}:${i}`,
          MboxStateSchema,
          () => appendMboxPage(env, mailboxId, key, uploadId, input, carryKey(i)),
          RETRY,
        );
      } while (state.cursor);
      const final: MboxState = state;
      files.push(
        await promiseStep(
          step,
          `v1:mbox-complete:${mailboxId}`,
          Schema.String,
          () => completeMbox(env, key, uploadId, final),
          RETRY,
        ),
      );
      await promiseStep(step, `v1:mbox-cleanup:${mailboxId}`, Schema.Boolean, async () => {
        // Only after the MBOX is durably complete; a retry here is harmless.
        for (;;) {
          const listed = await env.EXPORTS.list({
            prefix: `${prefix}/.carry/${mailboxId}/`,
            limit: 1000,
          });
          if (listed.objects.length) await env.EXPORTS.delete(listed.objects.map((o) => o.key));
          if (!listed.truncated) break;
        }
        return true;
      });
      const manifestKey = await promiseStep(
        step,
        `v1:manifest:${mailboxId}`,
        Schema.String,
        async () => {
          const m = await mailbox(env, mailboxId).exportSettings();
          const settingsKey = `${prefix}/.chunks/${mailboxId}.manifest.json`;
          await env.EXPORTS.put(
            settingsKey,
            JSON.stringify({
              contacts: m.contacts,
              notes: m.notes,
              clips: m.clips,
              policies: m.policies,
            }),
          );
          return settingsKey;
        },
      );
      files.push(
        await promiseStep(step, `v1:vcard-notes:${mailboxId}`, Schema.String, async () => {
          const manifest = (await (await this.env.EXPORTS.get(manifestKey))!.json()) as {
            contacts: ReadonlyArray<{
              contactId: string;
              name: string;
              emails: ReadonlyArray<string>;
              notes: string;
              groups: ReadonlyArray<string>;
            }>;
            notes: unknown;
            clips: unknown;
            policies: unknown;
          };
          const cards = manifest.contacts.map((c) => ({
            version: "4.0",
            uid: c.contactId,
            fn: c.name,
            n: undefined,
            emails: c.emails.map((value) => ({ value, types: [] })),
            tels: [],
            org: undefined,
            note: c.notes || undefined,
            categories: c.groups,
          }));
          await this.env.EXPORTS.put(`${prefix}/${mailboxId}.vcf`, serializeVCards(cards), {
            httpMetadata: { contentType: "text/vcard" },
          });
          await this.env.EXPORTS.put(
            `${prefix}/${mailboxId}.notes-settings.json`,
            JSON.stringify({
              notes: manifest.notes,
              clips: manifest.clips,
              senderPolicies: manifest.policies,
            }),
            {
              httpMetadata: { contentType: "application/json" },
            },
          );
          return `${prefix}/${mailboxId}.vcf`;
        }),
      );
    }
    for (const calendarId of calendarIds) {
      files.push(
        await promiseStep(step, `v1:ics:${calendarId}`, Schema.String, async () => {
          const ics = await settle(calendar(this.env, calendarId).read(userId, { type: "Export" }));
          if (typeof ics !== "string") throw new Error("calendar export: not text");
          const key = `${prefix}/${calendarId}.ics`;
          await this.env.EXPORTS.put(key, ics, { httpMetadata: { contentType: "text/calendar" } });
          return key;
        }),
      );
    }
    await promiseStep(step, "v1:retention", Schema.Boolean, async () => {
      for (const key of files) {
        const head = await env.EXPORTS.head(key);
        if (head) await recordUsage(env, "user", userId, "exports", head.size);
        await recordGcIntent(env, {
          bucket: "EXPORTS",
          key,
          ownerKind: "user",
          ownerId: userId,
          reason: "export-expired",
          delayMs: EXPORT_RETENTION_MS,
        });
      }
      return true;
    });
    return { v: 1, exportId, files, expiresAt: Date.now() + EXPORT_RETENTION_MS };
  }
}
