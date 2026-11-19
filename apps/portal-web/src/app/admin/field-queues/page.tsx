// SPDX-License-Identifier: AGPL-3.0-or-later
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ArrowLeft, ClipboardList } from 'lucide-react';

import { apiFetch } from '@/lib/api';
import { FieldQueuesView, type FieldQueueRow } from './field-queues-view';

/**
 * Admin-only "field device queues" surface. Tier 4 of the field-
 * offline resilience design (see docs/field-offline-areas.md). Lists
 * every per-(user, device) manifest beacon the field client has
 * posted, so an admin can answer:
 *
 *   - Who has records stuck offline?
 *   - How long has device X been silent? (last reportedAt)
 *   - Is anyone about to run out of phone storage?
 *   - Which deployment is the queue piling up against?
 *
 * The admin's recourse is human: contact the worker, walk them
 * through a manual sync, or accept the data loss. The actual record
 * payloads aren't here -- the design keeps them on the device by
 * intent.
 */
export default async function AdminFieldQueuesPage() {
  let me: { orgRole: string };
  try {
    me = await apiFetch<{ orgRole: string }>('/api/users/me');
  } catch {
    redirect('/items');
  }
  if (me.orgRole !== 'admin') redirect('/items');

  let rows: FieldQueueRow[] = [];
  let staleAfterDays = 7;
  let error: string | null = null;
  try {
    // #276: pull rows + the configured stale threshold in parallel
    // so the view's default-hide filter matches the bulk-forget
    // cutoff on the server. The threshold lives in
    // HousekeepingConfig (singleton); admin tweaks it on the
    // Housekeeping page.
    const [rowsRes, cfgRes] = await Promise.all([
      apiFetch<FieldQueueRow[]>('/api/admin/field-queues'),
      apiFetch<{ fieldQueueStaleDays: number }>(
        '/api/admin/housekeeping/config',
      ),
    ]);
    rows = rowsRes;
    if (typeof cfgRes.fieldQueueStaleDays === 'number') {
      staleAfterDays = cfgRes.fieldQueueStaleDays;
    }
  } catch (err) {
    error =
      err instanceof Error
        ? err.message
        : 'Could not load field-queue manifests.';
  }

  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-10">
      <Link
        href="/items"
        className="mb-3 inline-flex items-center gap-1 text-xs text-muted hover:text-ink-0"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Back to portal
      </Link>
      <header className="mb-6 flex items-center gap-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-md bg-accent/10 text-accent">
          <ClipboardList className="h-5 w-5" />
        </span>
        <div>
          <p className="text-xs text-muted">Admin</p>
          <h1 className="text-2xl font-semibold tracking-tight">
            Field queues
          </h1>
          <p className="mt-0.5 text-sm text-muted">
            What every field device has queued offline, and when it last
            reported in. The record payloads stay on the device by
            design; this page is for triage, not recovery.
          </p>
        </div>
      </header>

      {error ? (
        <div className="mb-6 rounded-lg border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-danger">
          <p className="font-medium">Could not load field-queue manifests</p>
          <p className="mt-1 text-danger/90">{error}</p>
        </div>
      ) : null}

      <FieldQueuesView rows={rows} staleAfterDays={staleAfterDays} />
    </div>
  );
}
