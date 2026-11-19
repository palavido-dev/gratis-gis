// SPDX-License-Identifier: AGPL-3.0-or-later
import { Sparkles } from 'lucide-react';

/**
 * Next.js App Router renders this immediately on route transition
 * while the parent page.tsx's server async work runs.  Housekeeping
 * fires 13 parallel API calls and blocks the route on the slowest
 * one (storage scans, largest-tables pg_class queries) which can
 * take several seconds.  Without this file the user clicks the
 * link, the URL changes, and nothing visible happens until the
 * slowest fetch completes.  With it the user gets an instant
 * skeleton shell so the page feels responsive.
 *
 * Per-card streaming is still pending; for now the loading state
 * is whole-page.  When the Suspense refactor lands the slow cards
 * will inherit their own per-card skeletons.
 */
export default function Loading() {
  return (
    <div className="w-full max-w-5xl pb-10 pt-4">
      <header className="mb-6 flex items-center gap-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-md bg-accent/10 text-accent">
          <Sparkles className="h-5 w-5" />
        </span>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Cleanup suggestions
          </h1>
          <p className="mt-0.5 text-sm text-muted">
            Loading items and accounts that look like they could be
            reviewed or retired...
          </p>
        </div>
      </header>

      {/* Five skeleton card rows so the page reads as "stuff is
          coming" rather than empty.  Each pulses gently to signal
          loading without being noisy. */}
      <div className="space-y-6">
        {Array.from({ length: 5 }).map((_, i) => (
          <SkeletonCard key={i} />
        ))}
      </div>
    </div>
  );
}

function SkeletonCard() {
  return (
    <section className="animate-pulse rounded-lg border border-border bg-surface-1 p-5 shadow-card">
      <div className="mb-4 flex items-center gap-3">
        <span className="h-8 w-8 shrink-0 rounded-md bg-surface-2" />
        <span className="h-4 w-40 rounded-sm bg-surface-2" />
      </div>
      <div className="space-y-2">
        <div className="h-3 w-full rounded-sm bg-surface-2" />
        <div className="h-3 w-4/5 rounded-sm bg-surface-2" />
        <div className="h-3 w-2/3 rounded-sm bg-surface-2" />
      </div>
    </section>
  );
}
