// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  GeocodingCandidate,
  GeocodingServiceData,
} from '@gratis-gis/shared-types';
import { isGeocodingServiceData } from '@gratis-gis/shared-types';

import { geoLimitSql } from '../common/closed-geo-limit.js';
import { ItemsService } from '../items/items.service.js';
import { SharingService } from '../items/sharing.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { AuthUser } from '../auth/auth-sync.service.js';
import {
  GEOCODER_INDEXES_PER_ORG,
  GEOCODER_INDEX_NAME,
  dropGeocoderIndexes,
  geocoderIndexName,
  geocoderIndexPrefix,
} from './geocoder-indexes.js';
import {
  assertSafeOutboundUrl,
  isPrivateOrLoopbackHost,
  safeFetch,
  UnsafeOutboundUrlError,
} from '../common/net-guards.js';

/** Longest one geocoder index build may run. */
const GEOCODER_INDEX_BUILD_TIMEOUT_MS = 15 * 60 * 1000;

/** Most bytes read from an upstream GeocodeServer reply (metadata or a
 *  candidate list). safeFetch's own default is 1 GiB. */
const UPSTREAM_MAX_BYTES = 4 * 1024 * 1024;
/** How long one upstream call may take, body included. */
const UPSTREAM_TIMEOUT_MS = 15_000;

/** Item data is only shape-checked on save, so a number setting can
 *  hold a string. A NaN reached SQL as `LIMIT NaN` and every search on
 *  the geocoder was a 500. Use the default instead. */
function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Service root without query or fragment. A URL pasted from the
 *  browser (`.../GeocodeServer?f=pjson`) kept its query, and `?f=json`
 *  or `/findAddressCandidates` was then appended after it. */
function geocodeServerBase(parsed: URL): string {
  let path = parsed.pathname;
  while (path.endsWith('/')) path = path.slice(0, -1);
  return `${parsed.origin}${path}`;
}

/**
 * Runtime engine for the geocoding_service item type (#74).
 *
 * search() takes a geocoding_service item id + an input string and
 * returns ranked candidate features from the underlying data_layer.
 * Scoring is pg_trgm `similarity()` across each configured search
 * field, multiplied by the field's weight; the top-N rows above the
 * configured `minScore` come back with composed labels + geometry
 * centroids.
 *
 * Authorization is two-layer:
 *
 *   1. The caller must have `view` access to the geocoding_service
 *      item itself. ItemsService.get() enforces this; if the user
 *      can't read the geocoder it raises NotFound and we propagate.
 *   2. The caller must ALSO be able to read the underlying
 *      data_layer. We call ItemsService.get() on the source layer
 *      with the caller's principal so the same share rules apply.
 *      A viewer who has the geocoder shared but not the source
 *      can still call /geocode -- but only against the subset of
 *      features they could read directly, with the share's geo-
 *      limit clip intersected into the query. Sharing a geocoder
 *      is not a back-door around the layer's authz.
 *
 * Perf notes:
 *
 *   - Candidate discovery is backed by the per-searchField partial
 *     GIN trigram indexes that `rebuildIndexes()` creates
 *     (`idx_geo_<item>_<field>`, scoped to the source layer); the
 *     `%>` prefilter in the query is shaped to use them. Without a
 *     rebuild (author never clicked Save on the geocoder editor)
 *     the same query still runs correctly, just as a scan: fine
 *     under ~100K rows, slow above.
 *   - The bboxFilter narrows the candidate set before similarity
 *     scoring fires, which makes "geocoder covers WV only" queries
 *     fast even when the underlying layer is large.
 */
@Injectable()
export class GeocodingService {
  private readonly log = new Logger(GeocodingService.name);

  /** Server-side hard caps so a misconfigured client can't request
   *  thousands of candidates per keystroke. */
  private static readonly MAX_CANDIDATES = 50;
  private static readonly DEFAULT_CANDIDATES = 10;
  private static readonly MAX_TEXT_LENGTH = 200;

  /**
   * Hex characters allowed in the index-name segment we derive from
   * the geocoder item id. UUIDs match [a-f0-9-] so we strip dashes
   * for a tight identifier (Postgres has a 63-char limit on
   * relation names).
   */
  private static readonly INDEX_NAME_PREFIX = 'idx_geo';

  constructor(
    private readonly prisma: PrismaService,
    private readonly items: ItemsService,
    private readonly sharing: SharingService,
  ) {}

