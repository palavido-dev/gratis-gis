// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Geocoder proxy. The browser hits `/api/geocode?q=...` and this route
 * forwards to the Nominatim instance configured by NOMINATIM_URL
 * (defaults to the docker-compose service at localhost:8081).
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

const NOMINATIM_URL = process.env.NOMINATIM_URL ?? 'http://localhost:8081';
const USER_AGENT =
  'GratisGIS/0.1 (https://github.com/palavido-dev/gratis-gis)';
const PUBLIC_NOMINATIM = 'https://nominatim.openstreetmap.org';

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
  if (!session) {
    return NextResponse.json({ message: 'Unauthorized' }, { status: 401 });
  }

  const q = req.nextUrl.searchParams.get('q')?.trim() ?? '';
  if (q.length < 3) {
    return NextResponse.json([], { status: 200 });
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
  const allowPublic = process.env.NOMINATIM_PUBLIC_FALLBACK !== '0';
  const localDefault = !process.env.NOMINATIM_URL;

  try {
    let res = await searchNominatim(NOMINATIM_URL, params);
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
