// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import { useState } from 'react';
import { Loader2, Save, Trash2 } from 'lucide-react';

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

const PROVIDERS: Array<{ id: AiProviderId; label: string; modelHint: string }> = [
  { id: 'openai', label: 'OpenAI (ChatGPT)', modelHint: 'gpt-4o-mini' },
  { id: 'anthropic', label: 'Anthropic (Claude)', modelHint: 'claude-sonnet-4-5' },
  { id: 'xai', label: 'xAI (Grok)', modelHint: 'grok-3' },
  {
    id: 'openai-compatible',
    label: 'Local OpenAI-compatible (Ollama or a proxy)',
    modelHint: 'llama3.2',
  },
];

const inputClass =
  'h-9 w-full rounded-md border border-border bg-surface-1 px-2 text-sm focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30';

/**
 * Admin form for the org AI provider. The key field starts empty
 * on every load. Saving with it blank keeps the stored key. The
 * API never sends the key back.
 */
export function AiSettingsForm({ initial }: { initial: AiSettings }) {
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

  const hint = PROVIDERS.find((row) => row.id === provider)?.modelHint ?? '';

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
            : 'Could not save the AI provider.',
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
          ? 'Saved. The API key stays on the server and is not shown again.'
          : 'Saved, but the provider is not usable yet.',
      );
    } catch {
      setError('Could not save the AI provider.');
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
        setError('Could not clear the AI provider.');
        return;
      }
      setSettings(body);
      setModel('');
      setBaseUrl('');
      setApiKey('');
      setProvider('openai');
      setConfirmClear(false);
      setNotice('AI is off. No model calls will be made.');
    } catch {
      setError('Could not clear the AI provider.');
    } finally {
      setClearing(false);
    }
  }

  return (
    <div className="rounded-lg border border-border bg-surface-1 p-4 shadow-card">
      <div className="mb-3 flex items-center gap-2">
        <h2 className="text-sm font-medium text-ink-0">Provider</h2>
        {settings.configured ? (
          <span className="inline-flex rounded-full bg-accent/15 px-1.5 py-0.5 text-2xs uppercase tracking-wide text-accent">
            configured
          </span>
        ) : (
          <span className="inline-flex rounded-full bg-warn/15 px-1.5 py-0.5 text-2xs uppercase tracking-wide text-warn">
            off
          </span>
        )}
      </div>
      <p className="mb-4 text-xs text-muted">
        Off until you save a provider and a key. The key is encrypted at
        rest and is not returned after save.
        {settings.apiKeyConfigured
          ? ' A key is already stored. Leave the field blank to keep it.'
          : ''}
      </p>

      <label className="mb-3 block text-xs text-muted">
        Provider
        <select
          value={provider}
          onChange={(e) => setProvider(e.target.value as AiProviderId)}
          className={`${inputClass} mt-1`}
        >
          {PROVIDERS.map((row) => (
            <option key={row.id} value={row.id}>
              {row.label}
            </option>
          ))}
        </select>
      </label>

      <label className="mb-3 block text-xs text-muted">
        Model
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
          Base URL
          <input
            type="url"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="http://127.0.0.1:11434/v1"
            maxLength={2048}
            className={`${inputClass} mt-1`}
          />
          <span className="mt-1 block">
            OpenAI-compatible root, such as an Ollama server. If it does
            not check keys, any non-empty placeholder still has to be saved.
          </span>
        </label>
      ) : null}

      <label className="mb-4 block text-xs text-muted">
        API key
        <input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          autoComplete="off"
          placeholder={
            settings.apiKeyConfigured ? '(unchanged)' : 'Paste an API key'
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
          Save
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
              Confirm clear
            </button>
            <button
              type="button"
              onClick={() => setConfirmClear(false)}
              className="inline-flex h-8 items-center rounded-md px-2 text-xs text-muted hover:text-ink-0"
            >
              Cancel
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
            Clear
          </button>
        )}
      </div>
    </div>
  );
}
