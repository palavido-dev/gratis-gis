// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Portal-api proxy. The browser hits /api/portal/<rest> and this route
 * forwards the request to portal-api with the current user's Keycloak
 * access token attached server-side. Keeps the JWT off the client while
 * giving interactive pages a simple fetch-to-relative-URL story.
 *
 * Only verbs we currently use are wired; add more as needed.
 */
import { getServerSession } from 'next-auth';
import { NextRequest, NextResponse } from 'next/server';
import { revalidatePath } from 'next/cache';
import { authOptions, type SessionWithToken } from '@/lib/auth';

const API_BASE = process.env.PORTAL_API_URL ?? 'http://localhost:4000';

/**
 * Long-running upstream dispatcher for ingest, per-layer import,
 * and whole-layer export routes. Default undici fetch() caps the
 * response-headers wait at 30 s, which is plenty for an admin click
 * but nowhere near long enough for a county-scale parcel ingest
 * (GDAL parse + bulk insert) or a GeoParquet export of the same
 * layer (the api walks every feature before the first response
 * byte). We use a dedicated Agent so normal API calls keep their
 * tight defaults: only requests routed here get the loosened
 * budget.
 *
 * Both the import AND the constructor are deferred to the first
 * matching hit. A static `import { Agent } from 'undici'` loads
 * undici's Agent module at evaluation time, and that module body
 * references `util.markAsUncloneable`, a Node 22+ builtin that
 * doesn't exist on the older Node our build container runs.
 * Next.js's "Collect page data" phase evaluates every route module,
 * so the build crashed even though we never instantiated the Agent.
 * Dynamic import keeps undici entirely out of build-time
 * evaluation.
 */
let _longRunningAgent: unknown = null;
async function getLongRunningAgent(): Promise<unknown> {
  if (!_longRunningAgent) {
    const { Agent } = await import('undici');
    _longRunningAgent = new Agent({
      headersTimeout: 15 * 60 * 1000,
      bodyTimeout: 15 * 60 * 1000,
      connectTimeout: 30 * 1000,
    });
  }
  return _longRunningAgent;
}

/** Match v3 per-layer ingest, v2 ingest, the wizard probe path, and
 *  the per-layer GeoParquet export. Conservative: only widens for
 *  endpoints we know can take minutes. */
function isLongRunningPath(suffix: string): boolean {
  return (/^items\/[^/]+\/layers\/[^/]+\/import$/.test(suffix) ||
  /^items\/[^/]+\/layers\/[^/]+\/geoparquet$/.test(suffix) ||
  /^items\/[^/]+\/ingest$/.test(suffix) || suffix === 'ingest/probe');
}

/**
 * Anonymous-fallback rewrites for #307. When the caller has no
 * session, GETs to a small allowlist of paths get forwarded
 * without an auth header. portal-api enforces access='public' on
 * each underlying endpoint, so anonymous calls to these paths are
 * safe; everything else still 401s.
 *
 * Two flavors:
 *   - Rewrite to `/api/public/...`: portal-api has a separate
 *     read-only public controller for that surface
 *     (items, layers/geojson, layers/features, items/:id/proxy).
 *   - Pass through unchanged: portal-api's controller is marked
 *     `@Public()` and branches on whether `@CurrentUser()` is
 *     null. The storage endpoint at `storage/private/:kind/:key`
 *     works this way (see storage.controller.ts getPrivateAsset).
 *     Returning the suffix unchanged signals "allowed anonymous,
 *     no rewrite needed."
 *
 * Allowlist:
 *   - items/:id                          -> public/items/:id
 *   - items/:id/layers/:layer/geojson    -> public/items/:id/layers/:layer/geojson
 *   - items/:id/layers/:layer/features   -> public/items/:id/layers/:layer/features
 *   - items/:id/layers/:layer/features-search
 *                                        -> public/items/:id/layers/:layer/features-search
 *   - items/:id/layers/:layer/tile/:z/:x/:y.mvt
 *                                        -> public/items/:id/layers/:layer/tile/:z/:x/:y.mvt
 *   - items/:id/proxy/...                -> public/items/:id/proxy/...
 *   - items/:id/thumbnail.svg            -> items/:id/thumbnail.svg (passthrough)
 *   - storage/private/:kind/:key         -> storage/private/:kind/:key (passthrough)
 *
 * Anything else (item lists, dependents lookups, write verbs)
 * stays auth-gated. Lists are deliberately not in the allowlist
 * because /api/public/items?type=basemap is a tiny custom surface
 * and the ?type=basemap parameter pattern doesn't generalize to
 * the rest of the items list contract.
 */
