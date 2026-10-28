// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

/**
 * Guided Calculate geometry action on the Analyze workbench
 * (R9-analyze-calculate-geometry-shortcut).
 *
 * Same honesty stance as Densify / Buffer: Analyze does not invent
 * area_m2() expression helpers. It opens a measurement / unit /
 * field-name form and POSTs a single-step `calculate-geometry`
 * derived_layer recipe that runs PostGIS geography measures.
 * Calculate field stays a separate builder path.
 */
import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Calculator, Loader2 } from 'lucide-react';
import {
  AREA_UNIT_LABELS,
  AREA_UNITS,
  LENGTH_UNITS,
  UNIT_LABELS,
  type AreaUnit,
  type LengthUnit,
} from '@gratis-gis/shared-types';
import { toast } from '@/lib/toast';
import { useT } from '@/lib/i18n/locale-context';
import {
  type CalculateGeometryMeasurement,
  buildCalculateGeometryDerivedLayerCreatePayload,
  defaultCalculateGeometryDerivedLayerTitle,
  validateCalculateGeometryParams,
} from '@/lib/analyze-calculate-geometry-derived';

interface Props {
  itemId: string;
  /** v3 sublayer id; stamped as derived_layer.source.layerKey. */
  layerKey: string;
  sourceLabel: string;
}

