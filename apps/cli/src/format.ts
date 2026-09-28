// Human and machine output. JSON output is stable; human output is a compact table.

import { Predicate } from "effect";
import { isJsonArray, isJsonObject, type JsonValue, type JsonObject } from "./json.ts";

/* oxlint-disable no-control-regex -- these match terminal controls on purpose */
const CONTROL_SEQUENCE = /\u001b\[[0-?]*[ -/]*[@-~]|\u009b[0-?]*[ -/]*[@-~]/g;

// OSC, DCS, SOS, PM and APC strings, up to their BEL or ST terminator.
const CONTROL_STRING =
  /(?:\u001b[\]P^_X]|[\u0090\u0098\u009d-\u009f])[^\u0007\u001b\u009c]*(?:\u0007|\u001b\\|\u009c)/g;

const CONTROL = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
/* oxlint-enable no-control-regex */

/**
 * Terminal-safe text from untrusted mail/calendar content: drops escape sequences (CSI, OSC, DCS…)
 * and every C0/C1 control, DEL and bidi override/isolate (which could reorder what is shown), and
 * flattens line breaks and tabs to spaces. Callers that keep lines split on newlines first.
 */
export const sanitize = (text: string): string =>
  text
    .replace(CONTROL_SEQUENCE, "")
    .replace(CONTROL_STRING, "")
    .replace(/[\r\n\t\u2028\u2029]+/g, " ")
    .replace(CONTROL, "");

/** Untrusted text made terminal-safe line by line, keeping its line breaks. */
const safeLines = (text: string): string =>
  text
    .split(/\r\n|[\r\n\u2028\u2029]/)
    .map(sanitize)
    .join("\n");

/** Leaf value as text: primitives via String, anything structured as JSON. */
const leaf = (v: JsonValue | undefined): string =>
  Predicate.isString(v)
    ? v
    : Predicate.isNumber(v) || Predicate.isBoolean(v) || Predicate.isBigInt(v)
      ? String(v)
      : JSON.stringify(v);

export const formatOutput = (value: JsonValue | undefined, json: boolean): string => {
  // Raw exports (vCard/ICS/CSV) are written as-is so `bye contacts export > contacts.vcf` works.
  // Everything else human-readable is terminal-safe: mail and calendar text is untrusted.
  if (Predicate.isString(value) && !json) return value;

  if (json) return JSON.stringify(value ?? null, null, 2);

  if (value === null || value === undefined) return "ok";
  const items = extractItems(value);

  if (items) return items.length === 0 ? "(empty)" : table(items);

  if (isJsonObject(value)) {
    return Object.entries(value)
      .map(([k, v]) => `${sanitize(k)}: ${safeLines(leaf(v))}`)
      .join("\n");
  }

  return safeLines(leaf(value));
};

const extractItems = (value: JsonValue | undefined): ReadonlyArray<JsonObject> | undefined => {
  if (isJsonArray(value)) return value as ReadonlyArray<JsonObject>;

  if (isJsonObject(value)) {
    for (const key of ["items", "results", "threads", "occurrences", "events", "boards"]) {
      const candidate = value[key];

      if (isJsonArray(candidate)) return candidate as ReadonlyArray<JsonObject>;
    }
  }

  return undefined;
};

const PREFERRED = [
  "id",
  "threadId",
  "subject",
  "title",
  "from",
  "sender",
  "start",
  "end",
  "snippet",
  "state",
];

const table = (rows: ReadonlyArray<JsonObject>): string => {
  const keys = [...new Set(rows.flatMap((r) => Object.keys(r)))];

  const columns = [
    ...PREFERRED.filter((k) => keys.includes(k)),
    ...keys.filter((k) => !PREFERRED.includes(k)),
  ].slice(0, 5);

  const cell = (v: JsonValue | undefined): string => {
    const flat = sanitize(v === undefined || v === null ? "" : leaf(v));

    return flat.length > 48 ? `${flat.slice(0, 47)}…` : flat;
  };

  const widths = columns.map((c) =>
    Math.max(sanitize(c).length, ...rows.map((r) => cell(r[c]).length)),
  );

  const line = (values: ReadonlyArray<string>) =>
    values
      .map((v, i) => v.padEnd(widths[i]!))
      .join("  ")
      .trimEnd();

  return [
    line(columns.map(sanitize)),
    line(widths.map((w) => "-".repeat(w))),
    ...rows.map((r) => line(columns.map((c) => cell(r[c])))),
  ].join("\n");
};
