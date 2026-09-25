import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";
import {
  arcChainShape,
  arcInstanceCount,
  arcSeal,
  arcSigningData,
  bodyHash,
  LOOP_HEADER,
  makeExternalIdentityApiTransport,
  makeSealedForwardingTransport,
  MAX_FORWARD_HOPS,
  prepareForward,
  relaxedBody,
  relaxedHeader,
  splitMessage,
  srsForward,
  srsReverse,
  trustedResults,
  type ArcSigner,
  type ExternalCredential,
} from "@bye/platform-cloudflare";

type Key = Awaited<ReturnType<typeof crypto.subtle.importKey>>;
const DAY = 86_400_000;
const srs = { secret: "test-srs-secret", domain: "fwd.bye.test" };

describe("SRS (sender rewriting)", () => {
  it("[E22] SRS0 round-trips and verifies its hash case-insensitively", async () => {
    const now = Date.UTC(2026, 8, 25);
    const rewritten = await srsForward(srs, "alice@example.com", now);
    expect(rewritten).toMatch(
      /^SRS0=[A-Za-z0-9+/]{4}=[A-Z2-7]{2}=example\.com=alice@fwd\.bye\.test$/,
    );
    expect(await srsReverse(srs, rewritten, now + 3 * DAY)).toEqual({
      _tag: "Ok",
      address: "alice@example.com",
    });
    expect(
      await srsReverse(srs, rewritten.toLowerCase().replace("@fwd.bye.test", "@FWD.bye.test"), now),
    ).toMatchObject({ _tag: "Ok" });
  });

  it("[E22] tampered, expired, foreign and malformed bounce addresses never reverse (no open relay)", async () => {
    const now = Date.UTC(2026, 8, 25);
    const rewritten = await srsForward(srs, "alice@example.com", now);
    expect((await srsReverse(srs, rewritten.replace("alice", "mallory"), now))._tag).toBe(
      "Invalid",
    );
    expect(await srsReverse(srs, rewritten, now + 30 * DAY)).toEqual({
      _tag: "Invalid",
      reason: "expired",
    });
    expect(await srsReverse({ ...srs, secret: "other" }, rewritten, now)).toEqual({
      _tag: "Invalid",
      reason: "bad-hash",
    });
    expect(await srsReverse(srs, "bob@fwd.bye.test", now)).toEqual({
      _tag: "Invalid",
      reason: "not-srs",
    });
    expect(await srsReverse(srs, rewritten.replace("fwd.bye.test", "other.test"), now)).toEqual({
      _tag: "Invalid",
      reason: "not-srs",
    });
  });

  it("[E22] re-forwarding an SRS0 address yields SRS1 that reverses to the previous hop", async () => {
    const now = Date.UTC(2026, 8, 25);
    const first = await srsForward({ secret: "a", domain: "hop1.test" }, "alice@example.com", now);
    const second = await srsForward(srs, first, now);
    expect(second).toMatch(/^SRS1=[^=]+=hop1\.test==[^@]+@fwd\.bye\.test$/);
    expect(await srsReverse(srs, second, now)).toEqual({ _tag: "Ok", address: first });
    expect(await srsForward(srs, "", now)).toBe("");
  });
});

const signer = async (): Promise<{ signer: ArcSigner; publicKey: Key }> => {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as unknown as { publicKey: Key; privateKey: Key };
  return {
    signer: {
      algorithm: "ed25519-sha256",
      domain: "fwd.bye.test",
      selector: "arc2026",
      key: pair.privateKey,
    },
    publicKey: pair.publicKey,
  };
};

const verifyEd = async (publicKey: Key, sigB64: string, data: string) =>
  crypto.subtle.verify(
    { name: "Ed25519" },
    publicKey,
    Uint8Array.from(atob(sigB64), (c) => c.charCodeAt(0)),
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(data))),
  );

const MSG =
  "Authentication-Results: mx.cloudflare.net; spf=pass; dkim=pass; dmarc=pass; arc=none\r\nFrom: Alice <alice@example.com>\r\nTo: bob@bye.test\r\nSubject: Hello\r\nReturn-Path: <alice@example.com>\r\n\r\nHi Bob  \r\n\r\n\r\n";

