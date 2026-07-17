// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import { useEffect, useState } from 'react';
import {
  AlertTriangle,
  ExternalLink,
  Loader2,
  Pencil,
  Plus,
  Trash2,
  X,
} from 'lucide-react';

interface AgoConnection {
  id: string;
  orgUrl: string;
  orgHost: string;
  displayName: string;
  clientId: string;
  createdAt: string;
  createdById: string;
}

export function ConnectionsView() {
  const [conns, setConns] = useState<AgoConnection[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState<AgoConnection | 'new' | null>(null);

  async function reload() {
    setLoadError(null);
    try {
      const resp = await fetch('/api/portal/admin/import-ago/connections');
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status} ${await resp.text()}`);
      }
      setConns((await resp.json()) as AgoConnection[]);
    } catch (e) {
      setLoadError((e as Error).message);
    }
  }

  useEffect(() => {
    void reload();
  }, []);

  async function remove(id: string) {
    if (
      !window.confirm(
        'Remove this connection? The importer will no longer be able to sign into this AGO portal until it is re-added.',
      )
    ) {
      return;
    }
    try {
      const resp = await fetch(
        `/api/portal/admin/import-ago/connections/${id}`,
        { method: 'DELETE' },
      );
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status} ${await resp.text()}`);
      }
      await reload();
    } catch (e) {
      setLoadError((e as Error).message);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={() => setEditing('new')}
          className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent/90"
        >
          <Plus className="h-4 w-4" />
          Add AGO connection
        </button>
      </div>

      {loadError && (
        <p className="rounded border border-danger/30 bg-danger/5 px-3 py-2 text-xs text-danger">
          {loadError}
        </p>
      )}

      {conns === null && !loadError ? (
        <p className="flex items-center gap-2 text-xs text-muted">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Loading...
        </p>
      ) : conns && conns.length === 0 ? (
        <EmptyState onAdd={() => setEditing('new')} />
      ) : conns ? (
        <ul className="space-y-2">
          {conns.map((c) => (
            <li
              key={c.id}
              className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-surface-1 p-4"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-ink-0">
                  {c.displayName}
                </p>
                <p className="truncate text-xs text-muted">
                  <span className="font-mono">{c.orgHost}</span>
                  <span className="mx-1">&middot;</span>
                  Client ID:{' '}
                  <span className="font-mono">
                    {c.clientId.slice(0, 8)}...
                  </span>
                </p>
              </div>
              <div className="flex shrink-0 gap-1.5">
                <button
                  type="button"
                  onClick={() => setEditing(c)}
                  className="inline-flex items-center gap-1 rounded-md border border-border bg-surface-0 px-2.5 py-1.5 text-xs font-medium hover:bg-surface-2"
                >
                  <Pencil className="h-3.5 w-3.5" />
                  Edit
                </button>
                <button
                  type="button"
                  onClick={() => remove(c.id)}
                  className="inline-flex items-center gap-1 rounded-md border border-danger/30 bg-surface-0 px-2.5 py-1.5 text-xs font-medium text-danger hover:bg-danger/5"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}

      {editing && (
        <ConnectionModal
          mode={editing === 'new' ? 'create' : 'edit'}
          existing={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void reload();
          }}
        />
      )}
    </div>
  );
}

function EmptyState({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="rounded-lg border border-border bg-surface-1 p-6 text-center">
      <p className="text-sm font-medium text-ink-0">
        No AGO connections configured yet.
      </p>
      <p className="mt-1 text-xs text-muted">
        Add one for each AGO portal you want to import from.
      </p>
      <button
        type="button"
        onClick={onAdd}
        className="mt-4 inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent/90"
      >
        <Plus className="h-4 w-4" />
        Add your first connection
      </button>
    </div>
  );
}

function ConnectionModal({
  mode,
  existing,
  onClose,
  onSaved,
}: {
  mode: 'create' | 'edit';
  existing: AgoConnection | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [orgUrl, setOrgUrl] = useState(existing?.orgUrl ?? '');
  const [displayName, setDisplayName] = useState(existing?.displayName ?? '');
  const [clientId, setClientId] = useState(existing?.clientId ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Predict the callback URL for the AGO-side registration step so
  // the operator can copy + paste it into AGO's "Add Application"
  // form without leaving the modal.
  const [redirectUri, setRedirectUri] = useState('');
  useEffect(() => {
    setRedirectUri(
      `${window.location.origin}/admin/migrations/from-ago/oauth-callback`,
    );
  }, []);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const url =
        mode === 'create'
          ? '/api/portal/admin/import-ago/connections'
          : `/api/portal/admin/import-ago/connections/${existing!.id}`;
      const method = mode === 'create' ? 'POST' : 'PATCH';
      const body =
        mode === 'create'
          ? { orgUrl: orgUrl.trim(), displayName: displayName.trim(), clientId: clientId.trim() }
          : { displayName: displayName.trim(), clientId: clientId.trim() };
      const resp = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status} ${await resp.text()}`);
      }
      onSaved();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl rounded-lg border border-border bg-surface-0 p-6 shadow-card"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold">
            {mode === 'create' ? 'Add AGO connection' : 'Edit AGO connection'}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="text-muted hover:text-ink-0"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="mb-4 rounded-md border border-warning/30 bg-warning/5 p-3 text-xs text-warning">
          <p className="flex items-start gap-2 font-medium">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            One-time setup on the AGO portal
          </p>
          <ol className="ml-5 mt-2 list-decimal space-y-1 text-warning/90">
            <li>
              Sign into the AGO portal as an org admin and go to{' '}
              <strong>Content &rarr; My Content &rarr; New Item &rarr; Application</strong>{' '}
              (or call <code>/sharing/rest/oauth2/registerApp</code> directly).
            </li>
            <li>
              <strong>App type:</strong> Browser (implicit grant).
            </li>
            <li>
              <strong>Redirect URI:</strong>{' '}
              <code className="break-all rounded bg-surface-0 px-1 text-2xs">
                {redirectUri}
              </code>
            </li>
            <li>Save the app. AGO shows the client ID; paste it below.</li>
          </ol>
        </div>

        <div className="space-y-3">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs text-muted">
              ArcGIS Online org URL{' '}
              {mode === 'edit' && <em>(can&apos;t change after create)</em>}
            </span>
            <input
              type="text"
              disabled={mode === 'edit'}
              value={orgUrl}
              onChange={(e) => setOrgUrl(e.target.value)}
              className="rounded border border-border bg-surface-0 px-2 py-1.5 text-sm disabled:opacity-60"
              placeholder="palavido.maps.arcgis.com"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs text-muted">Display name (optional)</span>
            <input
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              className="rounded border border-border bg-surface-0 px-2 py-1.5 text-sm"
              placeholder="Palavido demo org"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs text-muted">
              Client ID from the AGO app registration
            </span>
            <input
              type="text"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              className="rounded border border-border bg-surface-0 px-2 py-1.5 text-sm font-mono"
              placeholder="abc123xyzClientId"
            />
          </label>
          <p className="text-xs text-muted">
            <ExternalLink className="-mt-0.5 mr-1 inline h-3 w-3" />
            <a
              href="https://developers.arcgis.com/documentation/security-and-authentication/oauth-2/grant-types/implicit-grant/"
              target="_blank"
              rel="noreferrer"
              className="text-accent hover:underline"
            >
              AGO implicit-grant docs
            </a>
          </p>
        </div>

        {error && (
          <p className="mt-3 rounded border border-danger/30 bg-danger/5 px-3 py-2 text-xs text-danger">
            {error}
          </p>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-border bg-surface-0 px-3 py-1.5 text-sm font-medium hover:bg-surface-2"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={
              busy ||
              (mode === 'create' && !orgUrl.trim()) ||
              !clientId.trim()
            }
            onClick={save}
            className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent/90 disabled:opacity-50"
          >
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {mode === 'create' ? 'Add connection' : 'Save changes'}
          </button>
        </div>
      </div>
    </div>
  );
}
