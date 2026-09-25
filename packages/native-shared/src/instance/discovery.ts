import { normalizeInstanceUrl, type PrivateNetworkPolicy } from "./url.ts";

// Instance validation before anything is saved (spec §10 Instance selection;
// RFC 8414). A candidate is probed without credentials, cookies or account headers; redirects stop
// validation; responses are size- and time-bounded. The compatibility document names the issuer,
// whose metadata is then fetched from the issuer-derived well-known location and must name that
// exact issuer. Every credential endpoint must live on the issuer's origin, so a candidate can't
// pair another issuer's authorization endpoint with its own token endpoint.

export const INSTANCE_SCHEMA = "bye.instance/1";
export const INSTANCE_DOCUMENT_PATH = "/.well-known/bye-instance";
export const AS_METADATA_WELL_KNOWN = "/.well-known/oauth-authorization-server";
/** The /v1 API revisions this client build speaks. */
export const CLIENT_API_RANGE = { min: 1, max: 1 } as const;
/** Without these a client can't sign in safely; the instance is shown as unsupported. */
export const REQUIRED_CAPABILITIES = ["device-session", "authorization-response-iss"] as const;

export const PROBE_TIMEOUT_MS = 10_000;
export const PROBE_MAX_BYTES = 64 * 1024;

export interface ProbeFetchInit {
  readonly method: "GET";
  readonly headers: Record<string, string>;
  readonly credentials: "omit";
  readonly redirect: "manual";
  readonly signal?: AbortSignal;
}

export type ProbeFetch = (
  url: string,
  init: ProbeFetchInit,
) => Promise<{
  readonly status: number;
  /** Final URL when the platform followed a redirect anyway (React Native ignores `manual`). */
  readonly url?: string;
  readonly headers?: { get(name: string): string | null };
  text(): Promise<string>;
}>;

export interface InstanceEndpoints {
  readonly authorization: string;
  readonly token: string;
  readonly revocation: string | null;
  readonly deviceAuthorization: string | null;
}

export interface InstanceRoutes {
  readonly accountDeletion: string | null;
  readonly accountDeletionWeb: string | null;
  readonly support: string | null;
}

/** A validated instance: everything needed to sign in and call the API, nothing secret. */
export interface ValidatedInstance {
  /** Local identity: normalized base URL + validated issuer. */
  readonly key: string;
  readonly baseUrl: string;
  readonly issuer: string;
  readonly endpoints: InstanceEndpoints;
  readonly api: { readonly min: number; readonly max: number };
  readonly capabilities: ReadonlyArray<string>;
  /** Client IDs this instance registered, with their exact redirect URIs. */
  readonly clients: ReadonlyArray<{
    readonly clientId: string;
    readonly redirectUris: ReadonlyArray<string>;
    readonly loopback: boolean;
  }>;
  readonly routes: InstanceRoutes;
  readonly validatedAt: number;
}

export type ProbeResult =
  | { readonly _tag: "Valid"; readonly instance: ValidatedInstance }
  /** Validation stopped at a redirect or canonical-URL change; the new address needs its own probe. */
  | { readonly _tag: "Moved"; readonly location: string | null }
  | { readonly _tag: "Unreachable"; readonly detail: string }
  | { readonly _tag: "Invalid"; readonly reason: ProbeError; readonly detail?: string };

export type ProbeError =
  | "invalid-url"
  | "not-an-instance"
  | "unsupported-schema"
  | "incompatible-version"
  | "missing-capability"
  | "client-not-registered"
  | "invalid-issuer"
  | "invalid-metadata"
  | "issuer-mismatch"
  | "foreign-endpoint"
  | "response-too-large";

export const instanceKey = (baseUrl: string, issuer: string): string => `${baseUrl}|${issuer}`;

export interface ProbeOptions {
  readonly fetch: ProbeFetch;
  /** The client this build signs in as, and the exact callback it will use (null: no browser
   *  callback, e.g. the CLI's device-authorization grant). */
  readonly clientId: string;
  readonly redirectUri: string | null;
  readonly privateNetwork?: PrivateNetworkPolicy;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
  readonly now?: () => number;
}

type Fetched =
  | { readonly _tag: "Json"; readonly body: Record<string, unknown> }
  | { readonly _tag: "Moved"; readonly location: string | null }
  | { readonly _tag: "Unreachable"; readonly detail: string }
  | { readonly _tag: "Invalid"; readonly reason: ProbeError; readonly detail?: string };

const withTimeout = <T>(p: Promise<T>, ms: number, abort: () => void): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      abort();
      reject(new Error("timeout"));
    }, ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });

