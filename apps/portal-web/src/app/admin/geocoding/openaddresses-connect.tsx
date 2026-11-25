// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import { useState } from 'react';
import { CheckCircle2, Loader2, MailCheck } from 'lucide-react';

import { useT } from '@/lib/i18n/locale-context';
import type { GeocoderAdminView } from './geocoding-view';

type Mode = 'connect' | 'signup' | 'paste';

const API = '/api/portal/admin/geocoder/openaddresses';

const inputClass =
  'h-9 w-full rounded-md border border-border bg-surface-1 px-2 text-sm focus:border-accent focus:outline-hidden focus:ring-2 focus:ring-accent/30';

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API}/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const b = (await res.json()) as { message?: string | string[] };
      if (b.message) msg = Array.isArray(b.message) ? b.message.join(' ') : b.message;
    } catch {
      /* keep the status */
    }
    throw new Error(msg);
  }
  return (await res.json()) as T;
}

/**
 * Get an OpenAddresses token without leaving the page: sign in to an
 * existing account, create one (OpenAddresses emails a confirmation
 * link), or paste a token. Passwords go to OpenAddresses through the
 * portal and are not stored.
 */
export function OpenAddressesConnect({
  view,
  onView,
  oaToken,
  setOaToken,
  onClear,
  busy,
}: {
  view: GeocoderAdminView;
  onView: (next: GeocoderAdminView) => void;
  oaToken: string;
  setOaToken: (v: string) => void;
  onClear: () => void;
  busy: boolean;
}) {
  const t = useT();
  const [mode, setMode] = useState<Mode>('connect');
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);

  if (view.oaTokenSaved) {
    return (
      <div className="ml-6 space-y-1">
        <p className="flex items-center gap-2 text-sm">
          <CheckCircle2 className="h-4 w-4 text-accent" />
          {view.settings.oaAccount
            ? t('adminGeocoding.oaConnectedAs', { name: view.settings.oaAccount })
            : t('adminGeocoding.oaConnected')}
        </p>
        <button
          type="button"
          className="text-xs text-danger underline"
          onClick={onClear}
          disabled={busy}
        >
          {t('adminGeocoding.oaDisconnect')}
        </button>
      </div>
    );
  }

  async function connect() {
    setWorking(true);
    setError(null);
    try {
      onView(await post<GeocoderAdminView>('connect', { username: username.trim(), password }));
      setPassword('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setWorking(false);
    }
  }

  async function signup() {
    setWorking(true);
    setError(null);
    try {
      await post<{ username: string }>('signup', {
        username: username.trim(),
        email: email.trim(),
        password,
      });
      setSentTo(email.trim());
      setMode('connect');
      setPassword('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setWorking(false);
    }
  }

  const tabs: Array<{ id: Mode; label: string }> = [
    { id: 'connect', label: t('adminGeocoding.oaTabConnect') },
    { id: 'signup', label: t('adminGeocoding.oaTabSignup') },
    { id: 'paste', label: t('adminGeocoding.oaTabPaste') },
  ];

  return (
    <div className="ml-6 space-y-3 rounded-md border border-border p-3">
      <div role="tablist" className="flex flex-wrap gap-1">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={mode === tab.id}
            className={`rounded-md px-2 py-1 text-xs ${
              mode === tab.id ? 'bg-accent/10 font-medium text-accent' : 'text-muted hover:bg-surface-2'
            }`}
            onClick={() => {
              setMode(tab.id);
              setError(null);
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {sentTo && mode === 'connect' ? (
        <p className="flex items-start gap-2 rounded-md bg-surface-2 p-2 text-xs">
          <MailCheck className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
          {t('adminGeocoding.oaCheckEmail', { email: sentTo })}
        </p>
      ) : null}

      {mode === 'connect' ? (
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            void connect();
          }}
        >
          <input
            className={inputClass}
            autoComplete="off"
            placeholder={t('adminGeocoding.oaUsernameOrEmail')}
            aria-label={t('adminGeocoding.oaUsernameOrEmail')}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
          <input
            type="password"
            className={inputClass}
            autoComplete="off"
            placeholder={t('adminGeocoding.oaPassword')}
            aria-label={t('adminGeocoding.oaPassword')}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <button
            type="submit"
            className="inline-flex h-8 items-center gap-2 rounded-md border border-border px-3 text-xs disabled:opacity-50"
            disabled={working || !username.trim() || !password}
          >
            {working ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            {t('adminGeocoding.oaConnect')}
          </button>
        </form>
      ) : null}

      {mode === 'signup' ? (
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            void signup();
          }}
        >
          <input
            type="email"
            className={inputClass}
            autoComplete="off"
            placeholder={t('adminGeocoding.oaEmail')}
            aria-label={t('adminGeocoding.oaEmail')}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <input
            className={inputClass}
            autoComplete="off"
            placeholder={t('adminGeocoding.oaUsername')}
            aria-label={t('adminGeocoding.oaUsername')}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
          <input
            type="password"
            className={inputClass}
            autoComplete="new-password"
            placeholder={t('adminGeocoding.oaNewPassword')}
            aria-label={t('adminGeocoding.oaNewPassword')}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <p className="text-xs text-muted">{t('adminGeocoding.oaSignupHelp')}</p>
          <button
            type="submit"
            className="inline-flex h-8 items-center gap-2 rounded-md border border-border px-3 text-xs disabled:opacity-50"
            disabled={working || !email.trim() || !username.trim() || password.length < 8}
          >
            {working ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            {t('adminGeocoding.oaCreate')}
          </button>
        </form>
      ) : null}

      {mode === 'paste' ? (
        <div className="space-y-1">
          <input
            type="password"
            autoComplete="off"
            className={inputClass}
            placeholder={t('adminGeocoding.oaTokenPlaceholder')}
            aria-label={t('adminGeocoding.oaTokenPlaceholder')}
            value={oaToken}
            onChange={(e) => setOaToken(e.target.value)}
          />
          <p className="text-xs text-muted">{t('adminGeocoding.oaPasteHelp')}</p>
        </div>
      ) : null}

      {error ? <p className="text-xs text-danger">{error}</p> : null}
      <p className="text-xs text-muted">{t('adminGeocoding.oaTokenHelp')}</p>
    </div>
  );
}
