// SPDX-License-Identifier: AGPL-3.0-or-later
import { redirect } from 'next/navigation';

import { apiFetch } from '@/lib/api';

import { OperationsView } from './operations-view';

export default async function AdminOperationsPage() {
  let me: { orgRole: string };
  try {
    me = await apiFetch<{ orgRole: string }>('/api/users/me');
  } catch {
    redirect('/items');
  }
  if (me.orgRole !== 'admin') redirect('/items');
  // Readiness and maintenance are install-wide, so the API limits them
  // to admins of the operator organization. Probe once so other org
  // admins see a note instead of panels that would only return 403.
  let operator = true;
  let writesDisabled = false;
  try {
    const status = await apiFetch<{ writesDisabled?: boolean }>(
      '/api/admin/maintenance',
    );
    // GRATIS_DISABLE_BACKUP_UI: the API refuses maintenance writes.
    writesDisabled = status.writesDisabled === true;
  } catch (err) {
    if ((err as { status?: number }).status === 403) operator = false;
  }
  return <OperationsView operator={operator} writesDisabled={writesDisabled} />;
}
