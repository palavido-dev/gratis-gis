# Raw SQL inventory

Every hand-written SQL call site in `apps/portal-api/src` (test files and
`src/testing/` left out), with the tables it touches, where the id it
filters by comes from, and the check that makes it safe.

This is the RB-02 audit. RB-06 (database roles and row-level security)
builds on it.

- Generated against `main` at v1.7.0 plus one commit, and kept up to
  date since.
- `node scripts/check-raw-sql.mjs` counts the same sites per file and
  fails CI when the counts move or when a row's `file:line` no longer
  holds a site of its kind. See "Keeping this up to date" at the end.

## Totals

**244 sites** in 55 files. The guard counts the same 244.

| Kind | Sites | What it is |
| --- | ---: | --- |
| `prisma` | 190 | `.$queryRaw`, `.$executeRaw`, `.$queryRawUnsafe`, `.$executeRawUnsafe` calls |
| `pg` | 37 | node-postgres calls on connections outside Prisma (`client.query`, `admin.query`, `writer.query`, the CopyWriter `this.query<>` passthrough) |
| `raw` | 17 | `Prisma.raw(...)` fragments, which put text into SQL unescaped |

| Class | Sites |
| --- | ---: |
| item-scoped | 130 |
| system | 96 |
| external | 9 |
| org-scoped | 9 |
| user-scoped | 0 |
| UNVERIFIED | 0 |
| GAP | 0 |

The runbook's figure of 176 was a plain text count. 19 of those matches
are comments or type declarations (for example
`Pick<PrismaService, '$queryRawUnsafe'>`), which leaves 157 real Prisma
calls. The runbook did not count node-postgres calls or `Prisma.raw`.

`Prisma.sql` fragments are not counted on their own. Every fragment in
the tree is executed through one of the counted `prisma` sites (most go
through `engine/data-layer.ts`, plus `common/closed-geo-limit.ts`,
which builds geo limit predicates as parameters). `Prisma.join` and
`Prisma.empty` only combine fragments.

## Findings

The audit found two places where a read or a stored value was not held to
the caller's organization. Both were on older code paths and both are
fixed (#800). A default self-hosted install has one organization, where
neither applied.

- **F-1, fixed.** The item-level GeoJSON read and the derived layer read
  now resolve a clip boundary with the same rule as the v3 feature
  routes: the boundary applies when the caller can read it or it is in
  the layer's organization. The rule lives in `items/clip-boundary.ts`.
  Sites: rows 36 and 159.
- **F-2, fixed.** The stored extent refresh only uses referenced items
  from the same organization as the map or editor, or public ones, and
  the refresh after a layer write follows references under the same rule.
  Site: row 147.

Follow-ups, not yet done:

- The housekeeping extent recompute keeps same-organization references
  only, with no exception for public items, so it can differ from the
  refresh for a public layer in another organization.
- Map save stores layer ids as given and does not check that the author
  can read them.

### Not findings, but RB-06 must handle them

- **Connections outside the Prisma pool.** These do not go through
  `PrismaService` and will not get a per-request org stamp from a
  wrapped pool:
  - `engine/copy-writer.ts`: opens its own `pg.Pool` from `DATABASE_URL`
    and writes tenant feature rows (COPY, deletes, `item` row locks).
    The import paths (`IngestController` import route,
    `ImportJobsWorker`) must stamp the org on this connection too.
  - `engine/tile-cache.service.ts`: one long-lived `LISTEN` client. Must
    not be stamped per request.
  - `cron/leader-election.service.ts`: one long-lived client holding an
    advisory lock. Must not be stamped per request.
  - `maintenance/collation-refresh.ts`: CLI with its own admin client.
  - `postgis-live/*`: customer databases, not ours (class `external`).
- **Cross-org on purpose inside a user request.** These run while a
  normal user's request is in flight, not in a worker, and need
  `runAsSystem` (RB-00) or they will quietly see only one org under RLS:
  `admin/resource-quota.service.ts` (`reserve`, deletes stale holds of
  every org), `storage/key-ownership.ts` (`isKeyReferencedElsewhere`,
  may delete an object another org still references if it only sees one
  org), `items/items.service.ts` (`spliceFromLandingFeatured`,
  `spliceFromFolders`), and `analysis/analysis-target-stamp.ts` when
  called from `AnalysisService`.
- **`runAsSystem` does not exist yet.** RB-00 has not merged, so no
  `system` site can be confirmed to run in it. Every `system` row below
  is a place that needs it.
- **Feature rows have no org column.** Every `item-scoped` statement on
  `observation` relies on the `data_layer:<itemId>:<layerId>` scope and
  the caller's item check. RLS on `observation` is RB-06 stage 3.

## Access chains

Item-scoped rows name one of these chains. Each starts at a controller
or worker and ends at the SQL with the same item id.

- **CH-V3R** (v3 reads, signed in). `DataLayerFeaturesController`
  routes under `/items/:id/layers/:layerId/` (`features`,
  `features-page`, `aggregate`, `features-search`, `selection-extent`,
  `filtered-extent`, `tile/:z/:x/:y.mvt`, `tilejson.json`, `delta`,
  `geojson`, `csv`, `geoparquet`) call
  `assertV3Layer(user, itemId, layerId, 'read')` (directly or through
  `buildScopedReadOpts`). That runs `ItemsService.get(user, itemId)`
  (`SharingService.canRead`, 404 when unreadable or trashed) and
  `SharingService.featureScopeFor`. The same `itemId` and `layerId` go to
  `DataLayerFeaturesService.<method>`, then `DataLayerEngine.<method>`,
  which builds `scope = dataLayerScope(itemId, layerId)`.
- **CH-V3W** (v3 writes). Same controller, `POST features`,
  `POST features/calculate-field`, `PATCH features/:fid`,
  `DELETE features/:fid`, `DELETE sync-conflicts/:conflictId`:
  `assertV3Layer(..., 'write')` adds `ItemsService.assertCanEdit` and
  `assertLayerEditingEnabled`, and the edit share scope.
- **CH-VIA** (relate filter, `?via=`). Signed in: `resolveVia` runs
  `assertV3Layer(user, parentItemId, parentLayerId, 'read')` and refuses
  row-scoped parents. Public: `resolvePublicVia` requires the parent to
  be `access = 'public'`, live, and a `data_layer`.
- **CH-PUB** (anonymous). `PublicController` routes under
  `/public/items/:id/layers/:layerId/` load the item with
  `findFirst({ id, type: 'data_layer', access: 'public', deletedAt: null })`
  and apply the owner's public boundary. Public OGC features and tiles
  (`resolvePublicCollection`, `resolvePublicTileset`) use the same gate.
- **CH-OGC** (signed in OGC API). `AuthedOgcFeaturesController.resolveCollection`
  runs `ItemsService.get` and the share scope, then calls the v3 service
  with that item id.
- **CH-SVC** (internal reads after a check). `AnalysisService` zonal
  stats (`items.get(user, zoneItemId)` + `featureReadScope`),
  `AiFeaturesService` (`items.get` + `featureScopeFor`), attachment
  routes (`assertAttachmentAccess` runs `items.get`, `assertCanEdit` for
  writes).
- **CH-NEW** (writes into an item the caller just made).
  `OsmSaveAsLayerService`, `DrawingsPromoteService` and AGO hosted
  feature import call `ItemsService.create(user, ...)` and write into the
  returned id.
- **CH-FORM** (form submission mirror). `FormsService.assertMirrorTarget`
  requires the linked layer to be a live `data_layer` in the form's org
  that the form owner can edit.
- **CH-IMP** (bulk import). `POST /items/:id/layers/:layerId/import`
  (`IngestController`) and the async import enqueue
  (`ImportJobsController`) both run `ItemsService.get` and
  `assertCanImportAllRows` (edit, and no row or area limit). The worker
  then trusts `job.itemId` from the row it claimed.
- **CH-SAMPLES**. `SamplesService` seeds sample items it created.
- **CH-LEG** (legacy `fs_<id>` routes). `FeaturesController`
  (`/items/:id/features`) uses `requireReadAccess` (`ItemsService.get`,
  not v3, table exists), `requireEditAccess` (adds `canEdit`) and
  `requireEditAccessAndProvision`, then `scopeFor` for row and area
  limits. `RelationshipsController` requires `canAdmin` on both parent
  and child. `IngestController` `POST /items/:id/ingest` runs
  `ItemsService.get` + `canEdit` + `assertNotV3DataLayer`.

Bulk paths: the list decorators in `ItemsService.queryListRows` and
`PublicController.publicItemsFor` take arrays of ids, and every id in
them came out of a query that already applied visibility
(`visibleWhere(user)`, or `orgId` plus `access = 'public'`). Feature id
arrays (`entityIds`, `featureIds`) are always matched inside a checked
scope, so an id from another layer matches nothing.

## Legacy `fs_<id>` tables

`features/features.service.ts` keeps one table per legacy data layer,
named `fs_<item id without dashes>`. Names are built by `toTableName`
from a strict UUID regex.

Routes that still reach them:

- `/items/:id/features`: list, append, `POST import`, get one, history,
  `PATCH`, `DELETE`, related list and create (`FeaturesController`).
- `POST /items/:id/relationships` (`addParentKeyColumn`, `tableExists`).
- `POST /items/:id/ingest` (`provisionTable`, `replaceAll`, `stats`).
- `GET /items/:id/geojson` for an item with `storageType: 'postgis'` and
  no `version: 3` (`ItemsService.getGeoJson`), including analysis zones
  that fall back to it.
- Purge: `ItemsService.tearDownItemBackingStorage` drops the table.

Can data still be in them? Yes:

- Migration `20260507230000_drop_fs_tables` backfilled and dropped only
  the v3 per-layer tables (`fs_<32hex>_<suffix>`). It says in its header
  that the v2 single tables (`fs_<32hex>`) are not touched.
- New ones can still be created today. `ItemsService.create` does not
  force `version: 3` on a `data_layer`, and both `POST .../features/import`
  and `POST /items/:id/ingest` provision a table for any data layer that
  is not v3.
- Whether a given install has rows there can only be told on that
  database:
  `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename ~ '^fs_[0-9a-f]{32}$'`
  and items with `data_json->>'storageType' = 'postgis'` and
  `data_json->>'version'` not `'3'`.

Why it matters for Cloud: these tables have no org column, they are
created at runtime by the API's own role (which under RB-06 should not
have `CREATE` on the schema), and no row-level policy can cover a table
that does not exist yet.

