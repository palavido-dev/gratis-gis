// SPDX-License-Identifier: AGPL-3.0-or-later
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { GroupForm } from '../group-form';
import { t } from '@/lib/i18n';
import { getServerLocale } from '@/lib/i18n/server';

export async function generateMetadata() {
  const locale = await getServerLocale();
  return { title: t('groups.metaNewTitle', undefined, locale) };
}

export default async function NewGroupPage() {
  const locale = await getServerLocale();

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-10">
      <Link
        href="/groups"
        className="mb-6 inline-flex items-center gap-1 text-sm text-muted hover:text-ink-0"
      >
        <ArrowLeft className="h-4 w-4" />
        {t('groups.backToGroups', undefined, locale)}
      </Link>

      <header className="mb-8">
        <p className="text-sm text-muted">
          {t('groups.eyebrow', undefined, locale)}
        </p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">
          {t('groups.newPageTitle', undefined, locale)}
        </h1>
        <p className="mt-2 max-w-2xl text-sm text-muted">
          {t('groups.newPageIntro', undefined, locale)}
        </p>
      </header>

      <GroupForm mode={{ kind: 'create' }} />
    </div>
  );
}
