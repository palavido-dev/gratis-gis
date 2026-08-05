// SPDX-License-Identifier: AGPL-3.0-or-later
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';

import { apiFetch } from '@/lib/api';
import { ApiKeysManager, type ApiKeySummary } from './api-keys-manager';

export const metadata = { title: 'API keys' };

/**
 * /settings/api-keys: mint and revoke personal API keys (#219).
 *
 * apiFetch is the server-side helper and talks to portal-api
 * directly, so the path here is the API's real URL with no
 * `/api/portal/` BFF prefix.
 */
export default async function ApiKeysSettingsPage() {
  const keys = await apiFetch<ApiKeySummary[]>('/api/users/me/api-keys');

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-10">
      <header className="mb-8">
        <Link
          href="/profile"
          className="inline-flex items-center gap-1 text-xs text-muted hover:text-ink-0"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to profile
        </Link>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">
          API keys
        </h1>
        <p className="mt-2 max-w-2xl text-sm text-muted">
          Keys let a script, a scheduled job, or a notebook on your own
          machine reach this portal without signing in through a
          browser. A key acts as you, so it can see and change exactly
          what you can, and nothing more.
        </p>
      </header>

      <ApiKeysManager initial={keys} />
    </div>
  );
}
