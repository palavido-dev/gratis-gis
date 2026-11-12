// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Per-layer vector tile settings: validation on save, lenient reading
 * on the tile path, the per-request tile plan, the Cache-Control
 * header and the TileJSON document.
 *
 * The settings live on each v3 sublayer as `tiles` in the item's data
 * JSON, beside `editingPolicy`; see LayerTileSettings in shared-types
 * for the shape and the bounds. Every tile route (authenticated,
 * anonymous portal path, OGC) and every TileJSON route goes through
 * the helpers here, so the three cannot drift apart on what a setting
 * means.
 *
 * Cache invalidation needs no hook of its own: the tile cache key
 * hashes every option the engine receives (optsFingerprint), and the
 * plan below turns each setting that changes tile bytes into such an
 * option (the field list, the feature cap). Changing a setting
 * therefore changes the key, and the old entries age out unread.
 */
import { BadRequestException } from '@nestjs/common';
import {
  MAX_FEATURES_PER_TILE,
  TILE_CACHE_DEFAULT_PRIVATE,
  TILE_CACHE_DEFAULT_PUBLIC,
  TILE_CACHE_MAX_AGE_MAX,
  TILE_LABEL_POINT_PROP,
  TILE_LABELS_LAYER,
  TILE_ZOOM_MAX,
  TILE_ZOOM_MIN,
  sanitizeAttributionHtml,
  type LayerTileSettings,
} from '@gratis-gis/shared-types';

/** Same identifier rule the engine applies before projecting a field. */
const SAFE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

/** Most attribute names one include param may carry. */
const MAX_INCLUDE_NAMES = 200;

const KNOWN_KEYS = new Set<string>([
  'fields',
  'minZoom',
  'maxZoom',
  'maxFeatures',
  'cacheMaxAge',
  'labelPoints',
]);

function isInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v);
}

/**
 * Validate and normalize one layer's `tiles` object for storage.
 * Returns undefined when nothing is set, so the key can be dropped.
 *
 * Field names that are not declared on the layer are pruned rather
 * than refused: the schema editor removes a field and saves the layer
 * in one go, and refusing that save over a stale tile setting would
 * make the field impossible to delete.
 */
