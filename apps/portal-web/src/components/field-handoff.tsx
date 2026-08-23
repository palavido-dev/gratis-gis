// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import { useEffect, useState } from 'react';
import { Check, Copy, Smartphone } from 'lucide-react';
import { qrSvg } from '@gratis-gis/shared-types';
import { useT } from '@/lib/i18n/locale-context';

/**
 * Desk-to-phone handoff for a field deployment.
 *
 * Field collection is the one surface in the portal that is useless
 * on the machine you author it from: you configure it at a desk and
 * you need it in your hand, outdoors. Before this, the only way
 * across that gap was knowing the URL and typing it, which meant
 * anyone evaluating the portal had to read the docs to discover the
 * feature existed at all.
 *
 * The absolute URL is built in the browser rather than passed in,
 * because the server does not reliably know the public origin it is
 * being reached on (reverse proxies, the demo's own hostname, someone
 * self-hosting on a LAN address). `window.location.origin` is the one
 * value guaranteed to be the address the reader actually used, and a
 * QR pointing at the wrong host is worse than no QR.
 */
interface Props {
  /** Path to encode, e.g. `/items/<id>/field`. */
  path: string;
  /** Compact mode for list rows: smaller code, no explanatory text. */
  compact?: boolean;
}

export function FieldHandoff({ path, compact = false }: Props) {
  const t = useT();
  const [url, setUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Origin is only knowable on the client, so the QR renders after
  // mount. No skeleton: it is a small optional affordance and a
  // placeholder box that swaps to a code is more distracting than a
  // beat of nothing.
  useEffect(() => {
    setUrl(`${window.location.origin}${path}`);
  }, [path]);

  useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(id);
  }, [copied]);

  if (!url) return null;

  const svg = qrSvg(url);
  const size = compact ? 'h-28 w-28' : 'h-40 w-40';

  return (
    <div className={compact ? 'flex items-center gap-3' : 'flex items-start gap-4'}>
      <div
        className={`${size} shrink-0 rounded-md border border-border bg-white p-1.5`}
        // The encoder emits a self-contained SVG with no interpolated
        // content: every byte comes from qrSvg's own template and a
        // URL we built from location.origin plus a caller-supplied
        // path, so there is no untrusted string reaching the markup.
        dangerouslySetInnerHTML={{ __html: svg }}
        role="img"
        aria-label={t('field.qrAlt')}
      />
      <div className="min-w-0">
        {!compact ? (
          <p className="mb-2 text-xs text-muted">{t('field.qrHint')}</p>
        ) : null}
        <div className="flex min-w-0 items-center gap-1.5">
          <code className="min-w-0 truncate rounded bg-surface-2 px-1.5 py-1 text-2xs text-ink-1">
            {url}
          </code>
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard?.writeText(url).then(
                () => setCopied(true),
                () => setCopied(false),
              );
            }}
            className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-border bg-surface-1 px-2 text-2xs font-medium text-ink-1 hover:bg-surface-2"
            title={t('field.copyLink')}
          >
            {copied ? (
              <>
                <Check className="h-3 w-3 text-success" />
                {t('field.copied')}
              </>
            ) : (
              <>
                <Copy className="h-3 w-3" />
                {t('field.copyLink')}
              </>
            )}
          </button>
        </div>
        {!compact ? (
          <p className="mt-2 inline-flex items-center gap-1 text-2xs text-muted">
            <Smartphone className="h-3 w-3" />
            {t('field.qrSignIn')}
          </p>
        ) : null}
      </div>
    </div>
  );
}
