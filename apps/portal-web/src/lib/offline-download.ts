/**
 * Download manager for caching a data_collection deployment for
 * offline use. Walks every editable layer, fetches its features
 * scoped to the deployment's bbox (when configured), persists to
 * IndexedDB along with form schemas and pick lists, and writes a
 * deployment manifest record so subsequent visits can detect the
 * cached state.
 *
 * Tile caching is intentionally NOT in this module yet -- see
 * docs/field-offline-recovery.md for the staged plan. The map will
 * render with empty basemap tiles when offline at the cost of
 * pretty pictures, but feature data + forms + pick-lists work.
 *
 * The progress callback fires after each meaningful step so the UI
 * can render a live status without polling.
 */

import type { FeatureField, PickListData } from '@gratis-gis/shared-types';
import type { FormSchema } from '@gratis-gis/form-schema';
import {
  type CachedDeployment,
  type CachedFeature,
  type CachedLayerSchema,
  deploymentSlug,
  hashLayerSchema,
  putDeployment,
  putFeatures,
  putForm,
  putPickList,
} from './offline-store';

/** One editable layer the manager should fetch features for. Same
 *  shape as field-runtime's EditableLayer minus the things this
 *  module doesn't need at download time. */
export interface DownloadLayer {
  dataLayerId: string;
  layerKey: string;
  layerLabel: string;
  fields: FeatureField[];
  /** Optional form binding; when set, the bound form is fetched
   *  alongside layer features. */
  boundFormItemId?: string;
}

export interface DownloadProgress {
  /** Phase the manager is currently executing. */
  phase:
    | 'estimating'
    | 'fetching-features'
    | 'fetching-forms'
    | 'fetching-picklists'
    | 'persisting'
    | 'done'
    | 'failed';
  /** Free-text status line, e.g. "Fetching Nest features (123 so far)". */
  message: string;
  /** Estimated total bytes that will be cached. Updated through the
   *  estimating phase; final value lands in the deployment manifest. */
  estimatedSize: number;
  /** Counts updated as the run progresses. */
  featuresFetched: number;
  formsFetched: number;
  pickListsFetched: number;
  /** Set on 'failed'. */
  error?: string;
}

export interface DownloadInput {
  dataCollectionId: string;
  title: string;
  mapId: string;
  bbox?: [number, number, number, number];
  layers: DownloadLayer[];
  /** Pick-list item ids referenced by any layer field with a
   *  coded-value-ref domain. Server-side already resolved these for
   *  the live runtime; the download manager pre-fetches the same
   *  set so offline forms render with populated choices. */
  pickListIds: string[];
}

/** Best-effort byte estimate per cached feature. Used by the
 *  estimating phase before we know the real count. Tuned from
 *  observation: a typical PostGIS feature with ~10 attributes
 *  serialised through ST_AsGeoJSON lands ~600 bytes. */
const ESTIMATED_BYTES_PER_FEATURE = 800;

/**
 * Run the offline download for a deployment. Reports progress via
 * the supplied callback. Resolves on completion; rejects on a fatal
 * error (network failure on a critical fetch, IndexedDB write
 * refused). Per-layer fetch failures degrade gracefully: a layer
 * that 500s is skipped with a warning in `progress.message` rather
 * than aborting the whole run, so a stuck single layer doesn't
 * block offline of the rest.
 */
