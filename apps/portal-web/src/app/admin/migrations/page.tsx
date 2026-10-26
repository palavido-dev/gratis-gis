// SPDX-License-Identifier: AGPL-3.0-or-later
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ArrowLeft, ArrowRightLeft, CloudDownload, CloudUpload } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { t } from '@/lib/i18n';
import { getServerLocale } from '@/lib/i18n/server';

/**
 * Admin-only migrations hub.
 *
 * Single landing page for every importer / exporter the portal
 * supports. Today: AGO import. Future siblings: AGO export, QGIS
 * project file import, PostGIS direct sync, etc. Each migration
 * gets a card here; the card links to its own sub-page where the
 * actual flow lives.
 *
 * Kept separate from /admin/housekeeping on purpose: housekeeping
 * is about cleaning up what's already in the portal; migrations
 * are about moving data between systems.
 */
export default async function AdminMigrationsPage() {
  let me: { orgRole: string };
  try {
    me = await apiFetch<{ orgRole: string }>('/api/users/me');
  } catch {
    redirect('/items');
  }
  if (me.orgRole !== 'admin') redirect('/items');
  const locale = await getServerLocale();

  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-10">
      <Link
        href="/items"
        className="mb-3 inline-flex items-center gap-1 text-xs text-muted hover:text-ink-0"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        {t('adminHousekeeping.backToPortal', undefined, locale)}
      </Link>
      <header className="mb-6 flex items-center gap-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-md bg-accent/10 text-accent">
          <ArrowRightLeft className="h-5 w-5" />
        </span>
        <div>
          <p className="text-xs text-muted">
            {t('nav.admin', undefined, locale)}
          </p>
          <h1 className="text-2xl font-semibold tracking-tight">
            {t('nav.migrations', undefined, locale)}
          </h1>
          <p className="mt-0.5 text-sm text-muted">
            {t('adminMigrations.pageIntro', undefined, locale)}
          </p>
        </div>
      </header>

      <section className="grid gap-4 sm:grid-cols-2">
        <MigrationCard
          href="/admin/migrations/from-ago"
          icon={<CloudDownload className="h-5 w-5" />}
          direction={t('adminMigrations.directionImport', undefined, locale)}
          title={t('adminMigrations.cardAgoImportTitle', undefined, locale)}
          description={t(
            'adminMigrations.cardAgoImportDescription',
            undefined,
            locale,
          )}
          status="ready"
          plannedLabel={t('adminMigrations.statusPlanned', undefined, locale)}
        />
        <MigrationCard
          href="#"
          icon={<CloudUpload className="h-5 w-5" />}
          direction={t('adminMigrations.directionExport', undefined, locale)}
          title={t('adminMigrations.cardAgoExportTitle', undefined, locale)}
          description={t(
            'adminMigrations.cardAgoExportDescription',
            undefined,
            locale,
          )}
          status="planned"
          plannedLabel={t('adminMigrations.statusPlanned', undefined, locale)}
        />
        <MigrationCard
          href="#"
          icon={<CloudDownload className="h-5 w-5" />}
          direction={t('adminMigrations.directionImport', undefined, locale)}
          title={t('adminMigrations.cardQgisTitle', undefined, locale)}
          description={t(
            'adminMigrations.cardQgisDescription',
            undefined,
            locale,
          )}
          status="planned"
          plannedLabel={t('adminMigrations.statusPlanned', undefined, locale)}
        />
        <MigrationCard
          href="#"
          icon={<CloudDownload className="h-5 w-5" />}
          direction={t('adminMigrations.directionImport', undefined, locale)}
          title={t('adminMigrations.cardPostgisTitle', undefined, locale)}
          description={t(
            'adminMigrations.cardPostgisDescription',
            undefined,
            locale,
          )}
          status="planned"
          plannedLabel={t('adminMigrations.statusPlanned', undefined, locale)}
        />
      </section>
    </div>
  );
}

function MigrationCard(props: {
  href: string;
  icon: React.ReactNode;
  direction: string;
  title: string;
  description: string;
  status: 'ready' | 'planned';
  plannedLabel: string;
}) {
  const isReady = props.status === 'ready';
  const inner = (
    <div
      className={`flex h-full flex-col gap-2 rounded-lg border bg-surface-1 p-4 shadow-card transition ${
        isReady
          ? 'border-border hover:border-accent hover:bg-surface-2'
          : 'border-border/60 opacity-60'
      }`}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span
            className={`flex h-8 w-8 items-center justify-center rounded-md ${
              isReady ? 'bg-accent/10 text-accent' : 'bg-surface-2 text-muted'
            }`}
          >
            {props.icon}
          </span>
          <span className="text-2xs font-medium uppercase tracking-wide text-muted">
            {props.direction}
          </span>
        </div>
        {isReady ? null : (
          <span className="rounded bg-surface-2 px-1.5 py-0.5 text-2xs uppercase tracking-wide text-muted">
            {props.plannedLabel}
          </span>
        )}
      </div>
      <h2 className="text-sm font-semibold text-ink-0">{props.title}</h2>
      <p className="text-xs text-muted">{props.description}</p>
    </div>
  );
  return isReady ? (
    <Link href={props.href} className="block">
      {inner}
    </Link>
  ) : (
    <div>{inner}</div>
  );
}
