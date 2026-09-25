/** Canonical calendar address: `mailto:` stripped, trimmed, lower-cased (RFC 5545 CAL-ADDRESS). */
export const calNormAddress = (value: string | undefined): string =>
  (value ?? "")
    .trim()
    .replace(/^mailto:/i, "")
    .toLowerCase();
