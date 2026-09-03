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
 */

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
    lastError?: string;
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
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  // Fallback: timestamp + random; only used in obscure no-crypto
  // environments. Doesn't need to be cryptographically random.
  return (
    'dev-' +
    Date.now().toString(36) +
    '-' +
    Math.random().toString(36).slice(2, 10)
  );
}

/**
 * Build the manifest by walking IndexedDB. Cheap (a handful of cursor
 * scans); safe to call from the runtime hot path.
 */
async function buildManifest(): Promise<ManifestEntry[]> {
  const cached: CachedDeployment[] = await listDeployments();

  // Walk every cached deployment + the queue scoped to it. A
  // deployment with no queued records still gets reported so the
  // admin sees the cached-only devices.
  const entries: ManifestEntry[] = [];
  const seen = new Set<string>();
  for (const dep of cached) {
    seen.add(dep.dataCollectionId);
    const queue = await listQueue(dep.dataCollectionId);
    entries.push(toEntry(dep.dataCollectionId, dep.cachedAt, queue));
  }

  // It's possible (though rare) for a queue row to exist without a
  // cached deployment -- e.g. the user cleared the cache while
  // records were queued. Surface those too so the admin sees the
  // stuck records rather than them disappearing from the beacon.
  // We can't enumerate every queue scope without a deployment list,
  // so this codepath is best-effort: a deployment id we don't know
  // about won't be reported until the user re-caches it.

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
        if (r.failureReason) out.lastError = r.failureReason.slice(0, 500);
        if (typeof r.retryCount === 'number') out.attempts = r.retryCount;
        return out;
      }),
    };
  }
}

/**
 * Send a fresh manifest to the server. Returns true on a 2xx, false
 * otherwise; never throws. Callers fire-and-forget.
 */
export async function postQueueManifest(): Promise<boolean> {
  if (typeof window === 'undefined') return false;
  if (!navigator.onLine) return false;

  try {
    const manifest = await buildManifest();
    const estimate = await getStorageEstimate();
    const body = {
      deviceFingerprint: getDeviceFingerprint(),
      manifest,
      // getStorageEstimate() returns null on Safari < 15.4 and any
      // other browser without the StorageManager API; the server
      // treats missing as null.
      ...(estimate ? { storageUsage: estimate.usage } : {}),
      ...(estimate ? { storageQuota: estimate.quota } : {}),
      userAgent: navigator.userAgent,
    };

    const res = await fetch(BEACON_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      // Use 'low' priority so the beacon never starves a real sync
      // request on a constrained connection.
      keepalive: true,
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
 */
let lastBeaconAt = 0;
const BEACON_MIN_INTERVAL_MS = 10_000;

export async function postQueueManifestThrottled(): Promise<void> {
  const now = Date.now();
  if (now - lastBeaconAt < BEACON_MIN_INTERVAL_MS) return;
  lastBeaconAt = now;
  // Don't await; fire-and-forget keeps the call site clean.
  void postQueueManifest();
}
