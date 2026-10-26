// SPDX-License-Identifier: AGPL-3.0-or-later
import Link from 'next/link';
import { Plus, Users, Lock, Globe2, Building2 } from 'lucide-react';
import type { Group, GroupAccess } from '@gratis-gis/shared-types';
import { EntityBadge } from '@gratis-gis/ui';
import { apiFetch } from '@/lib/api';
import { EmptyState } from '@/components/empty-state';
import { t } from '@/lib/i18n';
import { getServerLocale } from '@/lib/i18n/server';

const accessIcon = {
  private: <Lock className="h-3.5 w-3.5" />,
  org: <Building2 className="h-3.5 w-3.5" />,
  public: <Globe2 className="h-3.5 w-3.5" />,
};

const accessLabelKey: Record<GroupAccess, string> = {
  private: 'groups.access.private',
  org: 'groups.access.org',
  public: 'groups.access.public',
};

export default async function GroupsPage() {
  const locale = await getServerLocale();
  const groups = await apiFetch<Group[]>('/api/groups');

  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-10">
      <header className="mb-6 flex items-end justify-between">
        <div>
          <p className="text-sm text-muted">
            {t('groups.eyebrow', undefined, locale)}
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">
            {t('nav.groups', undefined, locale)}
          </h1>
          <p className="mt-1 text-sm text-muted">
            {t('groups.visibleCount', { count: groups.length }, locale)}
          </p>
        </div>
        <Link
          href="/groups/new"
          className="inline-flex h-9 items-center gap-1.5 rounded-md bg-accent px-3 text-sm font-medium text-accent-foreground shadow-card hover:opacity-90"
        >
          <Plus className="h-4 w-4" />
          {t('groups.newGroup', undefined, locale)}
        </Link>
      </header>

      {groups.length === 0 ? (
        <EmptyState
          icon={<Users className="h-5 w-5" />}
          title={t('groups.emptyTitle', undefined, locale)}
          description={t('groups.emptyDescription', undefined, locale)}
          action={
            <Link
              href="/groups/new"
              className="inline-flex h-9 items-center gap-1.5 rounded-md bg-accent px-3 text-sm font-medium text-accent-foreground shadow-card hover:opacity-90"
            >
              <Plus className="h-4 w-4" />
              {t('groups.createGroup', undefined, locale)}
            </Link>
          }
        />
      ) : (
        <div className="divide-y divide-border rounded-lg border border-border bg-surface-1 shadow-card">
          {groups.map((g) => (
            <Link
              href={`/groups/${g.id}`}
              key={g.id}
              className="flex items-center justify-between gap-4 px-4 py-3 transition-colors hover:bg-surface-2"
            >
              <div className="flex min-w-0 items-center gap-3">
                <EntityBadge
                  label={g.title}
                  seed={g.id}
                  imageUrl={g.thumbnailUrl}
                  size="md"
                  rounded="md"
                />
                <div className="min-w-0">
                  <div className="truncate font-medium text-ink-1">{g.title}</div>
                  <div className="mt-0.5 truncate text-sm text-muted">
                    {g.description || '-'}
                  </div>
                </div>
              </div>
              <span className="inline-flex items-center gap-1 rounded-full border border-border bg-surface-2 px-2 py-0.5 text-xs text-muted">
                {accessIcon[g.access]}
                {t(accessLabelKey[g.access], undefined, locale)}
              </span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
