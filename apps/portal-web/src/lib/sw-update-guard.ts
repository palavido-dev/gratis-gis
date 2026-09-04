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
 */

type Listener = (busy: boolean) => void;

const busyReasons = new Set<string>();
const listeners = new Set<Listener>();

function notify(): void {
  const busy = busyReasons.size > 0;
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
  notify();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    busyReasons.delete(reason);
    notify();
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
