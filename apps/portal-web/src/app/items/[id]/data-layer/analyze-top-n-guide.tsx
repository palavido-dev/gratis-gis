// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

/**
 * Guided Top N action on the Analyze workbench
 * (R10-analyze-top-n-shortcut).
 *
 * Same honesty stance as Calculate geometry: Analyze does not fake
 * an in-browser top-N. It opens a numeric-field / N / direction
 * form and POSTs a single-step `top-n` derived_layer recipe.
 */
import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowDownWideNarrow, Loader2 } from 'lucide-react';
import type { FeatureField } from '@gratis-gis/shared-types';
import { toast } from '@/lib/toast';
import { useFormat } from '@/lib/i18n/format';
import { useT } from '@/lib/i18n/locale-context';
import {
  MAX_TOP_N,
  buildTopNDerivedLayerCreatePayload,
  defaultTopNDerivedLayerTitle,
  numericFieldsForTopN,
  validateTopNParams,
  type TopNDirection,
} from '@/lib/analyze-top-n-derived';

interface Props {
  /** Expand the form on mount (Analyze ?tool= deep link). */
  defaultOpen?: boolean;
  itemId: string;
  /** v3 sublayer id; stamped as derived_layer.source.layerKey. */
  layerKey: string;
  sourceLabel: string;
  fields: FeatureField[];
}

export function AnalyzeTopNGuide({
  itemId,
  layerKey,
  sourceLabel,
  fields,
  defaultOpen = false
}: Props) {
  const router = useRouter();
  const fmt = useFormat();
  const t = useT();
  const numericFields = useMemo(() => numericFieldsForTopN(fields), [fields]);
  const [open, setOpen] = useState(defaultOpen);
  const [field, setField] = useState(numericFields[0]?.name ?? '');
  const [n, setN] = useState(10);
  const [direction, setDirection] = useState<TopNDirection>('desc');
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);

  const suggestedTitle = useMemo(
    () => defaultTopNDerivedLayerTitle(sourceLabel, field, n, direction),
    [sourceLabel, field, n, direction],
  );

  const topNReason = validateTopNParams(field, n, direction, fields);
  const validationError =
    numericFields.length === 0
      ? t('analyzeWorkbench.topNValidateNoNumeric')
      : !field.trim()
        ? t('analyzeWorkbench.topNValidateField')
        : topNReason && /not a numeric/.test(topNReason)
          ? t('analyzeWorkbench.topNValidateField')
          : topNReason && /positive integer/.test(topNReason)
            ? t('analyzeWorkbench.topNValidateN')
            : topNReason && /at most/.test(topNReason)
              ? t('analyzeWorkbench.topNValidateMax', {
                  max: fmt.number(MAX_TOP_N),
                })
              : topNReason && /ascending or descending/.test(topNReason)
                ? t('analyzeWorkbench.topNValidateDirection')
                : topNReason
                  ? t('analyzeWorkbench.topNValidateField')
                  : null;

  async function createTopNLayer(): Promise<void> {
    if (busy || validationError) return;
    setBusy(true);
    try {
      const payload = buildTopNDerivedLayerCreatePayload({
        title: title.trim() || suggestedTitle,
        sourceLabel,
        sourceItemId: itemId,
        layerKey,
        field: field.trim(),
        n: Math.floor(n),
        direction,
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
        title={t('analyzeWorkbench.topNActionTitle')}
        className="inline-flex items-center gap-1 rounded-full border border-border bg-surface-1 px-2 py-0.5 text-2xs text-ink-1 hover:bg-surface-2"
      >
        <ArrowDownWideNarrow className="h-3 w-3" aria-hidden />
        {t('analyzeWorkbench.topNAction')}
      </button>
    );
  }

  return (
    <div className="w-full rounded-md border border-border bg-surface-1 p-2.5 space-y-2">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-xs font-medium text-ink-0">
            {t('analyzeWorkbench.topNHeading')}
          </p>
          <p className="text-2xs text-muted">
            {t('analyzeWorkbench.topNIntroBefore')}{' '}
            <a
              href="/help/analysis/top-n"
              className="underline underline-offset-2 hover:text-ink-1"
            >
              {t('analyzeWorkbench.topNHelpLink')}
            </a>
            {t('analyzeWorkbench.topNIntroTail')}
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
          <span>{t('analyzeWorkbench.topNField')}</span>
          <select
            value={field}
            onChange={(e) => setField(e.target.value)}
            disabled={busy || numericFields.length === 0}
            className="h-7 rounded-md border border-border bg-surface-0 px-2 text-xs text-ink-0 focus:border-accent focus:outline-hidden disabled:opacity-50"
            aria-label={t('analyzeWorkbench.topNFieldAria')}
          >
            {field === '' ? (
              <option value="">
                {numericFields.length === 0
                  ? t('analyzeWorkbench.topNNoNumeric')
                  : t('analyzeWorkbench.topNPickField')}
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
          <span>{t('analyzeWorkbench.topNN')}</span>
          <input
            type="number"
            min={1}
            step={1}
            value={Number.isFinite(n) ? n : 1}
            onChange={(e) =>
              setN(Math.max(1, Math.floor(Number(e.target.value)) || 1))
            }
            disabled={busy}
            className="h-7 w-20 rounded-md border border-border bg-surface-0 px-2 text-xs text-ink-0 focus:border-accent focus:outline-hidden disabled:opacity-50"
            aria-label={t('analyzeWorkbench.topNNAria')}
          />
        </label>
        <label className="flex flex-col gap-0.5 text-2xs text-ink-1">
          <span>{t('analyzeWorkbench.topNDirection')}</span>
          <select
            value={direction}
            onChange={(e) =>
              setDirection(e.target.value === 'asc' ? 'asc' : 'desc')
            }
            disabled={busy}
            className="h-7 rounded-md border border-border bg-surface-0 px-2 text-xs text-ink-0 focus:border-accent focus:outline-hidden disabled:opacity-50"
            aria-label={t('analyzeWorkbench.topNDirectionAria')}
          >
            <option value="desc">{t('analyzeWorkbench.topNDir_desc')}</option>
            <option value="asc">{t('analyzeWorkbench.topNDir_asc')}</option>
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
          onClick={() => void createTopNLayer()}
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
          {t('analyzeWorkbench.topNHint', { max: fmt.number(MAX_TOP_N) })}
        </p>
      )}
    </div>
  );
}
