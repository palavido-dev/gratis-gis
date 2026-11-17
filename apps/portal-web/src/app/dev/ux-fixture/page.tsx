// SPDX-License-Identifier: AGPL-3.0-or-later
import { notFound } from 'next/navigation';
import { NewItemWizard } from '@/app/items/new/wizard';
import { NotificationsLink } from '@/components/notifications-link';
import { TopBarSearch } from '@/components/top-bar-search';

export const dynamic = 'force-dynamic';

/**
 * Dev-only surface for the real new-item wizard, the real search
 * box, and the real notifications link. It has no session and loads
 * no portal data. It 404s in production even if GRATIS_UX_FIXTURE=1,
 * and it 404s in development unless that variable is exactly 1.
 */
export default function UxFixturePage() {
  // Production never serves this route, even if the variable is set.
  // It renders the real wizard with no session and no portal data.
  if (
    process.env.NODE_ENV === 'production' ||
    process.env.GRATIS_UX_FIXTURE !== '1'
  ) {
    notFound();
  }
  return (
    <main className="mx-auto w-full max-w-4xl px-4 py-6">
      <h1 className="text-xl font-semibold">UX fixture</h1>
      <div className="mt-4 flex items-center gap-2">
        <TopBarSearch />
        <NotificationsLink />
      </div>
      <div className="mt-8">
        <NewItemWizard scriptsEnabled />
      </div>
    </main>
  );
}
