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
      className="sticky top-0 z-50 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 border-b border-warn/40 bg-warn/10 px-4 py-2 text-sm text-ink-1"
    >
      <span>{t('errors.sessionExpired')}</span>
      <button
        type="button"
        onClick={() => void signIn('keycloak')}
        className="rounded-md border border-warn/40 bg-surface-1 px-3 py-1 text-xs font-medium text-ink-1 hover:bg-surface-2"
      >
        {t('nav.signIn')}
      </button>
    </div>
  );
}