export function normalizeTileSettings(
  raw: unknown,
  declared: ReadonlyArray<string>,
  layerLabel: string,
): LayerTileSettings | undefined {
  if (raw === undefined || raw === null) return undefined;
  const bad = (msg: string): never => {
    throw new BadRequestException(`Layer "${layerLabel}" tile settings: ${msg}`);
  };
  if (typeof raw !== 'object' || Array.isArray(raw)) bad('must be an object.');
  const r = raw as Record<string, unknown>;
  for (const key of Object.keys(r)) {
    if (!KNOWN_KEYS.has(key)) bad(`unknown setting "${key}".`);
  }
  const out: LayerTileSettings = {};
  if (r.fields !== undefined && r.fields !== null) {
    if (!Array.isArray(r.fields)) bad('fields must be a list of field names.');
    const declaredSet = new Set(declared);
    const seen = new Set<string>();
    for (const f of r.fields as unknown[]) {
      if (typeof f !== 'string' || !SAFE_NAME.test(f)) {
        bad('fields must be a list of field names.');
      }
      const name = f as string;
      if (declaredSet.has(name)) seen.add(name);
    }
    // Declared order, so a re-save is byte-stable.
    out.fields = declared.filter((n) => seen.has(n));
  }
  for (const key of ['minZoom', 'maxZoom'] as const) {
    const v = r[key];
    if (v === undefined || v === null) continue;
    if (!isInt(v) || v < TILE_ZOOM_MIN || v > TILE_ZOOM_MAX) {
      bad(`${key} must be a whole number from ${TILE_ZOOM_MIN} to ${TILE_ZOOM_MAX}.`);
    }
    out[key] = v as number;
  }
  if (
    out.minZoom !== undefined &&
    out.maxZoom !== undefined &&
    out.minZoom > out.maxZoom
  ) {
    bad('minZoom must not be greater than maxZoom.');
  }
  if (r.maxFeatures !== undefined && r.maxFeatures !== null) {
    const v = r.maxFeatures;
    if (!isInt(v) || v < 1 || v > MAX_FEATURES_PER_TILE) {
      bad(`maxFeatures must be a whole number from 1 to ${MAX_FEATURES_PER_TILE}.`);
    }
    out.maxFeatures = v as number;
  }
  if (r.cacheMaxAge !== undefined && r.cacheMaxAge !== null) {
    const v = r.cacheMaxAge;
    if (!isInt(v) || v < 0 || v > TILE_CACHE_MAX_AGE_MAX) {
      bad(`cacheMaxAge must be a whole number of seconds from 0 to ${TILE_CACHE_MAX_AGE_MAX}.`);
    }
    out.cacheMaxAge = v as number;
  }
  if (r.labelPoints !== undefined && r.labelPoints !== null) {
    if (typeof r.labelPoints !== 'boolean') bad('labelPoints must be true or false.');
    // Off is the default, so only `true` is stored.
    if (r.labelPoints === true) out.labelPoints = true;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Normalize the `tiles` settings of every layer in a v3 data_layer
 * payload. Returns the input object unchanged when no layer carries
 * settings, so saves that never touch them cost nothing; otherwise a
 * shallow copy with each layer's settings normalized (or dropped when
 * empty). Throws 400 on an invalid value.
 */
export function normalizeTileSettingsInData(data: unknown): unknown {
  if (!data || typeof data !== 'object') return data;
  const d = data as { version?: unknown; layers?: unknown };
  if (d.version !== 3 || !Array.isArray(d.layers)) return data;
  if (
    !d.layers.some(
      (l) => l && typeof l === 'object' && 'tiles' in (l as object),
    )
  ) {
    return data;
  }
  const layers = d.layers.map((l) => {
    if (!l || typeof l !== 'object' || !('tiles' in (l as object))) return l;
    const layer = l as Record<string, unknown>;
    const declared = Array.isArray(layer.fields)
      ? (layer.fields as Array<{ name?: unknown }>)
          .map((f) => (typeof f?.name === 'string' ? f.name : ''))
          .filter((n) => n.length > 0)
      : [];
    const label =
      typeof layer.label === 'string'
        ? layer.label
        : typeof layer.id === 'string'
          ? layer.id
          : '?';
    const tiles = normalizeTileSettings(layer.tiles, declared, label);
    const { tiles: _drop, ...rest } = layer;
    void _drop;
    return tiles ? { ...rest, tiles } : rest;
  });
  return { ...(data as Record<string, unknown>), layers };
}

/**
 * Read a stored `tiles` object on the tile path. Never throws: a value
 * that fails validation (a row written before validation existed, or
 * edited by hand) is ignored key by key and the default applies, so a
 * bad setting can cost an owner their tweak but never their map.
 */
export function readTileSettings(raw: unknown): LayerTileSettings {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const r = raw as Record<string, unknown>;
  const out: LayerTileSettings = {};
  if (Array.isArray(r.fields)) {
    out.fields = (r.fields as unknown[]).filter(
      (f): f is string => typeof f === 'string' && SAFE_NAME.test(f),
    );
  }
  const zoom = (v: unknown): number | undefined =>
    isInt(v) && v >= TILE_ZOOM_MIN && v <= TILE_ZOOM_MAX ? v : undefined;
  const minZoom = zoom(r.minZoom);
  const maxZoom = zoom(r.maxZoom);
  if (minZoom !== undefined) out.minZoom = minZoom;
  if (maxZoom !== undefined) out.maxZoom = maxZoom;
  if (
    out.minZoom !== undefined &&
    out.maxZoom !== undefined &&
    out.minZoom > out.maxZoom
  ) {
    delete out.minZoom;
    delete out.maxZoom;
  }
  if (isInt(r.maxFeatures) && r.maxFeatures >= 1) {
    out.maxFeatures = Math.min(r.maxFeatures, MAX_FEATURES_PER_TILE);
  }
  if (isInt(r.cacheMaxAge) && r.cacheMaxAge >= 0) {
    out.cacheMaxAge = Math.min(r.cacheMaxAge, TILE_CACHE_MAX_AGE_MAX);
  }
  if (r.labelPoints === true) out.labelPoints = true;
  return out;
}

/**
 * Parse the `include` query parameter a map sends: a comma separated
 * list of field names it reads from the tile, or `*` for all of them.
 * Malformed names are dropped rather than refused, because a map that
 * references a field the layer no longer has must keep drawing.
 */
export function parseIncludeParam(raw: unknown): string[] | '*' | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  const parts = raw.split(',').map((s) => s.trim());
  if (parts.includes('*')) return '*';
  const names = parts
    .filter((p) => SAFE_NAME.test(p))
    .slice(0, MAX_INCLUDE_NAMES);
  return names.length > 0 ? names : null;
}

