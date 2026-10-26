// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import { useEffect } from 'react';
import { useSearchParams } from 'next/navigation';
import { signIn } from 'next-auth/react';
import { useT } from '@/lib/i18n/locale-context';

/**
 * Custom sign-in page wired to NextAuth via authOptions.pages.signIn.
 *
 * When NextAuth has only one provider, the default /api/auth/signin
 * shows a one-button "Sign in with Keycloak" picker -- a useless extra
 * click since there's nothing to pick. We override pages.signIn so
 * NextAuth routes its sign-in flow through this page instead, and we
 * call signIn('keycloak', { callbackUrl }) on mount to drop the user
 * straight into Keycloak's hosted login.
 *
 * The visible "Continue to Keycloak" link is the noscript / late-JS
 * fallback. In the normal case the useEffect fires before the user
 * sees it, so they only ever land on Keycloak's own login.
 */
export default function SignInPage() {
  const t = useT();
  const params = useSearchParams();
  // NextAuth normally appends ?callbackUrl=... so the user lands back
  // where they were trying to go after auth. Honor it; default to / so
  // a direct visit to /signin still works.
  const callbackUrl = params.get('callbackUrl') ?? '/';

  useEffect(() => {
    void signIn('keycloak', { callbackUrl });
  }, [callbackUrl]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-0 p-4">
      <div className="rounded-md border border-border bg-surface-1 px-6 py-5 text-center shadow-card">
        <p className="text-sm text-ink-1">{t('auth.redirecting')}</p>
        <p className="mt-2 text-xs text-muted">
          {t('auth.redirectFallback')}{' '}
          <a
            href={`/api/auth/signin/keycloak?callbackUrl=${encodeURIComponent(
              callbackUrl,
            )}`}
            className="underline hover:text-ink-0"
          >
            {t('auth.continueToKeycloak')}
          </a>
          .
        </p>
      </div>
    </div>
  );
}
