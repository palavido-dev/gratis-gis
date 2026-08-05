// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Check, Copy, Key, Loader2, Plus, Trash2 } from 'lucide-react';

import { toast } from '@/lib/toast';

export interface ApiKeySummary {
  id: string;
  name: string;
  prefix: string;
  readOnly: boolean;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

/** Expiry choices. "Until revoked" is offered because the common case
 *  (a cron job nobody wants to re-key every quarter) is real, but it
 *  is not the default: a bounded key is the safer starting point. */
const EXPIRY_CHOICES: Array<{ label: string; days: number | null }> = [
  { label: '30 days', days: 30 },
  { label: '90 days', days: 90 },
  { label: '1 year', days: 365 },
  { label: 'Until revoked', days: null },
];

export function ApiKeysManager({ initial }: { initial: ApiKeySummary[] }) {
  const router = useRouter();
  const [keys, setKeys] = useState(initial);
  const [name, setName] = useState('');
  const [readOnly, setReadOnly] = useState(false);
  const [expiryDays, setExpiryDays] = useState<number | null>(90);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The one and only time the plaintext token exists in the browser.
  const [minted, setMinted] = useState<{ token: string; name: string } | null>(
    null,
  );
  const [copied, setCopied] = useState(false);

  async function create() {
    if (name.trim().length === 0) {
      setError('Give the key a name so you can recognize it later.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/portal/users/me/api-keys', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          readOnly,
          expiresInDays: expiryDays,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          message?: unknown;
        };
        throw new Error(
          typeof body.message === 'string'
            ? body.message
            : `Could not create the key (HTTP ${res.status}).`,
        );
      }
      const created = (await res.json()) as ApiKeySummary & { token: string };
      const { token, ...summary } = created;
      setMinted({ token, name: summary.name });
      setKeys((prev) => [summary, ...prev]);
      setName('');
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the key.');
    } finally {
      setBusy(false);
    }
  }

