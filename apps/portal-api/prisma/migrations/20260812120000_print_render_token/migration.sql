-- #229 shared store for single-use print render tokens.
--
-- Replaces the per-process in-memory map in PrintRenderService. Prod
-- runs portal-api at two replicas behind DNS round-robin, so the
-- token was minted on one replica and the chromium sidecar's
-- callback to consume it landed on the other about half the time,
-- where the map had no entry: the preview rendered notFound() and the
-- sidecar captured a 404 page as the PDF. A shared row fixes it, and
-- consuming via DELETE keeps the single-use guarantee across replicas.

CREATE TABLE "print_render_token" (
    "token" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "template_id" UUID NOT NULL,
    "map_id" UUID NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "print_render_token_pkey" PRIMARY KEY ("token")
);

-- Supports the opportunistic expired-token sweep done at mint time.
CREATE INDEX "print_render_token_expires_at_idx" ON "print_render_token" ("expires_at");
