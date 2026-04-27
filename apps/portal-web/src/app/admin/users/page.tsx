import Link from 'next/link';
import { redirect } from 'next/navigation';
import { AlertTriangle, ArrowLeft, Shield } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { AdminUsersView } from './admin-users-view';

/** Shape we expose to the client. Matches Keycloak's user rep plus
 *  our `fullName` convenience and `lastSeenAt` (populated by
 *  AuthSyncService on every authenticated request). Kept narrow so
 *  we don't leak internal Keycloak fields we aren't actually using. */
export interface AdminUserRow {
  id: string;
  username: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  fullName?: string;
  enabled: boolean;
  emailVerified?: boolean;
  createdTimestamp?: number;
  attributes?: Record<string, string[]>;
  /** ISO timestamp of the last authenticated request we saw from
   *  this user, or null if they've never signed in. */
  lastSeenAt: string | null;
  /** Optional auto-disable timestamp (#85). When non-null and in
   *  the past, auth-sync rejects requests immediately; the
   *  housekeeping cron flips Keycloak's enabled flag in bulk.
   *  Null = no auto-disable (default). */
  autoDisableAt: string | null;
}

interface Meta {
  configured: boolean;
}

export default async function AdminUsersPage() {
  // Guard the page server-side: non-admins get bounced to /items rather
  // than seeing a 403 from the API. The backend controller also gates
  // with AdminGuard as the actual source of truth, so a sneaky client-
  // side nav or direct URL hit can't bypass it.
  let me: { orgRole: string };
  try {
    me = await apiFetch<{ orgRole: string }>('/api/users/me');
  } catch {
    redirect('/items');
  }
  if (me.orgRole !== 'admin') redirect('/items');

  // Ask the backend whether the Keycloak admin integration is
  // configured. Unconfigured = render a helpful banner pointing at
  // the env vars + service-account role mapping instead of letting
  // every row action 503.
  let meta: Meta;
  let users: AdminUserRow[] = [];
  let listError: string | null = null;
  try {
    meta = await apiFetch<Meta>('/api/admin/users/_meta');
  } catch {
    meta = { configured: false };
  }
  if (meta.configured) {
    try {
      users = await apiFetch<AdminUserRow[]>('/api/admin/users?max=200');
    } catch (err) {
      // Surface the failure instead of silently returning an empty
      // table: an empty result indistinguishable from "no users yet"
      // is exactly the bug report path that sent us here (admin client
      // not live in realm, service account missing a role, etc).
      listError =
        (err instanceof Error && err.message) ||
        'Could not load users from Keycloak.';
    }
  }

  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-10">
      <Link
        href="/items"
        className="mb-3 inline-flex items-center gap-1 text-xs text-muted hover:text-ink-0"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Back to portal
      </Link>
      <header className="mb-6 flex items-center gap-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-md bg-accent/10 text-accent">
          <Shield className="h-5 w-5" />
        </span>
        <div>
          <p className="text-xs text-muted">Admin</p>
          <h1 className="text-2xl font-semibold tracking-tight">Users</h1>
          <p className="mt-0.5 text-sm text-muted">
            Manage the built-in user store: invite new users, reset
            passwords, change roles, disable access.
          </p>
        </div>
      </header>

      {!meta.configured ? (
        <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <p className="font-medium">Admin API not configured</p>
          <p className="mt-1">
            Set <code className="font-mono">KEYCLOAK_ADMIN_CLIENT_ID</code>{' '}
            and{' '}
            <code className="font-mono">KEYCLOAK_ADMIN_CLIENT_SECRET</code>{' '}
            for the portal-api, and grant the service-account of the{' '}
            <code className="font-mono">portal-api-admin</code> client the{' '}
            <code className="font-mono">realm-management / manage-users</code>{' '}
            role in Keycloak.
          </p>
        </div>
      ) : listError ? (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-lg border border-danger/40 bg-danger/5 px-4 py-3 text-sm text-danger"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <p className="font-medium">Could not load users from Keycloak</p>
            <p className="mt-1 text-danger/90">{listError}</p>
            <p className="mt-2 text-xs text-danger/80">
              Common causes: the{' '}
              <code className="font-mono">portal-api-admin</code> client is
              missing from the realm, its service-account isn&apos;t granted
              <code className="ml-1 font-mono">
                realm-management / manage-users
              </code>
              , or the client secret in the portal-api env is stale.
            </p>
          </div>
        </div>
      ) : (
        <AdminUsersView initialUsers={users} />
      )}
    </div>
  );
}
