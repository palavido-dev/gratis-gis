// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  CloudDownload,
  CloudOff,
  ClipboardList,
  ChevronRight,
  Loader2,
  Trash2,
  Wifi,
} from 'lucide-react';
import {
  listDeployments,
  listQueue,
  type CachedDeployment,
} from '@/lib/offline-store';
import { removeDeploymentFromDevice } from '@/lib/offline-remove';
import { formatBytes } from '@/lib/format-bytes';
import { postQueueManifest } from '@/lib/offline-queue-beacon';
import { syncQueue } from '@/lib/offline-sync';

/**
 * Server-side row shape we get from page.tsx. Mirrors the slice of
 * ItemWithShares the catalog actually consumes; we don't carry the
 * full item to keep the bundle small. The client merges this with
 * IDB-side state on mount.
 */
export interface FieldDeploymentRow {
  id: string;
  title: string;
  description: string;
  ownerLabel: string | null;
  updatedAt: string;
  mapId: string | null;
}

/**
 * Per-deployment overlay we compute client-side. The cache state is
 * read from IndexedDB; queue counts come from the queue store. Both
 * are scoped per deployment id; both are zero / null when the user
 * hasn't downloaded this deployment yet.
 */
interface DeploymentOverlay {
  cached: CachedDeployment | null;
  queueCount: number;
}

/**
 * Catalog body. Renders one row per deployment with cache + queue
 * state surfaced inline. Per-row affordances:
 *
 *   - "Open" link to the runtime (always available).
 *   - "Sync N" button when records are queued and the device is
 *     online. Drains just that deployment's queue.
 *   - "Cached / Not cached" indicator with size + age.
 *
 * The catalog itself doesn't hold any storage estimate -- the
 * runtime header does that for the active deployment. Per-deployment
 * size from the manifest is enough here.
 */
