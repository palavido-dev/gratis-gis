// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Bundle export (#109): pack a v3 data_layer's features + related
 * tables + feature attachments into a single ZIP archive the user
 * can hand to a client or open in Excel.
 *
 * Why client-side: the alternative was a server-side ZIP-streaming
 * endpoint + async job queue (the design tracked in
 * docs/handoff/reference/bundle-export-notes.md).  For a typical
 * municipal-scale data_layer (a few thousand parcels + attachments)
 * the in-browser path fits comfortably in memory, reuses the
 * existing layer-export writer + JSZip dep, and avoids a new server
 * surface entirely.  When users start hitting the 50k-feature /
 * 10GB-of-photos case we'll lift this server-side; until then,
 * client-side is the right call.
 *
 * ZIP layout (matches Matt's existing Pro/VertiGIS convention so
 * downstream scripts pattern-match without retraining):
 *
 *   <layer name>/
 *     data.xlsx                 (one sheet per layer, parent first,
 *                                related tables after; FK columns
 *                                preserved verbatim so the user can
 *                                re-join in Excel)
 *     attachments/
 *       <prefix>_ATT<id>_<original>.jpg
 *       ...
 *
 * `<prefix>` is the value of a configurable layer field when the
 * caller sets `attachmentPrefixField`; otherwise it's the feature's
 * global id (truncated to a sensible length).
 *
 * Progress is reported through an optional onProgress callback so
 * the UI can render "Building data.xlsx", "Fetching attachments
 * 23 / 412", etc.  Cancellation is a TODO -- a long export today
 * runs to completion or the user closes the tab.
 */

import { ZipWriter } from './zip-writer';
import { writeXlsx, type XlsxSheet } from './xlsx';
import { parseApiError } from './api-error';
import { fetchRetrying } from './request-pool';

export interface BundleExportOptions {
  /** Root data_layer item id. */
  itemId: string;
  /** Top-level sublayer to export.  Related tables are discovered
   *  by walking childLayerIds on this layer's schema. */
  layerKey: string;
  /** Optional layer schema (pulled from the item's data blob) so
   *  related tables can be enumerated without an extra round-trip.
   *  When omitted the bundle exports just the parent layer. */
  layers?: BundleSublayer[];
  /** Filename root for the downloaded ZIP.  Sanitized before use. */
  filename: string;
  /** When true, include related-table sheets in the workbook
   *  (recursively if a child has its own children). */
  includeRelatedTables: boolean;
  /** When true, fetch + bundle every attachment for every feature
   *  on every included layer.  Massively increases bundle size for
   *  layers with photos; off by default for that reason. */
  includeAttachments: boolean;
  /**
   * Optional pre-filter applied to the parent layer's features
   * (related tables follow whatever rows reference a surviving
   * parent via the FK column).  Use cases:
   *   - 'selection'-style: pass `featureIdsAllowlist` with the
   *     selected feature ids
   *   - 'visible'-style: pass `bbox` and let the helper drop
   *     features whose geometry doesn't intersect
   * Omit both for "include every parent feature" (the default).
   */
  featureIdsAllowlist?: ReadonlySet<string>;
  bbox?: [number, number, number, number];
  /**
   * Optional attribute name whose value will prefix attachment
   * filenames.  When omitted, the global id is used.  Matches the
   * naming convention Matt's Pro tool uses so emails to clients
   * read the same as before.
   */
  attachmentPrefixField?: string;
  /**
   * Optional second field name; when set, attachments split into
   * subfolders by that field's value.  Falls back to a flat
   * attachments/ folder when unset.  Mirrors the Pro tool's
   * "Organize by attribute" option.
   */
  attachmentSplitField?: string;
  /** Progress callback for the UI. */
  onProgress?: (msg: string) => void;
}

export interface BundleSublayer {
  /** Sublayer id (matches the layer's `id` in v3 data_layer data). */
  id: string;
  /** Author-facing label, used as the sheet name + folder names. */
  label: string;
  /** PostGIS-style stable name (used in filenames where label has
   *  spaces). */
  name: string;
  /** Field list for column ordering. */
  fields?: Array<{ name: string; label?: string }>;
  /** When set, this is a related table whose rows reference the
   *  parent by `id`. */
  parentLayerId?: string;
  /** Column on this related table holding the parent's global id.
   *  When absent the cascade falls back to "any string property
   *  equal to a surviving parent id". */
  parentFkColumn?: string;
}

