// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import { useEffect } from 'react';
import { requestBackgroundSync } from '@/lib/offline-store';

/**
 * Registers the GratisGIS service worker. Renders nothing.
 *
 * Must be a client component: placed in the root layout so it runs once
 * per browser session regardless of which page is visited first.
 *
 * Besides registering the worker, this re-arms the one-shot
 * Background Sync tag on every load. The tag is normally armed at
 * enqueue time (offline-store.ts / the forms respond page), but a
 * registration is consumed once it fires successfully and Chromium
 * abandons it after a few failed retries, so rows can survive from a
 * session whose registration is long gone (crash mid-drain, retries
 * exhausted while the device sat in a dead zone). Re-arming here is
 * nearly free: when the queues are empty the worker's drain no-ops
 * without even creating the databases.
 *
 * The in-app drains remain the primary replay path: lib/offline-sync.ts
 * runs from the field runtime and catalog, and the forms respond page
 * drains its own submissions outbox. The worker's sync handler is the
 * closed-tab safety net (Chromium only; elsewhere requestBackgroundSync
 * is a silent no-op).
 */
export function SwRegistrar() {
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;

    // Skip the service worker entirely when running against the Next.js
    // dev server. Dev chunks under /_next/static/ reuse filenames across
    // restarts, and the SW's cache-first strategy for static assets
    // ends up serving old chunks whose module IDs no longer exist in
    // the current webpack runtime: that's what produces the recurring
    // `options.factory undefined` crash after a dev server bounce.
    //
    // In dev, also proactively unregister any SW that a previous session
    // left behind so the user doesn't need to hunt through DevTools to
    // recover. Prod builds are unaffected.
    const hostname = window.location.hostname;
    const isDev =
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname.endsWith('.local') ||
      hostname.endsWith('.localhost');

    if (isDev) {
      navigator.serviceWorker.getRegistrations().then((regs) => {
        for (const r of regs) {
          r.unregister().catch(() => {
            /* non-fatal */
          });
        }
      });
      // Also nuke any caches the old SW populated.
      if ('caches' in window) {
        caches.keys().then((keys) => {
          for (const k of keys) {
            if (k.startsWith('gratis-')) caches.delete(k).catch(() => {});
          }
        });
      }
      return;
    }

    navigator.serviceWorker
      .register('/sw.js', { scope: '/' })
      .then(() => {
        // Catch-up arming for queued rows from earlier sessions; see
        // the component doc comment. Uses navigator.serviceWorker.ready
        // internally, so it waits for the worker to activate.
        requestBackgroundSync();
      })
      .catch((err) => console.warn('[SW] Registration failed:', err));
  }, []);

  return null;
}
