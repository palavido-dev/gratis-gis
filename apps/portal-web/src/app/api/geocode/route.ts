// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Geocoder proxy. The browser hits `/api/geocode?q=...` and this route
 * forwards to the Nominatim instance configured by NOMINATIM_URL
 * (defaults to the docker-compose service at localhost:8081), or to
 * an open-geocode server when OPEN_GEOCODE_URL is set. Either way the
 * answer is Nominatim jsonv2 rows.
 *
 * Why proxy instead of letting the browser call Nominatim directly:
 *   1. One env var swaps local / staging / prod endpoints.
 *   2. The public Nominatim endpoint requires a specific User-Agent
 *      header, which browsers won't let JS override. Forwarding from
 *      Node lets us set it properly.
 *   3. Future-proofs us to add rate limiting, caching, or metering
 *      without touching the client.
 *
 * Auth: a valid session is required. Anonymous callers get a 401: we
 * don't want this endpoint doubling as a free geocoder for the world.
 */
import { getServerSession } from 'next-auth';
import { NextRequest, NextResponse } from 'next/server';
import { authOptions } from '@/lib/auth';
import { hasUsableSession } from '@/lib/session-state';
import { nominatimTarget } from '@/lib/nominatim-config';
import { activeOpenGeocodeUrl, toNominatimRows } from '@/lib/open-geocode';

const USER_AGENT =
  'GratisGIS/0.1 (https://github.com/palavido-dev/gratis-gis)';
const PUBLIC_NOMINATIM = 'https://nominatim.openstreetmap.org';

async function askOpenGeocode(
  base: string,
  endpoint: 'autocomplete' | 'geocode',
  q: string,
): Promise<Response> {
  const params = new URLSearchParams({ q, limit: '5' });
  return fetch(`${base}/${endpoint}?${params}`, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
    cache: 'no-store',
  });
}

/**
 * Ask the configured open-geocode server. No public fallback: an
 * operator who set OPEN_GEOCODE_URL chose to keep searches on it.
 *
 * `autocomplete` is for search-as-you-type: open-geocode then matches
 * the last word as a prefix ("223 Merch" finds 223 Merchants Walk),
 * which its full geocoder does not. When autocomplete finds nothing,
 * the full geocoder gets the same text, so a complete address with a
 * typo still has a chance.
 */
async function searchOpenGeocode(
  base: string,
  q: string,
  autocomplete: boolean,
): Promise<NextResponse> {
  try {
    if (autocomplete) {
      const res = await askOpenGeocode(base, 'autocomplete', q);
      if (res.ok) {
        const rows = toNominatimRows(await res.json());
        if (rows.length > 0) return NextResponse.json(rows, { status: 200 });
      }
    }
    const res = await askOpenGeocode(base, 'geocode', q);
    if (!res.ok) {
      return NextResponse.json(
        { message: `open-geocode ${res.status}` },
        { status: 502 },
      );
    }
    return NextResponse.json(toNominatimRows(await res.json()), { status: 200 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Geocoder unreachable';
    return NextResponse.json({ message: msg }, { status: 502 });
  }
}

async function searchNominatim(base: string, params: URLSearchParams): Promise<Response> {
  return fetch(`${base.replace(/\/$/, '')}/search?${params}`, {
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(10_000),
    cache: 'no-store',
  });
}

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  // Same rule as the BFF: a session whose refresh failed or that hit
  // the idle timeout is signed out.
  if (!hasUsableSession(session)) {
    return NextResponse.json({ message: 'Unauthorized' }, { status: 401 });
  }

  const q = req.nextUrl.searchParams.get('q')?.trim() ?? '';
  if (q.length < 3) {
    return NextResponse.json([], { status: 200 });
  }

  const og = await activeOpenGeocodeUrl();
  if (og) {
    return searchOpenGeocode(
      og,
      q,
      req.nextUrl.searchParams.get('autocomplete') === '1',
    );
  }

  const params = new URLSearchParams({
    format: 'jsonv2',
    addressdetails: '1',
    limit: '5',
    q,
  });
  // A portal that never stood up its own Nominatim still needs
  // address search. When the configured geocoder is the local
  // default and it does not answer, ask the public Nominatim
  // service once. Set NOMINATIM_PUBLIC_FALLBACK=0 to keep queries
  // on the configured host only.
  const { url: nominatimUrl, allowPublic, localDefault } = nominatimTarget();

  try {
    let res = await searchNominatim(nominatimUrl, params);
    if (!res.ok && allowPublic && localDefault) {
      res = await searchNominatim(PUBLIC_NOMINATIM, params);
    }
    if (!res.ok) {
      return NextResponse.json(
        { message: `Nominatim ${res.status}` },
        { status: 502 },
      );
    }
    const body = await res.arrayBuffer();
    return new NextResponse(body, {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  } catch (err) {
    if (allowPublic && localDefault) {
      try {
        const res = await searchNominatim(PUBLIC_NOMINATIM, params);
        if (res.ok) {
          const body = await res.arrayBuffer();
          return new NextResponse(body, {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
      } catch {
        /* fall through to the error below */
      }
    }
    const msg = err instanceof Error ? err.message : 'Geocoder unreachable';
    return NextResponse.json({ message: msg }, { status: 502 });
  }
}
