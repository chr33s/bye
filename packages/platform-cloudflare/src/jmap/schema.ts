import type { Migration } from "../durable/sql.ts";

// JMAP core schema inside the existing MailboxDO (spec.md §16.2): per-email authority, typed
// history, blob pins, submissions, extensions, effective grants, staging and migration state.
// Expand-only, in its own migration set so the legacy mailbox schema is untouched (C3: old tables
// stay read-only after activation until verified cleanup).

export const JMAP_MIGRATIONS: ReadonlyArray<Migration> = [
  {
    version: 1,
    name: "jmap-core",
    statements: [
      // Account-level settings: mode (C3 state), revision counter, writer epoch, workflow targets.
      `CREATE TABLE jmap_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
      // Typed history (C1). `seq` orders operations within one revision.
      `CREATE TABLE jmap_history (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        rev INTEGER NOT NULL,
        type TEXT NOT NULL,
        object_id TEXT NOT NULL,
        op TEXT NOT NULL CHECK (op IN ('created','updated','destroyed')),
        created_at INTEGER NOT NULL
      )`,
      "CREATE INDEX jmap_history_type ON jmap_history (type, rev)",
      "CREATE INDEX jmap_history_object ON jmap_history (type, object_id, rev)",
      "CREATE INDEX jmap_history_age ON jmap_history (created_at)",
      // Latest revision per type (the type's state) and the compaction floor below which a
      // `/changes` can no longer be calculated.
      `CREATE TABLE jmap_type_state (type TEXT PRIMARY KEY, rev INTEGER NOT NULL, floor INTEGER NOT NULL DEFAULT 0)`,
      `CREATE TABLE jmap_mailboxes (
        mailbox_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        parent_id TEXT,
        role TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_rev INTEGER NOT NULL
      )`,
      "CREATE UNIQUE INDEX jmap_mailboxes_role ON jmap_mailboxes (role) WHERE role IS NOT NULL",
      `CREATE TABLE jmap_subscriptions (
        principal_id TEXT NOT NULL,
        mailbox_id TEXT NOT NULL,
        subscribed INTEGER NOT NULL,
        PRIMARY KEY (principal_id, mailbox_id)
      )`,
      `CREATE TABLE jmap_emails (
        email_id TEXT PRIMARY KEY,
        blob_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        size INTEGER NOT NULL,
        received_at INTEGER NOT NULL,
        sent_at INTEGER,
        message_id TEXT,
        in_reply_to TEXT,
        refs TEXT,
        sender TEXT,
        from_json TEXT,
        to_json TEXT,
        cc_json TEXT,
        bcc_json TEXT,
        reply_to_json TEXT,
        subject TEXT NOT NULL DEFAULT '',
        base_subject TEXT NOT NULL DEFAULT '',
        preview TEXT NOT NULL DEFAULT '',
        has_attachment INTEGER NOT NULL DEFAULT 0,
        headers_json TEXT NOT NULL DEFAULT '[]',
        body_json TEXT NOT NULL DEFAULT '{}',
        scan_status TEXT NOT NULL DEFAULT 'not-required',
        quarantined INTEGER NOT NULL DEFAULT 0,
        placement_version INTEGER NOT NULL DEFAULT 1,
        first_seen INTEGER NOT NULL,
        legacy_delivery_id TEXT
      )`,
      "CREATE INDEX jmap_emails_thread ON jmap_emails (thread_id, received_at)",
      "CREATE INDEX jmap_emails_received ON jmap_emails (received_at, email_id)",
      "CREATE INDEX jmap_emails_blob ON jmap_emails (blob_id)",
      // Canonical search (§4, D2): overlapping chunks so no match is lost at a chunk boundary.
      `CREATE VIRTUAL TABLE jmap_fts USING fts5(email_id UNINDEXED, chunk UNINDEXED, subject, addresses, body, tokenize = 'unicode61 remove_diacritics 2')`,
      `CREATE TABLE jmap_memberships (email_id TEXT NOT NULL, mailbox_id TEXT NOT NULL, PRIMARY KEY (email_id, mailbox_id))`,
      "CREATE INDEX jmap_memberships_mailbox ON jmap_memberships (mailbox_id, email_id)",
      `CREATE TABLE jmap_keywords (email_id TEXT NOT NULL, keyword TEXT NOT NULL, PRIMARY KEY (email_id, keyword))`,
      "CREATE INDEX jmap_keywords_keyword ON jmap_keywords (keyword, email_id)",
      // Message-ID index for deterministic threading (A2): first-seen order resolves duplicates.
      `CREATE TABLE jmap_message_ids (message_id TEXT NOT NULL, email_id TEXT NOT NULL, thread_id TEXT NOT NULL, first_seen INTEGER NOT NULL, PRIMARY KEY (message_id, email_id))`,
      `CREATE TABLE jmap_threads (thread_id TEXT PRIMARY KEY, threading_version INTEGER NOT NULL, created_rev INTEGER NOT NULL)`,
      // Blobs: immutable R2 objects this account references, and what keeps each alive.
      `CREATE TABLE jmap_blobs (
        blob_id TEXT PRIMARY KEY,
        bucket TEXT NOT NULL CHECK (bucket IN ('originals','parts')),
        r2_key TEXT NOT NULL,
        size INTEGER NOT NULL,
        type TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER
      )`,
      `CREATE TABLE jmap_blob_pins (blob_id TEXT NOT NULL, owner TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (blob_id, owner))`,
      "CREATE INDEX jmap_blob_pins_owner ON jmap_blob_pins (owner)",
      // Submissions (B2): an independent content pin, envelope and job association.
      `CREATE TABLE jmap_submissions (
        submission_id TEXT PRIMARY KEY,
        identity_id TEXT NOT NULL,
        email_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        envelope TEXT NOT NULL,
        send_at INTEGER NOT NULL,
        content_blob_id TEXT NOT NULL,
        send_job_id TEXT NOT NULL,
        canceled INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      )`,
      "CREATE INDEX jmap_submissions_job ON jmap_submissions (send_job_id)",
      // Intent receipts (B1): principal + intent, bound to method and payload digest.
      `CREATE TABLE jmap_intents (
        principal_id TEXT NOT NULL,
        intent_id TEXT NOT NULL,
        method TEXT NOT NULL,
        digest TEXT NOT NULL,
        result TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (principal_id, intent_id)
      )`,
      // Extensions (A2): presentation objects that never own membership or keywords.
      `CREATE TABLE jmap_conversations (
        conversation_id TEXT PRIMARY KEY,
        title TEXT,
        thread_ids TEXT NOT NULL DEFAULT '[]',
        redirect_to TEXT,
        version INTEGER NOT NULL DEFAULT 1
      )`,
      `CREATE TABLE jmap_draft_sessions (
        session_id TEXT PRIMARY KEY,
        principal_id TEXT NOT NULL,
        head_email_id TEXT,
        version INTEGER NOT NULL DEFAULT 1,
        conflicts TEXT NOT NULL DEFAULT '[]',
        pending_cleanup TEXT NOT NULL DEFAULT '[]',
        updated_at INTEGER NOT NULL
      )`,
      // Timers (A2 precedence): captured Email IDs with their placement versions.
      `CREATE TABLE jmap_timers (
        timer_id TEXT PRIMARY KEY,
        principal_id TEXT NOT NULL,
        emails TEXT NOT NULL,
        action TEXT NOT NULL,
        due_at INTEGER NOT NULL,
        generation INTEGER NOT NULL DEFAULT 1,
        state TEXT NOT NULL DEFAULT 'armed',
        reason TEXT
      )`,
      // Effective grants (A3): the account-local authority for every rights decision.
      `CREATE TABLE jmap_grants (
        principal_id TEXT NOT NULL,
        mailbox_id TEXT NOT NULL,
        rights TEXT NOT NULL,
        revision INTEGER NOT NULL,
        PRIMARY KEY (principal_id, mailbox_id)
      )`,
      // Arrival staging (B4): received → preparing → ready → published, or parked with a reason.
      `CREATE TABLE jmap_staging (
        arrival_id TEXT PRIMARY KEY,
        state TEXT NOT NULL CHECK (state IN ('received','preparing','ready','published','parked')),
        input TEXT NOT NULL,
        email_id TEXT,
        reason TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      )`,
      "CREATE INDEX jmap_staging_state ON jmap_staging (state, updated_at)",
      // Migration (C3): buffered work while fenced, and the fixed legacy-to-standard ID map.
      `CREATE TABLE jmap_buffer (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL,
        applied_at INTEGER
      )`,
      `CREATE TABLE jmap_id_map (kind TEXT NOT NULL, legacy_id TEXT NOT NULL, jmap_id TEXT NOT NULL, PRIMARY KEY (kind, legacy_id))`,
      `CREATE TABLE jmap_audit (seq INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, subject TEXT NOT NULL, detail TEXT NOT NULL, at INTEGER NOT NULL)`,
      // Cross-account copy operations (B3) on the destination side (dropped in version 2).
      `CREATE TABLE jmap_copy_ops (
        op_id TEXT NOT NULL,
        source_id TEXT NOT NULL,
        phase TEXT NOT NULL,
        destination_id TEXT,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (op_id, source_id)
      )`,
    ],
  },
  {
    version: 2,
    name: "jmap-retention-ownership",
    statements: [
      // Blob GC and legacy-key lookups probe by R2 key; scan verdicts by legacy delivery ID.
      "CREATE INDEX jmap_blobs_key ON jmap_blobs (r2_key)",
      "CREATE INDEX jmap_emails_legacy ON jmap_emails (legacy_delivery_id) WHERE legacy_delivery_id IS NOT NULL",
      // When an Email entered each Mailbox: Trash/Spam/Screened Out retention counts from here.
      // Existing memberships have no recorded time; rather than rewrite every row, the upgrade
      // time is kept once (`retentionFrom`) and stands in for them, so none is purged earlier
      // than its window allows.
      "ALTER TABLE jmap_memberships ADD COLUMN added_at INTEGER",
      `INSERT INTO jmap_meta (key, value)
       SELECT 'retentionFrom', CAST(strftime('%s', 'now') AS INTEGER) * 1000
       WHERE EXISTS (SELECT 1 FROM jmap_memberships)`,
      // The principal that created a submission: only it sees the envelope (Bcc) or may cancel.
      // Earlier submissions have none recorded; see `JmapObjects.submissions`.
      "ALTER TABLE jmap_submissions ADD COLUMN principal_id TEXT",
      // Submission and DraftSession history is now keyed per principal: earlier unscoped rows
      // can't be attributed, so states from before refresh once (cannotCalculateChanges).
      "UPDATE jmap_type_state SET floor = rev WHERE type IN ('EmailSubmission', 'DraftSession')",
      // Each principal's latest revision of those types: its state, without scanning history.
      `CREATE TABLE jmap_scoped_state (
        type TEXT NOT NULL,
        principal_id TEXT NOT NULL,
        rev INTEGER NOT NULL,
        PRIMARY KEY (type, principal_id)
      )`,
      // Per-principal visibility generation (A3): only the principal's own grant changes move it.
      `CREATE TABLE jmap_acl_generations (principal_id TEXT PRIMARY KEY, generation INTEGER NOT NULL)`,
      // Content-addressed keys blob GC is deleting (checked unreferenced, delete in flight): the
      // same content registered meanwhile would point at bytes about to go, so it is refused.
      `CREATE TABLE jmap_gc_claims (r2_key TEXT PRIMARY KEY, at INTEGER NOT NULL)`,
      // Never used: copies are prepared by the API host. (The equally unused `created_rev`
      // columns stay: dropping a column rewrites the whole table on the account's first wake.)
      "DROP TABLE jmap_copy_ops",
    ],
  },
];
