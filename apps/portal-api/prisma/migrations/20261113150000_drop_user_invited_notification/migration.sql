-- Remove the 'user-invited' notification type. Nothing ever sent it:
-- Keycloak sends the invite email itself and never hands the portal
-- the invite link, so the toggle and template only pretended to work.
-- Postgres cannot drop an enum value, so the type is rebuilt without
-- it. Rows for the removed type (preferences, defaults, templates,
-- queued notifications) are deleted first.

DELETE FROM "notification_preference" WHERE "type" = 'user-invited';
DELETE FROM "notification_type_default" WHERE "type" = 'user-invited';
DELETE FROM "notification_template" WHERE "type" = 'user-invited';
DELETE FROM "notification" WHERE "type" = 'user-invited';

ALTER TYPE "NotificationType" RENAME TO "NotificationType_old";
CREATE TYPE "NotificationType" AS ENUM (
  'share-created',
  'share-expiring',
  'share-expired',
  'user-auto-disable-warning',
  'user-disabled',
  'editor-feature-created',
  'data-collection-feature-created',
  'form-submission-received',
  'data-collection-schema-break',
  'comment-mentioned',
  'backup-failed'
);
ALTER TABLE "notification_preference"
  ALTER COLUMN "type" TYPE "NotificationType" USING ("type"::text::"NotificationType");
ALTER TABLE "notification_type_default"
  ALTER COLUMN "type" TYPE "NotificationType" USING ("type"::text::"NotificationType");
ALTER TABLE "notification_template"
  ALTER COLUMN "type" TYPE "NotificationType" USING ("type"::text::"NotificationType");
ALTER TABLE "notification"
  ALTER COLUMN "type" TYPE "NotificationType" USING ("type"::text::"NotificationType");
DROP TYPE "NotificationType_old";
