-- Hand-written. 2026-11 review, finding 19-9: the private asset route
-- finds the row that owns a storage key on every download, and both
-- lookups were sequential scans (item.storage_ref and
-- feature_attachment.storage_key had no index), reachable anonymously.

CREATE INDEX IF NOT EXISTS "item_storage_ref_idx" ON "item" ("storage_ref");
CREATE INDEX IF NOT EXISTS "feature_attachment_storage_key_idx"
  ON "feature_attachment" ("storage_key");
