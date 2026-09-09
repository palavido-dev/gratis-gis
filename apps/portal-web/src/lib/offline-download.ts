// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Download manager for caching a data_collection deployment for
 * offline use. Walks every editable layer, fetches its features
 * scoped to the deployment's bbox (when configured), persists to
 * IndexedDB along with form schemas and pick lists, and writes a
 * deployment manifest record so subsequent visits can detect the
 * cached state.
 *
 * Tile caching is intentionally NOT in this module yet; see
 * docs/field-offline-recovery.md for the staged plan. The map will
 * render with empty basemap tiles when offline at the cost of
 * pretty pictures, but feature data + forms + pick-lists work.
 *
 * The progress callback fires after each meaningful step so the UI
 * can render a live status without polling.
 */

import type {
  FeatureField,
  OfflineMessage,
  PickListData,
} from '@gratis-gis/shared-types';
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
import {
  estimateTileCount,
  warmTiles,
  WARMER_MAX_TILES,
} from './offline-tile-warmer';
import {
  downloadOfflineBasemap,
  storedBasemapSize,
} from './offline-basemap';

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
    | 'caching-tiles'
    | 'persisting'
    | 'done'
    | 'failed';
  /**
   * Status line, as a code plus params rather than a sentence.
   *
   * The download modal renders it live, but the same vocabulary is what
   * `partial.reasons` persists into the deployment manifest, and that
   * outlives the download by weeks. One representation for both, turned
   * into words by `lib/offline-message.ts` at the render site.
   */
  message: OfflineMessage;
  /** Estimated total bytes that will be cached. Updated through the
   *  estimating phase; final value lands in the deployment manifest. */
  estimatedSize: number;
  /** Total number of editable layers in this deployment. Surfaced
   *  in the final summary so an empty deployment (zero features,
   *  zero forms, zero picklists) doesn't render as "nothing
   *  happened"; the user sees "Cached N layers offline; sync
   *  stays current as you add features." instead. */
  layerCount: number;
  /** Counts updated as the run progresses. */
  featuresFetched: number;
  formsFetched: number;
  pickListsFetched: number;
  /** Slice 10: tiles fetched and total tiles to fetch in this run.
   *  When the deployment doesn't carry tile templates, both stay at
   *  0 and the UI hides the tile progress row. */
  tilesFetched: number;
  tilesTotal: number;
  /**
   * Tile sources skipped because the provider forbids pre-fetching,
   * with a reason per source. Distinct from `error`: the download
   * succeeded, the basemap just is not coming with it.
   */
  blockedTileSources?: Array<{
    template: string;
    host: string;
    reason: string;
  }>;
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
  /** Slice 10: basemap (and optional reference-layer) tile URL
   *  templates with {z}/{x}/{y} placeholders. The download manager
   *  pre-fetches every tile inside the deployment's bbox at the
   *  configured zoom range so the field map renders offline.
   *  Omitted when the deployment has no tiled basemap (vector-style
   *  basemaps, MVT-only, or admin hasn't configured a basemap on
   *  the map yet); the runtime degrades to blank tiles offline,
   *  same as today. */
  tileUrlTemplates?: string[];
  /** Inclusive zoom range to warm. Defaults to [12, 17] (urban /
   *  mid-detail field work) when caller omits it. */
  tileZoomRange?: [number, number];
  /**
   * #71: basemap packages the portal has already built for this
   * deployment, one per prepared area. When present they replace
   * tile warming outright: a few single-file downloads of megabytes
   * each instead of enumerating a million tiles, and it is the only
   * path that produces a map which draws with no signal at all.
   * Every ready area downloads, so a deployment split into crew
   * areas works from either end.
   *
   * The warmer stays as the fallback for deployments whose author
   * has not prepared an area.
   */
  preparedPackages?: Array<{ areaId: string; packageId: string }>;
}

/** Best-effort byte estimate per cached feature. Used by the
 *  estimating phase before we know the real count. Tuned from
 *  observation: a typical PostGIS feature with ~10 attributes
 *  serialised through ST_AsGeoJSON lands ~600 bytes. */
const ESTIMATED_BYTES_PER_FEATURE = 800;
/** Features assumed per layer before any are fetched. A guess, and
 *  labelled as one wherever it surfaces. */
const ASSUMED_FEATURES_PER_LAYER = 50;
/** Headroom for form schemas and pick lists, which are small and
 *  bounded. */
