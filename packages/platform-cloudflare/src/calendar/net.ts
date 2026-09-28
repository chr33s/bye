import { Effect, Layer, Predicate } from "effect";
import {
  CalendarFeedFetcher,
  CalendarFetchFailure,
  type CalendarFetchOutcome,
  LocationSearch,
  LocationSearchFailure,
} from "@bye/application";
import { isForbiddenIp, isForbiddenProxyTarget } from "@bye/mail-codec";
import { calendarError } from "./types.ts";

// Outbound network policy for the calendar (C05, C10, §9): subscription URL validation, the
// resolve-then-check SSRF guard, the bounded feed fetcher, and the location provider. The SSRF
// rules are mail-codec's (the image proxy's) — one definition of a forbidden destination.

/**
 * Validate an external subscription URL: https on the default port only (webcal is rewritten),
 * no credentials, and no forbidden destination. Integer, hex and octal hosts are normalized to
 * dotted IPv4 by the URL parser and then checked like any other literal.
 */
export const calendarValidateFeedUrl = (raw: string): string => {
  let url: URL;

  try {
    url = new URL(raw.trim().replace(/^webcals?:\/\//i, "https://"));
  } catch {
    throw calendarError("bad_request", "invalid subscription URL");
  }

  if (url.protocol !== "https:") throw calendarError("bad_request", "subscriptions require https");

  if (url.username || url.password)
    throw calendarError("bad_request", "credentials in URL are not allowed");

  if (url.port && url.port !== "443")
    throw calendarError("bad_request", "non-standard ports are not allowed");

  if (isForbiddenProxyTarget(url.toString()))
    throw calendarError("bad_request", "private destinations are not allowed");

  return url.toString();
};

/**
 * Read a body up to `maxBytes`: `null` (and the stream cancelled at once) when it is larger, so an
 * oversized or unannounced chunked body is never buffered. A declared Content-Length over the cap
 * is refused before reading.
 */
export const readBounded = async (
  source: Request | Response,
  maxBytes: number,
): Promise<Uint8Array | null> => {
  if (Number(source.headers.get("content-length") ?? "0") > maxBytes) return null;

  if (!source.body) return new Uint8Array(0);
  const reader = source.body.getReader();
  const chunks: Array<Uint8Array> = [];
  let total = 0;

  for (;;) {
    const { done, value } = await reader.read();

    if (done) break;
    total += value.byteLength;

    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);

      return null;
    }

    chunks.push(value);
  }

  const out = new Uint8Array(total);
  let offset = 0;

  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }

  return out;
};

/** Thrown before any request is sent when a destination resolves to a forbidden address. */
export class CalendarSsrfBlocked extends Error {
  override readonly name = "CalendarSsrfBlocked";
}

interface DohAnswer {
  readonly type: number;
  readonly data: string;
}

/**
 * Resolve-then-check SSRF guard for outbound subscription fetches (C05, §9). Every hostname is
 * resolved over DNS-over-HTTPS (A and AAAA, concurrently) and the request is refused if any answer
 * is forbidden. Residual risk: the platform resolves again when it connects (time-of-check/
 * time-of-use); closing that needs an egress proxy that pins the checked address — a documented
 * deployment gate.
 */
export const calendarResolvingFetch = (
  fetchFn: typeof fetch,
  dohFetch: typeof fetch = fetchFn,
): typeof fetch =>
  (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(
      Predicate.isString(input) ? input : input instanceof URL ? input.toString() : input.url,
    );

    const host = url.hostname.replace(/^\[|\]$/g, "");

    if (/^[\d.]+$/.test(host) || host.includes(":")) {
      if (isForbiddenIp(host)) throw new CalendarSsrfBlocked("destination address is not allowed");
    } else {
      const lookup = async (type: "A" | "AAAA"): Promise<ReadonlyArray<string>> => {
        const response = await dohFetch(
          `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=${type}`,
          { headers: { accept: "application/dns-json" } },
        );

        if (!response.ok) throw new CalendarSsrfBlocked("destination could not be resolved");
        const body = (await response.json()) as { Answer?: ReadonlyArray<DohAnswer> };

        return (body.Answer ?? []).filter((a) => a.type === 1 || a.type === 28).map((a) => a.data);
      };

      const answers = (await Promise.all([lookup("A"), lookup("AAAA")])).flat();

      if (answers.length === 0) throw new CalendarSsrfBlocked("destination did not resolve");

      if (answers.some((ip) => isForbiddenIp(ip)))
        throw new CalendarSsrfBlocked("destination resolves to a forbidden address");
    }

    return fetchFn(input, init);
  }) as typeof fetch;

/**
 * Subscription fetcher over `fetch`: https only, every redirect hop revalidated, bounded body,
 * timeout, conditional validators. Wrap `fetchFn` in `calendarResolvingFetch` to also check the
 * addresses each hostname resolves to (DNS rebinding).
 */
