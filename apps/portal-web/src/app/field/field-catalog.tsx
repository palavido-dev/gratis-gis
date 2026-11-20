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
} from 'lucide-react';
import {
  listDeployments,
  listQueue,
  listQueueAllOwners,
  type CachedDeployment,
} from '@/lib/offline-store';
import { removeDeploymentFromDevice } from '@/lib/offline-remove';
import { useIsOnline } from '@/lib/use-is-online';
import { formatBytes } from '@/lib/format-bytes';
import {
  postQueueManifest,
  postQueueManifestThrottled,
} from '@/lib/offline-queue-beacon';
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
  /** Uploaded or designed item thumbnail, when the item has one. */
  thumbnailUrl: string | null;
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
  /** This account's queued edits: what the Sync chip will send. */
  queueCount: number;
  /** Queued edits another account left on this device. Not this
   *  account's to sync, so they are not in the chip, but Remove
   *  destroys them too and its warning has to say so. */
  parkedForOthers: number;
  /** Why the last Sync tap left edits behind, if it did. */
  syncNote?: string | null;
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
 * The catalog itself doesn't hold any storage estimate; the
 * runtime header does that for the active deployment. Per-deployment
 * size from the manifest is enough here.
 */
export function FieldCatalog({
  rows,
  currentUserId,
  sectionLabel,
}: {
  rows: FieldDeploymentRow[];
  /** Small grey heading above the list, from the server locale. */
  sectionLabel: string;
  /** The signed-in account's portal user id, from the server render.
   *  Every queue read and the per-row drain run as this account. */
  currentUserId: string;
}) {
  const [overlays, setOverlays] = useState<Record<string, DeploymentOverlay>>(
    {},
  );
  const isOnline = useIsOnline();
  const [syncing, setSyncing] = useState<Record<string, boolean>>({});
  // Two-tap confirmation for the destructive Remove action: first tap
  // sets confirmingId, the affordance morphs to a red Confirm button,
  // the second tap commits. Tap-elsewhere clears the armed state so a
  // user can back out by just walking away (the effect below). Cheaper
  // than a full modal on a phone and matches the runtime More menu's
  // pattern.
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  useEffect(() => {
    if (!confirmingId) return;
    // Disarm on any tap outside the armed chip, and after a few
    // seconds regardless. Before this nothing disarmed it, so a single
    // tap much later deleted the deployment and its unsynced edits.
    function onPointerDown(e: PointerEvent) {
      const target = e.target as Element | null;
      if (target?.closest(`[data-remove-id="${confirmingId}"]`)) return;
      setConfirmingId(null);
    }
    document.addEventListener('pointerdown', onPointerDown, true);
    const timer = window.setTimeout(() => setConfirmingId(null), 6000);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      window.clearTimeout(timer);
    };
  }, [confirmingId]);
  const [removing, setRemoving] = useState<Record<string, boolean>>({});

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
        const queue = await listQueue(row.id, currentUserId);
        const everyRow = await listQueueAllOwners(row.id);
        next[row.id] = {
          cached: cachedById.get(row.id) ?? null,
          queueCount: queue.length,
          parkedForOthers: everyRow.length - queue.length,
        };
      }
      if (!cancelled) setOverlays(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [rows, currentUserId]);

  async function syncOne(id: string) {
    setSyncing((prev) => ({ ...prev, [id]: true }));
    let syncNote: string | null = null;
    try {
      // manual: a tap is the user asking now, so rows waiting out the
      // retry backoff go too, as the runtime's Sync button does.
      const result = await syncQueue(id, { currentUserId, manual: true });
      const notSent = result.failed + result.rejected;
      if (notSent > 0) {
        syncNote = `${notSent} not sent. Open the deployment to see why.`;
      }
      // Refresh the row's queue count after the run.
      const remaining = await listQueue(id, currentUserId);
      setOverlays((prev) => ({
        ...prev,
        [id]: {
          ...(prev[id] ?? { cached: null, queueCount: 0, parkedForOthers: 0 }),
          queueCount: remaining.length,
          syncNote,
        },
      }));
      void postQueueManifestThrottled(currentUserId);
    } catch {
      // The queue read itself failed (IndexedDB refused). Called with
      // `void`, so without this it was an unhandled rejection and the
      // chip just stopped spinning.
      setOverlays((prev) => ({
        ...prev,
        [id]: {
          ...(prev[id] ?? { cached: null, queueCount: 0, parkedForOthers: 0 }),
          syncNote: 'Could not read the offline queue on this device.',
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
      // The whole cascade: IndexedDB, the prepared basemap archive
      // and the service worker tile cache. deleteDeployment alone only
      // covered the first and left the largest artefacts behind.
      await removeDeploymentFromDevice(id);
      // Local optimistic update so the row's status dot flips back to
      // gray immediately. The next listDeployments / listQueue pass
      // would catch up on its own but this keeps the UI snappy.
      setOverlays((prev) => ({
        ...prev,
        [id]: { cached: null, queueCount: 0, parkedForOthers: 0 },
      }));
      // Tell the admin's field-queue mirror that this device's
      // manifest just shrank. Bypasses the throttle deliberately:
      // removal is a meaningful state change, not chatter.
      void postQueueManifest(currentUserId);
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
    <div className="space-y-3">
      {/* Offline banner. Online is the normal case and needs no
          banner; offline changes what the list can do, so it says so. */}
      {isOnline ? null : (
        <div className="flex items-center gap-2 rounded-lg border border-warn/40 bg-warn/10 px-3 py-2.5 text-sm font-medium text-warn">
          <CloudOff className="h-4 w-4 shrink-0" />
          <span>
            Offline. Cached deployments are still openable; queued edits
            will sync when you reconnect.
          </span>
        </div>
      )}

      {/* List styled after native field apps (#768): a small bold
          grey section heading, full-width rows with a thumbnail, a
          large title and hairline dividers, no card box around it. */}
      <h2 className="border-b border-border pb-1.5 text-base font-semibold text-muted">
        {sectionLabel}
      </h2>
      <ul className="-mt-3 divide-y divide-border border-b border-border">
        {sorted.map((row) => {
          const overlay = overlays[row.id] ?? {
            cached: null,
            queueCount: 0,
            parkedForOthers: 0,
          };
          const cached = overlay.cached !== null;
          // Remove destroys every account's rows, so its warning counts
          // them all; the Sync chip above counts only this account's.
          const removeLoses = overlay.queueCount + overlay.parkedForOthers;
          return (
            <li key={row.id}>
              <Link
                href={`/items/${row.id}/field?from=field`}
                className="flex w-full items-center gap-4 py-3 transition-colors hover:bg-surface-2/60 active:bg-surface-2"
              >
                <span
                  aria-hidden="true"
                  className="relative flex h-16 w-24 shrink-0 items-center justify-center overflow-visible rounded-lg border border-border bg-surface-2 text-accent"
                >
                  {row.thumbnailUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={row.thumbnailUrl}
                      alt=""
                      loading="lazy"
                      className="h-full w-full rounded-lg object-cover"
                    />
                  ) : (
                    <ClipboardList className="h-7 w-7" />
                  )}
                  {/* Cache status dot, lower-right of the thumbnail.
                      Green = cached, gray = not cached. Mobile reads
                      the dot at a glance instead of a wordy pill. */}
                  <span
                    aria-hidden="true"
                    className={`absolute -bottom-1 -right-1 h-3.5 w-3.5 rounded-full border-2 border-surface-0 ${
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
                  <h3 className="line-clamp-2 text-lg font-medium leading-snug text-ink-0">
                    {row.title}
                  </h3>
                  {/* Description hides on mobile to keep rows
                      single-line. Desktop sees it on a second line. */}
                  {row.description ? (
                    <p className="hidden truncate text-sm text-muted sm:block">
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
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-sm">
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
                            className="inline-flex items-center gap-1 rounded-full border border-warn/40 bg-warn/15 px-2.5 py-1 font-semibold text-warn hover:bg-warn/20 disabled:opacity-60"
                          >
                            {syncing[row.id] ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <CloudDownload className="h-3.5 w-3.5 rotate-180" />
                            )}
                            {syncing[row.id]
                              ? 'Syncing...'
                              : `Sync ${overlay.queueCount}`}
                          </button>
                        ) : (
                          <span className="inline-flex items-center gap-1 rounded-full border border-border bg-surface-2 px-2.5 py-1 font-medium text-ink-1">
                            <CloudOff className="h-3.5 w-3.5" />
                            {overlay.queueCount} queued
                          </span>
                        )
                      ) : null}
                      {cached ? (
                        <button
                          type="button"
                          data-remove-id={row.id}
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
                          className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 disabled:opacity-60 ${
                            confirmingId === row.id
                              ? 'border-danger/40 bg-danger/10 text-danger hover:bg-danger/15'
                              : 'border-border bg-surface-2 text-ink-1 hover:bg-surface-1'
                          }`}
                          title={
                            confirmingId === row.id
                              ? removeLoses > 0
                                ? `${removeLoses} unsynced edit${
                                    removeLoses === 1 ? '' : 's'
                                  } will be lost.`
                                : 'Tap again to remove from device.'
                              : 'Remove this deployment from your device.'
                          }
                        >
                          {removing[row.id] ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Trash2 className="h-3.5 w-3.5" />
                          )}
                          {removing[row.id]
                            ? 'Removing...'
                            : confirmingId === row.id
                              ? removeLoses > 0
                                ? `Confirm remove (${removeLoses} unsynced)`
                                : 'Confirm remove'
                              : 'Remove from device'}
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                  {overlay.syncNote ? (
                    <p className="mt-1 text-sm text-warn">{overlay.syncNote}</p>
                  ) : null}
                </div>
                <ChevronRight className="h-5 w-5 shrink-0 text-muted" />
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