describe("ARC sealing (RFC 8617, RFC 6376 relaxed, RFC 8463)", () => {
  it("[E22] relaxed canonicalization matches RFC 6376 §3.4.5", () => {
    expect(relaxedHeader("A", " X") + relaxedHeader("B ", " Y\t\r\n\tZ  ")).toBe(
      "a:X\r\nb:Y Z\r\n",
    );
    expect(relaxedBody(" C \r\nD \t E\r\n\r\n\r\n")).toBe(" C\r\nD E\r\n");
    expect(relaxedBody("")).toBe("");
  });

  it("[E22] seals i=1 with cv=none and signatures that verify with the public key", async () => {
    const { signer: s, publicKey } = await signer();
    const sealed = await arcSeal({
      raw: MSG,
      signer: s,
      authResults: "mx.bye.test; spf=pass; dkim=pass",
      priorChain: "none",
      now: 1_790_000_000_000,
    });
    if (sealed._tag !== "Sealed") throw new Error("expected sealed");
    const { headers, body } = splitMessage(sealed.raw);
    expect(arcInstanceCount(headers)).toBe(1);
    const as = headers.find(([n]) => n === "ARC-Seal")![1];
    const ams = headers.find(([n]) => n === "ARC-Message-Signature")![1];
    const aar = headers.find(([n]) => n === "ARC-Authentication-Results")![1];
    expect(as).toMatch(/cv=none/);
    expect(ams).toContain(`bh=${await bodyHash(body)}`);
    // Verify AMS over the signed headers + AMS with empty b=.
    const h = /h=([^;]+);/.exec(ams)![1]!.split(":");
    const amsNoB = ams.replace(/b=[^;]*$/, "b=");
    const original = splitMessage(MSG).headers;
    expect(
      await verifyEd(
        publicKey,
        /b=([^;]*)$/.exec(ams)![1]!,
        arcSigningData.signingInput(original, h, "ARC-Message-Signature", amsNoB),
      ),
    ).toBe(true);
    // Verify AS over AAR, AMS and AS(b=).
    const asNoB = as.replace(/b=[^;]*$/, "b=");
    const sealData =
      relaxedHeader("ARC-Authentication-Results", aar) +
      relaxedHeader("ARC-Message-Signature", ams) +
      relaxedHeader("ARC-Seal", asNoB).replace(/\r\n$/, "");
    expect(await verifyEd(publicKey, /b=([^;]*)$/.exec(as)![1]!, sealData)).toBe(true);
    // A modified body breaks the body hash.
    expect(await bodyHash(`${body}tampered`)).not.toBe(/bh=([^;]+);/.exec(ams)![1]);
  });

  it("[E22] later instances report cv from our MX's ARC verdict and the chain stops at 50", async () => {
    const { signer: s } = await signer();
    const one = await arcSeal({
      raw: MSG,
      signer: s,
      authResults: "mx.bye.test; arc=none",
      priorChain: "none",
    });
    const two = await arcSeal({
      raw: (one as { raw: string }).raw,
      signer: s,
      authResults: "mx.bye.test; arc=pass",
      priorChain: "pass",
    });
    expect(two).toMatchObject({ _tag: "Sealed", instance: 2 });
    expect(
      splitMessage((two as { raw: string }).raw).headers.find(([n]) => n === "ARC-Seal")![1],
    ).toMatch(/i=2;.*cv=pass/);
    const failed = await arcSeal({
      raw: (one as { raw: string }).raw,
      signer: s,
      authResults: "mx.bye.test; arc=fail",
      priorChain: "fail",
    });
    expect(
      splitMessage((failed as { raw: string }).raw).headers.find(([n]) => n === "ARC-Seal")![1],
    ).toMatch(/cv=fail/);
    // A genuine, contiguous 50-set chain is a loop.
    let chain = MSG;
    for (let i = 1; i <= 50; i++) {
      const sealed = await arcSeal({ raw: chain, signer: s, authResults: "x", priorChain: "pass" });
      if (sealed._tag !== "Sealed") throw new Error(`expected sealed at ${i}`);
      chain = sealed.raw;
    }
    expect(
      (await arcSeal({ raw: chain, signer: s, authResults: "x", priorChain: "pass" }))._tag,
    ).toBe("LoopLimit");
  });

  it("[E22] a planted high ARC instance is a broken chain (cv=fail), not a forced loop rejection", async () => {
    const { signer: s } = await signer();
    for (const planted of [
      `ARC-Seal: i=50; a=ed25519-sha256; cv=pass; d=x; s=y; b=z\r\n${MSG}`,
      `ARC-Seal: i=9999; a=ed25519-sha256; cv=pass; d=x; s=y; b=z\r\n${MSG}`,
      // Gap: i=1 and i=3 without i=2.
      `ARC-Seal: i=3; cv=pass; b=z\r\nARC-Message-Signature: i=3; b=z\r\nARC-Authentication-Results: i=3; x\r\nARC-Seal: i=1; cv=none; b=z\r\nARC-Message-Signature: i=1; b=z\r\nARC-Authentication-Results: i=1; x\r\n${MSG}`,
    ]) {
      const sealed = await arcSeal({
        raw: planted,
        signer: s,
        authResults: "x",
        priorChain: "pass",
      });
      expect(sealed._tag).toBe("Sealed");
      const as = splitMessage((sealed as { raw: string }).raw).headers[0]!;
      expect(as[0]).toBe("ARC-Seal");
      expect(as[1]).toMatch(/cv=fail/);
    }
    expect(arcChainShape(splitMessage(MSG).headers)).toEqual({ _tag: "None" });
  });

  it("[E22] only the topmost Authentication-Results (our MX) is trusted; forged lower ones are ignored", () => {
    const forged = splitMessage(
      "Authentication-Results: mx.cloudflare.net; spf=fail; dkim=fail; arc=fail\r\nAuthentication-Results: mx.cloudflare.net; spf=pass; arc=pass\r\nFrom: a@b.test\r\n\r\nx",
    ).headers;
    expect(trustedResults(forged)).toMatchObject({ arc: "fail" });
    expect(trustedResults(forged).results).toContain("spf=fail");
    // Sender-supplied header below a foreign top header: untrusted, defaults to cv=fail.
    const spoof = splitMessage(
      "Authentication-Results: other.example; spf=none\r\nAuthentication-Results: mx.cloudflare.net; arc=pass\r\n\r\nx",
    ).headers;
    expect(trustedResults(spoof)).toEqual({ results: "none", arc: "fail" });
    expect(trustedResults(splitMessage("From: a@b.test\r\n\r\nx").headers).arc).toBe("fail");
  });
});