const getJson = async (url: string, options: ProbeOptions): Promise<Fetched> => {
  const max = options.maxBytes ?? PROBE_MAX_BYTES;
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  try {
    return await withTimeout(
      (async (): Promise<Fetched> => {
        // No cookies, no Authorization, no client certificates: this request carries nothing.
        const response = await options.fetch(url, {
          method: "GET",
          headers: { accept: "application/json" },
          credentials: "omit",
          redirect: "manual",
          ...(controller ? { signal: controller.signal } : {}),
        });
        if (
          (response.status >= 300 && response.status < 400) ||
          response.status === 0 || // opaque redirect (fetch `redirect: "manual"` in browsers)
          (response.url !== undefined && response.url !== "" && response.url !== url)
        ) {
          const location =
            response.headers?.get("location") ??
            (response.url && response.url !== url ? response.url : null);
          return { _tag: "Moved", location };
        }
        if (response.status >= 500 || response.status === 429)
          return { _tag: "Unreachable", detail: `HTTP ${response.status}` };
        if (response.status !== 200) return { _tag: "Invalid", reason: "not-an-instance" };
        const declared = Number(response.headers?.get("content-length") ?? "0");
        if (declared > max) return { _tag: "Invalid", reason: "response-too-large" };
        const text = await response.text();
        if (text.length > max) return { _tag: "Invalid", reason: "response-too-large" };
        try {
          const body = JSON.parse(text) as unknown;
          if (body && typeof body === "object" && !Array.isArray(body))
            return { _tag: "Json", body: body as Record<string, unknown> };
        } catch {
          // fall through
        }
        return { _tag: "Invalid", reason: "not-an-instance" };
      })(),
      options.timeoutMs ?? PROBE_TIMEOUT_MS,
      () => controller?.abort(),
    );
  } catch (error) {
    return {
      _tag: "Unreachable",
      detail: error instanceof Error ? error.message || error.name : "network",
    };
  }
};

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

/** RFC 8414 §3.1: the well-known segment goes between the host and the issuer's path. */
export const metadataUrlFor = (issuer: string): string => {
  const n = normalizeInstanceUrl(issuer, { privateNetwork: "allow" });
  if (!n.ok) throw new Error("invalid issuer");
  return `${n.origin}${AS_METADATA_WELL_KNOWN}${n.path}`;
};

/** An https endpoint on exactly `origin` (query allowed on the authorization endpoint only). */
const endpointOn = (value: unknown, origin: string, allowQuery = false): string | null => {
  const s = str(value);
  if (!s || s.length > 2048 || s.includes("#")) return null;
  const [base, query] = s.split("?", 2) as [string, string | undefined];
  if (query !== undefined && !allowQuery) return null;
  const n = normalizeInstanceUrl(base, { privateNetwork: "allow" });
  if (!n.ok || n.origin !== origin) return null;
  return query === undefined ? n.url : `${n.url}?${query}`;
};

