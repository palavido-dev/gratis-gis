// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ChevronRight } from 'lucide-react';

import { sectionForPath } from '@/lib/admin-sections';
import { useT } from '@/lib/i18n/locale-context';

/**
 * Admin › group › page above each admin page. Nothing on the admin
 * home itself. Getting started has no group, so it shows only the
 * way back.
 */
export function AdminBreadcrumb() {
  const pathname = usePathname() ?? '';
  const t = useT();
  // Nothing on the home itself, or in the ArcGIS Online sign-in popup.
  if (pathname === '/admin' || pathname.includes('/oauth-callback')) return null;
  const section = sectionForPath(pathname);
  return (
    <nav
      aria-label={t('adminHome.title')}
      className="text-xs text-muted"
    >
      <ol className="flex flex-wrap items-center gap-1">
        <li>
          <Link href="/admin" className="hover:text-ink-0 hover:underline">
            {t('adminHome.title')}
          </Link>
        </li>
        {section ? (
          <>
            <li aria-hidden="true">
              <ChevronRight className="h-3 w-3" />
            </li>
            <li>
              <Link href={`/admin#${section.group}`} className="hover:text-ink-0 hover:underline">
                {t(`adminHome.groups.${section.group}`)}
              </Link>
            </li>
            <li aria-hidden="true">
              <ChevronRight className="h-3 w-3" />
            </li>
            <li aria-current="page" className="text-ink-1">
              {t(`adminHome.cards.${section.id}.title`)}
            </li>
          </>
        ) : null}
      </ol>
    </nav>
  );
}
