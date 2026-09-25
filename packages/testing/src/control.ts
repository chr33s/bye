import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { D1Like, D1SessionLike, D1StatementLike } from "@bye/platform-cloudflare";
import { openCloudflareSqlite } from "./sqlite.ts";

type Bound = Array<string | number | null | Uint8Array>;

class MemoryD1Statement implements D1StatementLike {
  constructor(
    readonly owner: MemoryD1,
    readonly query: string,
    readonly values: Bound = [],
  ) {}
  bind(...values: Array<unknown>): D1StatementLike {
    return new MemoryD1Statement(this.owner, this.query, values.map(toSql));
  }
  async first<T>(): Promise<T | null> {
    this.owner.check();
    return (
      (this.owner.db.prepare(this.query).get(...(this.values as Array<never>)) as T | undefined) ??
      null
    );
  }
  async all<T>(): Promise<{ results: Array<T> }> {
    this.owner.check();
    return {
      results: this.owner.db.prepare(this.query).all(...(this.values as Array<never>)) as Array<T>,
    };
  }
  async run(): Promise<{ meta: { changes: number } }> {
    this.owner.check();
    return {
      meta: {
        changes: Number(
          this.owner.db.prepare(this.query).run(...(this.values as Array<never>)).changes,
        ),
      },
    };
  }
  execSync(): unknown {
    const s = this.owner.db.prepare(this.query);
    return s.columns().length > 0
      ? { results: s.all(...(this.values as Array<never>)) }
      : { meta: { changes: Number(s.run(...(this.values as Array<never>)).changes) } };
  }
}

const toSql = (v: unknown): string | number | null | Uint8Array => {
  if (v === undefined || v === null) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string" || typeof v === "number" || v instanceof Uint8Array) return v;
  throw new TypeError(`D1 cannot bind ${typeof v}`);
};

/**
 * D1-compatible shim over node:sqlite: prepare/bind/first/all/run and atomic batch.
 * `failing = true` simulates a directory outage; `sessions` records requested constraints.
 */
export class MemoryD1 implements D1Like {
  readonly db = openCloudflareSqlite();
  failing = false;
  readonly sessions: Array<string> = [];

