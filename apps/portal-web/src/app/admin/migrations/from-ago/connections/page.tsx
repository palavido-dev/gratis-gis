// SPDX-License-Identifier: AGPL-3.0-or-later
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ArrowLeft, Plug } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { ConnectionsView } from './connections-view';

/**
 * Admin page to manage AGO OAuth connections. Each row corresponds
 * to one AGO portal the operator wants to import from; the
 * importer dropdown reads this list.
 */
export default async function AdminAgoConnectionsPage() {
  let me: { orgRole: string };
  try {
    me = await apiFetch<{ orgRole: string }>('/api/users/me');
  } catch {
    redirect('/items');
  }
  if (me.orgRole !== 'admin') redirect('/items');

  // The page renders empty quickly; the client component fetches
  // the live list on mount. Keeps initial paint fast without
  // round-tripping the connections endpoint on the server.
  return (
    <div className="w-full max-w-5xl pb-10 pt-4">
      <Link
        href="/admin/migrations/from-ago"
        className="mb-3 inline-flex items-center gap-1 text-xs text-muted hover:text-ink-0"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Back to AGO importer
      </Link>
      <header className="mb-6 flex items-center gap-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-md bg-accent/10 text-accent">
          <Plug className="h-5 w-5" />
        </span>
        <div>
          <p className="text-xs text-muted">Migrations / From ArcGIS Online</p>
          <h1 className="text-2xl font-semibold tracking-tight">
            AGO Connections
          </h1>
          <p className="mt-0.5 text-sm text-muted">
            One row per AGO portal you want to import from. Add a
            connection once; the importer can sign into any of them.
          </p>
        </div>
      </header>
      <ConnectionsView />
    </div>
  );
}
