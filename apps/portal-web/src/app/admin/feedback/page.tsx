// SPDX-License-Identifier: AGPL-3.0-or-later
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ArrowLeft, MessageSquarePlus } from 'lucide-react';

import { apiFetch } from '@/lib/api';
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

  let first: FeedbackPage | null = null;
  let error: string | null = null;
  try {
    first = await apiFetch<FeedbackPage>('/api/admin/feedback?limit=25');
  } catch (err) {
    error = err instanceof Error ? err.message : 'Could not load feedback.';
  }

  return (
    <div className="mx-auto w-full max-w-4xl px-6 py-10">
      <Link
        href="/items"
        className="mb-3 inline-flex items-center gap-1 text-xs text-muted hover:text-ink-0"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Back to portal
      </Link>
      <header className="mb-6 flex items-center gap-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-md bg-accent/10 text-accent">
          <MessageSquarePlus className="h-5 w-5" />
        </span>
        <div>
          <p className="text-xs text-muted">Admin</p>
          <h1 className="text-2xl font-semibold tracking-tight">Feedback</h1>
          <p className="mt-0.5 text-sm text-muted">
            What people have sent from the portal, newest first.
          </p>
        </div>
      </header>

      {error ? (
        <div className="mb-6 rounded-lg border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-danger">
          <p className="font-medium">Could not load feedback</p>
          <p className="mt-1 text-danger/90">{error}</p>
        </div>
      ) : null}

      {first ? <FeedbackAdminView initial={first} /> : null}
    </div>
  );
}
