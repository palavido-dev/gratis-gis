// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The item ids one item's saved data refers to, and the one rule every
// save follows for them: a reference that is new in this save must name
// an item the author can read. References already stored are not
// checked again, so an item whose target was unshared since can still
// be edited and saved. Reads through a stored reference keep their own
// read-time checks.
//
// An id that does not exist and an id the author may not read get the
// same answer, so the answer does not tell them apart.

import { BadRequestException } from '@nestjs/common';
import type { ItemType } from '@prisma/client';

import { isUuidShape } from '../common/uuid-shape.js';
import { extractDependencies } from './dependency-extractor.js';

/** What a reference walk needs from an item: its type, data and tier columns. */
export interface ReferenceSource {
  type: ItemType | string;
  data: unknown;
  publicGeoBoundaryId?: string | null;
  orgGeoBoundaryId?: string | null;
}

/**
 * Keys whose string value names another item, wherever they sit in an
 * item's data. The typed walk in dependency-extractor covers the known
 * shapes; this list also catches the same keys in shapes it does not
 * walk (tool actions, button and tool widgets, print templates,
 * composed basemaps, layer clips and relates, relationships), so a new
 * item type that reuses them is covered without a change here. Only
 * uuid-shaped values count: several of these keys may also hold a
 * built-in name (a basemap style, a starter theme).
 */
const REFERENCE_KEYS: ReadonlySet<string> = new Set([
  'itemId',
  'serviceItemId',
  'sourceItemId',
  'mapId',
  'mapItemId',
  'defaultMapId',
  'dataLayerId',
  'formItemId',
  'linkedLayerId',
  'layerItemId',
  'pickListId',
  'pickListItemId',
  'sourceLayerId',
  'geocoderId',
  'basemap',
  'defaultExtentBoundaryId',
  'clipBoundaryId',
  'boundaryFilterItemId',
  'preferredElevationItemId',
  'parentItemId',
  'relatedItemId',
  'targetItemId',
  'toolId',
  'themePresetId',
]);

/** Keys whose value is a list of item ids. */
const REFERENCE_LIST_KEYS: ReadonlySet<string> = new Set([
  'childItemIds',
  'templateIds',
  'basemapIds',
]);

/**
 * Server-owned keys left out of the walk: map expression `dataRefs`
 * are recomputed on every save from what the saving user can read
 * (resolveMapExpressionSources), whatever the client sent.
 */
const SERVER_OWNED_KEYS: ReadonlySet<string> = new Set(['dataRefs']);

/** Deeper than any real item shape; stops a hostile payload early. */
const MAX_WALK_DEPTH = 64;

/** The answer for a new reference that is missing or not readable. */
export function referenceNotFoundMessage(id: string): string {
  return `Referenced item ${id} was not found.`;
}

/**
 * The portal item a map layer reads through, or null for a url or
 * inline source. Each source kind names its item in its own field
 * (shared-types MapLayerSource).
 */
export function mapLayerBackingItemId(layer: unknown): string | null {
  const src = (layer as { source?: Record<string, unknown> } | null)?.source;
  if (!src || typeof src !== 'object') return null;
  let id: unknown;
  switch (src.kind) {
    case 'data-layer':
    case 'tile':
    case 'point-cloud':
      id = src.itemId;
      break;
    case 'arcgis-rest':
      id = src.sourceItemId;
      break;
    case 'postgis-live':
      id = src.serviceItemId;
      break;
    default:
      return null;
  }
  return typeof id === 'string' && id.length > 0 ? id : null;
}

/** The backing item ids of every layer in a map's data. */
export function mapLayerBackingItemIds(data: unknown): string[] {
  const layers = (data as { layers?: unknown } | null | undefined)?.layers;
  if (!Array.isArray(layers)) return [];
  const out = new Set<string>();
  for (const layer of layers) {
    const id = mapLayerBackingItemId(layer);
    if (id !== null) out.add(id);
  }
  return [...out];
}

