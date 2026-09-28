import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  D1BatchResult,
  D1Like,
  D1Row,
  D1SessionLike,
  D1StatementLike,
  D1Value,
} from "@bye/platform-cloudflare";
import { Predicate } from "effect";
import { openCloudflareSqlite } from "./sqlite.ts";

/** One statement's outcome from the in-memory batch: rows for reads, change count for writes. */
interface MemoryBatchResult extends D1BatchResult {
  readonly results?: Array<D1Row>;
}

type Bound = Array<string | number | null | Uint8Array>;

class MemoryD1Statement implements D1StatementLike {
  constructor(
    readonly owner: MemoryD1,
    readonly query: string,
    readonly values: Bound = [],
  ) {}
  bind(...values: Array<D1Value>): D1StatementLike {
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
  execSync(): MemoryBatchResult {
    const s = this.owner.db.prepare(this.query);

    return s.columns().length > 0
      ? { results: s.all(...(this.values as Array<never>)) as Array<D1Row> }
      : { meta: { changes: Number(s.run(...(this.values as Array<never>)).changes) } };
  }
}

const toSql = (v: D1Value): string | number | null | Uint8Array => {
  if (v === undefined || v === null) return null;

  if (Predicate.isBoolean(v)) return v ? 1 : 0;

  if (Predicate.isString(v) || Predicate.isNumber(v) || v instanceof Uint8Array) return v;
  throw new TypeError("D1 cannot bind object");
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
  async batch(statements: Array<D1StatementLike>): Promise<Array<D1BatchResult>> {
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
export interface FakeRoutingRule {
  enabled: boolean;
  name?: string;
  matchers: Array<{ type: string; field?: string; value?: string }>;
  actions: Array<{ type: string; value?: Array<string> }>;
}

/** JSON body of a Cloudflare API request the fake understands (DNS record, routing rule, purge). */
interface FakeRequestBody extends Partial<FakeRoutingRule> {
  type?: string;
  content?: unknown;
  priority?: unknown;
  files?: Array<string>;
}

export class FakeCloudflare {
  readonly zones = new Map<string, string>();
  readonly records: Array<FakeDnsRecord & { zoneId: string }> = [];
  readonly external: Array<FakeDnsRecord> = [];
  /** `catchAll`: the Worker the catch-all delivers to (null when it is off or not a Worker). */
  readonly routing = new Map<string, { enabled: boolean; catchAll: string | null }>();
  /** The full catch-all rule per zone, when one is set (any action). */
  readonly catchAllRules = new Map<string, FakeRoutingRule>();
  /** Address rules per zone (not the catch-all). */
  readonly routingRules = new Map<string, Array<FakeRoutingRule>>();
  readonly purged: Array<ReadonlyArray<string>> = [];
  readonly calls: Array<string> = [];
  /** API tokens and the zones each reaches ("all" = every zone). */
  readonly tokens = new Map<string, ReadonlyArray<string> | "all">([["cf-test-token", "all"]]);
  private n = 0;

  addZone(name: string): string {
    const id = `zone${++this.n}`;
    this.zones.set(id, name);
    this.routing.set(id, { enabled: false, catchAll: null });

    return id;
  }

  /** Sets a zone's catch-all rule directly (the customer's existing configuration). */
  setCatchAll(zoneId: string, rule: FakeRoutingRule): void {
    this.catchAllRules.set(zoneId, structuredClone(rule));
    const worker = rule.enabled ? rule.actions.find((a) => a.type === "worker") : undefined;
    this.routing.get(zoneId)!.catchAll = worker?.value?.[0] ?? null;
  }

  private ok = <Result extends object | null>(result: Result) =>
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

      const answerData = (r: FakeDnsRecord): string => {
        if (type === "MX") return `${r.priority ?? 10} ${r.content}.`;

        if (type === "TXT") return `"${r.content}"`;

        return `${r.content}.`;
      };

      const answers = [...this.records, ...this.external].flatMap((r) =>
        r.name.toLowerCase() === name.toLowerCase() && r.type === type
          ? [{ name: `${r.name}.`, type: code, data: answerData(r) }]
          : [],
      );

      return new Response(JSON.stringify({ Status: 0, Answer: answers }));
    }

    const denied = () =>
      new Response(JSON.stringify({ success: false, errors: [{ message: "auth" }] }), {
        status: 403,
      });

    const scope = this.tokens.get((init.headers?.authorization ?? "").replace(/^Bearer /, ""));

    if (scope === undefined) return denied();
    const reaches = (zoneId: string) => scope === "all" || scope.includes(zoneId);
    const body = init.body ? (JSON.parse(init.body) as FakeRequestBody) : {};
    const path = url.pathname.replace(/^\/client\/v4/, "");
    let m: RegExpMatchArray | null;
    const zoneOf = path.match(/^\/zones\/([^/]+)/);

    if (zoneOf && !reaches(zoneOf[1]!)) return denied();

    if (path === "/zones")
      return this.ok(
        [...this.zones].flatMap(([id, name]) =>
          reaches(id) && (!url.searchParams.has("name") || name === url.searchParams.get("name"))
            ? [{ id, name }]
            : [],
        ),
      );

    if ((m = path.match(/^\/zones\/([^/]+)$/))) {
      const name = this.zones.get(m[1]!);

      return name === undefined ? denied() : this.ok({ id: m[1], name, status: "active" });
    }

    if ((m = path.match(/^\/zones\/([^/]+)\/dns_records$/))) {
      const zoneId = m[1]!;

      if (method === "GET")
        return this.ok(
          this.records.filter(
            (r) => r.zoneId === zoneId && r.name === url.searchParams.get("name"),
          ),
        );

      const rec: FakeDnsRecord & { zoneId: string } = {
        id: `rec${++this.n}`,
        zoneId,
        type: body.type as FakeDnsRecord["type"],
        name: String(body.name),
        content: String(body.content),
      };

      if (body.priority !== undefined) rec.priority = Number(body.priority);

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

      if (method === "DELETE") {
        this.records.splice(this.records.indexOf(rec), 1);

        return this.ok({ id: rec.id });
      }

      rec.content = String(body.content);

      if (body.priority !== undefined) rec.priority = Number(body.priority);

      return this.ok(rec);
    }

    if ((m = path.match(/^\/zones\/([^/]+)\/email\/routing$/)))
      return this.ok({ enabled: this.routing.get(m[1]!)?.enabled ?? false });

    if ((m = path.match(/^\/zones\/([^/]+)\/email\/routing\/enable$/))) {
      this.routing.get(m[1]!)!.enabled = true;

      return this.ok({});
    }

    if ((m = path.match(/^\/zones\/([^/]+)\/email\/routing\/disable$/))) {
      this.routing.get(m[1]!)!.enabled = false;

      return this.ok({});
    }

    if ((m = path.match(/^\/zones\/([^/]+)\/email\/routing\/rules\/catch_all$/))) {
      const zoneId = m[1]!;

      if (method === "PUT")
        this.catchAllRules.set(zoneId, Object.assign({} as FakeRoutingRule, structuredClone(body)));
      const rule = this.catchAllRules.get(zoneId) ?? null;
      const worker = rule?.enabled ? rule.actions.find((a) => a.type === "worker") : undefined;
      this.routing.get(zoneId)!.catchAll = worker?.value?.[0] ?? null;

      return this.ok(rule);
    }

    if ((m = path.match(/^\/zones\/([^/]+)\/email\/routing\/rules$/)))
      return this.ok(this.routingRules.get(m[1]!) ?? []);

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