interface BundleFeature {
  id?: string;
  geometry?: unknown;
  properties?: Record<string, unknown> | null;
}

interface AttachmentRow {
  id: string;
  fileName: string;
  mime: string;
  sizeBytes: number;
  storageUrl: string;
}

/** Features per page when reading a layer. */
const FEATURE_PAGE_LIMIT = 5_000;

/**
 * Pull every feature of one layer via the existing API, a keyset
 * page at a time. The unpaged read can be switched off per install
 * (GRATIS_FEATURE_QUERY_PAGE=required), which failed every bundle
 * export there, so this pages the way offline-download does: `limit`
 * plus `cursor`, with the first page's `asOf` sent back as `at` so
 * every page reads the same snapshot. Accepts both shapes the
 * endpoint returns: a bare array and a `{ features }` envelope.
 */
async function fetchLayerFeatures(
  itemId: string,
  layerKey: string,
): Promise<BundleFeature[]> {
  const base = `/api/portal/items/${encodeURIComponent(itemId)}/layers/${encodeURIComponent(layerKey)}/features`;
  const out: BundleFeature[] = [];
  let cursor: string | undefined;
  let at: string | undefined;
  const seen = new Set<string>();
  for (;;) {
    const qs = new URLSearchParams({ limit: String(FEATURE_PAGE_LIMIT) });
    if (cursor) qs.set('cursor', cursor);
    if (at) qs.set('at', at);
    const res = await fetchRetrying(`${base}?${qs.toString()}`, {
      cache: 'no-store',
    });
    if (!res.ok) {
      throw new Error(
        await parseApiError(res, 'Layer features fetch failed'),
      );
    }
    const body = (await res.json()) as
      | BundleFeature[]
      | { features?: BundleFeature[]; nextCursor?: unknown; asOf?: unknown };
    if (Array.isArray(body)) {
      out.push(...body);
      break;
    }
    out.push(...(body.features ?? []));
    if (!at && typeof body.asOf === 'string') at = body.asOf;
    const next = typeof body.nextCursor === 'string' ? body.nextCursor : null;
    // A repeated cursor would loop forever; treat it as the end.
    if (!next || seen.has(next)) break;
    seen.add(next);
    cursor = next;
  }
  return out;
}

/**
 * Every attachment on one layer, by feature id, in one request
 * (`?all=1`). It used to be one request per feature, which ran into
 * the API's 300 a minute limit on a layer of a few hundred features;
 * the 429s then read as "no attachments" and the ZIP came out short
 * with no warning. A failure here now throws, so the export stops
 * instead of quietly leaving the photos out.
 */
async function fetchLayerAttachments(
  itemId: string,
  layerKey: string,
): Promise<Map<string, AttachmentRow[]>> {
  const res = await fetchRetrying(
    `/api/portal/items/${encodeURIComponent(itemId)}/layers/${encodeURIComponent(layerKey)}/attachments?all=1`,
    { cache: 'no-store' },
  );
  if (!res.ok) {
    throw new Error(
      await parseApiError(res, 'Attachment list fetch failed'),
    );
  }
  const groups = (await res.json()) as Array<{
    featureId: string;
    attachments: AttachmentRow[];
  }>;
  const out = new Map<string, AttachmentRow[]>();
  for (const g of Array.isArray(groups) ? groups : []) {
    if (g && typeof g.featureId === 'string' && Array.isArray(g.attachments)) {
      out.set(g.featureId, g.attachments);
    }
  }
  return out;
}

/**
 * Coarse bbox-intersect test for a GeoJSON geometry.  We compute
 * the geometry's own bbox by walking coordinates, then check
 * overlap with the supplied bbox.  Skips features whose geometry
 * is missing / unparseable (they're treated as "out of scope" --
 * a geometryless feature in a viewport-scoped export is the wrong
 * answer either way).
 */
