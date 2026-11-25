-- Two nullable columns and one index on tables added by the previous
-- migration. Nothing is rewritten.
--
-- storage_object.last_read_at: when a cached image embedding was last
-- served, so the per-item cap removes the least recently used first.
-- layer_storage_usage.measure_error: why the last measure of a layer
-- failed, so one failing layer is recorded and passed over instead of
-- holding the nightly queue.

ALTER TABLE "storage_object" ADD COLUMN "last_read_at" TIMESTAMPTZ(6);

ALTER TABLE "layer_storage_usage" ADD COLUMN "measure_error" TEXT;

CREATE INDEX "storage_object_item_kind_idx" ON "storage_object"("org_id", "item_id", "kind");
