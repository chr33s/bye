# Durable Object migrations

Two separate concerns (§15.9):

1. **Namespace/class migrations** register or transfer class storage on the host Worker.
   Alchemy beta.79 derives `new_sqlite_classes` for newly bound classes and
   `transferred_classes` from a declared `transferredFrom`. `durable-class-migrations.ts`
   is the reviewed record; released steps are immutable and a class may disappear only with
   an approved decommission (see `infra/policies/decommissions.json`).
2. **In-object application SQL migrations** upgrade each mailbox/calendar/shared/search
   object lazily under its initialization gate (`migrate()` in
   `packages/platform-cloudflare/src/durable/sql.ts`), namespaced per authority module.
   Each step is a bounded synchronous transaction; backfills are resumable jobs.

Rules:

- All authority classes are hosted by `MailCore`. Splitting hosts requires `transferredFrom`
  and a test against existing data before use (§15.2).
- Generated namespace migration success is not proof that mailbox data migrated safely.
- Expand → migrate/backfill → verify → contract. Readers support the prior schema for the
  rollback interval. A code rollback does not roll back object data.
- Fixtures of prior schemas live beside each authority's tests and must keep decoding.