function geometryIntersectsBbox(
  g: unknown,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
): boolean {
  if (!g || typeof g !== 'object') return false;
  let gMinX = Infinity;
  let gMinY = Infinity;
  let gMaxX = -Infinity;
  let gMaxY = -Infinity;
  function visit(coords: unknown): void {
    if (!coords || !Array.isArray(coords)) return;
    if (typeof coords[0] === 'number' && typeof coords[1] === 'number') {
      const x = coords[0] as number;
      const y = coords[1] as number;
      if (x < gMinX) gMinX = x;
      if (y < gMinY) gMinY = y;
      if (x > gMaxX) gMaxX = x;
      if (y > gMaxY) gMaxY = y;
      return;
    }
    for (const child of coords) visit(child);
  }
  const geom = g as { coordinates?: unknown; geometries?: unknown };
  if (Array.isArray(geom.geometries)) {
    for (const inner of geom.geometries) {
      const innerG = inner as { coordinates?: unknown };
      if (innerG.coordinates) visit(innerG.coordinates);
    }
  } else if (geom.coordinates) {
    visit(geom.coordinates);
  }
  if (gMinX === Infinity) return false;
  return !(gMaxX < minX || gMinX > maxX || gMaxY < minY || gMinY > maxY);
}

/** Sanitize a string into a safe ZIP entry path segment. */
function sanitizeSegment(raw: string): string {
  return raw
    .trim()
    .replace(/[^\w.\- ]+/g, '_')
    .replace(/\s+/g, '_')
    .replace(/^_+|(?<!_)_+$/g, '')
    .slice(0, 80) || 'item';
}

/**
 * Coerce a property value into a primitive an XLSX cell can hold.
 * Mirrors layer-export.ts's coerceCell.  Kept private here so a
 * future shared helper module can absorb both without churn.
 */
function coerceCell(v: unknown): string | number | boolean | null {
  if (v === null || v === undefined) return '';
  if (
    typeof v === 'string' ||
    typeof v === 'number' ||
    typeof v === 'boolean'
  ) {
    return v;
  }
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** Build a 2D row array from features + field schema. */
function buildSheetRows(
  features: BundleFeature[],
  fields: Array<{ name: string; label?: string }>,
): (string | number | boolean | null)[][] {
  const headers: string[] = [];
  const keys: string[] = [];
  const seen = new Set<string>();
  if (fields.length > 0) {
    for (const f of fields) {
      if (seen.has(f.name)) continue;
      headers.push(f.label?.trim() || f.name);
      keys.push(f.name);
      seen.add(f.name);
    }
  } else {
    for (const f of features) {
      const props = f.properties ?? {};
      for (const k of Object.keys(props)) {
        if (seen.has(k)) continue;
        headers.push(k);
        keys.push(k);
        seen.add(k);
      }
    }
  }
  const out: (string | number | boolean | null)[][] = [headers];
  for (const f of features) {
    const row: (string | number | boolean | null)[] = [];
    const props = f.properties ?? {};
    for (const k of keys) row.push(coerceCell(props[k]));
    out.push(row);
  }
  return out;
}

/**
 * Compute the export plan: which sublayers to include + their
 * order.  Parent first, then immediate children (recursively).
 */
function planLayers(
  rootKey: string,
  all: BundleSublayer[],
  includeRelated: boolean,
): BundleSublayer[] {
  const byId = new Map(all.map((l) => [l.id, l]));
  const root = byId.get(rootKey);
  if (!root) return [];
  if (!includeRelated) return [root];
  const out: BundleSublayer[] = [root];
  const stack: string[] = [root.id];
  const visited = new Set<string>([root.id]);
  while (stack.length > 0) {
    const parentId = stack.pop()!;
    for (const candidate of all) {
      if (candidate.parentLayerId === parentId && !visited.has(candidate.id)) {
        visited.add(candidate.id);
        out.push(candidate);
        stack.push(candidate.id);
      }
    }
  }
  return out;
}

/**
 * Truncate + sanitize sheet names to the XLSX 31-char limit, and keep
 * them unique. Excel compares sheet names case-insensitively and
 * treats a duplicate as a corrupt workbook; two long labels that
 * share their first 31 characters used to collide. A collision gets
 * a `~2`, `~3`... suffix, trimmed to stay within 31.
 */
export function sheetNames(layers: BundleSublayer[]): string[] {
  const used = new Set<string>();
  return layers.map((layer) => {
    const raw = (layer.label || layer.name || 'sheet').replace(/[/\\?*[\]:]/g, '');
    const base = raw.slice(0, 31) || 'sheet';
    let name = base;
    for (let n = 2; used.has(name.toLowerCase()); n += 1) {
      const suffix = `~${n}`;
      name = `${base.slice(0, 31 - suffix.length)}${suffix}`;
    }
    used.add(name.toLowerCase());
    return name;
  });
}

/** Trigger a browser download of a Blob. */
function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60);
}

