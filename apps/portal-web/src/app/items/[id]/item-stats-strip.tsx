// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import { useEffect, useState } from 'react';
import type { LayerGeometryType } from '@gratis-gis/shared-types';
import { Skeleton } from '@/components/ui/skeleton';
import { useT } from '@/lib/i18n/locale-context';

/**
 * The six-cell summary under an item's preview: uppercase micro label
 * over a big value. (#52)
 *
 * Only mounted for v3 data_layers, which is the branch that had no
 * stats at all; v1/v2 keep the count card in their own editor.
 *
 * The feature count is FETCHED, not read from `data.layers[].
 * featureCount`. That stored number is stamped by the import worker
 * and by the housekeeping recompute, and by nothing else, so it drifts
 * the moment anyone edits a feature. It is also the global count,
 * while `aggregate` answers under the caller's own row scope and geo
 * limit. Reading the stored value would therefore both go stale and
 * over-report to a restricted viewer, in a cell whose whole job is to
 * be the authoritative number. When the fetch fails we say so rather
 * than falling back to the stored value, because a wrong number that
 * looks right is worse than an absent one.
 */

export interface StatsLayer {
  id: string;
  geometryType: LayerGeometryType;
  fieldCount: number;
}

interface Props {
  itemId: string;
  layers: StatsLayer[];
  updatedAt: string;
  /** "authName:authCode" of the source file before reprojection, or
   *  null when the source declared none. Explicitly `| undefined`
   *  because `exactOptionalPropertyTypes` is on and the caller reaches
   *  this through an optional chain. */
  sourceSrs?: string | null | undefined;
}

type CountState =
  | { status: 'loading' }
  | { status: 'ready'; total: number }
  | { status: 'failed' };

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const seconds = Math.round((then - Date.now()) / 1000);
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['year', 31536000],
    ['month', 2592000],
    ['day', 86400],
    ['hour', 3600],
    ['minute', 60],
  ];
  const fmt = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) {
      return fmt.format(Math.round(seconds / size), unit);
    }
  }
  return fmt.format(Math.round(seconds), 'second');
}

function Cell({
  label,
  children,
  title,
}: {
  label: string;
  children: React.ReactNode;
  title?: string;
}) {
  return (
    <div className="min-w-0 px-3 py-2" title={title}>
      <div className="text-2xs uppercase tracking-wide text-muted">{label}</div>
      <div className="mt-0.5 truncate text-lg font-semibold tabular-nums text-ink-0">
        {children}
      </div>
    </div>
  );
}

export function ItemStatsStrip({
  itemId,
  layers,
  updatedAt,
  sourceSrs,
}: Props) {
  const t = useT();
  const [count, setCount] = useState<CountState>({ status: 'loading' });

  // Primitive key, same reason the map preview beside this strip has
  // one: `layers` is built inline by the server component with .map(),
  // so it is a fresh array identity on every render, and
  // ImportJobsBanner calls router.refresh() every 2.5s while an
  // import runs. Depending on the array re-ran this effect, and each
  // run is one count aggregate PER LAYER, so a multi-layer import
  // burst-fired aggregates for its whole duration (2026-08-24
  // review). The joined string only changes when a layer actually
  // appears, disappears, or changes shape.
  const layerKey = layers.map((l) => `${l.id}:${l.fieldCount}`).join('|');

  useEffect(() => {
    let cancelled = false;
    const spatial = layers;
    if (spatial.length === 0) {
      setCount({ status: 'ready', total: 0 });
      return;
    }
    void (async () => {
      try {
        const totals = await Promise.all(
          spatial.map(async (layer) => {
            const res = await fetch(
              `/api/portal/items/${itemId}/layers/${encodeURIComponent(layer.id)}/aggregate?agg=count`,
              { headers: { accept: 'application/json' } },
            );
            if (!res.ok) throw new Error(`count failed: ${res.status}`);
            const body = (await res.json()) as {
              groups?: Array<{ values?: Record<string, number> }>;
            };
            const value = body.groups?.[0]?.values?.count;
            if (typeof value !== 'number') {
              throw new Error('count missing from response');
            }
            return value;
          }),
        );
        if (cancelled) return;
        setCount({
          status: 'ready',
          total: totals.reduce((sum, n) => sum + n, 0),
        });
      } catch {
        if (!cancelled) setCount({ status: 'failed' });
      }
    })();
    return () => {
      cancelled = true;
    };
    // `updatedAt` is in the deps so the ONE refresh that matters
    // still lands: the importer stamps the item when its queue
    // drains, updatedAt bumps, and the counts refetch once. Without
    // it the primitive key would leave the strip showing pre-import
    // counts forever.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemId, layerKey, updatedAt]);

  const geometries = new Set(
    layers.map((l) => l.geometryType).filter((g): g is LayerGeometryType => !!g),
  );
  const geometryValue =
    geometries.size === 0
      ? t('itemDetail.geometryNone')
      : geometries.size > 1
        ? t('itemDetail.statMixed')
        : {
            point: t('itemDetail.geometryPoint'),
            line: t('itemDetail.geometryLine'),
            polygon: t('itemDetail.geometryPolygon'),
          }[[...geometries][0] as string] ?? [...geometries][0];

  const fieldTotal = layers.reduce((sum, l) => sum + l.fieldCount, 0);

  // The source note is the honest half of the coordinates cell: we
  // always STORE 4326, so the only interesting fact is what it came
  // from. "CRS:unknown" is the ingest sentinel for "no declared SRS".
  const srsNote =
    !sourceSrs || sourceSrs === 'CRS:unknown'
      ? t('itemDetail.statCoordinatesUnknown')
      : sourceSrs === 'EPSG:4326'
        ? t('itemDetail.statCoordinatesNative')
        : t('itemDetail.statCoordinatesFrom', { srs: sourceSrs });

  return (
    <dl className="grid grid-cols-2 divide-x divide-y divide-border overflow-hidden rounded-md border border-border bg-surface-1 sm:grid-cols-3 lg:grid-cols-6 lg:divide-y-0">
      <Cell label={t('itemDetail.statFeatures')} title={t('itemDetail.statFeaturesTitle')}>
        {count.status === 'loading' ? (
          <Skeleton className="h-6 w-16" />
        ) : count.status === 'failed' ? (
          <span className="text-sm font-normal text-muted">
            {t('itemDetail.statUnavailable')}
          </span>
        ) : (
          count.total.toLocaleString()
        )}
      </Cell>
      <Cell label={t('itemDetail.statGeometry')}>{geometryValue}</Cell>
      <Cell
        label={t('itemDetail.statCoordinates')}
        title={t('itemDetail.statCoordinatesTitle', { source: srsNote })}
      >
        EPSG:4326
      </Cell>
      <Cell label={t('itemDetail.statFields')}>
        {fieldTotal.toLocaleString()}
      </Cell>
      <Cell label={t('itemDetail.statLayers')}>
        {layers.length.toLocaleString()}
      </Cell>
      <Cell label={t('itemDetail.statUpdated')}>
        {/* Relative time is computed from the clock, so the server
            render and the first client render can legitimately differ
            by a tick. */}
        <time
          dateTime={updatedAt}
          title={new Date(updatedAt).toLocaleString()}
          suppressHydrationWarning
          className="text-base"
        >
          {relativeTime(updatedAt)}
        </time>
      </Cell>
    </dl>
  );
}
