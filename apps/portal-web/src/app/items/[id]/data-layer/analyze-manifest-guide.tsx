// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

/**
 * Shared Analyze guide shell driven by a parameter manifest
 * (analyze-param-manifests).
 *
 * First slice covers title-only / no-param tools. Chip → short form
 * → private single-step `derived_layer` POST. Honesty copy and help
 * links stay on the manifest; recipe builders stay in *-derived.ts.
 */
import { useMemo, useState, type ComponentType, type SVGProps } from 'react';
import { useRouter } from 'next/navigation';
import {
  CircleDot,
  Crosshair,
  Hexagon,
  Layers2,
  Loader2,
  Square,
} from 'lucide-react';
import { toast } from '@/lib/toast';
import { useT } from '@/lib/i18n/locale-context';
import {
  getAnalyzeParamManifest,
  type AnalyzeManifestIcon,
} from '@/lib/analyze-param-manifest';
import type { AnalyzeToolId } from '@/lib/analyze-tool-ids';

type IconCmp = ComponentType<SVGProps<SVGSVGElement> & { className?: string }>;

const ICONS: Record<AnalyzeManifestIcon, IconCmp> = {
  crosshair: Crosshair,
  square: Square,
  'circle-dot': CircleDot,
  hexagon: Hexagon,
  'layers-2': Layers2,
};

interface Props {
  tool: AnalyzeToolId;
  /** Expand the form on mount (Analyze ?tool= deep link). */
  defaultOpen?: boolean;
  itemId: string;
  /** v3 sublayer id; stamped as derived_layer.source.layerKey. */
  layerKey: string;
  sourceLabel: string;
}

export function AnalyzeManifestGuide({
  tool,
  itemId,
  layerKey,
  sourceLabel,
  defaultOpen = false,
}: Props) {
  const router = useRouter();
  const t = useT();
  const manifest = getAnalyzeParamManifest(tool);
  const [open, setOpen] = useState(defaultOpen);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);

  const suggestedTitle = useMemo(
    () => (manifest ? manifest.defaultTitle(sourceLabel) : ''),
    [manifest, sourceLabel],
  );

  if (!manifest) {
    return null;
  }

  const Icon = ICONS[manifest.icon];
  const { keys } = manifest;

  async function createDerived(): Promise<void> {
    if (busy || !manifest) return;
    setBusy(true);
    try {
      const payload = manifest.buildPayload({
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
          // Empty, not a snapshot: the placeholder and the submit
          // fallback follow the parameters as they change.
          setTitle('');
        }}
        title={t(keys.actionTitle)}
        className="inline-flex items-center gap-1 rounded-full border border-border bg-surface-1 px-2 py-0.5 text-2xs text-ink-1 hover:bg-surface-2"
      >
        <Icon className="h-3 w-3" aria-hidden />
        {t(keys.action)}
      </button>
    );
  }

  return (
    <div className="w-full rounded-md border border-border bg-surface-1 p-2.5 space-y-2">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-xs font-medium text-ink-0">{t(keys.heading)}</p>
          <p className="text-2xs text-muted">
            {t(keys.introBefore)}{' '}
            <span className="font-mono">{manifest.sqlFn}</span>{' '}
            {t(keys.introAfter)}{' '}
            <a
              href={manifest.helpHref}
              className="underline underline-offset-2 hover:text-ink-1"
            >
              {t(keys.helpLink)}
            </a>
            {t(keys.introTail)}
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
          onClick={() => void createDerived()}
          disabled={busy}
          className="inline-flex h-7 items-center gap-1.5 rounded-md bg-ink-1 px-2.5 text-xs font-medium text-surface-0 hover:opacity-90 disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : null}
          {busy
            ? t('analyzeWorkbench.creatingEllipsis')
            : t('analyzeWorkbench.createDerivedLayer')}
        </button>
      </div>

      <p className="text-2xs text-muted">{t(keys.hint)}</p>
    </div>
  );
}
