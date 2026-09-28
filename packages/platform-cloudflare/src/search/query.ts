// Typed search query AST (§8 Search). User input is parsed, never spliced into FTS syntax.

export type SearchClause =
  | { readonly _tag: "Term"; readonly value: string; readonly negated: boolean }
  | { readonly _tag: "Phrase"; readonly value: string; readonly negated: boolean };

export type SearchScope = "mail" | "trash" | "spam" | "everything-including-trash";

export interface SearchQuery {
  readonly clauses: ReadonlyArray<SearchClause>;
  readonly from: ReadonlyArray<string>;
  readonly to: ReadonlyArray<string>;
  readonly labels: ReadonlyArray<string>;
  readonly kinds: ReadonlyArray<string>;
  readonly view: string | undefined;
  readonly hasAttachment: boolean | undefined;
  readonly before: number | undefined;
  readonly after: number | undefined;
  /** Trash/Spam are only searched when asked for explicitly (E21). */
  readonly scope: SearchScope;
}

const FILTER_KEYS = new Set(["from", "to", "label", "in", "has", "before", "after", "is", "kind"]);

type SearchToken = { text: string; quoted: boolean; negated: boolean; key?: string };

/** Tokenize respecting double quotes; `-` negates the following token. */
const tokenize = (input: string): Array<SearchToken> => {
  const out: Array<SearchToken> = [];
  let i = 0;
  const s = input.normalize("NFC");

  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i]!)) i++;

    if (i >= s.length) break;
    let negated = false;

    if (s[i] === "-" && i + 1 < s.length && !/\s/.test(s[i + 1]!)) {
      negated = true;
      i++;
    }

    let key: string | undefined;
    const keyMatch = /^([a-z]+):/i.exec(s.slice(i));

    if (keyMatch && FILTER_KEYS.has(keyMatch[1]!.toLowerCase())) {
      key = keyMatch[1]!.toLowerCase();
      i += keyMatch[0].length;
    }

    if (s[i] === '"') {
      const end = s.indexOf('"', i + 1);
      const text = end < 0 ? s.slice(i + 1) : s.slice(i + 1, end);
      i = end < 0 ? s.length : end + 1;

      const token: SearchToken = {
        text,
        quoted: true,
        negated,
      };

      if (key) token.key = key;
      out.push(token);
    } else {
      let j = i;

      while (j < s.length && !/\s/.test(s[j]!)) j++;

      const token: SearchToken = {
        text: s.slice(i, j),
        quoted: false,
        negated,
      };

      if (key) token.key = key;
      out.push(token);
      i = j;
    }
  }

  return out;
};

const parseDate = (value: string): number | undefined => {
  const t = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value);

  return Number.isFinite(t) ? t : undefined;
};

export const parseSearchQuery = (input: string): SearchQuery => {
  const clauses: Array<SearchClause> = [];
  const from: Array<string> = [];
  const to: Array<string> = [];
  const labels: Array<string> = [];
  const kinds: Array<string> = [];
  let view: string | undefined;
  let hasAttachment: boolean | undefined;
  let before: number | undefined;
  let after: number | undefined;
  let scope: SearchScope = "mail";

  for (const t of tokenize(input)) {
    if (t.text.length === 0) continue;

    switch (t.key) {
      case "from":
        from.push(t.text.toLowerCase());
        break;
      case "to":
        to.push(t.text.toLowerCase());
        break;
      case "label":
        labels.push(t.text);
        break;
      case "kind":
        kinds.push(t.text.toLowerCase());
        break;
      case "in": {
        const v = t.text.toLowerCase();

        if (v === "trash") scope = "trash";
        else if (v === "spam") scope = "spam";
        else if (v === "anywhere" || v === "all") scope = "everything-including-trash";
        else view = v;
        break;
      }

      case "has":
      case "is":
        if (/^attachments?$/i.test(t.text)) hasAttachment = !t.negated;
        break;
      case "before":
        before = parseDate(t.text);
        break;
      case "after":
        after = parseDate(t.text);
        break;
      default:
        clauses.push(
          t.quoted
            ? { _tag: "Phrase", value: t.text, negated: t.negated }
            : { _tag: "Term", value: t.text, negated: t.negated },
        );
    }
  }

  return { clauses, from, to, labels, kinds, view, hasAttachment, before, after, scope };
};

/** Quote a user string as a single FTS5 string literal: operators and syntax become literal text. */
export const ftsLiteral = (value: string): string => `"${value.replace(/"/g, '""')}"`;

export const CJK = /[぀-ヿ㐀-䶿一-鿿가-힯豈-﫿]/;

/** Terms that tokenize to nothing under unicode61 (pure punctuation) can't match FTS; use LIKE. */
export const hasWordChars = (value: string): boolean => /[\p{L}\p{N}]/u.test(value);
