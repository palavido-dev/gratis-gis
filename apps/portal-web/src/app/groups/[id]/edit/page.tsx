// SPDX-License-Identifier: AGPL-3.0-or-later
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import type { Group } from '@gratis-gis/shared-types';
import { apiFetch } from '@/lib/api';
import { t } from '@/lib/i18n';
import { getServerLocale } from '@/lib/i18n/server';
import { GroupForm } from '../../group-form';

interface Props {
  params: Promise<{ id: string }>;
}

export async function generateMetadata() {
  const locale = await getServerLocale();
  return { title: t('groups.metaEditTitle', undefined, locale) };
}

export default async function EditGroupPage(props: Props) {
  const params = await props.params;
  const locale = await getServerLocale();
  let group: Group;
  try {
    group = await apiFetch<Group>(`/api/groups/${params.id}`);
  } catch (err) {
    if (err instanceof Error && err.message.includes('404')) notFound();
    throw err;
  }

  // Only the owner or an org admin should see this form. The API would
  // reject the PATCH anyway, but keeping the client gate in place means
  // we don't render a form that's going to 403 on submit.
  const me = await apiFetch<{ id: string; orgRole: string }>('/api/users/me');
  const canManage = me.id === group.ownerId || me.orgRole === 'admin';
  if (!canManage) redirect(`/groups/${group.id}`);

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-10">
      <Link
        href={`/groups/${group.id}`}
        className="mb-6 inline-flex items-center gap-1 text-sm text-muted hover:text-ink-0"
      >
        <ArrowLeft className="h-4 w-4" />
        {t('groups.backToGroup', undefined, locale)}
      </Link>

      <header className="mb-8">
        <p className="text-sm text-muted">
          {t('groups.editingEyebrow', undefined, locale)}
        </p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">
          {group.title}
        </h1>
      </header>

      <GroupForm
        mode={{ kind: 'edit', groupId: group.id }}
        initialValues={{
          title: group.title,
          description: group.description,
          access: group.access,
          thumbnailUrl: group.thumbnailUrl,
        }}
      />
    </div>
  );
}
