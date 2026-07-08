// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import { useEffect, useState } from 'react';
import { Globe2, Loader2 } from 'lucide-react';

import { getItemTypeLabel } from '@/lib/item-type-icon';
import type { ItemAccess, ItemType } from '@gratis-gis/shared-types';
import { useT } from '@/lib/i18n/locale-context';

/**
 * Lean payload for the cascade list. Pulled from the existing
 * /items/:id/dependencies?transitive=true endpoint, then narrowed
 * to private/org-only entries before being shown.
 */
interface DepRow {
  id: string;
  title: string;
  type: ItemType;
  access: ItemAccess;
}

interface Props {
  /** Title of the item the user just made public; shown in the
   *  modal header so they know which decision they're cascading. */
  parentTitle: string;
  /** Open vs. closed; mounted by the parent based on whether the
   *  most-recent access transition was -> public AND there's at
   *  least one private dependency. */
  open: boolean;
  /** Item id being made public. Used to fetch dependencies. */
  parentId: string;
  /** Called after the user confirms (one or more cascades) or
   *  dismisses (no cascades). The parent stays at access='public'
   *  on the parent regardless; the cascade is purely additive. */
  onClose: () => void;
  /**
   * Optional revert callback. When provided, a third "Cancel" button
   * appears that asks the parent to flip the source item back to
   * whatever tier it was on before going public, AND closes the
   * dialog without firing any cascades. Useful when seeing the
   * dependency list changes the author's mind ("oh I don't actually
   * want this public after all"). When omitted, only Skip + the
   * primary cascade button render -- existing call sites that don't
   * yet plumb the revert path keep working unchanged.
   */
  onCancel?: () => void;
}

/**
 * Hard-prompt the author when they flip an item to public, listing
 * the transitively-referenced items that are still private/org and
 * offering to flip them to public in one click. Mirrors the existing
 * share-time dependency prompt (#115) for individual user/group
 * shares; this one is for the access='public' tier.
 *
 * UX flow:
 *   1. Mount when parent flips to public.
 *   2. Fetch /items/:id/dependencies?transitive=true.
 *   3. Filter to entries where access !== 'public' and the type can
 *      meaningfully be public (data_layer, service, basemap, map,
 *      pick_list, geo_boundary). Hide the empty case so the modal
 *      never shows a "nothing to do" message.
 *   4. Render checkboxes (default all checked). Confirm fires a
 *      sequence of PATCH calls to /items/:id with { access:'public' }.
 *   5. Close on success or cancel.
 */
export function PublicCascadeDialog({
  parentTitle,
  open,
  parentId,
  onClose,
  onCancel,
}: Props) {
  const t = useT();
  const [deps, setDeps] = useState<DepRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  // Pull the transitive dependency list once when the dialog mounts.
  // The parent owns the open/closed gate; once it sets open=true we
  // always re-fetch to make sure stale data from a previous open
  // doesn't leak in.
  useEffect(() => {
    if (!open) return;
    let abort = false;
    setDeps(null);
    setError(null);
    setBusy(false);
    void (async () => {
      try {
        const res = await fetch(
          `/api/portal/items/${parentId}/dependencies?transitive=true`,
        );
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const json = (await res.json()) as Array<{
          id: string;
          title: string;
          type: ItemType;
          access: ItemAccess;
        }>;
        if (abort) return;
        // Only show items that need flipping. Items already public
        // are silently dropped; the user doesn't need to confirm
        // those again.
        const private_or_org = json.filter((r) => r.access !== 'public');
        setDeps(private_or_org);
        setSelected(new Set(private_or_org.map((r) => r.id)));
        // Empty list -> close the modal silently. Nothing to do.
        if (private_or_org.length === 0) onClose();
      } catch (err) {
        if (abort) return;
        setError(
          err instanceof Error
            ? err.message
            : t('cascade.loadFailed'),
        );
      }
    })();
    return () => {
      abort = true;
    };
  }, [open, parentId, onClose, t]);

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const confirm = async () => {
    if (selected.size === 0) {
      onClose();
      return;
    }
    setBusy(true);
    setError(null);
    // Sequential to keep the API server happy; the lists are small
    // (a viewer's worst case is one map + a handful of layers + one
    // basemap, well under 10). Promise.all would parallelise but
    // make error reporting messier; sequential is fine here.
    let failed = 0;
    for (const id of selected) {
      try {
        const res = await fetch(`/api/portal/items/${id}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ access: 'public' }),
        });
        if (!res.ok) failed += 1;
      } catch {
        failed += 1;
      }
    }
    setBusy(false);
    if (failed > 0) {
      setError(
        t('cascade.partialFailure', {
          failed,
          total: selected.size,
        }),
      );
      return;
    }
    onClose();
  };

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-label={t('cascade.dialogLabel')}
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-lg border border-border bg-surface-1 p-5 shadow-raised"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3">
          <Globe2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-700" />
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold text-ink-0">
              {t('cascade.title')}
            </h2>
            <p className="mt-1 text-xs text-muted">
              <span className="font-medium text-ink-1">{parentTitle}</span>{' '}
              {t('cascade.body')}
            </p>
          </div>
        </div>

        {deps === null ? (
          <div className="mt-4 flex items-center gap-2 text-xs text-muted">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t('cascade.loading')}
          </div>
        ) : (
          <ul className="mt-4 max-h-72 space-y-1 overflow-auto rounded-md border border-border bg-surface-0 p-2">
            {deps.map((d) => (
              <li key={d.id}>
                <label className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 hover:bg-surface-2">
                  <input
                    type="checkbox"
                    checked={selected.has(d.id)}
                    onChange={() => toggle(d.id)}
                    disabled={busy}
                  />
                  <span className="min-w-0 flex-1 truncate text-sm text-ink-1">
                    {d.title}
                  </span>
                  <span className="text-[10px] uppercase tracking-wide text-muted">
                    {getItemTypeLabel(d.type)}
                  </span>
                  <span className="text-[10px] uppercase tracking-wide text-muted">
                    {t(`sharing.access.${d.access}`)}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}

        {error ? (
          <p className="mt-3 text-xs text-rose-700">{error}</p>
        ) : null}

        <div className="mt-5 flex items-center justify-between gap-2">
          {/* Cancel reverts the parent's flip to public when the
              caller wires it up; otherwise it's hidden so existing
              callers don't grow a button that does nothing. Lives
              on the left so the destructive-ish action is visually
              separated from the Skip / primary affordances. */}
          <div>
            {onCancel ? (
              <button
                type="button"
                onClick={() => {
                  onCancel();
                }}
                disabled={busy}
                className="rounded-md border border-border bg-surface-1 px-3 py-1.5 text-sm text-ink-1 hover:bg-surface-2 disabled:opacity-50"
              >
                {t('common.cancel')}
              </button>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className="rounded-md border border-border bg-surface-1 px-3 py-1.5 text-sm hover:bg-surface-2 disabled:opacity-50"
            >
              {t('cascade.skip')}
            </button>
            <button
              type="button"
              onClick={() => void confirm()}
              disabled={busy || deps === null || selected.size === 0}
              className="inline-flex items-center gap-1.5 rounded-md bg-emerald-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-800 disabled:opacity-50"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {t('cascade.makePublic', { count: selected.size })}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