export const probeInstance = async (
  candidate: string,
  options: ProbeOptions,
): Promise<ProbeResult> => {
  const policy = options.privateNetwork ?? "block";
  const target = normalizeInstanceUrl(candidate, { privateNetwork: policy });
  if (!target.ok) return { _tag: "Invalid", reason: "invalid-url", detail: target.reason };

  const doc = await getJson(`${target.url}${INSTANCE_DOCUMENT_PATH}`, options);
  if (doc._tag !== "Json") return doc;
  const d = doc.body;
  if (d.schema !== INSTANCE_SCHEMA) return { _tag: "Invalid", reason: "unsupported-schema" };

  // The canonical base URL must be the one probed; a different one is a move, never a merge.
  const canonical = normalizeInstanceUrl(str(d.baseUrl) ?? "", { privateNetwork: policy });
  if (!canonical.ok) return { _tag: "Invalid", reason: "not-an-instance" };
  if (canonical.url !== target.url) return { _tag: "Moved", location: canonical.url };

  const api = d.api as { min?: unknown; max?: unknown } | undefined;
  const min = typeof api?.min === "number" ? api.min : NaN;
  const max = typeof api?.max === "number" ? api.max : NaN;
  if (!(min <= max) || max < CLIENT_API_RANGE.min || min > CLIENT_API_RANGE.max)
    return {
      _tag: "Invalid",
      reason: "incompatible-version",
      detail: `server ${min}–${max}, app ${CLIENT_API_RANGE.min}–${CLIENT_API_RANGE.max}`,
    };

  const capabilities = Array.isArray(d.capabilities)
    ? d.capabilities.filter((c): c is string => typeof c === "string" && c.length <= 64)
    : [];
  const missing = REQUIRED_CAPABILITIES.filter((c) => !capabilities.includes(c));
  if (missing.length)
    return { _tag: "Invalid", reason: "missing-capability", detail: missing.join(", ") };

  const clients = (Array.isArray(d.clients) ? d.clients : []).flatMap((c: unknown) => {
    const o = c as { clientId?: unknown; redirectUris?: unknown; loopback?: unknown } | null;
    const clientId = str(o?.clientId);
    if (!clientId) return [];
    const redirectUris = Array.isArray(o?.redirectUris)
      ? o.redirectUris.filter((u): u is string => typeof u === "string")
      : [];
    return [{ clientId, redirectUris, loopback: o?.loopback === true }];
  });
  const ours = clients.find((c) => c.clientId === options.clientId);
  const redirect = options.redirectUri;
  const loopback =
    redirect !== null && /^http:\/\/127\.0\.0\.1:\d{4,5}\/oauth\/callback$/.test(redirect);
  if (
    !ours ||
    (redirect !== null && !(ours.redirectUris.includes(redirect) || (loopback && ours.loopback)))
  )
    return { _tag: "Invalid", reason: "client-not-registered", detail: options.clientId };

  const issuerUrl = normalizeInstanceUrl(str(d.issuer) ?? "", { privateNetwork: policy });
  if (!issuerUrl.ok) return { _tag: "Invalid", reason: "invalid-issuer" };
  const issuer = issuerUrl.url;

  // Endpoints come only from the issuer-derived metadata location, never from the candidate.
  const meta = await getJson(metadataUrlFor(issuer), options);
  if (meta._tag !== "Json")
    return meta._tag === "Invalid" && meta.reason === "not-an-instance"
      ? { _tag: "Invalid", reason: "invalid-metadata" }
      : meta;
  const m = meta.body;
  if (m.issuer !== issuer) return { _tag: "Invalid", reason: "issuer-mismatch" };
  if (m.authorization_response_iss_parameter_supported !== true)
    return { _tag: "Invalid", reason: "missing-capability", detail: "authorization-response-iss" };
  if (
    !Array.isArray(m.code_challenge_methods_supported) ||
    !m.code_challenge_methods_supported.includes("S256")
  )
    return { _tag: "Invalid", reason: "invalid-metadata", detail: "S256" };

  const authorization = endpointOn(m.authorization_endpoint, issuerUrl.origin, true);
  const token = endpointOn(m.token_endpoint, issuerUrl.origin);
  if (!authorization || !token) return { _tag: "Invalid", reason: "foreign-endpoint" };
  const optional = (v: unknown): string | null | false =>
    v === undefined ? null : (endpointOn(v, issuerUrl.origin) ?? false);
  const revocation = optional(m.revocation_endpoint);
  const deviceAuthorization = optional(m.device_authorization_endpoint);
  if (revocation === false || deviceAuthorization === false)
    return { _tag: "Invalid", reason: "foreign-endpoint" };

  // Descriptive routes are kept only on the instance's own or its issuer's origin.
  const routes = (d.routes ?? {}) as Record<string, unknown>;
  const route = (v: unknown): string | null => {
    const s = str(v);
    if (!s || s.length > 2048) return null;
    const [base] = s.split(/[?#]/, 1) as [string];
    const n = normalizeInstanceUrl(base, { privateNetwork: policy });
    return n.ok && (n.origin === target.origin || n.origin === issuerUrl.origin) ? s : null;
  };

  return {
    _tag: "Valid",
    instance: {
      key: instanceKey(target.url, issuer),
      baseUrl: target.url,
      issuer,
      endpoints: { authorization, token, revocation, deviceAuthorization },
      api: { min, max },
      capabilities,
      clients,
      routes: {
        accountDeletion: route(routes.accountDeletion),
        accountDeletionWeb: route(routes.accountDeletionWeb),
        support: route(routes.support),
      },
      validatedAt: (options.now ?? Date.now)(),
    },
  };
};

/** The origin credentials go to, when it differs from the instance's own (shown before confirming). */
export const distinctAuthOrigin = (instance: ValidatedInstance): string | null => {
  const base = normalizeInstanceUrl(instance.baseUrl, { privateNetwork: "allow" });
  const issuer = normalizeInstanceUrl(instance.issuer, { privateNetwork: "allow" });
  if (!base.ok || !issuer.ok) return null;
  return base.origin === issuer.origin ? null : issuer.origin;
};

/** Same credential destinations: a change requires new authorization, never silent migration. */
export const sameCredentialDestinations = (a: ValidatedInstance, b: ValidatedInstance): boolean =>
  a.baseUrl === b.baseUrl &&
  a.issuer === b.issuer &&
  a.endpoints.authorization === b.endpoints.authorization &&
  a.endpoints.token === b.endpoints.token &&
  a.endpoints.revocation === b.endpoints.revocation &&
  a.endpoints.deviceAuthorization === b.endpoints.deviceAuthorization;

export const hasCapability = (instance: ValidatedInstance, name: string): boolean =>
  instance.capabilities.includes(name);

export const PROBE_ERRORS: Readonly<Record<ProbeError, string>> = {
  "invalid-url": "That isn't a valid server address.",
  "not-an-instance": "No compatible bye server was found at that address.",
  "unsupported-schema": "This server uses a setup format this app doesn't support. Update the app.",
  "incompatible-version":
    "This server's version isn't supported by this app. Update the app or the server.",
  "missing-capability":
    "This server doesn't support secure app sign-in yet. Ask its operator to update it.",
  "client-not-registered": "This server hasn't enabled this app. Ask its operator to register it.",
  "invalid-issuer": "This server's sign-in configuration is invalid.",
  "invalid-metadata": "This server's sign-in configuration couldn't be read.",
  "issuer-mismatch": "This server's sign-in configuration doesn't match its identity.",
  "foreign-endpoint": "This server sends sign-in to an unexpected address, so it was not added.",
  "response-too-large": "This server's response was too large.",
};