  async function revoke(key: ApiKeySummary) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/portal/users/me/api-keys/${key.id}`, {
        method: 'DELETE',
      });
      if (!res.ok) throw new Error(`Could not revoke (HTTP ${res.status}).`);
      const updated = (await res.json()) as ApiKeySummary;
      setKeys((prev) => prev.map((k) => (k.id === key.id ? updated : k)));
      toast(`"${key.name}" is revoked. Anything using it stops working now.`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not revoke the key.');
    } finally {
      setBusy(false);
    }
  }

  async function copyToken() {
    if (!minted) return;
    try {
      await navigator.clipboard.writeText(minted.token);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setError('Could not copy. Select the key and copy it manually.');
    }
  }

  const active = keys.filter((k) => k.revokedAt === null);
  const inactive = keys.filter((k) => k.revokedAt !== null);

  return (
    <div className="space-y-6">
      {/* The token, shown exactly once. Deliberately loud: there is no
          second chance to read it, and a user who navigates away
          without copying has to mint a new key. */}
      {minted ? (
        <section className="rounded-lg border border-accent/40 bg-accent/5 p-4">
          <h2 className="text-sm font-semibold text-ink-0">
            Copy your key now
          </h2>
          <p className="mt-1 text-xs text-muted">
            This is the only time &quot;{minted.name}&quot; can be shown. The
            portal stores a one-way hash, so if you lose it you will need
            to make a new key.
          </p>
          <div className="mt-3 flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded border border-border bg-surface-1 px-2 py-1.5 font-mono text-xs text-ink-0">
              {minted.token}
            </code>
            <button
              type="button"
              onClick={() => void copyToken()}
              className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-md bg-accent px-3 text-sm font-medium text-accent-foreground hover:opacity-90"
            >
              {copied ? (
                <Check className="h-4 w-4" />
              ) : (
                <Copy className="h-4 w-4" />
              )}
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <button
            type="button"
            onClick={() => setMinted(null)}
            className="mt-3 text-xs text-muted underline hover:text-ink-0"
          >
            I have saved it, hide this
          </button>
        </section>
      ) : null}

      <section className="rounded-lg border border-border bg-surface-1 p-4 shadow-card">
        <h2 className="text-sm font-semibold text-ink-0">New key</h2>
        <div className="mt-3 space-y-3">
          <label className="block">
            <span className="text-xs font-medium uppercase tracking-wide text-muted">
              Name
            </span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="nightly parcel refresh"
              maxLength={80}
              className="mt-1 h-9 w-full rounded-md border border-border bg-surface-0 px-2 text-sm text-ink-0"
            />
          </label>

          <label className="block">
            <span className="text-xs font-medium uppercase tracking-wide text-muted">
              Expires
            </span>
            <select
              value={expiryDays === null ? 'never' : String(expiryDays)}
              onChange={(e) =>
                setExpiryDays(
                  e.target.value === 'never' ? null : Number(e.target.value),
                )
              }
              className="mt-1 h-9 w-full rounded-md border border-border bg-surface-0 px-2 text-sm text-ink-0"
            >
              {EXPIRY_CHOICES.map((c) => (
                <option
                  key={c.label}
                  value={c.days === null ? 'never' : String(c.days)}
                >
                  {c.label}
                </option>
              ))}
            </select>
          </label>

          <label className="flex items-start gap-2 text-sm text-ink-1">
            <input
              type="checkbox"
              checked={readOnly}
              onChange={(e) => setReadOnly(e.target.checked)}
              className="mt-0.5 accent-accent"
            />
            <span>
              Read only
              <span className="block text-xs text-muted">
                The key can read data but cannot create, change, or
                delete anything. Pick this unless the script needs to
                write.
              </span>
            </span>
          </label>

          <p className="text-xs text-muted">
            Keys cannot be used for admin pages, and cannot create more
            keys.
          </p>

          <button
            type="button"
            onClick={() => void create()}
            disabled={busy}
            className="inline-flex h-9 items-center gap-1.5 rounded-md bg-accent px-3 text-sm font-medium text-accent-foreground hover:opacity-90 disabled:opacity-50"
          >
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Plus className="h-4 w-4" />
            )}
            Create key
          </button>
        </div>
      </section>

      {error ? (
        <p className="rounded border border-danger/30 bg-danger/5 px-3 py-2 text-xs text-danger" role="alert">
          {error}
        </p>
      ) : null}

      <section className="rounded-lg border border-border bg-surface-1 p-4 shadow-card">
        <h2 className="text-sm font-semibold text-ink-0">Your keys</h2>
        {keys.length === 0 ? (
          <p className="mt-2 text-sm text-muted">
            No keys yet. Create one above to use the portal from a
            script or notebook.
          </p>
        ) : (
          <ul className="mt-2 divide-y divide-border/60">
            {[...active, ...inactive].map((k) => (
              <KeyRow
                key={k.id}
                item={k}
                busy={busy}
                onRevoke={() => void revoke(k)}
              />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function KeyRow({
  item,
  busy,
  onRevoke,
}: {
  item: ApiKeySummary;
  busy: boolean;
  onRevoke: () => void;
}) {
  const revoked = item.revokedAt !== null;
  const expired =
    !revoked &&
    item.expiresAt !== null &&
    new Date(item.expiresAt).getTime() <= Date.now();
  const dead = revoked || expired;

  return (
    <li
      className={`flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5 ${
        dead ? 'opacity-55' : ''
      }`}
    >
      <Key className="h-4 w-4 shrink-0 text-muted" />
      <span className="font-medium text-ink-0">{item.name}</span>
      <code className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-2xs text-muted">
        {item.prefix}...
      </code>
      {item.readOnly ? (
        <span className="rounded-full border border-border px-2 py-0.5 text-2xs text-muted">
          read only
        </span>
      ) : null}
      {revoked ? (
        <span className="rounded-full border border-danger/40 bg-danger/5 px-2 py-0.5 text-2xs font-medium text-danger">
          revoked
        </span>
      ) : expired ? (
        <span className="rounded-full border border-warn/40 bg-warn/5 px-2 py-0.5 text-2xs font-medium text-warn">
          expired
        </span>
      ) : null}
      <span className="ml-auto text-2xs text-muted">
        {item.lastUsedAt
          ? `last used ${shortDate(item.lastUsedAt)}`
          : 'never used'}
        {item.expiresAt && !revoked && !expired
          ? ` - expires ${shortDate(item.expiresAt)}`
          : ''}
      </span>
      {!dead ? (
        <button
          type="button"
          onClick={onRevoke}
          disabled={busy}
          className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-2xs font-medium text-ink-1 hover:bg-surface-2 disabled:opacity-40"
        >
          <Trash2 className="h-3 w-3" />
          Revoke
        </button>
      ) : null}
    </li>
  );
}

function shortDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? 'unknown'
    : d.toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      });
}
