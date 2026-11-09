-- Known differences between the migration history and schema.prisma.
-- scripts/check-prisma-drift.sh fails when `prisma migrate diff` finds
-- a statement that is not listed here. Never hand-lift these into a
-- migration: each one would break something.
--
-- item.bbox_geom is a generated geometry column with a GiST index.
-- Prisma cannot declare generated columns.
-- observation is the partitioned observation log, managed by raw SQL
-- and pg_partman. It has no Prisma model on purpose.
-- notification_type_default.type and .channel are TEXT in the
-- database and enums in the client.
-- backup_config.id defaults to gen_random_uuid() in the database.
--
-- When a later change removes one of these, delete it here too.

-- DropIndex
DROP INDEX "item_bbox_geom_idx";

-- AlterTable
ALTER TABLE "backup_config" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "item" DROP COLUMN "bbox_geom";

-- AlterTable
ALTER TABLE "notification_type_default" DROP CONSTRAINT "notification_type_default_pkey",
DROP COLUMN "type",
ADD COLUMN     "type" "NotificationType" NOT NULL,
DROP COLUMN "channel",
ADD COLUMN     "channel" "NotificationChannel" NOT NULL,
ADD CONSTRAINT "notification_type_default_pkey" PRIMARY KEY ("type", "channel");

-- DropTable
DROP TABLE "observation";

