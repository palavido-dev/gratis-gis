// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

/**
 * Guided Random sample action on the Analyze workbench
 * (R10-analyze-random-sample-shortcut).
 *
 * Same honesty stance as Top N: Analyze does not fake an
 * in-browser sample. It opens mode / value / seed controls
 * (with a client-side reshuffle) and POSTs a single-step
 * `random-sample` derived_layer recipe.
 */
import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Dices, Loader2 } from 'lucide-react';
import { toast } from '@/lib/toast';
import { useFormat } from '@/lib/i18n/format';
import { useT } from '@/lib/i18n/locale-context';
import {
  MAX_RANDOM_SAMPLE_COUNT,
  buildRandomSampleDerivedLayerCreatePayload,
  defaultRandomSampleDerivedLayerTitle,
  normalizeRandomSampleSeed,
  rollRandomSampleSeed,
  validateRandomSampleParams,
  type RandomSampleMode,
} from '@/lib/analyze-random-sample-derived';

interface Props {
  itemId: string;
  /** v3 sublayer id; stamped as derived_layer.source.layerKey. */
  layerKey: string;
  sourceLabel: string;
}

export function AnalyzeRandomSampleGuide({
  itemId,
  layerKey,
  sourceLabel,
}: Props) {
  const router = useRouter();
  const fmt = useFormat();
  const t = useT();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<RandomSampleMode>('percentage');
  const [value, setValue] = useState(10);
  const [seed, setSeed] = useState(() => rollRandomSampleSeed());
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);

  const suggestedTitle = useMemo(
    () => defaultRandomSampleDerivedLayerTitle(sourceLabel, mode, value),
    [sourceLabel, mode, value],
  );

  const sampleReason = validateRandomSampleParams(mode, value, seed);
  const validationError =
    sampleReason && /percentage or count/.test(sampleReason)
      ? t('analyzeWorkbench.randomSampleValidateMode')
      : sampleReason && /at most 100/.test(sampleReason)
        ? t('analyzeWorkbench.randomSampleValidatePct')
        : sampleReason && /positive integer/.test(sampleReason)
          ? t('analyzeWorkbench.randomSampleValidateCount')
          : sampleReason && /at most/.test(sampleReason)
            ? t('analyzeWorkbench.randomSampleValidateMax', {
                max: fmt.number(MAX_RANDOM_SAMPLE_COUNT),
              })
            : sampleReason && /positive number/.test(sampleReason)
              ? t('analyzeWorkbench.randomSampleValidateValue')
              : sampleReason && /Seed/.test(sampleReason)
                ? t('analyzeWorkbench.randomSampleValidateSeed')
                : sampleReason
                  ? t('analyzeWorkbench.randomSampleValidateValue')
                  : null;

  async function createSampleLayer(): Promise<void> {
    if (busy || validationError) return;
    setBusy(true);
    try {
      const payload = buildRandomSampleDerivedLayerCreatePayload({
        title: title.trim() || suggestedTitle,
        sourceLabel,
        sourceItemId: itemId,
        layerKey,
        mode,
        value: mode === 'count' ? Math.floor(value) : value,
        seed: normalizeRandomSampleSeed(seed),
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
        title={t('analyzeWorkbench.randomSampleActionTitle')}
        className="inline-flex items-center gap-1 rounded-full border border-border bg-surface-1 px-2 py-0.5 text-2xs text-ink-1 hover:bg-surface-2"
      >
        <Dices className="h-3 w-3" aria-hidden />
        {t('analyzeWorkbench.randomSampleAction')}
      </button>
    );
  }

  return (
    <div className="w-full rounded-md border border-border bg-surface-1 p-2.5 space-y-2">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-xs font-medium text-ink-0">
            {t('analyzeWorkbench.randomSampleHeading')}
          </p>
          <p className="text-2xs text-muted">
            {t('analyzeWorkbench.randomSampleIntroBefore')}{' '}
            <a
              href="/help/analysis/random-sample"
              className="underline underline-offset-2 hover:text-ink-1"
            >
              {t('analyzeWorkbench.randomSampleHelpLink')}
            </a>
            {t('analyzeWorkbench.randomSampleIntroTail')}
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
          <span>{t('analyzeWorkbench.randomSampleMode')}</span>
          <select
            value={mode}
            onChange={(e) => {
              const next =
                e.target.value === 'count' ? 'count' : 'percentage';
              setMode(next);
              setValue(next === 'count' ? 100 : 10);
            }}
            disabled={busy}
            className="h-7 rounded-md border border-border bg-surface-0 px-2 text-xs text-ink-0 focus:border-accent focus:outline-hidden disabled:opacity-50"
            aria-label={t('analyzeWorkbench.randomSampleModeAria')}
          >
            <option value="percentage">
              {t('analyzeWorkbench.randomSampleMode_percentage')}
            </option>
            <option value="count">
              {t('analyzeWorkbench.randomSampleMode_count')}
            </option>
          </select>
        </label>
        <label className="flex flex-col gap-0.5 text-2xs text-ink-1">
          <span>
            {mode === 'percentage'
              ? t('analyzeWorkbench.randomSampleValuePct')
              : t('analyzeWorkbench.randomSampleValueCount')}
          </span>
          <input
            type="number"
            min={mode === 'percentage' ? 0.0001 : 1}
            max={mode === 'percentage' ? 100 : MAX_RANDOM_SAMPLE_COUNT}
            step={mode === 'percentage' ? 'any' : 1}
            value={Number.isFinite(value) ? value : mode === 'count' ? 1 : 10}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (!Number.isFinite(n)) return;
              setValue(mode === 'count' ? Math.max(1, Math.floor(n)) : n);
            }}
            disabled={busy}
            className="h-7 w-24 rounded-md border border-border bg-surface-0 px-2 text-xs text-ink-0 focus:border-accent focus:outline-hidden disabled:opacity-50"
            aria-label={t('analyzeWorkbench.randomSampleValueAria')}
          />
        </label>
        <label className="flex flex-col gap-0.5 text-2xs text-ink-1">
          <span>{t('analyzeWorkbench.randomSampleSeed')}</span>
          <div className="flex items-center gap-1">
            <input
              type="number"
              min={1}
              step={1}
              value={normalizeRandomSampleSeed(seed)}
              onChange={(e) =>
                setSeed(normalizeRandomSampleSeed(Number(e.target.value) || 1))
              }
              disabled={busy}
              className="h-7 w-28 rounded-md border border-border bg-surface-0 px-2 text-xs text-ink-0 focus:border-accent focus:outline-hidden disabled:opacity-50"
              aria-label={t('analyzeWorkbench.randomSampleSeedAria')}
            />
            <button
              type="button"
              onClick={() => setSeed(rollRandomSampleSeed())}
              disabled={busy}
              className="h-7 rounded-md border border-border bg-surface-0 px-2 text-2xs text-ink-1 hover:bg-surface-2 disabled:opacity-50"
              title={t('analyzeWorkbench.randomSampleShuffleTitle')}
            >
              {t('analyzeWorkbench.randomSampleShuffle')}
            </button>
          </div>
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
          onClick={() => void createSampleLayer()}
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
          {t('analyzeWorkbench.randomSampleHint', {
            max: fmt.number(MAX_RANDOM_SAMPLE_COUNT),
          })}
        </p>
      )}
    </div>
  );
}
