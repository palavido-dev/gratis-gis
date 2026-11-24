-- Storage usage per organization.
--
-- storage_object: one row per stored object (key, owner org, kind,
-- size read from the store). org_storage_usage: running totals per
-- org, changed in the same transaction as the object row.
-- layer_storage_usage: estimated size of each layer's feature rows.
--
-- Three new, empty tables: no lock on existing data and nothing to
-- rewrite, so this is quick on any install. Existing objects are not
-- backfilled here. The daily usage reconcile (or the separate
-- storage-usage-backfill script, run on demand) fills the ledger by
-- listing the bucket in pages, so a large bucket never holds a
-- migration open.

CREATE TABLE "storage_object" (
  "key"        TEXT NOT NULL,
  "org_id"     UUID NOT NULL,
  "kind"       TEXT NOT NULL,
  "bytes"      BIGINT NOT NULL,
  "item_id"    UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "deleted_at" TIMESTAMPTZ(6),
  CONSTRAINT "storage_object_pkey" PRIMARY KEY ("key")
);

CREATE INDEX "storage_object_org_kind_idx" ON "storage_object"("org_id", "kind");

CREATE TABLE "org_storage_usage" (
  "org_id"        UUID NOT NULL,
  "bytes"         BIGINT NOT NULL DEFAULT 0,
  "objects"       BIGINT NOT NULL DEFAULT 0,
  "feature_bytes" BIGINT NOT NULL DEFAULT 0,
  "feature_count" BIGINT NOT NULL DEFAULT 0,
  "reconciled_at" TIMESTAMPTZ(6),
  "drift_bytes"   BIGINT NOT NULL DEFAULT 0,
  "drift_objects" INTEGER NOT NULL DEFAULT 0,
  "updated_at"    TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "org_storage_usage_pkey" PRIMARY KEY ("org_id")
);

CREATE TABLE "layer_storage_usage" (
  "item_id"       UUID NOT NULL,
  "layer_key"     TEXT NOT NULL,
  "org_id"        UUID NOT NULL,
  "feature_count" BIGINT NOT NULL DEFAULT 0,
  "avg_row_bytes" INTEGER NOT NULL DEFAULT 0,
  "sampled_count" BIGINT NOT NULL DEFAULT 0,
  "est_bytes"     BIGINT NOT NULL DEFAULT 0,
  "sampled_at"    TIMESTAMPTZ(6),
  "measured_at"   TIMESTAMPTZ(6),
  CONSTRAINT "layer_storage_usage_pkey" PRIMARY KEY ("item_id", "layer_key")
);

CREATE INDEX "layer_storage_usage_org_measured_idx" ON "layer_storage_usage"("org_id", "measured_at");
