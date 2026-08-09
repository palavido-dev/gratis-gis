// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BadRequestException,
  Controller,
  Get,
  NotFoundException,
  Param,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';

import { Public } from '../auth/public.decorator.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { DataLayerFeaturesService } from '../data-layer/features.service.js';
import { parsePagingParams } from '../data-layer/feature-paging.js';
import { loadOsmPresetCatalog } from '../osm/preset-catalog.js';
import {
  TileCacheOverloadError,
  matchesIfNoneMatch,
  tileOverloadRetryAfterSeconds,
} from '../engine/tile-cache.service.js';
import { synthesizeThumbnailUrl } from '../items/thumbnail-url.js';
import {
  PUBLIC_TIER_SELECT,
  publicTierGeoLimit,
} from './public-geo-limit.js';

/**
 * Unauthenticated surface area for the portal. Anything here is
 * readable by the internet without a session cookie or bearer
 * token. Keep it narrow: public item metadata, org landing config,
 * public feeds.
 *
 * All responses deliberately carry a lean projection: no shares
 * list, no dependent lookups, nothing that would leak private
 * content through a public endpoint. If in doubt, do not expose it
 * here.
 */
@ApiTags('public')
@Controller('public')
export class PublicController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly v3: DataLayerFeaturesService,
  ) {}

  /**
   * Landing page payload for unauthenticated visitors. Returns:
   *   - resolved org (title, subtitle, hero image URL)
   *   - show-items toggle
   *   - grid of public items (honoring featuredItemIds order) OR
   *     empty array when the toggle is off
   *
   * In single-tenant deployments the `org` query param is optional
   * and resolves to the only organization. Multi-tenant deployments
   * require the slug.
   */
  @Public()
  @Get('landing')
  async landing(@Query('org') orgSlug?: string) {
    const org = orgSlug
      ? await this.prisma.organization.findUnique({ where: { slug: orgSlug } })
      : await this.resolveSingleOrg();
    if (!org) {
      throw new NotFoundException(
        orgSlug
          ? `No organization with slug "${orgSlug}"`
          : 'No organization configured on this portal yet',
      );
    }

    const items = org.landingShowPublicItems
      ? await this.publicItemsFor(org.id, org.landingFeaturedItemIds)
      : [];

    return {
      org: {
        slug: org.slug,
        name: org.name,
        title: org.landingTitle ?? org.name,
        subtitle: org.landingSubtitle ?? null,
        heroImageUrl: org.landingHeroImageUrl ?? null,
        showPublicItems: org.landingShowPublicItems,
      },
      items,
    };
  }

  /**
   * DCAT-lite machine-readable catalog of every public item. Shape
   * follows the W3C Data Catalog Vocabulary loosely: each item
   * becomes a dcat:Dataset with the license, description, tags, and
   * a landing URL back at the portal. Downstream consumers (open-data
   * aggregators, search crawlers, internal tooling) can crawl this to
   * discover what's shareable.
   *
   * The spec-strict DCAT feed (turtle / JSON-LD with full @context)
   * lands in #66: this is the Phase-1 JSON version, which is enough
   * for most aggregators that just want a list of URLs + metadata.
   */
  @Public()
  @Get('catalog.json')
  async catalog(@Req() req: Request, @Query('org') orgSlug?: string) {
    const org = orgSlug
      ? await this.prisma.organization.findUnique({ where: { slug: orgSlug } })
      : await this.resolveSingleOrg();
    if (!org) {
      throw new NotFoundException(
        orgSlug
          ? `No organization with slug "${orgSlug}"`
          : 'No organization configured on this portal yet',
      );
    }

    // Best-effort self URL for the catalog so clients can deref.
    // We honour X-Forwarded-* because portals are typically behind
    // a reverse proxy.
    const proto =
      (req.headers['x-forwarded-proto'] as string | undefined) ??
      req.protocol ??
      'http';
    const host =
      (req.headers['x-forwarded-host'] as string | undefined) ??
      req.headers.host ??
      'localhost';
    const portalBase = `${proto}://${host}`;

    const items = await this.prisma.item.findMany({
      where: {
        orgId: org.id,
        access: 'public',
        deletedAt: null,
      },
      select: {
        id: true,
        title: true,
        description: true,
        type: true,
        tags: true,
        license: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: { updatedAt: 'desc' },
    });

    return {
      '@context': 'https://project-open-data.cio.gov/v1.1/schema/catalog.jsonld',
      conformsTo: 'https://project-open-data.cio.gov/v1.1/schema',
      publisher: { name: org.name },
      dataset: items.map((it) => ({
        '@type': 'dcat:Dataset',
        identifier: it.id,
        title: it.title,
        description: it.description || it.title,
        keyword: it.tags ?? [],
        issued: it.createdAt.toISOString(),
        modified: it.updatedAt.toISOString(),
        landingPage: `${portalBase}/items/${it.id}`,
        // License is optional in v1; absent means "rights reserved".
        // Clients that want a discoverable open-data feed should
        // filter to items with a license set.
        ...(it.license ? { license: it.license } : {}),
        // Rough theme mapping from item type. Not standards-strict
        // but more useful than nothing for downstream facets.
        theme: [it.type],
      })),
    };
  }

  /**
   * Anonymous fetch of a single item by id (#307). Returns the
   * full item only when access='public' and the item isn't trashed;
   * otherwise 404 (deliberately indistinguishable from "no such id"
   * so the existence of a private item never leaks).
   *
   * The shape mirrors authenticated /api/items/:id so the viewer
   * runtime page can swap one for the other based on session
   * presence. Lean projection: shares list is stripped (anonymous
   * callers must not see a roster of who else has access).
   *
   * Anonymous viewer access composes: a publicly shared viewer
   * pulls the map item via this endpoint, then each layer item,
   * then the basemap item. Each must be access='public'
   * independently; we do not transitively grant access. This is
   * the same model AGOL uses (you must publicly share each
   * dependency for an anonymous link to render fully).
   */
  /**
   * Serve the vendored iD OSM preset catalog (#OSM).  Anonymous-
   * readable because the catalog itself is open data (the iD
   * tagging schema is ISC-licensed); the actual OSM features it
   * describes carry ODbL and our UI surfaces attribution
   * separately.  Long-cached because the catalog only changes
   * when an operator runs scripts/sync-osm-presets.mjs.
   */
  @Public()
  @Get('osm/presets')
  async osmPresets(@Res() res: Response) {
    const catalog = await loadOsmPresetCatalog();
    // 24h cache, immutable per-request body (the response only
    // changes after a sync + redeploy).  The browser-side OSM
    // picker requests with `cache: 'force-cache'` to coalesce
    // multiple recipe-editor opens into one download.
    res.setHeader('cache-control', 'public, max-age=86400, immutable');
    res.json(catalog);
  }

  @Public()
  @Get('items/:id')
  async item(@Param('id') id: string) {
    // Anonymous endpoint: malformed input must produce 404, not
    // a 500 leaked from Prisma's UUID parser. Prisma's
    // findFirst({ where: { id } }) throws PrismaClientKnownRequestError
    // when id isn't a valid UUID, which would expose the parser's
    // error message to anonymous callers. UUID-shape gate up front
    // returns the same NotFoundException as a UUID-valid miss so
    // existence (and even input validity) is uniform from the
    // attacker's perspective.
    if (!isUuidShape(id)) throw new NotFoundException('Item not found');
    const item = await this.prisma.item.findFirst({
      where: { id, access: 'public', deletedAt: null },
      include: {
        owner: {
          select: {
            id: true,
            username: true,
            fullName: true,
            avatarUrl: true,
          },
        },
      },
    });
    if (!item) throw new NotFoundException('Item not found');
    // Items with a thumbnailDesign (no static upload) get the
    // synthesized /api/portal/items/:id/thumbnail.svg URL so the
    // anon catalog renders the designer-baked thumbnail the same
    // way the authed item-detail page does. Without this, a
    // public web-app whose thumbnail was authored in the designer
    // came back with thumbnailUrl=null and the landing card fell
    // through to the generic type-icon tile.
    return synthesizeThumbnailUrl(item);
  }

  /**
   * Anonymous list of items, intended for the viewer runtime to
   * pull a list of public basemaps without a session. Limited to
   * type=basemap today; callers asking for any other type get an
   * empty list rather than the full public catalog (the dedicated
   * landing / catalog feeds are the right surface for that).
   *
   * Mirrors the authed list's paging contract so the runtime pages
   * can swap one for the other without branching: data_json is
   * stripped unless ?full=1, ?limit= / ?offset= page the result
   * (default 500, hard cap 1000), and X-Total-Count carries the
   * unpaged total. The body stays a plain JSON array.
   */
  @Public()
  @Get('items')
  async items(
    @Res({ passthrough: true }) res: Response,
    @Query('type') type?: string,
    @Query('full') full?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    if (type !== 'basemap') {
      // Keep the header present on the refusal path too so a pager
      // that trusts it never mistakes "not allowed" for "more pages".
      res.setHeader('X-Total-Count', '0');
      return [];
    }
    const where = {
      type: 'basemap',
      access: 'public',
      deletedAt: null,
    } as const;
    const parsedLimit = Number.parseInt(limit ?? '', 10);
    const take =
      Number.isFinite(parsedLimit) && parsedLimit > 0
        ? Math.min(parsedLimit, 1000)
        : 500;
    const parsedOffset = Number.parseInt(offset ?? '', 10);
    const skip =
      Number.isFinite(parsedOffset) && parsedOffset > 0 ? parsedOffset : 0;
    const wantFull = full === '1' || full === 'true';
    const [rows, total] = await Promise.all([
      this.prisma.item.findMany({
        where,
        // omit-not-select keeps the row shape identical to the old
        // response minus data_json, so anonymous consumers see the
        // exact same fields they always did.
        ...(wantFull ? {} : { omit: { data: true } }),
        include: {
          owner: {
            select: {
              id: true,
              username: true,
              fullName: true,
              avatarUrl: true,
            },
          },
        },
        orderBy: { updatedAt: 'desc' },
        take,
        ...(skip > 0 ? { skip } : {}),
      }),
      this.prisma.item.count({ where }),
    ]);
    res.setHeader('X-Total-Count', String(total));
    return rows;
  }

  /**
   * Anonymous feature collection for a layer of a public
   * data_layer item (#307). Mirrors the auth'd
   * /api/items/:id/layers/:layerId/features endpoint but gated to
   * `access='public'` items. Used by the viewer runtime when no
   * session is present.
   *
   * Supports the same bbox / at filters the auth'd path supports.
   *
   * Per-SHARE geographic restrictions (item_share.geoLimit) and
   * rowScope genuinely do not apply here: those hang off a share row
   * and an anonymous caller has none. The TIER boundary does apply,
   * though -- item.publicGeoBoundaryId (#80) exists precisely so a
   * public data_layer can be clipped for everyone on the internet,
   * and SharingService.geoLimitFor honours it on the auth'd path. A
   * previous version of this comment claimed no boundary concept
   * reached the public surface at all, and the missing clip meant
   * this mirror served the whole layer for an item the owner had
   * deliberately scoped to a region.
   */
  @Public()
  @Get('items/:id/layers/:layerId/features')
  async layerFeatures(
    @Param('id') itemId: string,
    @Param('layerId') layerId: string,
    @Query('bbox') bbox?: string,
    @Query('at') at?: string,
    // Single-feature lookup by stable entity id.  The MVT-popup
    // path on the auth'd surface (`features.controller.ts`) calls
    // /features?entity=<id> after a click to pull full attrs that
    // the tile doesn't carry; the public surface was silently
    // ignoring the param and falling back to a full layer scan.
    // For a 1.4M-feature layer (WV Parcels) that meant every
    // anonymous popup click stalled on a Loading… spinner for
    // 20-30s while the server materialised every parcel.
    @Query('entity') entity?: string,
    // Keyset pagination, mirroring the auth'd controller (#220). An
    // anonymous script reading a public layer needs a bounded read for
    // the same reason an authenticated one does, and leaving it off
    // here would mean the public surface is the unbounded one.
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    if (!isUuidShape(itemId)) throw new NotFoundException('Item not found');
    const item = await this.prisma.item.findFirst({
      where: {
        id: itemId,
        type: 'data_layer',
        access: 'public',
        deletedAt: null,
      },
      select: { id: true, ...PUBLIC_TIER_SELECT },
    });
    if (!item) throw new NotFoundException('Item not found');
    const opts: {
      bbox?: [number, number, number, number];
      at?: string;
      entity?: string;
      geoLimit?: unknown;
    } = {};
    const tierClip = await publicTierGeoLimit(
      this.prisma,
      item.publicGeoBoundaryId,
    );
    if (tierClip) opts.geoLimit = tierClip;
    if (bbox) {
      const parts = bbox.split(',').map(Number);
      if (parts.length === 4 && parts.every((n) => Number.isFinite(n))) {
        const [w, s, e, n] = parts as [number, number, number, number];
        opts.bbox = [w, s, e, n];
      }
    }
    if (at) opts.at = at;
    if (entity) opts.entity = entity;

    const paging = parsePagingParams(limit, cursor);
    if (paging !== null) {
      if (entity) {
        throw new BadRequestException(
          'Use either a single feature lookup or paging, not both.',
        );
      }
      const { entity: _ignored, ...pageOpts } = opts;
      const page = await this.v3.readFeaturePage(itemId, layerId, pageOpts, {
        pageSize: paging.pageSize,
        after: paging.after,
      });
      return {
        type: 'FeatureCollection' as const,
        features: page.features,
        nextCursor: page.nextCursor,
        asOf: page.asOf.toISOString(),
      };
    }
    return this.v3.listFeatures(itemId, layerId, opts);
  }

  /** Alias of /features under the same naming the auth'd v3
   *  controller exposes. Some callers ask for /geojson, others for
   *  /features; both return the same FeatureCollection. */
  @Public()
  @Get('items/:id/layers/:layerId/geojson')
  async layerGeojson(
    @Param('id') itemId: string,
    @Param('layerId') layerId: string,
    @Query('bbox') bbox?: string,
    @Query('at') at?: string,
    @Query('entity') entity?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.layerFeatures(itemId, layerId, bbox, at, entity, limit, cursor);
  }

  /**
   * Anonymous attribute search for a layer of a public data_layer
   * item. Mirrors the auth'd
   * /api/items/:id/layers/:layerId/features-search but gated to
   * `access='public'`.
   *
   * Why this is needed: the viewer / custom-app search widget builds
   * its request against the portal's native path, so an anonymous
   * visitor of a publicly-shared map hits this. Without it the search
   * 401s at the BFF and the widget shows "No matches" even though the
   * layer is marked searchable and the tiles + popups render fine
   * (those have public mirrors; this was the missing one). Returns the
   * same { results, truncated } shape the auth'd endpoint returns so
   * the client uses one parser either way.
   */
  @Public()
  @Get('items/:id/layers/:layerId/features-search')
  async layerFeaturesSearch(
    @Param('id') itemId: string,
    @Param('layerId') layerId: string,
    @Query('q') q?: string,
    @Query('fields') fields?: string,
    @Query('limit') limit?: string,
  ) {
    if (!isUuidShape(itemId)) throw new NotFoundException('Item not found');
    const item = await this.prisma.item.findFirst({
      where: {
        id: itemId,
        type: 'data_layer',
        access: 'public',
        deletedAt: null,
      },
      select: { id: true, data: true, ...PUBLIC_TIER_SELECT },
    });
    if (!item) throw new NotFoundException('Item not found');
    const layer = pickV3Layer(item.data, layerId);
    if (!layer) throw new NotFoundException('Layer not found');

    const text = (q ?? '').trim();
    if (text.length === 0) return { results: [], truncated: false };

    const opts: {
      q: string;
      fields?: string[];
      limit?: number;
      geoLimit?: unknown;
    } = { q: text };
    const tierClip = await publicTierGeoLimit(
      this.prisma,
      item.publicGeoBoundaryId,
    );
    if (tierClip) opts.geoLimit = tierClip;
    if (fields) {
      // Whitelist requested fields against the layer's public schema so
      // an arbitrary attribute key can't be probed via attrs->>'..'.
      const allowed = new Set(layer.fields.map((f) => f.name));
      const wanted = fields
        .split(',')
        .map((f) => f.trim())
        .filter((f) => f.length > 0 && allowed.has(f));
      if (wanted.length > 0) opts.fields = wanted;
    }
    if (limit) {
      const n = Number(limit);
      if (Number.isFinite(n) && n > 0) {
        opts.limit = Math.min(Math.max(Math.floor(n), 1), 50);
      }
    }
    return this.v3.searchFeatures(itemId, layerId, opts);
  }

  /**
   * Anonymous MVT tile for a layer of a public data_layer item.
   * Mirrors the auth'd /api/items/:id/layers/:layerId/tile/:z/:x/:y
   * .mvt endpoint but gated to `access='public'`.
   *
   * Why this is needed alongside the OGC Tiles endpoint at
   * /api/public/ogc/collections/:id/tiles/WebMercatorQuad/...:
   * the Custom Web App runtime builds its source URLs from the
   * portal's native path (it doesn't know the OGC URL shape), so
   * an anonymous viewer of a public app fetches tiles at the
   * portal path and would 401 at the BFF without this. Both
   * endpoints route through the same DataLayerFeaturesService.
   * mvtTile call -- the OGC controller adds the OGC envelope; this
   * one adds the portal's URL shape.
   */
  @Public()
  @Get('items/:id/layers/:layerId/tile/:z/:x/:y.mvt')
  async layerTile(
    @Req() req: Request,
    @Res() res: Response,
    @Param('id') itemId: string,
    @Param('layerId') layerId: string,
    @Param('z') zStr: string,
    @Param('x') xStr: string,
    @Param('y') yStr: string,
  ) {
    if (!isUuidShape(itemId)) {
      throw new NotFoundException('Item not found');
    }
    const item = await this.prisma.item.findFirst({
      where: {
        id: itemId,
        type: 'data_layer',
        access: 'public',
        deletedAt: null,
      },
      select: { id: true, data: true, ...PUBLIC_TIER_SELECT },
    });
    if (!item) throw new NotFoundException('Item not found');

    // Confirm the layer exists in the item's v3 schema; this also
    // lets us project the field set into the tile so labels +
    // popups + filters have feature properties at render time
    // (matches the auth'd tile's #147 behavior).
    const layer = pickV3Layer(item.data, layerId);
    if (!layer) throw new NotFoundException('Layer not found');

    const z = Number(zStr);
    const x = Number(xStr);
    const y = Number(yStr);
    if (
      !Number.isInteger(z) ||
      !Number.isInteger(x) ||
      !Number.isInteger(y) ||
      z < 0 ||
      z > 24 ||
      x < 0 ||
      y < 0
    ) {
      throw new BadRequestException('Invalid tile coordinates.');
    }

    const opts: {
      fields?: Array<{ name: string; type?: string }>;
      isTable?: boolean;
      geoLimit?: unknown;
    } = {};
    if (layer.fields.length > 0) opts.fields = layer.fields;
    if (layer.geometryType === null) opts.isTable = true;
    // Safe against the tile cache: optsFingerprint() already hashes
    // geoLimit into the cache key, so a clipped tile stores under its
    // own slot rather than overwriting the unclipped one.
    const tierClip = await publicTierGeoLimit(
      this.prisma,
      item.publicGeoBoundaryId,
    );
    if (tierClip) opts.geoLimit = tierClip;

    let mvt: Buffer;
    let etag: string;
    try {
      ({ mvt, etag } = await this.v3.mvtTile(itemId, layerId, z, x, y, opts));
    } catch (e) {
      if (e instanceof TileCacheOverloadError) {
        res.setHeader('Retry-After', String(tileOverloadRetryAfterSeconds()));
        res.setHeader('Cache-Control', 'no-store');
        res.status(503).end();
        return;
      }
      throw e;
    }
    if (matchesIfNoneMatch(req.headers['if-none-match'], etag)) {
      res.setHeader('ETag', etag);
      res.setHeader('Cache-Control', 'public, max-age=300');
      res.status(304).end();
      return;
    }
    res.setHeader('Content-Type', 'application/vnd.mapbox-vector-tile');
    res.setHeader('ETag', etag);
    // Public tiles can sit in shared caches; same posture as the
    // OGC tile endpoint (5-min public window).
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.end(mvt);
  }

  /**
   * Resolve the org for single-tenant portals where the query param
   * is unnecessary. Orders by createdAt so the original seed wins;
   * additional orgs (if any) can still be reached by explicit slug.
   */
  private async resolveSingleOrg() {
    const orgs = await this.prisma.organization.findMany({
      orderBy: { createdAt: 'asc' },
      take: 1,
    });
    return orgs[0] ?? null;
  }

  /**
   * Public items in the org, featured ones first. Lean projection
   * stripped of anything that would leak share lists or tag clouds
   * an admin didn't mean to publish.
   */
  private async publicItemsFor(orgId: string, featuredIds: string[]) {
    const rows = await this.prisma.item.findMany({
      where: {
        orgId,
        access: 'public',
        deletedAt: null,
      },
      select: {
        id: true,
        title: true,
        description: true,
        type: true,
        thumbnailUrl: true,
        // Designer-baked thumbnail JSON. Rows without a static
        // thumbnailUrl run through synthesizeThumbnailUrl below
        // to get the /thumbnail.svg cache-busted URL so the
        // landing tile shows the same baked card the authed
        // items list shows.
        thumbnailDesign: true,
        updatedAt: true,
        tags: true,
        // Open-data license URL when the item carries one. Used
        // by the landing's Schema.org Dataset JSON-LD (Google Rich
        // Results flags Datasets without a license as a missing
        // recommended field, and aggregators like data.gov filter
        // their crawls to license-bearing rows).
        license: true,
        // Include the data payload so the landing tile can route a
        // templated web_app (editor / viewer) straight to its
        // runtime URL. Without `data`, getItemHref / isViewerItem
        // can't read the `template` discriminator and falls through
        // to /items/:id, which middleware then redirects to sign-in
        // for anonymous visitors. The payload is already public-by-
        // construction (we only emit access='public' rows) and the
        // data shape across the supported types is small.
        data: true,
      },
      orderBy: { updatedAt: 'desc' },
    });
    const all = rows.map((r) => synthesizeThumbnailUrl(r));
    if (featuredIds.length === 0) return all;

    // Featured = strict filter when it resolves to anything: when the
    // admin curates a list, the landing shows ONLY those items, in
    // the admin's chosen order. Items no longer public (or moved to
    // trash) drop out silently. If the admin wants the full public
    // catalog they leave the featured list empty, which falls through
    // to the "all public items, newest first" branch above.
    const byId = new Map(all.map((i) => [i.id, i]));
    const featured = featuredIds
      .map((id) => byId.get(id))
      .filter((i): i is NonNullable<typeof i> => !!i);
    // Safety net: if EVERY featured id is stale (none resolve to a
    // live public item) but public items DO exist, fall back to the
    // full catalog rather than rendering a blank "nothing shared
    // publicly" page. A curated list pinned to ids that later get
    // re-created with fresh ids (every demo re-seed does this) would
    // otherwise silently hide real public content. Featuring is a
    // presentation preference; it must never suppress the catalog
    // entirely when the underlying items are gone.
    if (featured.length === 0) return all;
    return featured;
  }
}

