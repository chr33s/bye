import { describe, expect, it } from "vitest";
import { handleQueueMessage } from "../src/consumers.ts";
import { SCAN_MAX_ATTEMPTS } from "../src/scan.ts";
import { makeHarness } from "./harness.ts";

// Upload scanning through the (fake) isolated scanner container: pre-filter, verdicts, retries, fail closed.

const EICAR = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";
let n = 0;
const cmd = () => `cmd_${(++n).toString(36).padStart(20, "0")}`;

const upload = async (
  h: ReturnType<typeof makeHarness>,
  content: string | Uint8Array,
  filename = "report.pdf",
) => {
  const mailbox = h.namespaces.MAILBOXES.instance("mbx_scan");
  const size =
    typeof content === "string" ? new TextEncoder().encode(content).byteLength : content.byteLength;
  const reserved = mailbox.execute({
    _tag: "ReserveUpload",
    commandId: cmd(),
    filename,
    contentType: "application/pdf",
    declaredSize: size,
  } as never) as { ok: true; value: { uploadId: string; blobKey: string } };
  const { uploadId, blobKey } = reserved.value;
  await h.buckets.PARTS.put(blobKey, content, { customMetadata: { filename } });
  mailbox.execute({
    _tag: "CompleteUpload",
    commandId: cmd(),
    uploadId,
    actualSize: size,
  } as never);
  const store = (
    mailbox as unknown as { store: { uploads: { upload(id: string): { scanStatus: string } } } }
  ).store;
  return { uploadId, blobKey, status: () => store.uploads.upload(uploadId).scanStatus };
};

describe("upload scanning via the scanner container", () => {
  it("[E20] clean uploads are streamed to the scanner and marked clean", async () => {
    const h = makeHarness();
    const u = await upload(h, "%PDF-1.7 quarterly report");
    await h.drain();
    expect(h.scanner.scanned).toEqual(["%PDF-1.7 quarterly report"]);
    expect(u.status()).toBe("clean");
  });

  it("[E20] infected uploads (EICAR) are marked infected and cannot be sent", async () => {
    const h = makeHarness();
    const u = await upload(h, EICAR, "invoice.pdf");
    await h.drain();
    expect(u.status()).toBe("infected");
  });

  it("[E20] executables are rejected by the pre-filter without reaching the container", async () => {
    const h = makeHarness();
    const u = await upload(h, new Uint8Array([0x4d, 0x5a, 0x90, 0x00]), "invoice.pdf");
    const lnk = await upload(h, "shortcut", "open-me.lnk");
    await h.drain();
    expect(u.status()).toBe("failed");
    expect(lnk.status()).toBe("failed");
    expect(h.scanner.scanned).toEqual([]);
  });

  it("[E20] scanner errors and outages retry, then fail closed on the last attempt", async () => {
    const h = makeHarness();
    h.scanner.mode = "error";
    const u = await upload(h, "%PDF-1.7 body");
    await h.settle();
    const message = h.queues.PROPAGATE.messages
      .splice(0)
      .find((m) => JSON.stringify(m).includes('"scan"'));
    expect(message).toBeDefined();
    await expect(handleQueueMessage(h.env, message, 1)).rejects.toThrow(/scanner error/);
    expect(u.status()).toBe("pending");
    h.scanner.mode = "down";
    await expect(handleQueueMessage(h.env, message, 2)).rejects.toThrow(/unavailable/);
    await handleQueueMessage(h.env, message, SCAN_MAX_ATTEMPTS);
    expect(u.status()).toBe("failed");
    // A later successful redelivery can still clear a transient failure before the final attempt.
    const h2 = makeHarness();
    h2.scanner.mode = "error";
    const u2 = await upload(h2, "%PDF ok");
    await h2.settle();
    const m2 = h2.queues.PROPAGATE.messages
      .splice(0)
      .find((m) => JSON.stringify(m).includes('"scan"'));
    await expect(handleQueueMessage(h2.env, m2, 1)).rejects.toThrow();
    h2.scanner.mode = "clean";
    await handleQueueMessage(h2.env, m2, 2);
    expect(u2.status()).toBe("clean");
  });
});