Recommendation (decision for a human):

- Keep them for self-hosted installs until their data is moved.
- In `multi` mode, return 404 from the legacy routes and refuse to
  create a `data_layer` without `version: 3`. Small change, closes the
  runtime DDL path.
- Then a migration that backfills `fs_<32hex>` rows into `observation`
  (the same approach `20260507230000` took for v3) and converts those
  items to v3, after which `FeaturesService`, `FeaturesController`, the
  relationships routes and the legacy branch of `getGeoJson` can go.
- `FeaturesService.dropTable` has no caller and can be removed any time.

## Database objects RB-06 needs to know about

From `apps/portal-api/prisma/migrations` and `infra/`.

| Object | Kind | Where | Note for RB-06 |
| --- | --- | --- | --- |
| (none) | `SECURITY DEFINER` function | n/a | No function is declared `SECURITY DEFINER`. All run as the caller. |
| (none) | view or materialized view | n/a | No views. |
| `observation_notify_written()` + trigger `observation_notify_written` | `AFTER INSERT` row trigger on `observation` | `20260903150000_observation_notify_trigger` | Calls `pg_notify('gg_observation_written', scope)`. Runs as the inserting role. Cloned onto every partition, including ones pg_partman makes later. |
| `analysis_job_lease_guard()` + trigger `analysis_job_lease_guard` | `BEFORE UPDATE` trigger on `analysis_job` | `20261108120000_analysis_job_claim_token` | Fences stale workers by claim token. Runs as the updating role. |
| `gg_record_dismissed_seed_kind()` + trigger `item_record_dismissed_seed_kind` | `AFTER DELETE` trigger on `item` | `20261113131000_org_dismissed_seed_kinds` | Updates `organization` for `OLD.org_id`. Under RLS the deleting session must be allowed to update its own org row, or the trash purge cron must run as system. |
| `gg_expr_num`, `gg_expr_bool`, `gg_expr_ts`, `gg_expr_ts_text`, `gg_expr_list`, `gg_expr_month_diff` | SQL helper functions | `20261124090000_expression_functions` | Pure, no table access. `app` role needs `EXECUTE`. |
| `gg_try_timestamptz`, `gg_try_int` | plpgsql helper functions | `20261112190500_safe_text_casts` | Pure. `EXECUTE` grant. |
| `area_of_interest` | table with no `org_id` | `20261124130000_area_of_interest` | What's Here areas (#796), shared across orgs by design: shapes only, content addressed, pruned after a week unused. Needs no org policy; the `app` role needs SELECT, INSERT, UPDATE and DELETE. |
| `pg_temp.gg_sanitize_id` | temp function | `20260507230000_drop_fs_tables` | Migration only, gone after the session. |
| `pg_partman` extension in schema `partman`; `create_parent('public.observation', ...)` monthly on `tx_time` | partitioning | `20260508081000_partition_observation_table`, `20260726150000_observation_partman_premake_tuning` | New partitions are created by the owner. Policies on the parent apply to queries through the parent only. |
| `pg_partman_bgw` background worker, `pg_partman_bgw.role=gratisgis` | maintenance | `infra/docker-compose.yml` (also `.prod`, `.nas`) | Runs as the owner role. Keep it on the owner. |
| `partman.part_config`, `partman.show_partitions`, `partman.show_partition_info` | reads | `maintenance/partition-runway.service.ts`, `infra/postgres/partition-runway.sql` | The `app` role needs `USAGE` on schema `partman` and `SELECT` on `part_config`, or the hourly check reports nothing. |
| `pg_repack` | mentioned only | `20260510210000_observation_orphan_cleanup` (comment) | Not installed or called by the code. Operators may run it by hand as the owner. |
| `ALTER ROLE current_user SET statement_timeout` | role setting | `20260518150000_app_role_statement_timeout` | Applies to the migrating role only. `gratisgis_app` needs the same setting, or API queries lose their 30 s cap. |
| `GRANT USAGE ON SCHEMA tiles TO CURRENT_USER` | grant | `infra/init-prod-db.sql` | `gratisgis_app` needs it too if it reads `tiles`. |

## Inventory

Classes:

- **item-scoped**: filtered by an item id or `data_layer:` scope that
  the caller checked. The check or chain is named.
- **org-scoped**: filtered by `org_id` from the caller's user.
- **user-scoped**: filtered by the caller's own user id. (None today.)
- **system**: cron, worker, queue claim, migration helper, metrics,
  health, or SQL that reads no table at all (pure PostGIS on bound
  values, session settings, advisory locks). Must run in `runAsSystem`
  once RB-00 lands, and must not return other orgs' rows to a user.
- **external**: runs against a customer's own PostGIS server, not the
  portal database. Out of reach for RLS; the item check is named.
- **GAP**: reads or writes data the caller has not been checked for.
- **UNVERIFIED**: could not prove a check either way.

Session setting rows (`SET LOCAL`, `BEGIN`, `COMMIT`) take the class of
the statement they set up.

