// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';

/**
 * Loader for the bundled Randolph County sample datasets (#147).
 * The files live at apps/portal-api/content/samples/randolph/ and are
 * committed to the repo so the "Load sample data" seed never needs a
 * network fetch (air-gap safe by design; see
 * docs/handoff/sample-content-manifest.md).
 *
 * Loaded once per process and cached; the payload is a few tens of
 * kilobytes so keeping it resident is cheaper than re-reading and
 * re-validating on every org's seed run.
 */

export interface SampleFeature {
  /** Stable per-feature slug from the GeoJSON `id` (sample-fac-01
   *  etc.). The seeder derives each feature's entity UUID from this
   *  so re-runs address the same rows. */
  id: string;
  properties: Record<string, unknown>;
  geometry: Record<string, unknown>;
}

export interface SampleSubmission {
  /** Idempotency key: formSubmission is unique on (formId, clientId). */
  clientId: string;
  capturedAt: string;
  /** Keyed by question id, in the form runtime's native answer
   *  shapes (geopoint answers are `{ lat, lng }`). */
  response: Record<string, unknown>;
}

export interface SampleAssets {
  facilities: SampleFeature[];
  trails: SampleFeature[];
  parks: SampleFeature[];
  parcels: SampleFeature[];
  boundary: SampleFeature[];
  submissions: SampleSubmission[];
}

/**
 * Resolve the bundled sample-content directory across dev and
 * production layouts. Mirrors the OSM preset catalog's resolver
 * (src/osm/preset-catalog.ts): try each cwd-relative candidate, fall
 * back to the first so the read error names a concrete path.
 */
function resolveSamplesDir(): string {
  const candidates = [
    // Monorepo dev: portal-api's cwd is apps/portal-api.
    path.resolve(process.cwd(), 'content', 'samples', 'randolph'),
    // Docker runtime: cwd is /app; the image also carries a copy at
    // /app/apps/portal-api/content (see apps/portal-api/Dockerfile).
    path.resolve(
      process.cwd(),
      'apps',
      'portal-api',
      'content',
      'samples',
      'randolph',
    ),
    // Direct override for unusual deployments.
    process.env.GRATIS_GIS_SAMPLE_CONTENT_PATH ?? '',
  ].filter(Boolean);

  for (const c of candidates) {
    try {
      if (existsSync(c)) return c;
    } catch {
      /* ignore and try the next candidate */
    }
  }
  return candidates[0]!;
}

/**
 * Parse one bundled GeoJSON file into SampleFeature[]. Throws on any
 * malformed entry: the assets are compiled into the repo, so a shape
 * problem is a build defect that should fail the seed loudly rather
 * than plant a half-broken sample workspace.
 */
function parseFeatureCollection(
  raw: string,
  filePath: string,
): SampleFeature[] {
  const parsed = JSON.parse(raw) as { features?: unknown };
  if (!parsed || !Array.isArray(parsed.features)) {
    throw new Error(
      `Sample asset ${filePath} is missing the expected 'features' array`,
    );
  }
  return parsed.features.map((f, i) => {
    const feat = f as {
      id?: unknown;
      properties?: unknown;
      geometry?: unknown;
    };
    if (typeof feat.id !== 'string' || feat.id.length === 0) {
      throw new Error(
        `Sample asset ${filePath} feature[${i}] has no string 'id'`,
      );
    }
    if (!feat.properties || typeof feat.properties !== 'object') {
      throw new Error(
        `Sample asset ${filePath} feature[${i}] has no 'properties' object`,
      );
    }
    if (
      !feat.geometry ||
      typeof feat.geometry !== 'object' ||
      typeof (feat.geometry as { type?: unknown }).type !== 'string'
    ) {
      throw new Error(
        `Sample asset ${filePath} feature[${i}] has no GeoJSON 'geometry'`,
      );
    }
    return {
      id: feat.id,
      properties: feat.properties as Record<string, unknown>,
      geometry: feat.geometry as Record<string, unknown>,
    };
  });
}

function parseSubmissions(raw: string, filePath: string): SampleSubmission[] {
  const parsed = JSON.parse(raw) as { submissions?: unknown };
  if (!parsed || !Array.isArray(parsed.submissions)) {
    throw new Error(
      `Sample asset ${filePath} is missing the expected 'submissions' array`,
    );
  }
  return parsed.submissions.map((s, i) => {
    const sub = s as {
      clientId?: unknown;
      capturedAt?: unknown;
      response?: unknown;
    };
    if (typeof sub.clientId !== 'string' || sub.clientId.length === 0) {
      throw new Error(
        `Sample asset ${filePath} submissions[${i}] has no string 'clientId'`,
      );
    }
    if (
      typeof sub.capturedAt !== 'string' ||
      Number.isNaN(new Date(sub.capturedAt).getTime())
    ) {
      throw new Error(
        `Sample asset ${filePath} submissions[${i}] has no ISO 'capturedAt'`,
      );
    }
    if (!sub.response || typeof sub.response !== 'object') {
      throw new Error(
        `Sample asset ${filePath} submissions[${i}] has no 'response' object`,
      );
    }
    return {
      clientId: sub.clientId,
      capturedAt: sub.capturedAt,
      response: sub.response as Record<string, unknown>,
    };
  });
}

let cached: SampleAssets | null = null;

export async function loadSampleAssets(): Promise<SampleAssets> {
  if (cached) return cached;
  const dir = resolveSamplesDir();
  const read = async (name: string): Promise<{ raw: string; file: string }> => {
    const file = path.join(dir, name);
    return { raw: await readFile(file, 'utf8'), file };
  };
  // Parcels ship gzipped: the full-resolution county cadastre is ~38 MB
  // of GeoJSON, which compresses to ~12 MB for the repo and image. The
  // geometry is never simplified (parcel edges must stay crisp), so we
  // trade a one-time gunzip at seed time for a much smaller committed
  // asset.
  const readGz = async (
    name: string,
  ): Promise<{ raw: string; file: string }> => {
    const file = path.join(dir, name);
    return { raw: gunzipSync(await readFile(file)).toString('utf8'), file };
  };
  const [facilities, trails, parks, parcels, boundary, submissions] =
    await Promise.all([
      read('facilities.geojson'),
      read('trails.geojson'),
      read('parks.geojson'),
      readGz('parcels.geojson.gz'),
      read('county-boundary.geojson'),
      read('submissions.json'),
    ]);
  cached = {
    facilities: parseFeatureCollection(facilities.raw, facilities.file),
    trails: parseFeatureCollection(trails.raw, trails.file),
    parks: parseFeatureCollection(parks.raw, parks.file),
    parcels: parseFeatureCollection(parcels.raw, parcels.file),
    boundary: parseFeatureCollection(boundary.raw, boundary.file),
    submissions: parseSubmissions(submissions.raw, submissions.file),
  };
  return cached;
}

/** Test-only: drop the in-process cache so a spec can re-read from
 *  disk (or observe a fresh parse) without process isolation. */
export function __resetSampleAssetsCacheForTests(): void {
  cached = null;
}