  async search(
    user: AuthUser,
    itemId: string,
    queryText: string,
    opts: { bbox?: [number, number, number, number]; limit?: number } = {},
  ): Promise<GeocodingCandidate[]> {
    // Input sanitation. Reject empties before any DB work so the
    // common no-typed-anything case (autocomplete fires on focus)
    // round-trips fast.
    const text = (queryText ?? '').trim();
    if (text.length === 0) return [];
    if (text.length > GeocodingService.MAX_TEXT_LENGTH) {
      throw new BadRequestException(
        `Query text exceeds ${GeocodingService.MAX_TEXT_LENGTH} characters.`,
      );
    }

    // 1) Load the geocoding service item. ItemsService.get enforces
    // the user's read access (NotFound on no-access masks existence).
    const item = await this.items.get(user, itemId);
    if (item.type !== 'geocoding_service') {
      throw new BadRequestException(
        `Item ${itemId} is not a geocoding_service.`,
      );
    }
    if (!isGeocodingServiceData(item.data)) {
      throw new BadRequestException(
        'Geocoding service item has invalid configuration.',
      );
    }
    const config: GeocodingServiceData = item.data;

    // Branch on mode (#74 follow-up: external-arcgis support).
    // Internal mode falls through to the data-layer search below;
    // external-arcgis mode proxies to the upstream ArcGIS
    // GeocodeServer's findAddressCandidates endpoint and reshapes
    // the response into GeocodingCandidate[]. We treat missing
    // mode as 'internal' for backward compat with items written
    // before the field existed.
    const mode = config.mode ?? 'internal';
    if (mode === 'external-arcgis') {
      return this.searchExternalArcgis(config, text, opts);
    }

    if (config.searchFields.length === 0) {
      throw new BadRequestException(
        'Geocoding service has no search fields configured.',
      );
    }

    // 2) Resolve the source data layer + sublayer. The user must
    // be able to read it -- ItemsService.get again enforces share
    // access. If the user can read the geocoder but not the
    // source, they get a 404 here (NotFound for the source item).
    const source = await this.items.get(user, config.sourceLayerId);
    if (source.type !== 'data_layer') {
      throw new BadRequestException(
        'Geocoding service source must be a data_layer.',
      );
    }
    const sublayerId = this.resolveSublayerId(source, config);
    if (!sublayerId) {
      throw new BadRequestException(
        'Geocoding service source layer is missing or no longer has the configured sublayer.',
      );
    }
    const scope = `data_layer:${source.id}:${sublayerId}`;

    // 3) Compose the query. Search fields are validated against the
    // sublayer schema so the SQL fragment we substitute into
    // (attrs->>'field') uses safe identifiers; we hold a strict
    // regex on the field name and reject anything that doesn't
    // match so the embedded literal stays injection-safe.
    const validatedFields = this.validateSearchFields(source, sublayerId, config);

    // Clamp candidate limit to the server max.
    const requestedLimit =
      opts.limit ?? finiteOr(config.candidateLimit, GeocodingService.DEFAULT_CANDIDATES);
    const limit = Math.max(
      1,
      Math.min(GeocodingService.MAX_CANDIDATES, Math.floor(requestedLimit)),
    );

    const minScore = Math.max(0, Math.min(1, finiteOr(config.minScore, 0.1)));

    // Spatial constraint. Caller-supplied bbox overrides the
    // configured filter (the picker UI can shrink the constraint
    // to the visible map extent at query time). Source layer's
    // own bbox is used as fallback for 'layer-bbox'.
    const queryBbox = this.resolveBbox(opts.bbox, config, source);

    // Build the similarity-scoring SQL. Scoring uses explicit
    // word_similarity()/similarity() calls (not the bare `%`
    // operator) because we need the numeric score to rank by; the
    // index-friendly `%>` prefilter below is what keeps the
    // candidate set small on indexed layers.
    const fieldExpressions = validatedFields.map((f) => {
      const weight = Math.max(1, Math.min(10, finiteOr(f.weight, 1)));
      // pg_trgm.word_similarity(query, target) measures how well
      // the query matches the closest WORD in the target. This is
      // what autocomplete users expect: typing "Carlson" should
      // match the owner string "CARLSON CHRISTAL DAWN ROBYN LEE &
      // ALEXIS ANN" with a high score, even though that long
      // string and "Carlson" have very different overall trigram
      // content. similarity() (the obvious-looking choice) would
      // score this around 0.13 because most of the long string's
      // trigrams aren't in "Carlson"; word_similarity scores it
      // near 1.0 because "Carlson" matches the word "CARLSON"
      // exactly. We GREATEST() the per-field score against
      // similarity() so an exact full-string match (the rare case
      // where the user types the whole value) still ranks at the
      // top instead of relying solely on word_similarity's
      // boundary heuristics.
      //
      // Weight is applied as a straight multiplier, NOT divided by
      // maxWeight: a weight=1 field that perfect-matches scores
      // 1.0; a weight=5 field that perfect-matches scores 5.0.
      // The minScore threshold filters on the same scale, so a
      // default minScore of 0.1 catches the typical noise floor
      // for any weighted field. (An earlier draft divided by 10,
      // which made every unweighted match miss minScore by a hair
      // -- visible as "no candidates" when the data clearly
      // contained the term.)
      return Prisma.sql`GREATEST(
        COALESCE(public.word_similarity(${text}, attrs->>${f.name}), 0),
        COALESCE(public.similarity(attrs->>${f.name}, ${text}), 0)
      ) * ${weight}`;
    });
    // GREATEST(...) across all field expressions: the row's score
    // is its best field match. Prisma.join joins the fragments
    // with commas inside the GREATEST() call.
    const greatestExpr = Prisma.sql`GREATEST(${Prisma.join(fieldExpressions, ', ')})`;

    const filters: Prisma.Sql[] = [];
    if (queryBbox) {
      const [w, s, e, n] = queryBbox;
      filters.push(
        Prisma.sql`AND geom && ST_MakeEnvelope(${w}, ${s}, ${e}, ${n}, 4326)`,
      );
    }
    const filterSql =
      filters.length > 0 ? Prisma.join(filters, ' ') : Prisma.empty;

    // The caller's share scope on the source layer, applied to the
    // live rows: a geo limit or own-rows share narrows candidates the
    // same way the engine's reads do. Own rows key on the entity's
    // latest create, so a re-created id belongs to whoever re-created
    // it.
    const shareScope = await this.items.featureReadScope(
      user,
      source,
      sublayerId,
    );
    const scopeFilters: Prisma.Sql[] = [];
    if (shareScope.geoLimit) {
      scopeFilters.push(geoLimitSql(shareScope.geoLimit, 'geom', 'AND '));
    }
    if (shareScope.rowScope === 'own') {
      scopeFilters.push(Prisma.sql`AND (
        SELECT c.author_sub FROM observation c
        WHERE c.scope = ${scope}
          AND c.entity = latest.entity
          AND c.kind = 'create'
        ORDER BY c.valid_from DESC, c.tx_time DESC, c.id DESC
        LIMIT 1
      ) = ${shareScope.userId}`);
    }
    const scopeSql =
      scopeFilters.length > 0 ? Prisma.join(scopeFilters, ' ') : Prisma.empty;

    // Index-using filter (#74 perf followup). The %> operator
    // (word similarity above pg_trgm.word_similarity_threshold)
    // can use a GIN trigram index on `(attrs->>'field')`, which
    // we create per searchField in rebuildIndexes(). Without
    // this prefilter, queries against >100K-row layers go
    // sequential and take minutes. We OR across every search
    // field so a hit in ANY field qualifies the row for scoring.
    //
    // Lowering the per-query word_similarity threshold via
    // set_limit() makes the index hand back broader candidates;
    // we still apply minScore on the computed word_similarity
    // score below, so this just controls candidate breadth.
    const trgmFilters = validatedFields.map(
      (f) => Prisma.sql`attrs->>${f.name} %> ${text}`,
    );
    const trgmFilterSql = Prisma.sql`AND (${Prisma.join(trgmFilters, ' OR ')})`;

    interface CandidateRow {
      entity: string;
      attrs: Record<string, unknown> | null;
      geom_geojson: { type: string; coordinates: unknown } | null;
      score: number;
    }

    // Lower word_similarity_threshold, the setting `%>` reads (the
    // default 0.6 is too strict for autocomplete typos), so the index
    // hands back broader candidates; minScore is applied to the
    // computed score further down. set_config(..., true) is the
    // SET LOCAL form, so it lives only for this transaction and the
    // query below runs on the same connection. set_limit() changed
    // the other setting (similarity_threshold, for `%`), per session,
    // on whichever pooled connection it got.

    // Candidate-then-collapse-then-filter (the same staging the
    // engine's read paths use):
    //
    //   candidates: entities with ANY observation version matching
    //     the trigram prefilter + bbox. This is where the partial
    //     GIN indexes plug in; matching any version over-selects,
    //     never under-selects, because the current version is one
    //     of the versions probed.
    //   latest: each candidate collapsed to its true latest
    //     observation over its FULL history (same DISTINCT ON
    //     ordering the engine's canonical collapse uses).
    //   live: tombstones dropped AND the prefilters re-checked
    //     against the latest row. Without the re-check (the pre-fix
    //     shape applied the filters inside the collapse) a parcel
    //     whose owner attribute was edited away, or that was
    //     deleted outright, kept geocoding under its OLD value: the
    //     old version matched the prefilter and won the DISTINCT ON
    //     because the true latest was filtered out of the window.
    const rows = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('pg_trgm.word_similarity_threshold', '0.1', true)`;
      return tx.$queryRaw<CandidateRow[]>`
      WITH candidates AS (
        SELECT DISTINCT entity
        FROM observation
        WHERE scope = ${scope}
        ${trgmFilterSql}
        ${filterSql}
      ),
      latest AS (
        SELECT DISTINCT ON (entity)
          entity, attrs, geom, kind
        FROM observation
        WHERE scope = ${scope}
          AND entity IN (SELECT entity FROM candidates)
        ORDER BY entity, valid_from DESC, tx_time DESC, id DESC
      ),
      live AS (
        SELECT entity, attrs, geom
        FROM latest
        WHERE kind <> 'delete'
        ${trgmFilterSql}
        ${filterSql}
        ${scopeSql}
      ),
      scored AS (
        SELECT
          entity,
          attrs,
          geom,
          ${greatestExpr} AS score
        FROM live
      )
      SELECT
        entity,
        attrs,
        -- ST_PointOnSurface picks a point guaranteed to lie on
        -- the geometry (centroid can sit outside concave
        -- polygons). Falls through ST_AsGeoJSON to the wire
        -- shape the runtime emits in geom.
        ST_AsGeoJSON(
          CASE
            WHEN geom IS NULL THEN NULL
            WHEN ST_GeometryType(geom) = 'ST_Point' THEN geom
            ELSE ST_PointOnSurface(geom)
          END
        )::jsonb AS geom_geojson,
        score
      FROM scored
      WHERE score >= ${minScore}
      ORDER BY score DESC
      LIMIT ${limit}
    `;
    // Prisma's 5 s default would end a search the 30 s statement
    // timeout still allows.
    }, { timeout: 35_000 });

    // 4) Compose the wire shape: label string + restricted
    // attributes per the geocoder's resultFields setting.
    const resultFieldNames =
      Array.isArray(config.resultFields) && config.resultFields.length > 0
        ? config.resultFields.filter((n): n is string => typeof n === 'string')
        : validatedFields.map((f) => f.name);

    return rows
      .map((r): GeocodingCandidate | null => {
        if (!r.geom_geojson) return null;
        const coords = (r.geom_geojson as { coordinates?: unknown })
          .coordinates;
        if (
          !Array.isArray(coords) ||
          coords.length < 2 ||
          typeof coords[0] !== 'number' ||
          typeof coords[1] !== 'number'
        ) {
          return null;
        }
        const attrs = r.attrs ?? {};
        const restrictedAttrs: Record<string, unknown> = {};
        for (const name of resultFieldNames) {
          if (name in attrs) restrictedAttrs[name] = attrs[name];
        }
        return {
          featureId: r.entity,
          score: Number(r.score) || 0,
          label: this.composeLabel(config, validatedFields, attrs),
          geom: {
            type: 'Point',
            coordinates: [coords[0], coords[1]],
          },
          attributes: restrictedAttrs,
        };
      })
      .filter((c): c is GeocodingCandidate => c !== null);
  }

  /**
   * Resolve the source data_layer's sublayer id for this geocoder.
   * v3 data_layer items carry one or more layers in
   * `data.layers[]`; the geocoder targets one of them. v2 (legacy
   * single-table) data_layer items have no sublayer concept; we
   * return a synthetic 'default' id that the caller's scope build
   * handles uniformly.
   */
  /**
   * Rebuild the per-searchField GIN trigram indexes that power the
   * geocoder's runtime query. Creates one partial index per
   * configured searchField, scoped to the source data_layer's
   * observation rows. Drops indexes for fields the geocoder no
   * longer references so renaming or removing a searchField doesn't
   * leave dead indexes around.
   *
   * Synchronous on purpose: the user just clicked Save and is
   * waiting to see "indexes ready" before the geocoder is fast.
   * On a 1M-row layer one GIN trigram index takes ~30-60 seconds;
   * 2-3 searchFields total ~1-3 minutes one-time setup cost. The
   * editor's UI shows a "Building search indexes..." progress
   * indicator during the wait.
   *
   * Notes on the choice of partial vs full index:
   *
   *   - Full GIN on (attrs->>'field') would index every observation
   *     row across every scope, including unrelated data_layers
   *     that happen to have the same field name. Wasteful.
   *
   *   - Partial GIN with WHERE scope = '...' only includes the
   *     source layer's rows. Smaller index, faster build, faster
   *     query (planner can use the partial index when the query
   *     also has scope = '...').
   *
   * The CREATE INDEX runs without CONCURRENTLY because partitioned
   * parent tables (observation is partitioned by tx_time) don't
   * support concurrent index builds in PG 16. The build takes a
   * SHARE lock on every partition of observation, so it stalls
   * feature writes for every layer in every org while it runs, and
   * a partial index still scans the whole table. That is why only
   * org admins can rebuild and why each org's count is capped.
   *
   * Indexes are named `idx_geo_<itemIdHex>_<hash>_<safeFieldName>` so the
   * cleanup pass can identify and drop the ones this geocoder
   * owns without false positives.
   */
  async rebuildIndexes(
    user: AuthUser,
    itemId: string,
  ): Promise<{
    created: string[];
    kept: string[];
    dropped: string[];
    rowCount: number;
    durationMs: number;
  }> {
    const start = Date.now();
    const item = await this.items.get(user, itemId);
    if (item.type !== 'geocoding_service') {
      throw new BadRequestException(
        `Item ${itemId} is not a geocoding_service.`,
      );
    }
    // Org admins only, not every owner. The build and the drop lock
    // the shared observation table for every layer in every org, so
    // this is an install-level cost, like SearchIndexService's rebuild.
    if (user.orgRole !== 'admin' || !this.sharing.canAdmin(user, item)) {
      throw new ForbiddenException(
        'Only an org admin can rebuild geocoder indexes.',
      );
    }
    if (!isGeocodingServiceData(item.data)) {
      throw new BadRequestException(
        'Geocoding service item has invalid configuration.',
      );
    }
    const config: GeocodingServiceData = item.data;
    if (config.searchFields.length === 0) {
      // Nothing to index. Drop any leftover indexes from a
      // previous configuration and report.
      const dropped = await this.dropExistingGeocoderIndexes(itemId);
      return {
        created: [],
        kept: [],
        dropped,
        rowCount: 0,
        durationMs: Date.now() - start,
      };
    }

    const source = await this.items.get(user, config.sourceLayerId);
    if (source.type !== 'data_layer') {
      throw new BadRequestException(
        'Geocoding service source must be a data_layer.',
      );
    }
    const sublayerId = this.resolveSublayerId(source, config);
    if (!sublayerId) {
      throw new BadRequestException(
        'Geocoding service source layer is missing or no longer has the configured sublayer.',
      );
    }
    const scope = `data_layer:${source.id}:${sublayerId}`;

    // Validate field names against schema before any DB work.
    // Same check the runtime search uses.
    const validatedFields = this.validateSearchFields(
      source,
      sublayerId,
      config,
    );

    // Compute desired index names (see geocoderIndexName). The name
    // stays a plain identifier inside Postgres's 63-character limit.
    const itemIdHex = itemId.replace(/-/g, '').slice(0, 16);
    const desiredByField = new Map<string, string>();
    for (const f of validatedFields) {
      desiredByField.set(f.name, geocoderIndexName(itemId, scope, f.name));
    }
    const desiredIndexNames = new Set(desiredByField.values());

    // Find existing indexes that belong to this geocoder
    // (anything named idx_geo_<itemIdHex>_*). Anything not in the
    // desired set gets dropped.
    const existingIndexes = await this.prisma.$queryRaw<
      Array<{ indexname: string }>
    >`
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname LIKE ${`${GeocodingService.INDEX_NAME_PREFIX}_${itemIdHex}_%`}
    `;
    const existingNames = new Set(existingIndexes.map((r) => r.indexname));
    // An index left invalid (a build that died) is not an index the
    // planner uses. Treat it as missing so it is dropped and rebuilt.
    const invalid = await this.prisma.$queryRaw<Array<{ indexname: string }>>`
      SELECT c.relname AS indexname
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
      WHERE NOT i.indisvalid
        AND c.relname LIKE ${`${GeocodingService.INDEX_NAME_PREFIX}_${itemIdHex}_%`}
    `;
    for (const r of invalid) {
      if (!GEOCODER_INDEX_NAME.test(r.indexname)) continue;
      await this.prisma.$executeRawUnsafe(
        `DROP INDEX IF EXISTS "${r.indexname}"`,
      );
      existingNames.delete(r.indexname);
    }

    // Cap the indexes one org can hang off the shared table. Count the
    // org's other geocoders' indexes plus what this one wants.
    const toCreate = [...desiredIndexNames].filter((n) => !existingNames.has(n));
    if (toCreate.length > 0) {
      const others = await this.prisma.item.findMany({
        where: { orgId: item.orgId, type: 'geocoding_service', id: { not: itemId } },
        select: { id: true },
      });
      let held = 0;
      if (others.length > 0) {
        const prefixes = others.map((o) => `${geocoderIndexPrefix(o.id)}%`);
        const rows = await this.prisma.$queryRaw<Array<{ n: bigint }>>`
          SELECT count(*)::bigint AS n
          FROM pg_indexes
          WHERE schemaname = 'public'
            AND indexname LIKE ANY (${prefixes}::text[])
        `;
        held = Number(rows[0]?.n ?? 0);
      }
      if (held + desiredIndexNames.size > GEOCODER_INDEXES_PER_ORG) {
        throw new BadRequestException(
          `This organization's geocoders would hold more than ${GEOCODER_INDEXES_PER_ORG} search indexes. Remove search fields from this or another geocoder first.`,
        );
      }
    }

    const created: string[] = [];
    const kept: string[] = [];
    const dropped: string[] = [];

    // Drop indexes the new config no longer needs.
    for (const name of existingNames) {
      if (!desiredIndexNames.has(name)) {
        // Index names embedded into DDL aren't bound parameters
        // (Postgres has no parameterizable DROP INDEX). We mint
        // them ourselves from a sanitized hex string + safe
        // field name regex, so the value is trusted -- but we
        // still validate the name against our naming pattern
        // before interpolating to keep the trust boundary
        // explicit.
        if (!/^idx_geo_[a-f0-9]+_[a-zA-Z0-9_]+$/.test(name)) {
          this.log.warn(
            `Refusing to DROP unexpected index name '${name}' that survived the pg_indexes filter.`,
          );
          continue;
        }
        await this.prisma.$executeRawUnsafe(`DROP INDEX IF EXISTS "${name}"`);
        dropped.push(name);
      }
    }

    // Create indexes missing for the current config. CREATE INDEX
    // IF NOT EXISTS so the same call is idempotent across saves
    // where searchFields didn't change.
    for (const [fieldName, indexName] of desiredByField) {
      if (existingNames.has(indexName)) {
        kept.push(indexName);
        continue;
      }
      // Name + field both validated above. We can safely
      // interpolate them as identifiers.
      if (!/^idx_geo_[a-f0-9]+_[a-zA-Z0-9_]+$/.test(indexName)) {
        // Defensive: every desired name above passed the
        // validator. If we got here it's a bug, not a security
        // concern, but skip just in case.
        this.log.warn(`Skipping invalid index name '${indexName}'`);
        continue;
      }
      if (!/^[a-zA-Z0-9_]+$/.test(fieldName)) {
        this.log.warn(`Skipping invalid field name '${fieldName}'`);
        continue;
      }
      // The scope value comes from data we control (item.id +
      // sublayerId from the validated source) but we still bind
      // it as a parameter for safety. Field name is embedded
      // into the index expression because Postgres has no way to
      // parameterize a JSON path inside CREATE INDEX.
      // pg_trgm.gin_trgm_ops is the trigram opclass that supports
      // both similarity() and word_similarity() index lookups via
      // the %, %>, and <% operators.
      //
      // The app role's 30 s statement_timeout cancelled this on large
      // layers (the build takes 30 to 60 s at 1M rows, see above), so
      // the index could never be made. Lift it for this one statement,
      // the way CopyWriter and the item purge do. lock_timeout makes
      // the build give up rather than wait behind a long writer, since
      // every write that arrives meanwhile would queue behind it.
      await this.prisma.$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe('SET LOCAL statement_timeout = 0');
          await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '10s'");
          await tx.$executeRawUnsafe(
            `CREATE INDEX IF NOT EXISTS "${indexName}"
             ON observation
             USING gin ((attrs->>'${fieldName}') gin_trgm_ops)
             WHERE scope = '${scope.replace(/'/g, "''")}'`,
          );
        },
        { maxWait: 10_000, timeout: GEOCODER_INDEX_BUILD_TIMEOUT_MS },
      );
      created.push(indexName);
    }

    // Approximate row count (Postgres maintains a live estimate in
    // pg_class.reltuples that's good enough for telling the user
    // how big the indexed dataset is).
    const countRows = await this.prisma.$queryRaw<
      Array<{ count: bigint }>
    >`
      SELECT COUNT(*)::bigint AS count
      FROM observation
      WHERE scope = ${scope}
    `;
    const rowCount = Number(countRows[0]?.count ?? 0);

    return {
      created,
      kept,
      dropped,
      rowCount,
      durationMs: Date.now() - start,
    };
  }

  /**
   * Drop every geocoder index owned by this item. Used by
   * rebuildIndexes() when the geocoder has no searchFields left,
   * and (through dropGeocoderIndexes) by the item purge teardown.
   */
  private async dropExistingGeocoderIndexes(
    itemId: string,
  ): Promise<string[]> {
    return dropGeocoderIndexes(this.prisma, itemId);
  }


  /**
   * Probe an ArcGIS GeocodeServer URL and return the metadata
   * the editor needs to display + persist on the geocoding_service
   * item. The author calls this from the detail editor when
   * configuring an external-arcgis geocoder; on success the
   * editor PATCHes the returned fields into item.data and the
   * runtime is ready to forward queries.
   *
   * Refuses non-GeocodeServer URLs early so the user doesn't end
   * up with a geocoding_service that points at something else.
   * SSRF defense matches the basemap probe: private / loopback
   * IPs are refused.
   */
  async probeExternalArcgis(
    url: string,
  ): Promise<{
    externalUrl: string;
    externalServiceTitle?: string;
    externalAddressFields?: Array<{
      name: string;
      alias?: string;
      required?: boolean;
    }>;
    externalSingleLineFieldName?: string;
    externalSupportedCountries?: string[];
    externalCapabilities?: string[];
    externalAttribution?: string;
  }> {
    const trimmed = (url ?? '').trim();
    if (!trimmed) {
      throw new BadRequestException('URL is required.');
    }
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      throw new BadRequestException('Not a valid URL.');
    }
    if (isPrivateOrLoopbackHost(parsed.hostname)) {
      throw new BadRequestException(
        'Probing private / loopback addresses is not allowed.',
      );
    }
    if (!/\/GeocodeServer\/?$/i.test(parsed.pathname)) {
      throw new BadRequestException(
        'URL must point at an ArcGIS GeocodeServer (path ends in /GeocodeServer).',
      );
    }
    const base = geocodeServerBase(parsed);
    const metaUrl = `${base}?f=json`;
    // DNS-rebinding defense in addition to the hostname check above.
    let safeMetaUrl: URL;
    try {
      safeMetaUrl = await assertSafeOutboundUrl(metaUrl);
    } catch (err) {
      if (err instanceof UnsafeOutboundUrlError) {
        throw new BadRequestException(err.message);
      }
      throw err;
    }
    // safeFetch, not fetch: re-validate every redirect hop so a
    // validated host that 302s to an internal address is refused too
    // (the assert above only covers the first URL).
    // A small byte cap and one timeout that stays armed through the
    // body read: any signed-in user can point this at their own server,
    // which could otherwise send a 1 GiB body or drip one forever.
    const meta = (await this.fetchUpstreamJson(
      safeMetaUrl.toString(),
      'GratisGIS/geocoder-probe',
      (status) =>
        `GeocodeServer returned HTTP ${status}. Check the URL and that the server is reachable.`,
    )) as {
      serviceDescription?: unknown;
      mapName?: unknown;
      copyrightText?: unknown;
      addressFields?: unknown;
      singleLineAddressField?: unknown;
      countries?: unknown;
      capabilities?: unknown;
      currentVersion?: unknown;
    };
    if (typeof meta.currentVersion !== 'number') {
      throw new BadRequestException(
        'Response does not look like an ArcGIS REST service (no currentVersion field).',
      );
    }
    const result: Awaited<ReturnType<typeof this.probeExternalArcgis>> = {
      externalUrl: base,
    };
    const title =
      typeof meta.mapName === 'string' && meta.mapName.trim().length > 0
        ? meta.mapName.trim()
        : typeof meta.serviceDescription === 'string' &&
            meta.serviceDescription.trim().length > 0
          ? meta.serviceDescription.trim()
          : undefined;
    if (title) result.externalServiceTitle = title;
    const fields = this.parseAddressFields(meta.addressFields);
    if (fields && fields.length > 0) result.externalAddressFields = fields;
    const single = this.parseSingleLineField(meta.singleLineAddressField);
    if (single) result.externalSingleLineFieldName = single;
    const countries = this.parseCountries(meta.countries);
    if (countries && countries.length > 0) {
      result.externalSupportedCountries = countries;
    }
    const capabilities = this.parseCapabilities(meta.capabilities);
    if (capabilities && capabilities.length > 0) {
      result.externalCapabilities = capabilities;
    }
    if (
      typeof meta.copyrightText === 'string' &&
      meta.copyrightText.trim().length > 0
    ) {
      result.externalAttribution = meta.copyrightText.trim();
    }
    return result;
  }

  /**
   * Proxy a search to an external ArcGIS GeocodeServer. Posts the
   * query as `SingleLine=<text>` against findAddressCandidates,
   * reshapes the response into GeocodingCandidate[].
   *
   * Why not just have the browser hit the upstream directly:
   *
   *   - CORS. Most public locators don't set permissive headers,
   *     so direct browser fetches fail.
   *   - Consistency. The map search bar treats every geocoder
   *     source the same way regardless of internal vs external;
   *     proxying through our /geocode endpoint keeps that uniform.
   *   - Future caching. We can cache hot queries here without
   *     surface changes to consumers.
   */
  /**
   * GET an upstream GeocodeServer JSON reply with a byte cap and a
   * timeout that covers the body too. Every failure is a 400 so a bad
   * upstream never reads as a portal fault.
   */
  private async fetchUpstreamJson(
    url: string,
    userAgent: string,
    statusMessage: (status: number) => string,
  ): Promise<unknown> {
    const signal = AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
    let res: Response;
    try {
      res = await safeFetch(
        url,
        { headers: { 'user-agent': userAgent }, signal },
        { maxBytes: UPSTREAM_MAX_BYTES },
      );
    } catch (err) {
      if (err instanceof UnsafeOutboundUrlError) {
        throw new BadRequestException(err.message);
      }
      this.log.warn(
        `Upstream geocoder fetch failed for ${new URL(url).origin}: ${err instanceof Error ? err.message : err}`,
      );
      throw new BadRequestException(
        `Upstream geocoder unreachable: ${err instanceof Error ? err.message : 'network error'}`,
      );
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw new BadRequestException(statusMessage(res.status));
    }
    try {
      return await res.json();
    } catch (err) {
      if (err instanceof UnsafeOutboundUrlError) {
        throw new BadRequestException(err.message);
      }
      throw new BadRequestException(
        signal.aborted
          ? 'Upstream geocoder took too long to answer.'
          : 'Upstream geocoder did not answer with JSON.',
      );
    }
  }

  private async searchExternalArcgis(
    config: GeocodingServiceData,
    text: string,
    opts: { bbox?: [number, number, number, number]; limit?: number },
  ): Promise<GeocodingCandidate[]> {
    if (!config.externalUrl) {
      throw new BadRequestException(
        'External geocoder has no upstream URL configured.',
      );
    }
    let base: string;
    try {
      base = geocodeServerBase(new URL(config.externalUrl));
    } catch {
      throw new BadRequestException('External geocoder URL is not a valid URL.');
    }
    const params = new URLSearchParams();
    // Most modern locators support `SingleLine`. If a locator
    // only has multi-line fields (no singleLineAddressField), the
    // server still accepts SingleLine on findAddressCandidates
    // as of ArcGIS 10.3+; we don't try to split the query into
    // multi-line fields client-side.
    params.set('SingleLine', text);
    params.set('f', 'json');
    params.set('outFields', '*');
    params.set('outSR', '4326');
    const requestedLimit =
      opts.limit ?? finiteOr(config.candidateLimit, GeocodingService.DEFAULT_CANDIDATES);
    const maxLocations = Math.max(
      1,
      Math.min(GeocodingService.MAX_CANDIDATES, Math.floor(requestedLimit)),
    );
    params.set('maxLocations', String(maxLocations));
    if (opts.bbox) {
      // ArcGIS expects searchExtent as a JSON envelope in the
      // service's spatial reference. We pass 4326 here; servers
      // re-project internally. Format matches the documented
      // envelope shape.
      const [w, s, e, n] = opts.bbox;
      params.set(
        'searchExtent',
        JSON.stringify({
          xmin: w,
          ymin: s,
          xmax: e,
          ymax: n,
          spatialReference: { wkid: 4326 },
        }),
      );
    }
    const url = `${base}/findAddressCandidates?${params.toString()}`;
    // safeFetch (inside fetchUpstreamJson), not fetch: externalUrl was
    // validated at probe time, but item.data is editable afterwards,
    // so the runtime query path needs the same SSRF guard the admin
    // probe path runs.
    const body = (await this.fetchUpstreamJson(
      url,
      'GratisGIS/geocoder',
      (status) => `Upstream geocoder returned HTTP ${status}.`,
    )) as {
      candidates?: Array<{
        address?: unknown;
        score?: unknown;
        location?: { x?: unknown; y?: unknown };
        attributes?: Record<string, unknown>;
      }>;
      error?: { message?: unknown };
    };
    if (body.error && typeof body.error.message === 'string') {
      throw new BadRequestException(
        `Upstream geocoder error: ${body.error.message}`,
      );
    }
    const rawCandidates = Array.isArray(body.candidates) ? body.candidates : [];
    const minScore = Math.max(0, Math.min(100, finiteOr(config.minScore, 0.1) * 100));
    return rawCandidates
      .map((c): GeocodingCandidate | null => {
        const lng = c.location?.x;
        const lat = c.location?.y;
        if (typeof lng !== 'number' || typeof lat !== 'number') return null;
        // ArcGIS returns score on a 0-100 scale; our wire shape
        // uses 0-1. Normalize so consumers can sort with the
        // same comparator regardless of geocoder source.
        const rawScore = typeof c.score === 'number' ? c.score : 0;
        if (rawScore < minScore) return null;
        const label = typeof c.address === 'string' ? c.address : '(unnamed)';
        const attrs = c.attributes ?? {};
        // Use the address string as the featureId fallback when
        // the upstream didn't provide a stable id; clients use
        // this for click-through highlighting so any consistent
        // value works.
        const featureId =
          typeof attrs['Ref_ID'] === 'string'
            ? (attrs['Ref_ID'] as string)
            : typeof attrs['ResultID'] === 'number'
              ? String(attrs['ResultID'])
              : label;
        return {
          featureId,
          score: rawScore / 100,
          label,
          geom: { type: 'Point', coordinates: [lng, lat] },
          attributes: attrs,
        };
      })
      .filter((c): c is GeocodingCandidate => c !== null);
  }

  // ---- External-arcgis metadata parse helpers ----
  // These mirror the parser helpers in the basemap probe path
  // (#75 admin-basemap-probe.controller) but live here because
  // they're consumed only by the geocoding service.

  private parseAddressFields(
    input: unknown,
  ): Array<{ name: string; alias?: string; required?: boolean }> | undefined {
    if (!Array.isArray(input)) return undefined;
    const out: Array<{ name: string; alias?: string; required?: boolean }> = [];
    for (const f of input) {
      if (!f || typeof f !== 'object') continue;
      const row = f as { name?: unknown; alias?: unknown; required?: unknown };
      if (typeof row.name !== 'string' || row.name.length === 0) continue;
      const entry: { name: string; alias?: string; required?: boolean } = {
        name: row.name,
      };
      if (typeof row.alias === 'string' && row.alias.length > 0) {
        entry.alias = row.alias;
      }
      if (typeof row.required === 'boolean') entry.required = row.required;
      out.push(entry);
    }
    return out;
  }

  private parseSingleLineField(input: unknown): string | undefined {
    if (!input || typeof input !== 'object') return undefined;
    const obj = input as { name?: unknown };
    return typeof obj.name === 'string' && obj.name.length > 0
      ? obj.name
      : undefined;
  }

  private parseCountries(input: unknown): string[] | undefined {
    if (Array.isArray(input)) {
      const arr = input
        .filter((c): c is string => typeof c === 'string' && c.length > 0)
        .map((c) => c.trim().toUpperCase());
      return [...new Set(arr)];
    }
    if (typeof input === 'string' && input.length > 0) {
      const arr = input
        .split(',')
        .map((c) => c.trim().toUpperCase())
        .filter((c) => c.length > 0);
      return [...new Set(arr)];
    }
    return undefined;
  }

  private parseCapabilities(input: unknown): string[] | undefined {
    if (typeof input !== 'string' || input.length === 0) return undefined;
    const toks = input
      .split(',')
      .map((t) => t.trim().toLowerCase())
      .filter((t) => t.length > 0);
    return toks.length > 0 ? [...new Set(toks)] : undefined;
  }

  private resolveSublayerId(
    source: { data: unknown },
    config: GeocodingServiceData,
  ): string | null {
    const sd = source.data as {
      version?: unknown;
      layers?: Array<{ id?: unknown }>;
    } | null;
    if (sd?.version === 3 && Array.isArray(sd.layers)) {
      const wanted = config.sourceSublayerId;
      if (!wanted) return null;
      const match = sd.layers.find((l) => (l.id as unknown) === wanted);
      return match ? wanted : null;
    }
    // Legacy v2 layer: there's only one logical sublayer and the
    // engine's scope encoding for v2 doesn't include a sublayer
    // segment. Geocoding against v2 layers isn't a v1 target; the
    // wizard refuses to author a geocoder against a v2 source.
    return null;
  }

  /**
   * Validate that every searchField name is a real attribute on the
   * source layer's schema AND consists of safe identifier characters.
   * The field name gets embedded into the SQL as a bound parameter
   * (`attrs->>$x`) so injection isn't possible, but the strict-name
   * check still catches misconfigured items early and produces a
   * clean error message rather than a SQL operator failure.
   */
  private validateSearchFields(
    source: { data: unknown },
    sublayerId: string,
    config: GeocodingServiceData,
  ): Array<{ name: string; weight?: number; label?: string }> {
    const sd = source.data as {
      version?: unknown;
      layers?: Array<{ id?: unknown; fields?: Array<{ name?: unknown }> }>;
    } | null;
    const schemaFieldNames = new Set<string>();
    if (sd?.version === 3 && Array.isArray(sd.layers)) {
      const layer = sd.layers.find((l) => l.id === sublayerId);
      if (layer && Array.isArray(layer.fields)) {
        for (const f of layer.fields) {
          if (typeof f.name === 'string') schemaFieldNames.add(f.name);
        }
      }
    }
    const validated: Array<{ name: string; weight?: number; label?: string }> = [];
    for (const sf of config.searchFields) {
      if (!/^[a-zA-Z0-9_]+$/.test(sf.name)) {
        throw new BadRequestException(
          `Search field '${sf.name}' has invalid characters; must match [a-zA-Z0-9_]+`,
        );
      }
      if (schemaFieldNames.size > 0 && !schemaFieldNames.has(sf.name)) {
        throw new BadRequestException(
          `Search field '${sf.name}' is not in the source layer schema.`,
        );
      }
      const out: { name: string; weight?: number; label?: string } = {
        name: sf.name,
      };
      if (sf.weight !== undefined) out.weight = sf.weight;
      if (sf.label !== undefined) out.label = sf.label;
      validated.push(out);
    }
    if (validated.length === 0) {
      throw new BadRequestException(
        'Geocoding service has no valid search fields after validation.',
      );
    }
    return validated;
  }

  /** Resolve the effective bbox filter for this query. Caller-
   *  supplied bbox always wins (used by the map picker to clip to
   *  the visible extent). Otherwise honors the geocoder's
   *  bboxFilter config, falling back to the source layer's cached
   *  bbox for 'layer-bbox'. */
  private resolveBbox(
    callerBbox: [number, number, number, number] | undefined,
    config: GeocodingServiceData,
    source: { bbox: number[] | null },
  ): [number, number, number, number] | null {
    if (callerBbox) return callerBbox;
    const filter = config.bboxFilter ?? 'layer-bbox';
    if (filter === 'none') return null;
    if (filter === 'layer-bbox') {
      const b = source.bbox;
      if (
        Array.isArray(b) &&
        b.length === 4 &&
        b.every((n) => typeof n === 'number')
      ) {
        return [b[0]!, b[1]!, b[2]!, b[3]!];
      }
      return null;
    }
    if (
      filter &&
      typeof filter === 'object' &&
      Array.isArray(filter.wsen) &&
      filter.wsen.length === 4 &&
      filter.wsen.every((n) => typeof n === 'number' && Number.isFinite(n))
    ) {
      return filter.wsen;
    }
    return null;
  }

  /**
   * Compose the candidate label. Honors the geocoder's
   * `labelTemplate` when set (with `{fieldName}` substitution);
   * falls back to joining the search-field values with commas so
   * unconfigured geocoders still produce a usable label.
   */
  private composeLabel(
    config: GeocodingServiceData,
    fields: Array<{ name: string }>,
    attrs: Record<string, unknown>,
  ): string {
    const template =
      typeof config.labelTemplate === 'string' ? config.labelTemplate.trim() : undefined;
    if (template && template.length > 0) {
      return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (_full, name: string) => {
        const v = attrs[name];
        return v === null || v === undefined ? '' : String(v);
      });
    }
    // Default: join the search-field values with commas, skipping
    // empties. Falls back to the entity id if every field is null
    // so callers always have a non-empty string to render.
    const parts = fields
      .map((f) => attrs[f.name])
      .filter((v) => v !== null && v !== undefined && String(v).length > 0)
      .map((v) => String(v));
    if (parts.length > 0) return parts.join(', ');
    return '(unnamed)';
  }
}