describe("ForwardingTransport", () => {
  it("[E22] forwards the original with an SRS envelope, loop marker and ARC set", async () => {
    const { signer: s } = await signer();
    const calls: Array<{ body: { from: string; raw: string } }> = [];
    const adapter = makeSealedForwardingTransport(
      {
        endpoint: "https://fwd.provider.test/send",
        apiKey: "k",
        srs,
        signer: s,
        authservId: "mx.bye.test",
      },
      { load: async () => MSG },
      async (_u, init) => {
        const json = JSON.parse(String(init.body)) as { from: string; raw: string };
        calls.push({ body: { ...json, raw: atob(json.raw) } });
        return { status: 202, json: async () => ({ id: "p1" }), text: async () => "" };
      },
    );
    const exit = await Effect.runPromiseExit(
      adapter.submit({
        sendJobId: "snd_1",
        identityId: "forwarding",
        from: "bob@bye.test",
        contentKey: "k",
        envelopeRecipients: ["bob@elsewhere.test"],
        trafficClass: "forwarding",
        bytes: 100,
      }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(calls[0]!.body.from).toMatch(/^SRS0=.+=example\.com=alice@fwd\.bye\.test$/);
    expect(calls[0]!.body.raw).toMatch(/^ARC-Seal:/);
    expect(calls[0]!.body.raw).toContain(`${LOOP_HEADER}: fwd.bye.test`);
    expect(calls[0]!.body.raw).toContain("From: Alice <alice@example.com>");
  });

  it("[E22] 8-bit message bytes are forwarded byte-for-byte (no UTF-8 decode)", async () => {
    const head = new TextEncoder().encode(
      "From: a@example.com\r\nContent-Transfer-Encoding: 8bit\r\n\r\ncaf",
    );
    const original = new Uint8Array([...head, 0xe9, 0xff, 0x0d, 0x0a]);
    const prepared = await prepareForward(
      { endpoint: "", apiKey: "", srs, signer: null, authservId: "mx" },
      original,
      "bob@bye.test",
    );
    if (prepared._tag !== "Ready") throw new Error("expected ready");
    expect(prepared.raw.slice(prepared.raw.length - original.length)).toEqual(original);
  });

  it("[E22] refuses a message that already looped through us too many times", async () => {
    const looped = `${`${LOOP_HEADER}: fwd.bye.test\r\n`.repeat(MAX_FORWARD_HOPS)}${MSG}`;
    expect(
      await prepareForward(
        { endpoint: "", apiKey: "", srs, signer: null, authservId: "mx" },
        looped,
        "bob@bye.test",
      ),
    ).toMatchObject({ _tag: "Loop" });
  });
});

describe("ExternalIdentityTransport", () => {
  const submission = {
    sendJobId: "snd_9",
    identityId: "idn_1",
    from: "me@gmail.test",
    contentKey: "k",
    envelopeRecipients: ["x@y.test"],
    trafficClass: "external-identity" as const,
    bytes: 10,
  };

  it("[E19] sends through the Gmail API, refreshing an expired token first and persisting it", async () => {
    let stored: ExternalCredential = {
      provider: "gmail",
      accessToken: "old",
      refreshToken: "r",
      tokenEndpoint: "https://oauth.test/token",
      clientId: "c",
      expiresAt: 0,
    };
    const calls: Array<string> = [];
    const adapter = makeExternalIdentityApiTransport(
      { resolve: async () => stored, persist: async (_f, c) => void (stored = c) },
      { load: async () => "From: me@gmail.test\r\n\r\nhi" },
      async (url, init) => {
        calls.push(url);
        if (url.startsWith("https://oauth.test"))
          return {
            status: 200,
            json: async () => ({ access_token: "new", expires_in: 3600 }),
            text: async () => "",
          };
        expect(init.headers.authorization).toBe("Bearer new");
        expect(JSON.parse(String(init.body)).raw).toBe(
          btoa("From: me@gmail.test\r\n\r\nhi")
            .replace(/\+/g, "-")
            .replace(/\//g, "_")
            .replace(/=+$/, ""),
        );
        return { status: 200, json: async () => ({ id: "gm-1" }), text: async () => "" };
      },
    );
    const result = await Effect.runPromise(adapter.submit(submission));
    expect(result.providerId).toBe("gm-1");
    expect(stored.accessToken).toBe("new");
    expect(calls).toEqual([
      "https://oauth.test/token",
      "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
    ]);
  });

  it("[E19] no credential is a clear rejection; a network error after submit is Unknown, not retried", async () => {
    const none = makeExternalIdentityApiTransport(
      { resolve: async () => null, persist: async () => undefined },
      { load: async () => "x" },
      async () => ({ status: 200, json: async () => ({}), text: async () => "" }),
    );
    const e1 = await Effect.runPromiseExit(none.submit(submission));
    expect(JSON.stringify(e1)).toContain("no authorized credential");
    const flaky = makeExternalIdentityApiTransport(
      {
        resolve: async () => ({
          provider: "graph",
          accessToken: "t",
          expiresAt: Date.now() + 3_600_000,
        }),
        persist: async () => undefined,
      },
      { load: async () => "x" },
      async () => {
        throw new Error("reset");
      },
    );
    const e2 = await Effect.runPromiseExit(flaky.submit(submission));
    expect(JSON.stringify(e2)).toContain("Unknown");
  });

  it("[E19] concurrent sends for one identity share a single OAuth refresh; requests carry a timeout", async () => {
    let stored: ExternalCredential = {
      provider: "graph",
      accessToken: "old",
      refreshToken: "r1",
      tokenEndpoint: "https://oauth.test/token",
      clientId: "c",
      expiresAt: 0,
    };
    let refreshes = 0;
    let persists = 0;
    const signals: Array<AbortSignal | undefined> = [];
    const adapter = makeExternalIdentityApiTransport(
      { resolve: async () => stored, persist: async (_f, c) => void (persists++, (stored = c)) },
      { load: async () => "From: me@gmail.test\r\n\r\nhi" },
      async (url, init) => {
        signals.push(init.signal);
        if (url.startsWith("https://oauth.test")) {
          refreshes++;
          await new Promise((r) => setTimeout(r, 10));
          return {
            status: 200,
            json: async () => ({ access_token: "new", refresh_token: "r2", expires_in: 3600 }),
            text: async () => "",
          };
        }
        return { status: 202, json: async () => ({}), text: async () => "" };
      },
    );
    await Promise.all([
      Effect.runPromise(adapter.submit(submission)),
      Effect.runPromise(adapter.submit(submission)),
      Effect.runPromise(adapter.submit(submission)),
    ]);
    expect(refreshes).toBe(1);
    expect(persists).toBe(1);
    expect(stored.refreshToken).toBe("r2");
    expect(signals.every((s) => s instanceof AbortSignal)).toBe(true);
  });
});
