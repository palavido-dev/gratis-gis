// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

/**
 * First-run welcome panel (#147 Phase 1). Rendered by the items page
 * in place of the plain empty state when the signed-in user's "My
 * items" scope is empty: three concrete starting points instead of a
 * gray dashed box. "Load sample data" fires the idempotent Randolph
 * County seeder and refreshes the list.
 *
 * Dismissal is per-browser (localStorage) rather than per-account:
 * the panel only ever shows on an empty scope, so it disappears on
 * its own the moment the user creates anything. The dismiss button
 * exists for the user who wants the plain empty state back.
 */
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Loader2, Map as MapIcon, Sparkles, Upload, X } from 'lucide-react';

import { BrandMark } from '@/components/brand-mark';
import { useT } from '@/lib/i18n/locale-context';
import { toast } from '@/lib/toast';

const DISMISS_KEY = 'gg.items.welcomeDismissed';

export function WelcomePanel({
  canPublish,
}: {
  /** Viewers cannot create items or run the seeder; they keep the
   *  regular empty state instead of dead-end cards. The server
   *  component gates on this too; the prop is belt and braces. */
  canPublish: boolean;
}) {
  const t = useT();
  const router = useRouter();
  const [dismissed, setDismissed] = useState(true);
  const [seeding, setSeeding] = useState(false);

  // localStorage is unavailable during SSR; start hidden and reveal
  // after mount so hydration stays consistent.
  useEffect(() => {
    try {
      setDismissed(localStorage.getItem(DISMISS_KEY) === '1');
    } catch {
      setDismissed(false);
    }
  }, []);

  if (dismissed || !canPublish) return null;

  async function loadSample() {
    setSeeding(true);
    try {
      const res = await fetch('/api/portal/items/sample-data', {
        method: 'POST',
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const body = (await res.json()) as {
        created: string[];
        skipped: string[];
      };
      if (body.created.length > 0) {
        toast.success(t('welcome.loaded', { count: body.created.length }));
      } else {
        toast.info(t('welcome.allSkipped'));
      }
      router.refresh();
    } catch {
      toast.error(t('welcome.failed'));
    } finally {
      setSeeding(false);
    }
  }

  function dismiss() {
    try {
      localStorage.setItem(DISMISS_KEY, '1');
    } catch {
      /* private mode; hide for this render only */
    }
    setDismissed(true);
  }

  return (
    <section className="relative rounded-lg border border-border bg-surface-1 p-6 shadow-card">
      <button
        type="button"
        onClick={dismiss}
        aria-label={t('welcome.dismiss')}
        className="absolute right-3 top-3 inline-flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-surface-2 hover:text-ink-1"
      >
        <X className="h-4 w-4" />
      </button>

      <div className="mb-5 flex items-center gap-3">
        <BrandMark size={34} />
        <div>
          <h2 className="text-lg font-semibold tracking-tight text-ink-0">
            {t('welcome.title')}
          </h2>
          <p className="text-sm text-muted">{t('welcome.intro')}</p>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <Link
          href="/items/new?type=map"
          className="group flex flex-col gap-1.5 rounded-md border border-border bg-surface-0 p-4 transition-colors hover:border-accent hover:bg-accent/5"
        >
          <MapIcon className="h-5 w-5 text-accent" aria-hidden="true" />
          <span className="text-sm font-medium text-ink-0">
            {t('welcome.createMap')}
          </span>
          <span className="text-xs leading-relaxed text-muted">
            {t('welcome.createMapDesc')}
          </span>
        </Link>

        <Link
          href="/items/new?type=data_layer"
          className="group flex flex-col gap-1.5 rounded-md border border-border bg-surface-0 p-4 transition-colors hover:border-accent hover:bg-accent/5"
        >
          <Upload className="h-5 w-5 text-accent" aria-hidden="true" />
          <span className="text-sm font-medium text-ink-0">
            {t('welcome.uploadData')}
          </span>
          <span className="text-xs leading-relaxed text-muted">
            {t('welcome.uploadDataDesc')}
          </span>
        </Link>

        <button
          type="button"
          onClick={loadSample}
          disabled={seeding}
          className="group flex flex-col gap-1.5 rounded-md border border-border bg-surface-0 p-4 text-left transition-colors hover:border-accent hover:bg-accent/5 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {seeding ? (
            <Loader2
              className="h-5 w-5 animate-spin text-accent"
              aria-hidden="true"
            />
          ) : (
            <Sparkles className="h-5 w-5 text-accent" aria-hidden="true" />
          )}
          <span className="text-sm font-medium text-ink-0">
            {seeding ? t('welcome.loading') : t('welcome.loadSample')}
          </span>
          <span className="text-xs leading-relaxed text-muted">
            {t('welcome.loadSampleDesc')}
          </span>
        </button>
      </div>
    </section>
  );
}
