// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import { useEffect } from 'react';
import { useSearchParams } from 'next/navigation';
import { signIn } from 'next-auth/react';
import { useT } from '@/lib/i18n/locale-context';

/**
 * Starts the Keycloak redirect. Mounted only after the server has
 * checked that this browser host is the configured sign-in address.
 */
export function SignInClient() {
  const t = useT();
  const params = useSearchParams();
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
