// Deep-link contract shared by every native shell (X01). A native URL is mapped to a PWA hash
// route; anything not on the allowlist is ignored. The Rust (desktop), Swift (iOS) and Kotlin
// (Android) shells implement the same mapping and are tested against deeplink-vectors.json.

import { isMailView } from "./views.ts";

const COMPOSE_PARAMS = ["to", "cc", "subject", "body", "text", "url", "thread"] as const;

const ID = /^[a-z]{3}_[0-9a-z]{20,40}$/;

const MAX_PARAM = 4096;

const encode = (params: ReadonlyArray<readonly [string, string]>): string =>
  params.length === 0
    ? ""
    : `?${params.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&")}`;

const pick = (
  search: URLSearchParams,
  keys: ReadonlyArray<string>,
): Array<readonly [string, string]> =>
  keys.flatMap((k) => {
    const v = search.get(k);

    return v === null || v.length > MAX_PARAM ? [] : [[k, v] as const];
  });

/** Map `bye://…` or `mailto:…` to a PWA hash route (without the leading origin), or null. */
export const deepLinkToRoute = (raw: string): string | null => {
  let url: URL;

  try {
    url = new URL(raw);
  } catch {
    return null;
  }

  if (url.protocol === "mailto:") {
    let to: string;

    try {
      to = decodeURIComponent(url.pathname);
    } catch {
      return null;
    }

    if (to.length > MAX_PARAM || /[\r\n]/.test(to)) return null;
    const rest = pick(url.searchParams, ["cc", "subject", "body"]);

    return `#/compose${encode([...(to ? [["to", to] as const] : []), ...rest])}`;
  }

  if (url.protocol !== "bye:") return null;
  // bye://mail/imbox → host "mail", path "/imbox"
  let segments: Array<string>;

  try {
    segments = [url.hostname, ...url.pathname.split("/")].flatMap((s) =>
      s.length > 0 ? [decodeURIComponent(s)] : [],
    );
  } catch {
    return null;
  }

  const [head, second, ...more] = segments;

  switch (head) {
    case "mail": {
      const view = second ?? "imbox";

      return more.length === 0 && isMailView(view) ? `#/mail/${view}` : null;
    }

    case "thread":
      return second && ID.test(second) && more.length === 0 ? `#/thread/${second}` : null;
    case "compose":
      return second === undefined
        ? `#/compose${encode(pick(url.searchParams, COMPOSE_PARAMS))}`
        : null;
    case "calendar":
      return second === undefined ? "#/calendar" : null;
    case "search":
      return second === undefined ? `#/search${encode(pick(url.searchParams, ["q"]))}` : null;
    default:
      return null;
  }
};
