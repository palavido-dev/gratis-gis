# Morning proposals (Scoper-owned)

Ranked list for Matthew's yay/nay. The Scoper rewrites the **Pending
decision** section each morning from Researcher hand-offs. Format for
the chat post is in [DIGEST.md](./DIGEST.md). Process rules are in
[PLAYBOOK.md](./PLAYBOOK.md).

Do not implement from this file. Developer only takes ids that moved to
`approved` in [QUEUE.md](./QUEUE.md) after an explicit yay.

## Pending decision (2026-11-07)

| rank | id | size | risk | summary | why now |
| --- | --- | --- | --- | --- | --- |

No items. TrueNAS bugs #573 / #575 / #574 were handled in a separate Grok session (merged #578 ingest, #579 Tailscale redirect, #580 geocode + GPS honesty).

Parked (not listed this morning): `recipe-dag` — PostGIS branching recipe graph; still waiting on thinner recipe research.

Resolved outside the loop (not listed): [#551](https://github.com/palavido-dev/gratis-gis/issues/551) reporter-confirmed fixed; still open for Matthew to close.

## Decided this week

| id | decision | when | note |
| --- | --- | --- | --- |
| Q-573-nas-datalayer-polygon | yay (parallel Grok session) | 2026-11-07 | Merged #578 — shapefile/KMZ/GPKG/GeoJSON into data_layer |
| Q-575-nas-tailscale-redirect | yay (parallel Grok session) | 2026-11-07 | Merged #579 — sign-in stays on GRATIS_BASE_URL |
| Q-574-nas-http-locate | yay (parallel Grok session) | 2026-11-07 | Merged #580 — geocode Caddy matcher + GPS secure-context honesty |
| release-1.2.0 | yay | 2026-11-05 | Morning item 1; stamp Unreleased → v1.2.0 |
| analyze-param-manifests | yay | 2026-11-03 | Morning items 1–4 approved |
| Q-162b / R5-weblate-hosting | yay | 2026-11-03 | Chose Weblate; hosting deferred; git PRs until then |
| R2-comments-mentions / R5-comments-mentions | yay | 2026-11-03 | Shipped: email @mentions with abuse defaults |
| R1-presence-crdt / R5-presence-crdt | yay | 2026-11-03 | Thin signed-in Yjs markup co-edit; defaults locked |

## Scoper reject log (not shown at morning)

| id | when | reason |
| --- | --- | --- |
