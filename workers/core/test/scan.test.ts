import { Predicate } from "effect";
import { describe, expect, it } from "vitest";
import { handleQueueMessage } from "../src/consumers.ts";
import { SCAN_MAX_ATTEMPTS, ScannerContainer, SIGMIRROR_HOST } from "../src/scan.ts";
import { makeHarness, mockAs } from "./harness.ts";

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

  const size = Predicate.isString(content)
    ? new TextEncoder().encode(content).byteLength
    : content.byteLength;

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

  const view: { store: { uploads: { upload(id: string): { scanStatus: string } } } } =
    mockAs(mailbox);

  const store = view.store;

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
    await expect(handleQueueMessage(h.env, message!, 1)).rejects.toThrow(/scanner error/);
    expect(u.status()).toBe("pending");
    h.scanner.mode = "down";
    await expect(handleQueueMessage(h.env, message!, 2)).rejects.toThrow(/unavailable/);
    await handleQueueMessage(h.env, message!, SCAN_MAX_ATTEMPTS);
    expect(u.status()).toBe("failed");
    // A later successful redelivery can still clear a transient failure before the final attempt.
    const h2 = makeHarness();
    h2.scanner.mode = "error";
    const u2 = await upload(h2, "%PDF ok");
    await h2.settle();

    const m2 = h2.queues.PROPAGATE.messages
      .splice(0)
      .find((m) => JSON.stringify(m).includes('"scan"'));

    await expect(handleQueueMessage(h2.env, m2!, 1)).rejects.toThrow();
    h2.scanner.mode = "clean";
    await handleQueueMessage(h2.env, m2!, 2);
    expect(u2.status()).toBe("clean");
  });
});

describe("scanner container egress", () => {
  const start = async (env: { SIGMIRROR?: { fetch: () => Promise<Response> } }) => {
    const started: Array<{ enableInternet?: boolean; env?: Record<string, string> }> = [];
    const intercepted: Array<string> = [];
    let running = false;

    const container = {
      get running() {
        return running;
      },
      start: (options: { enableInternet?: boolean; env?: Record<string, string> }) => {
        started.push(options);
        running = true;
      },
      interceptOutboundHttp: async (host: string) => void intercepted.push(host),
      setInactivityTimeout: async () => undefined,
      getTcpPort: () => ({ fetch: async () => new Response("{}") }),
    };

    const scanner = new ScannerContainer({ container } as never, env as never);
    await scanner.fetch(new Request("http://scanner/scan", { method: "POST", body: "x" }));

    return { started, intercepted };
  };

  it("[E20] the scanner starts with internet disabled, with or without the signature mirror", async () => {
    const mirror = { fetch: async () => new Response("ok") };

    for (const env of [{}, { SIGMIRROR: mirror }]) {
      const { started } = await start(env);
      expect(started).toHaveLength(1);
      // Strictly false: an omitted flag would fall back to the platform default (egress allowed).
      expect(started[0]!.enableInternet).toBe(false);
    }
  });

  it("[E20] signatures come only through the intercepted mirror host, never a real one", async () => {
    const mirror = { fetch: async () => new Response("ok") };
    const withMirror = await start({ SIGMIRROR: mirror });
    expect(withMirror.intercepted).toEqual([SIGMIRROR_HOST]);
    expect(withMirror.started[0]!.env).toEqual({
      SIGNATURE_MIRROR_URL: `http://${SIGMIRROR_HOST}`,
    });
    expect(SIGMIRROR_HOST).toMatch(/\.internal$/);
    expect((await start({})).intercepted).toEqual([]);
  });
});
