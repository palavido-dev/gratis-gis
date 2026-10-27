// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

/**
 * Guided Buffer action on the Analyze workbench
 * (R4-analyze-buffer-derived).
 *
 * Meter buffers need PROJ data that DuckDB-WASM does not ship
 * honestly, so this control never invents an in-browser buffer.
 * It opens a distance/unit form and POSTs a single-step
 * `derived_layer` recipe that runs on PostGIS — the same path as
 * Create → Derived layer → Buffer.
 */
import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { CircleDashed, Loader2 } from 'lucide-react';
import {
  LENGTH_UNITS,
  MAX_BUFFER_DISTANCE_METERS,
  UNIT_LABELS,
  type LengthUnit,
} from '@gratis-gis/shared-types';
import { toast } from '@/lib/toast';
import { useFormat } from '@/lib/i18n/format';
import {
  buildBufferDerivedLayerCreatePayload,
  clampBufferDistance,
  defaultBufferDerivedLayerTitle,
  validateFixedBufferDistance,
} from '@/lib/analyze-buffer-derived';

interface Props {
  itemId: string;
  /** v3 sublayer id; stamped as derived_layer.source.layerKey. */
  layerKey: string;
  sourceLabel: string;
}

export function AnalyzeBufferGuide({
  itemId,
  layerKey,
  sourceLabel,
}: Props) {
  const router = useRouter();
  const fmt = useFormat();
  const [open, setOpen] = useState(false);
  const [distance, setDistance] = useState(100);
  const [unit, setUnit] = useState<LengthUnit>('meters');
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);

  const suggestedTitle = useMemo(
    () => defaultBufferDerivedLayerTitle(sourceLabel, distance, unit),
    [sourceLabel, distance, unit],
  );

  const validationError = validateFixedBufferDistance(distance, unit);

  async function createBufferLayer(): Promise<void> {
    if (busy || validationError) return;
    setBusy(true);
    try {
      const payload = buildBufferDerivedLayerCreatePayload({
        title: title.trim() || suggestedTitle,
        sourceLabel,
        sourceItemId: itemId,
        layerKey,
        distance: clampBufferDistance(distance, unit),
        unit,
      });
      const res = await fetch('/api/portal/items', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        throw new Error(
          `Could not create the derived layer (${res.status}): ${await res
            .text()
            .catch(() => '')}`,
        );
      }
      const created = (await res.json()) as { id?: string };
      if (!created?.id) {
        throw new Error(
          'The derived layer was created but the response had no id.',
        );
      }
      toast.success(`Derived layer "${payload.title}" created`);
      router.push(`/items/${created.id}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => {
          setOpen(true);
          setTitle(suggestedTitle);
        }}
        title="Create a server-side derived layer buffer (PostGIS). Meter buffers are not offered in the browser."
        className="inline-flex items-center gap-1 rounded-full border border-border bg-surface-1 px-2 py-0.5 text-2xs text-ink-1 hover:bg-surface-2"
      >
        <CircleDashed className="h-3 w-3" aria-hidden />
        Buffer this layer
      </button>
    );
  }

  return (
    <div className="w-full rounded-md border border-border bg-surface-1 p-2.5 space-y-2">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-xs font-medium text-ink-0">
            Buffer this layer (server derived layer)
          </p>
          <p className="text-2xs text-muted">
            Creates a private derived layer that runs{' '}
            <span className="font-mono">ST_Buffer</span> on PostGIS —
            geodesic meters, not a browser degree trap. Same recipe as{' '}
            <a
              href="/help/analysis/buffer"
              className="underline underline-offset-2 hover:text-ink-1"
            >
              Buffer help
            </a>
            . Not gated on the optional server-heavy analysis tier.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setOpen(false)}
          disabled={busy}
          className="h-7 rounded-md border border-border bg-surface-0 px-2 text-2xs text-ink-1 hover:bg-surface-2 disabled:opacity-50"
        >
          Cancel
        </button>
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-0.5 text-2xs text-ink-1">
          <span>Distance</span>
          <input
            type="number"
            min={0}
            step={1}
            value={Number.isFinite(distance) ? distance : 0}
            onChange={(e) =>
              setDistance(
                clampBufferDistance(Number(e.target.value), unit) ||
                  Number(e.target.value),
              )
            }
            disabled={busy}
            className="h-7 w-24 rounded-md border border-border bg-surface-0 px-2 text-xs text-ink-0 focus:border-accent focus:outline-hidden disabled:opacity-50"
            aria-label="Buffer distance"
          />
        </label>
        <label className="flex flex-col gap-0.5 text-2xs text-ink-1">
          <span>Unit</span>
          <select
            value={unit}
            onChange={(e) => setUnit(e.target.value as LengthUnit)}
            disabled={busy}
            className="h-7 rounded-md border border-border bg-surface-0 px-2 text-xs text-ink-0 focus:border-accent focus:outline-hidden disabled:opacity-50"
            aria-label="Buffer distance unit"
          >
            {LENGTH_UNITS.map((u) => (
              <option key={u} value={u}>
                {u} ({UNIT_LABELS[u]})
              </option>
            ))}
          </select>
        </label>
        <label className="flex min-w-[12rem] flex-1 flex-col gap-0.5 text-2xs text-ink-1">
          <span>Title</span>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={suggestedTitle}
            disabled={busy}
            className="h-7 rounded-md border border-border bg-surface-0 px-2 text-xs text-ink-0 focus:border-accent focus:outline-hidden disabled:opacity-50"
            aria-label="Derived layer title"
          />
        </label>
        <button
          type="button"
          onClick={() => void createBufferLayer()}
          disabled={busy || Boolean(validationError)}
          className="inline-flex h-7 items-center gap-1.5 rounded-md bg-ink-1 px-2.5 text-xs font-medium text-surface-0 hover:opacity-90 disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
          {busy ? 'Creating…' : 'Create derived layer'}
        </button>
      </div>

      {validationError ? (
        <p className="text-2xs text-danger" role="alert">
          {validationError}
        </p>
      ) : (
        <p className="text-2xs text-muted">
          Up to {fmt.number(MAX_BUFFER_DISTANCE_METERS)} m. Expect a
          short server job; open the new item to map or refresh the
          result.
        </p>
      )}
    </div>
  );
}