/**
 * Cheap UUID-shape gate for anonymous endpoints. Returns true if
 * the input matches the canonical 8-4-4-4-12 hex pattern (any
 * version). We don't validate the version bits because Prisma
 * will accept anything that parses as a UUID; this gate is a
 * 500-to-404 safety net, not a correctness check. Used by
 * PublicController and PublicProxyController so a stray
 * non-UUID path segment from a crawler or typo returns a clean
 * 404 instead of leaking Prisma's parser error message.
 */
export function isUuidShape(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    id,
  );
}

interface V3LayerInfo {
  geometryType: string | null;
  fields: Array<{ name: string; type?: string }>;
}

/**
 * Resolve a layer key inside a v3 data_layer item's `data` blob.
 * Returns the layer's geometry type + field schema so the tile
 * controller can decide table-mode + project the right fields
 * into the MVT. Returns null when the layer doesn't exist or the
 * item isn't v3 -- callers should 404.
 */
function pickV3Layer(data: unknown, layerId: string): V3LayerInfo | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as {
    version?: number;
    layers?: Array<{
      id?: unknown;
      geometryType?: unknown;
      fields?: Array<{ name?: unknown; type?: unknown }>;
    }>;
  };
  if (d.version !== 3 || !Array.isArray(d.layers)) return null;
  const match = d.layers.find((l) => l?.id === layerId);
  if (!match) return null;
  const geometryType =
    typeof match.geometryType === 'string' ? match.geometryType : null;
  const fields: Array<{ name: string; type?: string }> = [];
  if (Array.isArray(match.fields)) {
    for (const f of match.fields) {
      if (
        f &&
        typeof f.name === 'string' &&
        f.name.length > 0
      ) {
        fields.push({
          name: f.name,
          ...(typeof f.type === 'string' ? { type: f.type } : {}),
        });
      }
    }
  }
  return { geometryType, fields };
}
