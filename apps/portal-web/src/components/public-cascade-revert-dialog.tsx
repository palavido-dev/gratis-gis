// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import { useEffect, useState } from 'react';
import { Lock, Loader2 } from 'lucide-react';

import { getItemTypeLabel } from '@/lib/item-type-icon';
import type { ItemAccess, ItemType } from '@gratis-gis/shared-types';
import { useT } from '@/lib/i18n/locale-context';

/**
 * Lean payload for the cascade-revert list. Pulled from
 * /items/:id/cascade-revert-candidates which already filters server-
 * side to deps that are access='public' AND not independently
 * required by another public item.
 */
interface CandidateRow {
  id: string;
  title: string;
  type: ItemType;
  access: ItemAccess;
}

interface Props {
  /** Title of the item that just lost access='public'; shown in the
   *  modal header so the user knows which decision they're cascading. */
  parentTitle: string;
  /** Open vs. closed; mounted by the parent based on whether the
   *  most-recent access transition was FROM public AND the candidate
   *  list comes back non-empty. */
  open: boolean;
  /** Item id whose access was just downgraded. Used to fetch the
   *  candidate list. */
  parentId: string;
  /** Tier to downgrade selected candidates to. Defaults to 'org'
   *  because the candidates are dependencies of an item whose
   *  audience just stopped being anonymous; org-only is the safer
   *  middle ground than dropping straight to private. The user can
   *  still hand-revert to private from each item's own page later. */
  downgradeTo?: ItemAccess;
  /** Called after the user confirms (one or more flips) or
   *  dismisses (no flips). The parent stays at the new access on
   *  the parent regardless; the cascade is purely reverting
   *  dependencies. */
  onClose: () => void;
}

/**
 * Hard-prompt the author when they flip an item OUT of access='public'
 * (#334), listing the transitively-referenced items that are still
 * access='public' AND aren't independently consumed by another
 * public item. Inverse of PublicCascadeDialog (#310): going public
 * propagates DOWN; coming back from public reverts what's no longer
 * needed.
 *
 * UX flow:
 *   1. Mount when parent flips OUT of public.
 *   2. Fetch /items/:id/cascade-revert-candidates.
 *   3. Render checkboxes (default all checked). Confirm fires a
 *      sequence of PATCH calls to /items/:id with
 *      { access: downgradeTo }.
 *   4. Close on success or cancel.
 *   5. If the candidate list is empty, self-dismiss silently --
 *      nothing to revert.
 *
 * The "and not referenced by another public" filter happens
 * server-side: a layer that's still powering some other public
 * map shouldn't be offered for downgrade because that would break
 * the other map's anonymous render. Trusting the server keeps the
 * client honest with the same rule across surfaces.
 */
export function PublicCascadeRevertDialog({
  parentTitle,
  open,
  parentId,
  downgradeTo = 'org',
  onClose,
}: Props) {
  const t = useT();
  const [candidates, setCandidates] = useState<CandidateRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    let abort = false;
    setCandidates(null);
    setError(null);
    setBusy(false);
    void (async () => {
      try {
        const res = await fetch(
          `/api/portal/items/${parentId}/cascade-revert-candidates`,
        );
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const json = (await res.json()) as CandidateRow[];
        if (abort) return;
        setCandidates(json);
        setSelected(new Set(json.map((r) => r.id)));
        // Empty candidate list -> close the modal silently. Either
        // there are no public deps, or every public dep is still
        // needed by some other public consumer.
        if (json.length === 0) onClose();
      } catch (err) {
        if (abort) return;
        setError(
          err instanceof Error
            ? err.message
            : t('cascadeRevert.loadFailed'),
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
    let failed = 0;
    for (const id of selected) {
      try {
        const res = await fetch(`/api/portal/items/${id}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ access: downgradeTo }),
        });
        if (!res.ok) failed += 1;
      } catch {
        failed += 1;
      }
    }
    setBusy(false);
    if (failed > 0) {
      setError(
        t('cascadeRevert.partialFailure', {
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
      aria-label={t('cascadeRevert.dialogLabel')}
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-lg border border-border bg-surface-1 p-5 shadow-raised"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3">
          <Lock className="mt-0.5 h-5 w-5 shrink-0 text-slate-700" />
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold text-ink-0">
              {t('cascadeRevert.title')}
            </h2>
            <p className="mt-1 text-xs text-muted">
              <span className="font-medium text-ink-1">{parentTitle}</span>{' '}
              {t('cascadeRevert.body')}
            </p>
          </div>
        </div>

        {candidates === null ? (
          <div className="mt-4 flex items-center gap-2 text-xs text-muted">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t('cascade.loading')}
          </div>
        ) : (
          <ul className="mt-4 max-h-72 space-y-1 overflow-auto rounded-md border border-border bg-surface-0 p-2">
            {candidates.map((d) => (
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
                  <span className="text-[10px] uppercase tracking-wide text-emerald-700">
                    {t('sharing.access.public')}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}

        {error ? (
          <p className="mt-3 text-xs text-rose-700">{error}</p>
        ) : null}

        <div className="mt-5 flex items-center justify-end gap-2">
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
            disabled={busy || candidates === null || selected.size === 0}
            className="inline-flex items-center gap-1.5 rounded-md bg-slate-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {t('cascadeRevert.revertButton', {
              count: selected.size,
              tier: t(`sharing.access.${downgradeTo}`),
            })}
          </button>
        </div>
      </div>
    </div>
  );
}
