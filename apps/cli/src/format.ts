// Human and machine output. JSON output is stable; human output is a compact table.

/** Leaf value as text: primitives via String, anything structured as JSON. */
const leaf = (v: unknown): string =>
  typeof v === "string"
    ? v
    : typeof v === "number" || typeof v === "boolean" || typeof v === "bigint"
      ? String(v)
      : JSON.stringify(v);

export const formatOutput = (value: unknown, json: boolean): string => {
  // Raw exports (vCard/ICS/CSV) are written as-is so `bye contacts export > contacts.vcf` works.
  if (typeof value === "string" && !json) return value;
  if (json) return JSON.stringify(value ?? null, null, 2);
  if (value === null || value === undefined) return "ok";
  const items = extractItems(value);
  if (items) return items.length === 0 ? "(empty)" : table(items);
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => `${k}: ${leaf(v)}`)
      .join("\n");
  }
  return leaf(value);
};

const extractItems = (value: unknown): ReadonlyArray<Record<string, unknown>> | undefined => {
  if (Array.isArray(value)) return value as Array<Record<string, unknown>>;
  if (typeof value === "object" && value !== null) {
    for (const key of ["items", "results", "threads", "occurrences", "events", "boards"]) {
      const candidate = (value as Record<string, unknown>)[key];
      if (Array.isArray(candidate)) return candidate as Array<Record<string, unknown>>;
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

const table = (rows: ReadonlyArray<Record<string, unknown>>): string => {
  const keys = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const columns = [
    ...PREFERRED.filter((k) => keys.includes(k)),
    ...keys.filter((k) => !PREFERRED.includes(k)),
  ].slice(0, 5);
  const cell = (v: unknown): string => {
    const s = v === undefined || v === null ? "" : leaf(v);
    // oxlint-disable-next-line no-control-regex -- intentional control-char match
    const flat = s.replace(/[\r\n\t]+/g, " ").replace(/[\u0000-\u001f\u007f\u001b]/g, "");
    return flat.length > 48 ? `${flat.slice(0, 47)}…` : flat;
  };
  const widths = columns.map((c) => Math.max(c.length, ...rows.map((r) => cell(r[c]).length)));
  const line = (values: ReadonlyArray<string>) =>
    values
      .map((v, i) => v.padEnd(widths[i]!))
      .join("  ")
      .trimEnd();
  return [
    line(columns),
    line(widths.map((w) => "-".repeat(w))),
    ...rows.map((r) => line(columns.map((c) => cell(r[c])))),
  ].join("\n");
};
