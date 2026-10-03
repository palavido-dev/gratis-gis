// SPDX-License-Identifier: AGPL-3.0-or-later
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ArrowLeft, Bot } from 'lucide-react';

import { apiFetch } from '@/lib/api';
import { AiSettingsForm, type AiSettings } from './ai-settings-form';

const EMPTY: AiSettings = {
  configured: false,
  saved: false,
  provider: null,
  model: null,
  baseUrl: null,
  apiKeyConfigured: false,
};

/**
 * Org-admin AI provider settings. Viewers and contributors are
 * sent back to the items list, matching the other admin pages.
 */
export default async function AdminAiPage() {
  let me: { orgRole: string };
  try {
    me = await apiFetch<{ orgRole: string }>('/api/users/me');
  } catch {
    redirect('/items');
  }
  if (me.orgRole !== 'admin') redirect('/items');

  let settings: AiSettings = EMPTY;
  let error: string | null = null;
  try {
    settings = await apiFetch<AiSettings>('/api/admin/ai');
  } catch (err) {
    error = err instanceof Error ? err.message : 'Could not load AI settings.';
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-10">
      <Link
        href="/items"
        className="mb-3 inline-flex items-center gap-1 text-xs text-muted hover:text-ink-0"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Back to portal
      </Link>
      <header className="mb-6 flex items-center gap-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-md bg-accent/10 text-accent">
          <Bot className="h-5 w-5" />
        </span>
        <div>
          <p className="text-xs text-muted">Admin</p>
          <h1 className="text-2xl font-semibold tracking-tight">AI</h1>
          <p className="mt-0.5 text-sm text-muted">
            Optionally connect ChatGPT, Claude, Grok, or a local
            OpenAI-compatible server such as Ollama.
          </p>
        </div>
      </header>

      {error ? (
        <div className="mb-6 rounded-lg border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-danger">
          <p className="font-medium">Could not load AI settings</p>
          <p className="mt-1 text-danger/90">{error}</p>
        </div>
      ) : (
        <AiSettingsForm initial={settings} />
      )}
    </div>
  );
}
