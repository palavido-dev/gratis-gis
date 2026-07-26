// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import { useEffect } from 'react';
import { AlertTriangle, RefreshCcw } from 'lucide-react';
import { SignOutButton } from '@/components/user-menu';

/**
 * Route-level error boundary. When a server component throws (most
 * often because portal-api is unreachable), we catch it here instead of
 * showing the raw dev-mode "Unhandled Runtime Error" overlay. In dev
 * the overlay still shows; this is what users see in production, and
 * also what appears if the overlay is dismissed.
 */
export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // eslint-disable-next-line no-console
    console.error('Route error:', error);
  }, [error]);

  const apiDown =
    error.message.includes('fetch failed') ||
    error.message.includes('ECONNREFUSED');

  return (
    <div className="mx-auto w-full max-w-2xl px-6 py-16">
      <div className="rounded-lg border border-danger/30 bg-danger/5 p-6">
        <div className="flex items-center gap-2 text-danger">
          <AlertTriangle className="h-5 w-5" />
          <h1 className="text-lg font-semibold">Something went wrong</h1>
        </div>
        <p className="mt-3 text-sm text-ink-1">
          {apiDown
            ? 'Could not reach the API server. Make sure portal-api is running on port 4000, then retry.'
            : error.message || 'An unexpected error occurred.'}
        </p>
        <div className="mt-6 flex items-center gap-2">
          <button
            type="button"
            onClick={reset}
            className="inline-flex h-9 items-center gap-1.5 rounded-md bg-accent px-3 text-sm font-medium text-accent-foreground shadow-card hover:opacity-90"
          >
            <RefreshCcw className="h-4 w-4" />
            Try again
          </button>
          {/* Sign out must run the full client-side flow (NextAuth
              signOut() first, then the Keycloak end-session hop).
              A bare link to /api/auth/federated-logout leaves the
              NextAuth cookie alive, which for a dead session means
              the user lands right back on this error screen. */}
          <SignOutButton className="inline-flex h-9 items-center rounded-md border border-border bg-surface-1 px-3 text-sm font-medium text-ink-1 shadow-card hover:bg-surface-2">
            Sign out
          </SignOutButton>
        </div>
        {error.digest ? (
          <p className="mt-4 text-xs text-muted">Digest: {error.digest}</p>
        ) : null}
      </div>
    </div>
  );
}