/** Every reference-key value in `data`, at any depth. */
function collectKeyedReferences(data: unknown, out: Set<string>): void {
  const stack: Array<{ value: unknown; depth: number }> = [{ value: data, depth: 0 }];
  while (stack.length > 0) {
    const { value, depth } = stack.pop()!;
    if (depth > MAX_WALK_DEPTH || !value || typeof value !== 'object') continue;
    if (Array.isArray(value)) {
      for (const v of value) stack.push({ value: v, depth: depth + 1 });
      continue;
    }
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (SERVER_OWNED_KEYS.has(key)) continue;
      if (REFERENCE_KEYS.has(key) && isUuidShape(v)) {
        out.add(v.toLowerCase());
      } else if (REFERENCE_LIST_KEYS.has(key) && Array.isArray(v)) {
        for (const id of v) if (isUuidShape(id)) out.add(id.toLowerCase());
      }
      if (v && typeof v === 'object') stack.push({ value: v, depth: depth + 1 });
    }
  }
}

/**
 * Every item id `row` refers to: the typed dependency walk, the keyed
 * walk above, the tier geo boundary columns, and each map layer's
 * backing item. Map layer ids are kept even when they are not
 * uuid-shaped, as the map layer check always did, so a layer cannot
 * name an item by a malformed id.
 */
export function referencedItemIds(row: ReferenceSource | null | undefined): string[] {
  if (!row) return [];
  const out = new Set<string>();
  // Map expression dataRefs are server-owned (see SERVER_OWNED_KEYS),
  // and a map layer's elevation hint is an optional reference
  // (mapLayerElevationHintIds), not one the author chose.
  const data =
    row.type === 'map' ? withoutMapLayerElevationHints(stripDataRefs(row.data)) : row.data;
  const typed = extractDependencies({
    type: row.type as ItemType,
    data,
    publicGeoBoundaryId: row.publicGeoBoundaryId ?? null,
    orgGeoBoundaryId: row.orgGeoBoundaryId ?? null,
  });
  for (const id of typed.itemIds) out.add(id.toLowerCase());
  collectKeyedReferences(data, out);
  if (row.type === 'map') {
    for (const id of mapLayerBackingItemIds(data)) {
      out.add(isUuidShape(id) ? id.toLowerCase() : id);
    }
  }
  return [...out];
}

/**
 * The elevation hints of a map's layers: `source.preferredElevationItemId`,
 * copied from the tile or point cloud item when the layer is added. The
 * author did not choose it, so a save does not refuse it: a new hint the
 * author cannot read is left out of the saved layer instead.
 */
export function mapLayerElevationHintIds(data: unknown): string[] {
  const layers = (data as { layers?: unknown } | null | undefined)?.layers;
  if (!Array.isArray(layers)) return [];
  const out = new Set<string>();
  for (const l of layers as Array<{ source?: { preferredElevationItemId?: unknown } } | null>) {
    const id = l?.source?.preferredElevationItemId;
    if (isUuidShape(id)) out.add(id.toLowerCase());
  }
  return [...out];
}

/**
 * Map data without the layer elevation hints in `drop`, or without any
 * when `drop` is not given.
 */
export function withoutMapLayerElevationHints(data: unknown, drop?: ReadonlySet<string>): unknown {
  const d = data as { layers?: unknown } | null | undefined;
  if (!d || !Array.isArray(d.layers)) return data;
  let changed = false;
  const layers = (d.layers as unknown[]).map((l) => {
    const layer = l as { source?: Record<string, unknown> } | null;
    const src = layer?.source;
    if (!src || typeof src !== 'object' || !('preferredElevationItemId' in src)) return l;
    const id = src.preferredElevationItemId;
    if (drop && !(typeof id === 'string' && drop.has(referenceKey(id)))) return l;
    const { preferredElevationItemId: _hint, ...rest } = src;
    void _hint;
    changed = true;
    return { ...(layer as object), source: rest };
  });
  return changed ? { ...(d as object), layers } : data;
}

