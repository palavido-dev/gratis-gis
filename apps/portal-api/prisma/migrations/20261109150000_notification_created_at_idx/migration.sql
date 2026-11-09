-- The admin "recent" list sorts by created_at, and the retention
-- sweep deletes by it. Without this index both scan the whole table.
CREATE INDEX IF NOT EXISTS "notification_created_at_idx" ON "notification" ("created_at");
