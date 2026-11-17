// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

/**
 * Guided Erase action on the Analyze workbench
 * (R6-analyze-erase-shortcut / R7-i18n-erase-centroid-guides).
 *
 * Same honesty stance as Clip: Analyze does not fake a browser
 * erase. It opens a short form, picks a second data_layer as the
 * mask to subtract, and POSTs a single-step `derived_layer` recipe
 * that runs on PostGIS — the same path as Create → Derived layer
 * → Erase.
 */
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Eraser, Loader2 } from 'lucide-react';
import { toast } from '@/lib/toast';
import { useT } from '@/lib/i18n/locale-context';
import {
  buildEraseDerivedLayerCreatePayload,
  defaultEraseDerivedLayerTitle,
  validateEraseOtherSource,
} from '@/lib/analyze-erase-derived';

interface EraseOption {
  id: string;
  title: string;
}

interface Props {
  /** Expand the form on mount (Analyze ?tool= deep link). */
  defaultOpen?: boolean;
  itemId: string;
  /** v3 sublayer id; stamped as derived_layer.source.layerKey. */
  layerKey: string;
  sourceLabel: string;
}

export function AnalyzeEraseGuide({
  itemId,
  layerKey,
  sourceLabel,
  defaultOpen = false
}: Props) {
  const router = useRouter();
  const t = useT();
  const [open, setOpen] = useState(defaultOpen);
  const [options, setOptions] = useState<EraseOption[]>([]);
  const [eraseItemId, setEraseItemId] = useState('');
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      setLoadError(null);
      try {
        const res = await fetch(
          '/api/portal/items?type=data_layer&lite=1&limit=100',
        );
        if (!res.ok) {
          if (!cancelled) {
            setLoadError(t('analyzeWorkbench.eraseLoadFailed'));
          }
          return;
        }
        const rows = (await res.json()) as Array<{ id: string; title: string }>;
        if (cancelled) return;
        setOptions(
          rows
            .filter((r) => r.id !== itemId)
            .map((r) => ({ id: r.id, title: r.title || r.id })),
        );
      } catch {
        if (!cancelled) {
          setLoadError(t('analyzeWorkbench.eraseLoadFailed'));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, itemId, t]);

  const eraseLabel =
    options.find((o) => o.id === eraseItemId)?.title || 'erase mask';

  const suggestedTitle = useMemo(
    () => defaultEraseDerivedLayerTitle(sourceLabel, eraseLabel),
    [sourceLabel, eraseLabel],
  );

  const rawValidation = validateEraseOtherSource(eraseItemId, itemId);
  const validationError = !eraseItemId.trim()
    ? t('analyzeWorkbench.eraseValidateEmpty')
    : eraseItemId.trim() === itemId.trim()
      ? t('analyzeWorkbench.eraseValidateSelf')
      : rawValidation;

  async function createEraseLayer(): Promise<void> {
    if (busy || validationError) return;
    setBusy(true);
    try {
      const payload = buildEraseDerivedLayerCreatePayload({
        title: title.trim() || suggestedTitle,
        sourceLabel,
        eraseLabel,
        sourceItemId: itemId,
        layerKey,
        eraseItemId,
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
          setTitle('');
          setEraseItemId('');
        }}
        title={t('analyzeWorkbench.eraseActionTitle')}
        className="inline-flex items-center gap-1 rounded-full border border-border bg-surface-1 px-2 py-0.5 text-2xs text-ink-1 hover:bg-surface-2"
      >
        <Eraser className="h-3 w-3" aria-hidden />
        {t('analyzeWorkbench.eraseAction')}
      </button>
    );
  }

  return (
    <div className="w-full rounded-md border border-border bg-surface-1 p-2.5 space-y-2">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-xs font-medium text-ink-0">
            {t('analyzeWorkbench.eraseHeading')}
          </p>
          <p className="text-2xs text-muted">
            {t('analyzeWorkbench.eraseIntroBefore')}{' '}
            <span className="font-mono">ST_Difference</span>{' '}
            {t('analyzeWorkbench.eraseIntroAfter')}{' '}
            <a
              href="/help/analysis/erase"
              className="underline underline-offset-2 hover:text-ink-1"
            >
              {t('analyzeWorkbench.eraseHelpLink')}
            </a>
            {t('analyzeWorkbench.eraseIntroTail')}
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
        <label className="flex min-w-[14rem] flex-1 flex-col gap-0.5 text-2xs text-ink-1">
          <span>{t('analyzeWorkbench.eraseByLabel')}</span>
          <select
            value={eraseItemId}
            onChange={(e) => {
              setEraseItemId(e.target.value);
              if (!title.trim()) {
                const nextLabel =
                  options.find((o) => o.id === e.target.value)?.title ||
                  'erase mask';
                setTitle(
                  defaultEraseDerivedLayerTitle(sourceLabel, nextLabel),
                );
              }
            }}
            disabled={busy || Boolean(loadError)}
            className="h-7 rounded-md border border-border bg-surface-0 px-2 text-xs text-ink-0 focus:border-accent focus:outline-hidden disabled:opacity-50"
            aria-label={t('analyzeWorkbench.eraseByLabel')}
          >
            <option value="">
              {t('analyzeWorkbench.erasePickPlaceholder')}
            </option>
            {options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.title}
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
          onClick={() => void createEraseLayer()}
          disabled={busy || Boolean(validationError)}
          className="inline-flex h-7 items-center gap-1.5 rounded-md bg-ink-1 px-2.5 text-xs font-medium text-surface-0 hover:opacity-90 disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
          {busy
            ? t('analyzeWorkbench.creatingEllipsis')
            : t('analyzeWorkbench.createDerivedLayer')}
        </button>
      </div>

      {loadError ? (
        <p className="text-2xs text-danger" role="alert">
          {loadError}
        </p>
      ) : validationError ? (
        <p className="text-2xs text-danger" role="alert">
          {validationError}
        </p>
      ) : (
        <p className="text-2xs text-muted">
          {t('analyzeWorkbench.eraseHint')}
        </p>
      )}
    </div>
  );
}
