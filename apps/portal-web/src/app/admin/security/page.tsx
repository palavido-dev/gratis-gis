// SPDX-License-Identifier: AGPL-3.0-or-later
import { redirect } from 'next/navigation';

import { apiFetch } from '@/lib/api';
import { SecurityForm, type SecurityState } from './security-form';

const EMPTY: SecurityState = { providers: [], mfaRequired: false };

/**
 * Organization sign-in settings. Viewers and contributors are
 * sent back to the items list, matching the other admin pages.
 */
export default async function AdminSecurityPage() {
  let me: { orgRole: string };
  try {
    me = await apiFetch<{ orgRole: string }>('/api/users/me');
  } catch {
    redirect('/items');
  }
  if (me.orgRole !== 'admin') redirect('/items');

  let state = EMPTY;
  let error: string | null = null;
  try {
    state = await apiFetch<SecurityState>('/api/admin/security');
  } catch (err) {
    error = err instanceof Error ? err.message : 'Could not load sign-in settings.';
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-10">
      <h1 className="text-xl font-semibold text-ink-0">Sign-in</h1>
      <p className="mt-2 mb-8 text-sm text-ink-1">
        Add a work account people already have, and decide whether the
        next sign-in must set up an authenticator.
      </p>
      {error ? <p className="mb-4 text-sm text-ink-0">{error}</p> : null}
      <SecurityForm initial={state} />
    </div>
  );
}
