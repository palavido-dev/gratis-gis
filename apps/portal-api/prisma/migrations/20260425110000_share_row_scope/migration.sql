-- Add ShareRowScope enum and item_share.row_scope column.
-- See task #40. Default value is 'all' so existing shares keep
-- their pre-rowScope behaviour; new shares can opt into 'own'.

CREATE TYPE "ShareRowScope" AS ENUM ('all', 'own');

ALTER TABLE "item_share"
  ADD COLUMN "row_scope" "ShareRowScope" NOT NULL DEFAULT 'all';