import { utf8Encode } from "./encoding.ts";

// vCard 3.0/4.0 import/export (E16, A04).

export interface VCardValue {
  readonly value: string;
  readonly types: ReadonlyArray<string>;
}

export interface VCardName {
  readonly family: string;
  readonly given: string;
  readonly additional: string;
  readonly prefix: string;
  readonly suffix: string;
}

export interface VCard {
  readonly version: string;
  readonly uid: string | undefined;
  readonly fn: string;
  readonly n: VCardName | undefined;
  readonly emails: ReadonlyArray<VCardValue>;
  readonly tels: ReadonlyArray<VCardValue>;
  readonly org: string | undefined;
  readonly note: string | undefined;
  readonly categories: ReadonlyArray<string>;
}

const splitUnescaped = (value: string, separator: string): Array<string> => {
  const out: Array<string> = [];
  let current = "";
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]!;
    if (ch === "\\" && i + 1 < value.length) {
      current += ch + value[i + 1];
      i++;
    } else if (ch === separator) {
      out.push(current);
      current = "";
    } else current += ch;
  }
  out.push(current);
  return out;
};

const unescapeValue = (value: string): string =>
  value.replace(/\\([nN,;\\:])/g, (_, c: string) => (c === "n" || c === "N" ? "\n" : c));

const escapeValue = (value: string): string =>
  value.replace(/\\/g, "\\\\").replace(/\r?\n/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\\;");

const findValueColon = (line: string): number => {
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') quoted = !quoted;
    else if (line[i] === ":" && !quoted) return i;
  }
  return -1;
};

const parseTypes = (params: ReadonlyArray<string>): Array<string> => {
  const types: Array<string> = [];
  for (const param of params) {
    const eq = param.indexOf("=");
    if (eq < 0) {
      if (param) types.push(param.toLowerCase());
      continue;
    }
    if (param.slice(0, eq).toLowerCase() !== "type") continue;
    for (const t of param
      .slice(eq + 1)
      .replace(/"/g, "")
      .split(","))
      if (t) types.push(t.toLowerCase());
  }
  return types;
};

export const parseVCards = (text: string): Array<VCard> => {
  const unfolded = text.replace(/\r?\n[ \t]/g, "");
  const cards: Array<VCard> = [];
  let card:
    | {
        version: string;
        uid: string | undefined;
        fn: string;
        n: VCardName | undefined;
        emails: Array<VCardValue>;
        tels: Array<VCardValue>;
        org: string | undefined;
        note: string | undefined;
        categories: Array<string>;
      }
    | undefined;
  for (const line of unfolded.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const colon = findValueColon(line);
    if (colon < 0) continue;
    const [rawName = "", ...params] = splitUnescaped(line.slice(0, colon), ";");
    const name = (rawName.split(".").pop() ?? "").toUpperCase();
    const value = line.slice(colon + 1);
    if (name === "BEGIN" && value.toUpperCase() === "VCARD") {
      card = {
        version: "3.0",
        uid: undefined,
        fn: "",
        n: undefined,
        emails: [],
        tels: [],
        org: undefined,
        note: undefined,
        categories: [],
      };
      continue;
    }
    if (!card) continue;
    switch (name) {
      case "END":
        if (!card.fn && card.n)
          card.fn = [card.n.prefix, card.n.given, card.n.additional, card.n.family, card.n.suffix]
            .filter(Boolean)
            .join(" ");
        if (!card.fn && card.emails[0]) card.fn = card.emails[0].value;
        cards.push(card);
        card = undefined;
        break;
      case "VERSION":
        card.version = value.trim();
        break;
      case "UID":
        card.uid = unescapeValue(value);
        break;
      case "FN":
        card.fn = unescapeValue(value);
        break;
      case "N": {
        const [family = "", given = "", additional = "", prefix = "", suffix = ""] = splitUnescaped(
          value,
          ";",
        ).map(unescapeValue);
        card.n = { family, given, additional, prefix, suffix };
        break;
      }
      case "EMAIL":
        card.emails.push({
          value: unescapeValue(value)
            .replace(/^mailto:/i, "")
            .trim(),
          types: parseTypes(params),
        });
        break;
      case "TEL":
        card.tels.push({
          value: unescapeValue(value).replace(/^tel:/i, "").trim(),
          types: parseTypes(params),
        });
        break;
      case "ORG":
        card.org = splitUnescaped(value, ";").map(unescapeValue).filter(Boolean).join(", ");
        break;
      case "NOTE":
        card.note = unescapeValue(value);
        break;
      case "CATEGORIES":
        card.categories.push(
          ...splitUnescaped(value, ",")
            .map(unescapeValue)
            .map((c) => c.trim())
            .filter(Boolean),
        );
        break;
    }
  }
  return cards;
};

/** Fold a content line at 75 octets without splitting a UTF-8 sequence. */
export const foldContentLine = (line: string): string => {
  const out: Array<string> = [];
  let current = "";
  let bytes = 0;
  for (const cp of line) {
    const size = utf8Encode(cp).length;
    const limit = out.length === 0 ? 75 : 74;
    if (bytes + size > limit) {
      out.push(current);
      current = "";
      bytes = 0;
    }
    current += cp;
    bytes += size;
  }
  out.push(current);
  return out.join("\r\n ");
};

const typeParam = (types: ReadonlyArray<string>): string =>
  types.length ? `;TYPE=${types.map((t) => t.replace(/[^A-Za-z0-9-]/g, "")).join(",")}` : "";

export const serializeVCard = (card: VCard, version: "3.0" | "4.0" = "4.0"): string => {
  const lines = ["BEGIN:VCARD", `VERSION:${version}`];
  if (card.uid) lines.push(`UID:${escapeValue(card.uid)}`);
  lines.push(`FN:${escapeValue(card.fn)}`);
  const n = card.n ?? { family: "", given: "", additional: "", prefix: "", suffix: "" };
  lines.push(
    `N:${[n.family, n.given, n.additional, n.prefix, n.suffix].map(escapeValue).join(";")}`,
  );
  for (const e of card.emails) lines.push(`EMAIL${typeParam(e.types)}:${escapeValue(e.value)}`);
  for (const t of card.tels) lines.push(`TEL${typeParam(t.types)}:${escapeValue(t.value)}`);
  if (card.org) lines.push(`ORG:${escapeValue(card.org)}`);
  if (card.note) lines.push(`NOTE:${escapeValue(card.note)}`);
  if (card.categories.length)
    lines.push(`CATEGORIES:${card.categories.map(escapeValue).join(",")}`);
  lines.push("END:VCARD");
  return `${lines.map(foldContentLine).join("\r\n")}\r\n`;
};

export const serializeVCards = (cards: Iterable<VCard>, version: "3.0" | "4.0" = "4.0"): string =>
  Array.from(cards, (c) => serializeVCard(c, version)).join("");
