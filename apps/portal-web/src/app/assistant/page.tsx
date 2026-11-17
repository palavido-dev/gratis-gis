// SPDX-License-Identifier: AGPL-3.0-or-later
import { BuildComposer } from './build-composer';
import { LayerAsk } from './layer-ask';
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
