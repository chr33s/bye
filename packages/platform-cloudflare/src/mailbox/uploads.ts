import { normalizeAddress, timingSafeEqual } from "@bye/domain";
import { json } from "../durable/sql.ts";
import { type MailboxContext, reject } from "./context.ts";
import { isServableUpload, toUpload, type UploadRow } from "./rows.ts";
import type { MailboxUpload } from "./types.ts";

// Uploads, quota, large-file links and the attachment library (E20, §12).

export const DEFAULT_QUOTA_BYTES = 100 * 1024 * 1024 * 1024;

const isOpen = (state: string): boolean => state === "reserved" || state === "uploading";

export class MailboxUploads {
  constructor(private readonly ctx: MailboxContext) {}

  private get sql() {
    return this.ctx.sql;
  }

  // ------------------------------------------------------------ quota (§12)

  quota(): { readonly limitBytes: number; readonly usedBytes: number } {
    const limitBytes = this.ctx.setting<number>("quota:limitBytes", DEFAULT_QUOTA_BYTES);
    const mail = Number(
      this.sql.one<{ n: number | null }>("SELECT SUM(raw_size) AS n FROM deliveries")?.n ?? 0,
    );
    const uploads = Number(
      this.sql.one<{ n: number | null }>(
        "SELECT SUM(COALESCE(actual_size, declared_size)) AS n FROM uploads WHERE state IN ('reserved','uploading','complete')",
      )?.n ?? 0,
    );
    // Parts, normalized bodies and exports live outside this authority (D1 `storage_usage`); the
    // host refreshes their total before quota decisions and on reconcile.
    return { limitBytes, usedBytes: mail + uploads + this.externalUsage() };
  }

  /** Storage counted against the quota that lives outside this authority (parts, bodies, exports). */
  externalUsage(): number {
    return this.ctx.setting<number>("quota:externalBytes", 0);
  }

  setExternalUsage(bytes: number): void {
    this.ctx.putSetting("quota:externalBytes", Math.max(0, Math.floor(bytes)));
  }

  setQuota(limitBytes: number): void {
    this.ctx.putSetting("quota:limitBytes", limitBytes);
  }

  // ------------------------------------------------------------ uploads (E20)

  reserveUpload(input: {
    readonly filename: string;
    readonly contentType: string;
    readonly declaredSize: number;
  }): { readonly uploadId: string; readonly blobKey: string } {
    // Zero is a valid size (empty files); it completes without any parts.
    if (!(Number.isInteger(input.declaredSize) && input.declaredSize >= 0))
      reject("bad_request", "declared size required");
    const q = this.quota();
    if (q.usedBytes + input.declaredSize > q.limitBytes)
      reject("payload_too_large", "quota exceeded", { ...q });
    const uploadId = this.ctx.id("upl");
    const blobKey = `t/${this.ctx.mailboxId}/upload/${uploadId}`;
    this.sql.run(
      "INSERT INTO uploads (upload_id, filename, content_type, declared_size, state, blob_key, created_at) VALUES (?, ?, ?, ?, 'reserved', ?, ?)",
      uploadId,
      input.filename.slice(0, 255),
      input.contentType,
      input.declaredSize,
      blobKey,
      this.ctx.now(),
    );
    return { uploadId, blobKey };
  }

  recordUploadPart(uploadId: string, partNumber: number, size: number, etag: string): void {
    this.sql.tx(() => {
      const r = this.row(uploadId) ?? reject("not_found", "upload");
      if (r.state !== "reserved" && r.state !== "uploading") reject("conflict", "upload closed");
      const parts = json<Array<{ n: number; size: number; etag: string }>>(r.parts, []).filter(
        (p) => p.n !== partNumber,
      );
      parts.push({ n: partNumber, size, etag });
      const total = parts.reduce((s, p) => s + p.size, 0);
      if (total > Number(r.declared_size)) {
        this.close(uploadId, "failed", null);
        return;
      }
      this.sql.run(
        "UPDATE uploads SET state = 'uploading', parts = ? WHERE upload_id = ? AND state IN ('reserved','uploading')",
        JSON.stringify(parts.sort((a, b) => a.n - b.n)),
        uploadId,
      );
    });
  }

