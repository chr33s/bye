import { describe, expect, it } from "vitest";
import { parseToLines } from "../src/parse.ts";

const message = (attachments: number) =>
  [
    "From: a@example.net",
    "To: b@bye.test",
    "Subject: Big one",
    "Message-ID: <big@example.net>",
    "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="b"',
    "",
    "--b",
    "Content-Type: text/html",
    "",
    "<p>hi</p><script>x()</script>",
    ...Array.from({ length: attachments }, (_, i) =>
      [
        `--b`,
        `Content-Type: application/octet-stream; name="f${i}.bin"`,
        `Content-Disposition: attachment; filename="f${i}.bin"`,
        "Content-Transfer-Encoding: base64",
        "",
        btoa(`part-${i}`),
      ].join("\r\n"),
    ),
    "--b--",
    "",
  ].join("\r\n");

describe("MIME container NDJSON protocol", () => {
  it("[E20] emits metadata first, then one line per attachment, with sanitized HTML", () => {
    const lines = [...parseToLines(new TextEncoder().encode(message(3)), 1)].map((l) =>
      JSON.parse(l),
    );

    expect(lines[0].type).toBe("meta");
    expect(lines[0].summary.subject).toBe("Big one");
    expect(lines[0].body.html).not.toContain("<script");
    expect(lines[0].attachments).toHaveLength(3);
    expect(lines.slice(1).map((l) => l.type)).toEqual(["part", "part", "part"]);
    expect(atob(lines[2].contentBase64)).toBe("part-1");
  });

  it("[E20] limits turn hostile input into a truncated, still-parseable result", () => {
    const lines = [
      ...parseToLines(new TextEncoder().encode(message(20)), 1, {
        maxBytes: 1 << 20,
        maxParts: 5,
        maxDepth: 4,
        maxHeaderBytes: 65536,
        maxDecodedBytes: 1 << 20,
      }),
    ].map((l) => JSON.parse(l));

    expect(lines[0].truncated).toBe(true);
    const parts = lines.slice(1);
    expect(parts.length).toBeGreaterThanOrEqual(1);
    expect(parts.length).toBeLessThanOrEqual(5);
    expect(parts.every((l) => l.type === "part")).toBe(true);
  });
});
