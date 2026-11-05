// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { useT } from '@/lib/i18n/locale-context';

/**
 * Admins only. Hidden when the install is current, when the check is
 * offline, and on the Updates page itself.
 */
export function UpdateBanner({ admin }: { admin: boolean }) {
  const t = useT();
  const pathname = usePathname() ?? '';
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (!admin) return;
    let cancel = false;
    fetch('/api/portal/admin/updates')
      .then((res) => (res.ok ? res.json() : null))
      .then((body: { updateAvailable?: boolean; composeOutdated?: boolean; offline?: boolean } | null) => {
        if (cancel || !body || body.offline) return;
        if (body.updateAvailable || body.composeOutdated) setShow(true);
      })
      .catch(() => {});
    return () => {
      cancel = true;
    };
  }, [admin]);

  if (!admin || !show || pathname.startsWith('/admin/updates')) return null;

  return (
    <div className="border-b border-accent/40 bg-accent/10 px-4 py-2 text-sm text-ink-0">
      <Link href="/admin/updates" className="font-medium text-accent underline">
        {t('updates.banner')}
      </Link>
    </div>
  );
}
