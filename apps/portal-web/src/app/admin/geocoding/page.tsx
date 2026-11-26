// SPDX-License-Identifier: AGPL-3.0-or-later
import { redirect } from 'next/navigation';
import { MapPinned } from 'lucide-react';

import { apiFetch } from '@/lib/api';
import { t } from '@/lib/i18n';
import { getServerLocale } from '@/lib/i18n/server';
import { GeocodingView, type GeocoderAdminView } from './geocoding-view';

/**
 * Admin -> Geocoding: pick regions, and portal-worker downloads,
 * builds and serves an open-geocode index for address search.
 */
export default async function AdminGeocodingPage() {
  let me: { orgRole: string };
  try {
    me = await apiFetch<{ orgRole: string }>('/api/users/me');
  } catch {
    redirect('/items');
  }
  if (me.orgRole !== 'admin') redirect('/items');
  const locale = await getServerLocale();

  let view: GeocoderAdminView | null = null;
  let error: string | null = null;
  try {
    view = await apiFetch<GeocoderAdminView>('/api/admin/geocoder');
  } catch (err) {
    error = err instanceof Error ? err.message : t('adminGeocoding.loadError', undefined, locale);
  }

  return (
    <div className="w-full max-w-4xl pb-10 pt-4">
      <header className="mb-6 flex items-center gap-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-md bg-accent/10 text-accent">
          <MapPinned className="h-5 w-5" />
        </span>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {t('adminHome.cards.geocoding.title', undefined, locale)}
          </h1>
          <p className="mt-0.5 text-sm text-muted">{t('adminGeocoding.pageIntro', undefined, locale)}</p>
        </div>
      </header>
      {error ? (
        <div className="mb-6 rounded-lg border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-danger">
          <p className="font-medium">{t('adminGeocoding.loadError', undefined, locale)}</p>
          <p className="mt-1 text-danger/90">{error}</p>
        </div>
      ) : view ? (
        <GeocodingView initial={view} />
      ) : null}
    </div>
  );
}
