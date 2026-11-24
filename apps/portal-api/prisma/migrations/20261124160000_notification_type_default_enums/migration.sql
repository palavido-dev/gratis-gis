-- notification_type_default.type and .channel were created as TEXT,
-- but the Prisma schema declares them as the NotificationType and
-- NotificationChannel enums. Every lookup by (type, channel) then
-- compared text with an enum and failed, so saving a notification
-- preference and saving an org default both answered 500.
--
-- Change both columns to the enums. Rows were only ever written
-- through the enum-typed client, so each value casts. A value that
-- does not cast stops the migration rather than being dropped.
ALTER TABLE "notification_type_default"
  ALTER COLUMN "type" TYPE "NotificationType" USING "type"::"NotificationType",
  ALTER COLUMN "channel" TYPE "NotificationChannel" USING "channel"::"NotificationChannel";
