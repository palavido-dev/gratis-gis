// SPDX-License-Identifier: AGPL-3.0-or-later
import { Suspense } from 'react';
import { headers } from 'next/headers';
import { decideSignInOrigin } from '@/lib/auth-origin';
import { t } from '@/lib/i18n';
import { getServerLocale } from '@/lib/i18n/server';
import { SignInClient } from './sign-in-client';

/**
 * Custom sign-in page wired to NextAuth via authOptions.pages.signIn.
 *
 * When this host is the configured public URL, the client immediately
 * redirects to Keycloak. When it is not (a Tailscale name while
 * sign-in is still pinned to the LAN address), do not start OAuth:
 * that redirect is what sends the browser to the LAN IP.
 */
export default async function SignInPage() {
  const locale = await getServerLocale();
  const headerList = await headers();
  const decision = decideSignInOrigin(
    headerList.get('x-forwarded-host') ?? headerList.get('host'),
  );
  if (!decision.allowed) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-surface-0 p-4">
        <div className="max-w-lg rounded-md border border-border bg-surface-1 px-6 py-5 shadow-card">
          <h1 className="text-base font-semibold text-ink-0">
            {t('auth.wrongHostTitle', undefined, locale)}
          </h1>
          <p className="mt-2 text-sm text-ink-1">
            {t(
              'auth.wrongHostBody',
              { opened: decision.openedHost, canonical: decision.canonical },
              locale,
            )}
          </p>
          <pre className="mt-3 overflow-x-auto rounded bg-surface-0 p-3 text-xs text-ink-0">
            {`GRATIS_BASE_URL: ${decision.suggestedBaseUrl || decision.canonical}`}
          </pre>
          <p className="mt-3 text-xs text-muted">
            {t('auth.wrongHostRestart', undefined, locale)}
          </p>
        </div>
      </div>
    );
  }
  return (
    <Suspense
      fallback={
        <p className="p-6 text-sm text-muted">{t('auth.redirecting', undefined, locale)}</p>
      }
    >
      <SignInClient />
    </Suspense>
  );
}
