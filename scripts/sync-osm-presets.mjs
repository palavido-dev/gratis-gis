// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Sync the iD tagging schema (the OSM preset catalog the official
 * web editor uses) into GratisGIS's internal format.
 *
 * Source:  https://github.com/openstreetmap/id-tagging-schema
 * Licence: ISC (preset JSON itself) + ODbL (the OSM data the
 *          presets describe)
 *
 * Output: apps/portal-web/content/osm/preset-catalog.json
 *
 * Run on demand:
 *   node scripts/sync-osm-presets.mjs
 *   (defaults to the pinned upstream release below; override with
 *   --tag=vX.Y.Z, and bump PINNED_REF when adopting a new release)
 *
 * The output is committed to the repo so the runtime doesn't need
 * network access to load the catalog.  Re-run periodically to pick
 * up upstream additions.
 *
 * Internal entry shape:
 *   {
 *     id:          'amenity_fuel',           // dot/slash -> underscore
 *     label:       'Gas station',            // human display label
 *     category:    'amenity',                // top-level OSM key
 *     icon:        'fuel',                   // maki / temaki id (lowercased)
 *     tags:        [{ key, value }, ...],    // ANDed tag conditions
 *     geometries:  ['node', 'way', 'rel'],   // which OSM primitives
 *     description: 'Vehicle fuel filling…',  // optional
 *     terms:       ['gas', 'petrol', ...]    // optional aliases for search
 *   }
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const OUTPUT_PATH = resolve(
  REPO_ROOT,
  'apps',
  'portal-web',
  'content',
  'osm',
  'preset-catalog.json',
);

// Pinned upstream release tag so syncs are reproducible instead of
// tracking whatever `main` happens to be. Bump deliberately, review
// the diff, commit the regenerated catalog. --tag=vX.Y.Z overrides
// for a one-off run.
const PINNED_REF = 'v7.0.1';
const args = process.argv.slice(2);
const tagFlag = args.find((a) => a.startsWith('--tag='));
const ref = tagFlag ? tagFlag.split('=')[1] : PINNED_REF;

const PRESETS_URL = `https://raw.githubusercontent.com/openstreetmap/id-tagging-schema/${ref}/dist/presets.min.json`;
const TRANSLATIONS_URL = `https://raw.githubusercontent.com/openstreetmap/id-tagging-schema/${ref}/dist/translations/en.min.json`;

function safeId(rawKey) {
  // Upstream keys look like 'amenity/restaurant' or
  // 'amenity/cafe' or 'natural/water/lake'.  We keep the full path
  // (so 'natural/water/lake' and 'natural/water/pond' stay distinct)
  // but replace '/' with '_' so the id reads as a single token in
  // our codebase.
  return rawKey.replace(/[\/.]/g, '_');
}

function topCategory(rawKey) {
  const slash = rawKey.indexOf('/');
  return slash >= 0 ? rawKey.slice(0, slash) : rawKey;
}

function normaliseIcon(icon) {
  if (typeof icon !== 'string') return null;
  // iD uses 'maki-fuel', 'temaki-water_tower', 'fas-anchor'.  We
  // strip the family prefix and keep the leaf identifier so our
  // own UI can map it to a glyph.
  const stripped = icon.replace(/^(maki|temaki|fas|far|iD)-/, '');
  return stripped.toLowerCase();
}

function tagsObjectToArray(tagsObj) {
  if (!tagsObj || typeof tagsObj !== 'object') return [];
  const out = [];
  for (const [key, value] of Object.entries(tagsObj)) {
    if (typeof value !== 'string') continue;
    // The wildcard "*" means "any value for this key"; emit it as a
    // separate entry the QL builder turns into `["key"]` (presence
    // check) rather than `["key"="*"]` (literal equals).
    out.push({ key, value });
  }
  return out;
}

function normaliseGeometry(geomList) {
  if (!Array.isArray(geomList)) return ['node', 'way', 'relation'];
  const out = [];
  for (const g of geomList) {
    if (g === 'point') out.push('node');
    else if (g === 'line') out.push('way');
    else if (g === 'area') {
      out.push('way');
      out.push('relation');
    } else if (g === 'relation') out.push('relation');
    else if (g === 'vertex') out.push('node');
  }
  // De-dup but keep order.
  return Array.from(new Set(out));
}

async function fetchJson(url) {
  console.log(`fetching ${url}`);
  const res = await fetch(url, {
    headers: { 'user-agent': 'gratis-gis-osm-preset-sync/0.1' },
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching ${url}`);
  }
  return res.json();
}

async function main() {
  const presets = await fetchJson(PRESETS_URL);
  let translations = {};
  try {
    translations = await fetchJson(TRANSLATIONS_URL);
  } catch (err) {
    console.warn(
      `translations fetch failed; falling back to preset.name strings (${err.message})`,
    );
  }

  // iD's en.json wraps under a top-level 'en' key whose value carries
  // 'presets/presets/<key>'.name (and .description, .terms).  Some
  // upstream builds drop the top wrapper; tolerate both.
  const translationRoot =
    (translations.en && translations.en.presets && translations.en.presets.presets) ||
    (translations.presets && translations.presets.presets) ||
    {};

  const entries = [];
  for (const [rawKey, preset] of Object.entries(presets)) {
    if (typeof preset !== 'object' || preset === null) continue;
    // Skip iD's "namespace shells" -- presets keyed at the top level
    // (e.g. 'amenity') that have no own tags, just children.  These
    // aren't useful in the runtime picker.
    if (!preset.tags || Object.keys(preset.tags).length === 0) continue;
    // Skip deprecated / search-only entries.
    if (preset.searchable === false && preset.matchScore === undefined) continue;

    const id = safeId(rawKey);
    const category = topCategory(rawKey);

    // Translations carry the human name + description + alias terms.
    const t = translationRoot[rawKey] ?? {};
    const label = (t.name || preset.name || id).toString();
    const description = t.description ? String(t.description) : undefined;
    let terms = t.terms;
    if (typeof terms === 'string') terms = terms.split(',').map((s) => s.trim());
    if (!Array.isArray(terms)) terms = undefined;

    const tags = tagsObjectToArray(preset.tags);
    if (tags.length === 0) continue;
    const geometries = normaliseGeometry(preset.geometry);
    const icon = normaliseIcon(preset.icon);

    entries.push({
      id,
      label,
      category,
      ...(icon ? { icon } : {}),
      tags,
      geometries,
      ...(description ? { description } : {}),
      ...(terms && terms.length > 0 ? { terms } : {}),
    });
  }

  // Sort by (category, label) so the catalog is diff-stable across
  // upstream re-orderings.
  entries.sort((a, b) =>
    a.category === b.category
      ? a.label.localeCompare(b.label)
      : a.category.localeCompare(b.category),
  );

  const out = {
    source: {
      repo: 'openstreetmap/id-tagging-schema',
      // Upstream preset JSON is ISC; the OSM data the presets
      // describe is ODbL. See THIRD_PARTY_NOTICES.md.
      license: 'ISC',
      ref,
      generatedAt: new Date().toISOString(),
      generatorVersion: 1,
    },
    presets: entries,
  };

  await mkdir(dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, JSON.stringify(out, null, 2) + '\n', 'utf8');
  console.log(`wrote ${entries.length} presets to ${OUTPUT_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
