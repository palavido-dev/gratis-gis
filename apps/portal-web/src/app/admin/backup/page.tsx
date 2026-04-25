import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Archive, ArrowLeft } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { BackupView, type BackupConfig, type BackupRun } from './backup-view';

/**
 * Admin-only dashboard for the backup system. Server-rendered shell
 * fetches the initial config + runs list so the page is usable
 * immediately on load; the BackupView client component then owns
 * the "run now", "delete", and polling-while-running behaviours.
 */
export default async function AdminBackupPage() {
  // Client-side admin guard; matches the pattern used on /admin/branding.
  // The API enforces via AdminGuard regardless; this just avoids a
  // raw 403 landing page for non-admins who hit the URL by accident.
  let me: { orgRole: string; orgId: string };
  try {
    me = await apiFetch<{ orgRole: string; orgId: string }>('/api/users/me');
  } catch {
    redirect('/items');
  }
  if (me.orgRole !== 'admin') redirect('/items');

  // Portal display name is the confirmation phrase on Restore
  // plain "Acme Corp" rather than the URL slug "acme-corp". Fetched
  // server-side so the dialog can prefill the prompt without an
  // extra round trip.
  let orgName = '';
  try {
    const org = await apiFetch<{ name: string }>(`/api/admin/branding`);
    orgName = org.name;
  } catch {
    // Swallow; the restore dialog will still refuse to submit when
    // the empty name doesn't match the API's own check.
  }

  // Load config + runs in parallel. If either fails we still render
  // the page with an error banner: operators need to be able to see
  // the page even when something is broken, since that's exactly
  // when they need it.
  let config: BackupConfig | null = null;
  let runs: BackupRun[] = [];
  let error: string | null = null;
  try {
    const [c, r] = await Promise.all([
      apiFetch<BackupConfig>('/api/admin/backup/config'),
      apiFetch<BackupRun[]>('/api/admin/backup/runs'),
    ]);
    config = c;
    runs = r;
  } catch (err) {
    error = err instanceof Error ? err.message : 'Could not load backup data.';
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
          <Archive className="h-5 w-5" />
        </span>
        <div>
          <p className="text-xs text-muted">Admin</p>
          <h1 className="text-2xl font-semibold tracking-tight">Backup</h1>
          <p className="mt-0.5 text-sm text-muted">
            Save a complete snapshot of your portal: all items,
            uploaded files, sharing, branding, and history: so you can
            recover if something goes wrong. Set a schedule below or
            take one on demand.
          </p>
        </div>
      </header>

      {error ? (
        <div className="mb-6 rounded-lg border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-danger">
          <p className="font-medium">Could not load backup data</p>
          <p className="mt-1 text-danger/90">{error}</p>
        </div>
      ) : null}

      {config ? (
        <BackupView
          initialConfig={config}
          initialRuns={runs}
          orgName={orgName}
        />
      ) : null}
    </div>
  );
}
