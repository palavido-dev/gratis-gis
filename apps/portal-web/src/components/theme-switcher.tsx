// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

/**
 * Appearance picker (light / dark / system) backed by next-themes.
 *
 * Sits in the user menu next to the locale switcher and mirrors its
 * form-control styling. `useTheme` only knows the real value after
 * hydration (the pre-hydration class is applied by next-themes'
 * inline script), so we gate rendering the <select> value on a
 * mounted flag; until then the control renders disabled with the
 * system option to avoid a hydration mismatch.
 */
import { useEffect, useState, type ChangeEvent } from 'react';
import { useTheme } from 'next-themes';

import { useT } from '@/lib/i18n/locale-context';

const THEME_VALUES = ['light', 'dark', 'system'] as const;
type ThemeValue = (typeof THEME_VALUES)[number];

export function ThemeSwitcher() {
  const t = useT();
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  const value: ThemeValue =
    mounted && theme && (THEME_VALUES as readonly string[]).includes(theme)
      ? (theme as ThemeValue)
      : 'system';

  function onChange(event: ChangeEvent<HTMLSelectElement>) {
    setTheme(event.target.value);
  }

  return (
    <label className="inline-flex items-center gap-2 text-xs text-ink-1">
      <span className="text-muted">{t('theme.label')}</span>
      <select
        value={value}
        disabled={!mounted}
        onChange={onChange}
        className="rounded-md border border-border bg-surface-1 px-2 py-1 text-xs text-ink-0 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30 disabled:opacity-50"
      >
        {THEME_VALUES.map((v) => (
          <option key={v} value={v}>
            {t(`theme.${v}`)}
          </option>
        ))}
      </select>
    </label>
  );
}
