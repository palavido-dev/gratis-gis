'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Check,
  Eye,
  Link2,
  Loader2,
  Search,
  Users,
  X,
} from 'lucide-react';
import type {
  ItemShare,
  MapLayer,
  MapLayerAccess,
  MapLayerAccessEntry,
} from '@gratis-gis/shared-types';
import { DEFAULT_LAYER_ACCESS } from '@gratis-gis/shared-types';

/**
 * Principal surfaced in the matrix columns. Resolved by the parent
 * from whatever share records are on the item, with user/group names
 * looked up for display. Unresolved names fall back to the short id
 * so the matrix can still render during a lookup.
 */
export interface MatrixPrincipal {
  type: 'user' | 'group';
  id: string;
  name: string;
}

interface Props {
  open: boolean;
  layers: MapLayer[];
  principals: MatrixPrincipal[];
  /**
   * Per-layer map of backing item id (data_layer, arcgis_service).
   * Layers whose source isn't an item (geojson-url / geojson-inline)
   * map to null — those can't have item-level access gaps because
   * there's no separate item to share.
   */
  layerItemIds: Record<string, string | null>;
  /**
   * Current item-level shares keyed by item id. Matrix uses this to
   * detect "webmap shared, but underlying item isn't" gaps. Fetched
   * by the parent when the modal opens.
   */
  itemShares: Record<string, ItemShare[]>;
  /** Groups the current user can see; used to resolve group membership. */
  groupMemberships: Record<string, string[]>;
  onClose: () => void;
  /** Patch a single layer's `access` field; parent merges into its state. */
  onPatchAccess: (layerId: string, next: MapLayerAccess) => void;
  /**
   * Grant `view` permission on a backing item to a principal. Matrix
   * calls this for single-cell "fix it" actions and the bulk-grant
   * button at the top. Parent performs the POST to /items/:id/share
   * and refreshes the itemShares entry.
   */
  onGrantItemAccess: (
    itemId: string,
    principal: MatrixPrincipal,
  ) => Promise<void>;
}

/**
 * Per-layer access matrix modal for a web map.
 *
 * Two concerns stacked in one view:
 *   1. Webmap-scoped access — what each shared principal can see +
 *      do on this particular map (the View/Query/Edit matrix).
 *   2. Item-level sharing — whether the principal even has access to
 *      the backing feature / ArcGIS service. The matrix surfaces
 *      gaps here with a warning badge and a one-click "Grant view on
 *      this item" action, so authors don't have to hop between the
 *      map and each layer's item page to fix them. A top-level
 *      "Grant all missing" button does the whole set at once.
 *
 * Guard rail: item-level access is the security floor. The webmap
 * matrix can narrow access but can't widen it. Grant actions here
 * are the author explicitly widening the *item* access, not the
 * matrix silently bypassing it.
 */
