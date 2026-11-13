// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

/**
 * Tier 4 of the field-offline resilience design (see
 * docs/field-offline-areas.md). The field client periodically reports
 * a queue manifest to the server so an admin can see "user X has 47
 * records queued, oldest from 3 days ago" without the user pulling
 * out their phone. Pure beacon: the server table only carries
 * metadata; the actual record payloads stay in IndexedDB.
 *
 * The beacon is opportunistic. We post:
 *   - on field-runtime mount (so the admin sees a fresh row every time
 *     a worker opens the app)
 *   - after every successful sync run (so a queue that just drained
 *     to zero is reflected immediately)
 *   - on `online` flip (the device probably has things to report and
 *     the admin most cares about the moment connectivity returns)
 *
 * All posts are best-effort: a failed beacon is logged and dropped.
 * The next mount or sync naturally retries.
 *
 * The manifest is the signed-in account's. It reports the rows that
 * account owns (plus legacy rows with no owner) and nothing another
 * account parked on the same device: the server files the beacon under
 * the caller, so listing somebody else's rows would tell the admin the
 * wrong person is holding them.
 */

import type { OfflineMessage } from '@gratis-gis/shared-types';
import { clientUuid } from './uuid';

import {
  listDeployments,
  listQueue,
  getStorageEstimate,
  type CachedDeployment,
  type QueueRecord,
} from './offline-store';

// Beacon goes through the portal-web BFF passthrough at
// /api/portal/[...path], which injects the user's Keycloak JWT
// server-side. Hitting /api/field/* directly bypasses the BFF and
// the request lands on portal-api with no Authorization header,
// silently 401-ing every beacon -- which made the admin Field
// Device Queues page look broken (it was, but only because the
// beacons never reached the server).
const BEACON_ENDPOINT = '/api/portal/field/queue-manifest';
const FINGERPRINT_KEY = 'gratisgis.field.deviceFingerprint';

interface ManifestEntry {
  dataCollectionId: string;
  cachedAt: string | null;
  queuedRecords: Array<{
    id: string;
    op: 'insert' | 'update' | 'delete';
    layerId: string;
    queuedAt: string;
    status: 'pending' | 'failed' | 'rejected';
    /** Why the last attempt failed, as a code rather than a sentence.
     *  The admin reading it in the field-queues view is not the person
     *  who captured the row and may not share their language, so the
     *  words are chosen there. The server validates the shape and
     *  coerces a string from an older client into `legacy.text`. */
    lastError?: OfflineMessage;
    attempts?: number;
  }>;
}

/**
 * Stable per-browser-profile fingerprint. We keep it in localStorage
 * rather than deriving it from any actual device identity: the only
 * goal is to differentiate "Alice on her iPhone" from "Alice on the
 * shared tablet" in the admin view, not to recognize devices across
 * profile resets. Generated lazily on first access.
 */
export function getDeviceFingerprint(): string {
  if (typeof window === 'undefined') return 'server';
  try {
    const cached = window.localStorage.getItem(FINGERPRINT_KEY);
    if (cached && cached.length >= 8) return cached;
    const fresh = newFingerprint();
    window.localStorage.setItem(FINGERPRINT_KEY, fresh);
    return fresh;
  } catch {
    // Private mode / disabled storage. Fall back to a per-tab fingerprint
    // -- the admin will see "Alice device-9f3a-..." for each tab, which
    // is acceptable degradation.
    return newFingerprint();
  }
}

function newFingerprint(): string {
  // Stable per browser profile. clientUuid still returns an id when
  // the page is http://<lan-ip> and crypto.randomUUID is missing.
  return clientUuid();
}

/**
 * Build the manifest by walking IndexedDB. Cheap (a handful of cursor
 * scans); safe to call from the runtime hot path.
 */