/**
 * Build and download a bundle ZIP for the given layer + options.
 *
 * Returns a summary of what was packed so the caller can render a
 * "Done -- N features + M attachments" confirmation.
 */
export async function exportBundle(opts: BundleExportOptions): Promise<{
  layerCount: number;
  featureCount: number;
  attachmentCount: number;
  /** Attachments listed for an exported feature that could not be
   *  downloaded and so are not in the ZIP. */
  attachmentFailures: number;
  bytes: number;
}> {
  const progress = opts.onProgress ?? (() => undefined);
  const allLayers = opts.layers ?? [];
  const plan = planLayers(
    opts.layerKey,
    allLayers.length > 0
      ? allLayers
      : [{ id: opts.layerKey, label: 'Layer', name: 'layer' }],
    opts.includeRelatedTables,
  );

  // Map of layerKey -> features, populated as we walk.  We hold all
  // features in memory while building the workbook because XLSX's
  // aoa_to_sheet wants the full 2D array up front.  For very large
  // exports this is the memory bottleneck; the v2 server-side path
  // streams sheet-at-a-time instead.
  const featuresByLayer = new Map<string, BundleFeature[]>();
  let totalFeatures = 0;
  // Only cascade when the root was actually narrowed. With no
  // selection and no bbox every row of every layer belongs in the
  // export, and the cascade's FK guess could only lose rows.
  const scoped =
    (opts.featureIdsAllowlist !== undefined && opts.featureIdsAllowlist.size > 0) ||
    opts.bbox !== undefined;
  // Surviving feature ids per layer. Each related table is filtered
  // against its OWN parent's survivors. Filling this from the root
  // only emptied every table two or more levels down, because a
  // grandchild's FK holds a child's id, never a root id. The plan
  // lists parents before children, so the parent's set is ready.
  const survivingIds = new Map<string, Set<string>>();
  for (let i = 0; i < plan.length; i += 1) {
    const layer = plan[i]!;
    progress(`Fetching ${layer.label || layer.id}…`);
    let features = await fetchLayerFeatures(opts.itemId, layer.id);
    // Parent-layer scope: applies only to the root layer (i===0).
    // Related tables follow whatever rows reference a surviving
    // parent; that's the "selection cascade" the user actually wants
    // when picking 12 parcels for a handoff bundle.
    if (i === 0) {
      if (opts.featureIdsAllowlist && opts.featureIdsAllowlist.size > 0) {
        features = features.filter(
          (f) => f.id !== undefined && opts.featureIdsAllowlist!.has(f.id),
        );
      }
      if (opts.bbox) {
        const [minX, minY, maxX, maxY] = opts.bbox;
        features = features.filter((f) =>
          geometryIntersectsBbox(f.geometry, minX, minY, maxX, maxY),
        );
      }
    } else if (scoped && layer.parentLayerId) {
      const parentIds = survivingIds.get(layer.parentLayerId) ?? new Set<string>();
      const fk = layer.parentFkColumn;
      features = features.filter((f) => {
        const props = f.properties ?? {};
        if (fk) {
          const v = props[fk];
          return typeof v === 'string' && parentIds.has(v);
        }
        // No FK column known: any property value that matches a
        // surviving parent id. Intentionally permissive; a stale
        // match keeps an extra related row rather than dropping a
        // legitimate one.
        for (const v of Object.values(props)) {
          if (typeof v === 'string' && parentIds.has(v)) return true;
        }
        return false;
      });
    }
    const ids = new Set<string>();
    for (const f of features) if (f.id) ids.add(f.id);
    survivingIds.set(layer.id, ids);
    featuresByLayer.set(layer.id, features);
    totalFeatures += features.length;
  }

  // Build the workbook: one sheet per layer. The vendored XLSX
  // writer (#51) takes an array of { name, rows } sheets and
  // emits a Blob directly.
  progress('Building data.xlsx…');
  const names = sheetNames(plan);
  const xlsxSheets: XlsxSheet[] = plan.map((layer, i) => {
    const features = featuresByLayer.get(layer.id) ?? [];
    const rows = buildSheetRows(features, layer.fields ?? []);
    return { name: names[i]!, rows };
  });
  const xlsxBlob = await writeXlsx(xlsxSheets);

  // Build the ZIP.  Layout: <rootName>/data.xlsx + optional
  // attachments folder per layer. ZIP itself has no real folder
  // type; entries with "/" in the name render as folders in
  // Explorer / Finder. ZipWriter (vendored, #50) takes
  // slash-separated paths directly so we don't need a folder
  // helper.
  const zip = new ZipWriter();
  const rootName = sanitizeSegment(opts.filename);
  await zip.file(`${rootName}/data.xlsx`, xlsxBlob);

  let attachmentCount = 0;
  let attachmentFailures = 0;
  if (opts.includeAttachments) {
    // For each layer, list every attachment in one request, then
    // fetch + bundle the files of the features being exported.
    // Errors fetching one file don't fail the whole bundle: they are
    // counted and returned, so the caller can say how many are
    // missing instead of reporting a complete export.
    let processed = 0;
    for (const layer of plan) {
      const features = featuresByLayer.get(layer.id) ?? [];
      progress(`Listing attachments for ${layer.label || layer.id}…`);
      const byFeature = await fetchLayerAttachments(opts.itemId, layer.id);
      for (const f of features) {
        processed += 1;
        if (processed % 25 === 0) {
          progress(`Fetching attachments ${processed} / ${totalFeatures}…`);
        }
        if (!f.id) continue;
        const list = byFeature.get(f.id) ?? [];
        if (list.length === 0) continue;

        // Resolve the per-feature filename prefix.  Prefer the
        // configured field's value (matches Pro tool convention),
        // fall back to a truncated global id.
        let prefix = '';
        if (
          opts.attachmentPrefixField &&
          f.properties &&
          typeof f.properties === 'object'
        ) {
          const raw = (f.properties as Record<string, unknown>)[
            opts.attachmentPrefixField
          ];
          if (typeof raw === 'string' || typeof raw === 'number') {
            prefix = sanitizeSegment(String(raw));
          }
        }
        if (!prefix) prefix = f.id.slice(0, 8);

        // Optional split-by-field: drop attachments under a subfolder
        // named for the field's value.  Files for that feature land
        // at <splitValue>/<prefix>_ATT<id>_<original>. Folder
        // structure inside the archive is purely path-based now
        // (#50) since ZipWriter is folder-less; the resulting
        // archive layout is identical to what JSZip emitted.
        let attachmentsPath = `${rootName}/attachments`;
        if (
          opts.attachmentSplitField &&
          f.properties &&
          typeof f.properties === 'object'
        ) {
          const raw = (f.properties as Record<string, unknown>)[
            opts.attachmentSplitField
          ];
          if (typeof raw === 'string' || typeof raw === 'number') {
            const sub = sanitizeSegment(String(raw));
            if (sub) attachmentsPath = `${attachmentsPath}/${sub}`;
          }
        }

        for (const att of list) {
          try {
            // Retries a 429 or 5xx: a long run of downloads can still
            // reach the API's per-minute limit.
            const r = await fetchRetrying(att.storageUrl, { cache: 'no-store' });
            if (!r.ok) {
              console.warn('[bundle] attachment fetch failed', att.id, r.status);
              attachmentFailures += 1;
              continue;
            }
            const blob = await r.blob();
            const safeName = sanitizeSegment(
              att.fileName.replace(/\s+/g, ''),
            );
            const finalName = `${prefix}_ATT${att.id.slice(0, 8)}_${safeName}`;
            await zip.file(`${attachmentsPath}/${finalName}`, blob);
            attachmentCount += 1;
          } catch (err) {
            console.warn('[bundle] attachment error', att.id, err);
            attachmentFailures += 1;
          }
        }
      }
    }
  }

  progress('Compressing…');
  const zipBlob = await zip.blob();

  downloadBlob(zipBlob, `${rootName}.zip`);

  return {
    layerCount: plan.length,
    featureCount: totalFeatures,
    attachmentCount,
    attachmentFailures,
    bytes: zipBlob.size,
  };
}
