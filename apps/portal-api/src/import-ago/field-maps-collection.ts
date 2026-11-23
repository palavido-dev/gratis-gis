// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Field Maps web map to a data collection.
 *
 * When an imported web map was set up for Field Maps, the import also
 * makes what a field crew needs here: one form per layer that had a
 * Field Maps form, a data collection that wraps the map and binds
 * those forms, and an offline area for each of the map's offline map
 * areas. The map itself is imported as usual first.
 */
import { randomUUID } from 'node:crypto';

import type { Prisma } from '@prisma/client';
import type { FormSchema } from '@gratis-gis/form-schema';
import type {
  DataCollectionData,
  DataCollectionFormBinding,
  DataLayerDataV3,
  DataLayerSublayer,
  OfflineArea,
} from '@gratis-gis/shared-types';

import type { AuthUser } from '../auth/auth-sync.service.js';
import type { ItemsService } from '../items/items.service.js';
import type { ImportedFieldLayer } from '../items/web-map-json-import.service.js';

import type { AgoClient } from './ago-client.js';
import { fieldMapsFormToSchema, type AgoFormInfo } from './field-maps-form.js';

/** Type keywords ArcGIS sets when a map is hidden from Field Maps. */
const DISABLED = new Set(['fieldmapsdisabled', 'collectordisabled']);
/** Type keywords that mark a map as used for field editing. */
const FIELD_USE = new Set(['collector', 'data editing', 'offline', 'fieldmapsenabled']);

/**
 * Whether the web map should come over as a data collection: Field
 * Maps is not turned off for it, it has a layer the map lets crews
 * edit, and it shows signs of field use (a Field Maps form, or the
 * keywords ArcGIS adds to maps with editable layers or offline areas).
 */
export function isFieldMapsMap(
  typeKeywords: readonly string[],
  layers: readonly ImportedFieldLayer[],
): boolean {
  const kw = typeKeywords.map((k) => k.toLowerCase());
  if (kw.some((k) => DISABLED.has(k))) return false;
  if (!layers.some((l) => l.editable)) return false;
  return layers.some((l) => l.formInfo) || kw.some((k) => FIELD_USE.has(k));
}

/** An ArcGIS map area item's extent as an offline area. */
export function mapAreaToOfflineArea(item: {
  title?: unknown;
  extent?: unknown;
}): OfflineArea | null {
  const ext = item.extent;
  if (!Array.isArray(ext) || ext.length !== 2) return null;
  const [a, b] = ext as unknown[];
  if (!Array.isArray(a) || !Array.isArray(b)) return null;
  const nums = [a[0], a[1], b[0], b[1]].map(Number);
  if (nums.some((n) => !Number.isFinite(n))) return null;
  const [w, s, e, n] = nums as [number, number, number, number];
  if (w >= e || s >= n || w < -180 || e > 180 || s < -90 || n > 90) return null;
  return {
    id: randomUUID(),
    name: typeof item.title === 'string' && item.title.trim() ? item.title.trim() : 'Offline area',
    bbox: [w, s, e, n],
    minZoom: 0,
    maxZoom: 14,
  };
}

export interface CreatedExtra {
  portalItemId: string;
  portalItemType: string;
  title: string;
}

/**
 * Make the forms and the data collection for an imported Field Maps
 * map. A failure on one form is a warning; the data collection is
 * still made, and that layer uses the form built from its fields.
 */
export async function createFieldMapsCollection(args: {
  items: ItemsService;
  client: AgoClient;
  user: AuthUser;
  agoMapId: string;
  title: string;
  mapItemId: string;
  access: 'private' | 'org' | 'public';
  layers: ImportedFieldLayer[];
}): Promise<{ created: CreatedExtra[]; warnings: string[] }> {
  const { items, user } = args;
  const created: CreatedExtra[] = [];
  const warnings: string[] = [];
  const formBindings: Record<string, DataCollectionFormBinding> = {};

  for (const layer of args.layers) {
    if (!layer.editable || !layer.layerKey) continue;
    let sublayer: DataLayerSublayer | undefined;
    try {
      const item = await items.get(user, layer.dataLayerItemId);
      const data = item.data as unknown as DataLayerDataV3 | null;
      sublayer = data?.version === 3 ? data.layers.find((l) => l.id === layer.layerKey) : undefined;
    } catch {
      sublayer = undefined;
    }
    if (!sublayer) continue;
    if (sublayer.editingEnabled === false) {
      warnings.push(
        `"${layer.title}" is editable in the web map, but editing is off on its data layer. Turn it on there for crews to collect into it.`,
      );
    }
    if (!layer.formInfo || formBindings[layer.layerKey]) continue;
    const formTitle = `${args.title}: ${layer.title}`;
    const conv = fieldMapsFormToSchema({
      formInfo: layer.formInfo as AgoFormInfo,
      dataLayerId: layer.dataLayerItemId,
      layerKey: layer.layerKey,
      layerTitle: layer.title,
      fields: sublayer.fields ?? [],
      title: formTitle,
    });
    warnings.push(...conv.warnings);
    if (!conv.form) continue;
    try {
      const formItem = await items.create(user, {
        type: 'form',
        title: formTitle,
        data: conv.form as unknown as Prisma.InputJsonValue,
        access: args.access,
      });
      const form: FormSchema = { ...conv.form, id: formItem.id };
      await items.update(user, formItem.id, { data: form as unknown as Prisma.InputJsonValue });
      formBindings[layer.layerKey] = { formItemId: formItem.id };
      created.push({ portalItemId: formItem.id, portalItemType: 'form', title: formTitle });
    } catch (e) {
      warnings.push(
        `The form for "${layer.title}" was not created: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  const offlineAreas: OfflineArea[] = [];
  try {
    for (const area of await args.client.relatedItems(args.agoMapId, 'Map2Area')) {
      const converted = mapAreaToOfflineArea(area);
      if (converted) offlineAreas.push(converted);
    }
  } catch (e) {
    warnings.push(
      `The map's offline areas were not read: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (offlineAreas.length > 0) {
    warnings.push(
      `Added ${offlineAreas.length} offline area(s) from the map's offline map areas. Build them on the data collection's page before crews download.`,
    );
  }

  const data: DataCollectionData = {
    version: 1,
    mapId: args.mapItemId,
    ...(Object.keys(formBindings).length > 0 ? { formBindings } : {}),
    ...(offlineAreas.length > 0 ? { offlineAreas } : {}),
  };
  const dc = await items.create(user, {
    type: 'data_collection',
    title: args.title,
    data: data as unknown as Prisma.InputJsonValue,
    access: args.access,
  });
  created.push({ portalItemId: dc.id, portalItemType: 'data_collection', title: args.title });
  return { created, warnings };
}
