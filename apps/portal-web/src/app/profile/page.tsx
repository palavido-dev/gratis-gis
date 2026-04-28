import Link from 'next/link';
import { Bell, LogOut } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { AvatarEditor } from './avatar-editor';
import { ProfileIdentityForm } from './profile-identity-form';

interface Me {
  id: string;
  username: string;
  email: string;
  fullName: string;
  firstName: string;
  lastName: string;
  orgName: string | null;
  orgRole: string;
  avatarUrl: string | null;
}

export const metadata = { title: 'Profile' };

/**
 * Self-service profile page.
 *
 * Identity-editable fields (firstName, lastName, email) are PATCHed
 * through to Keycloak via `/api/users/me`. Username and org/role are
 * admin-managed: shown read-only so the user can always see what
 * they are without having to ask an admin.
 */
export default async function ProfilePage() {
  const me = await apiFetch<Me>('/api/users/me');

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-10">
      <header className="mb-8">
        <p className="text-sm text-muted">You</p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">Profile</h1>
        <p className="mt-2 max-w-2xl text-sm text-muted">
          Your identity in {me.orgName ?? 'this organization'}. Edit your name,
          email, or avatar here. Your username and role are managed by an
          admin.
        </p>
      </header>

      <section className="mb-8">
        <label className="mb-2 block text-xs font-medium uppercase tracking-wide text-muted">
          Avatar
        </label>
        <AvatarEditor
          userId={me.id}
          fullName={me.fullName}
          initialAvatarUrl={me.avatarUrl}
        />
      </section>

      <ProfileIdentityForm
        initial={{
          firstName: me.firstName,
          lastName: me.lastName,
          email: me.email,
        }}
      />

      <section className="mt-8 space-y-3 rounded-lg border border-border bg-surface-1 p-4 shadow-card">
        <p className="text-xs font-medium uppercase tracking-wide text-muted">
          Admin-managed
        </p>
        <Field label="Username" value={me.username} />
        <Field label="Organization" value={me.orgName ?? '-'} />
        <Field label="Role" value={me.orgRole} />
      </section>

      <section className="mt-8 flex flex-wrap items-center gap-2">
        <Link
          href="/settings/notifications"
          className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border bg-surface-1 px-3 text-sm font-medium text-ink-1 shadow-card hover:bg-surface-2"
        >
          <Bell className="h-4 w-4" />
          Notification preferences
        </Link>
        <Link
          href="/api/auth/federated-logout"
          className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border bg-surface-1 px-3 text-sm font-medium text-ink-1 shadow-card hover:bg-surface-2"
        >
          <LogOut className="h-4 w-4" />
          Sign out
        </Link>
      </section>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[8rem_1fr] items-baseline gap-4 text-sm">
      <dt className="text-xs font-medium uppercase tracking-wide text-muted">
        {label}
      </dt>
      <dd className="text-ink-0">{value}</dd>
    </div>
  );
}
