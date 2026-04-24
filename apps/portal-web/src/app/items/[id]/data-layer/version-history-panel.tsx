'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  Check,
  ChevronDown,
  History,
  Loader2,
  RotateCcw,
} from 'lucide-react';

/**
 * Version history panel for a data_layer item.
 *
 * ItemsService snapshots the item's `data` blob before every
 * replace (wizard re-upload, schema save, bulk import, revert).
 * This panel renders those snapshots newest-first and lets an
 * editor revert to one. The revert endpoint takes a fresh
 * snapshot of the current state FIRST — so un-revert is always
 * possible within the retention window.
 *
 * Retention on the API side:
 *   - TTL: 30 days (default; ITEM_SNAPSHOT_TTL_DAYS)
 *   - Cap: 20 per item (default; ITEM_SNAPSHOT_CAP_PER_ITEM)
 * A nightly maintenance cron drops rows past either gate.
 *
 * Visibility: API requires edit access — viewers won't see
 * snapshots, which matches 'authorship history, not public.'
 * We only mount this panel when `canEdit` is true anyway, so the
 * 403 case is mostly defensive.
 */
interface Snapshot {
  id: string;
  itemId: string;
  note: string | null;
  createdAt: string;
  createdBy: string;
}

interface Props {
  itemId: string;
  canEdit: boolean;
  /** Optional userId -> display name, same shape as other panels. */
  userNames?: Record<string, string>;
}

export function VersionHistoryPanel({ itemId, canEdit, userNames }: Props) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [reverting, setReverting] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/portal/items/${itemId}/snapshots`);
      if (!res.ok) {
        setError(`Could not load history: ${res.status}`);
        return;
      }
      const body = (await res.json()) as Snapshot[];
      setSnapshots(body);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load history');
    } finally {
      setLoading(false);
    }
  }, [itemId]);

  // Only fetch on first open — if a user never expands the panel
  // we shouldn't pay the round-trip. Reload on subsequent opens is
  // fine: history changes rarely relative to how often the panel
  // is clicked, and a stale list is easy enough to refresh.
  useEffect(() => {
    if (open && snapshots.length === 0 && !loading && !error) {
      void reload();
    }
  }, [open, snapshots.length, loading, error, reload]);

  if (!canEdit) return null;

  async function handleRevert(snapshotId: string) {
    setReverting(snapshotId);
    setError(null);
    try {
      const res = await fetch(
        `/api/portal/items/${itemId}/snapshots/${snapshotId}/revert`,
        { method: 'POST' },
      );
      if (!res.ok) {
        const body = await res.text();
        setError(`Revert failed: ${res.status} ${body.slice(0, 200)}`);
        return;
      }
      // Full reload so the rest of the page (schema, features,
      // provenance) picks up the restored data. A targeted
      // refetch would be nicer but the data blob touches many
      // components; a reload is the honest move.
      window.location.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Revert failed');
    } finally {
      setReverting(null);
      setConfirming(null);
    }
  }

  const headerCount = snapshots.length
    ? `${snapshots.length} ${snapshots.length === 1 ? 'version' : 'versions'}`
    : loading
    ? ''
    : open
    ? 'no history yet'
    : '';

  return (
    <section className="mb-6 rounded-md border border-border bg-surface-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left hover:bg-surface-2"
        aria-expanded={open}
      >
        <span className="inline-flex items-center gap-2">
          <History className="h-3.5 w-3.5 text-muted" />
          <span className="text-[11px] font-medium uppercase tracking-wide text-muted">
            Version history
          </span>
          {headerCount ? (
            <span className="text-xs text-muted">{headerCount}</span>
          ) : null}
        </span>
        <ChevronDown
          className={`h-3.5 w-3.5 text-muted transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open ? (
        <div className="border-t border-border p-3">
          {loading ? (
            <p className="inline-flex items-center gap-2 text-xs text-muted">
              <Loader2 className="h-3 w-3 animate-spin" />
              Loading history…
            </p>
          ) : error ? (
            <p className="inline-flex items-center gap-2 text-xs text-red-600">
              <AlertTriangle className="h-3.5 w-3.5" />
              {error}
            </p>
          ) : snapshots.length === 0 ? (
            <p className="text-xs text-muted">
              No prior versions yet. The next time this item's data is
              replaced (re-upload, bulk import, schema save), the
              current state will be captured here automatically.
            </p>
          ) : (
            <>
              <p className="mb-2 text-[11px] text-muted">
                Each row is a point-in-time copy of this item's data.
                Reverting restores that copy — and snapshots the
                current data first, so you can un-revert if needed.
                History is retained for 30 days or the last 20
                versions, whichever comes first.
              </p>
              <ul className="divide-y divide-border rounded border border-border bg-surface-0">
                {snapshots.map((s) => {
                  const createdAt = new Date(s.createdAt);
                  const by =
                    userNames?.[s.createdBy] ?? s.createdBy.slice(0, 8);
                  const isConfirming = confirming === s.id;
                  const isReverting = reverting === s.id;
                  return (
                    <li key={s.id} className="flex flex-col gap-1 p-2">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="text-xs text-ink-0">
                            <span
                              title={createdAt.toISOString()}
                              className="font-medium"
                            >
                              {createdAt.toLocaleString()}
                            </span>
                            <span className="ml-2 text-muted">by {by}</span>
                          </p>
                          {s.note ? (
                            <p className="mt-0.5 truncate text-[11px] italic text-muted">
                              {s.note}
                            </p>
                          ) : null}
                        </div>
                        {isConfirming ? (
                          <div className="flex shrink-0 items-center gap-1">
                            <button
                              type="button"
                              onClick={() => setConfirming(null)}
                              className="rounded border border-border bg-surface-1 px-2 py-0.5 text-[11px] text-ink-1 hover:bg-surface-2"
                              disabled={isReverting}
                            >
                              Cancel
                            </button>
                            <button
                              type="button"
                              onClick={() => handleRevert(s.id)}
                              disabled={isReverting}
                              className="inline-flex items-center gap-1 rounded border border-amber-400 bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-800 hover:bg-amber-100 disabled:opacity-60"
                            >
                              {isReverting ? (
                                <Loader2 className="h-3 w-3 animate-spin" />
                              ) : (
                                <Check className="h-3 w-3" />
                              )}
                              Revert to this
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setConfirming(s.id)}
                            className="inline-flex shrink-0 items-center gap-1 rounded border border-border bg-surface-1 px-2 py-0.5 text-[11px] text-ink-1 hover:bg-surface-2"
                          >
                            <RotateCcw className="h-3 w-3" />
                            Revert
                          </button>
                        )}
                      </div>
                      {isConfirming && !isReverting ? (
                        <p className="rounded bg-amber-50 px-2 py-1 text-[11px] text-amber-800">
                          This replaces the current data with the
                          version from {createdAt.toLocaleString()}. A
                          fresh snapshot of right-now is saved first,
                          so you can un-revert.
                        </p>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </div>
      ) : null}
    </section>
  );
}
