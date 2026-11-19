// SPDX-License-Identifier: AGPL-3.0-or-later
import { redirect } from 'next/navigation';
import { RefreshCw } from 'lucide-react';

import { apiFetch } from '@/lib/api';
import { getServerLocale } from '@/lib/i18n/server';
import { t } from '@/lib/i18n';

import { UpdatesView, type UpdateReport } from './updates-view';

export default async function AdminUpdatesPage() {
  const locale = await getServerLocale();
  let me: { orgRole: string };
  try {
    me = await apiFetch<{ orgRole: string }>('/api/users/me');
  } catch {
    redirect('/items');
  }
  if (me.orgRole !== 'admin') redirect('/items');

  let report: UpdateReport | null = null;
  let error: string | null = null;
  try {
    report = await apiFetch<UpdateReport>('/api/admin/updates');
  } catch (err) {
    error = err instanceof Error ? err.message : t('updates.loadFailed', undefined, locale);
  }
  // GRATIS_DISABLE_BACKUP_UI: hide the "back up first" button, which
  // the API would refuse.
  let backupDisabled = false;
  try {
    backupDisabled = (
      await apiFetch<{ disabled: boolean }>('/api/admin/backup/availability')
    ).disabled;
  } catch {
    /* not an operator, or older API: keep the button */
  }

  return (
    <div className="w-full max-w-3xl pb-10 pt-4">
      <header className="mb-6 flex items-center gap-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-md bg-accent/10 text-accent">
          <RefreshCw className="h-5 w-5" />
        </span>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {t('updates.title', undefined, locale)}
          </h1>
          <p className="mt-0.5 text-sm text-muted">{t('updates.intro', undefined, locale)}</p>
        </div>
      </header>
      {error ? <p className="text-sm text-danger">{error}</p> : null}
      {report ? <UpdatesView report={report} backupDisabled={backupDisabled} /> : null}
    </div>
  );
}
