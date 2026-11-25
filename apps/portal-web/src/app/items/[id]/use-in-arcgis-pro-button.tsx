// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Copy, ExternalLink, Globe } from 'lucide-react';

import { featureServerUrl } from '@/lib/geoservices';
import { useT } from '@/lib/i18n/locale-context';

/**
 * "Use in ArcGIS Pro" on a data layer's page: the item's FeatureServer
 * URL with a Copy button and the three steps to add it in Pro. The
 * same URL works in QGIS; the help link covers both.
 */
export function UseInArcGisProButton({ itemId, title }: { itemId: string; title: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [url, setUrl] = useState('');
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setUrl(featureServerUrl(window.location.origin, itemId, title));
  }, [itemId, title]);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (ref.current && e.target instanceof Node && !ref.current.contains(e.target)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard blocked (http, or a browser setting): the field is
      // selectable, so the user can still copy it by hand.
      setCopied(false);
    }
  }

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border bg-surface-1 px-3 text-sm font-medium text-ink-1 shadow-card hover:bg-surface-2"
      >
        <Globe className="h-4 w-4" />
        {t('useInPro.button')}
        <ChevronDown className="h-3.5 w-3.5 text-muted" />
      </button>
      {open ? (
        <div
          role="dialog"
          aria-label={t('useInPro.title')}
          className="absolute right-0 top-10 z-30 w-96 max-w-[90vw] rounded-md border border-border bg-surface-1 p-3 text-sm shadow-overlay"
        >
          <div className="mb-2 font-medium text-ink-0">{t('useInPro.title')}</div>
          <label className="mb-1 block text-2xs font-semibold uppercase tracking-wide text-muted" htmlFor="use-in-pro-url">
            {t('useInPro.urlLabel')}
          </label>
          <div className="mb-3 flex items-center gap-1.5">
            <input
              id="use-in-pro-url"
              readOnly
              value={url}
              onFocus={(e) => e.currentTarget.select()}
              className="h-8 min-w-0 flex-1 rounded-md border border-border bg-surface-2 px-2 font-mono text-xs text-ink-1"
            />
            <button
              type="button"
              onClick={() => void copy()}
              className="inline-flex h-8 shrink-0 items-center gap-1 rounded-md bg-accent px-2.5 text-xs font-medium text-accent-foreground hover:opacity-90"
            >
              {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              {copied ? t('useInPro.copied') : t('useInPro.copy')}
            </button>
          </div>
          <ol className="mb-2 list-decimal space-y-1 pl-5 text-xs text-ink-1">
            <li>{t('useInPro.step1')}</li>
            <li>{t('useInPro.step2')}</li>
            <li>{t('useInPro.step3')}</li>
          </ol>
          <p className="mb-2 text-xs text-muted">{t('useInPro.publicNote')}</p>
          <a
            href="/help/getting-started/arcgis-pro"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs font-medium text-accent hover:underline"
          >
            {t('useInPro.help')}
            <ExternalLink className="h-3 w-3" />
          </a>
        </div>
      ) : null}
    </div>
  );
}
