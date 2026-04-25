'use client';

import { useEffect } from 'react';
import { listenForOnline } from '@/lib/sync';

/**
 * Registers the GratisGIS service worker and sets up an online-reconnect
 * handler to flush the pending write queue. Renders nothing.
 *
 * Must be a client component: placed in the root layout so it runs once
 * per browser session regardless of which page is visited first.
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
      .catch((err) => console.warn('[SW] Registration failed:', err));

    // Flush queued writes whenever connectivity is restored.
    const cleanup = listenForOnline();
    return cleanup;
  }, []);

  return null;
}
