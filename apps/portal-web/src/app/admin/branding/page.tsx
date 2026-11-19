// SPDX-License-Identifier: AGPL-3.0-or-later
import { redirect } from 'next/navigation';
import { Paintbrush } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { t } from '@/lib/i18n';
import { getServerLocale } from '@/lib/i18n/server';
import { BrandingForm } from './branding-form';

export interface BrandingConfig {
  id: string;
  slug: string;
  name: string;
  landingTitle: string | null;
  landingSubtitle: string | null;
  landingHeroImageUrl: string | null;
  landingShowPublicItems: boolean;
  landingFeaturedItemIds: string[];
}

export default async function AdminBrandingPage() {
  // Client-side admin guard: the backend enforces via AdminGuard, but
  // bouncing non-admins up front avoids a 403 landing page.
  let me: { orgRole: string };
  try {
    me = await apiFetch<{ orgRole: string }>('/api/users/me');
  } catch {
    redirect('/items');
  }
  if (me.orgRole !== 'admin') redirect('/items');

  const locale = await getServerLocale();

  let config: BrandingConfig;
  try {
    config = await apiFetch<BrandingConfig>('/api/admin/branding');
  } catch (err) {
    const msg =
      err instanceof Error
        ? err.message
        : t('adminBranding.errLoad', undefined, locale);
    return (
      <div className="w-full max-w-4xl pb-10 pt-4">
        <div className="rounded-lg border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-danger">
          <p className="font-medium">
            {t('adminBranding.errLoadTitle', undefined, locale)}
          </p>
          <p className="mt-1 text-danger/90">{msg}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="w-full max-w-4xl pb-10 pt-4">
      <header className="mb-6 flex items-center gap-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-md bg-accent/10 text-accent">
          <Paintbrush className="h-5 w-5" />
        </span>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {t('nav.landingPage', undefined, locale)}
          </h1>
          <p className="mt-0.5 text-sm text-muted">
            {t('adminBranding.pageIntro', undefined, locale)}
          </p>
        </div>
      </header>

      <BrandingForm initial={config} />
    </div>
  );
}
