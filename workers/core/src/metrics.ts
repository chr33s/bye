// Operational counters (§3.1 Observability, §12 cost model). Emitted as structured logs in an
// Analytics-Engine-compatible shape: metric name, numeric value, low-cardinality tags only. Never
// include subjects, bodies, addresses, tokens or other customer content.

export type MetricTags = Readonly<Record<string, string | number | boolean>>;

export interface MetricSink {
  (event: { readonly metric: string; readonly value: number; readonly tags: MetricTags }): void;
}

const defaultSink: MetricSink = (event) =>
  console.log(JSON.stringify({ level: "metric", ...event }));

let sink: MetricSink = defaultSink;

export const setMetricSink = (next: MetricSink | null): void => {
  sink = next ?? defaultSink;
};

export const metric = (name: string, value = 1, tags: MetricTags = {}): void => {
  try {
    sink({ metric: name, value, tags });
  } catch {
    // metrics never break the request path
  }
};

/** Storage alert thresholds (§12): alert at 50% of a shard budget, split/rebuild before 70%. */
export const storageLevel = (
  usedBytes: number,
  budgetBytes: number,
): "ok" | "alert" | "rollover" => {
  const ratio = budgetBytes > 0 ? usedBytes / budgetBytes : 0;
  return ratio >= 0.7 ? "rollover" : ratio >= 0.5 ? "alert" : "ok";
};
