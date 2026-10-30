// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

/**
 * Guided Fishnet action on the Analyze workbench
 * (R10-analyze-fishnet-shortcut).
 *
 * Same honesty stance as Densify / Buffer: Analyze does not fake
 * an in-browser fishnet. It opens a cell-size / unit / output form
 * and POSTs a single-step `derived_layer` recipe that runs
 * `ST_SquareGrid` via PostGIS. The chip is polygon-only; save-time
 * ~1e6 cell cap stays on the server enrich hook.
 */
import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Grid3x3, Loader2 } from 'lucide-react';
import {
  LENGTH_UNITS,
  UNIT_LABELS,
  type LengthUnit,
} from '@gratis-gis/shared-types';
import { toast } from '@/lib/toast';
import { useFormat } from '@/lib/i18n/format';
import { useT } from '@/lib/i18n/locale-context';
import {
  FISHNET_MAX_CELLS_HINT,
  MAX_FISHNET_CELL_METERS,
  MIN_FISHNET_CELL_METERS,
  buildFishnetDerivedLayerCreatePayload,
  clampFishnetCellSize,
  defaultFishnetDerivedLayerTitle,
  validateFishnetCellSize,
  type FishnetOutput,
} from '@/lib/analyze-fishnet-derived';

interface Props {
  /** Expand the form on mount (Analyze ?tool= deep link). */
  defaultOpen?: boolean;
  itemId: string;
  /** v3 sublayer id; stamped as derived_layer.source.layerKey. */
  layerKey: string;
  sourceLabel: string;
}