const FORMS_AND_PICKLISTS_HEADROOM_BYTES = 5 * 1024 * 1024;
/** Matches ESTIMATED_BYTES_PER_TILE_MISSING_HEADER in the warmer, so
 *  the pre-flight estimate and the bytes the warmer reports are the
 *  same arithmetic. */
const ESTIMATED_BYTES_PER_TILE = 25_000;
/** A prepared basemap package, before we have asked the server how
 *  big it is. Randolph County measured 10.2 MB; 25 covers a larger
 *  area without pretending to precision we do not have. */
const ASSUMED_PREPARED_PACKAGE_BYTES = 25 * 1024 * 1024;
/**
 * Zoom range this module warms when the caller does not specify one.
 *
 * Note this is NOT the warmer's own default, which is [12, 19]. The
 * warmer's upper bound was raised to 19 for parcel-edge work (#272)
 * but this module has always passed [12, 17] explicitly, so that
 * change never reached a field download. Left as it was rather than
 * quietly multiplying every deployment's tile count by about 16;
 * worth a decision, not a drive-by. Named here so the estimate and
 * the warm call cannot disagree about it, which they previously did.
 */
const DEFAULT_WARM_ZOOM: [number, number] = [12, 17];

/**
 * Whether a thrown error is the browser refusing a write for space.
 *
 * Both IndexedDB and the Cache API surface this as a DOMException
 * named QuotaExceededError, but Firefox has historically used the
 * legacy code 22 with a different name, so both are checked. Worth
 * distinguishing from any other failure because it is the one the
 * user can do something about, and the message should say so.
 *
 * Exported for its spec; nothing outside this module calls it.
 */
export function isQuotaError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { name?: unknown; code?: unknown };
  return (
    e.name === 'QuotaExceededError' ||
    e.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
    e.code === 22
  );
}

/**
 * What a download is about to cost, in bytes.
 *
 * The pre-flight quota guard used `layers * 50 * 800 + 5 MB` and
 * stopped there, while the same run could hand the tile warmer a bbox
 * worth up to 200,000 tiles: roughly 5 GB against an estimate of a few
 * hundred kilobytes. The guard could not refuse a download that had no
 * chance of fitting, which is the one job it has. Tiles usually
 * dominate the total, so leaving them out did not make the estimate
 * rough, it made it unrelated.
 *
 * Exported so the guard and the progress display share one
 * implementation. Two copies of this drifting apart is how it got
 * here.
 */
