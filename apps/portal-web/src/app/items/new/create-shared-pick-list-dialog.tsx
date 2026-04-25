'use client';

import { useState } from 'react';
import { Loader2, ListChecks } from 'lucide-react';
import type { Item, PickListEntry } from '@gratis-gis/shared-types';

/**
 * In-flow modal for creating a shared `pick_list` item without
 * leaving the feature-service builder. Used in two places:
 *
 *   1. From `SharedPickListRefEditor` when the user has no existing
 *      pick lists yet ("Create new" button on the picker).
 *   2. From `CodedValueEditor` to promote the currently-inlined values
 *      into a shared list ("Save as shared list" button).
 *
 * On success the dialog fires `onCreated(newItemId)` so the caller
 * can (a) flip the field's domain to `coded-value-ref` and (b) refresh
 * any cached list of pick lists it may be holding. The dialog itself
 * closes.
 */
interface Props {
  /** Seed entries: typically the inline values being promoted. */
  seedEntries?: PickListEntry[];
  /** Default title (e.g. field label + " options"). */
  defaultTitle?: string;
  onClose: () => void;
  onCreated: (newItemId: string, newItemTitle: string) => void;
}

export function CreateSharedPickListDialog({
  seedEntries = [],
  defaultTitle = '',
  onClose,
  onCreated,
}: Props) {
  const [title, setTitle] = useState(defaultTitle);
  const [description, setDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (title.trim().length < 2) {
      setError('Give the pick list a name (at least 2 characters).');
      return;
    }

    setSubmitting(true);
    try {
      // Normalize seed entries to the shared-type shape. Inline
      // coded-value entries can carry numeric codes; shared pick
      // lists store codes as strings for referential consistency
      // with the domain resolver.
      const entries: PickListEntry[] = seedEntries
        .filter((e) => String(e.code ?? '').trim().length > 0)
        .map((e) => {
          const entry: PickListEntry = {
            code: String(e.code).trim(),
            label: (e.label ?? '').trim() || String(e.code).trim(),
          };
          if (e.description?.trim()) entry.description = e.description.trim();
          return entry;
        });

      const res = await fetch('/api/portal/items', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'pick_list',
          title: title.trim(),
          description: description.trim(),
          tags: [],
          access: 'org',
          data: { version: 3, entries },
        }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        setError(
          `Create failed: ${res.status}${body ? `: ${body}` : ''}`,
        );
        return;
      }
      const saved = (await res.json()) as Item;
      onCreated(saved.id, saved.title);
    } catch (err) {
      setError((err as Error).message || 'Create failed');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <form
        onSubmit={submit}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md space-y-3 rounded-lg border border-border bg-surface-1 p-4 shadow-raised"
      >
        <div className="flex items-center gap-2">
          <ListChecks className="h-5 w-5 text-accent" />
          <h2 className="text-lg font-semibold">
            {seedEntries.length > 0
              ? 'Save as shared pick list'
              : 'Create pick list'}
          </h2>
        </div>
        <p className="text-xs text-muted">
          {seedEntries.length > 0 ? (
            <>
              Promotes the{' '}
              <span className="font-semibold">
                {seedEntries.length} value{seedEntries.length === 1 ? '' : 's'}
              </span>{' '}
              on this field into a shared <code>pick_list</code> item that
              other fields, forms, and dashboards can reference. This field
              will automatically switch to referencing the new list.
            </>
          ) : (
            <>
              Creates a new shared pick list in your organization and
              associates this field with it. You can add entries here or
              later on the list&apos;s detail page (manual, CSV, Excel, or
              paste from clipboard all work).
            </>
          )}
        </p>

        <label className="block text-xs">
          <span className="mb-1 block uppercase tracking-wide text-muted">
            Name
          </span>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Priority levels"
            required
            maxLength={200}
            autoFocus
            className="h-9 w-full rounded-md border border-border bg-surface-1 px-2 text-sm focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
          />
        </label>

        <label className="block text-xs">
          <span className="mb-1 block uppercase tracking-wide text-muted">
            Description (optional)
          </span>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What's this list for? Who maintains it?"
            maxLength={5000}
            rows={2}
            className="w-full rounded-md border border-border bg-surface-1 px-2 py-1 text-xs focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
          />
        </label>

        {seedEntries.length > 0 ? (
          <div className="rounded border border-border bg-surface-0 p-2 text-[11px]">
            <p className="mb-1 uppercase tracking-wide text-muted">
              Entries to be copied
            </p>
            <ul className="max-h-32 space-y-0.5 overflow-y-auto">
              {seedEntries.slice(0, 12).map((e, i) => (
                <li
                  key={`${e.code}-${i}`}
                  className="flex items-center gap-2"
                >
                  <code className="rounded bg-surface-2 px-1 font-mono">
                    {String(e.code)}
                  </code>
                  <span className="text-ink-1">{e.label}</span>
                </li>
              ))}
              {seedEntries.length > 12 ? (
                <li className="pt-1 text-muted">
                  …and {seedEntries.length - 12} more.
                </li>
              ) : null}
            </ul>
          </div>
        ) : null}

        {error ? (
          <p role="alert" className="text-xs text-danger">
            {error}
          </p>
        ) : null}

        <div className="flex items-center justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="h-9 rounded-md border border-border bg-surface-1 px-3 text-xs font-medium text-ink-1 hover:bg-surface-2 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting}
            className="inline-flex h-9 items-center gap-1.5 rounded-md bg-accent px-3 text-xs font-medium text-accent-foreground hover:opacity-90 disabled:opacity-50"
          >
            {submitting ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <ListChecks className="h-3.5 w-3.5" />
            )}
            {seedEntries.length > 0
              ? 'Save & use shared list'
              : 'Create pick list'}
          </button>
        </div>
      </form>
    </div>
  );
}
