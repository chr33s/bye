import type { DnsRecord, DnsRecordType } from "./domains.ts";

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
  emailRoutingEnabled(zoneId: string): Promise<boolean>;
  enableEmailRouting(zoneId: string): Promise<void>;
  /** Catch-all rule delivering every address to the MailCore Worker (aliases live in D1). */
  catchAllToWorker(zoneId: string, workerName: string): Promise<void>;
  catchAllWorker(zoneId: string): Promise<string | null>;
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
    emailRoutingEnabled: async (zoneId) =>
      (await call<{ enabled?: boolean }>("GET", `/zones/${zoneId}/email/routing`)).enabled === true,
    enableEmailRouting: async (zoneId) =>
      void (await call("POST", `/zones/${zoneId}/email/routing/enable`, {})),
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
      }>("GET", `/zones/${zoneId}/email/routing/rules/catch_all`);
      const action = rule.enabled ? rule.actions?.find((a) => a.type === "worker") : undefined;
      return action?.value?.[0] ?? null;
    },
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
