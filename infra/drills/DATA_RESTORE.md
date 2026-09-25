# Data restore drills (§12)

The spec requires restore drills for a mailbox, an organization/shared resource, a calendar, and a
complete export, with erasure tombstones replayed so a restore never resurrects erased data.

## What is authoritative, and how each part is restored

| State                                                                           | Store                  | Restore mechanism                                                                                                               |
| ------------------------------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Mailbox, calendar, shared space, search, ingress journal                        | SQLite Durable Objects | Point-in-time recovery (30 days): `POST /v1/ops/restore` → `getBookmarkForTime` → `onNextSessionRestoreBookmark` → object reset |
| Accounts, orgs, directory, catalog, tombstones                                  | D1                     | D1 Time Travel (`wrangler d1 time-travel restore DIRECTORY --timestamp=<unix>`), run by an operator with the restore credential |
| Originals, parts, exports, published copies, **tombstone ledger** (`_erasure/`) | R2                     | Not rolled back (immutable content; the ledger must outlive D1 restores)                                                        |

Exports are derived data: after a restore, a new export is reproducible from the restored
authorities (the drill verifies the complete paged manifest).

## Production procedure

1. Pick the restore point `T` (ms since epoch, within 30 days) and record the incident ID.
2. D1 (if affected): `wrangler d1 time-travel restore DIRECTORY --timestamp=<T/1000>`.
3. Each affected authority:
   `curl -X POST $APP/v1/ops/restore -H "authorization: Bearer $OPS_TOKEN" -d '{"kind":"mailbox","id":"mbx_…","at":T,"confirm":"mbx_…"}'`
   (`kind` ∈ mailbox | calendar | space). The route arms the bookmark, resets the object, and
   replays every erasure tombstone.
4. `POST /v1/ops/tombstones/replay` once more after D1 is restored (the R2 ledger re-seeds D1).
5. Let the 5-minute reconcile run (alarms, outboxes, unknown sends, ingress replay), then check
   `GET /v1/ops/dlq` and the storage/ingest metrics.

## Local drill (automated)

`node --experimental-transform-types --no-warnings infra/drills/data-restore.ts` (also runs in
`workers/core/test/ops-drill.test.ts`). It runs the production MailCore bundle in local workerd with
persisted state, checkpoints D1 + Durable Object SQLite, damages every authority, erases a user
after the checkpoint, restores the checkpoint (R2 intact), and verifies:

- **mailbox:** deliveries return to their checkpoint state.
- **calendar:** events return to their checkpoint state.
- **export:** the complete manifest is reproducible.
- **shared:** a removed member comes back, and the erased user's membership does not.
- **tombstones:** the replay re-erases the erased user's restored mailbox.

Local workerd has no point-in-time recovery, so the drill restores the persisted SQLite files. The
PITR route path is covered by `workers/core/test/ops-recovery.test.ts` with a PITR-capable fake. A
production drill must be run quarterly on a staging stage using the procedure above.
