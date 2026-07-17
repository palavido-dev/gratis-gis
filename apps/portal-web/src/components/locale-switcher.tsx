// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

/**
 * #162 Phase 1.1 locale picker.
 *
 * Small dropdown that POSTs to /api/locale to set the gg_locale
 * cookie, then reloads the page so the server-rendered tree picks
 * up the new locale on the next request. Renders each option in
 * its native script so a viewer who can't read the portal's
 * current locale still recognizes their own language.
 *
 * Marks machine-translated locales with an "(MT)" suffix so users
 * know the seed needs native-speaker review, and links to the
 * contributor guide so a native speaker who notices a wrong
 * translation can find the recipe for fixing it.
 */
import { useState, type ChangeEvent } from 'react';

import { LOCALES, type SupportedLocale } from '@/lib/i18n/locales';
import { useLocale, useT } from '@/lib/i18n/locale-context';

export function LocaleSwitcher() {
  const t = useT();
  const current = useLocale();
  const [pending, setPending] = useState(false);

  async function onChange(event: ChangeEvent<HTMLSelectElement>) {
    const next = event.target.value as SupportedLocale;
    if (next === current) return;
    setPending(true);
    try {
      const res = await fetch('/api/locale', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ locale: next }),
      });
      if (res.ok) {
        // Force a hard reload so the server picks the new cookie
        // up on the very next request. router.refresh() would also
        // work but only re-renders the server tree; a full reload
        // catches any once-per-page setup that depends on locale.
        window.location.reload();
      }
    } finally {
      setPending(false);
    }
  }

  const activeLocale = LOCALES.find((l) => l.code === current);

  return (
    <div className="flex flex-col gap-1">
      <label className="inline-flex items-center gap-2 text-xs text-ink-1">
        <span className="text-muted">{t('common.language')}</span>
        <select
          value={current}
          disabled={pending}
          onChange={onChange}
          className="rounded-md border border-border bg-surface-1 px-2 py-1 text-xs text-ink-0 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30 disabled:opacity-50"
        >
          {LOCALES.map((l) => (
            <option key={l.code} value={l.code}>
              {l.nativeName}
              {l.machineTranslated ? ' (MT)' : ''}
            </option>
          ))}
        </select>
      </label>
      {activeLocale?.machineTranslated ? (
        <a
          href="https://github.com/palavido-dev/gratis-gis/blob/main/CONTRIBUTING-TRANSLATIONS.md"
          target="_blank"
          rel="noopener noreferrer"
          className="text-2xs text-muted underline hover:text-ink-1"
        >
          Machine-translated. Help us improve it.
        </a>
      ) : null}
    </div>
  );
}
