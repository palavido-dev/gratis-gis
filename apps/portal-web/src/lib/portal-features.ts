// SPDX-License-Identifier: AGPL-3.0-or-later
import { cache } from 'react';

import { publicApiFetch } from './api';

/**
 * Optional capabilities the portal has switched on, read from the
 * unauthenticated portal-info document.
 *
 * Server-only, and unauthenticated on purpose. The feedback
 * affordance has to reach signed-OUT visitors, who are most of the
 * audience for it, and a client-side fetch of portal-info through the
 * BFF would 401 for exactly those people.
 *
 * Wrapped in React's `cache` so the root layout and the app shell,
 * which both need this on every render, share one request per render
 * pass instead of each paying a round-trip.
 */
export interface PortalFeatures {
  feedback: boolean;
  version: string | null;
}

export const getPortalFeatures = cache(async (): Promise<PortalFeatures> => {
  try {
    const info = await publicApiFetch<{
      version?: string;
      features?: { feedback?: boolean };
    }>('/api/portal-info');
    return {
      feedback: info.features?.feedback === true,
      version: info.version ?? null,
    };
  } catch {
    // A portal-info failure is not worth failing a page render over.
    // Everything stays off, which is the same outcome as the flag
    // being unset and is the safe default either way.
    return { feedback: false, version: null };
  }
});
