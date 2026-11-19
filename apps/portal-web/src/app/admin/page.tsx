// SPDX-License-Identifier: AGPL-3.0-or-later
import { redirect } from 'next/navigation';

import { apiFetch } from '@/lib/api';

import { AdminHome } from './admin-home';

export const metadata = { title: 'Admin' };

/**
 * The admin home: every admin page as a card, grouped by what an
 * admin is trying to do, with a search box. It replaced a sidebar list
 * of sixteen links. The cards come from lib/admin-sections.ts.
 */
export default async function AdminHomePage() {
  let me: { orgRole: string; operator?: boolean };
  try {
    me = await apiFetch<{ orgRole: string; operator?: boolean }>('/api/users/me');
  } catch {
    redirect('/items');
  }
  if (me.orgRole !== 'admin') redirect('/items');
  return <AdminHome operator={me.operator === true} />;
}
