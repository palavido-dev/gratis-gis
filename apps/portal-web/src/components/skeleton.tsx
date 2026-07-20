// SPDX-License-Identifier: AGPL-3.0-or-later
/** Loading skeletons shown during data fetches instead of spinners. */
export function Skeleton({ className = '' }: { className?: string }) {
  return (
    <div
      className={`animate-pulse rounded-md bg-surface-2 ${className}`}
      aria-hidden="true"
    />
  );
}

export function CardSkeleton() {
  return (
    <div className="rounded-lg border border-border bg-surface-1 p-4 shadow-card">
      <Skeleton className="h-32 w-full" />
      <Skeleton className="mt-3 h-4 w-1/3" />
      <Skeleton className="mt-2 h-5 w-3/4" />
      <Skeleton className="mt-2 h-4 w-full" />
    </div>
  );
}

/**
 * Shared shape for the header + table pages (#173): admin surfaces
 * and list pages all render an icon-badge header followed by rows.
 * Route-level loading.tsx files compose this so every server-
 * rendered page paints a layout-faithful placeholder instead of a
 * blank canvas while its data fetches run.
 */
export function TablePageSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-10">
      <Skeleton className="h-3.5 w-24" />
      <div className="mt-4 flex items-center gap-3">
        <Skeleton className="h-10 w-10" />
        <div>
          <Skeleton className="h-3 w-14" />
          <Skeleton className="mt-1.5 h-6 w-48" />
        </div>
      </div>
      <div className="mt-6 overflow-hidden rounded-lg border border-border bg-surface-1 shadow-card">
        <div className="border-b border-border bg-surface-2 px-4 py-3">
          <Skeleton className="h-4 w-1/2" />
        </div>
        {Array.from({ length: rows }).map((_, i) => (
          <div
            key={i}
            className="flex items-center gap-4 border-b border-border px-4 py-3 last:border-0"
          >
            <Skeleton className="h-8 w-8 rounded-full" />
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="ml-auto h-4 w-24" />
            <Skeleton className="h-7 w-16" />
          </div>
        ))}
      </div>
    </div>
  );
}
