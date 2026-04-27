/**
 * Feature-extent probe for ArcGIS REST services (#94).
 *
 * Calling `/{layerId}/query?returnExtentOnly=true&where=1=1` is the
 * cheapest way to get the actual feature footprint without pulling
 * any rows. The service-level `fullExtent` field is unreliable: many
 * publishers leave it as the layer's spatial-reference envelope
 * (which is often the whole world), so an item.bbox derived from it
 * makes the area filter useless.
 *
 * Used by the housekeeping recompute pass and any future "probe
 * extents on item save" hook. Pure HTTP + JSON; honors the same
 * credential payload shape the proxy controller uses so secured
 * services work without a separate auth path.
 */
import type { CredentialPayload } from './credential.service.js';

export interface ProbeOptions {
  /** Per-call timeout in ms; default 8000 to keep batch passes
   *  bounded even when an upstream is slow. */
  timeoutMs?: number;
  /** Logger sink for warn-level messages so the caller controls
   *  where probe failures land. Optional. */
  warn?: (message: string) => void;
}

/**
 * Aggregate feature extents across `layerIds` of a service. Returns
 * a [w,s,e,n] envelope in EPSG:4326 or null when no layer yields a
 * usable extent. A failed probe on a single layer is non-fatal --
 * we log and continue so one broken sublayer doesn't black out the
 * whole service's bbox.
 *
 * outSR=4326 is requested in the query, so most modern services
 * project the response server-side. Older services that ignore
 * outSR will return native coordinates; we detect that with a
 * simple sanity check and discard.
 */
export async function probeArcgisExtent(
  serviceUrl: string,
  layerIds: number[],
  credential: CredentialPayload | null,
  opts: ProbeOptions = {},
): Promise<[number, number, number, number] | null> {
  if (layerIds.length === 0) return null;
  const timeoutMs = opts.timeoutMs ?? 8000;
  const warn = opts.warn ?? (() => {});

  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  let any = false;

  for (const layerId of layerIds) {
    let extent: { xmin: number; ymin: number; xmax: number; ymax: number } | null;
    try {
      extent = await fetchLayerExtent(serviceUrl, layerId, credential, timeoutMs);
    } catch (err) {
      warn(
        `extent probe failed for ${serviceUrl} layer ${layerId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      continue;
    }
    if (!extent) continue;
    // Sanity check: if the upstream ignored outSR=4326 and returned
    // Web Mercator coordinates, the values would be in millions of
    // meters and would corrupt the aggregate. WGS84 lon/lat caps at
    // ±180 / ±90; values noticeably outside that mean we got native
    // SR back and shouldn't trust them.
    if (
      Math.abs(extent.xmin) > 200 ||
      Math.abs(extent.xmax) > 200 ||
      Math.abs(extent.ymin) > 100 ||
      Math.abs(extent.ymax) > 100
    ) {
      warn(
        `extent probe for ${serviceUrl} layer ${layerId} returned non-WGS84 coords; skipping`,
      );
      continue;
    }
    w = Math.min(w, extent.xmin);
    s = Math.min(s, extent.ymin);
    e = Math.max(e, extent.xmax);
    n = Math.max(n, extent.ymax);
    any = true;
  }
  return any ? [w, s, e, n] : null;
}

async function fetchLayerExtent(
  serviceUrl: string,
  layerId: number,
  credential: CredentialPayload | null,
  timeoutMs: number,
): Promise<{
  xmin: number;
  ymin: number;
  xmax: number;
  ymax: number;
} | null> {
  // returnExtentOnly is the cheapest extent fetch the REST API
  // supports. f=json (not geojson) because returnExtentOnly's
  // response is `{ extent: { ... } }` shaped, which the geojson
  // converter doesn't recognise. outSR=4326 asks the upstream to
  // project to WGS84 so we don't need a client-side reprojection.
  const url = new URL(
    `${serviceUrl.replace(/\/$/, '')}/${layerId}/query`,
  );
  url.searchParams.set('where', '1=1');
  url.searchParams.set('returnExtentOnly', 'true');
  url.searchParams.set('returnCountOnly', 'false');
  url.searchParams.set('outSR', '4326');
  url.searchParams.set('f', 'json');
  if (credential?.kind === 'arcgis_token') {
    url.searchParams.set('token', credential.token);
  }
  const headers: Record<string, string> = { accept: 'application/json' };
  if (credential?.kind === 'bearer') {
    headers.authorization = `Bearer ${credential.token}`;
  } else if (credential?.kind === 'basic') {
    const encoded = Buffer.from(
      `${credential.username}:${credential.password}`,
      'utf8',
    ).toString('base64');
    headers.authorization = `Basic ${encoded}`;
  }
  // Per-call timeout via AbortController so a hung upstream can't
  // stall the whole recompute pass.
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  let res: globalThis.Response;
  try {
    res = await fetch(url.toString(), {
      method: 'GET',
      headers,
      signal: ctl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  const body = (await res.json()) as {
    extent?: {
      xmin?: unknown;
      ymin?: unknown;
      xmax?: unknown;
      ymax?: unknown;
    };
    error?: { code?: number; message?: string };
  };
  // Esri returns its error envelope with HTTP 200; check explicitly.
  if (body.error) {
    throw new Error(
      `ArcGIS error ${body.error.code ?? ''}: ${body.error.message ?? 'unknown'}`.trim(),
    );
  }
  const ex = body.extent;
  if (
    !ex ||
    typeof ex.xmin !== 'number' ||
    typeof ex.ymin !== 'number' ||
    typeof ex.xmax !== 'number' ||
    typeof ex.ymax !== 'number' ||
    !Number.isFinite(ex.xmin) ||
    !Number.isFinite(ex.ymin) ||
    !Number.isFinite(ex.xmax) ||
    !Number.isFinite(ex.ymax)
  ) {
    return null;
  }
  return { xmin: ex.xmin, ymin: ex.ymin, xmax: ex.xmax, ymax: ex.ymax };
}
