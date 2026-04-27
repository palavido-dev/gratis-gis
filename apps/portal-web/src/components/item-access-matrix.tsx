'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Check,
  Loader2,
  Search,
  ShieldCheck,
  X,
} from 'lucide-react';
import type { ItemType } from '@gratis-gis/shared-types';
import { getItemTypeLabel } from '@/lib/item-type-icon';

/**
 * Generic principal x dependency-item access matrix.
 *
 * Composite items (editor today, dashboards/web_apps later) compose
 * other items. Sharing the composite alone does not grant the sharee
 * access to those underlying items, so a sharee can land on a runtime
 * that 403s mid-render. This matrix surfaces those gaps explicitly:
 * one row per dependency item, one column per principal of the
 * composite item's shares. Cells show a tick when the principal can
 * see that item, a warning + grant button when they cannot.
 *
 * Intentionally NOT a copy of the map's per-layer AccessMatrix (which
 * also narrows View / Query / Edit per layer). This one is pure item-
 * level visibility -- the composite item never narrows the underlying
 * item's own ACL, it just relies on it. Keeping the surface tight
 * makes the contract obvious to the author.
 */
export interface MatrixPrincipal {
  type: 'user' | 'group';
  id: string;
  name: string;
}

export interface MatrixItem {
  id: string;
  title: string;
  type: ItemType;
  /**
   * Optional one-line context shown under the title. Used today to
   * tell the author why this row is here ("Referenced map",
   * "Editing target", "Layer in referenced map") so a long
   * dependency list reads as a clear chain rather than a flat list.
   */
  rationale?: string;
}

interface Props {
  open: boolean;
  /**
   * Title shown in the modal header. Composite-item-specific; e.g.
   * "Item access for Editor App Test" so the author knows which
   * surface they're auditing when several modals could be open.
   */
  title: string;
  items: MatrixItem[];
  principals: MatrixPrincipal[];
  /**
   * Pure predicate: does the given principal currently have view
   * access to the given item? Computed by the parent because access
   * combines item.access (private/org/public), item.orgId, share
   * rows, and the principal's group memberships -- the parent has
   * all of that loaded already, and pushing the predicate here
   * keeps the matrix stateless.
   */
  hasAccess: (itemId: string, principal: MatrixPrincipal) => boolean;
  /**
   * Grant view permission on the given item to the given principal.
   * Parent owns the POST + state refresh; the matrix just dispatches
   * and waits. Resolves on success, throws on failure (the row's
   * inline error rendering uses the thrown message).
   */
  onGrantItemAccess: (
    itemId: string,
    principal: MatrixPrincipal,
  ) => Promise<void>;
  onClose: () => void;
  /** Whether the viewer is allowed to grant item access. Owners /
   *  admins of the dependency items are the only ones who can; the
   *  matrix renders read-only for everyone else and shows gaps but
   *  no fix button. */
  canManage: boolean;
}

