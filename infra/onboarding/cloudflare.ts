// The few Cloudflare API reads onboarding makes itself with the operator's OAuth token: verify
// the selected account, find its workers.dev subdomain, and detect Worker-name collisions. All
// writes go through the existing Alchemy stack (executor.ts), never through this client.
import type { Fetch } from "./oauth.ts";

export const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";

export interface Account {
  readonly id: string;
  readonly name: string;
}

export class CloudflareApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface CloudflareReader {
  accounts(token: string): Promise<ReadonlyArray<Account>>;
  /** The account's workers.dev subdomain, or null when none is registered. */
  workersSubdomain(token: string, accountId: string): Promise<string | null>;
  workerNames(token: string, accountId: string): Promise<ReadonlyArray<string>>;
}

export const cloudflareReader = (fetcher: Fetch, base = CLOUDFLARE_API): CloudflareReader => {
  const get = async <T>(
    token: string,
    path: string,
  ): Promise<{ status: number; result: T | null }> => {
    let r: Response;
    try {
      r = await fetcher(`${base}${path}`, {
        headers: { authorization: `Bearer ${token}`, accept: "application/json" },
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new CloudflareApiError(0, "the Cloudflare API could not be reached");
    }
    const body = (await r.json().catch(() => ({}))) as { result?: T };
    return { status: r.status, result: r.ok ? (body.result ?? null) : null };
  };
  const fail = (status: number, what: string) =>
    new CloudflareApiError(
      status,
      status === 401 || status === 403
        ? `Cloudflare refused ${what}; reconnect and grant the requested access`
        : `Cloudflare returned ${status} for ${what}`,
    );
  return {
    async accounts(token) {
      // User-scoped OAuth tokens see an empty GET /accounts; memberships are the authoritative
      // list (as in Wrangler and Alchemy). /accounts stays as the fallback.
      const m = await get<
        Array<{ status?: string; account?: { id: string; name: string } | null }>
      >(token, "/memberships?per_page=50");
      const viaMemberships =
        m.status === 200 && m.result
          ? m.result.flatMap((x) =>
              x.account && (x.status === undefined || x.status === "accepted")
                ? [{ id: x.account.id, name: x.account.name }]
                : [],
            )
          : [];
      if (viaMemberships.length > 0) return viaMemberships;
      const r = await get<Array<{ id: string; name: string }>>(token, "/accounts?per_page=50");
      if (r.status !== 200 || !r.result) throw fail(r.status, "the account list");
      return r.result.map((a) => ({ id: a.id, name: a.name }));
    },
    async workersSubdomain(token, accountId) {
      const r = await get<{ subdomain?: string }>(
        token,
        `/accounts/${encodeURIComponent(accountId)}/workers/subdomain`,
      );
      if (r.status === 404) return null;
      if (r.status !== 200) throw fail(r.status, "the workers.dev subdomain");
      return r.result?.subdomain || null;
    },
    async workerNames(token, accountId) {
      const r = await get<Array<{ id: string }>>(
        token,
        `/accounts/${encodeURIComponent(accountId)}/workers/scripts`,
      );
      if (r.status !== 200 || !r.result) throw fail(r.status, "the Worker list");
      return r.result.map((w) => w.id);
    },
  };
};
