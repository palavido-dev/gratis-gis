// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { useT } from '@/lib/i18n/locale-context';

/**
 * Copy-to-clipboard button.
 *
 * The clipboard write is wrapped because `navigator.clipboard` is
 * unavailable on insecure origins, which is not an exotic case here:
 * a self-hosted portal reached over plain http on a LAN address has
 * no clipboard API at all, and the button would silently do nothing.
 * The fallback selects the text in a throwaway input so the user can
 * copy it by hand.
 */
export function CopyButton({
  value,
  label,
  copiedLabel,
  title,
  iconOnly = false,
  className,
}: {
  value: string;
  /** Visible label. Omitted when `iconOnly`. */
  label?: string;
  copiedLabel?: string;
  title?: string;
  iconOnly?: boolean;
  className?: string;
}) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const copiedText = copiedLabel ?? t('copyButton.copied');
  const copyTitle = title ?? t('copyButton.copy');

  async function onCopy() {
    const flash = () => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    };
    try {
      await navigator.clipboard.writeText(value);
      flash();
      return;
    } catch {
      // fall through to the manual-selection path
    }
    const tmp = document.createElement('input');
    tmp.value = value;
    document.body.appendChild(tmp);
    tmp.select();
    try {
      document.execCommand('copy');
      flash();
    } catch {
      // Give up silently. The value is still on screen next to the
      // button in every current caller, so the user can select it.
    }
    document.body.removeChild(tmp);
  }

  return (
    <button
      type="button"
      onClick={onCopy}
      aria-live="polite"
      aria-label={iconOnly ? copyTitle : undefined}
      title={copyTitle}
      className={
        className ??
        (iconOnly
          ? 'inline-flex h-6 w-6 shrink-0 items-center justify-center rounded border border-border bg-surface-1 text-muted transition-colors hover:bg-surface-2 hover:text-ink-1'
          : 'inline-flex h-9 shrink-0 items-center gap-1.5 rounded-md border border-border bg-surface-1 px-3 text-xs font-medium text-ink-1 shadow-card transition-colors hover:bg-surface-2')
      }
    >
      {copied ? (
        <>
          <Check className="h-3.5 w-3.5 text-success" />
          {iconOnly ? null : copiedText}
        </>
      ) : (
        <>
          <Copy className="h-3.5 w-3.5" />
          {iconOnly ? null : label}
        </>
      )}
    </button>
  );
}
