// Reads selected fields of a deployed stage's stack output from the self-hosted state backend
// (the same `/state/stacks/:stack/stages/:stage/output` route alchemy writes after a deploy) and
// prints them as `NAME=value` lines for `$GITHUB_ENV`. Used by the canary step to pin probes to
// the new MailCore version (coreWorkerName/coreVersionId → PROBE_WORKER_NAME/PROBE_VERSION_ID).
//
// Usage: node --experimental-strip-types infra/state/output.ts <stack> <stage> <field>=<ENV_NAME>...
// Env: BYE_STATE_URL, BYE_STATE_TOKEN. Missing fields print nothing (e.g. no canary in flight).

export type OutputFetcher = (
  url: string,
  init: { headers: Record<string, string> },
) => Promise<{ status: number; text(): Promise<string> }>;

export const readStackOutput = async (
  o: { readonly baseUrl: string; readonly token: string; readonly fetcher?: OutputFetcher },
  stack: string,
  stage: string,
): Promise<Record<string, unknown>> => {
  const fetcher = o.fetcher ?? (fetch as unknown as OutputFetcher);
  const r = await fetcher(
    `${o.baseUrl.replace(/\/$/, "")}/state/stacks/${encodeURIComponent(stack)}/stages/${encodeURIComponent(stage)}/output`,
    { headers: { authorization: `Bearer ${o.token}` } },
  );
  if (r.status !== 200) throw new Error(`state output request failed with ${r.status}`);
  const text = await r.text();
  const value = text ? (JSON.parse(text) as unknown) : {};
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
};

/** `field=ENV` pairs → env lines for string fields that are present; values are single-line. */
export const envLines = (
  output: Readonly<Record<string, unknown>>,
  pairs: ReadonlyArray<string>,
): ReadonlyArray<string> =>
  pairs.flatMap((pair) => {
    const [field, name] = pair.split("=");
    if (!field || !name || !/^[A-Z][A-Z0-9_]*$/.test(name)) throw new Error(`bad pair ${pair}`);
    const v = output[field];
    return typeof v === "string" && v !== "" && !/[\r\n]/.test(v) ? [`${name}=${v}`] : [];
  });

if (import.meta.main) {
  const [stack, stage, ...pairs] = process.argv.slice(2);
  const baseUrl = process.env.BYE_STATE_URL ?? "";
  const token = process.env.BYE_STATE_TOKEN ?? "";
  if (!stack || !stage || pairs.length === 0 || !baseUrl || !token) {
    console.error(
      "usage: output.ts <stack> <stage> <field>=<ENV_NAME>... (env BYE_STATE_URL, BYE_STATE_TOKEN)",
    );
    process.exit(2);
  }
  const output = await readStackOutput({ baseUrl, token }, stack, stage);
  for (const line of envLines(output, pairs)) console.log(line);
}
