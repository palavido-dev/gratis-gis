// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

/**
 * Guided Contour action on the Analyze workbench
 * (R11-analyze-contour-shortcut).
 *
 * Same honesty stance as Top N / Fishnet: Analyze does not fake
 * in-browser TIN contours. It opens a numeric-field / interval /
 * optional min-max form and POSTs a single-step `contour`
 * derived_layer recipe (auto mode only). Point layers only.
 */
import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ChartNoAxesColumnIncreasing, Loader2 } from 'lucide-react';
import type { FeatureField } from '@gratis-gis/shared-types';
import { toast } from '@/lib/toast';
import { useFormat } from '@/lib/i18n/format';
import { useT } from '@/lib/i18n/locale-context';
import {
  MAX_CONTOUR_LEVELS,
  buildContourDerivedLayerCreatePayload,
  defaultContourDerivedLayerTitle,
  numericFieldsForContour,
  validateContourParams,
} from '@/lib/analyze-contour-derived';

interface Props {
  itemId: string;
  /** v3 sublayer id; stamped as derived_layer.source.layerKey. */
  layerKey: string;
  sourceLabel: string;
  fields: FeatureField[];
}

function parseOptionalNumber(raw: string): number | undefined {
  const t = raw.trim();
  if (t === '') return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : Number.NaN;
}

export function AnalyzeContourGuide({
  itemId,
  layerKey,
  sourceLabel,
  fields,
}: Props) {
  const router = useRouter();
  const fmt = useFormat();
  const t = useT();
  const numericFields = useMemo(() => numericFieldsForContour(fields), [fields]);
  const [open, setOpen] = useState(false);
  const [field, setField] = useState(numericFields[0]?.name ?? '');
  const [interval, setInterval] = useState(10);
  const [minRaw, setMinRaw] = useState('');
  const [maxRaw, setMaxRaw] = useState('');
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);

  const minLevel = parseOptionalNumber(minRaw);
  const maxLevel = parseOptionalNumber(maxRaw);

  const suggestedTitle = useMemo(
    () => defaultContourDerivedLayerTitle(sourceLabel, field, interval),
    [sourceLabel, field, interval],
  );

  const contourReason = validateContourParams(
    field,
    interval,
    fields,
    minLevel,
    maxLevel,
  );
  const validationError =
    numericFields.length === 0
      ? t('analyzeWorkbench.contourValidateNoNumeric')
      : !field.trim()
        ? t('analyzeWorkbench.contourValidateField')
        : contourReason && /not a numeric/.test(contourReason)
          ? t('analyzeWorkbench.contourValidateField')
          : contourReason && /positive number/.test(contourReason)
            ? t('analyzeWorkbench.contourValidateInterval')
            : contourReason && /strictly less/.test(contourReason)
              ? t('analyzeWorkbench.contourValidateRange')
              : contourReason && /finite number/.test(contourReason)
                ? t('analyzeWorkbench.contourValidateRange')
                : contourReason
                  ? t('analyzeWorkbench.contourValidateField')
                  : null;

  async function createContourLayer(): Promise<void> {
    if (busy || validationError) return;
    setBusy(true);
    try {
      const payload = buildContourDerivedLayerCreatePayload({
        title: title.trim() || suggestedTitle,
        sourceLabel,
        sourceItemId: itemId,
        layerKey,
        field: field.trim(),
        interval,
        ...(minLevel !== undefined && Number.isFinite(minLevel)
          ? { minLevel }
          : {}),
        ...(maxLevel !== undefined && Number.isFinite(maxLevel)
          ? { maxLevel }
          : {}),
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
          if (!field && numericFields[0]) setField(numericFields[0].name);
          setTitle(suggestedTitle);
        }}
        title={t('analyzeWorkbench.contourActionTitle')}
        className="inline-flex items-center gap-1 rounded-full border border-border bg-surface-1 px-2 py-0.5 text-2xs text-ink-1 hover:bg-surface-2"
      >
        <ChartNoAxesColumnIncreasing className="h-3 w-3" aria-hidden />
        {t('analyzeWorkbench.contourAction')}
      </button>
    );
  }

  return (
    <div className="w-full rounded-md border border-border bg-surface-1 p-2.5 space-y-2">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-xs font-medium text-ink-0">
            {t('analyzeWorkbench.contourHeading')}
          </p>
          <p className="text-2xs text-muted">
            {t('analyzeWorkbench.contourIntroBefore')}{' '}
            <a
              href="/help/analysis/contour"
              className="underline underline-offset-2 hover:text-ink-1"
            >
              {t('analyzeWorkbench.contourHelpLink')}
            </a>
            {t('analyzeWorkbench.contourIntroTail')}
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
        <label className="flex min-w-[10rem] flex-col gap-0.5 text-2xs text-ink-1">
          <span>{t('analyzeWorkbench.contourField')}</span>
          <select
            value={field}
            onChange={(e) => setField(e.target.value)}
            disabled={busy || numericFields.length === 0}
            className="h-7 rounded-md border border-border bg-surface-0 px-2 text-xs text-ink-0 focus:border-accent focus:outline-hidden disabled:opacity-50"
            aria-label={t('analyzeWorkbench.contourFieldAria')}
          >
            {field === '' ? (
              <option value="">
                {numericFields.length === 0
                  ? t('analyzeWorkbench.contourNoNumeric')
                  : t('analyzeWorkbench.contourPickField')}
              </option>
            ) : null}
            {numericFields.map((f) => (
              <option key={f.name} value={f.name}>
                {f.label || f.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-0.5 text-2xs text-ink-1">
          <span>{t('analyzeWorkbench.contourInterval')}</span>
          <input
            type="number"
            min={Number.MIN_VALUE}
            step="any"
            value={Number.isFinite(interval) ? interval : 10}
            onChange={(e) => {
              const n = Number(e.target.value);
              setInterval(Number.isFinite(n) ? n : Number.NaN);
            }}
            disabled={busy}
            className="h-7 w-24 rounded-md border border-border bg-surface-0 px-2 text-xs text-ink-0 focus:border-accent focus:outline-hidden disabled:opacity-50"
            aria-label={t('analyzeWorkbench.contourIntervalAria')}
          />
        </label>
        <label className="flex flex-col gap-0.5 text-2xs text-ink-1">
          <span>{t('analyzeWorkbench.contourMin')}</span>
          <input
            type="number"
            step="any"
            value={minRaw}
            onChange={(e) => setMinRaw(e.target.value)}
            placeholder={t('analyzeWorkbench.contourOptional')}
            disabled={busy}
            className="h-7 w-24 rounded-md border border-border bg-surface-0 px-2 text-xs text-ink-0 focus:border-accent focus:outline-hidden disabled:opacity-50"
            aria-label={t('analyzeWorkbench.contourMinAria')}
          />
        </label>
        <label className="flex flex-col gap-0.5 text-2xs text-ink-1">
          <span>{t('analyzeWorkbench.contourMax')}</span>
          <input
            type="number"
            step="any"
            value={maxRaw}
            onChange={(e) => setMaxRaw(e.target.value)}
            placeholder={t('analyzeWorkbench.contourOptional')}
            disabled={busy}
            className="h-7 w-24 rounded-md border border-border bg-surface-0 px-2 text-xs text-ink-0 focus:border-accent focus:outline-hidden disabled:opacity-50"
            aria-label={t('analyzeWorkbench.contourMaxAria')}
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
          onClick={() => void createContourLayer()}
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
          {t('analyzeWorkbench.contourHint', {
            max: fmt.number(MAX_CONTOUR_LEVELS),
          })}
        </p>
      )}
    </div>
  );
}
