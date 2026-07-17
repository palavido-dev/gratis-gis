// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Skeleton loading primitive (#173). Use content-shaped skeletons for
 * INITIAL data loads (tables, lists, cards) so the page telegraphs
 * its layout instead of showing a centered spinner; keep spinners for
 * in-flight ACTIONS (buttons, refreshes of already-visible content).
 *
 * Server-safe; no client hooks. The pulse respects the global
 * prefers-reduced-motion override in globals.css.
 */

export function Skeleton({ className = '' }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={`animate-pulse rounded-md bg-muted/20 ${className}`}
    />
  );
}

/** Convenience: a stack of table-ish rows for list/table loads. */
export function SkeletonRows({
  rows = 6,
  className = '',
}: {
  rows?: number;
  className?: string;
}) {
  return (
    <div className={`space-y-2 ${className}`} aria-hidden="true">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-3">
          <Skeleton className="h-4 w-4 shrink-0" />
          <Skeleton className="h-4 flex-1" />
          <Skeleton className="h-4 w-24 shrink-0" />
        </div>
      ))}
    </div>
  );
}
