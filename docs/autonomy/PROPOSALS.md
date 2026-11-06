# Morning proposals (Scoper-owned)

Ranked list for Matthew's yay/nay. The Scoper rewrites the **Pending
decision** section each morning from Researcher hand-offs. Format for
the chat post is in [DIGEST.md](./DIGEST.md). Process rules are in
[PLAYBOOK.md](./PLAYBOOK.md).

Do not implement from this file. Developer only takes ids that moved to
`approved` in [QUEUE.md](./QUEUE.md) after an explicit yay.

## Pending decision (2026-11-06)

| rank | id | size | risk | summary | why now |
| --- | --- | --- | --- | --- | --- |
| 1 | Q-573-nas-datalayer-polygon | M | med | TrueNAS: shapefile zip / KMZ / GeoJSON into a data layer fails or yields an empty layer (#573); GeoJSON-on-map works | Blocks dashboards that require data_layer sources. Same reporter who unblocked #551; core ingest reliability on the NAS path we just shipped. |
| 2 | Q-575-nas-tailscale-redirect | S | med | Tailscale reachability: login bounces back to LAN IP instead of the Tailscale hostname (#575) | Documented optional Tailscale mode in truenas.md; broken auth redirect makes that path unusable. Likely Keycloak / `GRATIS_BASE_URL` / hostname config — confirm and fix or document the required setting. |
| 3 | Q-574-nas-http-locate | S | low | Locate address / my location fails on plain-HTTP NAS (#574); reporter suspects insecure context | Geolocation needs a secure context; address search may share the same failure class as #551. Prefer honest UX + docs over pretending browser locate works on `http://`. |

Parked (not listed this morning): `recipe-dag` — PostGIS branching recipe graph; still waiting on thinner recipe research.

Resolved outside the loop (not listed): [#551](https://github.com/palavido-dev/gratis-gis/issues/551) reporter-confirmed fixed; still open for Matthew to close.

## Decided this week

| id | decision | when | note |
| --- | --- | --- | --- |
| release-1.2.0 | yay | 2026-11-05 | Morning item 1; stamp Unreleased → v1.2.0 |
| analyze-param-manifests | yay | 2026-11-03 | Morning items 1–4 approved |
| Q-162b / R5-weblate-hosting | yay | 2026-11-03 | Chose Weblate; hosting deferred; git PRs until then |
| R2-comments-mentions / R5-comments-mentions | yay | 2026-11-03 | Shipped: email @mentions with abuse defaults |
| R1-presence-crdt / R5-presence-crdt | yay | 2026-11-03 | Thin signed-in Yjs markup co-edit; defaults locked |

## Scoper reject log (not shown at morning)

| id | when | reason |
| --- | --- | --- |