export interface TileField {
  name: string;
  type?: string;
}

/**
 * A layer's declared fields in the shape the engine projects, from the
 * raw stored list. Nameless entries are dropped, as every tile route
 * did before tile settings existed.
 */
export function declaredTileFields(raw: unknown): TileField[] {
  if (!Array.isArray(raw)) return [];
  const out: TileField[] = [];
  for (const f of raw as Array<{ name?: unknown; type?: unknown }>) {
    if (!f || typeof f.name !== 'string' || f.name.length === 0) continue;
    out.push({
      name: f.name,
      ...(typeof f.type === 'string' ? { type: f.type } : {}),
    });
  }
  return out;
}

export interface TilePlan {
  /** Fields to project into the tile. */
  fields: TileField[];
  /** Per-tile cap below the server's ceiling, or undefined for the ceiling. */
  maxFeaturesPerTile?: number;
  /** Zoom range outside which the tile is empty, when one is set. */
  zoomRange?: { min: number; max: number };
  /** Emit the `labels` layer (line and polygon layers only). */
  labelPoints?: true;
}

/**
 * Whether a layer's declared geometry can have label points. Lenient
 * about case and Multi prefixes because the stored value has come from
 * several importers over time.
 */
export function geometryTakesLabelPoints(geometryType: unknown): boolean {
  if (typeof geometryType !== 'string') return false;
  const g = geometryType.toLowerCase();
  return g.includes('line') || g.includes('polygon');
}

/**
 * The fields, cap and zoom range one tile request uses.
 *
 * Fields: with no owner selection, every declared field (unchanged
 * behaviour), and `include` is ignored so the cache key stays what it
 * always was. With a selection, the selection plus whatever the
 * requesting map names in `include` (limited to declared fields), so
 * a map's own renderer, labels and filter keep working after an owner
 * trims the tile. Declared order is kept; the cache fingerprint sorts
 * anyway.
 */
export function planTile(args: {
  declared: ReadonlyArray<TileField>;
  settings: LayerTileSettings;
  include?: string[] | '*' | null;
  /** The layer's declared geometry type; label points need line or polygon. */
  geometryType?: unknown;
}): TilePlan {
  const { declared, settings, include } = args;
  let fields: TileField[];
  if (settings.fields === undefined || include === '*') {
    fields = [...declared];
  } else {
    const keep = new Set(settings.fields);
    for (const n of include ?? []) keep.add(n);
    fields = declared.filter((f) => keep.has(f.name));
  }
  const plan: TilePlan = { fields };
  if (
    settings.maxFeatures !== undefined &&
    settings.maxFeatures < MAX_FEATURES_PER_TILE
  ) {
    plan.maxFeaturesPerTile = settings.maxFeatures;
  }
  if (settings.minZoom !== undefined || settings.maxZoom !== undefined) {
    plan.zoomRange = {
      min: settings.minZoom ?? TILE_ZOOM_MIN,
      max: settings.maxZoom ?? TILE_ZOOM_MAX,
    };
  }
  if (settings.labelPoints === true && geometryTakesLabelPoints(args.geometryType)) {
    plan.labelPoints = true;
  }
  return plan;
}

/**
 * Cache-Control for a tile response. The visibility comes from the
 * route, never from the setting: the authenticated route is always
 * `private` (the bytes depend on the viewer's geo limit and row
 * scope), and only the anonymous routes, which serve public items
 * only, say `public`. The setting changes the max-age alone.
 */
export function tileCacheControl(
  settings: LayerTileSettings,
  visibility: 'private' | 'public',
): string {
  const fallback =
    visibility === 'public' ? TILE_CACHE_DEFAULT_PUBLIC : TILE_CACHE_DEFAULT_PRIVATE;
  const age = settings.cacheMaxAge ?? fallback;
  return `${visibility}, max-age=${age}`;
}

/** Field types as TileJSON names them, from how the engine projects them. */
function tileJsonType(type: string | undefined): 'Number' | 'String' {
  // tileFieldProjection casts number fields to numeric; every other
  // type (boolean and date included) is carried as text.
  return type === 'number' ? 'Number' : 'String';
}

