-- Removes everything the deploy test created, so the instance is unclaimed
-- again for the S5 /setup flow. Test data uses class names "Load Test …"
-- and syncIds "loadtest-…". Safe to run twice.
DELETE FROM events WHERE item_key IN (SELECT key FROM items WHERE class LIKE 'Load Test %');
DELETE FROM reminders_sent WHERE item_key IN (SELECT key FROM items WHERE class LIKE 'Load Test %');
DELETE FROM items WHERE class LIKE 'Load Test %';
DELETE FROM classes WHERE name LIKE 'Load Test %';
DELETE FROM syncs WHERE id LIKE 'loadtest-%';
DELETE FROM settings WHERE k IN ('ingest_key_hash', 'last_sync_at');
