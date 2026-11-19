// SPDX-License-Identifier: AGPL-3.0-or-later
import { redirect } from 'next/navigation';
import { Bot } from 'lucide-react';

import { apiFetch } from '@/lib/api';
import { t } from '@/lib/i18n';
import { getServerLocale } from '@/lib/i18n/server';
import { AiSettingsForm, type AiSettings } from './ai-settings-form';

const EMPTY: AiSettings = {
  configured: false,
  saved: false,
  provider: null,
  model: null,
  baseUrl: null,
  apiKeyConfigured: false,
  configLocked: false,
  buildDisabled: false,
};

/**
 * Org-admin AI provider settings. Viewers and contributors are
 * sent back to the items list, matching the other admin pages.
 */
export default async function AdminAiPage() {
  let me: { orgRole: string };
  try {
    me = await apiFetch<{ orgRole: string }>('/api/users/me');
  } catch {
    redirect('/items');
  }
  if (me.orgRole !== 'admin') redirect('/items');
  const locale = await getServerLocale();

  let settings: AiSettings = EMPTY;
  let error: string | null = null;
  try {
    settings = await apiFetch<AiSettings>('/api/admin/ai');
  } catch (err) {
    error =
      err instanceof Error
        ? err.message
        : t('adminAi.loadErrorFallback', undefined, locale);
  }

  return (
    <div className="w-full max-w-3xl pb-10 pt-4">
      <header className="mb-6 flex items-center gap-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-md bg-accent/10 text-accent">
          <Bot className="h-5 w-5" />
        </span>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {t('adminHome.cards.ai.title', undefined, locale)}
          </h1>
          <p className="mt-0.5 text-sm text-muted">
            {t('adminAi.pageIntro', undefined, locale)}
          </p>
        </div>
      </header>

      {error ? (
        <div className="mb-6 rounded-lg border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-danger">
          <p className="font-medium">
            {t('adminAi.loadErrorTitle', undefined, locale)}
          </p>
          <p className="mt-1 text-danger/90">{error}</p>
        </div>
      ) : (
        <AiSettingsForm initial={settings} />
      )}
    </div>
  );
}
