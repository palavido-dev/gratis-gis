// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import { Grid3x3 } from 'lucide-react';
import {
  MAX_FEATURES_PER_TILE,
  TILE_CACHE_MAX_AGE_MAX,
  TILE_ZOOM_MAX,
  TILE_ZOOM_MIN,
  type DataLayerSublayer,
  type LayerTileSettings,
} from '@gratis-gis/shared-types';
import { useT } from '@/lib/i18n/locale-context';

/** Settings while editing: a cleared box is `undefined`, dropped on save. */
type TileDraft = {
  [K in keyof LayerTileSettings]?: LayerTileSettings[K] | undefined;
};

/**
 * Owner controls for a layer's vector tiles: which fields the tiles
 * carry, the zoom range that returns features, a per-tile feature cap
 * and the browser cache age. Sits with the other layer-level switches
 * in the layer builder; saving the layer saves these, and the API
 * validates them (see apps/portal-api/src/data-layer/tile-settings.ts).
 *
 * Every control starts empty, which means "the server default", so an
 * owner who never opens this section changes nothing.
 */
export function TileSettingsSection({
  layer,
  onPatch,
  onReplace,
}: {
  layer: DataLayerSublayer;
  onPatch: (patch: Partial<DataLayerSublayer>) => void;
  onReplace: (next: DataLayerSublayer) => void;
}) {
  const t = useT();
  const tiles: LayerTileSettings = layer.tiles ?? {};
  const fieldNames = layer.fields.map((f) => f.name).filter((n) => n.length > 0);
  const selecting = tiles.fields !== undefined;
  const selected = new Set(tiles.fields ?? []);

  function update(next: TileDraft) {
    const clean: LayerTileSettings = {};
    for (const [k, v] of Object.entries(next) as Array<
      [keyof LayerTileSettings, TileDraft[keyof LayerTileSettings]]
    >) {
      if (v !== undefined) (clean as Record<string, unknown>)[k] = v;
    }
    const { tiles: _old, ...rest } = layer;
    void _old;
    if (Object.keys(clean).length === 0) {
      // Drop the key rather than store `{}`, so an untouched layer
      // round-trips byte-identical.
      onReplace(rest);
    } else {
      onPatch({ tiles: clean });
    }
  }

  function numberOrUndefined(raw: string): number | undefined {
    if (raw.trim() === '') return undefined;
    const n = Number(raw);
    return Number.isFinite(n) ? Math.trunc(n) : undefined;
  }

  const inputClass =
    'h-7 w-20 rounded border border-border bg-surface-1 px-2 text-2xs focus:border-accent focus:outline-hidden focus:ring-2 focus:ring-accent/30';

  return (
    <details className="rounded-md border border-border bg-surface-1/60 px-2 py-1.5 text-xs text-ink-1">
      <summary className="inline-flex cursor-pointer items-center gap-1.5 text-muted">
        <Grid3x3 className="h-3.5 w-3.5" />
        {t('tileSettings.heading')}
      </summary>
      <div className="mt-2 space-y-3">
        <p className="text-2xs text-muted">{t('tileSettings.intro')}</p>

        <fieldset className="space-y-1">
          <legend className="text-2xs font-medium uppercase tracking-wide text-muted">
            {t('tileSettings.fieldsHeading')}
          </legend>
          <label className="mr-4 inline-flex items-center gap-1.5">
            <input
              type="radio"
              name={`${layer.id}-tile-fields`}
              checked={!selecting}
              onChange={() => update({ ...tiles, fields: undefined })}
            />
            {t('tileSettings.allFields')}
          </label>
          <label className="inline-flex items-center gap-1.5">
            <input
              type="radio"
              name={`${layer.id}-tile-fields`}
              checked={selecting}
              onChange={() => update({ ...tiles, fields: [...fieldNames] })}
            />
            {t('tileSettings.someFields')}
          </label>
          {selecting ? (
            <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
              {fieldNames.length === 0 ? (
                <span className="text-2xs text-muted">{t('tileSettings.noFields')}</span>
              ) : (
                fieldNames.map((name) => (
                  <label key={name} className="inline-flex items-center gap-1.5 font-mono text-2xs">
                    <input
                      type="checkbox"
                      checked={selected.has(name)}
                      onChange={(e) => {
                        const next = new Set(selected);
                        if (e.target.checked) next.add(name);
                        else next.delete(name);
                        update({
                          ...tiles,
                          fields: fieldNames.filter((n) => next.has(n)),
                        });
                      }}
                      className="h-3.5 w-3.5 rounded border-border"
                    />
                    {name}
                  </label>
                ))
              )}
            </div>
          ) : null}
          <p className="text-2xs text-muted">{t('tileSettings.fieldsNote')}</p>
        </fieldset>

        <div className="flex flex-wrap items-end gap-4">
          <label className="flex flex-col gap-0.5">
            <span className="text-2xs text-muted">{t('tileSettings.minZoom')}</span>
            <input
              type="number"
              min={TILE_ZOOM_MIN}
              max={TILE_ZOOM_MAX}
              step={1}
              value={tiles.minZoom ?? ''}
              placeholder={String(TILE_ZOOM_MIN)}
              onChange={(e) =>
                update({ ...tiles, minZoom: numberOrUndefined(e.target.value) })
              }
              className={inputClass}
            />
          </label>
          <label className="flex flex-col gap-0.5">
            <span className="text-2xs text-muted">{t('tileSettings.maxZoom')}</span>
            <input
              type="number"
              min={TILE_ZOOM_MIN}
              max={TILE_ZOOM_MAX}
              step={1}
              value={tiles.maxZoom ?? ''}
              placeholder={String(TILE_ZOOM_MAX)}
              onChange={(e) =>
                update({ ...tiles, maxZoom: numberOrUndefined(e.target.value) })
              }
              className={inputClass}
            />
          </label>
          <label className="flex flex-col gap-0.5">
            <span className="text-2xs text-muted">{t('tileSettings.maxFeatures')}</span>
            <input
              type="number"
              min={1}
              max={MAX_FEATURES_PER_TILE}
              step={1}
              value={tiles.maxFeatures ?? ''}
              placeholder={String(MAX_FEATURES_PER_TILE)}
              onChange={(e) =>
                update({ ...tiles, maxFeatures: numberOrUndefined(e.target.value) })
              }
              className={inputClass}
            />
          </label>
          <label className="flex flex-col gap-0.5">
            <span className="text-2xs text-muted">{t('tileSettings.cacheMaxAge')}</span>
            <input
              type="number"
              min={0}
              max={TILE_CACHE_MAX_AGE_MAX}
              step={1}
              value={tiles.cacheMaxAge ?? ''}
              placeholder={t('tileSettings.default')}
              onChange={(e) =>
                update({ ...tiles, cacheMaxAge: numberOrUndefined(e.target.value) })
              }
              className={inputClass}
            />
          </label>
        </div>
        <p className="text-2xs text-muted">
          {t('tileSettings.zoomHint', { min: TILE_ZOOM_MIN, max: TILE_ZOOM_MAX })}{' '}
          {t('tileSettings.maxFeaturesHint', { max: MAX_FEATURES_PER_TILE })}{' '}
          {t('tileSettings.cacheHint', { max: TILE_CACHE_MAX_AGE_MAX })}
        </p>
      </div>
    </details>
  );
}
