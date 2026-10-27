// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

/**
 * Cite dropdown for public items. Downloads BibTeX / RIS /
 * Schema.org JSON-LD from the public citation endpoints.
 */
import { useState } from 'react';
import { Download } from 'lucide-react';
import { t } from '@/lib/i18n';
import type { SupportedLocale } from '@/lib/i18n/locales';

const FORMATS: Array<{
  format: 'bib' | 'ris' | 'jsonld';
  labelKey: string;
}> = [
  { format: 'bib', labelKey: 'metadataPanel.citeBibtex' },
  { format: 'ris', labelKey: 'metadataPanel.citeRis' },
  { format: 'jsonld', labelKey: 'metadataPanel.citeJsonLd' },
];

export function CiteMenu({
  itemId,
  locale,
}: {
  itemId: string;
  locale: SupportedLocale;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function download(format: 'bib' | 'ris' | 'jsonld') {
    setBusy(format);
    setError(null);
    try {
      // Via the portal BFF so local next.dev and prod Caddy both reach
      // portal-api. The citation routes are @Public(); auth is optional.
      const res = await fetch(
        `/api/portal/public/ogc/citation/${itemId}.${format}`,
      );
      if (!res.ok) {
        throw new Error(`${res.status}`);
      }
      const blob = await res.blob();
      const disposition = res.headers.get('content-disposition') ?? '';
      const match = /filename="([^"]+)"/i.exec(disposition);
      const name = match?.[1] ?? `citation.${format}`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.click();
      URL.revokeObjectURL(url);
      setOpen(false);
    } catch {
      setError(t('metadataPanel.citeFailed', undefined, locale));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="relative">
      <button
        type="button"
        className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface-1 px-2.5 py-1.5 text-xs font-medium text-ink-1 shadow-xs transition-colors hover:bg-surface-2"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((v) => !v)}
      >
        <Download className="h-3.5 w-3.5" aria-hidden />
        {t('metadataPanel.cite', undefined, locale)}
      </button>
      {open ? (
        <div
          role="menu"
          className="absolute right-0 z-20 mt-1 min-w-[12rem] rounded-md border border-border bg-surface-1 py-1 shadow-card"
        >
          {FORMATS.map(({ format, labelKey }) => (
            <button
              key={format}
              type="button"
              role="menuitem"
              disabled={busy !== null}
              className="block w-full px-3 py-1.5 text-left text-sm text-ink-1 hover:bg-surface-2 disabled:opacity-50"
              onClick={() => void download(format)}
            >
              {busy === format
                ? t('metadataPanel.citeDownloading', undefined, locale)
                : t(labelKey, undefined, locale)}
            </button>
          ))}
          {error ? (
            <p className="border-t border-border px-3 py-1.5 text-2xs text-danger">
              {error}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