export function AccessMatrix({
  open,
  layers,
  principals,
  layerItemIds,
  itemShares,
  groupMemberships,
  onClose,
  onPatchAccess,
  onGrantItemAccess,
}: Props) {
  const [filter, setFilter] = useState('');
  const [activePopover, setActivePopover] = useState<{
    layerId: string;
    principalKey: string;
  } | null>(null);
  const [grantingKey, setGrantingKey] = useState<string | null>(null);
  const [bulkGranting, setBulkGranting] = useState(false);

  useEffect(() => {
    if (!open) setActivePopover(null);
  }, [open]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return layers;
    return layers.filter((l) => l.title.toLowerCase().includes(q));
  }, [layers, filter]);

  // Enumerate every (layer, principal) pair where item access is
  // missing. Used both for the bulk-grant button and the summary
  // line above the matrix. Kept above the early return so hook
  // order stays stable across open/closed transitions of the modal.
  const gaps = useMemo(() => {
    const out: Array<{
      itemId: string;
      layer: MapLayer;
      principal: MatrixPrincipal;
    }> = [];
    const hasAccess = (itemId: string, p: MatrixPrincipal): boolean => {
      const shares = itemShares[itemId];
      if (!shares) return true;
      if (p.type === 'user') {
        if (
          shares.some(
            (s) => s.principalType === 'user' && s.principalId === p.id,
          )
        ) {
          return true;
        }
        const myGroups = groupMemberships[p.id] ?? [];
        for (const gid of myGroups) {
          if (
            shares.some(
              (s) => s.principalType === 'group' && s.principalId === gid,
            )
          ) {
            return true;
          }
        }
        return false;
      }
      return shares.some(
        (s) => s.principalType === 'group' && s.principalId === p.id,
      );
    };
    for (const layer of layers) {
      const itemId = layerItemIds[layer.id];
      if (!itemId) continue;
      for (const p of principals) {
        if (!hasAccess(itemId, p)) {
          out.push({ itemId, layer, principal: p });
        }
      }
    }
    return out;
  }, [layers, layerItemIds, itemShares, principals, groupMemberships]);

  if (!open) return null;

  const principalKey = (p: MatrixPrincipal) => `${p.type}:${p.id}`;

  /**
   * Can this layer be edited via the map's (yet-to-ship) feature
   * editing flow? Only data_layer layers have a writable backing
   * store the webmap can own — arcgis-rest points at a remote service
   * we don't control, geojson-url is read-only by definition, and
   * geojson-inline is baked into the webmap's own dataJson (not
   * per-feature editable). Exposing Edit for those three types in the
   * matrix is misleading, so the popover disables the toggle and the
   * badge never shows "+E" for non-editable layers.
   */
  function layerEditable(layer: MapLayer): boolean {
    return layer.source.kind === 'data-layer';
  }

  /**
   * Does this principal have at least view access to the given item?
   * A user matches by their own id; a group matches as itself; a user
   * also matches any group they belong to (via groupMemberships).
   */
  function principalHasItemAccess(
    itemId: string,
    p: MatrixPrincipal,
  ): boolean {
    const shares = itemShares[itemId];
    if (!shares) return true; // haven't loaded yet — don't warn prematurely
    if (p.type === 'user') {
      if (
        shares.some(
          (s) => s.principalType === 'user' && s.principalId === p.id,
        )
      ) {
        return true;
      }
      const myGroups = groupMemberships[p.id] ?? [];
      for (const gid of myGroups) {
        if (
          shares.some(
            (s) => s.principalType === 'group' && s.principalId === gid,
          )
        ) {
          return true;
        }
      }
      return false;
    }
    return shares.some(
      (s) => s.principalType === 'group' && s.principalId === p.id,
    );
  }

  function entryFor(
    layer: MapLayer,
    p: MatrixPrincipal,
  ): MapLayerAccessEntry {
    const acc = layer.access ?? DEFAULT_LAYER_ACCESS;
    const found = acc.entries.find(
      (e) => e.principalType === p.type && e.principalId === p.id,
    );
    if (found) return found;
    if (acc.policy === 'custom') {
      return {
        principalType: p.type,
        principalId: p.id,
        view: false,
        query: false,
        edit: false,
      };
    }
    return {
      principalType: p.type,
      principalId: p.id,
      view: true,
      query: true,
      edit: false,
    };
  }

  function writeEntry(
    layer: MapLayer,
    p: MatrixPrincipal,
    patch: Partial<MapLayerAccessEntry>,
  ) {
    const acc = layer.access ?? DEFAULT_LAYER_ACCESS;
    const next: MapLayerAccess = {
      policy: 'custom',
      entries: [...acc.entries],
    };
    const idx = next.entries.findIndex(
      (e) => e.principalType === p.type && e.principalId === p.id,
    );
    const current = entryFor(layer, p);
    const merged: MapLayerAccessEntry = { ...current, ...patch };
    // Clamp edit for non-editable layers so the stored matrix matches
    // what the UI offers. An author can't toggle Edit on for a layer
    // that has no editable backing store, and the server would ignore
    // the flag anyway; being strict here keeps persisted maps honest.
    if (!layerEditable(layer)) merged.edit = false;
    if (idx >= 0) next.entries[idx] = merged;
    else next.entries.push(merged);
    onPatchAccess(layer.id, next);
  }

  async function doGrant(itemId: string, p: MatrixPrincipal) {
    const key = `${itemId}:${principalKey(p)}`;
    setGrantingKey(key);
    try {
      await onGrantItemAccess(itemId, p);
    } finally {
      setGrantingKey(null);
    }
  }

  async function grantAllMissing() {
    if (gaps.length === 0) return;
    setBulkGranting(true);
    try {
      // De-dupe so we don't grant the same (item, principal) pair
      // twice when a principal is missing on multiple layers that
      // share a backing item.
      const seen = new Set<string>();
      for (const g of gaps) {
        const key = `${g.itemId}:${principalKey(g.principal)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        try {
          await onGrantItemAccess(g.itemId, g.principal);
        } catch {
          /* continue so one failure doesn't stall the batch */
        }
      }
    } finally {
      setBulkGranting(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Layer access matrix"
      className="fixed inset-0 z-30 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[92vh] w-full max-w-7xl flex-col overflow-hidden rounded-lg border border-border bg-surface-1 shadow-overlay"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div>
            <h2 className="text-base font-semibold">Layer access</h2>
            <p className="text-xs text-muted">
              Refine what each shared user or group sees on this map. The
              matrix narrows access; a warning badge appears when a principal
              has no item-level access to a layer&apos;s source data.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted hover:bg-surface-2"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex items-center gap-3 border-b border-border bg-surface-1 px-4 py-3">
          <label className="relative min-w-0 flex-1 max-w-xs">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" />
            <input
              type="text"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter layers..."
              className="h-8 w-full rounded-md border border-border bg-surface-1 pl-8 pr-3 text-sm focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
            />
          </label>
          <div className="text-xs text-muted">
            {filtered.length} layer{filtered.length === 1 ? '' : 's'} Ã—{' '}
            {principals.length} principal
            {principals.length === 1 ? '' : 's'}
          </div>
          {gaps.length > 0 ? (
            <button
              type="button"
              onClick={grantAllMissing}
              disabled={bulkGranting}
              className="ml-auto inline-flex h-8 items-center gap-1.5 rounded-md border border-warn bg-warn/10 px-3 text-xs font-medium text-warn hover:bg-warn/15 disabled:opacity-50"
              title="Add view-level shares on every backing item so the gaps below disappear"
            >
              {bulkGranting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <AlertTriangle className="h-3.5 w-3.5" />
              )}
              Grant missing item access ({gapSummary(gaps)})
            </button>
          ) : null}
        </div>

        <div className="flex-1 overflow-auto">
          {principals.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 py-12 text-sm text-muted">
              <Users className="h-6 w-6" />
              <p>Share the map with at least one user or group first.</p>
              <p className="text-xs">
                The matrix only shows principals that already have
                access to the webmap itself.
              </p>
            </div>
          ) : filtered.length === 0 ? (
            <div className="py-12 text-center text-sm text-muted">
              No layers match the filter.
            </div>
          ) : (
            <table className="w-full border-collapse text-sm">
              <thead className="sticky top-0 bg-surface-1">
                <tr>
                  <th className="sticky left-0 z-10 border-b border-r border-border bg-surface-1 px-3 py-2 text-left text-[11px] font-medium uppercase tracking-wide text-muted">
                    Layer
                  </th>
                  {principals.map((p) => (
                    <th
                      key={principalKey(p)}
                      className="border-b border-border px-2 py-2 text-center font-medium"
                    >
                      <div className="flex flex-col items-center gap-0.5">
                        <span className="text-xs text-ink-0">{p.name}</span>
                        <span className="text-[10px] text-muted">
                          {p.type}
                        </span>
                      </div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map((layer) => {
                  const itemId = layerItemIds[layer.id] ?? null;
                  return (
                    <tr key={layer.id} className="hover:bg-surface-2/60">
                      <td className="sticky left-0 z-[1] border-r border-b border-border bg-surface-1 px-3 py-2 text-left">
                        <div className="flex items-center gap-1.5">
                          <span className="truncate text-sm font-medium text-ink-0">
                            {layer.title}
                          </span>
                          {itemId ? (
                            <Link2 className="h-3 w-3 shrink-0 text-muted" />
                          ) : null}
                        </div>
                        <div className="text-[11px] text-muted">
                          {layer.access?.policy ?? 'inherit'}
                          {itemId ? null : ' · no backing item'}
                        </div>
                      </td>
                      {principals.map((p) => {
                        const key = principalKey(p);
                        const entry = entryFor(layer, p);
                        const hasItemAccess = itemId
                          ? principalHasItemAccess(itemId, p)
                          : true;
                        const isOpen =
                          activePopover?.layerId === layer.id &&
                          activePopover.principalKey === key;
                        const granting =
                          grantingKey ===
                          (itemId ? `${itemId}:${key}` : '');
                        return (
                          <td
                            key={key}
                            className="relative border-b border-border px-2 py-1 text-center"
                          >
                            <AccessBadge
                              entry={entry}
                              hasItemAccess={hasItemAccess}
                              editable={layerEditable(layer)}
                              onClick={() =>
                                setActivePopover(
                                  isOpen
                                    ? null
                                    : {
                                        layerId: layer.id,
                                        principalKey: key,
                                      },
                                )
                              }
                            />
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        <div className="flex items-center justify-between border-t border-border bg-surface-1 px-4 py-3 text-[11px] text-muted">
          <span>
            Access changes flow into the map&apos;s layers immediately.
            They persist with the next Save map.
          </span>
          <button
            type="button"
            onClick={onClose}
            className="h-8 rounded-md border border-border bg-surface-1 px-3 text-xs text-ink-1 hover:bg-surface-2"
          >
            Done
          </button>
        </div>
      </div>

      {/* Per-cell detail dialog. Rendered as a sibling of the main
          matrix (both sit on the same fixed backdrop) so it's never
          clipped by the matrix's scroll area — the bug where users
          had to scroll down to notice the popover. Stop-propagation
          on the inner card lets a backdrop click close just this
          dialog without collapsing the whole matrix. */}
      {activePopover
        ? (() => {
            const aLayer = layers.find(
              (l) => l.id === activePopover.layerId,
            );
            const aPrincipal = principals.find(
              (pp) => principalKey(pp) === activePopover.principalKey,
            );
            if (!aLayer || !aPrincipal) return null;
            const aItemId = layerItemIds[aLayer.id] ?? null;
            const aEntry = entryFor(aLayer, aPrincipal);
            const aHasItem = aItemId
              ? principalHasItemAccess(aItemId, aPrincipal)
              : true;
            const aGranting =
              grantingKey === (aItemId ? `${aItemId}:${activePopover.principalKey}` : '');
            return (
              <AccessDetailDialog
                layerTitle={aLayer.title}
                principalName={aPrincipal.name}
                principalType={aPrincipal.type}
                entry={aEntry}
                itemId={aItemId}
                hasItemAccess={aHasItem}
                editable={layerEditable(aLayer)}
                granting={aGranting}
                onChange={(patch) =>
                  writeEntry(aLayer, aPrincipal, patch)
                }
                onClose={() => setActivePopover(null)}
                {...(aItemId && !aHasItem
                  ? {
                      onGrant: () => {
                        void doGrant(aItemId, aPrincipal);
                      },
                    }
                  : {})}
              />
            );
          })()
        : null}
    </div>
  );
}

function gapSummary(
  gaps: Array<{ itemId: string; principal: MatrixPrincipal }>,
): string {
  const uniq = new Set(
    gaps.map((g) => `${g.itemId}:${g.principal.type}:${g.principal.id}`),
  );
  return `${uniq.size} gap${uniq.size === 1 ? '' : 's'}`;
}

/**
 * Compact one-cell summary. Warning triangle overlays the badge when
 * item-level access is missing for this (principal, layer), since
 * the webmap flags don't matter if the server will reject the user
 * at the item level anyway.
 */
function AccessBadge({
  entry,
  hasItemAccess,
  editable,
  onClick,
}: {
  entry: MapLayerAccessEntry;
  hasItemAccess: boolean;
  editable: boolean;
  onClick: () => void;
}) {
  const effective = {
    view: entry.view,
    query: entry.view && entry.query,
    // If the layer isn't editable, the "E" part of the badge would
    // be misleading — the flag has no runtime effect regardless of
    // what's stored in entry.edit.
    edit: editable && entry.view && entry.query && entry.edit,
  };
  const label = !effective.view
    ? '—'
    : effective.edit
      ? 'V+Q+E'
      : effective.query
        ? 'V+Q'
        : 'V';
  const tone = !effective.view
    ? 'bg-surface-2 text-muted border-border'
    : effective.edit
      ? 'bg-accent text-accent-foreground border-accent'
      : effective.query
        ? 'bg-accent/10 text-accent border-accent/40'
        : 'bg-surface-1 text-ink-0 border-border';
  return (
    <button
      type="button"
      onClick={onClick}
      className={`relative inline-flex h-7 min-w-[3.25rem] items-center justify-center gap-1 rounded-md border px-2 text-[11px] font-medium tabular-nums transition-colors hover:brightness-95 ${tone}`}
    >
      <Eye className="h-3 w-3 opacity-70" />
      {label}
      {!hasItemAccess ? (
        <span
          className="absolute -right-1 -top-1 inline-flex h-3.5 w-3.5 items-center justify-center rounded-full bg-warn text-[8px] font-bold text-white"
          title="No access to the backing item — grant from the popover"
        >
          !
        </span>
      ) : null}
    </button>
  );
}

/**
 * Per-cell detail dialog — the View/Query/Edit toggles plus the
 * item-level access status and Grant button. Rendered as a proper
 * centered modal (not an absolutely-positioned popover below the
 * cell) so nothing inside the matrix's scroll region can clip it.
 * Backdrop click and Esc both close; clicking the card itself
 * doesn't propagate so the matrix behind stays open.
 */
function AccessDetailDialog({
  layerTitle,
  principalName,
  principalType,
  entry,
  itemId,
  hasItemAccess,
  editable,
  granting,
  onChange,
  onGrant,
  onClose,
}: {
  layerTitle: string;
  principalName: string;
  principalType: 'user' | 'group';
  entry: MapLayerAccessEntry;
  itemId: string | null;
  hasItemAccess: boolean;
  editable: boolean;
  granting: boolean;
  onChange: (patch: Partial<MapLayerAccessEntry>) => void;
  onGrant?: () => void | Promise<void>;
  onClose: () => void;
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Access for ${principalName} on ${layerTitle}`}
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="flex w-full max-w-sm flex-col gap-3 rounded-lg border border-border bg-surface-1 p-4 shadow-overlay"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-xs uppercase tracking-wide text-muted">
              Layer access
            </div>
            <div className="mt-0.5 truncate text-sm font-semibold text-ink-0">
              {layerTitle}
            </div>
            <div className="text-xs text-muted">
              {principalType === 'group' ? 'Group' : 'User'} · {principalName}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted hover:bg-surface-2"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {itemId ? (
          <div
            className={`rounded-md px-3 py-2 text-xs ${
              hasItemAccess
                ? 'bg-success/10 text-success'
                : 'bg-warn/10 text-warn'
            }`}
          >
            {hasItemAccess ? (
              <span className="inline-flex items-center gap-1.5">
                <Check className="h-3.5 w-3.5" />
                Has item-level access to the backing item.
              </span>
            ) : (
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="inline-flex items-center gap-1.5 font-medium">
                    <AlertTriangle className="h-3.5 w-3.5" />
                    No item-level access
                  </div>
                  <div className="mt-0.5 text-[11px] opacity-80">
                    The matrix flags below won&apos;t take effect until
                    this principal is shared on the backing item.
                  </div>
                </div>
                {onGrant ? (
                  <button
                    type="button"
                    onClick={onGrant}
                    disabled={granting}
                    className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-warn bg-warn/10 px-2 text-[11px] font-medium text-warn hover:bg-warn/20 disabled:opacity-50"
                  >
                    {granting ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : null}
                    Grant view
                  </button>
                ) : null}
              </div>
            )}
          </div>
        ) : (
          <div className="rounded-md bg-surface-2 px-3 py-2 text-xs text-muted">
            No backing item — every principal with map access can see
            this layer.
          </div>
        )}

        <div className="space-y-1">
          <PopoverRow
            label="View"
            desc="See the layer on the map"
            checked={entry.view}
            onChange={(v) => onChange({ view: v })}
          />
          <PopoverRow
            label="Query"
            desc="Popups, attribute table, search"
            checked={entry.query}
            disabled={!entry.view}
            onChange={(v) => onChange({ query: v })}
          />
          <PopoverRow
            label="Edit"
            desc={
              editable
                ? 'Modify features (enables once editing UI ships)'
                : 'Not available — this layer has no writable source'
            }
            checked={editable && entry.edit}
            disabled={!editable || !entry.view || !entry.query}
            onChange={(v) => onChange({ edit: v })}
          />
          {!editable ? (
            <p className="px-1.5 text-[10px] text-muted">
              Edit is only available for feature-service layers. Remote
              sources (ArcGIS REST, URL, inline) stay read-only in the
              matrix to avoid offering permissions that can&apos;t
              take effect.
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function PopoverRow({
  label,
  desc,
  checked,
  disabled = false,
  onChange,
}: {
  label: string;
  desc: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label
      className={`flex cursor-pointer items-start gap-2 rounded px-1.5 py-1 ${
        disabled ? 'cursor-not-allowed opacity-50' : 'hover:bg-surface-2'
      }`}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 h-3.5 w-3.5 rounded border-border text-accent focus:ring-accent/30"
      />
      <div className="flex-1">
        <div className="text-xs font-medium text-ink-0">{label}</div>
        <div className="text-[10px] text-muted">{desc}</div>
      </div>
    </label>
  );
}

/**
 * Helper the map-editor uses to resolve shares â†’ named principals.
 * Falls back to a short id when the name lookup hasn't come back
 * yet so the matrix can render during fetch.
 */
export function unresolvedPrincipal(
  principalType: 'user' | 'group',
  principalId: string,
): MatrixPrincipal {
  return {
    type: principalType,
    id: principalId,
    name: `${principalType}/${principalId.slice(0, 8)}`,
  };
}
