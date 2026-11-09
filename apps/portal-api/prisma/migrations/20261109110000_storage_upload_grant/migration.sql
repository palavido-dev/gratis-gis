-- Who was issued each presigned upload key. Attach paths (item create
-- and update, tile layer and point cloud finalize, mosaic sources,
-- feature attachment register) accept a client-supplied key only when
-- the caller was issued it or the target already references it.
-- New, empty table: no lock on existing data.
CREATE TABLE "storage_upload_grant" (
  "key"        TEXT PRIMARY KEY,
  "user_id"    UUID NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);

CREATE INDEX "storage_upload_grant_created_at_idx" ON "storage_upload_grant"("created_at");
