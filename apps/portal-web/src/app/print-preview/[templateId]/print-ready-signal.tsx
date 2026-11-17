// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

/**
 * Sets `body[data-map-ready="true"]`, which the PDF pipeline waits for
 * before capturing, once every map on the sheet has finished.
 *
 * Only MapSnapshot used to set the flag, so a template with no Map
 * element always waited out the API's full 15 s timeout, and with two
 * maps the first one to finish marked the page ready. Each snapshot
 * now reports through `reportPrintMapReady`, and this counts them.
 */
import { useEffect } from 'react';

const EVENT = 'gg-print-map-ready';

export function reportPrintMapReady(): void {
  window.dispatchEvent(new Event(EVENT));
}

export function PrintReadySignal({ mapCount }: { mapCount: number }) {
  useEffect(() => {
    let seen = 0;
    const markReady = () => {
      document.body.dataset.mapReady = 'true';
    };
    if (mapCount <= 0) {
      markReady();
      return;
    }
    const onReady = () => {
      seen += 1;
      if (seen >= mapCount) markReady();
    };
    window.addEventListener(EVENT, onReady);
    return () => window.removeEventListener(EVENT, onReady);
  }, [mapCount]);
  return null;
}
