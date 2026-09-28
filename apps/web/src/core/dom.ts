import { Predicate } from "effect";
import type { JsonValue } from "@bye/native-shared/json";
import { ApiRequestError } from "../api.ts";

// DOM helpers. Untrusted strings only ever enter the DOM as text nodes or attribute values; there
// is no innerHTML anywhere in the client (§10). Message HTML renders in sandboxed iframes.

export type Child =
  | Node
  | string
  | null
  | undefined
  | false
  | ReadonlyArray<Node | string | null | undefined | false>;

type Attr = string | boolean | number | ((event: Event) => void) | undefined;

export const h = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Readonly<Record<string, Attr>> = {},
  ...children: ReadonlyArray<Child>
): HTMLElementTagNameMap[K] => {
  const el = document.createElement(tag);

  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue;

    if (Predicate.isFunction(value)) el.addEventListener(key.replace(/^on/, ""), value);
    else if (value === true) el.setAttribute(key, "");
    else el.setAttribute(key, String(value));
  }

  const append = (c: Child) => {
    if (c === null || c === undefined || c === false) return;

    if (Array.isArray(c)) (c as ReadonlyArray<Child>).forEach(append);
    else el.append(c as Node | string);
  };

  children.forEach(append);

  return el;
};

export const main = (): HTMLElement => document.getElementById("main")!;

/** Replace the main region and move focus to its heading for screen-reader and keyboard users. */
export const show = (node: HTMLElement): void => {
  main().replaceChildren(node);
  const heading = node.querySelector<HTMLElement>("h1");

  if (heading) {
    heading.tabIndex = -1;
    heading.focus({ preventScroll: true });
  }
};

export const announce = (message: string): void => {
  const live = document.getElementById("status");

  if (live) live.textContent = message;
};

export const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

export const errorState = (cause: unknown, retry: () => void): HTMLElement =>
  h(
    "section",
    { class: "empty", role: "alert", "aria-labelledby": "error-title" },
    h(
      "h1",
      { id: "error-title" },
      cause instanceof ApiRequestError && cause.status === 401
        ? "Signed out"
        : "Something went wrong",
    ),
    h("p", {}, errorMessage(cause)),
    h("button", { type: "button", onclick: () => retry() }, "Try again"),
  );

export const section = (
  id: string,
  title: string,
  ...children: ReadonlyArray<Child>
): HTMLElement => h("section", { "aria-labelledby": id }, h("h1", { id }, title), ...children);

export const field = (label: string, control: HTMLElement): HTMLElement =>
  h("label", {}, label, control);

export const formatDate = (ms: number | null | undefined): string =>
  ms ? new Date(ms).toLocaleString() : "—";

export const formatSize = (bytes: number): string =>
  bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;

/** Run an async UI action and report its outcome in the live region. */
export const act =
  <R>(label: string, fn: () => Promise<R>, after?: () => void) =>
  async (event?: Event): Promise<void> => {
    event?.preventDefault();
    announce(`${label}…`);

    try {
      await fn();
      announce(`${label}: done`);
      after?.();
    } catch (error) {
      announce(`${label} failed: ${errorMessage(error)}`);
    }
  };

/** A form control's value narrowed to its allowed options (a tampered DOM falls back). */
export const choice = <const T extends string>(
  value: string,
  allowed: ReadonlyArray<T>,
  fallback: T,
): T => ((allowed as ReadonlyArray<string>).includes(value) ? (value as T) : fallback);

/** Generic table for administrative lists; columns pick fields, actions render per row. */
export const table = <T extends object>(
  caption: string,
  rows: ReadonlyArray<T>,
  columns: ReadonlyArray<readonly [string, (row: T) => Child]>,
  empty = "Nothing here.",
): HTMLElement => {
  if (rows.length === 0) return h("p", { class: "empty" }, empty);

  return h(
    "table",
    {},
    h("caption", {}, caption),
    h(
      "thead",
      {},
      h(
        "tr",
        {},
        columns.map(([label]) => h("th", { scope: "col" }, label)),
      ),
    ),
    h(
      "tbody",
      {},
      rows.map((row) =>
        h(
          "tr",
          {},
          columns.map(([, cell]) => h("td", {}, cell(row))),
        ),
      ),
    ),
  );
};

export const text = (value: JsonValue | undefined): string =>
  value === null || value === undefined
    ? ""
    : Predicate.isString(value)
      ? value
      : Predicate.isNumber(value) || Predicate.isBoolean(value)
        ? String(value)
        : JSON.stringify(value);
