import type { DnsRecord, DnsRecordType, EmailRoutingRule } from "./domains.ts";

// Narrow Cloudflare API adapter for customer-domain onboarding (O01) and public cache purge (P01).
// Uses a separately scoped, revocable token (Zone:DNS edit, Email Routing edit / Cache Purge) held
// only by MailCore; it is never the deployment management token (§15.5).

export interface CloudflareDnsRecord extends DnsRecord {
  readonly id: string;
}

export interface CloudflareApi {
  findZone(name: string): Promise<{ readonly id: string; readonly name: string } | null>;
  listDns(zoneId: string, name: string): Promise<ReadonlyArray<CloudflareDnsRecord>>;
  createDns(zoneId: string, record: DnsRecord): Promise<void>;
  updateDns(zoneId: string, id: string, record: DnsRecord): Promise<void>;
  /** Only for an explicitly confirmed MX cutover or a rollback to the recorded snapshot. */
  deleteDns(zoneId: string, id: string): Promise<void>;
  emailRoutingEnabled(zoneId: string): Promise<boolean>;
  enableEmailRouting(zoneId: string): Promise<void>;
  /** Rollback only: restores a zone whose Email Routing was off before the cutover. */
  disableEmailRouting(zoneId: string): Promise<void>;
  /** Catch-all rule delivering every address to the MailCore Worker (aliases live in D1). */
  catchAllToWorker(zoneId: string, workerName: string): Promise<void>;
  /** Rollback only: turns the catch-all rule off (no Worker receives unmatched mail). */
  disableCatchAll(zoneId: string): Promise<void>;
  catchAllWorker(zoneId: string): Promise<string | null>;
  /** The full catch-all rule (any action: worker, forward, drop), or null when none is set. */
  catchAllRule(zoneId: string): Promise<EmailRoutingRule | null>;
  /** Rollback only: puts a recorded catch-all rule back exactly as it was. */
  putCatchAll(zoneId: string, rule: EmailRoutingRule): Promise<void>;
  /** Address rules (not the catch-all), bounded to the first page. */
  routingRules(zoneId: string): Promise<ReadonlyArray<EmailRoutingRule>>;
  purgeUrls(zoneId: string, urls: ReadonlyArray<string>): Promise<void>;
}

export type CloudflareFetch = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<Response>;

