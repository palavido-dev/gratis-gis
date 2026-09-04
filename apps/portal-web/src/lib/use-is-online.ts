// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

/**
 * One answer to "are we online".
 *
 * The field runtime had four. A `useState(true)` whose comment
 * described a `typeof navigator` initialiser that did not exist, plus
 * three bare `navigator.onLine` reads scattered through effects and
 * the submit path. So the first client render of an offline boot ran
 * in online mode, and any two of the four could disagree within the
 * same tick.
 *
 * `useSyncExternalStore` is the right primitive rather than
 * useState + an effect: it takes a separate server snapshot, so React
 * hydrates against the value the server rendered and then switches to
 * the real one without a mismatch warning. The effect version could
 * not do that, which is why it shipped as a hardcoded `true`.
 *
 * `navigator.onLine` only tells you the device has SOME network
 * attachment: a phone on a wifi access point with no upstream reads
 * as online. It is a useful hint, not proof, which is why the write
 * paths still fall back to the queue when a fetch throws rather than
 * trusting this.
 */

import { useSyncExternalStore } from 'react';

function subscribe(onChange: () => void): () => void {
  window.addEventListener('online', onChange);
  window.addEventListener('offline', onChange);
  return () => {
    window.removeEventListener('online', onChange);
    window.removeEventListener('offline', onChange);
  };
}

function getSnapshot(): boolean {
  // Anything other than an explicit false counts as online, so a
  // browser that does not implement the property fails open rather
  // than trapping the user in offline mode.
  return navigator.onLine !== false;
}

/** Server render, and the hydration pass, assume online. */
function getServerSnapshot(): boolean {
  return true;
}

/** Subscribe a component to connectivity changes. */
export function useIsOnline(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/**
 * Read connectivity outside React: event handlers, effects, and the
 * non-component helpers. Same fail-open rule as the hook, so a
 * callback and the render that scheduled it cannot disagree.
 */
export function isOnlineNow(): boolean {
  if (typeof navigator === 'undefined') return true;
  return navigator.onLine !== false;
}
