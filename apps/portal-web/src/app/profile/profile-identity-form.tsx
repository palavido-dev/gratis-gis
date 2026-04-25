'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Check, Loader2, Save } from 'lucide-react';

interface Initial {
  firstName: string;
  lastName: string;
  email: string;
}

interface Props {
  initial: Initial;
}

/**
 * Editable identity fields on the /profile page.
 *
 * PATCHes /api/users/me with only the diff. The API pushes identity
 * fields (firstName / lastName / email) to Keycloak before mirroring
 * into the local user row, so a Keycloak rejection propagates back as
 * a save error and nothing partial-saves.
 */
export function ProfileIdentityForm({ initial }: Props) {
  const router = useRouter();
  const [firstName, setFirstName] = useState(initial.firstName);
  const [lastName, setLastName] = useState(initial.lastName);
  const [email, setEmail] = useState(initial.email);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  const dirty =
    firstName.trim() !== initial.firstName ||
    lastName.trim() !== initial.lastName ||
    email.trim() !== initial.email;

  async function save() {
    setError(null);

    if (!email.includes('@')) {
      setError('Please enter a valid email address.');
      return;
    }

    const patch: Record<string, string> = {};
    if (firstName.trim() !== initial.firstName) patch.firstName = firstName.trim();
    if (lastName.trim() !== initial.lastName) patch.lastName = lastName.trim();
    if (email.trim() !== initial.email) patch.email = email.trim();
    if (Object.keys(patch).length === 0) return;

    setSaving(true);
    try {
      const res = await fetch('/api/portal/users/me', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        setError(`Save failed: ${res.status}${text ? `: ${text}` : ''}`);
        return;
      }
      setSaved(true);
      setTimeout(() => setSaved(false), 1600);
      // Refresh the server-rendered page so header / nav / badge
      // labels that depend on fullName pick up the change.
      startTransition(() => router.refresh());
    } catch (err) {
      setError((err as Error).message || 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="space-y-4 rounded-lg border border-border bg-surface-1 p-4 shadow-card">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium uppercase tracking-wide text-muted">
          Editable
        </p>
        {saved ? (
          <span className="inline-flex items-center gap-1 text-xs text-success">
            <Check className="h-3.5 w-3.5" /> Saved
          </span>
        ) : null}
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="block text-xs">
          <span className="mb-1 block uppercase tracking-wide text-muted">
            First name
          </span>
          <input
            type="text"
            value={firstName}
            onChange={(e) => setFirstName(e.target.value)}
            maxLength={60}
            className="h-9 w-full rounded-md border border-border bg-surface-1 px-2 text-sm focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
          />
        </label>
        <label className="block text-xs">
          <span className="mb-1 block uppercase tracking-wide text-muted">
            Last name
          </span>
          <input
            type="text"
            value={lastName}
            onChange={(e) => setLastName(e.target.value)}
            maxLength={60}
            className="h-9 w-full rounded-md border border-border bg-surface-1 px-2 text-sm focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
          />
        </label>
      </div>

      <label className="block text-xs">
        <span className="mb-1 block uppercase tracking-wide text-muted">
          Email
        </span>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          maxLength={200}
          className="h-9 w-full rounded-md border border-border bg-surface-1 px-2 text-sm focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
        />
        {email.trim() !== initial.email ? (
          <span className="mt-1 block text-[11px] text-warning">
            Changing the email will require re-verification on next sign-in.
          </span>
        ) : null}
      </label>

      {error ? (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      ) : null}

      <div className="flex items-center justify-end">
        <button
          type="button"
          onClick={save}
          disabled={saving || !dirty}
          className="inline-flex h-9 items-center gap-1.5 rounded-md bg-accent px-3 text-sm font-medium text-accent-foreground shadow-card hover:opacity-90 disabled:opacity-50"
        >
          {saving ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Save className="h-4 w-4" />
          )}
          Save
        </button>
      </div>
    </section>
  );
}
