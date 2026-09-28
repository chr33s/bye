// DKIM signing (RFC 6376 relaxed/relaxed) checked by an independent verifier written here, so the
// signer and the check don't share canonicalization code.
import { Predicate } from "effect";
import { describe, expect, it } from "vitest";
import { dkimSign, DKIM_SIGNED_HEADERS, fromDomain, importDkimKey } from "@bye/platform-cloudflare";

type Key = Awaited<ReturnType<typeof crypto.subtle.importKey>>;

type KeyPair = { readonly privateKey: Key; readonly publicKey: Key };

const enc = new TextEncoder();

const b64 = (b: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(b)));

const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

const pem = (der: ArrayBuffer, label: string) =>
  `-----BEGIN ${label}-----\n${b64(der).replace(/(.{64})/g, "$1\n")}\n-----END ${label}-----\n`;

const rsaPair = async () =>
  (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as KeyPair;

// ---- independent verifier (RFC 6376 §3.4.2, §3.4.4, §3.7) ----
const canonBody = (body: string) => {
  let lines = body.split("\r\n").map((l) => l.replace(/[ \t]+/g, " ").replace(/ $/, ""));

  while (lines.length && lines[lines.length - 1] === "") lines = lines.slice(0, -1);

  return lines.length ? lines.join("\r\n") + "\r\n" : "";
};

const canonHeader = (line: string) => {
  const i = line.indexOf(":");
  const name = line.slice(0, i).toLowerCase().trim();

  const value = line
    .slice(i + 1)
    .replace(/\r\n([ \t])/g, "$1")
    .replace(/[ \t]+/g, " ")
    .trim();

  return `${name}:${value}`;
};

const verify = async (message: string, publicKey: Key): Promise<string> => {
  const split = message.indexOf("\r\n\r\n");
  const head = message.slice(0, split);
  const body = message.slice(split + 4);
  const fields = head.split(/\r\n(?![ \t])/);
  const sigField = fields.find((f) => /^dkim-signature:/i.test(f))!;

  const tags = Object.fromEntries(
    sigField
      .slice(sigField.indexOf(":") + 1)
      .replace(/\s+/g, "")
      .split(";")
      .filter(Boolean)
      .map((t) => [t.slice(0, t.indexOf("=")), t.slice(t.indexOf("=") + 1)]),
  );

  const bh = b64(await crypto.subtle.digest("SHA-256", enc.encode(canonBody(body))));

  if (bh !== tags.bh) return "body hash mismatch";
  const others = fields.filter((f) => f !== sigField);
  const used = new Map<string, number>();
  let data = "";

  for (const h of tags.h!.split(":")) {
    const matches = others.filter((f) => f.toLowerCase().startsWith(`${h}:`));
    const n = used.get(h) ?? 0;
    used.set(h, n + 1);
    const pick = matches[matches.length - 1 - n];

    if (pick) data += canonHeader(pick) + "\r\n";
  }

  data += canonHeader(sigField.replace(/b=[^;]*$/, "b="));

  const ok = await crypto.subtle.verify(
    { name: "RSASSA-PKCS1-v1_5" },
    publicKey,
    unb64(tags.b!),
    enc.encode(data),
  );

  return ok ? "pass" : "signature mismatch";
};

const MESSAGE = [
  "From: Ana Example <ana@Example.org>",
  "To: bob@x.test,",
  "  carol@x.test",
  "Subject:   Lunch   plans ",
  "Date: Mon, 1 Sep 2026 10:00:00 +0000",
  "Message-ID: <m1@example.org>",
  "MIME-Version: 1.0",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "Noon  at the usual place?  ",
  "",
  "",
].join("\n"); // bare LF on purpose: the signer normalizes to CRLF

describe("DKIM signing", () => {
  it("signs relaxed/relaxed with d=<From domain>, s=bye1, and an independent verifier passes", async () => {
    const pair = await rsaPair();

    const key = await importDkimKey(
      pem(await crypto.subtle.exportKey("pkcs8", pair.privateKey), "PRIVATE KEY"),
      "bye1",
    );

    const r = await dkimSign(enc.encode(MESSAGE), key, 1_790_000_000_000);
    expect(r._tag).toBe("Signed");

    if (!Predicate.isTagged(r, "Signed")) return;
    const signed = new TextDecoder().decode(r.raw);
    expect(r.domain).toBe("example.org");
    expect(signed).toMatch(
      /^DKIM-Signature: v=1; a=rsa-sha256; c=relaxed\/relaxed; d=example\.org; s=bye1; t=1790000000; h=from:to:subject:mime-version:content-type; bh=/,
    );
    expect(signed).not.toMatch(/[^\r]\n/); // CRLF throughout
    expect(await verify(signed, pair.publicKey)).toBe("pass");
    // Headers the sending service rewrites are unsigned, so changing them keeps the signature valid.
    expect(
      await verify(
        signed.replace("Message-ID: <m1@example.org>", "Message-ID: <cf@x>"),
        pair.publicKey,
      ),
    ).toBe("pass");
    // Whitespace-only changes survive relaxed canonicalization.
    expect(await verify(signed.replace("Subject:   Lunch", "Subject: Lunch"), pair.publicKey)).toBe(
      "pass",
    );
    // Real changes don't.
    expect(await verify(signed.replace("Lunch", "Dinner"), pair.publicKey)).toBe(
      "signature mismatch",
    );
    expect(await verify(signed.replace("Noon", "Nine"), pair.publicKey)).toBe("body hash mismatch");
  });

  it("is deterministic for RSA and hashes an empty body to the RFC value", async () => {
    const pair = await rsaPair();
    const key = { algorithm: "rsa-sha256" as const, selector: "bye1", key: pair.privateKey };
    const a = await dkimSign(enc.encode(MESSAGE), key, 1_790_000_000_000);
    const b = await dkimSign(enc.encode(MESSAGE), key, 1_790_000_000_000);
    expect(a).toEqual(b);
    const empty = await dkimSign(enc.encode("From: a@example.org\r\n\r\n"), key, 0);
    // SHA-256 of the empty string (relaxed canonical form of an empty body).
    expect(new TextDecoder().decode((empty as { raw: Uint8Array }).raw)).toContain(
      "bh=47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=;",
    );
  });

  it("accepts Ed25519 keys (RFC 8463) and refuses messages it can't attribute", async () => {
    const generated: unknown = await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
      "sign",
      "verify",
    ]);

    const pair = generated as KeyPair;

    const key = await importDkimKey(
      pem(await crypto.subtle.exportKey("pkcs8", pair.privateKey), "PRIVATE KEY"),
      "bye1",
    );

    expect(key.algorithm).toBe("ed25519-sha256");
    const r = await dkimSign(enc.encode(MESSAGE), key);
    expect(new TextDecoder().decode((r as { raw: Uint8Array }).raw)).toMatch(
      /^DKIM-Signature: v=1; a=ed25519-sha256;/,
    );
    expect((await dkimSign(enc.encode("To: b@x.test\r\n\r\nhi"), key))._tag).toBe("Unsigned");
    expect((await dkimSign(enc.encode("From: a@x.org\r\nFrom: b@y.org\r\n\r\nhi"), key))._tag).toBe(
      "Unsigned",
    );
  });

  it("finds the From domain and signs only headers the sender does not rewrite", () => {
    expect(fromDomain(' "Ana, X" <ana@Mail.Example.org>')).toBe("mail.example.org");
    expect(fromDomain(" ana@example.org")).toBe("example.org");
    expect(fromDomain(" undisclosed")).toBeNull();

    for (const h of ["date", "message-id", "return-path"])
      expect(DKIM_SIGNED_HEADERS as ReadonlyArray<string>).not.toContain(h);
  });
});