export const calendarFeedFetcherLive = (
  fetchFn: typeof fetch,
  options: { timeoutMs?: number; maxRedirects?: number } = {},
) =>
  Layer.succeed(CalendarFeedFetcher, {
    fetch: (request) =>
      Effect.tryPromise({
        try: async (): Promise<CalendarFetchOutcome | CalendarFetchFailure> => {
          let url = request.url;

          for (let hop = 0; hop <= (options.maxRedirects ?? 3); hop++) {
            try {
              url = calendarValidateFeedUrl(url);
            } catch (error) {
              return new CalendarFetchFailure({
                reason: "blocked",
                detail: error instanceof Error ? error.message : "blocked",
              });
            }

            const headers: ConditionalRequestHeaders = {
              accept: "text/calendar, text/plain;q=0.5",
            };

            if (request.etag) headers["if-none-match"] = request.etag;

            if (request.lastModified) headers["if-modified-since"] = request.lastModified;

            const response = await fetchFn(url, {
              headers,
              redirect: "manual",
              signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
            });

            if (response.status >= 300 && response.status < 400 && response.status !== 304) {
              const location = response.headers.get("location");

              if (!location)
                return new CalendarFetchFailure({
                  reason: "http",
                  detail: "redirect without location",
                });
              url = new URL(location, url).toString();
              continue;
            }

            if (response.status === 304) return { status: "not-modified" };

            if (!response.ok)
              return new CalendarFetchFailure({
                reason: "http",
                detail: `status ${response.status}`,
              });
            const type = (response.headers.get("content-type") ?? "").toLowerCase();

            if (type && !/text\/calendar|text\/plain|application\/octet-stream/.test(type))
              return new CalendarFetchFailure({
                reason: "content-type",
                detail: type.split(";")[0] ?? type,
              });
            const bytes = await readBounded(response, request.maxBytes);

            if (bytes === null)
              return new CalendarFetchFailure({
                reason: "too-large",
                detail: `over ${request.maxBytes} bytes`,
              });
            const etag = response.headers.get("etag") ?? undefined;
            const lastModified = response.headers.get("last-modified") ?? undefined;

            const fetched: FetchedCalendarBody = {
              status: "ok",
              body: new TextDecoder().decode(bytes),
            };

            if (etag) fetched.etag = etag;

            if (lastModified) fetched.lastModified = lastModified;

            return fetched;
          }

          return new CalendarFetchFailure({ reason: "http", detail: "too many redirects" });
        },
        catch: (error) =>
          new CalendarFetchFailure({
            reason:
              error instanceof Error && error.name === "CalendarSsrfBlocked"
                ? "blocked"
                : error instanceof Error && error.name === "TimeoutError"
                  ? "timeout"
                  : "network",
            detail:
              error instanceof Error
                ? error.name === "CalendarSsrfBlocked"
                  ? error.message
                  : error.name
                : "network",
          }),
      }).pipe(
        Effect.flatMap((r) =>
          r instanceof CalendarFetchFailure ? Effect.fail(r) : Effect.succeed(r),
        ),
      ),
  });

/**
 * Location autocomplete adapter (C10, §9). A geocoding provider behind the LocationSearch service;
 * without an API key it returns no suggestions rather than inventing data. Only the query text and
 * optional proximity leave the platform; no account identifiers are sent.
 */
export const CALENDAR_GEOCODER_ENDPOINT = "https://api.mapbox.com/search/geocode/v6/forward";

export const calendarLocationSearchLive = (
  apiKey: string | undefined,
  fetchFn: typeof fetch = (input, init) => fetch(input, init),
) =>
  Layer.succeed(LocationSearch, {
    search: (query) =>
      apiKey
        ? Effect.tryPromise({
            try: async () => {
              const url = new URL(CALENDAR_GEOCODER_ENDPOINT);
              url.searchParams.set("q", query.text);
              url.searchParams.set("limit", String(Math.min(Math.max(query.limit, 1), 10)));
              url.searchParams.set("autocomplete", "true");

              if (query.near)
                url.searchParams.set("proximity", `${query.near.longitude},${query.near.latitude}`);
              url.searchParams.set("access_token", apiKey);

              const response = await fetchFn(url.toString(), {
                headers: { accept: "application/json" },
                signal: AbortSignal.timeout(5_000),
              });

              if (!response.ok) throw new Error(`geocoder status ${response.status}`);

              const body = (await response.json()) as {
                features?: ReadonlyArray<{
                  id?: string;
                  properties?: {
                    name?: string;
                    full_address?: string;
                    place_formatted?: string;
                    mapbox_id?: string;
                    coordinates?: { latitude?: number; longitude?: number };
                  };
                }>;
              };

              return (body.features ?? []).slice(0, query.limit).map((f) => {
                const p = f.properties ?? {};

                const place: GeocodedPlace = { label: p.name ?? p.full_address ?? "Unknown place" };

                const address = p.full_address ?? p.place_formatted;
                const providerId = p.mapbox_id ?? f.id;

                if (address) place.address = address;

                if (p.coordinates?.latitude !== undefined) place.latitude = p.coordinates.latitude;

                if (p.coordinates?.longitude !== undefined)
                  place.longitude = p.coordinates.longitude;

                if (providerId) place.providerId = providerId;

                return place;
              });
            },
            catch: (error) =>
              new LocationSearchFailure({
                detail: error instanceof Error ? error.message : "geocoder failed",
              }),
          })
        : Effect.succeed([]),
  });

type ConditionalRequestHeaders = {
  accept: string;
  "if-none-match"?: string;
  "if-modified-since"?: string;
};

type FetchedCalendarBody = {
  status: "ok";
  body: string;
  etag?: string;
  lastModified?: string;
};

type GeocodedPlace = {
  label: string;
  address?: string;
  latitude?: number;
  longitude?: number;
  providerId?: string;
};
