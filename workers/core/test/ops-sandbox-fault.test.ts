import { Effect, Exit } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ControlDirectory } from "@bye/platform-cloudflare";
import { kernelClock } from "../src/durable-host.ts";
import type { CoreEnv } from "../src/env.ts";
import { handleInbound, ingressFault } from "../src/inbound.ts";
import { buildTransportAdapters } from "../src/transports.ts";
import { inboundMessage, makeHarness, rfc822 } from "./harness.ts";

(globalThis as { FixedLengthStream?: unknown }).FixedLengthStream ??= class extends (
  TransformStream
) {
  constructor(_length: number) {
    super();
  }
};

const submission = (to: ReadonlyArray<string>) => ({
  sendJobId: "snd_1",
  identityId: "idn_1",
  from: "ana@bye.test",
  contentKey: "t/mbx/out/snd_1.eml",
  envelopeRecipients: to,
  trafficClass: "transactional" as const,
  bytes: 10,
});

describe("preview mail sandbox wiring (§15.8)", () => {
  /** Env with every transport configured, so all adapter kinds are built. */
  const envWith = (sandbox: string) => {
    const sent: Array<string> = [];
    const fetched: Array<string> = [];
    const env = {
      MAIL_SANDBOX_DOMAINS: sandbox,
      TRANSACTIONAL_EMAIL: {
        send: async (m: { to: string }) => (sent.push(m.to), { messageId: "cf-1" }),
      },
      ORIGINALS: { get: async () => ({ body: new Response("raw").body }) },
      MAIL_TRAFFIC_CLASSES: "transactional,personal,forwarding",
      FORWARDING_API_KEY: "fwd-key",
      FORWARDING_ENDPOINT: "https://forward.example.net/send",
      SRS_SECRET: "srs-secret",
      FORWARDING_DOMAIN: "fwd.bye.test",
      NEWSLETTER_API_KEY: "",
      EXTERNAL_IDENTITY_SEAL_KEY: "",
    } as unknown as CoreEnv;
    const fetchFn = (async (url: string | URL | Request) => {
      fetched.push(String(url instanceof Request ? url.url : url));
      return Response.json({ id: "provider-1" }, { status: 202 });
    }) as typeof fetch;
    return { env, sent, fetched, fetchFn };
  };

  it("[E18] every adapter is wrapped and refuses recipients outside the preview's domains", async () => {
    const { env, sent, fetched, fetchFn } = envWith("preview-7.bye.test");
    const adapters = await buildTransportAdapters(env, "mbx_1", fetchFn);
    // Transactional, personal (Cloudflare) and sealed-forwarding transports are all configured.
    expect(adapters.map((a) => a.capabilities.name)).toHaveLength(3);
    for (const a of adapters) {
      expect(a.capabilities.name).toMatch(/^sandbox\(/);
      const outside = await Effect.runPromiseExit(
        a.submit(submission(["qa@preview-7.bye.test", "someone@gmail.com"])),
      );
      expect(Exit.isFailure(outside)).toBe(true);
      expect(JSON.stringify(outside)).toMatch(/sandbox: 1 recipient\(s\) outside/);
    }
    // No provider saw any of the refused submissions.
    expect(sent).toEqual([]);
    expect(fetched).toEqual([]);
    // Allowed recipients pass the sandbox and reach each inner transport.
    for (const a of adapters) {
      const before = sent.length + fetched.length;
      const inside = await Effect.runPromiseExit(a.submit(submission(["qa@preview-7.bye.test"])));
      expect(JSON.stringify(inside)).not.toMatch(/sandbox:/);
      expect(sent.length + fetched.length, a.capabilities.name).toBeGreaterThan(before);
    }
    // Transactional and personal both reach the Cloudflare binding.
    expect(sent).toEqual(["qa@preview-7.bye.test", "qa@preview-7.bye.test"]);
  });

  it("[E18] outside previews (empty setting) adapters are not wrapped", async () => {
    const { env, fetchFn } = envWith("");
    const adapters = await buildTransportAdapters(env, "mbx_1", fetchFn);
    expect(adapters).toHaveLength(3);
    for (const a of adapters) expect(a.capabilities.name).not.toMatch(/^sandbox\(/);
  });

  it("personal mail uses the Cloudflare binding only when the stage enables the class", async () => {
    const { env, fetchFn } = envWith("");
    const names = async () =>
      (await buildTransportAdapters(env, "mbx_1", fetchFn)).map((a) => a.capabilities.name);
    expect(await names()).toContain("cloudflare-personal");
    for (const classes of ["", "transactional", "transactional,forwarding"]) {
      (env as { MAIL_TRAFFIC_CLASSES: string }).MAIL_TRAFFIC_CLASSES = classes;
      expect(await names(), classes).not.toContain("cloudflare-personal");
    }
  });
});

describe("staging-only ingress fault injection (§14.2 evidence)", () => {
  let h: ReturnType<typeof makeHarness>;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2026, 8, 25, 12));
    h = makeHarness();
  });
  afterEach(() => vi.useRealTimers());

  const provision = () =>
    new ControlDirectory(h.env.DIRECTORY, kernelClock).provisionPersonalAccount({
      address: "ana@bye.test",
      displayName: "Ana",
    });
  const mail = (to: string) =>
    inboundMessage(
      "x@example.net",
      to,
      rfc822({
        from: "x@example.net",
        to,
        subject: "s",
        body: "b",
        messageId: `${to}-${Math.random()}@x`,
      }),
    );

  it("[O01] only opted-in +fault recipients are affected, and only when configured", () => {
    expect(ingressFault({ BYE_FAULT_INGRESS: "" }, "ana+fault@bye.test")).toBeNull();
    expect(ingressFault({ BYE_FAULT_INGRESS: "throw" }, "ana@bye.test")).toBeNull();
    expect(ingressFault({ BYE_FAULT_INGRESS: "bogus" }, "ana+fault@bye.test")).toBeNull();
    expect(ingressFault({ BYE_FAULT_INGRESS: "r2" }, "ANA+FAULT@bye.test")).toBe("r2");
  });

  it("[O01] throw fails before any receipt; r2 fails after the receipt with no original stored", async () => {
    await provision();
    (h.env as { BYE_FAULT_INGRESS: string }).BYE_FAULT_INGRESS = "throw";
    await expect(handleInbound(mail("ana+fault@bye.test"), h.env)).rejects.toThrow(
      "fault injection",
    );
    expect(h.buckets.ORIGINALS.objects.size).toBe(0);

    (h.env as { BYE_FAULT_INGRESS: string }).BYE_FAULT_INGRESS = "r2";
    await expect(handleInbound(mail("ana+fault@bye.test"), h.env)).rejects.toThrow(
      "storage unavailable",
    );
    expect(h.buckets.ORIGINALS.objects.size).toBe(0);

    // Ordinary recipients are never affected, even while fault injection is configured.
    const ok = await handleInbound(mail("ana@bye.test"), h.env);
    expect(ok._tag).toBe("Accepted");
    expect(h.buckets.ORIGINALS.objects.size).toBe(1);
  });
});
