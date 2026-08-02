#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Give the public demo's tester accounts a workspace worth looking at.
#
# The problem this solves: every item in the golden snapshot is owned
# by the `admin` account, so a tester who signs in lands on "My items"
# owning nothing and gets the empty-workspace panel. The curated
# sample content is there, but it reads as buried, and the first
# impression of the portal is an empty box. The snapshot also carried
# zero item_share rows, so sharing, the feature the project leads
# with, was invisible in the demo.
#
#   sudo ./infra/seed-demo-workspace.sh            # apply
#   sudo ./infra/seed-demo-workspace.sh --revert   # hand it all back
#
# ---------------------------------------------------------------
# READ THIS BEFORE CHANGING WHEN IT RUNS
# ---------------------------------------------------------------
# This must NOT be baked into the golden snapshot. snapshot-golden.sh
# runs cleanup-non-admin.mjs first, which hard-purges every item not
# owned by `admin` (dropping feature tables and MinIO blobs with it).
# A snapshot taken while the sample set belonged to tester-admin
# therefore does not contain a tester-owned workspace; it contains
# no sample set at all. That is not hypothetical; it is how the
# sample content got destroyed once already.
#
# So the ownership split lives outside the snapshot, and the pipeline
# owns both halves:
#
#   restore-golden.sh  -> applies it after every nightly restore
#   snapshot-golden.sh -> reverts it before the non-admin purge
#
# The golden snapshot stays 100% admin-owned, the purge keeps doing
# its job of evicting visitor pollution, and testers still see owned
# and shared content on first sign-in because the reset re-applies
# this every night.
#
# ---------------------------------------------------------------
# WHAT IT DOES
# ---------------------------------------------------------------
# Everything is keyed on `item.seed_kind` (the marker the samples
# seeder writes) rather than on titles or hardcoded UUIDs, so it
# keeps working after the sample set is re-seeded or renamed.
#
#   1. Collection-side items go to tester-contributor: the field
#      survey, the issue-report form, and the form's paired
#      submissions layer. That is what a contributor owns in practice.
#   2. The rest of the sample set goes to tester-admin: the folder,
#      maps, layers, apps, boundary, pick lists, tool.
#   3. Creates a "Randolph County Team" group with all three testers
#      in it, tester-admin as group admin.
#   4. Shares the sample set with that group, so tester-viewer, who
#      correctly owns nothing, still sees content on first sign-in.
#
# The built-in themes, print templates, app templates and basemaps are
# deliberately untouched: they carry their own non-`sample:` seed_kind
# values and belong to the platform, not to a tester.
#
# Ownership transfer does NOT reattribute form responses:
# form_submission.submitted_by is independent of item.owner_id, so
# existing responses stay credited to whoever submitted them.
#
# Both modes are idempotent, and both are no-ops (exit 0, with a
# warning) when the sample set is absent: restore-golden.sh calls
# this unconditionally and a demo without sample content is a
# recoverable state, not a reason to fail the nightly reset.
set -euo pipefail

MODE=apply
case "${1:-}" in
  --revert) MODE=revert ;;
  --apply|'') MODE=apply ;;
  *)
    echo "usage: $0 [--apply|--revert]" >&2
    exit 2
    ;;
esac

PG_CONTAINER="${PG_CONTAINER:-gratis-gis-prod-postgres}"
PG_USER="${PG_USER:-gratisgis}"
PG_DB="${PG_DB:-gratisgis}"
ADMIN_USERNAME="${ADMIN_USERNAME:-admin}"
GROUP_TITLE="${GROUP_TITLE:-Randolph County Team}"

# These two are spliced into SQL string literals below. They are
# operator-set, not user input, but a stray quote would still turn
# into a syntax error inside a transaction against the live database,
# so refuse anything outside a boring character set up front.
for v in ADMIN_USERNAME GROUP_TITLE; do
  if [[ ! "${!v}" =~ ^[A-Za-z0-9._\ -]+$ ]]; then
    echo "FATAL: $v contains characters this script will not splice into SQL: ${!v}" >&2
    exit 2
  fi
done

psql_do() {
  docker exec -i "$PG_CONTAINER" psql -U "$PG_USER" -d "$PG_DB" \
    -v ON_ERROR_STOP=1 "$@"
}

psql_val() {
  docker exec -i "$PG_CONTAINER" psql -U "$PG_USER" -d "$PG_DB" -At -c "$1"
}

