import { Schema } from "effect";
import { decode } from "./schemas.ts";
import { record, rows } from "./discover.ts";

/** beta.10's generated command index has no legacy Worker domains/routes/schedules/settings reads.
 * Exception owner: deployment maintainers. These GET-only paths are tested in metadata.test.ts.
 * Product writes still use cf; this adapter cannot mutate or choose an arbitrary URL.
 */
export interface WorkerMetadata {
  domains(): Promise<ReadonlyArray<Schema.Schema.Type<typeof Schema.Json>>>;
  settings(worker: string): Promise<Schema.Schema.Type<typeof Schema.Json>>;
  schedules(worker: string): Promise<Schema.Schema.Type<typeof Schema.Json>>;
  subdomain(worker: string): Promise<Schema.Schema.Type<typeof Schema.Json>>;
  routes(zoneId: string): Promise<ReadonlyArray<Schema.Schema.Type<typeof Schema.Json>>>;
}

export const workerMetadata = (options: {
  readonly accountId: string;
  readonly apiToken: string;
  readonly fetcher?: typeof fetch;
}): WorkerMetadata => {
  if (!/^[a-f0-9]{32}$/.test(options.accountId) || !options.apiToken)
    throw new Error("explicit metadata account/token required");

  const segment = (value: string) => {
    if (!/^[a-zA-Z0-9_-]+$/.test(value)) throw new Error("invalid metadata identity");

    return encodeURIComponent(value);
  };

  const get = async (path: string) => {
    const response = await (options.fetcher ?? fetch)(
      `https://api.cloudflare.com/client/v4${path}`,
      {
        method: "GET",
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
        headers: { authorization: `Bearer ${options.apiToken}` },
      },
    );

    if (!response.ok) throw new Error("Cloudflare metadata read failed");
    const body = record(decode(Schema.Json, await response.json()));

    if (body.success !== true) throw new Error("Cloudflare metadata API rejected read");

    return decode(Schema.Json, body.result);
  };

  const scripts = `/accounts/${options.accountId}/workers/scripts`;

  return {
    domains: async () => rows(await get(`/accounts/${options.accountId}/workers/domains`)),
    settings: (worker) => get(`${scripts}/${segment(worker)}/settings`),
    schedules: (worker) => get(`${scripts}/${segment(worker)}/schedules`),
    subdomain: (worker) => get(`${scripts}/${segment(worker)}/subdomain`),
    routes: async (zoneId) => rows(await get(`/zones/${segment(zoneId)}/workers/routes`)),
  };
};
