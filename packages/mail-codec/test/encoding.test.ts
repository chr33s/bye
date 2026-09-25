import { describe, expect, it } from "vitest";
import { decodeCharset, parseMailDate, type Warning } from "@bye/mail-codec";

const b = (...bytes: Array<number>) => new Uint8Array(bytes);
const iso = (ms: number | undefined) => (ms === undefined ? undefined : new Date(ms).toISOString());

describe("decodeCharset", () => {
  it("decodes ISO-8859-1 / latin1 byte-for-byte, whatever the label spelling", () => {
    for (const label of ["latin1", "ISO-8859-1", "iso8859-1", "iso_8859-1", '"iso-8859-1"'])
      expect(decodeCharset(b(0x63, 0x61, 0x66, 0xe9), label)).toBe("café");
    // RFC 2231 language suffix is ignored.
    expect(decodeCharset(b(0x63, 0x61, 0x66, 0xe9), "iso-8859-1*en")).toBe("café");
    // Exact latin1 keeps C1 controls as-is (no windows-1252 remapping), so bytes round-trip.
    expect(decodeCharset(b(0x80, 0x9f), "latin1")).toBe("\u0080\u009f");
  });

  it("decodes windows-1252 punctuation in the 0x80–0x9F range", () => {
    expect(decodeCharset(b(0x80, 0x93, 0x94, 0x9f), "windows-1252")).toBe("€“”Ÿ");
  });

  it("decodes stateful ISO-2022-JP and Shift_JIS", () => {
    // ESC $ B <JIS X 0208 "日本"> ESC ( B
    expect(
      decodeCharset(b(0x1b, 0x24, 0x42, 0x46, 0x7c, 0x4b, 0x5c, 0x1b, 0x28, 0x42), "ISO-2022-JP"),
    ).toBe("日本");
    expect(decodeCharset(b(0x93, 0xfa, 0x96, 0x7b), "Shift_JIS")).toBe("日本");
  });

  it("falls back to lenient UTF-8 with one warning for an unknown charset", () => {
    const warnings: Array<Warning> = [];
    expect(decodeCharset(b(0xe2, 0x98, 0x95), "x-bogus", warnings)).toBe("☕");
    decodeCharset(b(0x61), "x-bogus", warnings);
    expect(warnings).toEqual([{ _tag: "UnknownCharset", charset: "x-bogus" }]);
    expect(decodeCharset(b(0xff, 0x61), undefined)).toBe("�a");
  });
});

describe("parseMailDate", () => {
  it("parses RFC 5322 dates with numeric zones, comments and folding whitespace", () => {
    expect(iso(parseMailDate("Fri, 25 Sep 2026 10:00:00 +0000"))).toBe("2026-09-25T10:00:00.000Z");
    expect(iso(parseMailDate("Fri, 25 Sep 2026 10:00:00 -0700 (PDT)"))).toBe(
      "2026-09-25T17:00:00.000Z",
    );
    expect(iso(parseMailDate("25 Sep 2026 10:00 +0530"))).toBe("2026-09-25T04:30:00.000Z");
    expect(iso(parseMailDate("Fri,  25\r\n   Sep 2026 10:00:00 +0000 (UTC)"))).toBe(
      "2026-09-25T10:00:00.000Z",
    );
    expect(iso(parseMailDate("Fri, 25 September 2026 10:00:00 +0000"))).toBe(
      "2026-09-25T10:00:00.000Z",
    );
  });

  it("handles obsolete two- and three-digit years and named zones", () => {
    expect(iso(parseMailDate("Fri, 25 Sep 26 10:00:00 +0000"))).toBe("2026-09-25T10:00:00.000Z");
    expect(iso(parseMailDate("Sat, 25 Sep 99 10:00:00 +0000"))).toBe("1999-09-25T10:00:00.000Z");
    expect(iso(parseMailDate("Sat, 25 Sep 099 10:00:00 +0000"))).toBe("1999-09-25T10:00:00.000Z");
    expect(iso(parseMailDate("Fri, 25 Sep 2026 10:00:00 GMT"))).toBe("2026-09-25T10:00:00.000Z");
    expect(iso(parseMailDate("Fri, 25 Sep 2026 10:00:00 UT"))).toBe("2026-09-25T10:00:00.000Z");
    expect(iso(parseMailDate("Fri, 25 Sep 2026 10:00:00 EST"))).toBe("2026-09-25T15:00:00.000Z");
    expect(iso(parseMailDate("Fri, 25 Sep 2026 10:00:00 PDT"))).toBe("2026-09-25T17:00:00.000Z");
  });

  it("treats a missing zone as UTC regardless of the host time zone", () => {
    // Date.parse would read this as local time; RFC 5322 §4.3 says treat it as -0000.
    expect(iso(parseMailDate("Fri, 25 Sep 2026 10:00:00"))).toBe("2026-09-25T10:00:00.000Z");
    expect(iso(parseMailDate("Fri, 25 Sep 2026 10:00:00 A"))).toBe("2026-09-25T10:00:00.000Z");
  });

  it("falls back to Date.parse for ISO 8601", () => {
    expect(iso(parseMailDate("2026-09-25T10:00:00Z"))).toBe("2026-09-25T10:00:00.000Z");
  });

  it("rejects missing, garbage, unknown-month and out-of-range dates", () => {
    expect(parseMailDate(undefined)).toBeUndefined();
    expect(parseMailDate("")).toBeUndefined();
    expect(parseMailDate("not a date")).toBeUndefined();
    expect(parseMailDate("Fri, 25 Foo 2026 10:00:00 +0000")).toBeUndefined();
    expect(parseMailDate("Fri, 31 Sep 2026 10:00:00 +0000")).toBeUndefined();
    expect(parseMailDate("Fri, 25 Sep 2026 24:00:00 +0000")).toBeUndefined();
  });
});
