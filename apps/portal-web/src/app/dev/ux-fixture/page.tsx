// SPDX-License-Identifier: AGPL-3.0-or-later
import { notFound } from 'next/navigation';
import { NewItemWizard } from '@/app/items/new/wizard';
import { NotificationsLink } from '@/components/notifications-link';
import { TopBarSearch } from '@/components/top-bar-search';

export const dynamic = 'force-dynamic';

/**
 * Synthetic surface for the task-first wizard, item search, and the
 * notifications link. It 404s unless GRATIS_UX_FIXTURE=1, so a normal
 * portal does not publish it.
 */
export default function UxFixturePage() {
  if (process.env.GRATIS_UX_FIXTURE !== '1') notFound();
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