async function buildManifest(
  currentUserId: string,
): Promise<ManifestEntry[]> {
  const cached: CachedDeployment[] = await listDeployments();

  // Walk every cached deployment + the queue scoped to it. A
  // deployment with no queued records still gets reported so the
  // admin sees the cached-only devices.
  // A queue row whose deployment has no manifest is not reported: the
  // queue is listed per deployment, so a deployment id we do not know
  // about shows up once the user caches it again.
  const entries: ManifestEntry[] = [];
  for (const dep of cached) {
    const queue = await listQueue(dep.dataCollectionId, currentUserId);
    entries.push(toEntry(dep.dataCollectionId, dep.cachedAt, queue));
  }
  return entries;

  function toEntry(
    dataCollectionId: string,
    cachedAt: string | null,
    queue: QueueRecord[],
  ): ManifestEntry {
    return {
      dataCollectionId,
      // CachedDeployment.cachedAt is already an ISO string; pass it
      // through so the admin view doesn't have to translate.
      cachedAt: cachedAt ?? null,
      // Cap per deployment so the JSON stays small even on a stuck
      // queue. The server has its own cap; this just keeps the
      // beacon request body small.
      queuedRecords: queue.slice(0, 200).map((r) => {
        const out: ManifestEntry['queuedRecords'][number] = {
          id: r.id,
          op: r.op,
          layerId: r.dataLayerId,
          queuedAt: r.queuedAt,
          // 'syncing' and 'synced' collapse to pending: a row mid-flight
          // is still owed to the server. 'rejected' is reported as its
          // own state so the admin can tell "offline" from "the server
          // said no and a person has to look".
          status:
            r.syncStatus === 'failed' || r.syncStatus === 'rejected'
              ? r.syncStatus
              : 'pending',
        };
        if (r.failure) out.lastError = r.failure;
        if (typeof r.retryCount === 'number') out.attempts = r.retryCount;
        return out;
      }),
    };
  }
}

/**
 * Send a fresh manifest to the server. Returns true on a 2xx, false
 * otherwise; never throws. Callers fire-and-forget.
 *
 * `currentUserId` is the account the page is running as (the field
 * surfaces receive it from their server render); the manifest lists
 * that account's rows only.
 */
export async function postQueueManifest(
  currentUserId: string,
): Promise<boolean> {
  if (typeof window === 'undefined') return false;
  if (!navigator.onLine) return false;

  try {
    const manifest = await buildManifest(currentUserId);
    const estimate = await getStorageEstimate();
    const body = {
      deviceFingerprint: getDeviceFingerprint(),
      manifest,
      // getStorageEstimate() returns null on Safari < 15.4 and any
      // other browser without the StorageManager API; the server
      // treats missing as null.
      // Rounded: the server takes whole numbers only, and one browser
      // reporting a fraction would turn the whole beacon into a 400.
      ...(estimate ? { storageUsage: Math.round(estimate.usage) } : {}),
      ...(estimate ? { storageQuota: Math.round(estimate.quota) } : {}),
      userAgent: navigator.userAgent,
    };

    const res = await fetch(BEACON_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      // No `keepalive`. Browsers refuse a keepalive request whose body
      // is over 64 KiB, which a device with a large stuck queue easily
      // reaches, so the beacon failed exactly when the admin most
      // needed it. No caller fires during page unload, so keepalive
      // bought nothing.
    });
    return res.ok;
  } catch {
    // Beacon failures are non-fatal: a missing manifest is much
    // better than a runtime error in front of the worker.
    return false;
  }
}

/**
 * Throttled wrapper. Multiple call sites (mount, sync, online flip)
 * can fire postQueueManifest() at once; we want at most one beacon
 * per ~10s window so a chatty page doesn't hammer the server.
 *
 * Trailing, not leading: a call inside the window schedules one post
 * at the end of it instead of being dropped. The later call carries
 * the newer state (typically "the queue just drained to zero"), so it
 * is the one that must go out. A post that fails does not hold the
 * window shut for the next one.
 */
let lastBeaconAt = 0;
let trailing: ReturnType<typeof setTimeout> | null = null;
let trailingUserId = '';
const BEACON_MIN_INTERVAL_MS = 10_000;

export async function postQueueManifestThrottled(
  currentUserId: string,
): Promise<void> {
  trailingUserId = currentUserId;
  if (trailing) return; // the scheduled post will use the newest user
  const wait = lastBeaconAt + BEACON_MIN_INTERVAL_MS - Date.now();
  if (wait <= 0) {
    // Don't await; fire-and-forget keeps the call site clean.
    void sendThrottled(currentUserId);
    return;
  }
  trailing = setTimeout(() => {
    trailing = null;
    void sendThrottled(trailingUserId);
  }, wait);
}

async function sendThrottled(currentUserId: string): Promise<void> {
  const previous = lastBeaconAt;
  // Stamped before the post so calls made while it is in flight wait.
  lastBeaconAt = Date.now();
  const ok = await postQueueManifest(currentUserId);
  if (!ok) lastBeaconAt = previous;
}
