-- FeatureServer layer numbers, and ObjectID order within a layer.
--
-- An Esri client names a layer by number (FeatureServer/0, /1, ...).
-- A sublayer gets its number the first time the FeatureServer interface
-- sees it and keeps it, so a Pro project that points at layer 2 still
-- reads the same layer after others are added or removed. Numbers are
-- never reused within an item.
CREATE TABLE "featureserver_layer" (
    "item_id" UUID NOT NULL,
    "layer_id" TEXT NOT NULL,
    "layer_index" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "featureserver_layer_pkey" PRIMARY KEY ("item_id", "layer_id")
);

CREATE UNIQUE INDEX "featureserver_layer_item_id_layer_index_key"
    ON "featureserver_layer"("item_id", "layer_index");

-- Queries page through a layer in ObjectID order.
CREATE INDEX "feature_oid_scope_oid_idx" ON "feature_oid"("scope", "oid");