  check(): void {
    if (this.failing) throw new Error("D1_ERROR: simulated outage");
  }
  prepare(query: string): D1StatementLike {
    return new MemoryD1Statement(this, query);
  }
  async batch(statements: Array<D1StatementLike>): Promise<Array<unknown>> {
    this.check();
    this.db.exec("BEGIN");
    try {
      const out = statements.map((s) => (s as MemoryD1Statement).execSync());
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  withSession(constraint: "first-primary" | "first-unconstrained"): D1SessionLike {
    this.sessions.push(constraint);
    return this;
  }
  /** Apply the ordered control-plane migrations from infra/migrations/d1. */
  static migrated(dir = join(import.meta.dirname, "../../../infra/migrations/d1")): MemoryD1 {
    const d1 = new MemoryD1();
    for (const file of readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .sort())
      d1.db.exec(readFileSync(join(dir, file), "utf8"));
    return d1;
  }
}

export interface FakeDnsRecord {
  id: string;
  type: "MX" | "TXT" | "CNAME";
  name: string;
  content: string;
  priority?: number;
}

/**
 * In-memory Cloudflare API + DNS-over-HTTPS fake for onboarding tests (O01, P01). Serves the zone,
 * DNS record, Email Routing and cache-purge endpoints the scoped adapter uses; DoH answers come from
 * the same records (instant propagation) plus `external` records the test publishes by hand.
 */
export class FakeCloudflare {
  readonly zones = new Map<string, string>();
  readonly records: Array<FakeDnsRecord & { zoneId: string }> = [];
  readonly external: Array<FakeDnsRecord> = [];
  readonly routing = new Map<string, { enabled: boolean; catchAll: string | null }>();
  readonly purged: Array<ReadonlyArray<string>> = [];
  readonly calls: Array<string> = [];
  private n = 0;

  addZone(name: string): string {
    const id = `zone${++this.n}`;
    this.zones.set(id, name);
    this.routing.set(id, { enabled: false, catchAll: null });
    return id;
  }

  private ok = (result: unknown) =>
    new Response(JSON.stringify({ success: true, result }), {
      headers: { "content-type": "application/json" },
    });

  readonly fetch = async (
    input: string,
    init: { method?: string; body?: string; headers?: Record<string, string> } = {},
  ): Promise<Response> => {
    const url = new URL(input);
    const method = init.method ?? "GET";
    this.calls.push(`${method} ${url.pathname}`);
    if (url.hostname === "cloudflare-dns.com") {
      const name = url.searchParams.get("name") ?? "";
      const type = url.searchParams.get("type") as FakeDnsRecord["type"];
      const code = { MX: 15, TXT: 16, CNAME: 5 }[type];
      const answers = [...this.records, ...this.external]
        .filter((r) => r.name.toLowerCase() === name.toLowerCase() && r.type === type)
        .map((r) => ({
          name: `${r.name}.`,
          type: code,
          data:
            type === "MX"
              ? `${r.priority ?? 10} ${r.content}.`
              : type === "TXT"
                ? `"${r.content}"`
                : `${r.content}.`,
        }));
      return new Response(JSON.stringify({ Status: 0, Answer: answers }));
    }
    if (init.headers?.authorization !== "Bearer cf-test-token")
      return new Response(JSON.stringify({ success: false, errors: [{ message: "auth" }] }), {
        status: 403,
      });
    const body = init.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    const path = url.pathname.replace(/^\/client\/v4/, "");
    let m: RegExpMatchArray | null;
    if (path === "/zones")
      return this.ok(
        [...this.zones]
          .filter(([, n]) => n === url.searchParams.get("name"))
          .map(([id, name]) => ({ id, name })),
      );
    if ((m = path.match(/^\/zones\/([^/]+)\/dns_records$/))) {
      const zoneId = m[1]!;
      if (method === "GET")
        return this.ok(
          this.records.filter(
            (r) => r.zoneId === zoneId && r.name === url.searchParams.get("name"),
          ),
        );
      const rec = {
        id: `rec${++this.n}`,
        zoneId,
        type: body.type as FakeDnsRecord["type"],
        name: String(body.name),
        content: String(body.content),
        ...(body.priority !== undefined ? { priority: Number(body.priority) } : {}),
      };
      this.records.push(rec);
      return this.ok(rec);
    }
    if ((m = path.match(/^\/zones\/([^/]+)\/dns_records\/([^/]+)$/))) {
      const rec = this.records.find((r) => r.id === m![2]);
      if (!rec)
        return new Response(
          JSON.stringify({ success: false, errors: [{ message: "not found" }] }),
          { status: 404 },
        );
      Object.assign(rec, {
        content: String(body.content),
        ...(body.priority !== undefined ? { priority: Number(body.priority) } : {}),
      });
      return this.ok(rec);
    }
    if ((m = path.match(/^\/zones\/([^/]+)\/email\/routing$/)))
      return this.ok({ enabled: this.routing.get(m[1]!)?.enabled ?? false });
    if ((m = path.match(/^\/zones\/([^/]+)\/email\/routing\/enable$/))) {
      this.routing.get(m[1]!)!.enabled = true;
      return this.ok({});
    }
    if ((m = path.match(/^\/zones\/([^/]+)\/email\/routing\/rules\/catch_all$/))) {
      const state = this.routing.get(m[1]!)!;
      if (method === "PUT")
        state.catchAll = (body.actions as Array<{ value: Array<string> }>)[0]!.value[0] ?? null;
      return this.ok({
        enabled: state.catchAll !== null,
        actions: state.catchAll ? [{ type: "worker", value: [state.catchAll] }] : [],
      });
    }
    if ((m = path.match(/^\/zones\/([^/]+)\/purge_cache$/))) {
      this.purged.push(body.files as Array<string>);
      return this.ok({ id: "purge" });
    }
    return new Response(
      JSON.stringify({ success: false, errors: [{ message: `unhandled ${method} ${path}` }] }),
      { status: 404 },
    );
  };
}