# Guard: no sample set means nothing to hand out. Warn and succeed so
# an unseeded demo doesn't fail the nightly reset.
SAMPLE_COUNT="$(psql_val \
  "SELECT count(*) FROM item WHERE deleted_at IS NULL AND seed_kind LIKE 'sample:%'" \
  || echo 0)"
if [[ "${SAMPLE_COUNT:-0}" -eq 0 ]]; then
  echo "WARN: no sample:* items in $PG_DB; nothing to $MODE." >&2
  echo "      Run infra/seed-sample-content.mjs inside the portal-api" >&2
  echo "      container first (see seed-demo-workspace notes)." >&2
  exit 0
fi

if [[ "$MODE" == revert ]]; then
  echo "=== Reverting the demo tester workspace (pre-snapshot) ==="
  # Hand every sample item back to the bootstrap admin and drop the
  # group's shares. The group and its membership stay: they are not
  # items, the purge never sees them, and keeping them means the
  # snapshot carries the group while apply only has to re-point
  # ownership and re-add shares.
  psql_do <<SQL
BEGIN;

DELETE FROM item_share
WHERE principal_type = 'group'
  AND principal_id IN (
    SELECT id FROM "group" WHERE title = '${GROUP_TITLE}' AND deleted_at IS NULL
  );

-- Scope: exactly what apply granted, nothing more. The previous
-- version matched ANY item titled '% - Submissions' regardless of
-- owner, which would have adopted a visitor-created item into admin
-- ownership right before the purge and baked it into the golden
-- snapshot, defeating the purge's whole guarantee. Restrict to items
-- currently owned by the tester accounts (the only owners apply ever
-- assigns) and to the same item condition apply uses.
UPDATE item SET owner_id = (
  SELECT id FROM "user" WHERE username = '${ADMIN_USERNAME}'
)
WHERE owner_id IN (
    SELECT id FROM "user"
    WHERE username IN ('tester-admin', 'tester-contributor', 'tester-viewer')
  )
  AND (
    seed_kind LIKE 'sample:%'
    OR (
      type = 'data-layer'
      AND title = (
        SELECT title || ' - Submissions' FROM item
        WHERE seed_kind = 'sample:form-issue-report' AND deleted_at IS NULL
      )
    )
  );

COMMIT;
SQL
  echo
  psql_do -c "
SELECT u.username AS owner, count(*) AS sample_items
FROM item i JOIN \"user\" u ON u.id = i.owner_id
WHERE i.deleted_at IS NULL
  AND (i.seed_kind LIKE 'sample:%' OR i.title LIKE '% - Submissions')
GROUP BY 1 ORDER BY 2 DESC;"
  echo "Reverted. Safe to snapshot."
  exit 0
fi

echo "=== Seeding the demo tester workspace ==="

psql_do <<SQL
BEGIN;

-- Resolve everything by name. Fails loudly via the check below rather
-- than silently updating zero rows if a username ever changes.
CREATE TEMP TABLE ids AS
SELECT
  (SELECT id FROM organization ORDER BY created_at LIMIT 1)     AS org_id,
  (SELECT id FROM "user" WHERE username = 'tester-admin')       AS admin_id,
  (SELECT id FROM "user" WHERE username = 'tester-contributor') AS contrib_id,
  (SELECT id FROM "user" WHERE username = 'tester-viewer')      AS viewer_id;

DO \$\$
DECLARE r RECORD;
BEGIN
  SELECT * INTO r FROM ids;
  IF r.org_id IS NULL OR r.admin_id IS NULL
     OR r.contrib_id IS NULL OR r.viewer_id IS NULL THEN
    RAISE EXCEPTION 'missing org or tester accounts; run seed-test-users.sh first';
  END IF;
END \$\$;

-- 1. Collection-side items go to the contributor. The submissions
--    layer has no seed_kind of its own (the form creates it), so it
--    is matched through the form's own title prefix.
UPDATE item SET owner_id = (SELECT contrib_id FROM ids)
WHERE deleted_at IS NULL
  AND (
    seed_kind IN ('sample:collection-trail-survey', 'sample:form-issue-report')
    OR (
      type = 'data-layer'
      AND title = (
        SELECT title || ' - Submissions' FROM item
        WHERE seed_kind = 'sample:form-issue-report' AND deleted_at IS NULL
      )
      -- Owner scoping: the real paired layer is admin-owned right
      -- after a restore (or contrib-owned on a re-run). A visitor
      -- item that happens to share the title matches neither and is
      -- left alone.
      AND owner_id IN (
        (SELECT id FROM "user" WHERE username = '${ADMIN_USERNAME}'),
        (SELECT contrib_id FROM ids)
      )
    )
  );

