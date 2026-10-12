import { blobKey } from "@bye/application";
import { encodeId } from "@bye/domain";

// spec.md §16 D2 deployed evidence: drive a deployed (throwaway, synthetic-data) stage over the
// Cloudflare REST API. D1 seeding reuses the real control-plane code through a REST-backed D1;
// mail enters through the deployed pipeline from the original in R2 and the ingest queue onward
// (the SMTP edge needs a routed zone, so it is the one hop this run does not exercise).

export interface DeployedStage {
  readonly accountId: string;
  readonly apiToken: string;
  readonly database: string;
  readonly originals: string;
  readonly ingestQueue: string;
}

interface D1Meta {
  readonly changes: number;
  readonly last_row_id: number;
}

interface D1QueryResult {
  readonly results: ReadonlyArray<Row>;
  readonly meta: D1Meta;
}

interface D1Envelope {
  readonly success: boolean;
  readonly errors: ReadonlyArray<{ readonly message: string }>;
  readonly result: ReadonlyArray<D1QueryResult>;
}

type Row = Readonly<Record<string, string | number | null>>;

type Param = string | number | null;

interface CloudflareRequest {
  readonly method: string;
  readonly contentType: string;
  readonly body: string | Uint8Array;
}

const cloudflare = (stage: DeployedStage, path: string, init: CloudflareRequest) =>
  fetch(`https://api.cloudflare.com/client/v4/accounts/${stage.accountId}${path}`, {
    method: init.method,
    headers: { authorization: `Bearer ${stage.apiToken}`, "content-type": init.contentType },
    body: init.body,
  });

const query = async (
  stage: DeployedStage,
  sql: string,
  params: ReadonlyArray<Param>,
): Promise<D1QueryResult> => {
  const r = await cloudflare(stage, `/d1/database/${stage.database}/query`, {
    method: "POST",
    contentType: "application/json",
    body: JSON.stringify({ sql, params }),
  });

  const body = (await r.json()) as D1Envelope;

  if (!body.success) throw new Error(`D1: ${body.errors.map((e) => e.message).join("; ")}`);

  return body.result[0]!;
};

class RestStatement {
  constructor(
    private readonly stage: DeployedStage,
    readonly sql: string,
    readonly params: ReadonlyArray<Param> = [],
  ) {}

  bind(...params: ReadonlyArray<Param>) {
    return new RestStatement(this.stage, this.sql, params);
  }

  async first(column?: string) {
    const row = (await query(this.stage, this.sql, this.params)).results[0] ?? null;

    return column === undefined || row === null ? row : (row[column] ?? null);
  }

  async all() {
    const r = await query(this.stage, this.sql, this.params);

    return { success: true, results: r.results, meta: r.meta };
  }

  async run() {
    const r = await query(this.stage, this.sql, this.params);

    return { success: true, results: r.results, meta: r.meta };
  }
}

/**
 * A D1Database over the REST API, enough for the control plane's provisioning and credential
 * paths. `batch` runs its statements in order but not atomically: seeding a throwaway stage only.
 */
export const restD1 = (stage: DeployedStage) => {
  const db = {
    prepare: (sql: string) => new RestStatement(stage, sql),
    batch: async (statements: ReadonlyArray<RestStatement>) => {
      const out = [];

      for (const s of statements) out.push(await s.run());

      return out;
    },
    exec: async (sql: string) => {
      await query(stage, sql, []);

      return { count: 1, duration: 0 };
    },
    withSession: () => db,
  };

  return db;
};

export const d1Rows = async (stage: DeployedStage, sql: string, params: ReadonlyArray<Param>) =>
  (await query(stage, sql, params)).results;

/** Store an original in the stage's R2 and enqueue it on the deployed ingest queue. */
export const injectMail = async (
  stage: DeployedStage,
  delivery: {
    readonly mailboxId: string;
    readonly recipient: string;
    readonly envelopeFrom: string;
    readonly raw: string;
  },
) => {
  const ingestionId = encodeId("IngestionId", crypto.getRandomValues(new Uint8Array(16)));
  const objectKey = blobKey.original(delivery.mailboxId, ingestionId);
  const bytes = new TextEncoder().encode(delivery.raw);

  const put = await cloudflare(stage, `/r2/buckets/${stage.originals}/objects/${objectKey}`, {
    method: "PUT",
    contentType: "message/rfc822",
    body: bytes,
  });

  if (!put.ok) throw new Error(`R2 put ${put.status}: ${await put.text()}`);

  const sent = await cloudflare(stage, `/queues/${stage.ingestQueue}/messages`, {
    method: "POST",
    contentType: "application/json",
    body: JSON.stringify({
      content_type: "json",
      body: {
        schemaVersion: 1,
        type: "ingest",
        eventId: `ingest:${ingestionId}`,
        ingestionId,
        mailboxId: delivery.mailboxId,
        recipient: delivery.recipient,
        envelopeFrom: delivery.envelopeFrom,
        objectKey,
        rawSize: bytes.byteLength,
        receivedAt: Date.now(),
      },
    }),
  });

  if (!sent.ok) throw new Error(`queue send ${sent.status}: ${await sent.text()}`);

  return ingestionId;
};
