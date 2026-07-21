'use client';
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Terrain analysis section on an elevation layer's page. Each
 * button queues a worker job that lands as a NEW item in the
 * user's content:
 *
 *   - Contour lines: gdal_contour -> data_layer (via the analysis
 *     bridge + the async import pipeline).
 *   - Steepness map: gdaldem slope -> colored raster tile_layer.
 *
 * Visibility and Elevation profile are interactive, so they live
 * inside maps; this section just points at them.
 */

import { useState } from 'react';
import Link from 'next/link';
import { ChartSpline, Loader2, Mountain, Waves } from 'lucide-react';

const M_TO_FT = 3.28084;

interface QueuedResult {
  targetItemId: string;
  label: string;
}

export function DemAnalysisSection({
  itemId,
  canEdit,
}: {
  itemId: string;
  canEdit: boolean;
}) {
  const metric =
    typeof window !== 'undefined' &&
    window.localStorage.getItem('gg-profile-units') === 'metric';
  const [intervalVal, setIntervalVal] = useState(metric ? '3' : '10');
  const [busy, setBusy] = useState<'contours' | 'steepness' | null>(null);
  const [queued, setQueued] = useState<QueuedResult[]>([]);
  const [error, setError] = useState<string | null>(null);

  async function queueJob(
    kind: 'contours' | 'steepness',
    body: Record<string, unknown>,
    label: string,
  ) {
    setBusy(kind);
    setError(null);
    try {
      const res = await fetch(
        `/api/portal/items/${itemId}/analysis/${kind}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      );
      if (!res.ok) {
        const payload = (await res.json().catch(() => null)) as {
          message?: string | string[];
        } | null;
        const msg = Array.isArray(payload?.message)
          ? payload.message.join(' ')
          : payload?.message;
        setError(msg || 'The job could not be started.');
        return;
      }
      const out = (await res.json()) as { targetItemId: string };
      setQueued((cur) => [
        ...cur,
        { targetItemId: out.targetItemId, label },
      ]);
    } catch {
      setError('The job could not be started.');
    } finally {
      setBusy(null);
    }
  }

  function submitContours() {
    const v = Number(intervalVal);
    if (!Number.isFinite(v) || v <= 0) {
      setError('Enter a height between lines.');
      return;
    }
    const intervalM = metric ? v : v / M_TO_FT;
    void queueJob('contours', { intervalM }, 'Contour lines');
  }

  return (
    <section className="overflow-hidden rounded-lg border border-border bg-surface-1 shadow-card">
      <div className="border-b border-border bg-surface-2 px-4 py-3">
        <h3 className="text-sm font-medium text-ink-0">
          Terrain analysis
        </h3>
        <p className="mt-0.5 text-xs text-muted">
          Turn this elevation layer into new layers. Each result
          shows up as its own item in your content, ready to add to
          maps and share.
        </p>
      </div>
      <div className="space-y-3 p-4 text-sm">
        <div className="flex flex-wrap items-end gap-2">
          <label className="block text-xs text-muted">
            Height between lines ({metric ? 'm' : 'ft'})
            <input
              type="number"
              value={intervalVal}
              min={1}
              onChange={(e) => setIntervalVal(e.target.value)}
              disabled={!canEdit || busy !== null}
              className="mt-1 block w-32 rounded-md border border-border bg-surface-2 px-2 py-1.5 text-sm text-ink-0 disabled:opacity-50"
            />
          </label>
          <button
            type="button"
            onClick={submitContours}
            disabled={!canEdit || busy !== null}
            className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border bg-surface-1 px-3 text-sm font-medium text-ink-1 shadow-card hover:bg-surface-2 disabled:opacity-50"
          >
            {busy === 'contours' ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Waves className="h-4 w-4" />
            )}
            Draw contour lines
          </button>
          <button
            type="button"
            onClick={() =>
              void queueJob('steepness', {}, 'Steepness map')
            }
            disabled={!canEdit || busy !== null}
            className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border bg-surface-1 px-3 text-sm font-medium text-ink-1 shadow-card hover:bg-surface-2 disabled:opacity-50"
          >
            {busy === 'steepness' ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Mountain className="h-4 w-4" />
            )}
            Make a steepness map
          </button>
        </div>
        {!canEdit ? (
          <p className="text-xs text-muted">
            Creating layers requires the contributor or admin role.
          </p>
        ) : null}
        {error ? (
          <p className="text-xs text-danger" role="alert">
            {error}
          </p>
        ) : null}
        {queued.map((q) => (
          <p
            key={q.targetItemId}
            className="rounded-md border border-success/30 bg-success/10 px-3 py-2 text-xs text-ink-1"
          >
            Working on it. {q.label} will be ready in a few minutes:{' '}
            <Link
              href={`/items/${q.targetItemId}`}
              className="font-medium text-success underline-offset-2 hover:underline"
            >
              view the new item
            </Link>
            .
          </p>
        ))}
        <p className="flex items-center gap-1.5 text-xs text-muted">
          <ChartSpline className="h-3.5 w-3.5" />
          Looking for the elevation profile or visibility tools?
          They live in the map toolbar; open any map with this
          terrain.
        </p>
      </div>
    </section>
  );
}
