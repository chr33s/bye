import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseAddressList, parseMessage, summarizeMessage } from "@bye/mail-codec";

const enc = (s: string) => new TextEncoder().encode(s.replace(/\r?\n/g, "\r\n"));
const fixture = (name: string) =>
  new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
const bin = (b: Uint8Array) => Array.from(b, (x) => String.fromCharCode(x)).join("");

describe("parseMessage", () => {
  it("[E20] decodes mixed encodings, groups, related CID parts, nested messages and RFC 2231 filenames", () => {
    const parsed = parseMessage(fixture("nested.eml"));
    expect(parsed.subject).toBe("Café ☕ menu");
    expect(parsed.from).toEqual([{ name: "Doe, Jane", address: "jane@example.com" }]);
    expect(parsed.to).toEqual([]);
    expect(parsed.cc.map((a) => a.address)).toEqual([
      "a@example.com",
      "b@example.com",
      "c@example.com",
    ]);
    expect(parsed.cc[1]?.name).toBe("B (x)");
    expect(parsed.date).toBe(Date.UTC(2026, 8, 25, 10, 0, 0));
    expect(parsed.html).toContain("café");
    const names = parsed.attachments.map((a) => a.filename);
    expect(names).toContain("résumé.pdf");
    expect(names).toContain("Forwarded thing.eml");
    const logo = parsed.attachments.find((a) => a.contentId === "logo@x");
    expect(logo?.inline).toBe(true);
    expect(logo?.contentType).toBe("image/png");
    // The nested message is an attachment, not merged into the outer body.
    expect(parsed.text).toBeUndefined();
    expect(parsed.warnings).toEqual([]);
    const summary = summarizeMessage(parsed, 0);
    expect(summary.attachments.map((a) => a.filename)).not.toContain(logo?.filename);
    expect(summary.snippet).toBe("Hello café");
  });

  it("[E20] preserves signed entities and signature parts byte-for-byte", () => {
    const raw = fixture("signed.eml");
    const parsed = parseMessage(raw);
    expect(parsed.text?.trim()).toBe("Signed body text.");
    const sig = parsed.parts.find((p) => p.contentType === "application/pkcs7-signature");
    expect(sig?.opaque).toBe(true);
    expect(Array.from(sig!.content)).toEqual([0, 1, 2, 3, 4, 5]);
    const signed = parsed.parts.find((p) => p.partId === "1.signed");
    expect(signed?.opaque).toBe(true);
    const signedText = bin(signed!.content);
    expect(signedText).toBe("Content-Type: text/plain; charset=utf-8\n\nSigned body text.");
    expect(parsed.attachments.map((a) => a.filename)).toEqual(["smime.p7s"]);
  });

  it("[E20] treats multipart/encrypted children as opaque", () => {
    const parsed = parseMessage(
      enc(`Content-Type: multipart/encrypted; protocol="application/pgp-encrypted"; boundary=e

--e
Content-Type: application/pgp-encrypted

Version: 1
--e
Content-Type: application/octet-stream

-----BEGIN PGP MESSAGE-----
--e--
`),
    );
    expect(parsed.parts).toHaveLength(2);
    expect(parsed.parts.every((p) => p.opaque)).toBe(true);
    expect(parsed.attachments).toHaveLength(2);
  });

  it("recovers from a missing closing boundary with a warning", () => {
    const parsed = parseMessage(
      enc(`Subject: broken
Content-Type: multipart/alternative; boundary=b

--b
Content-Type: text/plain

still readable
`),
    );
    expect(parsed.text?.trim()).toBe("still readable");
    expect(parsed.warnings).toContainEqual({ _tag: "MalformedBoundary", partId: "" });
  });

  it("falls back to text when the boundary never appears", () => {
    const parsed = parseMessage(enc(`Content-Type: multipart/mixed; boundary=zzz\n\nplain body`));
    expect(parsed.text).toBe("plain body");
    expect(parsed.warnings.some((w) => w._tag === "MalformedBoundary")).toBe(true);
  });

  it("does not confuse a boundary that is a prefix of a longer delimiter", () => {
    const parsed = parseMessage(
      enc(`Content-Type: multipart/mixed; boundary=b

--b
Content-Type: multipart/alternative; boundary=b-inner

--b-inner
Content-Type: text/plain

inner text
--b-inner--
--b--
`),
    );
    expect(parsed.text?.trim()).toBe("inner text");
    expect(parsed.warnings).toEqual([]);
  });

  it("keeps long References chains and strips brackets", () => {
    const refs = Array.from({ length: 400 }, (_, i) => `<r${i}@x.example>`).join("\r\n ");
    const parsed = parseMessage(
      enc(`Message-ID: <m@x.example>\nIn-Reply-To: <r399@x.example>\nReferences: ${refs}\n\nbody`),
    );
    expect(parsed.references).toHaveLength(400);
    expect(parsed.references[399]).toBe("r399@x.example");
    expect(parsed.inReplyTo).toEqual(["r399@x.example"]);
    expect(parsed.messageIdHeader).toBe("m@x.example");
  });

  it("warns on unknown charsets and still decodes", () => {
    const parsed = parseMessage(
      enc(`Subject: =?x-unknown-9?Q?hi?=\nContent-Type: text/plain; charset=x-bogus\n\nhello`),
    );
    expect(parsed.subject).toBe("hi");
    expect(parsed.text).toBe("hello");
    expect(parsed.warnings.filter((w) => w._tag === "UnknownCharset")).toHaveLength(2);
  });

  it("extracts calendar parts with METHOD", () => {
    const parsed = parseMessage(
      enc(`Content-Type: multipart/alternative; boundary=c

--c
Content-Type: text/plain

Invite
--c
Content-Type: text/calendar; charset=utf-8; method=REQUEST

BEGIN:VCALENDAR
METHOD:REQUEST
END:VCALENDAR
--c--
`),
    );
    expect(parsed.calendar?.method).toBe("REQUEST");
    expect(parsed.calendar?.ics).toContain("BEGIN:VCALENDAR");
    expect(summarizeMessage(parsed, 1).hasCalendar).toBe(true);
  });

  it("never throws on random bytes", () => {
    let seed = 7;
    for (let round = 0; round < 50; round++) {
      const bytes = new Uint8Array(2000).map(
        () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) >> 16) & 0xff,
      );
      expect(() => parseMessage(bytes)).not.toThrow();
    }
  });

  it("parses headers that contain raw UTF-8 and malformed lines", () => {
    const parsed = parseMessage(
      enc(`Subject: Grüße\nnot a header\nFrom: Zoë <zoe@example.com>\n\nx`),
    );
    expect(parsed.subject).toBe("Grüße");
    expect(parsed.from[0]?.name).toBe("Zoë");
    expect(parsed.warnings.some((w) => w._tag === "MalformedHeader")).toBe(true);
  });

  it("summarizes snippets and detects automated mail", () => {
    const parsed = parseMessage(
      enc(`From: noreply@shop.example\nSubject: Your receipt\n\n${"word ".repeat(100)}`),
    );
    const summary = summarizeMessage(parsed, 42);
    expect(summary.automated).toBe(true);
    expect(Array.from(summary.snippet).length).toBeLessThanOrEqual(200);
    expect(summary.date).toBe(42);
  });
});

describe("parseAddressList", () => {
  it("handles comments, quoted specials and encoded names", () => {
    expect(
      parseAddressList(
        `=?UTF-8?B?w4lsb2RpZQ==?= <e@x.example>, "a,b" <ab@x.example>, (c) plain@x.example`,
      ),
    ).toEqual([
      { name: "Élodie", address: "e@x.example" },
      { name: "a,b", address: "ab@x.example" },
      { name: undefined, address: "plain@x.example" },
    ]);
  });
});
