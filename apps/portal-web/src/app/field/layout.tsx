// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Metadata } from 'next';
import type { ReactNode } from 'react';

/**
 * Layout segment for /field. Its only job is to override the root
 * layout's manifest URL so a PWA install from this route creates the
 * field app rather than the portal app.
 *
 * It does NOT wrap the per-deployment runtime. Next layouts follow the
 * URL, and the runtime lives at /items/[id]/field, which is a
 * different branch of the tree; the comment here used to claim
 * otherwise, which is part of how the manifest's scope came to exclude
 * the one route the app spends its time on. The runtime page sets the
 * same manifest itself.
 */
export const metadata: Metadata = {
  manifest: '/field/manifest.webmanifest',
};

export default function FieldLayout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