  /**
   * Verify actual size against the declaration; content type claims are not trusted until scanned.
   * Only an open upload (`reserved`/`uploading`) can close: every transition is a conditional
   * UPDATE, so an aborted upload can't complete and a completed one can't fail or abort. A repeat
   * of the transition that already happened returns the upload unchanged.
   */
  completeUpload(uploadId: string, actualSize: number): MailboxUpload {
    const u = this.upload(uploadId) ?? reject("not_found", "upload");
    if (u.state === "complete" && u.actualSize === actualSize) return u;
    // Parts overran the declaration: the upload already failed; completing it only collects it.
    if (u.state === "failed") {
      this.ctx.kernel.emit("blob-gc", this.ctx.mailboxId, {
        key: u.blobKey,
        reason: "upload-failed",
      });
      return u;
    }
    if (!isOpen(u.state)) reject("conflict", `upload is ${u.state}`);
    if (actualSize > u.declaredSize) {
      if (!this.close(uploadId, "failed", actualSize)) reject("conflict", "upload closed");
      this.ctx.kernel.emit("blob-gc", this.ctx.mailboxId, {
        key: u.blobKey,
        reason: "upload-failed",
      });
      return this.upload(uploadId)!;
    }
    if (!this.close(uploadId, "complete", actualSize)) reject("conflict", "upload closed");
    this.ctx.kernel.emit("scan", this.ctx.mailboxId, { uploadId, key: u.blobKey });
    return this.upload(uploadId)!;
  }

  abortUpload(uploadId: string): void {
    const u = this.upload(uploadId) ?? reject("not_found", "upload");
    if (u.state === "aborted") return;
    if (!this.close(uploadId, "aborted", null)) reject("conflict", `upload is ${u.state}`);
    this.ctx.kernel.emit("blob-gc", this.ctx.mailboxId, { key: u.blobKey, reason: "aborted" });
  }

  /** `reserved|uploading → complete|failed|aborted`; false when the upload was already closed. */
  private close(
    uploadId: string,
    to: "complete" | "failed" | "aborted",
    actualSize: number | null,
  ): boolean {
    return (
      this.sql.run(
        "UPDATE uploads SET state = ?, actual_size = COALESCE(?, actual_size) WHERE upload_id = ? AND state IN ('reserved','uploading')",
        to,
        actualSize,
        uploadId,
      ) > 0
    );
  }

  setR2UploadId(uploadId: string, r2UploadId: string): void {
    this.sql.run("UPDATE uploads SET r2_upload_id = ? WHERE upload_id = ?", r2UploadId, uploadId);
  }

  uploadParts(uploadId: string): {
    readonly r2UploadId: string | null;
    readonly parts: ReadonlyArray<{
      readonly n: number;
      readonly size: number;
      readonly etag: string;
    }>;
  } {
    const r = this.row(uploadId) ?? reject("not_found", "upload");
    return { r2UploadId: r.r2_upload_id, parts: json(r.parts, []) };
  }

  uploads(limit = 100): ReadonlyArray<MailboxUpload & { readonly createdAt: number }> {
    return this.sql
      .all<UploadRow>(
        "SELECT * FROM uploads WHERE state = 'complete' ORDER BY created_at DESC LIMIT ?",
        limit,
      )
      .map((r) => ({ ...toUpload(r), createdAt: Number(r.created_at) }));
  }

  setScanResult(uploadId: string, status: "clean" | "infected" | "failed"): void {
    this.sql.tx(() => {
      this.sql.run("UPDATE uploads SET scan_status = ? WHERE upload_id = ?", status, uploadId);
      if (status === "clean") this.ctx.indexUpsert("upload", uploadId);
      else this.ctx.indexDelete("upload", uploadId);
      if (status !== "clean")
        this.sql.run(
          "UPDATE file_links SET revoked_at = ? WHERE upload_id = ? AND revoked_at IS NULL",
          this.ctx.now(),
          uploadId,
        );
      this.ctx.change("upload", "scanned", { uploadId, status });
    });
  }

  private row(uploadId: string): UploadRow | undefined {
    return this.sql.one<UploadRow>("SELECT * FROM uploads WHERE upload_id = ?", uploadId);
  }

  upload(uploadId: string): MailboxUpload | undefined {
    const r = this.row(uploadId);
    return r ? toUpload(r) : undefined;
  }

  /** Bytes a draft's attachments add; rejects anything not complete and scanned clean, or a bad file link. */
  attachmentBytes(uploadIds: ReadonlyArray<string>, fileLinks: ReadonlyArray<string>): number {
    let bytes = 0;
    for (const uploadId of uploadIds) {
      const u = this.upload(uploadId) ?? reject("bad_request", "unknown attachment", { uploadId });
      if (!isServableUpload(u))
        reject("conflict", "attachment not ready", {
          uploadId,
          state: u.state,
          scanStatus: u.scanStatus,
        });
      bytes += u.actualSize ?? u.declaredSize;
    }
    for (const linkId of fileLinks) {
      const l = this.sql.one<{ revoked_at: number | null }>(
        "SELECT revoked_at FROM file_links WHERE link_id = ?",
        linkId,
      );
      if (!l || l.revoked_at !== null) reject("bad_request", "invalid file link", { linkId });
    }
    return bytes;
  }