function publicRewriteForAnonymousGet(suffix: string): string | null {
  if (/^items\/[^/]+$/.test(suffix)) {
    return `public/${suffix}`;
  }
  if (
    /^items\/[^/]+\/layers\/[^/]+\/(geojson|features|features-search)$/.test(
      suffix,
    )
  ) {
    return `public/${suffix}`;
  }
  // MVT tile path for v3 data_layer items. The custom + viewer
  // runtimes build their MapLibre source URLs against the portal's
  // native /tile/:z/:x/:y.mvt shape (they don't know about OGC
  // Tiles), so an anon viewer of a publicly-shared app fetches
  // tiles here. portal-api mirrors the auth'd route as
  // /api/public/items/:id/layers/:layerId/tile/:z/:x/:y.mvt gated
  // on access='public'. Symptom this fixes: WV Parcels (1.4M
  // polygons) failed to draw for anon visitors -- the runtime
  // requested tiles at z=11 and got 401 at the BFF, never reaching
  // portal-api. The county boundaries + flood services rendered
  // fine in the same view because they use the items/:id/proxy/
  // path (already in the allowlist below).
  if (
    /^items\/[^/]+\/layers\/[^/]+\/tile\/\d+\/\d+\/\d+\.mvt$/.test(suffix)
  ) {
    return `public/${suffix}`;
  }
  // Designer-baked thumbnail SVG. Public landing tiles + anon
  // catalog cards point their <img src> at this endpoint via
  // synthesizeThumbnailUrl. portal-api's thumbnail route is now
  // @Public() and branches on @CurrentUser() (full ACL when
  // signed in, access='public' fast path when anon), so the BFF
  // forwards the suffix unchanged rather than rewriting to
  // /public/items/.../thumbnail.svg. Same passthrough pattern as
  // the storage entry below.
  if (/^items\/[^/]+\/thumbnail\.svg$/.test(suffix)) {
    return suffix;
  }
  // #154 Drawings list on a public map. portal-api's GET
  // /api/items/:mapId/drawings is @Public() and gates anon reads
  // to access='public' inside the service. Anonymous viewers
  // load this from the markup panel; without the BFF passthrough
  // the panel would 401 before reaching portal-api. Passthrough
  // rather than rewrite because portal-api hosts a single route
  // that branches on the optional bearer token.
  if (/^items\/[^/]+\/drawings$/.test(suffix)) {
    return suffix;
  }
  // #155 Threaded comments list on a public item. Same pattern
  // as drawings above: the GET route is @Public() and the
  // service gates non-public reads against canRead.
  if (/^items\/[^/]+\/comments$/.test(suffix)) {
    return suffix;
  }
  // Anonymous service-proxy passthrough: a public viewer that
  // references an external service (ArcGIS / WMS / WFS / WMTS)
  // hits /items/:id/proxy/<sub-path>?... at runtime to fetch
  // tiles or features. The matching public endpoint is gated on
  // access='public' and injects stored credentials server-side
  // before forwarding upstream, so the credential never leaves
  // the server. See public-proxy.controller.ts.
  if (/^items\/[^/]+\/proxy(\/.*)?$/.test(suffix)) {
    return `public/${suffix}`;
  }
  // OSM preset catalog (#OSM).  The recipe editor + runtime
  // panel fetch this from the browser on first render so users
  // can pick OSM presets at design / run time.  Catalog is the
  // ISC-licensed iD tagging schema -- open data, anon-safe to
  // serve.  Passthrough rather than rewrite because portal-api
  // already mounts the route at /api/public/osm/presets to match
  // the prefix every client uses.
  if (suffix === 'public/osm/presets') {
    return suffix;
  }
  // Anonymous file-item / attachment fetch. A publicly-shared
  // web-app embedding a logo or a file-item points its <img src>
  // at /api/portal/storage/private/<kind>/<key>. portal-api's
  // storage controller is @Public() and falls back to an
  // access='public' check on the parent item when no Bearer
  // token is present. The BFF was still 401-ing those requests
  // before this allowlist entry landed, which is why the WV
  // Parcel Viewer logo kept "going missing" after every
  // backend-only fix (9e3f624 + df663fd patched portal-api but
  // not the BFF). Passthrough: the portal-api route is the same
  // for anon and authed; no /public/storage/ controller exists
  // because we don't need one.
  if (
    /^storage\/private\/(item-file|item-tile-layer|item-point-cloud|feature-attachment)\/[A-Za-z0-9._-]+$/.test(
      suffix,
    )
  ) {
    return suffix;
  }
  // #179 point-cloud range proxy. A public map with a point cloud
  // layer streams octree nodes from /point-cloud/:itemId/file with
  // Range headers. portal-api's route is @Public() and branches on
  // the optional bearer token (full item ACL when signed in,
  // access='public' resolution when anon), so this is a
  // passthrough, same pattern as the storage entry above.
  if (/^point-cloud\/[^/]+\/file(\.copc\.laz)?$/.test(suffix)) {
    return suffix;
  }
  // #185 tile-layer range proxy. A public map with an imagery
  // overlay layer range-reads /tile-layer/:itemId/file the same
  // way; portal-api's route is @Public() with the same dual ACL
  // path, so passthrough again.
  if (/^tile-layer\/[^/]+\/file$/.test(suffix)) {
    return suffix;
  }
  return null;
}

