// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Map address search through a self-hosted open-geocode server
 * (https://github.com/open-geocode-rs/open-geocode).
 *
 * When OPEN_GEOCODE_URL is set, /api/geocode asks that server instead
 * of Nominatim and reshapes its answers into the Nominatim jsonv2 rows
 * the map, field app and custom apps already read. Nothing on the
 * client changes.
 */

/** The fields of a Nominatim jsonv2 row that portal clients read. */
export interface NominatimLikeRow {
  display_name: string;
  lat: string;
  lon: string;
  /** Nominatim order: south, north, west, east. */
  boundingbox: [string, string, string, string];
  class: string;
  type: string;
}

/** The configured server's base URL, or null when OPEN_GEOCODE_URL is unset or not http(s). */
export function openGeocodeUrl(
  env: Record<string, string | undefined> = process.env,
): string | null {
  const raw = env.OPEN_GEOCODE_URL?.trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  return raw.replace(/\/+$/, '');
}

interface OgFeature {
  geometry?: { coordinates?: unknown };
  bbox?: unknown;
  properties?: {
    label?: unknown;
    address_lines?: unknown;
    layer?: unknown;
    accuracy?: unknown;
    bbox?: unknown;
  };
}

/**
 * Reshape an open-geocode GET /geocode answer into Nominatim rows.
 *
 * `class` carries open-geocode's layer (address, street, locality, ...)
 * and `type` its accuracy (rooftop, interpolated, street, ...), so the
 * search list's "class · type" subtitle tells the user how precise
 * each match is.
 */
export function toNominatimRows(body: unknown): NominatimLikeRow[] {
  const features = (body as { features?: unknown } | null)?.features;
  if (!Array.isArray(features)) return [];
  const rows: NominatimLikeRow[] = [];
  for (const raw of features as OgFeature[]) {
    const coords = raw?.geometry?.coordinates;
    if (!Array.isArray(coords) || coords.length < 2) continue;
    const lon = Number(coords[0]);
    const lat = Number(coords[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const props = raw.properties ?? {};
    const lines = Array.isArray(props.address_lines)
      ? props.address_lines.filter((l): l is string => typeof l === 'string')
      : [];
    const label =
      lines.length > 0
        ? lines.join(', ')
        : typeof props.label === 'string'
          ? props.label
          : `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
    const box = readBbox(raw.bbox) ?? readBbox(props.bbox);
    const [w, s, e, n] = box ?? [lon, lat, lon, lat];
    rows.push({
      display_name: label,
      lat: String(lat),
      lon: String(lon),
      boundingbox: [String(s), String(n), String(w), String(e)],
      class: typeof props.layer === 'string' ? props.layer : 'place',
      type: typeof props.accuracy === 'string' ? props.accuracy : '',
    });
  }
  return rows;
}

/** A GeoJSON-order [west, south, east, north] box, or null. */
function readBbox(raw: unknown): [number, number, number, number] | null {
  if (!Array.isArray(raw) || raw.length !== 4) return null;
  const nums = raw.map(Number);
  if (nums.some((v) => !Number.isFinite(v))) return null;
  const [w, s, e, n] = nums as [number, number, number, number];
  if (w > e || s > n) return null;
  return [w, s, e, n];
}
