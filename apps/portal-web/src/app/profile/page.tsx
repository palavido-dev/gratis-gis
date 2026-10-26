// SPDX-License-Identifier: AGPL-3.0-or-later
import Link from 'next/link';
import { Bell, Key, LogOut } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { SignOutButton } from '@/components/user-menu';
import { t } from '@/lib/i18n';
import { getServerLocale } from '@/lib/i18n/server';
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

export async function generateMetadata() {
  const locale = await getServerLocale();
  return { title: t('profile.metaTitle', undefined, locale) };
}

/**
 * Self-service profile page.
 *
 * Identity-editable fields (firstName, lastName, email) are PATCHed
 * through to Keycloak via `/api/users/me`. Username and org/role are
 * admin-managed: shown read-only so the user can always see what
 * they are without having to ask an admin.
 */
export default async function ProfilePage() {
  const locale = await getServerLocale();
  const me = await apiFetch<Me>('/api/users/me');
  const org =
    me.orgName ?? t('profile.thisOrganization', undefined, locale);

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-10">
      <header className="mb-8">
        <p className="text-sm text-muted">
          {t('profile.eyebrow', undefined, locale)}
        </p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">
          {t('nav.profile', undefined, locale)}
        </h1>
        <p className="mt-2 max-w-2xl text-sm text-muted">
          {t('profile.pageIntro', { org }, locale)}
        </p>
      </header>

      <section className="mb-8">
        <label className="mb-2 block text-xs font-medium uppercase tracking-wide text-muted">
          {t('profile.profilePhoto', undefined, locale)}
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
          {t('profile.adminManaged', undefined, locale)}
        </p>
        <Field
          label={t('profile.fieldUsername', undefined, locale)}
          value={me.username}
        />
        <Field
          label={t('profile.fieldOrganization', undefined, locale)}
          value={me.orgName ?? '-'}
        />
        <Field
          label={t('profile.fieldRole', undefined, locale)}
          value={me.orgRole}
        />
      </section>

      <section className="mt-8 flex flex-wrap items-center gap-2">
        <Link
          href="/settings/notifications"
          className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border bg-surface-1 px-3 text-sm font-medium text-ink-1 shadow-card hover:bg-surface-2"
        >
          <Bell className="h-4 w-4" />
          {t('profile.linkNotificationPreferences', undefined, locale)}
        </Link>
        <Link
          href="/settings/api-keys"
          className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border bg-surface-1 px-3 text-sm font-medium text-ink-1 shadow-card hover:bg-surface-2"
        >
          <Key className="h-4 w-4" />
          {t('profile.linkApiKeys', undefined, locale)}
        </Link>
        {/* Sign out must run the client-side flow (NextAuth
            signOut() first, then the Keycloak end-session hop).
            A bare link to /api/auth/federated-logout leaves the
            NextAuth cookie alive, so the browser would come back
            still signed in to the portal. */}
        <SignOutButton className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border bg-surface-1 px-3 text-sm font-medium text-ink-1 shadow-card hover:bg-surface-2">
          <LogOut className="h-4 w-4" />
          {t('nav.signOut', undefined, locale)}
        </SignOutButton>
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
