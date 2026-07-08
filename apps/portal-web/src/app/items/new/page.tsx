// SPDX-License-Identifier: AGPL-3.0-or-later
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import {
  NewItemWizard,
  type AppTemplateSummary,
} from './wizard';
import { getServerLocale } from '@/lib/i18n/server';
import { t } from '@/lib/i18n';

export const metadata = { title: 'New item' };

export default async function NewItemPage() {
  const locale = await getServerLocale();
  // #22: load all app_template items the user can read so the
  // Custom Web App gallery can show built-in starters AND any
  // user-saved templates side-by-side.  Failure here drops to an
  // empty list, which the wizard handles with a friendly empty
  // state; create still works (the user can save a blank app and
  // edit from there).
  let appTemplates: AppTemplateSummary[] = [];
  try {
    type ItemListResponse = {
      id: string;
      title: string;
      description: string;
      tags: string[];
      ownerId: string;
      data?: unknown;
    }[];
    const rows = await apiFetch<ItemListResponse>(
      '/api/items?type=app_template&lite=1',
    );
    appTemplates = rows.map((r) => ({
      itemId: r.id,
      title: r.title,
      description: r.description,
      tags: r.tags,
    }));
  } catch {
    // Empty list is the right fallback; the wizard handles it.
  }

  return (
    <div className="mx-auto w-full max-w-4xl px-6 py-10">
      <Link
        href="/items"
        className="mb-6 inline-flex items-center gap-1 text-sm text-muted hover:text-ink-0"
      >
        <ArrowLeft className="h-4 w-4" />
        {t('common.backToItems', undefined, locale)}
      </Link>

      <header className="mb-8">
        <p className="text-sm text-muted">{t('itemsPage.eyebrow', undefined, locale)}</p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">
          {t('newItem.pageTitle', undefined, locale)}
        </h1>
        <p className="mt-2 max-w-2xl text-sm text-muted">
          {t('newItem.pageIntro', undefined, locale)}
        </p>
      </header>

      <NewItemWizard appTemplates={appTemplates} />
    </div>
  );
}
