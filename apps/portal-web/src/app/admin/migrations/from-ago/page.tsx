// SPDX-License-Identifier: AGPL-3.0-or-later
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ArrowLeft, CloudDownload, Plug } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { FromAgoView } from './from-ago-view';

/**
 * Admin-only "Migrate from ArcGIS Online" page. Operator picks an
 * AGO connection from the dropdown (registered once via
 * /admin/migrations/from-ago/connections), signs in via OAuth
 * popup, previews + commits the import.
 */
export default async function AdminMigrateFromAgoPage() {
  let me: { orgRole: string };
  try {
    me = await apiFetch<{ orgRole: string }>('/api/users/me');
  } catch {
    redirect('/items');
  }
  if (me.orgRole !== 'admin') redirect('/items');

  return (
    <div className="w-full max-w-5xl pb-10 pt-4">
      <Link
        href="/admin/migrations"
        className="mb-3 inline-flex items-center gap-1 text-xs text-muted hover:text-ink-0"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Back to migrations
      </Link>
      <header className="mb-6 flex items-center gap-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-md bg-accent/10 text-accent">
          <CloudDownload className="h-5 w-5" />
        </span>
        <div className="flex-1">
          <p className="text-xs text-muted">Migrations / Import</p>
          <h1 className="text-2xl font-semibold tracking-tight">
            From ArcGIS Online
          </h1>
          <p className="mt-0.5 text-sm text-muted">
            Pick a registered AGO connection, sign in, preview what
            will be imported, then commit. Folder layout and per-item
            sharing scope are preserved. Apps, dashboards, and forms
            are skipped.
          </p>
        </div>
        <Link
          href="/admin/migrations/from-ago/connections"
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface-0 px-3 py-1.5 text-sm font-medium hover:bg-surface-2"
        >
          <Plug className="h-4 w-4" />
          Manage connections
        </Link>
      </header>
      <FromAgoView />
    </div>
  );
}
