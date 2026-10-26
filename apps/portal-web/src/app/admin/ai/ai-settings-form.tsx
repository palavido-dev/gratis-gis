// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import { useMemo, useState } from 'react';
import { Loader2, Save, Trash2 } from 'lucide-react';
import { useT } from '@/lib/i18n/locale-context';

export type AiProviderId =
  | 'openai'
  | 'anthropic'
  | 'xai'
  | 'openai-compatible';

export interface AiSettings {
  configured: boolean;
  saved: boolean;
  provider: AiProviderId | null;
  model: string | null;
  baseUrl: string | null;
  apiKeyConfigured: boolean;
}

const MODEL_HINTS: Record<AiProviderId, string> = {
  openai: 'gpt-4o-mini',
  anthropic: 'claude-sonnet-4-5',
  xai: 'grok-3',
  'openai-compatible': 'llama3.2',
};

const inputClass =
  'h-9 w-full rounded-md border border-border bg-surface-1 px-2 text-sm focus:border-accent focus:outline-hidden focus:ring-2 focus:ring-accent/30';

/**
 * Admin form for the org AI provider. The key field starts empty
 * on every load. Saving with it blank keeps the stored key. The
 * API never sends the key back.
 */
export function AiSettingsForm({ initial }: { initial: AiSettings }) {
  const t = useT();
  const [settings, setSettings] = useState<AiSettings>(initial);
  const [provider, setProvider] = useState<AiProviderId>(
    initial.provider ?? 'openai',
  );
  const [model, setModel] = useState(initial.model ?? '');
  const [baseUrl, setBaseUrl] = useState(initial.baseUrl ?? '');
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const providers = useMemo(
    () =>
      [
        { id: 'openai' as const, label: t('adminAi.providerOpenai') },
        { id: 'anthropic' as const, label: t('adminAi.providerAnthropic') },
        { id: 'xai' as const, label: t('adminAi.providerXai') },
        {
          id: 'openai-compatible' as const,
          label: t('adminAi.providerOpenaiCompatible'),
        },
      ] satisfies Array<{ id: AiProviderId; label: string }>,
    [t],
  );

  const hint = MODEL_HINTS[provider];

  async function save() {
    setSaving(true);
    setError(null);
    setNotice(null);
    setConfirmClear(false);
    try {
      const payload: {
        provider: AiProviderId;
        model: string;
        baseUrl?: string;
        apiKey?: string;
      } = {
        provider,
        model: model.trim(),
      };
      if (provider === 'openai-compatible') payload.baseUrl = baseUrl.trim();
      if (apiKey.trim()) payload.apiKey = apiKey.trim();
      const res = await fetch('/api/portal/admin/ai', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = (await res.json().catch(() => null)) as
        | (AiSettings & { message?: string })
        | null;
      if (!res.ok || !body || typeof body.configured !== 'boolean') {
        setError(
          typeof body?.message === 'string'
            ? body.message
            : t('adminAi.errSaveFallback'),
        );
        return;
      }
      setSettings(body);
      setApiKey('');
      setModel(body.model ?? '');
      setBaseUrl(body.baseUrl ?? '');
      if (body.provider) setProvider(body.provider);
      setNotice(
        body.configured
          ? t('adminAi.noticeSaved')
          : t('adminAi.noticeSavedIncomplete'),
      );
    } catch {
      setError(t('adminAi.errSaveFallback'));
    } finally {
      setSaving(false);
    }
  }

  async function clear() {
    setClearing(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch('/api/portal/admin/ai', { method: 'DELETE' });
      const body = (await res.json().catch(() => null)) as AiSettings | null;
      if (!res.ok || !body) {
        setError(t('adminAi.errClear'));
        return;
      }
      setSettings(body);
      setModel('');
      setBaseUrl('');
      setApiKey('');
      setProvider('openai');
      setConfirmClear(false);
      setNotice(t('adminAi.noticeCleared'));
    } catch {
      setError(t('adminAi.errClear'));
    } finally {
      setClearing(false);
    }
  }

  return (
    <div className="rounded-lg border border-border bg-surface-1 p-4 shadow-card">
      <div className="mb-3 flex items-center gap-2">
        <h2 className="text-sm font-medium text-ink-0">
          {t('adminAi.providerHeading')}
        </h2>
        {settings.configured ? (
          <span className="inline-flex rounded-full bg-accent/15 px-1.5 py-0.5 text-2xs uppercase tracking-wide text-accent">
            {t('adminAi.badgeConfigured')}
          </span>
        ) : (
          <span className="inline-flex rounded-full bg-warn/15 px-1.5 py-0.5 text-2xs uppercase tracking-wide text-warn">
            {t('adminAi.badgeOff')}
          </span>
        )}
      </div>
      <p className="mb-4 text-xs text-muted">
        {t('adminAi.intro')}
        {settings.apiKeyConfigured ? t('adminAi.introKeyStored') : ''}
      </p>

      <label className="mb-3 block text-xs text-muted">
        {t('adminAi.labelProvider')}
        <select
          value={provider}
          onChange={(e) => setProvider(e.target.value as AiProviderId)}
          className={`${inputClass} mt-1`}
        >
          {providers.map((row) => (
            <option key={row.id} value={row.id}>
              {row.label}
            </option>
          ))}
        </select>
      </label>

      <label className="mb-3 block text-xs text-muted">
        {t('adminAi.labelModel')}
        <input
          type="text"
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder={hint}
          maxLength={200}
          className={`${inputClass} mt-1`}
        />
      </label>

      {provider === 'openai-compatible' ? (
        <label className="mb-3 block text-xs text-muted">
          {t('adminAi.labelBaseUrl')}
          <input
            type="url"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="http://127.0.0.1:11434/v1"
            maxLength={2048}
            className={`${inputClass} mt-1`}
          />
          <span className="mt-1 block">{t('adminAi.baseUrlHint')}</span>
        </label>
      ) : null}

      <label className="mb-4 block text-xs text-muted">
        {t('adminAi.labelApiKey')}
        <input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          autoComplete="off"
          placeholder={
            settings.apiKeyConfigured
              ? t('adminAi.placeholderUnchanged')
              : t('adminAi.placeholderPasteKey')
          }
          maxLength={4096}
          className={`${inputClass} mt-1`}
        />
      </label>

      {error ? <p className="mb-3 text-xs text-danger">{error}</p> : null}
      {notice ? <p className="mb-3 text-xs text-ink-1">{notice}</p> : null}

      <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
        <button
          type="button"
          onClick={() => void save()}
          disabled={
            saving ||
            clearing ||
            model.trim().length === 0 ||
            (provider === 'openai-compatible' && baseUrl.trim().length === 0) ||
            (!settings.apiKeyConfigured && apiKey.trim().length === 0)
          }
          className="inline-flex h-8 items-center gap-1 rounded-md bg-accent px-3 text-xs font-medium text-accent-foreground hover:opacity-90 disabled:opacity-50"
        >
          {saving ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Save className="h-3.5 w-3.5" />
          )}
          {t('common.save')}
        </button>
        {confirmClear ? (
          <>
            <button
              type="button"
              onClick={() => void clear()}
              disabled={clearing || saving}
              className="inline-flex h-8 items-center gap-1 rounded-md border border-danger/40 px-3 text-xs font-medium text-danger hover:bg-danger/5 disabled:opacity-50"
            >
              {clearing ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Trash2 className="h-3.5 w-3.5" />
              )}
              {t('adminAi.confirmClear')}
            </button>
            <button
              type="button"
              onClick={() => setConfirmClear(false)}
              className="inline-flex h-8 items-center rounded-md px-2 text-xs text-muted hover:text-ink-0"
            >
              {t('common.cancel')}
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => setConfirmClear(true)}
            disabled={!settings.saved || saving || clearing}
            className="inline-flex h-8 items-center gap-1 rounded-md border border-border px-3 text-xs text-ink-1 hover:bg-surface-2 disabled:opacity-50"
          >
            <Trash2 className="h-3.5 w-3.5" />
            {t('adminAi.clear')}
          </button>
        )}
      </div>
    </div>
  );
}