export function AnalyzeCalculateGeometryGuide({
  itemId,
  layerKey,
  sourceLabel,
}: Props) {
  const router = useRouter();
  const t = useT();
  const [open, setOpen] = useState(false);
  const [measurement, setMeasurement] =
    useState<CalculateGeometryMeasurement>('area');
  const [unit, setUnit] = useState<LengthUnit | AreaUnit>('acres');
  const [fieldName, setFieldName] = useState('acres');
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);

  const suggestedTitle = useMemo(
    () =>
      defaultCalculateGeometryDerivedLayerTitle(
        sourceLabel,
        measurement,
        unit,
      ),
    [sourceLabel, measurement, unit],
  );

  const validationError = (() => {
    const reason = validateCalculateGeometryParams(
      measurement,
      unit,
      fieldName,
    );
    if (!reason) return null;
    if (/Enter a field/.test(reason)) {
      return t('analyzeWorkbench.calcGeomValidateFieldEmpty');
    }
    if (/reserved/.test(reason)) {
      return t('analyzeWorkbench.calcGeomValidateFieldReserved', {
        name: fieldName.trim(),
      });
    }
    if (/letter or underscore/.test(reason) || /characters or fewer/.test(reason)) {
      return t('analyzeWorkbench.calcGeomValidateFieldFormat');
    }
    if (/area unit/.test(reason)) {
      return t('analyzeWorkbench.calcGeomValidateAreaUnit');
    }
    if (/length unit/.test(reason)) {
      return t('analyzeWorkbench.calcGeomValidateLengthUnit');
    }
    return t('analyzeWorkbench.calcGeomValidateFieldEmpty');
  })();

  function changeMeasurement(next: CalculateGeometryMeasurement): void {
    if (next === measurement) return;
    setMeasurement(next);
    if (next === 'area') {
      setUnit('acres');
      setFieldName((prev) => (prev === 'length_m' || prev === 'perimeter_m' ? 'acres' : prev || 'acres'));
    } else {
      setUnit('meters');
      setFieldName((prev) =>
        prev === 'acres' || prev === 'area'
          ? next === 'perimeter'
            ? 'perimeter_m'
            : 'length_m'
          : prev || (next === 'perimeter' ? 'perimeter_m' : 'length_m'),
      );
    }
  }

  async function createCalculateGeometryLayer(): Promise<void> {
    if (busy || validationError) return;
    setBusy(true);
    try {
      const payload = buildCalculateGeometryDerivedLayerCreatePayload({
        title: title.trim() || suggestedTitle,
        sourceLabel,
        sourceItemId: itemId,
        layerKey,
        measurement,
        unit,
        fieldName,
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
        title={t('analyzeWorkbench.calcGeomActionTitle')}
        className="inline-flex items-center gap-1 rounded-full border border-border bg-surface-1 px-2 py-0.5 text-2xs text-ink-1 hover:bg-surface-2"
      >
        <Calculator className="h-3 w-3" aria-hidden />
        {t('analyzeWorkbench.calcGeomAction')}
      </button>
    );
  }

  return (
    <div className="w-full rounded-md border border-border bg-surface-1 p-2.5 space-y-2">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-xs font-medium text-ink-0">
            {t('analyzeWorkbench.calcGeomHeading')}
          </p>
          <p className="text-2xs text-muted">
            {t('analyzeWorkbench.calcGeomIntroBefore')}{' '}
            <span className="font-mono">ST_Length</span> /{' '}
            <span className="font-mono">ST_Area</span>{' '}
            {t('analyzeWorkbench.calcGeomIntroAfter')}{' '}
            <a
              href="/help/analysis/calculate"
              className="underline underline-offset-2 hover:text-ink-1"
            >
              {t('analyzeWorkbench.calcGeomHelpLink')}
            </a>
            {t('analyzeWorkbench.calcGeomIntroTail')}
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

      <div
        className="grid grid-cols-3 gap-1.5"
        role="radiogroup"
        aria-label={t('analyzeWorkbench.calcGeomMeasurementAria')}
      >
        {(
          [
            ['length', 'analyzeWorkbench.calcGeomMeasurement_length'],
            ['perimeter', 'analyzeWorkbench.calcGeomMeasurement_perimeter'],
            ['area', 'analyzeWorkbench.calcGeomMeasurement_area'],
          ] as const
        ).map(([m, labelKey]) => (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={measurement === m}
            onClick={() => changeMeasurement(m)}
            disabled={busy}
            className={`h-7 rounded-md border px-2 text-2xs capitalize transition-colors disabled:opacity-50 ${
              measurement === m
                ? 'border-accent bg-accent/5 text-ink-0 ring-1 ring-accent/30'
                : 'border-border bg-surface-0 text-ink-1 hover:bg-surface-2'
            }`}
          >
            {t(labelKey)}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-0.5 text-2xs text-ink-1">
          <span>{t('analyzeWorkbench.calcGeomUnit')}</span>
          <select
            value={unit}
            onChange={(e) =>
              setUnit(e.target.value as LengthUnit | AreaUnit)
            }
            disabled={busy}
            className="h-7 rounded-md border border-border bg-surface-0 px-2 text-xs text-ink-0 focus:border-accent focus:outline-hidden disabled:opacity-50"
            aria-label={t('analyzeWorkbench.calcGeomUnitAria')}
          >
            {measurement === 'area'
              ? AREA_UNITS.map((u) => (
                  <option key={u} value={u}>
                    {u} ({AREA_UNIT_LABELS[u]})
                  </option>
                ))
              : LENGTH_UNITS.map((u) => (
                  <option key={u} value={u}>
                    {u} ({UNIT_LABELS[u]})
                  </option>
                ))}
          </select>
        </label>
        <label className="flex flex-col gap-0.5 text-2xs text-ink-1">
          <span>{t('analyzeWorkbench.calcGeomFieldName')}</span>
          <input
            type="text"
            value={fieldName}
            onChange={(e) => setFieldName(e.target.value)}
            maxLength={60}
            disabled={busy}
            className="h-7 w-32 rounded-md border border-border bg-surface-0 px-2 text-xs text-ink-0 focus:border-accent focus:outline-hidden disabled:opacity-50"
            aria-label={t('analyzeWorkbench.calcGeomFieldNameAria')}
          />
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
          onClick={() => void createCalculateGeometryLayer()}
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
          {t('analyzeWorkbench.calcGeomHint')}
        </p>
      )}
    </div>
  );
}