function stripDataRefs(data: unknown): unknown {
  const d = data as { layers?: unknown } | null | undefined;
  if (!d || !Array.isArray(d.layers)) return data;
  return {
    ...(d as object),
    layers: (d.layers as Array<Record<string, unknown> | null>).map((l) => {
      if (!l || !Array.isArray(l.expressions)) return l;
      return {
        ...l,
        expressions: (l.expressions as Array<Record<string, unknown> | null>).map((ex) => {
          if (!ex || typeof ex !== 'object') return ex;
          const { dataRefs: _refs, ...rest } = ex;
          void _refs;
          return rest;
        }),
      };
    }),
  };
}

/** The ids in `incoming` that are not in `stored`, in order, without repeats. */
export function addedReferenceIds(stored: Iterable<string>, incoming: Iterable<string>): string[] {
  const before = new Set<string>();
  for (const id of stored) before.add(id.toLowerCase());
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of incoming) {
    const key = id.toLowerCase();
    if (before.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(id);
  }
  return out;
}

/** Answers which of a set of ids the author cannot read, in one query. */
export type UnreadableLookup<U> = (user: U, ids: string[]) => Promise<Set<string>>;

/**
 * The save rule. `stored` are the references the item holds now (empty
 * for a new item), `incoming` the references of the data being saved.
 * Every reference that is new in this save must name an item `author`
 * can read; the first one that does not is refused with the same body
 * whether it is missing, trashed or not visible to the author. One
 * lookup for all of them, and none when nothing was added.
 */
export async function assertAddedReferencesReadable<U>(
  unreadable: UnreadableLookup<U>,
  author: U,
  stored: Iterable<string>,
  incoming: Iterable<string>,
  /** References that are dropped rather than refused when the author
   *  cannot read them (a map layer's elevation hint). New ones share
   *  the one lookup. */
  optional: Iterable<string> = [],
): Promise<Set<string>> {
  const storedList = [...stored];
  const added = addedReferenceIds(storedList, incoming);
  const addedOptional = addedReferenceIds([...storedList, ...added], optional);
  if (added.length === 0 && addedOptional.length === 0) return new Set();
  const hidden = await unreadable(author, [...added, ...addedOptional]);
  const isHidden = (id: string) => hidden.has(id) || hidden.has(id.toLowerCase());
  const first = added.find(isHidden);
  if (first !== undefined) {
    throw new BadRequestException(referenceNotFoundMessage(first));
  }
  return new Set(addedOptional.filter(isHidden).map(referenceKey));
}

/** An app target ({ dataLayerId }) or source ({ layer: { dataLayerId } }) of a dropped layer. */
function namesDroppedLayer(v: unknown, drop: ReadonlySet<string>): boolean {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const o = v as { dataLayerId?: unknown; layer?: { dataLayerId?: unknown } | null };
  const id =
    o.dataLayerId ?? (o.layer && typeof o.layer === 'object' ? o.layer.dataLayerId : undefined);
  return typeof id === 'string' && drop.has(referenceKey(id));
}

/** The form ids take in reference sets: uuids lowercased, anything else as is. */
export function referenceKey(id: string): string {
  return isUuidShape(id) ? id.toLowerCase() : id;
}

/**
 * `data` without any reference to an id in `drop`: a reference-key
 * property naming one is removed, and list entries naming one are
 * left out. Item-type agnostic; callers that can do better for a
 * shape (a map layer is dropped whole) do that first.
 */
export function withoutReferences(data: unknown, drop: ReadonlySet<string>): unknown {
  const visit = (value: unknown, depth: number): unknown => {
    if (depth > MAX_WALK_DEPTH || !value || typeof value !== 'object') return value;
    if (Array.isArray(value)) {
      // A layer target or source entry is meaningless without its
      // layer, so an entry naming a dropped layer is left out whole.
      return value.filter((v) => !namesDroppedLayer(v, drop)).map((v) => visit(v, depth + 1));
    }
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (REFERENCE_KEYS.has(key) && typeof v === 'string' && drop.has(referenceKey(v))) {
        continue;
      }
      if (REFERENCE_LIST_KEYS.has(key) && Array.isArray(v)) {
        out[key] = v.filter((id) => !(typeof id === 'string' && drop.has(referenceKey(id))));
        continue;
      }
      out[key] = visit(v, depth + 1);
    }
    return out;
  };
  return visit(data, 0);
}