  // ------------------------------------------------------------ attachment library (E20)

  attachments(
    filter: {
      readonly contentTypePrefix?: string;
      readonly from?: string;
      readonly minSize?: number;
      readonly limit?: number;
    } = {},
  ): ReadonlyArray<{
    readonly deliveryId: string;
    readonly partId: string;
    readonly threadId: string;
    readonly filename: string;
    readonly contentType: string;
    readonly size: number;
    readonly from: string;
    readonly receivedAt: number;
  }> {
    const from = filter.from ? normalizeAddress(filter.from) : null;
    return this.sql
      .all<{
        delivery_id: string;
        part_id: string;
        thread_id: string;
        filename: string;
        content_type: string;
        size: number;
        from_address: string;
        received_at: number;
      }>(
        `SELECT a.* FROM attachments a JOIN threads t ON t.thread_id = a.thread_id
         WHERE t.disposition = 'active' AND a.inline = 0 AND (? IS NULL OR instr(lower(a.content_type), lower(?)) = 1) AND (? IS NULL OR a.from_address = ?) AND a.size >= ?
         ORDER BY a.received_at DESC LIMIT ?`,
        filter.contentTypePrefix ?? null,
        filter.contentTypePrefix ?? null,
        from,
        from,
        filter.minSize ?? 0,
        filter.limit ?? 100,
      )
      .map((a) => ({
        deliveryId: a.delivery_id,
        partId: a.part_id,
        threadId: a.thread_id,
        filename: a.filename,
        contentType: a.content_type,
        size: Number(a.size),
        from: a.from_address,
        receivedAt: Number(a.received_at),
      }));
  }

  // ------------------------------------------------------------ large-file links (E20)

  /** Active large-file grants (the mailbox's personal `/v1/grants`). */
  fileLinks(): ReadonlyArray<{
    readonly linkId: string;
    readonly uploadId: string;
    readonly filename: string;
    readonly expiresAt: number | null;
    readonly createdAt: number;
  }> {
    return this.sql
      .all<{
        link_id: string;
        upload_id: string;
        filename: string;
        expires_at: number | null;
        created_at: number;
      }>(
        "SELECT l.link_id, l.upload_id, u.filename, l.expires_at, l.created_at FROM file_links l JOIN uploads u ON u.upload_id = l.upload_id WHERE l.revoked_at IS NULL AND (l.expires_at IS NULL OR l.expires_at > ?) ORDER BY l.created_at DESC",
        this.ctx.now(),
      )
      .map((r) => ({
        linkId: r.link_id,
        uploadId: r.upload_id,
        filename: r.filename,
        expiresAt: r.expires_at === null ? null : Number(r.expires_at),
        createdAt: Number(r.created_at),
      }));
  }

  /** Unguessable, revocable, optionally expiring; not a public R2 URL. */
  createFileLink(
    uploadId: string,
    expiresAt?: number,
  ): { readonly linkId: string; readonly token: string } {
    const u = this.upload(uploadId) ?? reject("not_found", "upload");
    if (!isServableUpload(u)) reject("conflict", "upload not ready");
    const linkId = this.ctx.id("lnk");
    const secret = this.ctx.secret(24);
    this.sql.run(
      "INSERT INTO file_links (link_id, secret, upload_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?)",
      linkId,
      secret,
      uploadId,
      expiresAt ?? null,
      this.ctx.now(),
    );
    return { linkId, token: `${linkId}.${secret}` };
  }

  revokeFileLink(linkId: string): void {
    this.sql.run(
      "UPDATE file_links SET revoked_at = ? WHERE link_id = ? AND revoked_at IS NULL",
      this.ctx.now(),
      linkId,
    );
  }

  /** Checked on every request; revocation blocks new downloads. */
  resolveFileLink(
    token: string,
    now: number,
  ): {
    readonly blobKey: string;
    readonly filename: string;
    readonly contentType: string;
    readonly size: number;
  } | null {
    const [linkId, secret] = token.split(".");
    if (!linkId || !secret) return null;
    const l = this.sql.one<{
      secret: string;
      upload_id: string;
      expires_at: number | null;
      revoked_at: number | null;
    }>("SELECT * FROM file_links WHERE link_id = ?", linkId);
    if (
      !l ||
      !timingSafeEqual(l.secret, secret) ||
      l.revoked_at !== null ||
      (l.expires_at !== null && now >= Number(l.expires_at))
    )
      return null;
    const u = this.upload(l.upload_id);
    if (!u || !isServableUpload(u)) return null;
    return {
      blobKey: u.blobKey,
      filename: u.filename,
      contentType: u.contentType,
      size: u.actualSize ?? u.declaredSize,
    };
  }
}
