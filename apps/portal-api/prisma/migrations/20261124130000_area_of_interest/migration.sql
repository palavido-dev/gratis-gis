-- Areas of interest for What's Here (#796). A screen resolves its
-- area once (union, make valid, buffer) and each layer read names it
-- by id. The id is a hash of the geometry. The table holds shapes
-- only, belongs to no org, and is pruned of rows unused for a week.
CREATE TABLE "area_of_interest" (
    "id" TEXT NOT NULL,
    "geom" geometry(Geometry, 4326) NOT NULL,
    "square_meters" DOUBLE PRECISION NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "area_of_interest_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "area_of_interest_last_used_at_idx" ON "area_of_interest"("last_used_at");
