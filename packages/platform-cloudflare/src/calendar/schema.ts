import type { Migration } from "../durable/sql.ts";

// In-object application schema for the CalendarDO authority (§4.1 CalendarDO records, §15.9).

export const CALENDAR_MIGRATIONS: ReadonlyArray<Migration> = [
  {
    version: 1,
    name: "calendar-core",
    statements: [
      `CREATE TABLE cal_calendars (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        color TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('local', 'subscription', 'invitations')),
        visible INTEGER NOT NULL DEFAULT 1,
        revision INTEGER NOT NULL DEFAULT 1,
        deleted INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      )`,
      `CREATE TABLE cal_grants (
        calendar_id TEXT NOT NULL,
        grantee TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('read', 'write')),
        created_at INTEGER NOT NULL,
        PRIMARY KEY (calendar_id, grantee)
      )`,
      `CREATE TABLE cal_subscriptions (
        calendar_id TEXT PRIMARY KEY,
        url TEXT NOT NULL,
        etag TEXT,
        last_modified TEXT,
        last_fetched_at INTEGER,
        last_status TEXT,
        item_limit INTEGER NOT NULL,
        refresh_ms INTEGER NOT NULL
      )`,
      `CREATE TABLE cal_events (
        id TEXT PRIMARY KEY,
        calendar_id TEXT NOT NULL,
        uid TEXT NOT NULL,
        series TEXT NOT NULL,
        organizer TEXT,
        we_are_organizer INTEGER NOT NULL DEFAULT 0,
        attendees TEXT NOT NULL DEFAULT '[]',
        alarms TEXT NOT NULL DEFAULT '[]',
        sequence INTEGER NOT NULL DEFAULT 0,
        dtstamp INTEGER,
        revision INTEGER NOT NULL DEFAULT 1,
        generation INTEGER NOT NULL DEFAULT 1,
        highlight INTEGER NOT NULL DEFAULT 0,
        countdown INTEGER NOT NULL DEFAULT 0,
        private_note TEXT,
        source_ref TEXT,
        range_start INTEGER NOT NULL,
        range_end INTEGER,
        deleted INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (calendar_id, uid)
      )`,
      "CREATE INDEX cal_events_range ON cal_events (calendar_id, deleted, range_start)",
      "CREATE INDEX cal_events_uid ON cal_events (uid)",
      `CREATE TABLE cal_exceptions (
        event_id TEXT NOT NULL,
        recurrence_key TEXT NOT NULL,
        body TEXT NOT NULL,
        PRIMARY KEY (event_id, recurrence_key)
      )`,
      `CREATE TABLE cal_invitation_revisions (
        uid TEXT NOT NULL,
        recurrence_key TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        dtstamp INTEGER,
        method TEXT NOT NULL,
        received_at INTEGER NOT NULL,
        PRIMARY KEY (uid, recurrence_key)
      )`,
      `CREATE TABLE cal_attendee_revisions (
        uid TEXT NOT NULL,
        address TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        dtstamp INTEGER,
        PRIMARY KEY (uid, address)
      )`,
      `CREATE TABLE cal_series_links (
        original_uid TEXT NOT NULL,
        new_uid TEXT NOT NULL,
        split_key TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (original_uid, new_uid)
      )`,
      `CREATE TABLE cal_week_tasks (
        id TEXT PRIMARY KEY,
        anchor TEXT NOT NULL,
        title TEXT NOT NULL,
        order_key TEXT NOT NULL,
        completed_at INTEGER,
        event_id TEXT,
        revision INTEGER NOT NULL DEFAULT 1,
        deleted INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      )`,
      "CREATE INDEX cal_week_tasks_anchor ON cal_week_tasks (anchor, deleted, order_key)",
      `CREATE TABLE cal_habits (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        weekdays TEXT NOT NULL,
        archived INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      )`,
      `CREATE TABLE cal_habit_completions (
        habit_id TEXT NOT NULL,
        date TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (habit_id, date)
      )`,
      `CREATE TABLE cal_time_entries (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        stopped_at INTEGER,
        active INTEGER UNIQUE,
        source TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )`,
      "CREATE INDEX cal_time_entries_started ON cal_time_entries (started_at)",
      `CREATE TABLE cal_day_decorations (
        date TEXT PRIMARY KEY,
        label TEXT,
        photo_key TEXT,
        updated_at INTEGER NOT NULL
      )`,
      `CREATE TABLE cal_journal (
        date TEXT PRIMARY KEY,
        body TEXT NOT NULL,
        revision INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
      `CREATE TABLE cal_feed_tokens (
        token_hash TEXT PRIMARY KEY,
        calendar_ids TEXT NOT NULL,
        label TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        revoked_at INTEGER
      )`,
      `CREATE TABLE cal_preferences (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )`,
      `CREATE VIRTUAL TABLE cal_search USING fts5 (
        doc_id UNINDEXED,
        kind UNINDEXED,
        ref UNINDEXED,
        body,
        tokenize = 'unicode61 remove_diacritics 2'
      )`,
    ],
  },
  {
    // Resumable ICS import (C05): progress of an import command, committed with each batch.
    version: 2,
    name: "ics-import-checkpoints",
    statements: [
      `CREATE TABLE cal_import_checkpoints (
        command_id TEXT PRIMARY KEY,
        calendar_id TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        next_index INTEGER NOT NULL,
        imported INTEGER NOT NULL,
        updated INTEGER NOT NULL,
        warnings TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
    ],
  },
  {
    // Invitation state for clients (C04/C09): which delivered message carried which invitation,
    // and the owner's answer to single occurrences (a series answer lives on the attendee row).
    version: 3,
    name: "invitation-messages-and-occurrence-responses",
    statements: [
      `CREATE TABLE cal_invitation_messages (
        delivery_id TEXT NOT NULL,
        mailbox_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        recurrence_key TEXT NOT NULL,
        received_at INTEGER NOT NULL,
        PRIMARY KEY (delivery_id, event_id, recurrence_key)
      )`,
      "CREATE INDEX cal_invitation_messages_event ON cal_invitation_messages (event_id)",
      `CREATE TABLE cal_occurrence_responses (
        event_id TEXT NOT NULL,
        occurrence_key TEXT NOT NULL,
        partstat TEXT NOT NULL,
        responded_at INTEGER NOT NULL,
        PRIMARY KEY (event_id, occurrence_key)
      )`,
    ],
  },
  {
    // Invitations received before message links existed: link each to the delivery that created
    // it (later updates of those events stay unlinked; clients fall back to a title search).
    version: 4,
    name: "backfill-invitation-messages",
    statements: [
      `INSERT OR IGNORE INTO cal_invitation_messages (delivery_id, mailbox_id, event_id, recurrence_key, received_at)
       SELECT json_extract(source_ref, '$.deliveryId'), json_extract(source_ref, '$.mailboxId'), id, '', created_at
       FROM cal_events
       WHERE deleted = 0 AND organizer IS NOT NULL AND we_are_organizer = 0 AND source_ref IS NOT NULL
         AND json_extract(source_ref, '$.deliveryId') IS NOT NULL`,
    ],
  },
];
