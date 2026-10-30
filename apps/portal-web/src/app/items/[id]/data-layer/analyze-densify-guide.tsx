// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

/**
 * Guided Densify action on the Analyze workbench
 * (R8-analyze-densify-shortcut).
 *
 * Same honesty stance as Buffer / Simplify: Analyze does not fake
 * an in-browser densify. It opens a max-segment-length / unit form
 * and POSTs a single-step `derived_layer` recipe that runs
 * `ST_Segmentize` on geography via PostGIS.
 */
import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Waypoints } from 'lucide-react';
import {
  LENGTH_UNITS,
  UNIT_LABELS,
  type LengthUnit,
} from '@gratis-gis/shared-types';
import { toast } from '@/lib/toast';
import { useFormat } from '@/lib/i18n/format';
import { useT } from '@/lib/i18n/locale-context';
import {
  MAX_DENSIFY_SEGMENT_METERS,
  MIN_DENSIFY_SEGMENT_METERS,
  buildDensifyDerivedLayerCreatePayload,
  clampDensifySegmentLength,
  defaultDensifyDerivedLayerTitle,
  validateDensifySegmentLength,
} from '@/lib/analyze-densify-derived';

interface Props {
  /** Expand the form on mount (Analyze ?tool= deep link). */
  defaultOpen?: boolean;
  itemId: string;
  /** v3 sublayer id; stamped as derived_layer.source.layerKey. */
  layerKey: string;
  sourceLabel: string;
}

export function AnalyzeDensifyGuide({
  itemId,
  layerKey,
  sourceLabel,
  defaultOpen = false
}: Props) {
  const router = useRouter();
  const fmt = useFormat();
  const t = useT();
  const [open, setOpen] = useState(defaultOpen);
  const [maxSegmentLength, setMaxSegmentLength] = useState(100);
  const [unit, setUnit] = useState<LengthUnit>('meters');
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);

  const suggestedTitle = useMemo(
    () =>
      defaultDensifyDerivedLayerTitle(sourceLabel, maxSegmentLength, unit),
    [sourceLabel, maxSegmentLength, unit],
  );

  // Locale overlay on the same checks as validateDensifySegmentLength.
  const densifyReason = validateDensifySegmentLength(maxSegmentLength, unit);
  const validationError = !LENGTH_UNITS.includes(unit)
    ? t('analyzeWorkbench.densifyValidateUnit')
    : !Number.isFinite(maxSegmentLength) || maxSegmentLength <= 0
      ? t('analyzeWorkbench.densifyValidateEmpty')
      : densifyReason && /at least/.test(densifyReason)
        ? t('analyzeWorkbench.densifyValidateMin', {
            meters: fmt.number(MIN_DENSIFY_SEGMENT_METERS),
          })
        : densifyReason && /at most/.test(densifyReason)
          ? t('analyzeWorkbench.densifyValidateMax', {
              meters: fmt.number(MAX_DENSIFY_SEGMENT_METERS),
            })
          : densifyReason
            ? t('analyzeWorkbench.densifyValidateEmpty')
            : null;

  async function createDensifyLayer(): Promise<void> {
    if (busy || validationError) return;
    setBusy(true);
    try {
      const payload = buildDensifyDerivedLayerCreatePayload({
        title: title.trim() || suggestedTitle,
        sourceLabel,
        sourceItemId: itemId,
        layerKey,
        maxSegmentLength: clampDensifySegmentLength(maxSegmentLength, unit),
        unit,
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
        title={t('analyzeWorkbench.densifyActionTitle')}
        className="inline-flex items-center gap-1 rounded-full border border-border bg-surface-1 px-2 py-0.5 text-2xs text-ink-1 hover:bg-surface-2"
      >
        <Waypoints className="h-3 w-3" aria-hidden />
        {t('analyzeWorkbench.densifyAction')}
      </button>
    );
  }

  return (
    <div className="w-full rounded-md border border-border bg-surface-1 p-2.5 space-y-2">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-xs font-medium text-ink-0">
            {t('analyzeWorkbench.densifyHeading')}
          </p>
          <p className="text-2xs text-muted">
            {t('analyzeWorkbench.densifyIntroBefore')}{' '}
            <span className="font-mono">ST_Segmentize</span>{' '}
            {t('analyzeWorkbench.densifyIntroAfter')}{' '}
            <a
              href="/help/analysis/densify"
              className="underline underline-offset-2 hover:text-ink-1"
            >
              {t('analyzeWorkbench.densifyHelpLink')}
            </a>
            {t('analyzeWorkbench.densifyIntroTail')}
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
          <span>{t('analyzeWorkbench.densifyMaxSegment')}</span>
          <input
            type="number"
            min={0}
            step={1}
            value={Number.isFinite(maxSegmentLength) ? maxSegmentLength : 0}
            onChange={(e) =>
              setMaxSegmentLength(
                clampDensifySegmentLength(Number(e.target.value), unit) ||
                  Number(e.target.value),
              )
            }
            disabled={busy}
            className="h-7 w-24 rounded-md border border-border bg-surface-0 px-2 text-xs text-ink-0 focus:border-accent focus:outline-hidden disabled:opacity-50"
            aria-label={t('analyzeWorkbench.densifyMaxSegmentAria')}
          />
        </label>
        <label className="flex flex-col gap-0.5 text-2xs text-ink-1">
          <span>{t('analyzeWorkbench.densifyUnit')}</span>
          <select
            value={unit}
            onChange={(e) => setUnit(e.target.value as LengthUnit)}
            disabled={busy}
            className="h-7 rounded-md border border-border bg-surface-0 px-2 text-xs text-ink-0 focus:border-accent focus:outline-hidden disabled:opacity-50"
            aria-label={t('analyzeWorkbench.densifyUnitAria')}
          >
            {LENGTH_UNITS.map((u) => (
              <option key={u} value={u}>
                {u} ({UNIT_LABELS[u]})
              </option>
            ))}
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
          onClick={() => void createDensifyLayer()}
          disabled={busy || Boolean(validationError)}
          className="inline-flex h-7 items-center gap-1.5 rounded-md bg-ink-1 px-2.5 text-xs font-medium text-surface-0 hover:opacity-90 disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
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
          {t('analyzeWorkbench.densifyLimitHint', {
            minMeters: fmt.number(MIN_DENSIFY_SEGMENT_METERS),
            maxMeters: fmt.number(MAX_DENSIFY_SEGMENT_METERS),
          })}
        </p>
      )}
    </div>
  );
}
