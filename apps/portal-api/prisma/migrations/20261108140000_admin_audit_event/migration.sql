-- Org admin audit. This is not the feature observation log.
-- Rows name an actor id, a target id, an action, and an outcome.
-- They do not store passwords, tokens, request bodies, or email.

CREATE TABLE "admin_audit_event" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor_user_id" UUID,
    "action" TEXT NOT NULL,
    "target_type" TEXT NOT NULL,
    "target_id" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "detail" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "admin_audit_event_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "admin_audit_event_outcome_check" CHECK ("outcome" IN ('succeeded', 'failed', 'denied')),
    CONSTRAINT "admin_audit_event_org_fkey" FOREIGN KEY ("org_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "admin_audit_event_org_at_idx" ON "admin_audit_event" ("org_id", "at" DESC, "id" DESC);