/**
 * Anonymous-POST allowlist (#146). The /feedback endpoint on
 * portal-api is decorated @Public() and is meant for any visitor
 * (including unauthenticated public-test-instance testers) to
 * leave a comment without needing a GitHub account or a portal
 * sign-in. The BFF normally 401s unauthenticated non-GET
 * requests; this allowlist makes specific POST paths fall
 * through unauthenticated so portal-api's own @Public()
 * decorator can take over.
 *
 * Keep this list TINY. Every entry is a public attack surface.
 * Each path needs:
 *   - portal-api side: @Public() decorator AND rate limit AND
 *     honeypot or equivalent bot defense.
 *   - portal-web side: explicit regex below, no parameters in
 *     the path that could be smuggled into a different handler.
 */
function isAnonymousPostAllowed(suffix: string): boolean {
  if (suffix === 'feedback') return true;
  // Tool-run for publicly-shared Custom Web Apps embedding an OSM
  // tool. portal-api's POST /api/tools/:id/run is @Public() and
  // refuses any tool item whose access != 'public' (and any output
  // sink that would touch private data layers, see
  // recipe-runner.service.ts). The BFF allowlist entry is the gate
  // that lets the request reach portal-api in the first place;
  // without it the BFF 401s anonymous POSTs and the embedded tool
  // appears broken to every signed-out visitor.
  //
  // Strict path shape: `tools/<uuid>/run` with no query smuggling.
  // The 8-4-4-4-12 hex pattern is the same gate isUuidShape() uses
  // server-side; defense-in-depth against a stray non-UUID segment
  // reaching the tool runner.
  if (
    /^tools\/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\/run$/.test(
      suffix,
    )
  ) {
    return true;
  }
  return false;
}

