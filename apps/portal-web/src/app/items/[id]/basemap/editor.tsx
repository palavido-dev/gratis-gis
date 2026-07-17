// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Check, Loader2, Save } from 'lucide-react';
import type { BasemapData } from '@gratis-gis/shared-types';
import { BasemapConfigSection } from '../../_components/basemap-config-section';
import { BasemapPreview } from '@/components/basemap-preview';

/**
 * Detail-page editor for basemap items (#144). Closes the gap where
 * basemaps had no edit-the-source surface after creation: previously
 * a misconfigured basemap could only be fixed by deleting and
 * recreating it through the wizard, because the generic ItemForm
 * only handles metadata (title / description / tags / access).
 *
 * The interesting work happens inside BasemapConfigSection, which
 * also drives the wizard's authoring step (#298) and the Probe URL
 * tab (#144). This component contributes:
 *
 *   - state ownership: stages a draft BasemapData and tracks
 *     whether it differs from the persisted version so Save only
 *     PATCHes when there's actually something to save
 *   - canEdit gate: viewers (read-only shares) see the configured
 *     source but can't change it; the section still renders for
 *     transparency, just inside a disabled container
 *   - save: PATCHes /api/portal/items/{id} with `{ data: draft }`.
 *     The api validates BasemapData server-side via
 *     class-validator + the existing item PATCH path; we surface
 *     whatever error comes back rather than trying to pre-validate
 *     here.
 *
 * Layout mirrors ServiceEditor / OgcServiceEditor so admins move
 * between item-type editors without re-learning the chrome: card
 * with title strip, body, sticky Save / Discard footer when dirty.
 */
interface Props {
  itemId: string;
  initial: BasemapData;
  canEdit: boolean;
}

export function BasemapEditor({ itemId, initial, canEdit }: Props) {
  const router = useRouter();
  const [draft, setDraft] = useState<BasemapData>(initial);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Dirty check via JSON equality. The fields we care about
  // (kind + url variants + wmsConfig + attribution + thumbnailUrl)
  // are all serializable so stringify is a clean comparator; we
  // intentionally don't deep-compare key-by-key because that
  // would also have to enumerate the wmsConfig sub-fields.
  const initialJson = JSON.stringify(initial);
  const draftJson = JSON.stringify(draft);
  const hasChanges = initialJson !== draftJson;

  async function save() {
    if (!canEdit || !hasChanges) return;
    setError(null);
    setSaving(true);
    setSaved(false);
    try {
      const res = await fetch(`/api/portal/items/${itemId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ data: draft }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        let msg = `Save failed (HTTP ${res.status}).`;
        // The api returns BadRequestException as
        // { statusCode, message, error } -- pull the message
        // field so the user sees the real validation error.
        try {
          const parsed = JSON.parse(body) as { message?: unknown };
          if (typeof parsed.message === 'string') msg = parsed.message;
          else if (
            Array.isArray(parsed.message) &&
            parsed.message.length > 0
          ) {
            msg = String(parsed.message[0]);
          }
        } catch {
          /* response wasn't JSON; keep the HTTP fallback */
        }
        setError(msg);
        return;
      }
      setSaved(true);
      // Refresh the server component so the new data lands in the
      // detail page's other surfaces (e.g. dependency panel).
      // We don't router.refresh() while a probe is being shown
      // because the editor's own draft state already reflects the
      // saved value.
      router.refresh();
      // Auto-dismiss the "Saved" affordance so the footer doesn't
      // permanently look like there's an unconfirmed action.
      window.setTimeout(() => setSaved(false), 2400);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed.');
    } finally {
      setSaving(false);
    }
  }

  function discard() {
    setDraft(initial);
    setError(null);
    setSaved(false);
  }

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-surface-1 shadow-card">
      <div className="border-b border-border bg-surface-2 px-4 py-3">
        <h3 className="text-sm font-medium text-ink-0">Basemap source</h3>
        <p className="mt-0.5 text-xs text-muted">
          {canEdit
            ? 'Configure how this basemap is served. Maps that reference this item pull from the source below.'
            : 'You have read-only access to this basemap. The source is shown below; ask an admin or the owner to change it.'}
        </p>
      </div>

      <div className={canEdit ? '' : 'pointer-events-none opacity-70'}>
        <div className="grid gap-4 p-4 md:grid-cols-[minmax(0,_1fr)_minmax(0,_1fr)]">
          <BasemapConfigSection value={draft} onChange={setDraft} />
          <div className="flex min-w-0 flex-col gap-2">
            <p className="text-xs font-medium uppercase tracking-wide text-muted">
              Preview
            </p>
            <div className="aspect-[3/2] w-full overflow-hidden rounded-md border border-border bg-surface-2">
              <BasemapPreview data={draft} interactive />
            </div>
            <p className="text-2xs text-muted">
              Live render against the fields on the left. Pan and zoom
              to confirm tiles serve at the levels you need.
            </p>
          </div>
        </div>
      </div>

      {canEdit ? (
        <div className="flex items-center justify-between gap-3 border-t border-border bg-surface-2 px-4 py-3">
          <div className="min-w-0 flex-1 text-xs">
            {error ? (
              <p className="text-danger" role="alert">
                {error}
              </p>
            ) : saved ? (
              <p className="inline-flex items-center gap-1 text-accent">
                <Check className="h-3.5 w-3.5" />
                Saved
              </p>
            ) : hasChanges ? (
              <p className="text-muted">Unsaved changes.</p>
            ) : (
              <p className="text-muted">No changes.</p>
            )}
          </div>
          <button
            type="button"
            onClick={discard}
            disabled={!hasChanges || saving}
            className="inline-flex h-9 items-center rounded-md border border-border bg-surface-1 px-3 text-sm font-medium text-ink-1 hover:bg-surface-2 disabled:opacity-50"
          >
            Discard
          </button>
          <button
            type="button"
            onClick={() => void save()}
            disabled={!hasChanges || saving}
            className="inline-flex h-9 items-center gap-1.5 rounded-md bg-accent px-3 text-sm font-medium text-accent-foreground hover:opacity-90 disabled:opacity-50"
          >
            {saving ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Save className="h-4 w-4" />
            )}
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      ) : null}
    </div>
  );
}
