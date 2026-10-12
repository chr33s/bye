import { describe, expect, it } from "vitest";
import { bodyValue, buildMessage, partContent, prepareEmail, withoutBcc } from "@bye/mail-codec";

// JMAP preparation (spec.md §16.6 mail-codec): complete header/body structure from immutable
// bytes, bounded body values, and the Bcc-free bytes a submission pins (B2).

const enc = (s: string) => new TextEncoder().encode(s);

const multipart = [
  "From: Carol <carol@example.net>",
  "Sender: assistant@example.net",
  "To: me@bye.test",
  "Cc: dan@example.net",
  "Bcc: secret@example.net,",
  " other@example.net",
  "Reply-To: replies@example.net",
  "Subject: =?utf-8?q?Caf=C3=A9_plans?=",
  "Date: Mon, 12 Oct 2026 12:00:00 +0000",
  "Message-ID: <m1@example.net>",
  "In-Reply-To: <m0@example.net>",
  "References: <a@example.net> <m0@example.net>",
  "MIME-Version: 1.0",
  'Content-Type: multipart/mixed; boundary="outer"',
  "",
  "--outer",
  'Content-Type: multipart/alternative; boundary="inner"',
  "",
  "--inner",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "Plain café",
  "--inner",
  "Content-Type: text/html; charset=utf-8",
  "",
  "<p>Html café</p>",
  "--inner--",
  "--outer",
  'Content-Type: application/pdf; name="plan.pdf"',
  'Content-Disposition: attachment; filename="plan.pdf"',
  "Content-Transfer-Encoding: base64",
  "",
  "JVBERi0xLjQK",
  "--outer--",
  "",
].join("\r\n");

describe("prepareEmail", () => {
  it("derives every Email field and the MIME tree with stable part IDs", () => {
    const e = prepareEmail(enc(multipart));

    expect(e).toMatchObject({
      messageId: ["m1@example.net"],
      inReplyTo: ["m0@example.net"],
      references: ["a@example.net", "m0@example.net"],
      from: [{ name: "Carol", email: "carol@example.net" }],
      sender: [{ name: null, email: "assistant@example.net" }],
      cc: [{ name: null, email: "dan@example.net" }],
      bcc: [
        { name: null, email: "secret@example.net" },
        { name: null, email: "other@example.net" },
      ],
      replyTo: [{ name: null, email: "replies@example.net" }],
      subject: "Café plans",
      sentAt: Date.UTC(2026, 9, 12, 12),
      textBody: ["1.1"],
      htmlBody: ["1.2"],
      attachments: ["2"],
      hasAttachment: true,
      truncated: false,
    });
    expect(e.bodyStructure).toMatchObject({
      type: "multipart/mixed",
      subParts: [
        { type: "multipart/alternative", subParts: [{ partId: "1.1" }, { partId: "1.2" }] },
        { partId: "2", name: "plan.pdf", disposition: "attachment" },
      ],
    });
    expect(e.text).toContain("Plain café");
    expect(e.preview).toContain("Plain café");
  });

  it("falls back across text and html bodies and handles single-part messages", () => {
    const html = prepareEmail(
      enc("From: a@x.test\r\nSubject: h\r\nContent-Type: text/html\r\n\r\n<b>only html</b>"),
    );

    expect(html.textBody).toEqual(["1"]);
    expect(html.htmlBody).toEqual(["1"]);
    expect(html.text).toContain("only html");
    expect(html.messageId).toBeNull();
    expect(html.hasAttachment).toBe(false);
  });
});

describe("body values and parts", () => {
  it("truncates large multi-byte text in linear time, never splitting a code point", () => {
    const body = `${"漢字".repeat(30_000)}😀tail`;

    const raw = enc(
      [
        "From: a@example.net",
        "Subject: big",
        "Content-Type: text/plain; charset=utf-8",
        "Content-Transfer-Encoding: 8bit",
        "",
        body,
        "",
      ].join("\r\n"),
    );

    const t0 = performance.now();
    const v = bodyValue(raw, "1", 100_000)!;

    expect(performance.now() - t0).toBeLessThan(1_000);
    expect(v.isTruncated).toBe(true);
    expect(new TextEncoder().encode(v.value).byteLength).toBeLessThanOrEqual(100_000);

    // Cut right before the emoji: 180,000 bytes of CJK fit only in part, and the 4-byte emoji
    // is either whole or absent.
    const emoji = bodyValue(raw, "1", 180_002)!.value;

    expect(emoji.endsWith("\uD83D")).toBe(false);
  });

  it("decodes a text part, truncating by UTF-8 bytes", () => {
    const bytes = enc(multipart);

    expect(bodyValue(bytes, "1.1", 0)).toEqual({
      value: "Plain café",
      isEncodingProblem: false,
      isTruncated: false,
    });
    expect(bodyValue(bytes, "1.1", 10)).toEqual({
      value: "Plain caf",
      isEncodingProblem: false,
      isTruncated: true,
    });
    expect(bodyValue(bytes, "2", 0)).toBeUndefined();
    expect(bodyValue(bytes, "9", 0)).toBeUndefined();
    expect(partContent(bytes, "2")).toMatchObject({ type: "application/pdf", name: "plan.pdf" });
    expect(partContent(bytes, "9")).toBeUndefined();
  });
});

describe("withoutBcc (B2)", () => {
  it("removes every Bcc field, including folded lines, and nothing else", () => {
    const out = new TextDecoder().decode(withoutBcc(enc(multipart)));

    expect(out).not.toMatch(/^bcc:/im);
    expect(out).not.toContain("other@example.net");
    expect(out).toContain("Cc: dan@example.net");
    expect(out.length).toBeLessThan(multipart.length);
  });

  it("returns the same bytes when there is no Bcc", () => {
    const bytes = enc("From: a@x.test\r\nSubject: s\r\n\r\nbody bcc: not a header");

    expect(withoutBcc(bytes)).toBe(bytes);
  });

  it("drafts keep Bcc as a header only when asked", () => {
    const input = {
      from: { name: undefined, address: "a@x.test" },
      to: [{ name: undefined, address: "b@x.test" }],
      bcc: [{ name: undefined, address: "hidden@x.test" }],
      subject: "s",
      text: "t",
      date: 0,
      messageId: "id@x.test",
    };

    const plain = new TextDecoder().decode(buildMessage(input).bytes);
    const draft = new TextDecoder().decode(buildMessage({ ...input, draftBcc: true }).bytes);

    expect(plain).not.toMatch(/^bcc:/im);
    expect(draft).toMatch(/^Bcc: hidden@x.test/m);
  });
});
