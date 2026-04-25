-- Task #32: add `download` to SharePermission, between `view` and
-- `edit`. Lets an item owner share a data_layer for visualization
-- (the grantee sees features on a map, queries attributes via
-- popups) while preventing bulk extract of the underlying data via
-- the GeoJSON dump endpoint. Existing 'view' shares stay 'view' and
-- do NOT silently gain download access; the upgrade is a deliberate
-- re-share at the new tier.
--
-- Postgres requires ALTER TYPE ADD VALUE outside a transaction
-- block, which Prisma's migration runner already handles per file.
-- We pin the new value's position with BEFORE 'edit' so the
-- declared enum order matches the privilege ladder
-- (view < download < edit < admin) and any UI that reads the enum
-- order gets a sensible default.

ALTER TYPE "SharePermission" ADD VALUE 'download' BEFORE 'edit';
