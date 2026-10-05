-- Self-host v1 schema. Every lookup the Worker makes has an index (D1 free
-- tier enforces daily row-read limits, so no full scans on hot paths).

CREATE TABLE settings (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
) WITHOUT ROWID;

-- Baseline state per class (a = assignments, p = posts).
CREATE TABLE classes (
  name         TEXT PRIMARY KEY,
  a_baselined  INTEGER NOT NULL DEFAULT 0,
  p_baselined  INTEGER NOT NULL DEFAULT 0,
  last_sync_at INTEGER
) WITHOUT ROWID;

-- Assignments (kind 'a') and posts (kind 'p'). Text columns hold plain text only.
CREATE TABLE items (
  key             TEXT PRIMARY KEY,
  kind            TEXT NOT NULL CHECK (kind IN ('a', 'p')),
  class           TEXT NOT NULL,
  title           TEXT NOT NULL DEFAULT '',
  body            TEXT,
  due_iso         TEXT,
  due_ms          INTEGER,
  tab             TEXT,
  submitted       INTEGER NOT NULL DEFAULT 0,
  tag             TEXT,
  ts              TEXT,
  first_seen      INTEGER NOT NULL,
  missing_sync_id TEXT,
  missing_at      INTEGER,
  removed_at      INTEGER,
  done_at         INTEGER
) WITHOUT ROWID;

-- Ingest: load the live assignments of one class.
CREATE INDEX items_class_live ON items (class) WHERE kind = 'a' AND removed_at IS NULL;
-- Reminder cron and /today /week /due /plan: open assignments by due time.
CREATE INDEX items_open_due ON items (due_ms) WHERE kind = 'a' AND removed_at IS NULL AND submitted = 0;

-- Change events and reminders: one outbox. A row is sent at most once at a
-- time (claimed_at lease) and marked sent only after Telegram confirms.
CREATE TABLE events (
  id         TEXT PRIMARY KEY,
  type       TEXT NOT NULL,
  item_key   TEXT,
  created_at INTEGER NOT NULL,
  payload    TEXT NOT NULL,
  priority   TEXT NOT NULL DEFAULT 'normal',
  not_before INTEGER NOT NULL,
  claimed_at INTEGER,
  sent_at    INTEGER,
  attempts   INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;

CREATE INDEX events_created ON events (created_at, id);
CREATE INDEX events_outbox ON events (not_before) WHERE sent_at IS NULL;

-- Reminder idempotency: id = itemKey \0 dueIso \0 slot.
CREATE TABLE reminders_sent (
  id         TEXT PRIMARY KEY,
  item_key   TEXT NOT NULL,
  created_at INTEGER NOT NULL
) WITHOUT ROWID;

-- One row per syncId (a "Sync all classes" run spans one call per class).
CREATE TABLE syncs (
  id       TEXT PRIMARY KEY,
  first_at INTEGER NOT NULL,
  last_at  INTEGER NOT NULL,
  calls    INTEGER NOT NULL DEFAULT 1
) WITHOUT ROWID;

-- Fixed-window counters (S5: /setup rate limit).
CREATE TABLE rate (
  k            TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count        INTEGER NOT NULL
) WITHOUT ROWID;
