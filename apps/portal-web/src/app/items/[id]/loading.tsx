// SPDX-License-Identifier: AGPL-3.0-or-later
import { Skeleton } from '@/components/skeleton';

/**
 * Route-level skeleton for the item detail page (#173). This is
 * the heaviest server render in the portal (item + shares +
 * capabilities + per-type panels fetched before first paint), so
 * without it every item open sits on a blank canvas for the whole
 * round trip. The shapes mirror the real layout: back link,
 * icon + title header with action buttons, then the type panel
 * and related-items cards.
 */
export default function LoadingItemDetail() {
  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-10">
      <Skeleton className="h-3.5 w-24" />

      <div className="mt-4 flex items-center gap-3">
        <Skeleton className="h-10 w-10" />
        <Skeleton className="h-7 w-72" />
        <Skeleton className="h-5 w-16 rounded-full" />
        <div className="ml-auto flex gap-2">
          <Skeleton className="h-9 w-20" />
          <Skeleton className="h-9 w-24" />
          <Skeleton className="h-9 w-28" />
        </div>
      </div>
      <Skeleton className="mt-3 h-4 w-56" />

      <div className="mt-6 rounded-lg border border-border bg-surface-1 p-4 shadow-card">
        <Skeleton className="h-5 w-40" />
        <Skeleton className="mt-4 h-64 w-full" />
      </div>

      <div className="mt-6 rounded-lg border border-border bg-surface-1 p-4 shadow-card">
        <Skeleton className="h-5 w-32" />
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div>
            <Skeleton className="h-4 w-24" />
            <Skeleton className="mt-2 h-4 w-full" />
            <Skeleton className="mt-2 h-4 w-2/3" />
          </div>
          <div>
            <Skeleton className="h-4 w-24" />
            <Skeleton className="mt-2 h-4 w-full" />
            <Skeleton className="mt-2 h-4 w-2/3" />
          </div>
        </div>
      </div>
    </div>
  );
}
