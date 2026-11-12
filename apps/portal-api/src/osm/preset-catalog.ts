// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync } from 'node:fs';
import { BadRequestException } from '@nestjs/common';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Backend access to the vendored iD tagging schema preset catalog
 * (#OSM).  Loaded from apps/portal-web/content/osm/preset-catalog.json
 * (shared with the web tier so the same catalog drives both Overpass
 * QL construction here and the runtime picker UI on the web side).
 *
 * Loaded once on first access and cached in memory for the lifetime
 * of the process.  The catalog is ~1MB; pre-loading it once means
 * the per-query QL build does pure map lookups.
 */

export interface OsmPresetTag {
  key: string;
  value: string;
}

export interface OsmPreset {
  id: string;
  label: string;
  category: string;
  icon?: string;
  tags: OsmPresetTag[];
  geometries: Array<'node' | 'way' | 'relation'>;
  description?: string;
  terms?: string[];
}

export interface OsmPresetCatalog {
  source: {
    repo: string;
    ref: string;
    generatedAt: string;
    generatorVersion: number;
  };
  presets: OsmPreset[];
}

let cached: OsmPresetCatalog | null = null;
let cachedById: Map<string, OsmPreset> | null = null;

/**
 * Resolve the catalog file across both dev and standalone production
 * builds, mirroring the pattern used by the help-content + whats-new
 * loaders.  Portal-api runs out of apps/portal-api in dev and from
 * /app in the Docker image, but the catalog lives under portal-web's
 * content/ directory in both cases.
 */
function resolveCatalogPath(): string {
  const candidates = [
    // Monorepo dev: portal-api cwd is apps/portal-api; walk to the
    // sibling portal-web content tree.
    path.resolve(
      process.cwd(),
      '..',
      'portal-web',
      'content',
      'osm',
      'preset-catalog.json',
    ),
    // Standalone Docker: cwd is /app and the traced files live at
    // /app/apps/portal-web/content/osm/preset-catalog.json.
    path.resolve(
      process.cwd(),
      'apps',
      'portal-web',
      'content',
      'osm',
      'preset-catalog.json',
    ),
    // Direct override via env var for unusual deployments.
    process.env.GRATIS_GIS_OSM_PRESET_CATALOG_PATH ?? '',
  ].filter(Boolean);

  for (const c of candidates) {
    try {
      if (existsSync(c)) return c;
    } catch {
      /* ignore */
    }
  }
  // Fall back to the dev path; the loader will fail on read and
  // surface a clear error message.
  return candidates[0]!;
}

export async function loadOsmPresetCatalog(): Promise<OsmPresetCatalog> {
  if (cached) return cached;
  const filePath = resolveCatalogPath();
  const raw = await readFile(filePath, 'utf8');
  const parsed = JSON.parse(raw) as OsmPresetCatalog;
  if (!parsed || !Array.isArray(parsed.presets)) {
    throw new Error(
      `OSM preset catalog at ${filePath} is missing the expected 'presets' array`,
    );
  }
  cached = parsed;
  cachedById = new Map(parsed.presets.map((p) => [p.id, p]));
  return parsed;
}

/**
 * Look up a single preset by id.  Throws when the id is unknown so
 * the QL builder fails fast on a misconfigured recipe rather than
 * silently emitting an empty query.
 */
export async function getOsmPreset(id: string): Promise<OsmPreset> {
  if (!cached) await loadOsmPresetCatalog();
  const preset = cachedById?.get(id);
  if (!preset) {
    throw new BadRequestException(`Unknown OSM preset id: ${id}`);
  }
  return preset;
}

/**
 * Bulk lookup; throws if any id is unknown.  Caller-friendly when
 * the QL builder needs every preset in one go.
 */
export async function getOsmPresets(ids: string[]): Promise<OsmPreset[]> {
  if (!cached) await loadOsmPresetCatalog();
  const out: OsmPreset[] = [];
  const missing: string[] = [];
  for (const id of ids) {
    const p = cachedById?.get(id);
    if (p) out.push(p);
    else missing.push(id);
  }
  if (missing.length > 0) {
    // A caller's mistake, not a server fault: 400, not 500.
    throw new BadRequestException(`Unknown OSM preset ids: ${missing.join(', ')}`);
  }
  return out;
}

/**
 * Reset the in-process cache.  Test-only; callers in prod should
 * never call this.  Exported so the unit tests that exercise the
 * catalog can hand-roll a fixture without colliding with a
 * previously-loaded real catalog.
 */
export function __resetCacheForTests(): void {
  cached = null;
  cachedById = null;
}

/** Test-only: install a hand-crafted catalog in place of the real
 *  one.  Bypasses the file read so unit tests don't depend on the
 *  vendored JSON existing in the test environment. */
export function __setCacheForTests(catalog: OsmPresetCatalog): void {
  cached = catalog;
  cachedById = new Map(catalog.presets.map((p) => [p.id, p]));
}
