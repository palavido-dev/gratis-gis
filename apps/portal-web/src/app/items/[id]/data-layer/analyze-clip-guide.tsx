// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

/**
 * Guided Clip action on the Analyze workbench
 * (R5-analyze-clip-shortcut).
 *
 * Same honesty stance as Buffer: Analyze does not fake a browser
 * clip. It opens a short form, picks a second data_layer as the
 * cookie-cutter, and POSTs a single-step `derived_layer` recipe
 * that runs on PostGIS — the same path as Create → Derived layer
 * → Clip.
 */
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Scissors } from 'lucide-react';
import { toast } from '@/lib/toast';
import { useT } from '@/lib/i18n/locale-context';
import {
  buildClipDerivedLayerCreatePayload,
  defaultClipDerivedLayerTitle,
  validateClipOtherSource,
} from '@/lib/analyze-clip-derived';

interface ClipOption {
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

export function AnalyzeClipGuide({
  itemId,
  layerKey,
  sourceLabel,
  defaultOpen = false
}: Props) {
  const router = useRouter();
  const t = useT();
  const [open, setOpen] = useState(defaultOpen);
  const [options, setOptions] = useState<ClipOption[]>([]);
  const [clipItemId, setClipItemId] = useState('');
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
            setLoadError(t('analyzeWorkbench.clipLoadFailed'));
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
          setLoadError(t('analyzeWorkbench.clipLoadFailed'));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, itemId, t]);

  const clipLabel =
    options.find((o) => o.id === clipItemId)?.title || 'clip layer';

  const suggestedTitle = useMemo(
    () => defaultClipDerivedLayerTitle(sourceLabel, clipLabel),
    [sourceLabel, clipLabel],
  );

  const rawValidation = validateClipOtherSource(clipItemId, itemId);
  const validationError = !clipItemId.trim()
    ? t('analyzeWorkbench.clipValidateEmpty')
    : clipItemId.trim() === itemId.trim()
      ? t('analyzeWorkbench.clipValidateSelf')
      : rawValidation;

  async function createClipLayer(): Promise<void> {
    if (busy || validationError) return;
    setBusy(true);
    try {
      const payload = buildClipDerivedLayerCreatePayload({
        title: title.trim() || suggestedTitle,
        sourceLabel,
        clipLabel,
        sourceItemId: itemId,
        layerKey,
        clipItemId,
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
          setClipItemId('');
        }}
        title={t('analyzeWorkbench.clipActionTitle')}
        className="inline-flex items-center gap-1 rounded-full border border-border bg-surface-1 px-2 py-0.5 text-2xs text-ink-1 hover:bg-surface-2"
      >
        <Scissors className="h-3 w-3" aria-hidden />
        {t('analyzeWorkbench.clipAction')}
      </button>
    );
  }

  return (
    <div className="w-full rounded-md border border-border bg-surface-1 p-2.5 space-y-2">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-xs font-medium text-ink-0">
            {t('analyzeWorkbench.clipHeading')}
          </p>
          <p className="text-2xs text-muted">
            {t('analyzeWorkbench.clipIntroBefore')}{' '}
            <span className="font-mono">ST_Intersection</span>{' '}
            {t('analyzeWorkbench.clipIntroAfter')}{' '}
            <a
              href="/help/analysis/clip"
              className="underline underline-offset-2 hover:text-ink-1"
            >
              {t('analyzeWorkbench.clipHelpLink')}
            </a>
            {t('analyzeWorkbench.clipIntroTail')}
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
          <span>{t('analyzeWorkbench.clipByLabel')}</span>
          <select
            value={clipItemId}
            onChange={(e) => {
              setClipItemId(e.target.value);
              if (!title.trim()) {
                const nextLabel =
                  options.find((o) => o.id === e.target.value)?.title ||
                  'clip layer';
                setTitle(
                  defaultClipDerivedLayerTitle(sourceLabel, nextLabel),
                );
              }
            }}
            disabled={busy || Boolean(loadError)}
            className="h-7 rounded-md border border-border bg-surface-0 px-2 text-xs text-ink-0 focus:border-accent focus:outline-hidden disabled:opacity-50"
            aria-label={t('analyzeWorkbench.clipByLabel')}
          >
            <option value="">{t('analyzeWorkbench.clipPickPlaceholder')}</option>
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
          onClick={() => void createClipLayer()}
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
          {t('analyzeWorkbench.clipHint')}
        </p>
      )}
    </div>
  );
}
