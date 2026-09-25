import { binaryToBytes, bytesToBinary } from "./encoding.ts";

// MBOX export/import (A04) in the mboxrd variant: any line matching /^>*From / gains one '>'
// on write and loses one on read, so message bodies round-trip exactly (modulo CRLF→LF).

export interface MboxEntry {
  readonly envelopeFrom: string;
  readonly date: number;
  /** Raw RFC 5322 bytes. */
  readonly bytes: Uint8Array;
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** asctime(3)-style date used on mbox separator lines. */
export const formatMboxDate = (ms: number): string => {
  const d = new Date(ms);
  const p = (n: number) => n.toString().padStart(2, "0");
  return `${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate().toString().padStart(2, " ")} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} ${d.getUTCFullYear()}`;
};

export const mboxEntryText = (entry: MboxEntry): string => {
  const sender = entry.envelopeFrom.replace(/\s+/g, "") || "MAILER-DAEMON";
  const body = bytesToBinary(entry.bytes)
    .replace(/\r\n/g, "\n")
    .replace(/^(>*From )/gm, ">$1");
  return `From ${sender} ${formatMboxDate(entry.date)}\n${body}${body.endsWith("\n") ? "" : "\n"}\n`;
};

/** Streaming-friendly writer: yields one encoded chunk per message. */
export function* mboxChunks(entries: Iterable<MboxEntry>): Generator<Uint8Array> {
  for (const entry of entries) yield binaryToBytes(mboxEntryText(entry));
}

export const writeMbox = (entries: Iterable<MboxEntry>): Uint8Array => {
  let out = "";
  for (const entry of entries) out += mboxEntryText(entry);
  return binaryToBytes(out);
};

export const readMbox = (
  bytes: Uint8Array,
  options: { readonly crlf?: boolean } = {},
): Array<MboxEntry> => {
  const text = bytesToBinary(bytes).replace(/\r\n/g, "\n");
  const entries: Array<MboxEntry> = [];
  let current: { envelopeFrom: string; date: number; lines: Array<string> } | undefined;
  const flush = () => {
    if (!current) return;
    const lines = current.lines;
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    let body = lines.join("\n");
    if (lines.length > 0) body += "\n";
    if (options.crlf) body = body.replace(/\n/g, "\r\n");
    entries.push({
      envelopeFrom: current.envelopeFrom,
      date: current.date,
      bytes: binaryToBytes(body),
    });
  };
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  for (const line of lines) {
    const sep = /^From (\S*)\s+(.*)$/.exec(line);
    if (sep) {
      flush();
      const parsed = Date.parse(`${sep[2]} UTC`);
      current = { envelopeFrom: sep[1] ?? "", date: Number.isNaN(parsed) ? 0 : parsed, lines: [] };
      continue;
    }
    if (!current) continue;
    current.lines.push(line.replace(/^>(>*From )/, "$1"));
  }
  flush();
  return entries;
};
