// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import { useEffect } from 'react';
import { requestBackgroundSync } from '@/lib/offline-store';
import { isReloadHeld, onReloadHoldChange } from '@/lib/sw-update-guard';

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
export function SwRegistrar({ deploymentId }: { deploymentId?: string }) {
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

    // A new worker calls skipWaiting() and clients.claim(), and its
    // activate handler deletes every cache not carrying the current
    // CACHE_VERSION. So a deploy pulls the static cache out from under
    // this already-loaded page while it still holds references to
    // chunks that lived there. Reload once when that happens, so the
    // tab is running the build whose assets are actually cached.
    //
    // But not while a collector has unsaved work. This is a data
    // collection app; reloading someone halfway through a form to fix
    // a caching problem trades one bug for a worse one. The guard
    // holds the reload until the last busy surface clears.
    let reloading = false;
    let unsubscribe: (() => void) | null = null;
    const doReload = () => {
      if (reloading) return;
      reloading = true;
      window.location.reload();
    };
    const onControllerChange = () => {
      if (!isReloadHeld()) {
        doReload();
        return;
      }
      // Wait it out. Nothing else re-checks, so if the hold is never
      // released the tab simply keeps running the old build, which is
      // the safe direction to fail in.
      unsubscribe = onReloadHoldChange((busy) => {
        if (!busy) doReload();
      });
    };
    navigator.serviceWorker.addEventListener(
      'controllerchange',
      onControllerChange,
    );

    // The deploy id rides in the script URL. Same scope, so this
    // UPDATES the existing registration rather than adding a second
    // one, and the differing URL is what makes the browser fetch and
    // install a new worker each deploy: it reinstalls on changed
    // script bytes only, so before this an edit to the precached
    // offline shell never reached an installed PWA unless sw.js
    // happened to change in the same commit. The worker reads the
    // same value for its cache names.
    const swUrl = deploymentId
      ? `/sw.js?v=${encodeURIComponent(deploymentId)}`
      : '/sw.js';
    navigator.serviceWorker
      .register(swUrl, { scope: '/' })
      .then(() => {
        // Catch-up arming for queued rows from earlier sessions; see
        // the component doc comment. Uses navigator.serviceWorker.ready
        // internally, so it waits for the worker to activate.
        requestBackgroundSync();
      })
      .catch((err) => console.warn('[SW] Registration failed:', err));

    return () => {
      navigator.serviceWorker.removeEventListener(
        'controllerchange',
        onControllerChange,
      );
      unsubscribe?.();
    };
  }, [deploymentId]);

  return null;
}