-- 2. Everything else in the curated sample set goes to the admin
--    tester. Deliberately scoped to seed_kind LIKE 'sample:%': the
--    built-in themes, print templates and basemaps stay with the real
--    admin account, as does any ad-hoc content with a null seed_kind.
UPDATE item SET owner_id = (SELECT admin_id FROM ids)
WHERE deleted_at IS NULL
  AND seed_kind LIKE 'sample:%'
  AND owner_id <> (SELECT contrib_id FROM ids);

-- 3. The group. Insert-if-absent keyed on (org, title) so a re-run
--    updates the existing one rather than making a second.
INSERT INTO "group" (id, org_id, title, description, access, owner_id, created_at)
SELECT gen_random_uuid(), org_id, '${GROUP_TITLE}',
       'Shared workspace for the Randolph County sample content. '
       || 'Every tester account belongs to this group.',
       'org'::"GroupAccess", admin_id, now()
FROM ids
WHERE NOT EXISTS (
  SELECT 1 FROM "group"
  WHERE org_id = (SELECT org_id FROM ids)
    AND title = '${GROUP_TITLE}'
    AND deleted_at IS NULL
);

CREATE TEMP TABLE grp AS
SELECT id FROM "group"
WHERE org_id = (SELECT org_id FROM ids)
  AND title = '${GROUP_TITLE}'
  AND deleted_at IS NULL
LIMIT 1;

-- Enum literals need explicit casts here: Postgres cannot infer the
-- column type through a UNION of untyped literals, and fails with
-- "column role is of type GroupRole but expression is of type text".
INSERT INTO group_member (group_id, user_id, role, joined_at)
SELECT (SELECT id FROM grp), admin_id, 'admin'::"GroupRole", now() FROM ids
UNION ALL
SELECT (SELECT id FROM grp), contrib_id, 'member'::"GroupRole", now() FROM ids
UNION ALL
SELECT (SELECT id FROM grp), viewer_id, 'member'::"GroupRole", now() FROM ids
ON CONFLICT (group_id, user_id) DO UPDATE SET role = EXCLUDED.role;

-- 4. Share the sample set with the group. The collection surface gets
--    edit so a contributor tester can actually capture something; the
--    rest is view. Org-role still caps what a viewer can do, so the
--    edit grant does not hand tester-viewer write access.
INSERT INTO item_share (item_id, principal_type, principal_id, permission, row_scope, created_at)
SELECT i.id, 'group'::"PrincipalType", (SELECT id FROM grp),
       (CASE
         WHEN i.seed_kind IN ('sample:collection-trail-survey', 'sample:form-issue-report')
           THEN 'edit'
         ELSE 'view'
       END)::"SharePermission",
       'all'::"ShareRowScope", now()
FROM item i
WHERE i.deleted_at IS NULL
  AND (
    i.seed_kind LIKE 'sample:%'
    -- The form's paired submissions layer, which carries no seed_kind
    -- of its own. Without it a group member can open the survey but
    -- not the data it has collected, which reads as broken. Owner
    -- scoping for the same reason as the ownership update above: a
    -- visitor item with a coincidental title must not get shared.
    OR (
      i.type = 'data-layer'
      AND i.title = (
        SELECT title || ' - Submissions' FROM item
        WHERE seed_kind = 'sample:form-issue-report' AND deleted_at IS NULL
      )
      AND i.owner_id = (SELECT contrib_id FROM ids)
    )
  )
ON CONFLICT (item_id, principal_type, principal_id)
  DO UPDATE SET permission = EXCLUDED.permission;

COMMIT;
SQL

echo
echo "=== Result ==="
psql_do -c "
SELECT u.username AS owner, count(*) AS sample_items
FROM item i JOIN \"user\" u ON u.id = i.owner_id
WHERE i.deleted_at IS NULL
  AND (i.seed_kind LIKE 'sample:%' OR i.title LIKE '% - Submissions')
GROUP BY 1 ORDER BY 2 DESC;"

psql_do -c "
SELECT g.title AS grp, u.username AS member, m.role
FROM group_member m
JOIN \"group\" g ON g.id = m.group_id
JOIN \"user\" u ON u.id = m.user_id
ORDER BY g.title, u.username;"

psql_do -c "
SELECT s.permission, count(*) AS items
FROM item_share s WHERE s.principal_type = 'group'
GROUP BY 1 ORDER BY 2 DESC;"