export async function downloadDeployment(
  input: DownloadInput,
  onProgress: (p: DownloadProgress) => void,
): Promise<CachedDeployment> {
  const progress: DownloadProgress = {
    phase: 'estimating',
    message: 'Estimating download size...',
    estimatedSize: 0,
    featuresFetched: 0,
    formsFetched: 0,
    pickListsFetched: 0,
  };
  onProgress({ ...progress });

  // Estimating phase: rough envelope based on the layer fields. Real
  // size is computed during persist when we know byte counts.
  progress.estimatedSize =
    input.layers.length * 50 * ESTIMATED_BYTES_PER_FEATURE;
  progress.message = `Estimated ~${formatBytesShort(progress.estimatedSize)}`;
  onProgress({ ...progress });

  // Layer schemas: hash + capture every layer's field list now so
  // the deployment manifest carries the snapshot. Sync time uses
  // these to detect schema drift (#199 / docs).
  const layerSchemas: Record<string, CachedLayerSchema> = {};
  for (const l of input.layers) {
    const schemaHash = await hashLayerSchema(l.fields);
    layerSchemas[`${l.dataLayerId}:${l.layerKey}`] = {
      dataLayerId: l.dataLayerId,
      layerKey: l.layerKey,
      schemaHash,
      fields: l.fields,
    };
  }

  // Fetch features per layer, scoped to bbox when present.
  progress.phase = 'fetching-features';
  let totalFeatureBytes = 0;
  for (const layer of input.layers) {
    progress.message = `Fetching ${layer.layerLabel} features...`;
    onProgress({ ...progress });
    try {
      const url = buildFeatureUrl(
        layer.dataLayerId,
        layer.layerKey,
        input.bbox,
      );
      const res = await fetch(url);
      if (!res.ok) {
        progress.message = `${layer.layerLabel}: HTTP ${res.status}, skipping`;
        onProgress({ ...progress });
        continue;
      }
      const text = await res.text();
      totalFeatureBytes += text.length;
      let body: { features?: GeoJSON.Feature[] };
      try {
        body = JSON.parse(text) as { features?: GeoJSON.Feature[] };
      } catch {
        progress.message = `${layer.layerLabel}: malformed response, skipping`;
        onProgress({ ...progress });
        continue;
      }
      const features = body.features ?? [];
      const rows: CachedFeature[] = features.map((f) => {
        const props = (f.properties ?? {}) as Record<string, unknown>;
        // _global_id is the universal feature id we stamp server-side
        // so popups can recover it after MapLibre rewrites Feature.id
        // into a generated integer. It's also the natural key for the
        // cached-features store. Fall back to f.id when present, then
        // to a stable hash of the feature so we never lose a row.
        const globalId =
          (typeof props._global_id === 'string' && props._global_id) ||
          (typeof f.id === 'string' && f.id) ||
          stableId(f);
        return {
          dataCollectionId: input.dataCollectionId,
          dataLayerId: layer.dataLayerId,
          layerKey: layer.layerKey,
          globalId,
          feature: f,
          cachedAt: new Date().toISOString(),
        };
      });
      await putFeatures(rows);
      progress.featuresFetched += features.length;
      progress.message = `${layer.layerLabel}: ${features.length} features cached`;
      onProgress({ ...progress });
    } catch (err) {
      // A single layer failing shouldn't take the whole download down.
      // Surface a warning and move on; the deployment manifest will
      // still record what we did manage to cache.
      const reason = err instanceof Error ? err.message : String(err);
      progress.message = `${layer.layerLabel}: ${reason} (skipped)`;
      onProgress({ ...progress });
    }
  }

  // Fetch bound forms.
  progress.phase = 'fetching-forms';
  const boundFormIds = Array.from(
    new Set(
      input.layers
        .map((l) => l.boundFormItemId)
        .filter((s): s is string => typeof s === 'string'),
    ),
  );
  for (const formId of boundFormIds) {
    progress.message = `Fetching form ${formId.slice(0, 8)}...`;
    onProgress({ ...progress });
    try {
      const res = await fetch(`/api/portal/items/${formId}`);
      if (!res.ok) continue;
      const item = (await res.json()) as { data?: FormSchema };
      if (!item.data) continue;
      await putForm({
        dataCollectionId: input.dataCollectionId,
        formItemId: formId,
        schema: item.data,
        cachedAt: new Date().toISOString(),
      });
      progress.formsFetched += 1;
    } catch {
      /* swallow individual form failures; deployment can still work
         with auto-generated forms for the missing bindings */
    }
  }

  // Fetch pick lists.
  progress.phase = 'fetching-picklists';
  for (const pickListId of input.pickListIds) {
    progress.message = `Fetching pick list ${pickListId.slice(0, 8)}...`;
    onProgress({ ...progress });
    try {
      const res = await fetch(`/api/portal/items/${pickListId}`);
      if (!res.ok) continue;
      const item = (await res.json()) as { data?: PickListData };
      if (!item.data) continue;
      await putPickList({
        dataCollectionId: input.dataCollectionId,
        pickListItemId: pickListId,
        data: item.data,
        cachedAt: new Date().toISOString(),
      });
      progress.pickListsFetched += 1;
    } catch {
      /* same swallow rationale as forms above */
    }
  }

  // Persist the deployment manifest. cachedAt is the moment-of-truth
  // for the offline indicator; the field runtime reads it to decide
  // whether to show "cached on Apr 30" vs "Download for offline".
  progress.phase = 'persisting';
  progress.message = 'Saving deployment manifest...';
  onProgress({ ...progress });

  const manifest: CachedDeployment = {
    dataCollectionId: input.dataCollectionId,
    title: input.title,
    slug: deploymentSlug(input.title),
    mapId: input.mapId,
    layerSchemas,
    cachedAt: new Date().toISOString(),
    estimatedSize: totalFeatureBytes,
  };
  if (input.bbox !== undefined) manifest.bbox = input.bbox;
  await putDeployment(manifest);

  progress.phase = 'done';
  progress.message = `Cached ${progress.featuresFetched} features, ${progress.formsFetched} forms, ${progress.pickListsFetched} pick lists.`;
  progress.estimatedSize = totalFeatureBytes;
  onProgress({ ...progress });

  return manifest;
}

/**
 * Build the URL for a layer's GeoJSON. v3 multi-layer items hit the
 * per-sublayer endpoint; layerKey-less callers fall back to the
 * legacy item-level route (which now routes server-side to the
 * first spatial sublayer for v3 items per #194).
 */
function buildFeatureUrl(
  dataLayerId: string,
  layerKey: string,
  bbox: [number, number, number, number] | undefined,
): string {
  const base = `/api/portal/items/${dataLayerId}/layers/${encodeURIComponent(layerKey)}/geojson`;
  if (!bbox) return base;
  const qs = new URLSearchParams({
    bbox: bbox.join(','),
  });
  return `${base}?${qs.toString()}`;
}

/**
 * Pin a feature to a string id when neither _global_id nor f.id is
 * available. Stable across calls (same feature -> same key) so a
 * re-download doesn't double-cache the same row. Hash of the
 * canonical-JSON serialised geometry + properties.
 */
function stableId(f: GeoJSON.Feature): string {
  const text = JSON.stringify({
    geometry: f.geometry,
    properties: f.properties,
  });
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return `synth:${h.toString(16).padStart(8, '0')}`;
}

/** Compact byte formatter for the progress messages. */
function formatBytesShort(n: number): string {
  if (n < 1024) return `${n}B`;
  const kb = n / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}
