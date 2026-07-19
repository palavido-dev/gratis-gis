// SPDX-License-Identifier: AGPL-3.0-or-later
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ArrowLeft, Rocket } from 'lucide-react';

import { apiFetch } from '@/lib/api';
import {
  GettingStartedView,
  type OnboardingStatus,
} from './getting-started-view';

/**
 * Admin getting-started checklist (#147 Phase 3). Follows the shape
 * of the other admin pages: server-side role gate, initial data
 * fetched here, interactivity in the client view.
 */
export default async function AdminGettingStartedPage() {
  let me: { orgRole: string };
  try {
    me = await apiFetch<{ orgRole: string }>('/api/users/me');
  } catch {
    redirect('/items');
  }
  if (me.orgRole !== 'admin') redirect('/items');

  let status: OnboardingStatus | null = null;
  let error: string | null = null;
  try {
    status = await apiFetch<OnboardingStatus>('/api/admin/onboarding');
  } catch (err) {
    error =
      err instanceof Error ? err.message : 'Could not load the checklist.';
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-10">
      <Link
        href="/items"
        className="mb-3 inline-flex items-center gap-1 text-xs text-muted hover:text-ink-0"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Back to portal
      </Link>
      <header className="mb-6 flex items-center gap-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-md bg-accent/10 text-accent">
          <Rocket className="h-5 w-5" />
        </span>
        <div>
          <p className="text-xs text-muted">Admin</p>
          <h1 className="text-2xl font-semibold tracking-tight">
            Getting started
          </h1>
          <p className="mt-0.5 text-sm text-muted">
            A short setup checklist for a fresh portal. Nothing here
            is required; hide anything that does not apply.
          </p>
        </div>
      </header>

      {error ? (
        <div className="mb-6 rounded-lg border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-danger">
          <p className="font-medium">Could not load the checklist</p>
          <p className="mt-1 text-danger/90">{error}</p>
        </div>
      ) : null}

      {status ? <GettingStartedView initialStatus={status} /> : null}
    </div>
  );
}
