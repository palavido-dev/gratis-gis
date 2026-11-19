// SPDX-License-Identifier: AGPL-3.0-or-later
import Link from 'next/link';

import { BuildComposer } from './build-composer';
import { LayerAsk } from './layer-ask';
import { apiFetch } from '@/lib/api';
import { getServerLocale } from '@/lib/i18n/server';
import { t } from '@/lib/i18n';

export const metadata = {
  title: 'Build',
};

/**
 * Natural-language builder. The signed-in shell already wraps
 * this route; the composer talks to the portal API.
 */
export default async function BuildPage() {
  const locale = await getServerLocale();
  // The sidebar hides Build until a provider is connected. Someone who
  // opens the address directly gets a short notice, not a composer
  // that can only fail.
  const [status, me] = await Promise.all([
    apiFetch<{ configured?: boolean }>('/api/ai/status').catch(() => null),
    apiFetch<{ orgRole?: string }>('/api/users/me').catch(() => null),
  ]);
  if (status?.configured !== true) {
    return (
      <div className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6 sm:py-10">
        <h1 className="text-xl font-semibold text-ink-0">
          {t('buildPage.title', undefined, locale)}
        </h1>
        <p className="mt-2 text-sm text-ink-1">{t('buildPage.notConfigured', undefined, locale)}</p>
        {me?.orgRole === 'admin' ? (
          <Link
            href="/admin/ai"
            className="mt-3 inline-flex text-sm font-medium text-accent hover:underline"
          >
            {t('buildPage.connectProvider', undefined, locale)}
          </Link>
        ) : null}
      </div>
    );
  }
  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6 sm:py-10">
      <h1 className="text-xl font-semibold text-ink-0">
        {t('buildPage.title', undefined, locale)}
      </h1>
      <p className="mt-2 text-sm text-ink-1">
        {t('buildPage.intro', undefined, locale)}
      </p>
      <div className="mt-8">
        <BuildComposer />
      </div>
      <div className="mt-12 border-t border-border pt-10">
        <LayerAsk />
      </div>
    </div>
  );
}
