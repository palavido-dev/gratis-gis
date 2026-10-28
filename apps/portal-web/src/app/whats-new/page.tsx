// SPDX-License-Identifier: AGPL-3.0-or-later
import Link from 'next/link';
import type { Metadata } from 'next';
import { getServerSession } from 'next-auth';
import { ArrowLeft, LogIn, Sparkles } from 'lucide-react';
import { BrandMark } from '@/components/brand-mark';
import {
  formatChangelogDate,
  WhatsNewEntryList,
} from '@/components/whats-new-list';
import { authOptions } from '@/lib/auth';
import { t } from '@/lib/i18n';
import { getServerLocale } from '@/lib/i18n/server';
import {
  groupWhatsNewByRelease,
  loadWhatsNewEntries,
} from '@/lib/whats-new';

/**
 * Full What's new history. The landing card shows the five newest
 * entries; this page is the jump-out for scrolling the entire
 * user-visible changelog, grouped by release when the markdown
 * carries `## [X.Y.Z] - YYYY-MM-DD` banners.
 */
export async function generateMetadata(): Promise<Metadata> {
  const locale = await getServerLocale();
  return {
    title: t('whatsNewPage.metaTitle', undefined, locale),
    description: t('whatsNewPage.metaDescription', undefined, locale),
  };
}

export default async function WhatsNewPage() {
  const locale = await getServerLocale();
  const session = await getServerSession(authOptions);
  const isAuthenticated = !!session;
  const entries = await loadWhatsNewEntries();
  const groups = groupWhatsNewByRelease(entries);

  return (
    <div className="flex min-h-screen flex-col bg-surface-0">
      {!isAuthenticated ? <TopBar locale={locale} /> : null}

      <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-12 sm:py-16">
        <Link
          href="/"
          className="inline-flex items-center gap-1.5 text-xs font-medium text-muted hover:text-ink-0"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          {t('whatsNewPage.backToHome', undefined, locale)}
        </Link>

        <header className="mt-6">
          <div className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-accent" aria-hidden="true" />
            <h1 className="text-3xl font-semibold tracking-tight text-ink-0 sm:text-4xl">
              {t('whatsNewPage.title', undefined, locale)}
            </h1>
          </div>
          <p className="mt-3 text-base text-muted">
            {t('whatsNewPage.intro', undefined, locale)}
          </p>
        </header>

        {groups.length === 0 ? (
          <p className="mt-10 text-sm text-muted">
            {t('whatsNewPage.empty', undefined, locale)}
          </p>
        ) : (
          <div className="mt-10 space-y-10">
            {groups.map((group) => (
              <section
                key={
                  group.release
                    ? `release-${group.release}`
                    : 'earlier-updates'
                }
              >
                <h2 className="mb-4 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 border-b border-border pb-2 text-lg font-semibold tracking-tight text-ink-0">
                  {group.release ? (
                    <>
                      <span>
                        {t(
                          'whatsNewPage.releaseHeading',
                          { version: group.release },
                          locale,
                        )}
                      </span>
                      {group.releaseDate ? (
                        <time
                          dateTime={group.releaseDate}
                          className="font-mono text-xs font-normal uppercase tracking-wide text-muted"
                        >
                          {formatChangelogDate(group.releaseDate, locale)}
                        </time>
                      ) : null}
                    </>
                  ) : (
                    t('whatsNewPage.earlierHeading', undefined, locale)
                  )}
                </h2>
                <WhatsNewEntryList entries={group.entries} locale={locale} />
              </section>
            ))}
          </div>
        )}
      </main>

      <footer className="border-t border-border bg-surface-1 py-6 text-center text-xs text-muted">
        <Link href="/" className="underline hover:text-ink-0">
          {t('nav.home', undefined, locale)}
        </Link>
      </footer>
    </div>
  );
}

function TopBar({
  locale,
}: {
  locale: Awaited<ReturnType<typeof getServerLocale>>;
}) {
  return (
    <header className="flex h-[calc(3.5rem+env(safe-area-inset-top))] items-center justify-between border-b border-border bg-surface-1 px-6 pt-[env(safe-area-inset-top)]">
      <Link href="/" className="flex items-center gap-2">
        <BrandMark size={26} />
        <span className="text-base font-semibold tracking-tight">
          GratisGIS
        </span>
      </Link>
      <Link
        href="/signin"
        className="inline-flex h-9 items-center gap-1.5 rounded-md bg-accent px-3 text-sm font-medium text-accent-foreground hover:opacity-90"
      >
        <LogIn className="h-4 w-4" />
        {t('nav.signIn', undefined, locale)}
      </Link>
    </header>
  );
}