/** The default upper zoom the tile routes advertise when none is set. */
export const DEFAULT_ADVERTISED_MAXZOOM = 22;

/**
 * TileJSON 3.0.0 for one layer.
 *
 * `bounds` is the caller's decision: pass it only when the viewer may
 * see the whole layer's extent (no geo limit, no row scope, no tier
 * clip). `fields` must be what the tile actually carries for a request
 * without `include`, which is what a TileJSON client will send.
 */
export function buildTileJson(args: {
  name: string;
  description?: string | null;
  tileUrl: string;
  settings: LayerTileSettings;
  fields: ReadonlyArray<TileField>;
  bounds?: [number, number, number, number] | null;
  attribution?: unknown;
  /** The plan's labelPoints: adds the `labels` layer to vector_layers. */
  labelPoints?: boolean;
}): Record<string, unknown> {
  const minzoom = args.settings.minZoom ?? TILE_ZOOM_MIN;
  // Zooms go up to TILE_ZOOM_MAX, so a minZoom above the advertised
  // default must lift the default too; minzoom > maxzoom makes strict
  // clients reject the TileJSON.
  const maxzoom =
    args.settings.maxZoom ?? Math.max(DEFAULT_ADVERTISED_MAXZOOM, minzoom);
  const fields: Record<string, string> = { _global_id: 'String' };
  for (const f of args.fields) fields[f.name] = tileJsonType(f.type);
  const featureFields: Record<string, string> = args.labelPoints
    ? { ...fields, [TILE_LABEL_POINT_PROP]: 'Boolean' }
    : fields;
  const doc: Record<string, unknown> = {
    tilejson: '3.0.0',
    name: args.name,
    ...(args.description ? { description: args.description } : {}),
    scheme: 'xyz',
    tiles: [args.tileUrl],
    minzoom,
    maxzoom,
    vector_layers: [
      {
        id: 'features',
        fields: featureFields,
        minzoom,
        maxzoom,
      },
      ...(args.labelPoints
        ? [
            {
              id: TILE_LABELS_LAYER,
              description:
                'One point per line or polygon feature, in the tile that contains it.',
              fields,
              minzoom,
              maxzoom,
            },
          ]
        : []),
    ],
  };
  if (args.bounds && isValidBounds(args.bounds)) doc.bounds = args.bounds;
  if (typeof args.attribution === 'string') {
    const clean = sanitizeAttributionHtml(args.attribution);
    if (clean.length > 0) doc.attribution = clean;
  }
  return doc;
}

function isValidBounds(b: unknown): b is [number, number, number, number] {
  return (
    Array.isArray(b) &&
    b.length === 4 &&
    b.every((n) => typeof n === 'number' && Number.isFinite(n)) &&
    (b[0] as number) <= (b[2] as number) &&
    (b[1] as number) <= (b[3] as number)
  );
}

/**
 * The layer's stored extent, if one is on the layer, else the item's.
 * Both are written by ingest and the bbox refresh, so reading them is
 * free; the TileJSON does not compute an extent on request.
 */
export function storedLayerBounds(
  layerBbox: unknown,
  itemBbox: unknown,
): [number, number, number, number] | null {
  if (isValidBounds(layerBbox)) return layerBbox;
  if (isValidBounds(itemBbox)) return itemBbox;
  return null;
}

/**
 * Absolute origin for URLs in a TileJSON. PORTAL_BASE_URL only: a
 * TileJSON is a document clients cache and share, so it must never
 * echo a client-supplied Host or X-Forwarded-Host. Unset falls back to
 * the local dev origin, the same default the mail templates use.
 */
export function tileJsonBase(): string {
  const raw = process.env.PORTAL_BASE_URL?.trim();
  return (raw && raw.length > 0 ? raw : 'http://localhost:3000').replace(
    /(?<!\/)\/+$/,
    '',
  );
}

/** The attribution string stored on a layer or its item, if any. */
export function layerAttribution(layer: unknown, itemData: unknown): unknown {
  const fromLayer = (layer as { attribution?: unknown } | null)?.attribution;
  if (typeof fromLayer === 'string' && fromLayer.length > 0) return fromLayer;
  return (itemData as { attribution?: unknown } | null)?.attribution;
}
