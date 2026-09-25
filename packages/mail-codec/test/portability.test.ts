import { describe, expect, it } from "vitest";
import {
  parseVCards,
  readMbox,
  serializeVCard,
  serializeVCards,
  writeMbox,
  type VCard,
} from "@bye/mail-codec";

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

describe("MBOX", () => {
  it("[A04] round-trips messages with From-lines using mboxrd quoting", () => {
    const messages = [
      {
        envelopeFrom: "a@x.example",
        date: Date.UTC(2026, 0, 2, 3, 4, 5),
        bytes: enc("Subject: one\n\nFrom here on\n>From quoted\n>>From deeper\nend\n"),
      },
      {
        envelopeFrom: "b@x.example",
        date: Date.UTC(2026, 8, 25),
        bytes: enc("Subject: two\n\nno trailing newline"),
      },
      { envelopeFrom: "c@x.example", date: 0, bytes: enc("Subject: ünï\n\n\nblank lines\n\n") },
    ];
    const mbox = writeMbox(messages);
    const text = dec(mbox);
    expect(text).toContain("\n>From here on\n>>From quoted\n>>>From deeper\n");
    expect(text.startsWith("From a@x.example Fri Jan  2 03:04:05 2026\n")).toBe(true);
    const back = readMbox(mbox);
    expect(back).toHaveLength(3);
    expect(back.map((m) => m.envelopeFrom)).toEqual(["a@x.example", "b@x.example", "c@x.example"]);
    expect(back[0]!.date).toBe(messages[0]!.date);
    expect(dec(back[0]!.bytes)).toBe(dec(messages[0]!.bytes));
    expect(dec(back[1]!.bytes)).toBe("Subject: two\n\nno trailing newline\n");
    expect(dec(back[2]!.bytes)).toBe(dec(messages[2]!.bytes));
  });

  it("[A04] normalizes CRLF and can restore it on read", () => {
    const mbox = writeMbox([
      { envelopeFrom: "a@x", date: 0, bytes: enc("A: b\r\n\r\nFrom x\r\n") },
    ]);
    expect(dec(readMbox(mbox, { crlf: true })[0]!.bytes)).toBe("A: b\r\n\r\nFrom x\r\n");
  });
});

describe("vCard", () => {
  const card: VCard = {
    version: "4.0",
    uid: "urn:uuid:1",
    fn: "Zoë O'Brien, PhD",
    n: { family: "O'Brien", given: "Zoë", additional: "", prefix: "Dr.", suffix: "PhD" },
    emails: [
      { value: "zoe@example.com", types: ["work"] },
      { value: "z@home.example", types: [] },
    ],
    tels: [{ value: "+1 555 0100", types: ["cell"] }],
    org: "Acme; Inc",
    note: `Met at conference.\nLikes ${"long notes ".repeat(20)}`,
    categories: ["friends", "work, mostly"],
  };

  it("[E16] round-trips vCard 4.0 and 3.0 with escaping and folding", () => {
    for (const version of ["4.0", "3.0"] as const) {
      const text = serializeVCard(card, version);
      for (const line of text.split("\r\n"))
        expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
      const [parsed] = parseVCards(text);
      expect(parsed).toEqual({ ...card, version });
    }
  });

  it("[E16] imports common third-party exports", () => {
    const text = [
      "BEGIN:VCARD",
      "VERSION:3.0",
      "item1.EMAIL;type=INTERNET;type=pref:first@example.com",
      "EMAIL;WORK:second@example.com",
      "N:Smith;Jane;;;",
      "TEL;TYPE=CELL,VOICE:+44 20",
      "CATEGORIES:A,B",
      "END:VCARD",
      "BEGIN:VCARD",
      "VERSION:4.0",
      "EMAIL:mailto:only@example.com",
      "END:VCARD",
    ].join("\n");
    const cards = parseVCards(text);
    expect(cards).toHaveLength(2);
    expect(cards[0]!.fn).toBe("Jane Smith");
    expect(cards[0]!.emails).toEqual([
      { value: "first@example.com", types: ["internet", "pref"] },
      { value: "second@example.com", types: ["work"] },
    ]);
    expect(cards[0]!.tels[0]!.types).toEqual(["cell", "voice"]);
    expect(cards[1]!.fn).toBe("only@example.com");
    expect(parseVCards(serializeVCards(cards))).toHaveLength(2);
  });
});
