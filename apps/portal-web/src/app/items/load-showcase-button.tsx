// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, LayoutDashboard } from 'lucide-react';

import { useT } from '@/lib/i18n/locale-context';
import { toast } from '@/lib/toast';

/**
 * Loads the built-in showcase dashboards. Visible on an install that
 * already has items, where the empty-workspace welcome panel is gone.
 */
export function LoadShowcaseButton() {
  const t = useT();
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const res = await fetch('/api/portal/items/showcase-data', {
        method: 'POST',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { created: string[]; skipped: string[] };
      if (body.created.length > 0) {
        toast.success(t('welcome.loadedShowcase', { count: body.created.length }));
      } else {
        toast.info(t('welcome.allSkippedShowcase'));
      }
      router.refresh();
    } catch {
      toast.error(t('welcome.failedShowcase'));
    } finally {
      setLoading(false);
    }
  }

  return (
    <button
      type="button"
      onClick={load}
      disabled={loading}
      className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border bg-surface-1 px-3 text-sm font-medium text-ink-1 shadow-card hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-60"
    >
      {loading ? (
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
      ) : (
        <LayoutDashboard className="h-4 w-4" aria-hidden="true" />
      )}
      {loading ? t('welcome.loadingShowcase') : t('welcome.loadShowcase')}
    </button>
  );
}