export function AnalyzeFishnetGuide({
  itemId,
  layerKey,
  sourceLabel,
  defaultOpen = false
}: Props) {
  const router = useRouter();
  const fmt = useFormat();
  const t = useT();
  const [open, setOpen] = useState(defaultOpen);
  const [cellSize, setCellSize] = useState(500);
  const [unit, setUnit] = useState<LengthUnit>('meters');
  const [output, setOutput] = useState<FishnetOutput>('polygons');
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);

  const suggestedTitle = useMemo(
    () =>
      defaultFishnetDerivedLayerTitle(sourceLabel, cellSize, unit, output),
    [sourceLabel, cellSize, unit, output],
  );

  const fishnetReason = validateFishnetCellSize(cellSize, unit, output);
  const validationError = !LENGTH_UNITS.includes(unit)
    ? t('analyzeWorkbench.fishnetValidateUnit')
    : !Number.isFinite(cellSize) || cellSize <= 0
      ? t('analyzeWorkbench.fishnetValidateEmpty')
      : fishnetReason && /at least/.test(fishnetReason)
        ? t('analyzeWorkbench.fishnetValidateMin', {
            meters: fmt.number(MIN_FISHNET_CELL_METERS),
          })
        : fishnetReason && /at most/.test(fishnetReason)
          ? t('analyzeWorkbench.fishnetValidateMax', {
              meters: fmt.number(MAX_FISHNET_CELL_METERS),
            })
          : fishnetReason && /polygons or lines/.test(fishnetReason)
            ? t('analyzeWorkbench.fishnetValidateOutput')
            : fishnetReason
              ? t('analyzeWorkbench.fishnetValidateEmpty')
              : null;

  async function createFishnetLayer(): Promise<void> {
    if (busy || validationError) return;
    setBusy(true);
    try {
      const payload = buildFishnetDerivedLayerCreatePayload({
        title: title.trim() || suggestedTitle,
        sourceLabel,
        sourceItemId: itemId,
        layerKey,
        cellSize: clampFishnetCellSize(cellSize, unit),
        unit,
        output,
      });
      const res = await fetch('/api/portal/items', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        throw new Error(
          t('analyzeWorkbench.bufferCreateFailed', {
            status: res.status,
            detail: await res.text().catch(() => ''),
          }),
        );
      }
      const created = (await res.json()) as { id?: string };
      if (!created?.id) {
        throw new Error(t('analyzeWorkbench.bufferMissingId'));
      }
      toast.success(
        t('analyzeWorkbench.bufferCreatedToast', { title: payload.title }),
      );
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
        title={t('analyzeWorkbench.fishnetActionTitle')}
        className="inline-flex items-center gap-1 rounded-full border border-border bg-surface-1 px-2 py-0.5 text-2xs text-ink-1 hover:bg-surface-2"
      >
        <Grid3x3 className="h-3 w-3" aria-hidden />
        {t('analyzeWorkbench.fishnetAction')}
      </button>
    );
  }

  return (
    <div className="w-full rounded-md border border-border bg-surface-1 p-2.5 space-y-2">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-xs font-medium text-ink-0">
            {t('analyzeWorkbench.fishnetHeading')}
          </p>
          <p className="text-2xs text-muted">
            {t('analyzeWorkbench.fishnetIntroBefore')}{' '}
            <span className="font-mono">ST_SquareGrid</span>{' '}
            {t('analyzeWorkbench.fishnetIntroAfter')}{' '}
            <a
              href="/help/analysis/fishnet"
              className="underline underline-offset-2 hover:text-ink-1"
            >
              {t('analyzeWorkbench.fishnetHelpLink')}
            </a>
            {t('analyzeWorkbench.fishnetIntroTail')}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setOpen(false)}
          disabled={busy}
          className="h-7 rounded-md border border-border bg-surface-0 px-2 text-2xs text-ink-1 hover:bg-surface-2 disabled:opacity-50"
        >
          {t('analyzeWorkbench.cancel')}
        </button>
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-0.5 text-2xs text-ink-1">
          <span>{t('analyzeWorkbench.fishnetCellSize')}</span>
          <input
            type="number"
            min={0}
            step={1}
            value={Number.isFinite(cellSize) ? cellSize : 0}
            onChange={(e) =>
              setCellSize(
                clampFishnetCellSize(Number(e.target.value), unit) ||
                  Number(e.target.value),
              )
            }
            disabled={busy}
            className="h-7 w-24 rounded-md border border-border bg-surface-0 px-2 text-xs text-ink-0 focus:border-accent focus:outline-hidden disabled:opacity-50"
            aria-label={t('analyzeWorkbench.fishnetCellSizeAria')}
          />
        </label>
        <label className="flex flex-col gap-0.5 text-2xs text-ink-1">
          <span>{t('analyzeWorkbench.fishnetUnit')}</span>
          <select
            value={unit}
            onChange={(e) => setUnit(e.target.value as LengthUnit)}
            disabled={busy}
            className="h-7 rounded-md border border-border bg-surface-0 px-2 text-xs text-ink-0 focus:border-accent focus:outline-hidden disabled:opacity-50"
            aria-label={t('analyzeWorkbench.fishnetUnitAria')}
          >
            {LENGTH_UNITS.map((u) => (
              <option key={u} value={u}>
                {u} ({UNIT_LABELS[u]})
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-0.5 text-2xs text-ink-1">
          <span>{t('analyzeWorkbench.fishnetOutput')}</span>
          <select
            value={output}
            onChange={(e) => setOutput(e.target.value as FishnetOutput)}
            disabled={busy}
            className="h-7 rounded-md border border-border bg-surface-0 px-2 text-xs text-ink-0 focus:border-accent focus:outline-hidden disabled:opacity-50"
            aria-label={t('analyzeWorkbench.fishnetOutputAria')}
          >
            <option value="polygons">
              {t('analyzeWorkbench.fishnetOutput_polygons')}
            </option>
            <option value="lines">
              {t('analyzeWorkbench.fishnetOutput_lines')}
            </option>
          </select>
        </label>
        <label className="flex min-w-[12rem] flex-1 flex-col gap-0.5 text-2xs text-ink-1">
          <span>{t('analyzeWorkbench.derivedTitle')}</span>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={suggestedTitle}
            disabled={busy}
            className="h-7 rounded-md border border-border bg-surface-0 px-2 text-xs text-ink-0 focus:border-accent focus:outline-hidden disabled:opacity-50"
            aria-label={t('analyzeWorkbench.derivedTitleAria')}
          />
        </label>
        <button
          type="button"
          onClick={() => void createFishnetLayer()}
          disabled={busy || Boolean(validationError)}
          className="inline-flex h-7 items-center gap-1.5 rounded-md bg-ink-1 px-2.5 text-xs font-medium text-surface-0 hover:opacity-90 disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : null}
          {busy
            ? t('analyzeWorkbench.creatingEllipsis')
            : t('analyzeWorkbench.createDerivedLayer')}
        </button>
      </div>

      {validationError ? (
        <p className="text-2xs text-danger" role="alert">
          {validationError}
        </p>
      ) : (
        <p className="text-2xs text-muted">
          {t('analyzeWorkbench.fishnetLimitHint', {
            minMeters: fmt.number(MIN_FISHNET_CELL_METERS),
            maxMeters: fmt.number(MAX_FISHNET_CELL_METERS),
            maxCells: fmt.number(FISHNET_MAX_CELLS_HINT),
          })}
        </p>
      )}
    </div>
  );
}