async function forward(req: NextRequest, pathSegments: string[]) {
  // Per-hop timing log behind the BFF_TIMING flag. Lets us split a
  // slow page load into "cookie + getServerSession" vs "upstream
  // fetch to portal-api" vs "body shaping". With ~24 items in the
  // dev DB, none of those should take more than tens of ms; if the
  // log shows a 20s+ value on any hop, that's where the time is.
  const trace = process.env.BFF_TIMING === '1';
  const t0 = trace ? Date.now() : 0;

  const session = (await getServerSession(authOptions)) as SessionWithToken | null;
  const tSession = trace ? Date.now() : 0;

  const suffix = pathSegments.join('/');
  const qs = req.nextUrl.search;

  // #307: when an anonymous visitor opens a publicly-shared viewer,
  // the runtime makes client-side fetches for layer features and
  // map item metadata. Without a session we'd 401 here; instead,
  // for a small allowlist of GET paths we rewrite to the public
  // surface and forward without auth. portal-api enforces
  // access='public' on those endpoints.
  const publicRewrite =
    !session?.accessToken && req.method === 'GET'
      ? publicRewriteForAnonymousGet(suffix)
      : null;

  // #146: tiny allowlist for anonymous POSTs (currently just
  // /feedback). portal-api has @Public() on the matching route
  // and rate-limits per IP + honeypot internally.
  const allowAnonymousPost =
    !session?.accessToken &&
    req.method === 'POST' &&
    isAnonymousPostAllowed(suffix);

  if (!session?.accessToken && !publicRewrite && !allowAnonymousPost) {
    return NextResponse.json({ message: 'Unauthorized' }, { status: 401 });
  }

  const effectiveSuffix = publicRewrite ?? suffix;
  const target = `${API_BASE}/api/${effectiveSuffix}${qs}`;

  // Preserve the full Content-Type header. Multipart uploads carry a
  // boundary in the value (e.g. `multipart/form-data; boundary=----x`)
  // and strip-to-"application/json" corrupts them.
  const headers: Record<string, string> = {};
  if (session?.accessToken) {
    headers.authorization = `Bearer ${session.accessToken}`;
  }
  const ct = req.headers.get('content-type');
  if (ct) headers['content-type'] = ct;
  // Editor runtime sends `x-editor-id` on every write so the API can
  // apply the Editor item's per-target policy as a defense-in-depth
  // gate over the existing data_layer share-edit check. Forward it
  // through the BFF unchanged. Custom headers are namespaced under
  // x-* so we keep the allowlist explicit rather than blanket-
  // forwarding everything.
  const editorId = req.headers.get('x-editor-id');
  if (editorId) headers['x-editor-id'] = editorId;
  // Field deployment runtime sends `x-data-collection-id` on every
  // write so the API can fire the data_collection_feature_created
  // notification (#229). Same allowlist pattern as x-editor-id.
  const dataCollectionId = req.headers.get('x-data-collection-id');
  if (dataCollectionId) headers['x-data-collection-id'] = dataCollectionId;
  // Forward X-Forwarded-For so portal-api can see the real client
  // IP (Caddy puts it on the incoming request; without this hop
  // portal-api would see portal-web's container IP, which is
  // useless for per-IP rate limiting on public endpoints like
  // /feedback, #146).
  const xff = req.headers.get('x-forwarded-for');
  if (xff) headers['x-forwarded-for'] = xff;
  // Forward Range so byte-serving endpoints work through the BFF.
  // The pmtiles / cog protocol plugins and the COPC reader (#179)
  // issue many small ranged reads against /tile-layer/:id/file,
  // /point-cloud/:id/file, and /storage/private/...; without this
  // header the upstream returns 200 with the ENTIRE multi-GB file
  // for every nibble the client asked for. If-Range rides along so
  // a replaced file invalidates cleanly rather than serving mixed
  // halves.
  const range = req.headers.get('range');
  if (range) headers.range = range;
  const ifRange = req.headers.get('if-range');
  if (ifRange) headers['if-range'] = ifRange;

  // Stream-forward the request body instead of buffering the full
  // payload into a single ArrayBuffer. Buffering blew up on large
  // ingest uploads (a 200 MB shapefile would allocate 200 MB in the
  // BFF and another 200 MB in fetch's internal copy before sending,
  // sometimes oom-ing portal-web). Streaming keeps memory flat.
  // `duplex: 'half'` is required by undici/fetch when the request
  // body is a ReadableStream; without it Node throws "RequestInit:
  // duplex option is required when sending a body".
  const init: RequestInit & { duplex?: 'half'; dispatcher?: unknown } = {
    method: req.method,
    headers,
    cache: 'no-store',
  };
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    init.body = req.body;
    init.duplex = 'half';
  }

  // Forward client aborts upstream. Without this, when the browser
  // cancels its request the BFF still waits for portal-api to
  // finish (and portal-api still holds a Prisma connection). On a
  // slow page-revisit pattern that means each abandoned request
  // serialises behind the previous one's still-running query.
  init.signal = req.signal;

  // Long-running ingest / export endpoints get a custom dispatcher
  // with 15 min headers + body timeouts. Everything else falls
  // through to the built-in 30 s defaults so a misbehaving upstream
  // still fails fast.
  if (isLongRunningPath(suffix)) {
    init.dispatcher = await getLongRunningAgent();
  }

  const upstream = await fetch(target, init);
  const tUpstream = trace ? Date.now() : 0;
  // Stream-pass the response body so the browser receives bytes the
  // moment portal-api flushes them. The previous arrayBuffer() round-
  // trip buffered the entire body before forwarding, which is fatal
  // for NDJSON streams (#103 per-batch ingest progress) -- the client
  // would never see progress events until the entire ingest
  // completed. Stream-pass also drops a redundant memory copy of
  // every download from portal-api through the BFF.
  //
  // We forward Content-Type unchanged (NDJSON / event-stream /
  // application/json all flow through). Transfer-Encoding is decided
  // by Next.js based on the body type; a ReadableStream becomes
  // chunked transfer automatically.
  if (trace) {
    // eslint-disable-next-line no-console
    console.log(
      `[bff] ${req.method} /api/${suffix}${qs} ` +
        `session=${tSession - t0}ms upstream=${tUpstream - tSession}ms ` +
        `(streaming through)`,
    );
  }
  // Bust the Next.js Router Cache for the items list (and the
  // specific item detail page when present) after any successful
  // mutating call on an `items/...` path.  Without this, a thumbnail
  // / title edit only shows up in /items after the 30s default cache
  // window expires; users edit, navigate back, and stare at a stale
  // card thinking nothing happened.
  //
  // Cheap and best-effort: revalidatePath only invalidates the
  // server-side render cache; subsequent navigations re-render the
  // page server-side from a fresh apiFetch (which is already
  // `cache: 'no-store'`).
  if (
    upstream.ok &&
    (req.method === 'POST' ||
      req.method === 'PATCH' ||
      req.method === 'PUT' ||
      req.method === 'DELETE') &&
    /^items(\/|$)/.test(suffix)
  ) {
    revalidatePath('/items');
    const idMatch = /^items\/([^/]+)/.exec(suffix);
    if (idMatch?.[1]) {
      revalidatePath(`/items/${idMatch[1]}`);
      revalidatePath(`/items/${idMatch[1]}/edit`);
    }
  }
  return new NextResponse(upstream.body, {
    status: upstream.status,
    headers: {
      'content-type':
        upstream.headers.get('content-type') ?? 'application/json',
      // No-cache + no-transform mirrors what portal-api set on the
      // streaming response, so an intermediate Caddy or browser
      // cache doesn't try to coalesce the chunks.
      ...(upstream.headers.get('cache-control')
        ? { 'cache-control': upstream.headers.get('cache-control')! }
        : {}),
      // Download endpoints (layer CSV / GeoParquet exports) mark
      // themselves `attachment; filename=...`; without forwarding
      // this the browser loses the server-chosen filename and
      // save-as behavior.
      ...(upstream.headers.get('content-disposition')
        ? {
            'content-disposition': upstream.headers.get(
              'content-disposition',
            )!,
          }
        : {}),
      // Byte-serving headers for ranged reads (see the Range
      // forwarding note on the request side). Status is already
      // mirrored, so a 206 arrives as a 206; without Content-Range
      // the client cannot place the slice, and without ETag /
      // Accept-Ranges the reader disables range mode entirely.
      ...(upstream.headers.get('content-range')
        ? { 'content-range': upstream.headers.get('content-range')! }
        : {}),
      ...(upstream.headers.get('accept-ranges')
        ? { 'accept-ranges': upstream.headers.get('accept-ranges')! }
        : {}),
      ...(upstream.headers.get('etag')
        ? { etag: upstream.headers.get('etag')! }
        : {}),
      ...(upstream.headers.get('content-length')
        ? { 'content-length': upstream.headers.get('content-length')! }
        : {}),
    },
  });
}

// Next 15 changed Route Handler params from a sync object to a
// Promise.  We await it on the way in; the rest of the file is
// unchanged.  Sync-shape backward-compat is gone in 15+, so this
// is mandatory for build, not a deprecation warning.
type RouteCtx = { params: Promise<{ path: string[] }> };

export async function GET(req: NextRequest, ctx: RouteCtx) {
  const { path } = await ctx.params;
  return forward(req, path);
}
export async function POST(req: NextRequest, ctx: RouteCtx) {
  const { path } = await ctx.params;
  return forward(req, path);
}
export async function PUT(req: NextRequest, ctx: RouteCtx) {
  const { path } = await ctx.params;
  return forward(req, path);
}
export async function PATCH(req: NextRequest, ctx: RouteCtx) {
  const { path } = await ctx.params;
  return forward(req, path);
}
export async function DELETE(req: NextRequest, ctx: RouteCtx) {
  const { path } = await ctx.params;
  return forward(req, path);
}