export function ItemAccessMatrix({
  open,
  title,
  items,
  principals,
  hasAccess,
  onGrantItemAccess,
  onClose,
  canManage,
}: Props) {
  const [filter, setFilter] = useState('');
  const [grantingKey, setGrantingKey] = useState<string | null>(null);
  const [bulkGranting, setBulkGranting] = useState(false);
  const [errorByKey, setErrorByKey] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!open) {
      setFilter('');
      setErrorByKey({});
    }
  }, [open]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return items;
    return items.filter((i) => i.title.toLowerCase().includes(q));
  }, [items, filter]);

  // Enumerate every (item, principal) pair where access is missing.
  // Drives the bulk-grant button + the summary line. Computed on the
  // unfiltered list so a filter doesn't lie about how much work is
  // left.
  const gaps = useMemo(() => {
    const out: Array<{ item: MatrixItem; principal: MatrixPrincipal }> = [];
    for (const item of items) {
      for (const p of principals) {
        if (!hasAccess(item.id, p)) out.push({ item, principal: p });
      }
    }
    return out;
  }, [items, principals, hasAccess]);

  function cellKey(itemId: string, p: MatrixPrincipal): string {
    return `${itemId}|${p.type}:${p.id}`;
  }

  async function grantOne(item: MatrixItem, principal: MatrixPrincipal) {
    const key = cellKey(item.id, principal);
    setGrantingKey(key);
    setErrorByKey((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
    try {
      await onGrantItemAccess(item.id, principal);
    } catch (err) {
      setErrorByKey((prev) => ({
        ...prev,
        [key]: err instanceof Error ? err.message : 'Grant failed',
      }));
    } finally {
      setGrantingKey(null);
    }
  }

  async function grantAll() {
    if (gaps.length === 0) return;
    setBulkGranting(true);
    // Best-effort sequential apply: any single failure surfaces in
    // the per-cell error and the loop continues. Stopping on the
    // first error would leave the matrix half-fixed and confusing.
    for (const gap of gaps) {
      const key = cellKey(gap.item.id, gap.principal);
      try {
        await onGrantItemAccess(gap.item.id, gap.principal);
      } catch (err) {
        setErrorByKey((prev) => ({
          ...prev,
          [key]: err instanceof Error ? err.message : 'Grant failed',
        }));
      }
    }
    setBulkGranting(false);
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="flex max-h-[85vh] w-full max-w-5xl flex-col overflow-hidden rounded-lg bg-surface-1 shadow-raised">
        <div className="flex items-start justify-between gap-4 border-b border-border px-4 py-3">
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold text-ink-0">
              {title}
            </h2>
            <p className="text-xs text-muted">
              These items power this composite at runtime. Each sharee
              needs view access on every row, or they will see broken
              layers when they open it.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted hover:bg-surface-2"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-3 border-b border-border bg-surface-2 px-4 py-2">
          <label className="relative flex-1 min-w-[200px]">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" />
            <input
              type="text"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter dependency items..."
              className="h-7 w-full rounded border border-border bg-surface-1 pl-7 pr-2 text-xs focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
            />
          </label>
          <span className="text-xs text-muted">
            {items.length} item{items.length === 1 ? '' : 's'} ·{' '}
            {principals.length} sharee
            {principals.length === 1 ? '' : 's'}
          </span>
          {gaps.length > 0 && canManage ? (
            <button
              type="button"
              disabled={bulkGranting}
              onClick={() => void grantAll()}
              className="inline-flex h-7 items-center gap-1 rounded border border-amber-300 bg-amber-50 px-2 text-xs font-medium text-amber-900 hover:bg-amber-100 disabled:opacity-50"
            >
              {bulkGranting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <AlertTriangle className="h-3.5 w-3.5" />
              )}
              Grant {gaps.length} missing access
              {gaps.length === 1 ? '' : 'es'}
            </button>
          ) : gaps.length === 0 ? (
            <span className="inline-flex items-center gap-1 rounded border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-800">
              <ShieldCheck className="h-3.5 w-3.5" />
              No gaps
            </span>
          ) : null}
        </div>

        <div className="flex-1 overflow-auto">
          <table className="min-w-full border-collapse text-xs">
            <thead className="sticky top-0 z-10 bg-surface-2">
              <tr>
                <th className="border-b border-border px-3 py-2 text-left font-medium text-ink-0">
                  Item
                </th>
                {principals.map((p) => (
                  <th
                    key={`${p.type}:${p.id}`}
                    className="border-b border-l border-border px-3 py-2 text-center font-medium text-ink-0"
                  >
                    <div className="truncate" title={p.name}>
                      {p.name}
                    </div>
                    <div className="text-[10px] font-normal uppercase tracking-wide text-muted">
                      {p.type}
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr>
                  <td
                    colSpan={1 + principals.length}
                    className="px-3 py-6 text-center text-xs text-muted"
                  >
                    No items match the filter.
                  </td>
                </tr>
              ) : (
                filtered.map((item) => (
                  <tr key={item.id} className="border-b border-border">
                    <td className="px-3 py-2 align-top">
                      <div className="flex flex-col gap-0.5">
                        <span className="font-medium text-ink-1">
                          {item.title}
                        </span>
                        <span className="text-[10px] uppercase tracking-wide text-muted">
                          {getItemTypeLabel(item.type)}
                          {item.rationale ? ` · ${item.rationale}` : ''}
                        </span>
                      </div>
                    </td>
                    {principals.map((p) => {
                      const ok = hasAccess(item.id, p);
                      const key = cellKey(item.id, p);
                      const granting = grantingKey === key || bulkGranting;
                      const err = errorByKey[key];
                      return (
                        <td
                          key={key}
                          className="border-l border-border px-3 py-2 align-top"
                        >
                          <div className="flex flex-col items-center gap-1">
                            {ok ? (
                              <span
                                className="inline-flex items-center gap-1 text-emerald-700"
                                title={`${p.name} has view access`}
                              >
                                <Check className="h-3.5 w-3.5" />
                              </span>
                            ) : canManage ? (
                              <button
                                type="button"
                                onClick={() => void grantOne(item, p)}
                                disabled={granting}
                                className="inline-flex items-center gap-1 rounded border border-amber-300 bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-900 hover:bg-amber-100 disabled:opacity-50"
                                title={`Grant view to ${p.name}`}
                              >
                                {granting ? (
                                  <Loader2 className="h-3 w-3 animate-spin" />
                                ) : (
                                  <AlertTriangle className="h-3 w-3" />
                                )}
                                Grant view
                              </button>
                            ) : (
                              <span
                                className="inline-flex items-center gap-1 text-amber-700"
                                title={`${p.name} cannot see this item`}
                              >
                                <AlertTriangle className="h-3.5 w-3.5" />
                              </span>
                            )}
                            {err ? (
                              <span
                                className="text-[10px] text-danger"
                                role="alert"
                              >
                                {err}
                              </span>
                            ) : null}
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <div className="border-t border-border bg-surface-2 px-4 py-2 text-right">
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-7 items-center rounded border border-border bg-surface-1 px-3 text-xs font-medium text-ink-1 hover:bg-surface-2"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
