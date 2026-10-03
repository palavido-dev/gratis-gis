'use client';

import { useState } from 'react';

export interface SecurityState {
  providers: Array<{
    alias: string;
    displayName: string;
    enabled: boolean;
    domain: string | null;
  }>;
  mfaRequired: boolean;
}

const EMPTY_FORM = {
  alias: '',
  displayName: '',
  clientId: '',
  clientSecret: '',
  authorizationUrl: '',
  tokenUrl: '',
  domain: '',
};

/**
 * Add one OpenID Connect sign-in method and turn authenticator
 * setup on or off. The client secret is sent once and never shown
 * again.
 */
export function SecurityForm({ initial }: { initial: SecurityState }) {
  const [state, setState] = useState(initial);
  const [form, setForm] = useState(EMPTY_FORM);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function set<K extends keyof typeof EMPTY_FORM>(key: K, value: string) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function addProvider() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/portal/admin/security/oidc', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...form,
          domain: form.domain.trim() || undefined,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      if (!res.ok) {
        setError(body.message || 'Could not add that sign-in method.');
        return;
      }
      setState((prev) => ({
        ...prev,
        providers: [
          ...prev.providers,
          {
            alias: form.alias.trim().toLowerCase(),
            displayName: form.displayName.trim(),
            enabled: true,
            domain: form.domain.trim() || null,
          },
        ],
      }));
      setForm(EMPTY_FORM);
    } catch {
      setError('Could not add that sign-in method.');
    } finally {
      setBusy(false);
    }
  }

  async function remove(alias: string) {
    setError(null);
    const res = await fetch(`/api/portal/admin/security/oidc/${encodeURIComponent(alias)}`, {
      method: 'DELETE',
    });
    if (!res.ok) {
      setError('Could not remove that sign-in method.');
      return;
    }
    setState((prev) => ({
      ...prev,
      providers: prev.providers.filter((provider) => provider.alias !== alias),
    }));
  }

  async function toggleMfa(required: boolean) {
    setError(null);
    const res = await fetch('/api/portal/admin/security/mfa', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ required }),
    });
    if (!res.ok) {
      setError('Could not update the authenticator setting.');
      return;
    }
    setState((prev) => ({ ...prev, mfaRequired: required }));
  }

  const field =
    'mt-1 w-full rounded-md border border-border bg-surface-0 px-3 py-2 text-sm text-ink-0';

  return (
    <div className="space-y-8">
      <section className="rounded-md border border-border bg-surface-1 p-4">
        <h2 className="text-sm font-semibold text-ink-0">Authenticator</h2>
        <p className="mt-1 text-sm text-ink-1">
          When this is on, every account is asked to set up an authenticator
          the next time they sign in, including yours.
        </p>
        <label className="mt-3 flex items-center gap-2 text-sm text-ink-0">
          <input
            type="checkbox"
            checked={state.mfaRequired}
            onChange={(event) => void toggleMfa(event.target.checked)}
          />
          Require an authenticator
        </label>
      </section>

      <section>
        <h2 className="text-sm font-semibold text-ink-0">Sign-in methods</h2>
        {state.providers.length === 0 ? (
          <p className="mt-2 text-sm text-ink-1">
            People sign in with the portal account. Add an OpenID Connect
            provider to offer their existing work account on the sign-in page.
          </p>
        ) : (
          <ul className="mt-3 space-y-2">
            {state.providers.map((provider) => (
              <li
                key={provider.alias}
                className="flex items-center justify-between rounded-md border border-border px-3 py-2 text-sm"
              >
                <span>
                  {provider.displayName}
                  {provider.domain ? ` · ${provider.domain}` : ''}
                </span>
                <button
                  type="button"
                  className="text-accent underline"
                  onClick={() => void remove(provider.alias)}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-ink-0">Add OpenID Connect</h2>
        <p className="text-sm text-ink-1">
          New people who sign in this way join your organization as viewers.
          Use the provider&apos;s authorize and token URLs. Microsoft Entra,
          Google, and any other OpenID Connect service all use this form.
        </p>
        {(
          [
            ['displayName', 'Name on the sign-in page', 'Microsoft'],
            ['alias', 'Alias', 'entra'],
            ['clientId', 'Client ID', ''],
            ['authorizationUrl', 'Authorize URL', 'https://'],
            ['tokenUrl', 'Token URL', 'https://'],
            ['domain', 'Email domain (optional)', 'example.org'],
          ] as const
        ).map(([key, label, placeholder]) => (
          <label key={key} className="block text-sm text-ink-0">
            {label}
            <input
              className={field}
              value={form[key]}
              placeholder={placeholder}
              onChange={(event) => set(key, event.target.value)}
            />
          </label>
        ))}
        <label className="block text-sm text-ink-0">
          Client secret
          <input
            className={field}
            type="password"
            autoComplete="off"
            value={form.clientSecret}
            onChange={(event) => set('clientSecret', event.target.value)}
          />
        </label>
        <button
          type="button"
          disabled={busy}
          onClick={() => void addProvider()}
          className="rounded-md bg-accent px-3 py-2 text-sm text-accent-foreground disabled:opacity-50"
        >
          {busy ? 'Adding…' : 'Add sign-in method'}
        </button>
      </section>
      {error ? <p className="text-sm text-ink-0">{error}</p> : null}
    </div>
  );
}
