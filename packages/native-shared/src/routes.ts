import { toLocalDate, ymd } from "./calendar-form.ts";
import { isMailView, type MailView } from "./views.ts";

// The hash-route grammar every client shares (web PWA, native apps, deep links, the iOS share
// extension, widget taps), so a link resolves identically everywhere.
//
// A route table is data: `[pattern, name]` rows with literal segments, `:param` captures and
// trailing `:param?` optionals. Extra trailing segments are ignored; the first matching row wins,
// so specific rows come first. `matchHash` is the one parser.

export type RouteTable = ReadonlyArray<readonly [pattern: string, name: string]>;

export interface HashMatch<Name extends string> {
  readonly name: Name;
  /** Decoded captures; bad percent-encoding is kept verbatim rather than failing the route. */
  readonly params: Readonly<Record<string, string>>;
  readonly query: URLSearchParams;
  /** The raw path (no leading `#`). */
  readonly path: string;
}

const dec = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

const matchPattern = (
  pattern: string,
  parts: ReadonlyArray<string>,
): Record<string, string> | null => {
  const params: Record<string, string> = {};
  const segments = pattern.split("/");
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    const part = parts[i];
    if (seg.startsWith(":")) {
      const optional = seg.endsWith("?");
      const key = seg.slice(1, optional ? -1 : undefined);
      if (part === undefined) {
        if (optional) continue;
        return null;
      }
      params[key] = part;
    } else if (part !== seg) {
      return null;
    }
  }
  return params;
};

export const matchHash = <const T extends RouteTable, const F extends T[number][1]>(
  table: T,
  hash: string,
  fallback: F,
): HashMatch<T[number][1]> => {
  const raw = hash.replace(/^#/, "");
  const q = raw.indexOf("?");
  const path = q < 0 ? raw : raw.slice(0, q);
  const query = new URLSearchParams(q < 0 ? "" : raw.slice(q + 1));
  const parts = path.split("/").filter(Boolean).map(dec);
  for (const [pattern, name] of table) {
    const params = matchPattern(pattern, parts);
    if (params) return { name, params, query, path };
  }
  return { name: fallback, params: {}, query, path };
};

// ---- native navigation ----

export type NativeRoute =
  | { readonly screen: "mail"; readonly view: MailView }
  | { readonly screen: "thread"; readonly threadId: string }
  | {
      readonly screen: "compose";
      readonly to?: string;
      readonly subject?: string;
      readonly text?: string;
      readonly threadId?: string;
    }
  | { readonly screen: "calendar" }
  | { readonly screen: "event"; readonly date: string }
  | { readonly screen: "planning" }
  | { readonly screen: "settings" }
  | { readonly screen: "search"; readonly q: string };

export const DEFAULT_ROUTE: NativeRoute = { screen: "mail", view: "imbox" };

/** The subset of the web routes the native apps render. */
export const NATIVE_ROUTES = [
  ["mail/:view?", "mail"],
  ["thread/:threadId", "thread"],
  ["compose", "compose"],
  ["calendar/planning", "planning"],
  ["calendar/new", "event"],
  ["calendar", "calendar"],
  ["settings", "settings"],
  ["devices", "settings"],
  ["search", "search"],
] as const satisfies RouteTable;

export const parseRoute = (hash: string): NativeRoute => {
  const { name, params, query } = matchHash(NATIVE_ROUTES, hash, "mail");
  switch (name) {
    case "mail":
      return isMailView(params.view) ? { screen: "mail", view: params.view } : DEFAULT_ROUTE;
    case "thread":
      return { screen: "thread", threadId: params.threadId! };
    case "compose": {
      // Shared text and URLs become the message body (share sheet / share extension).
      const text = [query.get("text") ?? query.get("body"), query.get("url")]
        .filter(Boolean)
        .join("\n\n");
      const opt = (k: string) => query.get(k) ?? undefined;
      return {
        screen: "compose",
        ...(opt("to") ? { to: opt("to") } : {}),
        ...(opt("subject") ? { subject: opt("subject") } : {}),
        ...(text ? { text } : {}),
        ...(opt("thread") ? { threadId: opt("thread") } : {}),
      };
    }
    case "planning":
      return { screen: "planning" };
    case "event": {
      const date = query.get("date") ?? "";
      return {
        screen: "event",
        date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : ymd(toLocalDate(new Date())),
      };
    }
    case "calendar":
      return { screen: "calendar" };
    case "settings":
      return { screen: "settings" };
    case "search":
      return { screen: "search", q: query.get("q") ?? "" };
  }
};