export function FieldCatalog({ rows }: { rows: FieldDeploymentRow[] }) {
  const [overlays, setOverlays] = useState<Record<string, DeploymentOverlay>>(
    {},
  );
  const [isOnline, setIsOnline] = useState(
    typeof navigator !== 'undefined' ? navigator.onLine : true,
  );
  const [syncing, setSyncing] = useState<Record<string, boolean>>({});
  // Two-tap confirmation for the destructive Remove action: first tap
  // sets confirmingId, the affordance morphs to a red Confirm button,
  // the second tap commits. Tap-elsewhere clears the armed state so a
  // user can back out by just walking away. Cheaper than a full modal
  // on a phone and matches the runtime More menu's pattern.
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [removing, setRemoving] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onUp = () => setIsOnline(true);
    const onDown = () => setIsOnline(false);
    window.addEventListener('online', onUp);
    window.addEventListener('offline', onDown);
    return () => {
      window.removeEventListener('online', onUp);
      window.removeEventListener('offline', onDown);
    };
  }, []);

  // Initial load: walk every cached deployment + every queue read
  // once so the rows render with current state. Cheap (a few
  // IndexedDB reads); no need to fan these out as the user
  // navigates.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const cachedList = await listDeployments();
      const cachedById = new Map(
        cachedList.map((c) => [c.dataCollectionId, c]),
      );
      const next: Record<string, DeploymentOverlay> = {};
      for (const row of rows) {
        const queue = await listQueue(row.id);
        next[row.id] = {
          cached: cachedById.get(row.id) ?? null,
          queueCount: queue.length,
        };
      }
      if (!cancelled) setOverlays(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [rows]);

  async function syncOne(id: string) {
    setSyncing((prev) => ({ ...prev, [id]: true }));
    try {
      await syncQueue(id);
      // Refresh the row's queue count after the run.
      const remaining = await listQueue(id);
      setOverlays((prev) => ({
        ...prev,
        [id]: {
          ...(prev[id] ?? { cached: null, queueCount: 0 }),
          queueCount: remaining.length,
        },
      }));
    } finally {
      setSyncing((prev) => ({ ...prev, [id]: false }));
    }
  }

  async function removeOne(id: string) {
    setRemoving((prev) => ({ ...prev, [id]: true }));
    setConfirmingId(null);
    try {
      // Removes the prepared basemap archive too; deleteDeployment
      // only cascades through IndexedDB and left the largest artefact
      // of the download sitting in Cache Storage.
      await removeDeploymentFromDevice(id);
      // Local optimistic update so the row's status dot flips back to
      // gray immediately. The next listDeployments / listQueue pass
      // would catch up on its own but this keeps the UI snappy.
      setOverlays((prev) => ({
        ...prev,
        [id]: { cached: null, queueCount: 0 },
      }));
      // Tell the admin's field-queue mirror that this device's
      // manifest just shrank. Bypasses the throttle deliberately:
      // removal is a meaningful state change, not chatter.
      void postQueueManifest();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('Failed to remove offline cache:', err);
    } finally {
      setRemoving((prev) => ({ ...prev, [id]: false }));
    }
  }

  // Sort: deployments with queued edits float to the top (the user
  // most likely wants to see those), then by updatedAt desc.
  const sorted = [...rows].sort((a, b) => {
    const qa = overlays[a.id]?.queueCount ?? 0;
    const qb = overlays[b.id]?.queueCount ?? 0;
    if (qa !== qb) return qb - qa;
    return b.updatedAt.localeCompare(a.updatedAt);
  });

  return (
    <div className="space-y-4">
      {/* Connectivity banner: a thin reminder at the top so the
          worker knows whether sync is going to run on tap. */}
      <div
        className={`flex items-center gap-2 rounded-md border px-3 py-2 text-xs ${
          isOnline
            ? 'border-success/30 bg-success/10 text-success'
            : 'border-warn/30 bg-warn/10 text-warn'
        }`}
      >
        {isOnline ? (
          <>
            <Wifi className="h-3.5 w-3.5" />
            <span>Online. Tap a deployment to open.</span>
          </>
        ) : (
          <>
            <CloudOff className="h-3.5 w-3.5" />
            <span>
              Offline. Cached deployments are still openable; queued edits
              will sync when you reconnect.
            </span>
          </>
        )}
      </div>

      {/* Field Maps style row layout (#226). On mobile each row is
          a tap target that opens the deployment, with a compact
          status dot for cache state and a tiny pill for queued
          edits. Desktop keeps the previous denser layout via sm:
          breakpoints because there's room for the description and
          the explicit Open button there. */}
      <ul className="divide-y divide-border overflow-hidden rounded-md border border-border bg-surface-1 sm:border-0">
        {sorted.map((row) => {
          const overlay = overlays[row.id] ?? {
            cached: null,
            queueCount: 0,
          };
          const cached = overlay.cached !== null;
          return (
            <li key={row.id}>
              <Link
                href={`/items/${row.id}/field?from=field`}
                className="flex w-full items-center gap-3 p-3 transition-colors hover:bg-surface-2 active:bg-surface-2"
              >
                <span
                  aria-hidden="true"
                  className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-accent/10 text-accent sm:h-9 sm:w-9"
                >
                  <ClipboardList className="h-4 w-4" />
                  {/* Cache status dot, lower-right of the thumbnail.
                      Green = cached, gray = not cached. Mobile reads
                      the dot at a glance instead of a wordy pill. */}
                  <span
                    aria-hidden="true"
                    className={`absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-surface-1 ${
                      cached ? 'bg-success' : 'bg-muted/50'
                    }`}
                    title={
                      cached
                        ? `Cached: ${formatBytes(
                            overlay.cached!.estimatedSize,
                          )}`
                        : 'Not cached'
                    }
                  />
                </span>
                <div className="min-w-0 flex-1">
                  <h2 className="truncate text-sm font-semibold text-ink-0">
                    {row.title}
                  </h2>
                  {/* Description hides on mobile to keep rows
                      single-line. Desktop sees it on a second line. */}
                  {row.description ? (
                    <p className="hidden truncate text-2xs text-muted sm:block">
                      {row.description}
                    </p>
                  ) : null}
                  {/* Queued edits + Remove chips. The queue chip
                      surfaces unsynced work; the Remove chip lets a
                      user clear an offline cache they no longer need
                      from the catalog without opening the runtime.
                      Both stop propagation so the row's primary tap
                      keeps opening the deployment. */}
                  {(overlay.queueCount > 0 || cached) ? (
                    <div className="mt-1 flex flex-wrap items-center gap-1 text-2xs">
                      {overlay.queueCount > 0 ? (
                        isOnline ? (
                          <button
                            type="button"
                            disabled={syncing[row.id]}
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              void syncOne(row.id);
                            }}
                            className="inline-flex items-center gap-1 rounded-full border border-warn/30 bg-warn/10 px-2 py-0.5 text-warn hover:bg-warn/20 disabled:opacity-60"
                          >
                            {syncing[row.id] ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                              <CloudDownload className="h-3 w-3 rotate-180" />
                            )}
                            {syncing[row.id]
                              ? 'Syncing...'
                              : `Sync ${overlay.queueCount}`}
                          </button>
                        ) : (
                          <span className="inline-flex items-center gap-1 rounded-full border border-border bg-surface-2 px-2 py-0.5 text-muted">
                            <CloudOff className="h-3 w-3" />
                            {overlay.queueCount} queued
                          </span>
                        )
                      ) : null}
                      {cached ? (
                        <button
                          type="button"
                          disabled={removing[row.id]}
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            if (confirmingId !== row.id) {
                              setConfirmingId(row.id);
                              return;
                            }
                            void removeOne(row.id);
                          }}
                          className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 disabled:opacity-60 ${
                            confirmingId === row.id
                              ? 'border-danger/40 bg-danger/10 text-danger hover:bg-danger/15'
                              : 'border-border bg-surface-2 text-muted hover:bg-surface-1'
                          }`}
                          title={
                            confirmingId === row.id
                              ? overlay.queueCount > 0
                                ? `${overlay.queueCount} unsynced edit${
                                    overlay.queueCount === 1 ? '' : 's'
                                  } will be lost.`
                                : 'Tap again to remove from device.'
                              : 'Remove this deployment from your device.'
                          }
                        >
                          {removing[row.id] ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            <Trash2 className="h-3 w-3" />
                          )}
                          {removing[row.id]
                            ? 'Removing...'
                            : confirmingId === row.id
                              ? overlay.queueCount > 0
                                ? `Confirm remove (${overlay.queueCount} unsynced)`
                                : 'Confirm remove'
                              : 'Remove from device'}
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                </div>
                <ChevronRight className="h-4 w-4 shrink-0 text-muted" />
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
