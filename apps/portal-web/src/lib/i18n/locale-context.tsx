// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

/**
 * #162 Phase 1.1 React context for the negotiated locale.
 *
 * The server reads the user's locale cookie (or, when absent, the
 * Accept-Language header) and renders <LocaleProvider locale={...}>
 * around the React tree. Client components reach the active locale
 * through useLocale(), and the convenient useT() hook returns a
 * `t(key, params?)` function pre-bound to that locale, so call
 * sites can stay terse:
 *
 *   const t = useT();
 *   return <button>{t('common.save')}</button>;
 *
 * Server components don't use this hook; they call `t(key, params,
 * locale)` directly with the locale they themselves negotiated.
 *
 * Phase 1.1 keeps the runtime vanilla (same lookup + interpolation
 * the Phase 1.0 `t()` already does). When the heavier library
 * swap lands the useT() shape stays compatible.
 */
import { createContext, useContext, useMemo, type ReactNode } from 'react';

import { t as baseT, type SupportedLocale } from './index';
import { DEFAULT_LOCALE } from './locales';

const LocaleContext = createContext<SupportedLocale>(DEFAULT_LOCALE);

export function LocaleProvider({
  locale,
  children,
}: {
  locale: SupportedLocale;
  children: ReactNode;
}) {
  return (
    <LocaleContext.Provider value={locale}>{children}</LocaleContext.Provider>
  );
}

/** The active locale for the client subtree. Defaults to English
 *  when no provider has mounted (e.g. in unit tests). */
export function useLocale(): SupportedLocale {
  return useContext(LocaleContext);
}

/**
 * Returns a `t(key, params?)` function pre-bound to the active
 * locale from context. The result is memoized per-locale so a
 * component that calls useT() in a hot path doesn't allocate a
 * new closure on every render.
 */
export function useT(): (
  key: string,
  params?: Record<string, string | number>,
) => string {
  const locale = useLocale();
  return useMemo(
    () =>
      (key: string, params?: Record<string, string | number>) =>
        baseT(key, params, locale),
    [locale],
  );
}
