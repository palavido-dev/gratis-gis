// SPDX-License-Identifier: AGPL-3.0-or-later
import { redirect } from 'next/navigation';

import { apiFetch } from '@/lib/api';

import { AuditView } from './audit-view';

export default async function AdminAuditPage() {
  let me: { orgRole: string };
  try {
    me = await apiFetch<{ orgRole: string }>('/api/users/me');
  } catch {
    redirect('/items');
  }
  if (me.orgRole !== 'admin') redirect('/items');
  return <AuditView />;
}
