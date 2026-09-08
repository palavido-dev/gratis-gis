// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Whether it is safe to reload the page for a service worker update.
 *
 * The worker calls skipWaiting() and clients.claim(), and its activate
 * handler deletes every cache whose name does not carry the current
 * CACHE_VERSION. So when a deploy lands, a tab that is still open
 * loses the static cache its already-loaded chunks came from, while
 * still holding references to them. Online that degrades to a network
 * fetch for a URL the new build no longer serves; offline it is a
 * broken page. The usual answer is to reload on 'controllerchange'.
 *
 * A blind reload is the wrong answer HERE. This is a data collection
 * app: reloading a collector who is halfway through a form, or
 * mid-download of an offline area, destroys work that may have taken
 * ten minutes to gather in the rain. Losing an edit to fix a caching
 * problem trades one bug for a worse one.
 *
 * So surfaces that would lose something register as busy, and the
 * reload waits for them. The reload happens the moment the last of
 * them clears, which in practice is when the form closes.
 *
 * The idle notification is deferred by one microtask, and the reason
 * is React. A hold is typically taken in an effect and released in
 * that effect's cleanup, and when the effect's dependencies change
 * React runs the OLD cleanup before the NEW body: a dependency change
 * is release-then-hold inside one synchronous tick. With a synchronous
 * notify, the release fired busy=false, the registrar reloaded the
 * page on the spot, and the re-hold that followed a few microseconds
 * later never ran. That is exactly the mid-form reload this module
 * exists to prevent, arriving through the module's own API. Taking a
 * hold stays synchronous so `isReloadHeld()` is true the instant the
 * caller asked for it; only "we are idle now" waits until the end of
 * the tick to see whether anyone re-held.
 */

type Listener = (busy: boolean) => void;

const busyReasons = new Set<string>();
const listeners = new Set<Listener>();

function notify(busy: boolean): void {
  for (const l of listeners) {
    try {
      l(busy);
    } catch {
      // A listener that throws must not strand the others, or a
      // pending reload never fires.
    }
  }
}

/**
 * Mark the app as holding unsaved work. Returns the release function;
 * call it when the work is done or abandoned.
 *
 * Keyed by reason so overlapping holds (a form open during a
 * download) each release independently. Calling the returned function
 * twice is harmless.
 */
export function holdReload(reason: string): () => void {
  busyReasons.add(reason);
  notify(true);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    busyReasons.delete(reason);
    // Re-checked at flush time, not captured here: a hold taken later
    // in the same tick (see the module comment) must turn this into a
    // no-op rather than a reload.
    queueMicrotask(() => {
      if (busyReasons.size === 0) notify(false);
    });
  };
}

/** True while any surface is holding unsaved work. */
export function isReloadHeld(): boolean {
  return busyReasons.size > 0;
}

/** Subscribe to busy changes. Returns an unsubscribe function. */
export function onReloadHoldChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