export class CloudflareApiError extends Error {
  override readonly name = "CloudflareApiError";
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const API = "https://api.cloudflare.com/client/v4";

interface RawRule {
  enabled?: boolean;
  name?: string;
  matchers?: Array<{ type: string; field?: string; value?: string }>;
  actions?: Array<{ type: string; value?: Array<string> }>;
}

const toRule = (r: RawRule): EmailRoutingRule => ({
  enabled: r.enabled === true,
  ...(r.name !== undefined ? { name: r.name } : {}),
  matchers: (r.matchers ?? []).map((m) => ({
    type: m.type,
    ...(m.field !== undefined ? { field: m.field } : {}),
    ...(m.value !== undefined ? { value: m.value } : {}),
  })),
  actions: (r.actions ?? []).map((a) => ({
    type: a.type,
    ...(a.value !== undefined ? { value: [...a.value] } : {}),
  })),
});

export const cloudflareApi = (token: string, fetchFn: CloudflareFetch): CloudflareApi => {
  const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const response = await fetchFn(`${API}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = (await response.json().catch(() => ({}))) as {
      success?: boolean;
      result?: T;
      errors?: Array<{ message?: string }>;
    };
    if (!response.ok || data.success === false)
      throw new CloudflareApiError(
        response.status,
        data.errors?.[0]?.message ?? `cloudflare ${method} ${path} failed`,
      );
    return data.result as T;
  };
  const toRecord = (r: {
    id: string;
    type: string;
    name: string;
    content: string;
    priority?: number;
  }): CloudflareDnsRecord => ({
    id: r.id,
    type: r.type as DnsRecordType,
    name: r.name,
    content: r.content,
    ...(r.priority !== undefined ? { priority: r.priority } : {}),
  });
  const payload = (record: DnsRecord) => ({
    type: record.type,
    name: record.name,
    content: record.content,
    ttl: 1,
    ...(record.priority !== undefined ? { priority: record.priority } : {}),
  });
  return {
    findZone: async (name) => {
      const zones = await call<Array<{ id: string; name: string }>>(
        "GET",
        `/zones?name=${encodeURIComponent(name)}`,
      );
      return zones[0] ?? null;
    },
    listDns: async (zoneId, name) =>
      (
        await call<
          Array<{ id: string; type: string; name: string; content: string; priority?: number }>
        >("GET", `/zones/${zoneId}/dns_records?name=${encodeURIComponent(name)}&per_page=100`)
      ).map(toRecord),
    createDns: async (zoneId, record) =>
      void (await call("POST", `/zones/${zoneId}/dns_records`, payload(record))),
    updateDns: async (zoneId, id, record) =>
      void (await call("PATCH", `/zones/${zoneId}/dns_records/${id}`, payload(record))),
    deleteDns: async (zoneId, id) =>
      void (await call("DELETE", `/zones/${zoneId}/dns_records/${id}`)),
    emailRoutingEnabled: async (zoneId) =>
      (await call<{ enabled?: boolean }>("GET", `/zones/${zoneId}/email/routing`)).enabled === true,
    enableEmailRouting: async (zoneId) =>
      void (await call("POST", `/zones/${zoneId}/email/routing/enable`, {})),
    disableEmailRouting: async (zoneId) =>
      void (await call("POST", `/zones/${zoneId}/email/routing/disable`, {})),
    disableCatchAll: async (zoneId) =>
      void (await call("PUT", `/zones/${zoneId}/email/routing/rules/catch_all`, {
        enabled: false,
        name: "bye catch-all",
        matchers: [{ type: "all" }],
        actions: [{ type: "drop" }],
      })),
    catchAllToWorker: async (zoneId, workerName) =>
      void (await call("PUT", `/zones/${zoneId}/email/routing/rules/catch_all`, {
        enabled: true,
        name: "bye catch-all",
        matchers: [{ type: "all" }],
        actions: [{ type: "worker", value: [workerName] }],
      })),
    catchAllWorker: async (zoneId) => {
      const rule = await call<{
        enabled?: boolean;
        actions?: Array<{ type: string; value?: Array<string> }>;
      } | null>("GET", `/zones/${zoneId}/email/routing/rules/catch_all`);
      const action = rule?.enabled ? rule.actions?.find((a) => a.type === "worker") : undefined;
      return action?.value?.[0] ?? null;
    },
    catchAllRule: async (zoneId) => {
      const rule = await call<RawRule | null>(
        "GET",
        `/zones/${zoneId}/email/routing/rules/catch_all`,
      );
      return rule && Array.isArray(rule.actions) ? toRule(rule) : null;
    },
    putCatchAll: async (zoneId, rule) =>
      void (await call("PUT", `/zones/${zoneId}/email/routing/rules/catch_all`, {
        enabled: rule.enabled,
        name: rule.name ?? "catch-all",
        matchers: rule.matchers.length > 0 ? rule.matchers : [{ type: "all" }],
        actions: rule.actions,
      })),
    routingRules: async (zoneId) =>
      (
        (await call<Array<RawRule> | null>(
          "GET",
          `/zones/${zoneId}/email/routing/rules?per_page=50`,
        )) ?? []
      )
        // The catch-all is read separately; the list may include it.
        .filter((r) => !(r.matchers ?? []).some((m) => m.type === "all"))
        .map(toRule),
    purgeUrls: async (zoneId, urls) => {
      // The purge API accepts at most 30 URLs per request.
      for (let i = 0; i < urls.length; i += 30)
        await call("POST", `/zones/${zoneId}/purge_cache`, { files: urls.slice(i, i + 30) });
    },
  };
};

/** DNS-over-HTTPS lookup used to verify public answers independent of the zone API. */
export const dohResolver =
  (fetchFn: CloudflareFetch) =>
  async (name: string, type: DnsRecordType): Promise<ReadonlyArray<DnsRecord>> => {
    const response = await fetchFn(
      `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${type}`,
      { headers: { accept: "application/dns-json" } },
    );
    if (!response.ok) throw new Error(`DoH ${type} ${name} failed`);
    const data = (await response.json()) as {
      Answer?: Array<{ name: string; type: number; data: string }>;
    };
    const code = { MX: 15, TXT: 16, CNAME: 5 }[type];
    return (data.Answer ?? [])
      .filter((a) => a.type === code)
      .map((a) => {
        const name0 = a.name.replace(/\.$/, "");
        if (type === "MX") {
          const [prio, host] = a.data.split(/\s+/);
          return {
            type,
            name: name0,
            content: (host ?? "").replace(/\.$/, ""),
            priority: Number(prio),
          };
        }
        return {
          type,
          name: name0,
          content:
            type === "TXT"
              ? a.data.replace(/^"|"$/g, "").replace(/" "/g, "")
              : a.data.replace(/\.$/, ""),
        };
      });
  };
