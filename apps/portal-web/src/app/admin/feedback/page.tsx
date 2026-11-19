// SPDX-License-Identifier: AGPL-3.0-or-later
import { redirect } from 'next/navigation';
import { MessageSquarePlus } from 'lucide-react';

import { apiFetch } from '@/lib/api';
import { t } from '@/lib/i18n';
import { getServerLocale } from '@/lib/i18n/server';
import { FeedbackAdminView, type FeedbackPage } from './feedback-admin-view';

/**
 * Feedback triage (#146). Same shape as the other admin pages:
 * server-side role gate, first page fetched here, interactivity in
 * the client view.
 *
 * Deliberately reachable even when PORTAL_FEEDBACK_ENABLED is off.
 * An operator who switches the form off still has to be able to read
 * and clear whatever arrived while it was on; gating the reader on
 * the writer's flag would strand exactly the data the flip was
 * probably reacting to.
 */
export default async function AdminFeedbackPage() {
  let me: { orgRole: string };
  try {
    me = await apiFetch<{ orgRole: string }>('/api/users/me');
  } catch {
    redirect('/items');
  }
  if (me.orgRole !== 'admin') redirect('/items');
  const locale = await getServerLocale();

  let first: FeedbackPage | null = null;
  let error: string | null = null;
  try {
    // status=new to match the tab the view opens on. With no status
    // the API returns every status, so handled and spam rows showed
    // under "New" until the first action reloaded the list.
    first = await apiFetch<FeedbackPage>('/api/admin/feedback?status=new&limit=25');
  } catch (err) {
    error =
      err instanceof Error
        ? err.message
        : t('adminFeedback.loadErrorFallback', undefined, locale);
  }

  return (
    <div className="w-full max-w-4xl pb-10 pt-4">
      <header className="mb-6 flex items-center gap-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-md bg-accent/10 text-accent">
          <MessageSquarePlus className="h-5 w-5" />
        </span>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {t('adminHome.cards.feedback.title', undefined, locale)}
          </h1>
          <p className="mt-0.5 text-sm text-muted">
            {t('adminFeedback.pageIntro', undefined, locale)}
          </p>
        </div>
      </header>

      {error ? (
        <div className="mb-6 rounded-lg border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-danger">
          <p className="font-medium">
            {t('adminFeedback.loadErrorTitle', undefined, locale)}
          </p>
          <p className="mt-1 text-danger/90">{error}</p>
        </div>
      ) : null}

      {first ? <FeedbackAdminView initial={first} /> : null}
    </div>
  );
}
