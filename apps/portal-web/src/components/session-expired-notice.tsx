// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import { signIn, useSession } from 'next-auth/react';

import { useT } from '@/lib/i18n/locale-context';
import { isSessionStale } from '@/lib/session-state';

/**
 * Global banner for the silently-dead-session state (#195).
 *
 * The NextAuth cookie lives for a year, but the Keycloak tokens
 * inside it die whenever Keycloak forgets the session: the nightly
 * golden restore on the demo instance, an SSO max-lifespan expiry,
 * or a Keycloak outage. When that happened before this banner, the
 * header still showed the user as signed in while the BFF treated
 * them as signed out; private layers quietly vanished (the 3D
 * terrain "nothing drapes" incident) and saves 401ed with no
 * explanation. The jwt callback flags the state with
 * error: 'RefreshAccessTokenError' and the BFF downgrades those
 * sessions to signed-out behavior; this banner is the user-visible
 * half. It also self-heals: useSession refetches on window focus,
 * so once a refresh succeeds again (or the user signs back in) the
 * error flag disappears and the banner unmounts.
 */
export function SessionExpiredNotice() {
  const { data: session } = useSession();
  const t = useT();
  // Same predicate the app shell uses to swap the header identity for
  // a Sign in button, so the two can never disagree.
  if (!isSessionStale(session)) return null;
  return (
    <div
      role="alert"
      // Opaque, and padded below the iPhone status bar: in an
      // installed PWA (viewport-fit=cover) the page starts under it,
      // and a see-through bar at y=0 put Sign in behind the clock.
      className="sticky top-0 z-50 flex flex-wrap items-center justify-center gap-x-3 gap-y-2 border-b border-warn/60 bg-surface-1 px-4 pb-2 pt-[max(0.5rem,env(safe-area-inset-top))] text-sm font-medium text-ink-0"
    >
      <span>{t('errors.sessionExpired')}</span>
      <button
        type="button"
        onClick={() => void signIn('keycloak')}
        className="inline-flex h-10 items-center rounded-md bg-accent px-4 text-sm font-semibold text-accent-foreground hover:opacity-90"
      >
        {t('nav.signIn')}
      </button>
    </div>
  );
}
