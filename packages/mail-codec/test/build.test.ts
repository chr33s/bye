import { describe, expect, it } from "vitest";
import { buildMessage, parseMessage, replyReferences } from "@bye/mail-codec";

const text = (b: Uint8Array) => new TextDecoder().decode(b);

const base = {
  from: { name: "Ana Núñez", address: "ana@example.com" },
  to: [{ name: "Bob, Jr.", address: "bob@example.org" }],
  cc: [{ name: undefined, address: "carol@example.net" }],
  bcc: [{ name: "Hidden", address: "secret@example.net" }],
  subject: "Résumé — café ☕ and a long subject that needs folding across multiple header lines",
  date: Date.UTC(2026, 8, 25, 12, 0, 0),
  messageId: "abc123@bye.example",
  boundary: (i: number) => `b${i}`,
};

describe("buildMessage", () => {
  it("[E17] round-trips text, html, inline CID images, attachments and reply headers", () => {
    const built = buildMessage({
      ...base,
      text: "Hello Bob\nSecond line with ünïcode",
      html: '<p>Hello <b>Bob</b> <img src="cid:logo@bye"></p>',
      inline: [
        {
          filename: "logo.png",
          contentType: "image/png",
          content: new Uint8Array([137, 80, 78, 71]),
          contentId: "logo@bye",
        },
      ],
      attachments: [
        {
          filename: "naïve plan.pdf",
          contentType: "application/pdf",
          content: new Uint8Array(300).fill(7),
        },
      ],
      inReplyTo: "parent@x.example",
      references: ["root@x.example", "parent@x.example"],
    });
    const wire = text(built.bytes);
    for (const line of wire.split("\r\n")) expect(line.length).toBeLessThanOrEqual(998);
    expect(wire).not.toMatch(/[^\r]\n/);
    const parsed = parseMessage(built.bytes);
    expect(parsed.subject).toBe(base.subject);
    expect(parsed.from[0]).toEqual(base.from);
    expect(parsed.to[0]).toEqual(base.to[0]);
    expect(parsed.text).toBe("Hello Bob\r\nSecond line with ünïcode");
    expect(parsed.html).toContain("cid:logo@bye");
    expect(parsed.inReplyTo).toEqual(["parent@x.example"]);
    expect(parsed.references).toEqual(["root@x.example", "parent@x.example"]);
    expect(parsed.messageIdHeader).toBe("abc123@bye.example");
    expect(parsed.date).toBe(base.date);
    const pdf = parsed.attachments.find((a) => a.contentType === "application/pdf");
    expect(pdf?.filename).toBe("naïve plan.pdf");
    expect(pdf?.size).toBe(300);
    expect(parsed.attachments.find((a) => a.contentId === "logo@bye")?.inline).toBe(true);
    expect(parsed.warnings).toEqual([]);
  });

  it("[E17] never writes Bcc recipients into headers but keeps them in the envelope", () => {
    const built = buildMessage({ ...base, text: "hi" });
    const wire = text(built.bytes);
    expect(wire.toLowerCase()).not.toContain("secret@example.net");
    expect(wire.toLowerCase()).not.toContain("bcc");
    expect(built.envelopeRecipients).toEqual([
      "bob@example.org",
      "carol@example.net",
      "secret@example.net",
    ]);
  });

  it("[E17] strips header injection and refuses protected extra headers", () => {
    const built = buildMessage({
      ...base,
      subject: "hi\r\nBcc: victim@example.com",
      text: "x",
      extraHeaders: [
        ["Bcc", "a@b.c"],
        ["X-Campaign", "one\r\nTo: evil@x"],
        ["Content-Type", "text/html"],
      ],
    });
    const wire = text(built.bytes);
    const headerBlock = wire.split("\r\n\r\n")[0]!;
    expect(headerBlock).not.toMatch(/^Bcc:/im);
    expect(headerBlock).not.toMatch(/^To: evil/im);
    expect(headerBlock).toMatch(/^X-Campaign: one To: evil@x$/m);
    expect(headerBlock.match(/^Content-Type:/gim)).toHaveLength(1);
  });

  it("[C04] emits text/calendar alternatives with the iTIP method", () => {
    const ics = "BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nEND:VCALENDAR";
    const parsed = parseMessage(
      buildMessage({ ...base, text: "invite", calendar: { method: "REQUEST", ics } }).bytes,
    );
    expect(parsed.calendar?.method).toBe("REQUEST");
    expect(parsed.calendar?.ics).toBe(ics);
  });

  it("[E22] marks away replies as Auto-Submitted", () => {
    const parsed = parseMessage(
      buildMessage({ ...base, text: "away", autoSubmitted: "auto-replied" }).bytes,
    );
    expect(parsed.autoSubmitted).toBe("auto-replied");
  });

  it("[E17] wraps base64 at 76 characters", () => {
    const built = buildMessage({
      ...base,
      text: "x",
      attachments: [
        {
          filename: "a.bin",
          contentType: "application/octet-stream",
          content: new Uint8Array(1000),
        },
      ],
    });
    const lines = text(built.bytes)
      .split("\r\n")
      .filter((l) => /^[A-Za-z0-9+/=]{20,}$/.test(l));
    expect(lines.length).toBeGreaterThan(5);
    expect(Math.max(...lines.map((l) => l.length))).toBe(76);
  });

  it("[E11] bounds reply References while keeping the root", () => {
    const refs = Array.from({ length: 50 }, (_, i) => `r${i}@x`);
    const out = replyReferences({ messageIdHeader: "p@x", references: refs }, 20);
    expect(out).toHaveLength(20);
    expect(out[0]).toBe("r0@x");
    expect(out.at(-1)).toBe("p@x");
  });
});

describe("header line limits (RFC 5322 §2.1.1)", () => {
  it("[E17] an ASCII subject with a very long unbroken run is encoded so no line exceeds 998 octets", () => {
    const url = `https://example.net/${"a".repeat(1200)}`;
    const { bytes } = buildMessage({
      from: { name: undefined, address: "ana@bye.test" },
      to: [{ name: undefined, address: "bob@example.net" }],
      subject: `see ${url}`,
      text: "x",
      date: 0,
      messageId: "m1@bye.test",
    });
    const head = new TextDecoder().decode(bytes).split("\r\n\r\n")[0]!;
    expect(Math.max(...head.split("\r\n").map((l) => l.length))).toBeLessThanOrEqual(998);
    expect(head).toMatch(/^Subject:(\r\n)? =\?UTF-8\?B\?/m);
  });

  it("[E17] ordinary ASCII subjects are left readable", () => {
    const { bytes } = buildMessage({
      from: { name: undefined, address: "ana@bye.test" },
      to: [{ name: undefined, address: "bob@example.net" }],
      subject: "Lunch on Friday?",
      text: "x",
      date: 0,
      messageId: "m2@bye.test",
    });
    expect(new TextDecoder().decode(bytes)).toContain("Subject: Lunch on Friday?");
  });
});
