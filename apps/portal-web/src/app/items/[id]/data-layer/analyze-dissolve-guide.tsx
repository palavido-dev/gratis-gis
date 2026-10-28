// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

/**
 * Guided Dissolve action on the Analyze workbench
 * (R7-analyze-dissolve-shortcut).
 *
 * Same honesty stance as Centroid: Analyze does not fake an
 * in-browser dissolve. It opens a short title form and POSTs a
 * single-step `derived_layer` recipe that runs `ST_Union` on
 * PostGIS — attributes dropped. Keyed dissolve stays on group-by.
 */
import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Layers2, Loader2 } from 'lucide-react';
import { toast } from '@/lib/toast';
import { useT } from '@/lib/i18n/locale-context';
import {
  buildDissolveDerivedLayerCreatePayload,
  defaultDissolveDerivedLayerTitle,
} from '@/lib/analyze-dissolve-derived';

interface Props {
  itemId: string;
  /** v3 sublayer id; stamped as derived_layer.source.layerKey. */
  layerKey: string;
  sourceLabel: string;
}

export function AnalyzeDissolveGuide({
  itemId,
  layerKey,
  sourceLabel,
}: Props) {
  const router = useRouter();
  const t = useT();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);

  const suggestedTitle = useMemo(
    () => defaultDissolveDerivedLayerTitle(sourceLabel),
    [sourceLabel],
  );

  async function createDissolveLayer(): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      const payload = buildDissolveDerivedLayerCreatePayload({
        title: title.trim() || suggestedTitle,
        sourceLabel,
        sourceItemId: itemId,
        layerKey,
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
        title={t('analyzeWorkbench.dissolveActionTitle')}
        className="inline-flex items-center gap-1 rounded-full border border-border bg-surface-1 px-2 py-0.5 text-2xs text-ink-1 hover:bg-surface-2"
      >
        <Layers2 className="h-3 w-3" aria-hidden />
        {t('analyzeWorkbench.dissolveAction')}
      </button>
    );
  }

  return (
    <div className="w-full rounded-md border border-border bg-surface-1 p-2.5 space-y-2">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-xs font-medium text-ink-0">
            {t('analyzeWorkbench.dissolveHeading')}
          </p>
          <p className="text-2xs text-muted">
            {t('analyzeWorkbench.dissolveIntroBefore')}{' '}
            <span className="font-mono">ST_Union</span>{' '}
            {t('analyzeWorkbench.dissolveIntroAfter')}{' '}
            <a
              href="/help/analysis/dissolve"
              className="underline underline-offset-2 hover:text-ink-1"
            >
              {t('analyzeWorkbench.dissolveHelpLink')}
            </a>
            {t('analyzeWorkbench.dissolveIntroTail')}
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
          onClick={() => void createDissolveLayer()}
          disabled={busy}
          className="inline-flex h-7 items-center gap-1.5 rounded-md bg-ink-1 px-2.5 text-xs font-medium text-surface-0 hover:opacity-90 disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : null}
          {busy
            ? t('analyzeWorkbench.creatingEllipsis')
            : t('analyzeWorkbench.createDerivedLayer')}
        </button>
      </div>

      <p className="text-2xs text-muted">
        {t('analyzeWorkbench.dissolveHint')}
      </p>
    </div>
  );
}
