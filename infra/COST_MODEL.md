# Cost model (spec §12)

The business cost is driven by retained bytes and asynchronous work, not by Worker request pricing alone (§12). This worksheet maps each cost driver to a counter the platform already emits. The unit prices are **inputs**: copy them from the current Cloudflare and provider price lists at review time. This document does not assert prices.

## Counters

| Driver (§12)                                          | Counter / source                                                                                 | Emitted by                                          |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------- |
| Retained R2 bytes (originals, bodies, parts, exports) | `storage_usage` table (bytes per owner/category); mailbox quota `usedBytes`                      | `workers/core/src/usage.ts`, `MailboxStore.quota()` |
| R2 class A/B operations                               | `ingest.committed`, `ingest.offloaded`, `redeliver.copied.bytes`, `blobgc.deleted`, export files | `consumers.ts`, `blobgc.ts`, `workflows/export.ts`  |
| DO rows read/written, duration                        | per-authority reconcile counts `reconcile.catalog`; outbox and relay `queue.batch`               | `scheduled.ts`, `consumers.ts`                      |
| FTS write amplification                               | `search.shard.bytes` (per-shard stored bytes, alert at 50%, rollover at 70%)                     | index consumer / `metrics.ts storageLevel`          |
| D1 control-plane operations                           | `send.policy.blocked`, `sendevent.recorded`, `dlq.captured` plus request counts                  | `consumers.ts`, `sendevents.ts`, `dlq.ts`           |
| Queue operations and retries                          | `queue.batch` (ok/failed per batch), `ingest.republished`, `dlq.replayed`                        | `consumers.ts`, `scheduled.ts`, `dlq.ts`            |
| Workflow steps                                        | `erasure.started`, export/reindex/fanout instance results                                        | `erasure.ts`, `workflows/*`                         |
| Container CPU/memory                                  | scan requests (`scan`/`scan-message` topics); `ingest.offloaded` for the MIME container          | `scan.ts`, `mime.ts`                                |
| Transports                                            | `send.accepted`, `send.failed`, `send.unknown.reconciled` per traffic class                      | `consumers.ts`, `sendevents.ts`                     |
| Push                                                  | `push.delivered`                                                                                 | `push.ts`                                           |
| Observability                                         | structured log volume (one line per metric)                                                      | `metrics.ts`                                        |

## Worksheet

For a period P, where `price_x` is the input unit price:

```text
storage      = Σ owner bytes (storage_usage + mailbox originals) × byte-month fraction × price_r2_storage
r2_ops       = (writes: ingest.committed + ingest.offloaded + copies + export files) × price_r2_class_a
             + (reads: renders, downloads, scans, exports) × price_r2_class_b
queues       = (messages + retries + DLQ) × price_queue_op × 3   # write + read + delete per message
do           = rows_written × price_do_row_write + rows_read × price_do_row_read + GB-s × price_do_duration
d1           = rows_read × price_d1_read + rows_written × price_d1_write
workflows    = steps × price_workflow_step (+ CPU)
containers   = vCPU-s × price_container_cpu + GiB-s × price_container_mem
transports   = accepted messages × provider price per traffic class
push         = provider push charges (usually zero; APNs/FCM rate limits apply)
total        = storage + r2_ops + queues + do + d1 + workflows + containers + transports + push + observability
```

## Sizing scenario from §12 (not a forecast)

The scenario is 10,000 users × 100 incoming messages/day × 30 days: 30 M messages/month, about 6 TB of new originals per month at 200 KB each, plus about 3 M outbound submissions. Apply the worksheet with current unit prices. Add extracted parts and indexes separately, using the measured `storage_usage` bodies/parts ratio from a pilot rather than an assumed multiple.

## Shared-quota coupling

Cloudflare sending quotas and reputation are shared across tenants (§12). Track `send.policy.blocked{reason=budget}` per tier, and review the ramp tiers in `SendingPolicy` whenever platform-level budgets change.