| # | Site | Kind | Function | Tables | Id comes from | Class | Check or chain |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `admin/diagnostics.service.ts:68` | prisma | `bundle` | none (SELECT 1) | none | **system** | Health probe inside the org admin diagnostics bundle. Returns ok or error only. |
| 2 | `admin/housekeeping-schedule.service.ts:294` | prisma | `runOnce` | none (advisory lock) | constant lock key | **system** | Housekeeping cron, leader only. |
| 3 | `admin/housekeeping.service.ts:629` | prisma | `largeItems` | item, user | `user.orgId` | **org-scoped** | `WHERE i.org_id = ${orgId}`. HousekeepingController `large-items`, org admin. |
| 4 | `admin/housekeeping.service.ts:776` | prisma | `largestTables` | pg_class, pg_namespace (catalog) | none | **system** | Install-wide. `OperatorOrgGuard` (operator org only). |
| 5 | `admin/housekeeping.service.ts:848` | prisma | `largestDataLayers` | observation (L845); pg_inherits, pg_stat_user_tables (L860) | none in SQL; rows filtered by `item.orgId === orgId` in code | **system** | Install-wide top 50 scopes, then filtered to the caller org in code. `OperatorOrgGuard`. In multi mode a small org can see an empty list (correctness, not a leak). |
| 6 | `admin/housekeeping.service.ts:863` | prisma | `largestDataLayers` | observation (L845); pg_inherits, pg_stat_user_tables (L860) | none in SQL; rows filtered by `item.orgId === orgId` in code | **system** | Install-wide top 50 scopes, then filtered to the caller org in code. `OperatorOrgGuard`. In multi mode a small org can see an empty list (correctness, not a leak). |
| 7 | `admin/housekeeping.service.ts:976` | prisma | `queryDatabaseSize` | none (pg_database_size) | none | **system** | Storage metrics, `OperatorOrgGuard`. |
| 8 | `admin/housekeeping.service.ts:1041` | prisma | `expiringShares` | item_share, item, user, group | `user.orgId` | **org-scoped** | `WHERE i.org_id = ${orgId}`. HousekeepingController `expiring-shares`. |
| 9 | `admin/housekeeping.service.ts:1388` | prisma | `referencedStorageKeys` | item, item_data_snapshot, analysis_job, others | none | **system** | Orphan object sweep, install-wide on purpose. Returns a key set, never rows to a user. |
| 10 | `admin/readiness.service.ts:91` | prisma | `pingDatabase` | none (SELECT 1) | none | **system** | Readiness probe. |
| 11 | `admin/resource-quota.service.ts:38` | prisma | `reserve` | none (advisory lock, L38); storage_reservation, import_job (L42) | none: deletes stale holds of every org | **system** | Cross-org cleanup on purpose, but it runs inside a user request (upload or import reservation). Returns nothing to the user. Needs `runAsSystem` under RB-06. |
| 12 | `admin/resource-quota.service.ts:42` | prisma | `reserve` | none (advisory lock, L38); storage_reservation, import_job (L42) | none: deletes stale holds of every org | **system** | Cross-org cleanup on purpose, but it runs inside a user request (upload or import reservation). Returns nothing to the user. Needs `runAsSystem` under RB-06. |
| 13 | `analysis/analysis-bridge.worker.ts:121` | prisma | `reclaimStaleJobs` | analysis_job | none (stale lease sweep) | **system** | Analysis bridge worker. |
| 14 | `analysis/analysis-bridge.worker.ts:174` | prisma | `reclaimStaleJobs` | analysis_job | none (stale lease sweep) | **system** | Analysis bridge worker. |
| 15 | `analysis/analysis-target-stamp.ts:70` | prisma | `stampAnalysisTargetFailed` | item | target item id from the analysis job row | **system** | Called by the analysis worker (job row) and by AnalysisService right after it created the target item for the caller. Writes a failure hint only. |
| 16 | `backup/backup.service.ts:1734` | prisma | `appliedMigrations` | _prisma_migrations | none | **system** | Backup metadata. |
| 17 | `cron/leader-election.service.ts:221` | pg | `tryAcquire` | none (pg_try_advisory_lock) | constant lock key | **system** | Own long-lived `pg.Client`, outside the Prisma pool. |
| 18 | `cron/leader-election.service.ts:264` | pg | `reconcile` | none (SELECT 1 keepalive) | none | **system** | Same leader client. |
| 19 | `cron/leader-election.service.ts:298` | pg | `teardownClient` | none (pg_advisory_unlock) | constant lock key | **system** | Same leader client. |
| 20 | `data-layer/features.controller.ts:1711` | prisma | `assertGeometriesInsideLimit` | none (PostGIS on bound values) | none | **system** | Pure computation on request geometries and the caller geo limit. Reads no table. |
| 21 | `data-layer/search-index-jobs.service.ts:103` | prisma | `claimNext` | search_index_build | none (queue claim) | **system** | Worker claim, `FOR UPDATE SKIP LOCKED`. |
| 22 | `data-layer/search-index.service.ts:316` | prisma | `reconcileScope` | pg_indexes, pg_class, pg_index (catalog); DDL on observation | item id from `buildForOrg(job.orgId)` item list | **system** | Search index worker. Items come from `item.findMany({ orgId: job.orgId })`. Index DDL only, no rows returned. |
| 23 | `data-layer/search-index.service.ts:331` | prisma | `reconcileScope` | pg_indexes, pg_class, pg_index (catalog); DDL on observation | item id from `buildForOrg(job.orgId)` item list | **system** | Search index worker. Items come from `item.findMany({ orgId: job.orgId })`. Index DDL only, no rows returned. |
| 24 | `data-layer/search-index.service.ts:356` | prisma | `reconcileScope` | pg_indexes, pg_class, pg_index (catalog); DDL on observation | item id from `buildForOrg(job.orgId)` item list | **system** | Search index worker. Items come from `item.findMany({ orgId: job.orgId })`. Index DDL only, no rows returned. |
| 25 | `data-layer/search-index.service.ts:376` | prisma | `reconcileScope` | pg_indexes, pg_class, pg_index (catalog); DDL on observation | item id from `buildForOrg(job.orgId)` item list | **system** | Search index worker. Items come from `item.findMany({ orgId: job.orgId })`. Index DDL only, no rows returned. |
| 26 | `data-layer/search-index.service.ts:395` | prisma | `reconcileScope` | pg_indexes, pg_class, pg_index (catalog); DDL on observation | item id from `buildForOrg(job.orgId)` item list | **system** | Search index worker. Items come from `item.findMany({ orgId: job.orgId })`. Index DDL only, no rows returned. |
| 27 | `data-layer/search-index.service.ts:398` | prisma | `reconcileScope` | pg_indexes, pg_class, pg_index (catalog); DDL on observation | item id from `buildForOrg(job.orgId)` item list | **system** | Search index worker. Items come from `item.findMany({ orgId: job.orgId })`. Index DDL only, no rows returned. |
| 28 | `data-layer/search-index.service.ts:500` | prisma | `dropOrphanIndexes` | pg_indexes (catalog); DROP INDEX | none | **system** | Search index worker, install-wide orphan cleanup. |
| 29 | `data-layer/search-index.service.ts:534` | prisma | `dropOrphanIndexes` | pg_indexes (catalog); DROP INDEX | none | **system** | Search index worker, install-wide orphan cleanup. |
| 30 | `data-layer/stamp-layer-source.ts:44` | prisma | `stampV3LayerSource` | item (FOR UPDATE) | `itemId` from caller | **item-scoped** | CH-IMP: IngestController import route (items.get + assertCanImportAllRows) and ImportJobsWorker (`job.itemId`, checked at enqueue). |
| 31 | `data-layer/tables.service.ts:92` | prisma | `aggregateBbox` | observation | scope `data_layer:<itemId>:<layerId>` | **item-scoped** | CH-IMP (ingest, import worker), plus housekeeping recompute and ItemBboxRefreshService (system callers). Result is stored on the same item, not returned. |
| 32 | `data-layer/tables.service.ts:150` | prisma | `lastDataActivityAt` | observation | scope from item id | **system** | Housekeeping stale-items report; items come from an org-filtered list. |
| 33 | `data-layer/tables.service.ts:217` | prisma | `stampFeatureCounts` | item (FOR UPDATE) | `itemId` from caller | **item-scoped** | CH-IMP (ingest, import worker); housekeeping recompute (system). |
| 34 | `data-layer/tables.service.ts:261` | prisma | `readLiveCount` | observation | scope from `itemId` | **item-scoped** | Via stampFeatureCounts (above) and countLiveEntities (IngestController import route, CH-IMP). |
| 35 | `derived-layers/derived-layers.service.ts:435` | prisma | `enrichContext` | observation (through composed CTEs) | derived recipe source ids | **item-scoped** | Save path: ItemsService.enrichDerivedLayerData runs assertReadableDerivedLayerChain on the source and assertReadableDerivedLayerInput on every dependency before validateAndEnrich. |
| 36 | `derived-layers/derived-layers.service.ts:607` | prisma | `getGeoJson` | observation (through composed CTEs), item (boundary geometry) | recipe source ids; `boundaryClipId` from `?clip=` | item-scoped | Fixed in #800: the clip boundary is resolved through `resolveClipBoundaryGeometry` (caller can read it, or same organization as the layer) before this query runs. |
| 37 | `derived-layers/result-cache.ts:80` | prisma | `scopeVersions` | none (SET LOCAL, L80); observation (L83) | scopes parsed from the already composed derived SQL | **item-scoped** | Only called from DerivedLayersService.getGeoJson after its checks. Returns version hashes, not rows. |
| 38 | `derived-layers/result-cache.ts:83` | prisma | `scopeVersions` | none (SET LOCAL, L80); observation (L83) | scopes parsed from the already composed derived SQL | **item-scoped** | Only called from DerivedLayersService.getGeoJson after its checks. Returns version hashes, not rows. |
| 39 | `engine/copy-writer.ts:118` | pg | `begin` | none (BEGIN, SET LOCAL) | none | **item-scoped** | CopyWriter session setup. CopyWriter opens its own `pg.Pool` from DATABASE_URL, outside PrismaService. Used only by CH-IMP. |
| 40 | `engine/copy-writer.ts:127` | pg | `begin` | none (BEGIN, SET LOCAL) | none | **item-scoped** | CopyWriter session setup. CopyWriter opens its own `pg.Pool` from DATABASE_URL, outside PrismaService. Used only by CH-IMP. |
| 41 | `engine/copy-writer.ts:153` | pg | `deleteScope` | observation | scope from caller | **item-scoped** | CH-IMP replace mode. |
| 42 | `engine/copy-writer.ts:162` | pg | `liveEntityIds` | observation | scope from caller | **item-scoped** | CH-IMP. Runs through the CopyWriter.query passthrough (L189). |
| 43 | `engine/copy-writer.ts:189` | pg | `query` | any (passthrough) | whatever the caller passes | **item-scoped** | Passthrough used by liveEntityIds and by DataLayerEngine.commitCopiedLayer (`writer.query`). Callers are CH-IMP only. |
| 44 | `engine/copy-writer.ts:217` | pg | `beginCopy` | observation (COPY FROM) | scope column written by the encoder from caller args | **item-scoped** | CH-IMP. |
| 45 | `engine/copy-writer.ts:423` | pg | `dropDuplicateAppendCreates` | item (FOR UPDATE), advisory locks, observation | `itemId` and scope from caller | **item-scoped** | CH-IMP append mode. |
| 46 | `engine/copy-writer.ts:437` | pg | `dropDuplicateAppendCreates` | item (FOR UPDATE), advisory locks, observation | `itemId` and scope from caller | **item-scoped** | CH-IMP append mode. |
| 47 | `engine/copy-writer.ts:453` | pg | `dropDuplicateAppendCreates` | item (FOR UPDATE), advisory locks, observation | `itemId` and scope from caller | **item-scoped** | CH-IMP append mode. |
| 48 | `engine/copy-writer.ts:495` | pg | `commit` | none (COMMIT) | none | **item-scoped** | CH-IMP. |
| 49 | `engine/data-layer.ts:70` | raw | `expressionSqlFragment` | n/a (fragment) | n/a | **item-scoped** | `Prisma.raw` over SQL text from the expression compiler; values stay in params. Used by ExpressionsService.tileComputed for CH-V3R tiles. Compiler output is trusted, not re-audited here. |
| 50 | `engine/data-layer.ts:662` | prisma | `compileViaFilter` | observation (parent layer keys) | parent item and layer from `?via=` | **item-scoped** | CH-VIA. L695 and L698 are `Prisma.raw` of a constant CTE name. |
| 51 | `engine/data-layer.ts:695` | raw | `compileViaFilter` | observation (parent layer keys) | parent item and layer from `?via=` | **item-scoped** | CH-VIA. L695 and L698 are `Prisma.raw` of a constant CTE name. |
| 52 | `engine/data-layer.ts:698` | raw | `compileViaFilter` | observation (parent layer keys) | parent item and layer from `?via=` | **item-scoped** | CH-VIA. L695 and L698 are `Prisma.raw` of a constant CTE name. |
| 53 | `engine/data-layer.ts:736` | raw | `compileAttrGroup` | n/a (fragment) | n/a | **item-scoped** | `Prisma.raw` of fixed column aliases (`attrs`, `p.attrs`, `entity`, `p.entity`). No input reaches it. |
| 54 | `engine/data-layer.ts:736` | raw | `compileAttrGroup` | n/a (fragment) | n/a | **item-scoped** | `Prisma.raw` of fixed column aliases (`attrs`, `p.attrs`, `entity`, `p.entity`). No input reaches it. |
| 55 | `engine/data-layer.ts:808` | raw | `compileAttrGroup` | n/a (fragment) | n/a | **item-scoped** | `Prisma.raw` of fixed column aliases (`attrs`, `p.attrs`, `entity`, `p.entity`). No input reaches it. |
| 56 | `engine/data-layer.ts:808` | raw | `compileAttrGroup` | n/a (fragment) | n/a | **item-scoped** | `Prisma.raw` of fixed column aliases (`attrs`, `p.attrs`, `entity`, `p.entity`). No input reaches it. |
| 57 | `engine/data-layer.ts:1150` | prisma | `scopeDataVersion` | none (SET LOCAL, L1124); observation (L1127) | scope from caller | **item-scoped** | Cache version probe for CH-V3R, CH-PUB and CH-OGC reads. Returns a hash. |
| 58 | `engine/data-layer.ts:1153` | prisma | `scopeDataVersion` | none (SET LOCAL, L1124); observation (L1127) | scope from caller | **item-scoped** | Cache version probe for CH-V3R, CH-PUB and CH-OGC reads. Returns a hash. |
| 59 | `engine/data-layer.ts:1187` | prisma | `commitLayerSync` | item (FOR UPDATE, L1161; UPDATE, L1191) | `itemId` from caller | **item-scoped** | DataLayerFeaturesService write paths: insertFeatures, updateFeature, deleteFeature, calculateField. Callers CH-V3W, CH-FORM, CH-NEW. |
| 60 | `engine/data-layer.ts:1217` | prisma | `commitLayerSync` | item (FOR UPDATE, L1161; UPDATE, L1191) | `itemId` from caller | **item-scoped** | DataLayerFeaturesService write paths: insertFeatures, updateFeature, deleteFeature, calculateField. Callers CH-V3W, CH-FORM, CH-NEW. |
| 61 | `engine/data-layer.ts:1262` | pg | `commitCopiedLayer` | item, observation | `itemId`, `layerId` from caller | **item-scoped** | CH-IMP (IngestController import route, ImportJobsWorker). All statements on the CopyWriter connection. |
| 62 | `engine/data-layer.ts:1267` | pg | `commitCopiedLayer` | item, observation | `itemId`, `layerId` from caller | **item-scoped** | CH-IMP (IngestController import route, ImportJobsWorker). All statements on the CopyWriter connection. |
| 63 | `engine/data-layer.ts:1282` | pg | `commitCopiedLayer` | item, observation | `itemId`, `layerId` from caller | **item-scoped** | CH-IMP (IngestController import route, ImportJobsWorker). All statements on the CopyWriter connection. |
| 64 | `engine/data-layer.ts:1300` | pg | `commitCopiedLayer` | item, observation | `itemId`, `layerId` from caller | **item-scoped** | CH-IMP (IngestController import route, ImportJobsWorker). All statements on the CopyWriter connection. |
| 65 | `engine/data-layer.ts:1310` | pg | `commitCopiedLayer` | item, observation | `itemId`, `layerId` from caller | **item-scoped** | CH-IMP (IngestController import route, ImportJobsWorker). All statements on the CopyWriter connection. |
| 66 | `engine/data-layer.ts:1330` | pg | `commitCopiedLayer` | item, observation | `itemId`, `layerId` from caller | **item-scoped** | CH-IMP (IngestController import route, ImportJobsWorker). All statements on the CopyWriter connection. |
| 67 | `engine/data-layer.ts:1361` | pg | `commitCopiedLayer` | item, observation | `itemId`, `layerId` from caller | **item-scoped** | CH-IMP (IngestController import route, ImportJobsWorker). All statements on the CopyWriter connection. |
| 68 | `engine/data-layer.ts:1380` | pg | `commitCopiedLayer` | item, observation | `itemId`, `layerId` from caller | **item-scoped** | CH-IMP (IngestController import route, ImportJobsWorker). All statements on the CopyWriter connection. |
| 69 | `engine/data-layer.ts:1609` | prisma | `writeFeaturesCreateIdempotent` | none (advisory lock, L1583); observation (L1589) | scope from `itemId`, `layerId` | **item-scoped** | DataLayerFeaturesService.insertFeatures. CH-V3W, CH-FORM, CH-NEW. |
| 70 | `engine/data-layer.ts:1615` | prisma | `writeFeaturesCreateIdempotent` | none (advisory lock, L1583); observation (L1589) | scope from `itemId`, `layerId` | **item-scoped** | DataLayerFeaturesService.insertFeatures. CH-V3W, CH-FORM, CH-NEW. |
| 71 | `engine/data-layer.ts:1865` | prisma | `insertUpdatesIfHead` | observation | scope from caller, entity ids from request | **item-scoped** | DataLayerFeaturesService.updateFeature / calculateField. CH-V3W. Entity ids are only matched inside the checked scope. |
| 72 | `engine/data-layer.ts:1871` | prisma | `insertUpdatesIfHead` | observation | scope from caller, entity ids from request | **item-scoped** | DataLayerFeaturesService.updateFeature / calculateField. CH-V3W. Entity ids are only matched inside the checked scope. |
| 73 | `engine/data-layer.ts:1913` | prisma | `insertUpdatesIfHead` | observation | scope from caller, entity ids from request | **item-scoped** | DataLayerFeaturesService.updateFeature / calculateField. CH-V3W. Entity ids are only matched inside the checked scope. |
| 74 | `engine/data-layer.ts:2041` | prisma | `listDeltaSince` | observation | scope from caller | **item-scoped** | DataLayerFeaturesService.listDelta. CH-V3R (`delta` route). |
| 75 | `engine/data-layer.ts:2116` | prisma | `listDeltaSince` | observation | scope from caller | **item-scoped** | DataLayerFeaturesService.listDelta. CH-V3R (`delta` route). |
| 76 | `engine/data-layer.ts:2295` | prisma | `listFeatures` | observation | scope from caller | **item-scoped** | CH-V3R, CH-PUB, CH-OGC, CH-SVC, CH-SAMPLES, and re-reads inside CH-V3W write paths. |
| 77 | `engine/data-layer.ts:2406` | prisma | `listFeatures` | observation | scope from caller | **item-scoped** | CH-V3R, CH-PUB, CH-OGC, CH-SVC, CH-SAMPLES, and re-reads inside CH-V3W write paths. |
| 78 | `engine/data-layer.ts:2782` | prisma | `readFeaturePage` | observation | scope from caller | **item-scoped** | CH-V3R (`features?limit=`), CH-PUB, CH-OGC. |
| 79 | `engine/data-layer.ts:2858` | prisma | `readFeaturePage` | observation | scope from caller | **item-scoped** | CH-V3R (`features?limit=`), CH-PUB, CH-OGC. |
| 80 | `engine/data-layer.ts:3182` | raw | `pageFeatures` | observation | scope from caller | **item-scoped** | CH-V3R (`features-page`), CH-PUB. L3156 and L3158 are `Prisma.raw` of `ASC`/`DESC` and a fixed alias. |
| 81 | `engine/data-layer.ts:3184` | raw | `pageFeatures` | observation | scope from caller | **item-scoped** | CH-V3R (`features-page`), CH-PUB. L3156 and L3158 are `Prisma.raw` of `ASC`/`DESC` and a fixed alias. |
| 82 | `engine/data-layer.ts:3220` | prisma | `pageFeatures` | observation | scope from caller | **item-scoped** | CH-V3R (`features-page`), CH-PUB. L3156 and L3158 are `Prisma.raw` of `ASC`/`DESC` and a fixed alias. |
| 83 | `engine/data-layer.ts:3243` | prisma | `pageFeatures` | observation | scope from caller | **item-scoped** | CH-V3R (`features-page`), CH-PUB. L3156 and L3158 are `Prisma.raw` of `ASC`/`DESC` and a fixed alias. |
| 84 | `engine/data-layer.ts:3285` | prisma | `pageFeatures` | observation | scope from caller | **item-scoped** | CH-V3R (`features-page`), CH-PUB. L3156 and L3158 are `Prisma.raw` of `ASC`/`DESC` and a fixed alias. |
| 85 | `engine/data-layer.ts:3603` | raw | `aggregateFeaturesUncached` | observation | scope from caller | **item-scoped** | CH-V3R (`aggregate`), CH-PUB. The `Prisma.raw` sites are generated aliases (`g0`, `a0`, bin alias); field names go in as params. |
| 86 | `engine/data-layer.ts:3605` | raw | `aggregateFeaturesUncached` | observation | scope from caller | **item-scoped** | CH-V3R (`aggregate`), CH-PUB. The `Prisma.raw` sites are generated aliases (`g0`, `a0`, bin alias); field names go in as params. |
| 87 | `engine/data-layer.ts:3626` | raw | `aggregateFeaturesUncached` | observation | scope from caller | **item-scoped** | CH-V3R (`aggregate`), CH-PUB. The `Prisma.raw` sites are generated aliases (`g0`, `a0`, bin alias); field names go in as params. |
| 88 | `engine/data-layer.ts:3628` | raw | `aggregateFeaturesUncached` | observation | scope from caller | **item-scoped** | CH-V3R (`aggregate`), CH-PUB. The `Prisma.raw` sites are generated aliases (`g0`, `a0`, bin alias); field names go in as params. |
| 89 | `engine/data-layer.ts:3631` | raw | `aggregateFeaturesUncached` | observation | scope from caller | **item-scoped** | CH-V3R (`aggregate`), CH-PUB. The `Prisma.raw` sites are generated aliases (`g0`, `a0`, bin alias); field names go in as params. |
| 90 | `engine/data-layer.ts:3703` | raw | `aggregateFeaturesUncached` | observation | scope from caller | **item-scoped** | CH-V3R (`aggregate`), CH-PUB. The `Prisma.raw` sites are generated aliases (`g0`, `a0`, bin alias); field names go in as params. |
| 91 | `engine/data-layer.ts:3781` | prisma | `aggregateFeaturesUncached` | observation; area_of_interest by `area` id | scope from caller; area id checked by AreaOfInterestService.touch | **item-scoped** | CH-V3R (`aggregate`), CH-PUB. The `Prisma.raw` sites are generated aliases (`g0`, `a0`, bin alias); field names go in as params. |
| 92 | `engine/data-layer.ts:4006` | prisma | `searchFeatures` | observation | scope from caller | **item-scoped** | CH-V3R (`features-search`), CH-PUB, CH-SVC (AiFeaturesService). |
| 93 | `engine/data-layer.ts:4143` | prisma | `selectionExtent` | observation | scope from caller | **item-scoped** | CH-V3R (`selection-extent`). |
| 94 | `engine/data-layer.ts:4299` | prisma | `filteredExtent` | observation | scope from caller | **item-scoped** | CH-V3R (`filtered-extent`), CH-PUB. |
| 95 | `engine/data-layer.ts:4625` | raw | `computeMvtTileBytes` | observation | scope from caller | **item-scoped** | CH-V3R (`tile`), CH-PUB, public OGC tiles. L4556: field names pass `SAFE_NAME`; L4565: names pass `^expr\.[A-Za-z_]...`. |
| 96 | `engine/data-layer.ts:4634` | raw | `computeMvtTileBytes` | observation | scope from caller | **item-scoped** | CH-V3R (`tile`), CH-PUB, public OGC tiles. L4556: field names pass `SAFE_NAME`; L4565: names pass `^expr\.[A-Za-z_]...`. |
| 97 | `engine/data-layer.ts:4850` | prisma | `computeMvtTileBytes` | observation | scope from caller | **item-scoped** | CH-V3R (`tile`), CH-PUB, public OGC tiles. L4556: field names pass `SAFE_NAME`; L4565: names pass `^expr\.[A-Za-z_]...`. |
| 98 | `engine/engine.service.ts:125` | prisma | `writeIfHead` | none (advisory locks, L125); observation (L126) | scope on the observation built by DataLayerEngine | **item-scoped** | DataLayerEngine.writeFeatureUpdate. CH-V3W. |
| 99 | `engine/engine.service.ts:126` | prisma | `writeIfHead` | none (advisory locks, L125); observation (L126) | scope on the observation built by DataLayerEngine | **item-scoped** | DataLayerEngine.writeFeatureUpdate. CH-V3W. |
| 100 | `engine/engine.service.ts:167` | prisma | `insertOne` | observation | scope on the observation | **item-scoped** | DataLayerEngine writes (CH-V3W, CH-FORM, CH-NEW). |
| 101 | `engine/engine.service.ts:253` | prisma | `writeMany` | observation | scope on the observations | **item-scoped** | DataLayerEngine writes (CH-V3W, CH-FORM, CH-NEW) and OsmService cache writes (`osm:<hash>` scope, shared public cache). |
| 102 | `engine/tile-cache.service.ts:963` | pg | `ensureListener` | none (LISTEN) | none | **system** | Own `pg.Client`, held for the process lifetime. Must not be stamped per request (RB-06 trap). |
| 103 | `expressions/expressions.service.ts:338` | prisma | `runBounded` | none (SET LOCAL, L338); observation (L339) | item and referenced layers | **item-scoped** | evaluate / valuesForFeatures: `prepare()` runs sourceAccessFor on the item and prepareExpressionData checks `canRead` (or `access = public` for anonymous) on every referenced layer, same org for name lookups. Callers pass an item already checked by assertV3Layer or the public gate. |
| 104 | `expressions/expressions.service.ts:339` | prisma | `runBounded` | none (SET LOCAL, L338); observation (L339) | item and referenced layers | **item-scoped** | evaluate / valuesForFeatures: `prepare()` runs sourceAccessFor on the item and prepareExpressionData checks `canRead` (or `access = public` for anonymous) on every referenced layer, same org for name lookups. Callers pass an item already checked by assertV3Layer or the public gate. |
| 105 | `features/features.service.ts:198` | prisma | `provisionTable` | fs_<id> (DDL) | `itemId` via `toTableName` (UUID regex) | **item-scoped** | CH-LEG: FeaturesController.requireEditAccessAndProvision (items.get + canEdit), IngestController POST /items/:id/ingest (items.get + canEdit). |
| 106 | `features/features.service.ts:213` | prisma | `provisionTable` | fs_<id> (DDL) | `itemId` via `toTableName` (UUID regex) | **item-scoped** | CH-LEG: FeaturesController.requireEditAccessAndProvision (items.get + canEdit), IngestController POST /items/:id/ingest (items.get + canEdit). |
| 107 | `features/features.service.ts:219` | prisma | `provisionTable` | fs_<id> (DDL) | `itemId` via `toTableName` (UUID regex) | **item-scoped** | CH-LEG: FeaturesController.requireEditAccessAndProvision (items.get + canEdit), IngestController POST /items/:id/ingest (items.get + canEdit). |
| 108 | `features/features.service.ts:224` | prisma | `provisionTable` | fs_<id> (DDL) | `itemId` via `toTableName` (UUID regex) | **item-scoped** | CH-LEG: FeaturesController.requireEditAccessAndProvision (items.get + canEdit), IngestController POST /items/:id/ingest (items.get + canEdit). |
| 109 | `features/features.service.ts:233` | prisma | `provisionTable` | fs_<id> (DDL) | `itemId` via `toTableName` (UUID regex) | **item-scoped** | CH-LEG: FeaturesController.requireEditAccessAndProvision (items.get + canEdit), IngestController POST /items/:id/ingest (items.get + canEdit). |
| 110 | `features/features.service.ts:246` | prisma | `dropTable` | fs_<id> (DROP) | `itemId` | **item-scoped** | No caller in the tree (dead code). Teardown uses ItemsService.tearDownItemBackingStorage instead. |
| 111 | `features/features.service.ts:253` | prisma | `tableExists` | information_schema.tables | `itemId` | **item-scoped** | CH-LEG requireReadAccess; RelationshipsController create after requireAdmin + canAdmin on the child. |
| 112 | `features/features.service.ts:357` | prisma | `bulkInsertCore` | fs_<id> | `itemId` | **item-scoped** | CH-LEG append and import (requireEditAccess / requireEditAccessAndProvision). |
| 113 | `features/features.service.ts:384` | prisma | `replaceAll` | fs_<id> | `itemId` | **item-scoped** | CH-LEG bulk import; IngestController POST /items/:id/ingest. |
| 114 | `features/features.service.ts:449` | prisma | `updateFeature` | fs_<id> | `itemId`, feature id from route | **item-scoped** | CH-LEG PATCH (requireEditAccess + scopeFor edit). |
| 115 | `features/features.service.ts:462` | prisma | `updateFeature` | fs_<id> | `itemId`, feature id from route | **item-scoped** | CH-LEG PATCH (requireEditAccess + scopeFor edit). |
| 116 | `features/features.service.ts:485` | prisma | `updateFeature` | fs_<id> | `itemId`, feature id from route | **item-scoped** | CH-LEG PATCH (requireEditAccess + scopeFor edit). |
| 117 | `features/features.service.ts:540` | prisma | `deleteFeature` | fs_<id> | `itemId`, feature id from route | **item-scoped** | CH-LEG DELETE (requireEditAccess + scopeFor edit). |
| 118 | `features/features.service.ts:606` | prisma | `query` | fs_<id> | `itemId` | **item-scoped** | CH-LEG GET list (requireReadAccess + scopeFor read). |
| 119 | `features/features.service.ts:651` | prisma | `getFeature` | fs_<id> | `itemId`, feature id | **item-scoped** | CH-LEG GET one, related routes (parent requireReadAccess). |
| 120 | `features/features.service.ts:687` | prisma | `getHistory` | fs_<id> | `itemId`, feature id | **item-scoped** | CH-LEG history (requireReadAccess). |
| 121 | `features/features.service.ts:703` | prisma | `stats` | fs_<id> | `itemId` | **item-scoped** | FeaturesController.syncItemMeta after a checked write; IngestController after canEdit. |
| 122 | `features/features.service.ts:754` | prisma | `addParentKeyColumn` | fs_<child id> (ALTER, CREATE INDEX) | `dto.relatedItemId` | **item-scoped** | RelationshipsController.create: requireAdmin on the parent and `canAdmin` on the child. |
| 123 | `features/features.service.ts:757` | prisma | `addParentKeyColumn` | fs_<child id> (ALTER, CREATE INDEX) | `dto.relatedItemId` | **item-scoped** | RelationshipsController.create: requireAdmin on the parent and `canAdmin` on the child. |
| 124 | `features/features.service.ts:804` | prisma | `getRelatedFeatures` | fs_<child id> | `childItemId` from route | **item-scoped** | FeaturesController.listRelated: requireReadAccess on parent and child, scopeFor on both. |
| 125 | `features/features.service.ts:840` | prisma | `createRelatedFeature` | fs_<child id> | `childItemId` from route | **item-scoped** | FeaturesController.createRelated: requireReadAccess on parent, requireEditAccess on child. |
| 126 | `features/features.service.ts:888` | prisma | `assertGeometriesInsideLimit` | none (PostGIS on bound values) | none | **system** | Pure computation. Reads no table. |
| 127 | `feedback/feedback.service.ts:116` | prisma | `submit` | none (advisory lock) | hash of the client IP | **system** | Anonymous feedback rate limit lock. Reads no table. |
| 128 | `forms/forms.service.ts:403` | prisma | `reconcileFormMirrors` | form_submission, item, observation | none (sweep); joins require `l.org_id = f.org_id` | **system** | Leader-only cron. Each repair then goes through assertMirrorTarget (CH-FORM). |
| 129 | `geocoding/geocoder-indexes.ts:45` | prisma | `dropGeocoderIndexes` | pg_indexes (catalog); DROP INDEX | `itemId` prefix | **item-scoped** | ItemsService.tearDownItemBackingStorage: user purge (items.get + canAdmin) or TrashPurgeService (system). |
| 130 | `geocoding/geocoder-indexes.ts:54` | prisma | `dropGeocoderIndexes` | pg_indexes (catalog); DROP INDEX | `itemId` prefix | **item-scoped** | ItemsService.tearDownItemBackingStorage: user purge (items.get + canAdmin) or TrashPurgeService (system). |
| 131 | `geocoding/geocoding.service.ts:342` | prisma | `search` | none (set_config, L342); observation (L343) | scope from `config.sourceLayerId` | **item-scoped** | GeocodingService.search: items.get(geocoder), items.get(source layer), featureScopeFor on the source; own-rows and geo limit applied in SQL. |
| 132 | `geocoding/geocoding.service.ts:343` | prisma | `search` | none (set_config, L342); observation (L343) | scope from `config.sourceLayerId` | **item-scoped** | GeocodingService.search: items.get(geocoder), items.get(source layer), featureScopeFor on the source; own-rows and geo limit applied in SQL. |
| 133 | `geocoding/geocoding.service.ts:562` | prisma | `rebuildIndexes` | pg_indexes, pg_index, pg_class (catalog); DDL on observation; observation count | geocoder item id and source layer id | **item-scoped** | items.get(geocoder) + `orgRole === admin` + canAdmin, then items.get(source). Index names use the item hex; field names pass `^[a-zA-Z0-9_]+$`. |
| 134 | `geocoding/geocoding.service.ts:573` | prisma | `rebuildIndexes` | pg_indexes, pg_index, pg_class (catalog); DDL on observation; observation count | geocoder item id and source layer id | **item-scoped** | items.get(geocoder) + `orgRole === admin` + canAdmin, then items.get(source). Index names use the item hex; field names pass `^[a-zA-Z0-9_]+$`. |
| 135 | `geocoding/geocoding.service.ts:582` | prisma | `rebuildIndexes` | pg_indexes, pg_index, pg_class (catalog); DDL on observation; observation count | geocoder item id and source layer id | **item-scoped** | items.get(geocoder) + `orgRole === admin` + canAdmin, then items.get(source). Index names use the item hex; field names pass `^[a-zA-Z0-9_]+$`. |
| 136 | `geocoding/geocoding.service.ts:599` | prisma | `rebuildIndexes` | pg_indexes, pg_index, pg_class (catalog); DDL on observation; observation count | geocoder item id and source layer id | **item-scoped** | items.get(geocoder) + `orgRole === admin` + canAdmin, then items.get(source). Index names use the item hex; field names pass `^[a-zA-Z0-9_]+$`. |
| 137 | `geocoding/geocoding.service.ts:634` | prisma | `rebuildIndexes` | pg_indexes, pg_index, pg_class (catalog); DDL on observation; observation count | geocoder item id and source layer id | **item-scoped** | items.get(geocoder) + `orgRole === admin` + canAdmin, then items.get(source). Index names use the item hex; field names pass `^[a-zA-Z0-9_]+$`. |
| 138 | `geocoding/geocoding.service.ts:677` | prisma | `rebuildIndexes` | pg_indexes, pg_index, pg_class (catalog); DDL on observation; observation count | geocoder item id and source layer id | **item-scoped** | items.get(geocoder) + `orgRole === admin` + canAdmin, then items.get(source). Index names use the item hex; field names pass `^[a-zA-Z0-9_]+$`. |
| 139 | `geocoding/geocoding.service.ts:678` | prisma | `rebuildIndexes` | pg_indexes, pg_index, pg_class (catalog); DDL on observation; observation count | geocoder item id and source layer id | **item-scoped** | items.get(geocoder) + `orgRole === admin` + canAdmin, then items.get(source). Index names use the item hex; field names pass `^[a-zA-Z0-9_]+$`. |
| 140 | `geocoding/geocoding.service.ts:679` | prisma | `rebuildIndexes` | pg_indexes, pg_index, pg_class (catalog); DDL on observation; observation count | geocoder item id and source layer id | **item-scoped** | items.get(geocoder) + `orgRole === admin` + canAdmin, then items.get(source). Index names use the item hex; field names pass `^[a-zA-Z0-9_]+$`. |
| 141 | `geocoding/geocoding.service.ts:694` | prisma | `rebuildIndexes` | pg_indexes, pg_index, pg_class (catalog); DDL on observation; observation count | geocoder item id and source layer id | **item-scoped** | items.get(geocoder) + `orgRole === admin` + canAdmin, then items.get(source). Index names use the item hex; field names pass `^[a-zA-Z0-9_]+$`. |
| 142 | `health.controller.ts:25` | prisma | `check` | none (SELECT 1) | none | **system** | Public health endpoint. |
| 143 | `import-jobs/import-jobs.service.ts:178` | prisma | `claimNext` | import_job | none (queue claim) | **system** | Import worker claim. |
| 144 | `items/data-snapshot.service.ts:109` | prisma | `purge` | item_data_snapshot | none (sweep) | **system** | Retention cron. Groups by item id, returns ids to its own cap loop only. |
| 145 | `items/item-bbox-refresh.service.ts:296` | prisma | `writeBbox` | item | item id from a feature write or the reverse walk | **system** | Background bbox refresh. Seed id comes from DataLayerFeaturesService.noteFeatureWrite (a checked write). See F-2 for the reverse walk. |
| 146 | `items/item-bbox-refresh.service.ts:311` | prisma | `growStoredBbox` | item | seed item id from a checked feature write | **system** | Background bbox refresh. |
| 147 | `items/item-bbox-refresh.service.ts:548` | prisma | `findReferencingItems` | item | ids of edited layers | item-scoped | Fixed in #800: references are followed and extents are used only within the same organization, or for public items. |
| 148 | `items/item-data-lock.ts:36` | prisma | `lockItemRow` | item (FOR UPDATE) | `id` from caller | **item-scoped** | Callers: ItemsService.updateOnce (get + canEdit), FeaturesController.syncItemMeta (CH-LEG), RelationshipsController create/remove (canAdmin on parent; child id from the stored relationship, change only when the child back-reference matches), DrawingsService.mutateMapData (loadMapItem + canEdit or the anonymous drawing flag), ItemsService.spliceFromFolders (system), DerivedLayerCacheRefresh (system). Returns data to the caller code, not to the user. |
| 149 | `items/items.service.ts:1054` | prisma | `buildListWhere` | item, item_share | `user.orgId` | **org-scoped** | Spatial pre-filter for GET /items: `org_id = user.orgId OR access = public OR shared`. Final visibility is the Prisma `visibleWhere(user)` clause the ids are ANDed into. |
| 150 | `items/items.service.ts:1203` | prisma | `queryListRows` | item | ids of rows already returned by the visible list query | **item-scoped** | Decorates list rows (sublayer count, storage type, template). Ids come from `item.findMany({ where: visibleWhere })`. |
| 151 | `items/items.service.ts:1240` | prisma | `queryListRows` | item | ids of rows already returned by the visible list query | **item-scoped** | Decorates list rows (sublayer count, storage type, template). Ids come from `item.findMany({ where: visibleWhere })`. |
| 152 | `items/items.service.ts:1294` | prisma | `queryListRows` | item | ids of rows already returned by the visible list query | **item-scoped** | Decorates list rows (sublayer count, storage type, template). Ids come from `item.findMany({ where: visibleWhere })`. |
| 153 | `items/items.service.ts:3652` | prisma | `notifyDataCollectionSchemaBreak` | field_queue_manifest | data_collection id that references the edited layer | **item-scoped** | Runs in ItemsService.update of a layer (get + canEdit). User ids found are filtered by schemaBreakRecipients (canRead on the deployment) before any notification. |
| 154 | `items/items.service.ts:4050` | prisma | `tearDownItemBackingStorage` | none (SET LOCAL, L4050); observation (L4051); fs_<id> DROP (L4064) | `itemId` of the item being purged | **item-scoped** | ItemsService.purge (get with includeTrashed + canAdmin) and TrashPurgeService.purgeExpired (system cron). Table name from a UUID-shaped id. |
| 155 | `items/items.service.ts:4051` | prisma | `tearDownItemBackingStorage` | none (SET LOCAL, L4050); observation (L4051); fs_<id> DROP (L4064) | `itemId` of the item being purged | **item-scoped** | ItemsService.purge (get with includeTrashed + canAdmin) and TrashPurgeService.purgeExpired (system cron). Table name from a UUID-shaped id. |
| 156 | `items/items.service.ts:4064` | prisma | `tearDownItemBackingStorage` | none (SET LOCAL, L4050); observation (L4051); fs_<id> DROP (L4064) | `itemId` of the item being purged | **item-scoped** | ItemsService.purge (get with includeTrashed + canAdmin) and TrashPurgeService.purgeExpired (system cron). Table name from a UUID-shaped id. |
| 157 | `items/items.service.ts:4207` | prisma | `spliceFromLandingFeatured` | organization | purged item id | **system** | Cross-org cleanup by item id after a purge. Runs in the user purge request. Needs `runAsSystem` under RB-06 or other orgs keep a dead id. |
| 158 | `items/items.service.ts:4221` | prisma | `spliceFromFolders` | item (folders) | purged item id | **system** | Cross-org cleanup like the row above. |
| 159 | `items/items.service.ts:4488` | prisma | `getGeoJson` | fs_<id>; item (boundary geometry, via Prisma) | `id` from route; `boundaryClipId` from `?clip=` | item-scoped | Fixed in #800: the clip boundary is resolved through `resolveClipBoundaryGeometry` (caller can read it, or same organization as the layer) before this query runs. |
| 160 | `items/items.service.ts:4562` | prisma | `getGeoJson` | none (PostGIS on bound values) | none | **system** | Pure computation (geo limit test per feature). Reads no table. |
| 161 | `items/last-usage-stamp.ts:62` | prisma | `stamp` | item (last_usage_at) | `itemId` | **item-scoped** | ItemsController GET /items/:id after ItemsService.get; ItemProxyController after its item check. Writes a timestamp only. |
| 162 | `maintenance/collation-refresh.ts:51` | pg | `refreshCollations` | pg_roles, pg_database (catalog); REINDEX DATABASE; ALTER DATABASE; postgis_extensions_upgrade() | none | **system** | Maintenance CLI (`collation-refresh.main.ts`) with its own admin `pg.Client`. Database names are quoted with quoteIdent. |
| 163 | `maintenance/collation-refresh.ts:59` | pg | `refreshCollations` | pg_roles, pg_database (catalog); REINDEX DATABASE; ALTER DATABASE; postgis_extensions_upgrade() | none | **system** | Maintenance CLI (`collation-refresh.main.ts`) with its own admin `pg.Client`. Database names are quoted with quoteIdent. |
| 164 | `maintenance/collation-refresh.ts:80` | pg | `refreshCollations` | pg_roles, pg_database (catalog); REINDEX DATABASE; ALTER DATABASE; postgis_extensions_upgrade() | none | **system** | Maintenance CLI (`collation-refresh.main.ts`) with its own admin `pg.Client`. Database names are quoted with quoteIdent. |
| 165 | `maintenance/collation-refresh.ts:81` | pg | `refreshCollations` | pg_roles, pg_database (catalog); REINDEX DATABASE; ALTER DATABASE; postgis_extensions_upgrade() | none | **system** | Maintenance CLI (`collation-refresh.main.ts`) with its own admin `pg.Client`. Database names are quoted with quoteIdent. |
| 166 | `maintenance/collation-refresh.ts:85` | pg | `refreshCollations` | pg_roles, pg_database (catalog); REINDEX DATABASE; ALTER DATABASE; postgis_extensions_upgrade() | none | **system** | Maintenance CLI (`collation-refresh.main.ts`) with its own admin `pg.Client`. Database names are quoted with quoteIdent. |
| 167 | `maintenance/collation-refresh.ts:93` | pg | `refreshCollations` | pg_roles, pg_database (catalog); REINDEX DATABASE; ALTER DATABASE; postgis_extensions_upgrade() | none | **system** | Maintenance CLI (`collation-refresh.main.ts`) with its own admin `pg.Client`. Database names are quoted with quoteIdent. |
| 168 | `maintenance/partition-runway.service.ts:75` | prisma | `check` | partman.part_config, partman.show_partitions; partition parents and defaults | none | **system** | Hourly check. Table names come from partman config and are quoted with quoteQualified. |
| 169 | `maintenance/partition-runway.service.ts:79` | prisma | `check` | partman.part_config, partman.show_partitions; partition parents and defaults | none | **system** | Hourly check. Table names come from partman config and are quoted with quoteQualified. |
| 170 | `maintenance/partition-runway.service.ts:84` | prisma | `check` | partman.part_config, partman.show_partitions; partition parents and defaults | none | **system** | Hourly check. Table names come from partman config and are quoted with quoteQualified. |
| 171 | `maintenance/partition-runway.service.ts:90` | prisma | `check` | partman.part_config, partman.show_partitions; partition parents and defaults | none | **system** | Hourly check. Table names come from partman config and are quoted with quoteQualified. |
| 172 | `maintenance/trash-purge.service.ts:103` | prisma | `purgeExpired` | none (SET LOCAL, L101, L102); item (FOR UPDATE SKIP LOCKED, L103) | item ids from the expired-trash sweep | **system** | Trash purge cron. |
| 173 | `maintenance/trash-purge.service.ts:104` | prisma | `purgeExpired` | none (SET LOCAL, L101, L102); item (FOR UPDATE SKIP LOCKED, L103) | item ids from the expired-trash sweep | **system** | Trash purge cron. |
| 174 | `maintenance/trash-purge.service.ts:105` | prisma | `purgeExpired` | none (SET LOCAL, L101, L102); item (FOR UPDATE SKIP LOCKED, L103) | item ids from the expired-trash sweep | **system** | Trash purge cron. |
| 175 | `metrics/job-metrics.ts:162` | prisma | `query` | none (SET LOCAL, L162); job tables (L163) | none | **system** | Prometheus job queue gauges, install-wide counts. |
| 176 | `metrics/job-metrics.ts:163` | prisma | `query` | none (SET LOCAL, L162); job tables (L163) | none | **system** | Prometheus job queue gauges, install-wide counts. |
| 177 | `notifications/notifications-cron.service.ts:111` | prisma | `prune` | notification | none (retention sweep) | **system** | Retention cron. |
| 178 | `offline-package/offline-package.service.ts:123` | prisma | `claimNext` | offline_package | none (queue claim) | **system** | Worker claim. |
| 179 | `osm/osm-scrub.service.ts:167` | prisma | `purgeScope` | observation | scope `osm:<hash>` from osm_query_cache | **system** | OSM cache scrub cron. Refuses any scope not matching `^osm:[A-Za-z0-9_-]+$`. |
| 180 | `osm/osm.service.ts:577` | prisma | `writeFeaturesToScope` | observation | scope `osm:<hash>` of the query | **system** | Shared OSM cache, content-addressed, public OpenStreetMap data. Not tenant data. |
| 181 | `osm/osm.service.ts:614` | prisma | `readFeaturesFromScope` | observation | scope `osm:<hash>` | **system** | Same shared OSM cache. |
| 182 | `postgis-live/postgis-live.service.ts:117` | pg | `probe` | external database catalog | service item id | **external** | Customer PostGIS, not the portal database. loadService(user, id, { edit: true }) checks canRead + canEdit. |
| 183 | `postgis-live/postgis-live.service.ts:133` | pg | `probe` | external database catalog | service item id | **external** | Customer PostGIS, not the portal database. loadService(user, id, { edit: true }) checks canRead + canEdit. |
| 184 | `postgis-live/postgis-live.service.ts:165` | pg | `probe` | external database catalog | service item id | **external** | Customer PostGIS, not the portal database. loadService(user, id, { edit: true }) checks canRead + canEdit. |
| 185 | `postgis-live/postgis-live.service.ts:346` | pg | `readFeatures` | external database table | service item id | **external** | loadService(user, id) checks canRead. |
| 186 | `postgis-live/postgis-live.service.ts:445` | pg | `tryConnection` | external database (SET, version) | host from request | **external** | testConnection: assertCanAuthorPostgis + assertPostgisHost allowlist. |
| 187 | `postgis-live/postgis-live.service.ts:446` | pg | `tryConnection` | external database (SET, version) | host from request | **external** | testConnection: assertCanAuthorPostgis + assertPostgisHost allowlist. |
| 188 | `postgis-live/postgis-live.service.ts:584` | pg | `applyStatementTimeout` | external database (set_config) | none | **external** | Pool setup for an item-checked external connection. |
| 189 | `postgis-live/postgis-table-preview.ts:41` | pg | `listGeometryTablesPreview` | external database catalog and counts | none | **external** | Called from probe (canEdit on the service item). |
| 190 | `postgis-live/postgis-table-preview.ts:49` | pg | `listGeometryTablesPreview` | external database catalog and counts | none | **external** | Called from probe (canEdit on the service item). |
| 191 | `public/ogc/records-core.ts:101` | prisma | `queryPublicRecords` | item | none; `access = public` filter | **item-scoped** | Public OGC records bbox filter. Only public, live items. No org filter: see "Found outside scope". |
| 192 | `public/public.controller.ts:1356` | prisma | `publicItemsFor` | item | ids from `item.findMany({ orgId, access: public })` | **item-scoped** | Public landing. Reads `template` only for rows already filtered to public items of the org. |
| 193 | `scripts/script-runner.worker.ts:160` | prisma | `pruneOldRuns` | script_run | none (retention) | **system** | Script runner worker. |
| 194 | `scripts/script-runner.worker.ts:180` | prisma | `claimOne` | script_run | none (queue claim) | **system** | Script runner worker. |
| 195 | `scripts/script-schedule.service.ts:159` | prisma | `reconcile` | item (scripts) | none (all script items) | **system** | Schedule reconciler, install-wide. |
| 196 | `storage/key-ownership.ts:167` | prisma | `isKeyReferencedElsewhere` | item, feature_attachment | storage key | **system** | Cross-org reference check before deleting an object. Runs inside user delete requests and returns only a boolean. Under RB-06 it must see every org or it may delete an object another org still references. |
| 197 | `storage/storage.controller.ts:426` | prisma | `findItemIdOwningKey` | item | storage key from the URL | **item-scoped** | StorageController download: the returned id is then checked with ItemsService.get + canRead (signed in) or `access = public` (anonymous) before any bytes are sent. |
| 198 | `tile-layer/pyramid.worker.ts:166` | prisma | `reclaimStaleTilings` | item | none (stale sweep) | **system** | Pyramid worker. |
| 199 | `tile-layer/pyramid.worker.ts:182` | prisma | `reclaimStaleTilings` | item | none (stale sweep) | **system** | Pyramid worker. |
| 200 | `tile-layer/pyramid.worker.ts:219` | prisma | `claimNext` | item | none (queue claim) | **system** | Pyramid worker. |
| 201 | `tile-layer/pyramid.worker.ts:255` | prisma | `beatHeartbeat` | item | claimed item id | **system** | Pyramid worker. |
| 202 | `tile-layer/pyramid.worker.ts:547` | prisma | `applyPatch` | item | claimed item id | **system** | Pyramid worker. |
| 203 | `tile-layer/pyramid.worker.ts:555` | prisma | `applyPatch` | item | claimed item id | **system** | Pyramid worker. |
| 204 | `tile-layer/pyramid.worker.ts:572` | prisma | `clearTilingError` | item | claimed item id | **system** | Pyramid worker. |
| 205 | `tile-layer/pyramid.worker.ts:580` | prisma | `clearTilingError` | item | claimed item id | **system** | Pyramid worker. |
| 206 | `tile-layer/pyramid.worker.ts:615` | prisma | `markFailed` | item | claimed item id | **system** | Pyramid worker. |
| 207 | `tools/recipe-runner.service.ts:546` | prisma | `runSelectionInternal` | observation (through composed CTEs) | target and step source item ids from the recipe | **item-scoped** | items.get(target) + assertFullyReadableLayer on the target and on every step dependency (items.get + isFeatureReadLimited). |
| 208 | `tools/recipe-runner.service.ts:1174` | prisma | `filterByCorridor` | none (PostGIS on bound values) | none | **system** | Pure computation on request features. Reads no table. |
| 209 | `tools/recipe-runner.service.ts:1209` | prisma | `buildAnchorBuffers` | none (PostGIS on bound values) | none | **system** | Pure computation. Reads no table. |
| 210 | `tools/recipe-runner.service.ts:1334` | prisma | `computeAoiBbox` | observation | AOI layer item id from the request | **item-scoped** | Sign-in required, then ItemsService.isFeatureReadLimited (runs items.get, refuses row or area limited shares). |
| 211 | `tools/recipe-runner.service.ts:1352` | prisma | `computeAoiBbox` | observation | AOI layer item id from the request | **item-scoped** | Sign-in required, then ItemsService.isFeatureReadLimited (runs items.get, refuses row or area limited shares). |
| 212 | `area-of-interest/area-of-interest.service.ts:62` | prisma | `register` | none (PostGIS on bound values) | none | **system** | What's Here area resolve (#796): union, make valid, buffer the caller's own shape. Reads no table. Public endpoint; input size checked first. |
| 213 | `area-of-interest/area-of-interest.service.ts:103` | prisma | `register` | area_of_interest (INSERT ... ON CONFLICT) | hash of the resolved shape | **system** | Stores a shape only, no org and no feature data. Shared across orgs by design: the row reveals nothing, and every read that names it runs under the caller's own layer access. |
| 214 | `storage/storage-ledger.service.ts:144` | prisma | `orgOfKey` | storage_object | object key | **system** | Owner check for keys in the older layout: the org found is only compared with the org that authorised the call, never returned. Needs every org's rows once row-level security is on (system connection). |
| 215 | `storage/storage-ledger.service.ts:242` | prisma | `usage` | org_storage_usage | caller's org (`user.orgId`) | **org-scoped** | Storage usage read. The admin route reads only the caller's own org. |
| 216 | `storage/storage-ledger.service.ts:254` | prisma | `usage` | storage_object | caller's org (`user.orgId`) | **org-scoped** | Usage by kind for the same org, grouped. |
| 217 | `storage/storage-ledger.service.ts:299` | prisma | `recountOrg` | org_storage_usage (INSERT ... ON CONFLICT DO NOTHING) | org id from the reconcile | **system** | Daily reconcile, `runAsSystem`. One org per call. |
| 218 | `storage/storage-ledger.service.ts:302` | prisma | `recountOrg` | org_storage_usage (FOR UPDATE) | org id from the reconcile | **system** | Locks the totals row first so a concurrent upload is counted once. |
| 219 | `storage/storage-ledger.service.ts:304` | prisma | `recountOrg` | storage_object | org id from the reconcile | **system** | Sum of the org's live rows. |
| 220 | `storage/storage-ledger.service.ts:312` | prisma | `recountOrg` | org_storage_usage | org id from the reconcile | **system** | Sets the totals and the drift. All values bound. |
| 221 | `storage/storage-ledger.service.ts:333` | prisma | `liveRows` | storage_object | keys listed from the bucket | **system** | Reconcile page lookup, keys bound as one text array. |
| 222 | `storage/storage-ledger.service.ts:346` | prisma | `orgsWithUsage` | org_storage_usage, storage_object | none (all orgs) | **system** | Reconcile: which orgs to recount. |
| 223 | `storage/storage-ledger.service.ts:364` | prisma | `liveKeysOfOrg` | storage_object | org id from the reconcile | **system** | Reconcile: one org's live keys, paged by key. |
| 224 | `storage/storage-ledger.service.ts:380` | prisma | `recordInTx` | storage_object (INSERT ... ON CONFLICT DO NOTHING) | object key and its owner org | **org-scoped** | The owner org comes from the key's org segment or the item that authorised the upload, after the storage owner check. |
| 225 | `storage/storage-ledger.service.ts:392` | prisma | `recordInTx` | storage_object (UPDATE ... FROM a FOR UPDATE subquery) | object key and its owner org | **org-scoped** | Filtered by key and org, so another org's row is never changed. |
| 226 | `storage/storage-ledger.service.ts:412` | prisma | `markDeletedInTx` | storage_object | object key, plus the owner org unless the caller is system work | **system** | Delete hook. Filtered by org for org callers; sweeps filter by key only. |
| 227 | `storage/storage-ledger.service.ts:430` | prisma | `addToTotals` | org_storage_usage (INSERT ... ON CONFLICT DO UPDATE) | owner org of the row just changed | **org-scoped** | Increment in the same transaction as the object row. |
| 228 | `storage/storage-usage-reconcile.service.ts:427` | prisma | `findMissing` | storage_object | org id from the reconcile | **system** | Count of the org's live rows older than the walk. |
| 229 | `storage/storage-usage-reconcile.service.ts:477` | prisma | `loadSmallReferenceMaps` | item, group, user, organization | none (URL pattern bound as a parameter) | **system** | Reconcile: which org owns each older public image key. Read once per run; nothing is returned to a user. |
| 230 | `storage/storage-usage-reconcile.service.ts:517` | prisma | `attribute` | storage_object | keys listed from the bucket | **system** | Reconcile: owner of an older key from a deleted ledger row. |
| 231 | `storage/storage-usage-reconcile.service.ts:520` | prisma | `attribute` | feature_attachment, item | keys listed from the bucket | **system** | Reconcile: owner of an older attachment key, served by feature_attachment_storage_key_idx. |
| 232 | `storage/storage-usage-reconcile.service.ts:534` | prisma | `attribute` | item | keys listed from the bucket | **system** | Reconcile: owner of an older file key, one containment probe per key (item_data_gin, storage_ref index). |
| 233 | `storage/feature-usage.ts:57` | prisma | `measureLayer` | observation | `data_layer:` scope of one layer, built from an item id and layer key the server read | **item-scoped** | Live feature count of one layer through the scope index. Called by the import job after a bulk write and by the nightly pass; returns a number only. |
| 234 | `storage/feature-usage.ts:66` | prisma | `measureLayer` | layer_storage_usage | item id and layer key | **item-scoped** | Previous sample for the same layer. |
| 235 | `storage/feature-usage.ts:80` | prisma | `measureLayer` | observation | same scope | **item-scoped** | Average row size over at most 2000 rows of the layer (`LIMIT` bound as a parameter). |
| 236 | `storage/feature-usage.ts:87` | prisma | `measureLayer` | layer_storage_usage (INSERT ... ON CONFLICT DO UPDATE) | item id, layer key, the item's org | **item-scoped** | Stores the measure under the item's own org. |
| 237 | `storage/feature-usage.ts:110` | prisma | `refreshOrgFeatureTotals` | org_storage_usage, layer_storage_usage | org id of the layer just measured | **org-scoped** | Sum of one org's layer rows. |
| 238 | `storage/feature-usage.ts:122` | prisma | `forgetItemFeatureUsage` | layer_storage_usage | purged item id and its org | **item-scoped** | Purge path, after the item's observation rows are deleted. |
| 239 | `storage/feature-usage.ts:134` | prisma | `queueLayers` | layer_storage_usage, item | none (all data layer items) | **system** | Nightly pass, `runAsSystem`: adds a row per layer. Reads the item table only. |
| 240 | `storage/feature-usage.ts:143` | prisma | `queueLayers` | layer_storage_usage, item | none (rows whose item is gone) | **system** | Nightly pass: drops rows of purged items. |
| 241 | `storage/feature-usage.ts:167` | prisma | `runFeatureUsagePass` | layer_storage_usage | none (oldest measured first) | **system** | Nightly pass work list, 20 rows at a time. |
| 242 | `storage/feature-usage.ts:190` | prisma | `runFeatureUsagePass` | layer_storage_usage | none | **system** | Count of layers left for the next run. |
| 243 | `storage/storage-ledger.service.ts:207` | prisma | `touchRead` | storage_object | object key of a cached embedding the caller was just served | **item-scoped** | Notes the read time for the per-item embedding cap. The key comes from the imagery item the caller can read (after the read check and the storage owner check); at most one write per key every ten minutes. |
| 244 | `storage/feature-usage.ts:207` | prisma | `markMeasureFailed` | layer_storage_usage | item id and layer key from the work list | **system** | Nightly pass, `runAsSystem`: stamps a layer whose measure failed, with the error text bound as a parameter. |

## Keeping this up to date

`scripts/check-raw-sql.mjs` runs in the CI `verify` job. It counts the
sites above per file and compares with `scripts/raw-sql-baseline.json`.

When you add, move or remove a raw SQL call:

1. Add or remove its row here: file, function, tables, where the id
   comes from, class, and the check that protects it. A new `GAP` needs
   an issue.
2. Run `node scripts/check-raw-sql.mjs --update` and commit the new
   baseline with the code and this file.
3. When code above a site moves it to another line, correct the line in
   its row (`--list` prints the current ones). The check names each
   row that is out of date.

`node scripts/check-raw-sql.mjs --list` prints every site as
`file:line kind`. The totals at the top of this page must match its
last line.