export function estimateDownloadBytes(input: {
  layers: unknown[];
  bbox?: [number, number, number, number];
  tileUrlTemplates?: string[];
  tileZoomRange?: [number, number];
  preparedPackages?: Array<{ areaId: string; packageId: string }>;
}): number {
  const features =
    input.layers.length *
    ASSUMED_FEATURES_PER_LAYER *
    ESTIMATED_BYTES_PER_FEATURE;

  // A prepared package replaces tile warming outright, so the two are
  // never both paid for. Mirrors the branch in downloadDeployment.
  if (input.preparedPackages && input.preparedPackages.length > 0) {
    return (
      features +
      FORMS_AND_PICKLISTS_HEADROOM_BYTES +
      input.preparedPackages.length * ASSUMED_PREPARED_PACKAGE_BYTES
    );
  }

  let tiles = 0;
  if (
    input.bbox &&
    input.tileUrlTemplates &&
    input.tileUrlTemplates.length > 0
  ) {
    // Count the tiles the warmer will actually walk, capped exactly
    // as it caps, then multiply by every permitted template: the
    // warmer fetches the bbox once per source.
    const perTemplate = Math.min(
      estimateTileCount(input.bbox, input.tileZoomRange ?? DEFAULT_WARM_ZOOM),
      WARMER_MAX_TILES,
    );
    tiles =
      perTemplate * input.tileUrlTemplates.length * ESTIMATED_BYTES_PER_TILE;
  }

  return features + FORMS_AND_PICKLISTS_HEADROOM_BYTES + tiles;
}

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
  signal?: AbortSignal,
): Promise<CachedDeployment> {
  const progress: DownloadProgress = {
    phase: 'estimating',
    message: { code: 'download.estimating' },
    estimatedSize: 0,
    layerCount: input.layers.length,
    featuresFetched: 0,
    formsFetched: 0,
    pickListsFetched: 0,
    tilesFetched: 0,
    tilesTotal: 0,
  };
  onProgress({ ...progress });

  // Estimating phase. Same arithmetic the pre-flight quota guard
  // used, so the number the user was shown before starting is the
  // number they see now. Real size is computed during persist when we
  // know byte counts.
  progress.estimatedSize = estimateDownloadBytes(input);
  progress.message = {
    code: 'download.estimated',
    params: { bytes: progress.estimatedSize },
  };
  onProgress({ ...progress });

  // Everything that did not make it into the cache. Non-empty means
  // the manifest is written as partial rather than as ready, so the
  // badge cannot promise offline coverage the cache does not have.
  const shortfalls: OfflineMessage[] = [];
  let outOfSpace = false;
  const noteShortfall = (what: OfflineMessage, err?: unknown) => {
    if (isQuotaError(err)) outOfSpace = true;
    shortfalls.push(what);
  };

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
    progress.message = {
      code: 'download.fetchingLayer',
      params: { layer: layer.layerLabel },
    };
    onProgress({ ...progress });
    try {
      const url = buildFeatureUrl(
        layer.dataLayerId,
        layer.layerKey,
        input.bbox,
      );
      const res = await fetch(url);
      if (!res.ok) {
        // The same message serves as the live line and as the entry in
        // the manifest's shortfall list, so the two cannot disagree
        // about what went wrong with this layer.
        const failure: OfflineMessage = {
          code: 'download.layerHttpError',
          params: { layer: layer.layerLabel, status: res.status },
        };
        noteShortfall(failure);
        progress.message = failure;
        onProgress({ ...progress });
        continue;
      }
      const text = await res.text();
      totalFeatureBytes += text.length;
      let body: { features?: GeoJSON.Feature[] };
      try {
        body = JSON.parse(text) as { features?: GeoJSON.Feature[] };
      } catch {
        const failure: OfflineMessage = {
          code: 'download.layerMalformed',
          params: { layer: layer.layerLabel },
        };
        noteShortfall(failure);
        progress.message = failure;
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
      progress.message = {
        code: 'download.layerCached',
        params: { layer: layer.layerLabel, count: features.length },
      };
      onProgress({ ...progress });
    } catch (err) {
      // A single layer failing shouldn't take the whole download down.
      // Surface a warning and move on; the deployment manifest will
      // still record what we did manage to cache.
      const failure: OfflineMessage = isQuotaError(err)
        ? {
            code: 'download.layerOutOfSpace',
            params: { layer: layer.layerLabel },
          }
        : {
            code: 'download.layerFailed',
            params: {
              layer: layer.layerLabel,
              error: err instanceof Error ? err.message : String(err),
            },
          };
      noteShortfall(failure, err);
      progress.message = failure;
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
    const form = formId.slice(0, 8);
    progress.message = { code: 'download.fetchingForm', params: { form } };
    onProgress({ ...progress });
    try {
      const res = await fetch(`/api/portal/items/${formId}`);
      if (!res.ok) {
        noteShortfall({
          code: 'download.formHttpError',
          params: { form, status: res.status },
        });
        continue;
      }
      const item = (await res.json()) as { data?: FormSchema };
      if (!item.data) {
        noteShortfall({ code: 'download.formNoSchema', params: { form } });
        continue;
      }
      await putForm({
        dataCollectionId: input.dataCollectionId,
        formItemId: formId,
        schema: item.data,
        cachedAt: new Date().toISOString(),
      });
      progress.formsFetched += 1;
    } catch (err) {
      // The deployment can still work with auto-generated forms for
      // the missing bindings, so this is a shortfall rather than a
      // failure. It is not nothing, though: the collector gets a
      // different form offline than online, which is worth recording.
      noteShortfall({ code: 'download.formFailed', params: { form } }, err);
    }
  }

  // Fetch pick lists.
  progress.phase = 'fetching-picklists';
  for (const pickListId of input.pickListIds) {
    const pickList = pickListId.slice(0, 8);
    progress.message = {
      code: 'download.fetchingPickList',
      params: { pickList },
    };
    onProgress({ ...progress });
    try {
      const res = await fetch(`/api/portal/items/${pickListId}`);
      if (!res.ok) {
        noteShortfall({
          code: 'download.pickListHttpError',
          params: { pickList, status: res.status },
        });
        continue;
      }
      const item = (await res.json()) as { data?: PickListData };
      if (!item.data) {
        noteShortfall({
          code: 'download.pickListNoData',
          params: { pickList },
        });
        continue;
      }
      await putPickList({
        dataCollectionId: input.dataCollectionId,
        pickListItemId: pickListId,
        data: item.data,
        cachedAt: new Date().toISOString(),
      });
      progress.pickListsFetched += 1;
    } catch (err) {
      // A missing pick list means a choice field offline renders with
      // no choices, which stops a collector mid-form. Recorded.
      noteShortfall(
        { code: 'download.pickListFailed', params: { pickList } },
        err,
      );
    }
  }

  // Slice 10: warm the basemap tile cache so the field map renders
  // offline. The service worker intercepts every fetch and writes
  // responses into TILES_CACHE; the warmer's job is just to call
  // fetch() for each tile coord in the bbox at the deployment's
  // configured zoom range. Skipped silently when the deployment
  // has no tile templates (vector-style basemap, MVT-only,
  // unconfigured, etc); the runtime degrades to blank tiles
  // offline as it did before, but feature data + forms still work.
  if (input.preparedPackages && input.preparedPackages.length > 0) {
    // #71: the author prepared areas, so there are single files to
    // fetch. Takes precedence over tile warming unconditionally: a
    // prepared package is both smaller and the only version that
    // renders with no signal, so warming as well would be pure
    // waste against somebody else's tile server.
    progress.phase = 'caching-tiles';
    onProgress({ ...progress });
    const count = input.preparedPackages.length;
    for (let i = 0; i < count; i += 1) {
      const pkg = input.preparedPackages[i]!;
      // A deployment with one prepared area should not read "map 1 of
      // 1", and the i18n runtime cannot nest a placeholder inside a
      // plural case, so the two shapes are separate codes rather than
      // one message with a count.
      const index = i + 1;
      const only = count === 1;
      progress.message = only
        ? { code: 'download.basemapOne' }
        : { code: 'download.basemapNth', params: { index, count } };
      onProgress({ ...progress });
      try {
        await downloadOfflineBasemap(
          input.dataCollectionId,
          pkg.areaId,
          pkg.packageId,
          (p) => {
            if (p.totalBytes) {
              const percent = Math.round((p.receivedBytes / p.totalBytes) * 100);
              progress.message = only
                ? { code: 'download.basemapOnePercent', params: { percent } }
                : {
                    code: 'download.basemapNthPercent',
                    params: { index, count, percent },
                  };
            } else {
              // No Content-Length: report what has arrived instead of a
              // percentage of an unknown total.
              const megabytes = (p.receivedBytes / 1024 / 1024).toFixed(1);
              progress.message = only
                ? { code: 'download.basemapOneMegabytes', params: { megabytes } }
                : {
                    code: 'download.basemapNthMegabytes',
                    params: { index, count, megabytes },
                  };
            }
            onProgress({ ...progress });
          },
          signal,
        );
        const stored = await storedBasemapSize(
          input.dataCollectionId,
          pkg.areaId,
        );
        if (stored) totalFeatureBytes += stored;
      } catch (err) {
        if (signal?.aborted) throw err;
        // The data above is already cached and useful on its own,
        // and the remaining areas may still succeed, so one failed
        // map degrades to "that area stays online-only" rather than
        // losing the whole run. It is still a hole in the cache: a
        // map that does not draw is the most visible way for a
        // collector to discover their download was incomplete.
        noteShortfall(
          {
            code: 'download.basemapAreaMissing',
            params: { area: pkg.areaId.slice(0, 8) },
          },
          err,
        );
        progress.message = isQuotaError(err)
          ? { code: 'download.basemapOutOfSpace' }
          : {
              code: 'download.basemapFailed',
              params: {
                error: err instanceof Error ? err.message : String(err),
              },
            };
        onProgress({ ...progress });
      }
    }
  } else if (
    input.tileUrlTemplates &&
    input.tileUrlTemplates.length > 0 &&
    input.bbox
  ) {
    progress.phase = 'caching-tiles';
    progress.message = { code: 'download.cachingTiles' };
    onProgress({ ...progress });
    try {
      const warmResult = await warmTiles(
        {
          urlTemplates: input.tileUrlTemplates,
          bbox: input.bbox,
          zoomRange: input.tileZoomRange ?? DEFAULT_WARM_ZOOM,
        },
        (p) => {
          progress.tilesFetched = p.fetched;
          progress.tilesTotal = p.total;
          progress.message = {
            code: 'download.tilesProgress',
            params: { fetched: p.fetched, total: p.total },
          };
          onProgress({ ...progress });
        },
        signal,
      );
      // Roll the tile bytes into the deployment manifest's size
      // estimate so the field UI's "Cached: 14 MB" reflects the
      // total footprint (features + tiles), not just the IndexedDB
      // slice. This is what users want to see when deciding which
      // areas to keep cached vs free up.
      totalFeatureBytes += warmResult.bytes;
      // A refusal is not a failure, and must not read like one. If
      // every source was refused the map will be blank offline, and
      // the reader needs to know that is the provider's rule rather
      // than a broken download, because the fix (self-host the
      // basemap) is theirs to make.
      const refused = warmResult.refused ?? [];
      if (refused.length > 0 && warmResult.total === 0) {
        progress.blockedTileSources = refused;
        // The provider's own sentence, worded by the tile-prefetch
        // policy table. Carried as a param rather than restated,
        // because only that table knows which provider said no and what
        // the reader can do about it.
        const reason = refused[0]?.reason;
        progress.message = reason
          ? { code: 'download.tilesRefused', params: { reason } }
          : { code: 'download.tilesRefusedGeneric' };
      } else {
        if (refused.length > 0) progress.blockedTileSources = refused;
        progress.message = {
          code: 'download.tilesCached',
          params: { fetched: warmResult.fetched, failed: warmResult.failed },
        };
      }
      // Tiles that did not land mean a basemap with holes in it, so
      // the manifest should not read as fully cached. A provider
      // refusal is deliberately NOT counted: that is the provider's
      // rule, reported separately as blockedTileSources, and marking
      // the whole deployment partial for it would cry wolf on every
      // download that uses a public basemap.
      if (warmResult.failed > 0) {
        noteShortfall({
          code: 'download.tilesMissing',
          params: { count: warmResult.failed },
        });
      }
      onProgress({ ...progress });
    } catch (err) {
      // Tile-warming is best-effort; a failure here doesn't void
      // the rest of the cache. Surface the message so the user
      // knows tiles may be incomplete, then continue to persist.
      noteShortfall({ code: 'download.tilesMissingAll' }, err);
      progress.message = isQuotaError(err)
        ? { code: 'download.tilesOutOfSpace' }
        : {
            code: 'download.tilesFailed',
            params: {
              error: err instanceof Error ? err.message : 'failed',
            },
          };
      onProgress({ ...progress });
    }
  }

  // warmTiles stops quietly on abort rather than throwing, so without
  // this a cancelled run would fall through, write a manifest, and
  // report "Ready for offline" over a half-warmed cache. Everything
  // already written to IndexedDB stays: the caller says so, and it
  // is genuinely useful on its own.
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

  // Persist the deployment manifest. cachedAt is the moment-of-truth
  // for the offline indicator; the field runtime reads it to decide
  // whether to show "cached on Apr 30" vs "Download for offline".
  progress.phase = 'persisting';
  progress.message = { code: 'download.saving' };
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
  // Record the holes. Everything cached above stays, because a
  // partial cache is genuinely useful, but the manifest has to carry
  // the truth: this used to write "cached" unconditionally, and a
  // collector reading "Ready for offline" would drive out of signal
  // on the strength of it.
  if (shortfalls.length > 0) {
    manifest.partial = { reasons: shortfalls, outOfSpace };
  }
  await putDeployment(manifest);

  progress.phase = 'done';
  // The summary carries the counts; which of them are worth naming, and
  // in what words, is decided by the renderer. That is why a run with
  // zero features still reports a layer count rather than the old
  // "Cached 0 features, 0 forms, 0 picklists", which read like a
  // download that did nothing.
  //
  // A run with holes in it leads with what is missing: the collector is
  // about to decide whether to leave signal on the strength of this
  // line, so burying the gap after the good news is the wrong order.
  const counts = {
    layers: progress.layerCount,
    features: progress.featuresFetched,
    forms: progress.formsFetched,
    pickLists: progress.pickListsFetched,
  };
  if (shortfalls.length > 0 && outOfSpace) {
    progress.message = {
      code: 'download.donePartialOutOfSpace',
      params: { missing: shortfalls },
    };
  } else if (shortfalls.length > 0) {
    progress.message = {
      code: 'download.donePartial',
      params: { ...counts, missing: shortfalls },
    };
  } else {
    progress.message = { code: 'download.done', params: counts };
  }
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
