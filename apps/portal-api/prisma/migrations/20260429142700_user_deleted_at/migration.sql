-- Add a soft-delete marker to "user". Set by the KeycloakSyncService
-- reconcile pass when a Prisma row's Keycloak entry is gone, so the
-- principal picker stops showing users who have been removed from the
-- realm without us having to hard-delete the row (which would either
-- cascade-delete their items or block on the FK). Mirrors the
-- Group.deleted_at and Item.deleted_at columns.
ALTER TABLE "user" ADD COLUMN "deleted_at" TIMESTAMP(3);
CREATE INDEX "user_deleted_at_idx" ON "user"("deleted_at");
