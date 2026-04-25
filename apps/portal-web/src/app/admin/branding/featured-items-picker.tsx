'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Loader2,
  Plus,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import type { ItemType } from '@gratis-gis/shared-types';
import { getItemTypeAccent, getItemTypeIcon } from '@/lib/item-type-icon';

/**
 * Admin control for picking + ordering the public items that the
 * landing page should feature. Replaces the raw "paste UUIDs"
 * textarea per the guided-before-raw-input design rule.
 *
 * Behaviour:
 *   - Load the org's public items once on mount and keep them in
 *     memory; the list isn't long enough to warrant server-side
 *     search for v1.
 *   - Current featured order is driven by `value`: the parent
 *     keeps the canonical state, we just emit onChange with the
 *     reordered / filtered id array.
 *   - An "Add featured item" dropdown shows every public item that
 *     isn't already featured, with a search box.
 *   - Featured rows render in priority order with up/down arrows
 *     and a remove button.
 */

interface ItemSummary {
  id: string;
  title: string;
  type: ItemType;
  access: 'private' | 'org' | 'public';
  updatedAt: string;
  thumbnailUrl: string | null;
}

interface Props {
  value: string[];
  onChange: (next: string[]) => void;
}

export function FeaturedItemsPicker({ value, onChange }: Props) {
  const [items, setItems] = useState<ItemSummary[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState('');

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setLoadError(null);
      try {
        // The server-side list endpoint filters by visibility, so
        // public items are the intersection of "listed to me" and
        // `access === 'public'`. We fetch the whole visible set and
        // narrow here: saves needing a new API for a single page.
        const res = await fetch('/api/portal/items');
        if (!res.ok) {
          setLoadError(`Could not load items: ${res.status}`);
          return;
        }
        const body = (await res.json()) as ItemSummary[];
        if (cancelled) return;
        const publics = body
          .filter((i) => i.access === 'public')
          .sort((a, b) => a.title.localeCompare(b.title));
        setItems(publics);
      } catch (e) {
        if (!cancelled)
          setLoadError(
            e instanceof Error ? e.message : 'Could not load items',
          );
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  // Map items by id once so the ordered render doesn't rescan the
  // list for each row.
  const itemsById = useMemo(() => {
    const m = new Map<string, ItemSummary>();
    for (const it of items ?? []) m.set(it.id, it);
    return m;
  }, [items]);

  // "Featured rows" are rendered in the exact order the parent
  // owns: we don't reorder by title / date here.
  const featuredRows = value.map((id) => ({
    id,
    item: itemsById.get(id),
  }));

  // "Adder candidates" = public items not already featured,
  // filtered by the search box.
  const candidates = useMemo(() => {
    if (!items) return [];
    const featured = new Set(value);
    const q = query.trim().toLowerCase();
    return items
      .filter((i) => !featured.has(i.id))
      .filter(
        (i) =>
          !q ||
          i.title.toLowerCase().includes(q) ||
          i.type.toLowerCase().includes(q),
      );
  }, [items, value, query]);

  const addId = useCallback(
    (id: string) => {
      if (value.includes(id)) return;
      onChange([...value, id]);
      setQuery('');
    },
    [value, onChange],
  );

  const removeId = useCallback(
    (id: string) => {
      onChange(value.filter((v) => v !== id));
    },
    [value, onChange],
  );

  const moveIdx = useCallback(
    (from: number, delta: number) => {
      const to = from + delta;
      if (to < 0 || to >= value.length) return;
      const next = value.slice();
      const [picked] = next.splice(from, 1);
      if (!picked) return;
      next.splice(to, 0, picked);
      onChange(next);
    },
    [value, onChange],
  );

  if (loading) {
    return (
      <div className="rounded-md border border-border bg-surface-0 p-3 text-xs text-muted">
        <Loader2 className="mr-1 inline h-3.5 w-3.5 animate-spin" />
        Loading your org's items…
      </div>
    );
  }
  if (loadError) {
    return (
      <div className="rounded-md border border-danger/30 bg-danger/5 p-3 text-xs text-danger">
        {loadError}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Featured list. Empty state spells out what'll happen. */}
      {featuredRows.length === 0 ? (
        <p className="rounded-md border border-dashed border-border bg-surface-0 px-3 py-4 text-center text-xs text-muted">
          No featured items. The landing page will show all public
          items in your org, newest first. Add items below to pin
          specific ones to the top in the order you want.
        </p>
      ) : (
        <ul className="space-y-1.5">
          {featuredRows.map((row, idx) => (
            <FeaturedRow
              key={row.id}
              position={idx + 1}
              total={featuredRows.length}
              id={row.id}
              item={row.item}
              onMoveUp={() => moveIdx(idx, -1)}
              onMoveDown={() => moveIdx(idx, +1)}
              onRemove={() => removeId(row.id)}
            />
          ))}
        </ul>
      )}

      {/* Adder: a popover-style panel. Shown as a collapsible
          chunk rather than a modal so the admin can see the
          already-featured list while picking. */}
      {adding ? (
        <Adder
          items={candidates}
          query={query}
          onQuery={setQuery}
          onPick={(id) => {
            addId(id);
            // Leave the adder open after a pick so an admin
            // adding 5 items in a row doesn't have to re-click
            // the Add button each time. Close via the X.
          }}
          onClose={() => {
            setAdding(false);
            setQuery('');
          }}
        />
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface-1 px-3 py-1.5 text-xs font-medium text-ink-1 hover:bg-surface-2"
        >
          <Plus className="h-3.5 w-3.5" />
          Add featured item
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------
// Row
// ---------------------------------------------------------------

function FeaturedRow({
  position,
  total,
  id,
  item,
  onMoveUp,
  onMoveDown,
  onRemove,
}: {
  position: number;
  total: number;
  id: string;
  item: ItemSummary | undefined;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onRemove: () => void;
}) {
  // Missing item means the id in `value` no longer matches a public
  // item: either the item's access was flipped, the item was
  // deleted, or it's in a different org. Show a soft-warning row
  // rather than silently dropping it, so the admin can clean up.
  if (!item) {
    return (
      <li className="flex items-center justify-between gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs">
        <span className="min-w-0 truncate text-amber-900">
          Unknown item{' '}
          <code className="font-mono">{id.slice(0, 8)}…</code>
          <span className="ml-2 text-amber-700">
            (not public any more? Deleted?)
          </span>
        </span>
        <button
          type="button"
          onClick={onRemove}
          className="inline-flex items-center gap-1 rounded border border-amber-400 bg-white px-2 py-0.5 text-[11px] text-amber-800 hover:bg-amber-100"
        >
          <Trash2 className="h-3 w-3" />
          Remove
        </button>
      </li>
    );
  }
  const Icon = getItemTypeIcon(item.type);
  const accent = getItemTypeAccent(item.type);
  return (
    <li className="flex items-center gap-2 rounded-md border border-border bg-surface-1 px-3 py-2">
      <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded bg-surface-2 text-[11px] font-semibold text-muted">
        {position}
      </span>
      <Icon className={`h-4 w-4 shrink-0 ${accent}`} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-ink-0">
          {item.title}
        </p>
        <p className="truncate text-[11px] text-muted">
          {prettyType(item.type)}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          onClick={onMoveUp}
          disabled={position === 1}
          className="inline-flex h-6 w-6 items-center justify-center rounded border border-border bg-surface-0 text-muted hover:bg-surface-2 hover:text-ink-1 disabled:opacity-40"
          title="Move up"
        >
          <ArrowUp className="h-3 w-3" />
        </button>
        <button
          type="button"
          onClick={onMoveDown}
          disabled={position === total}
          className="inline-flex h-6 w-6 items-center justify-center rounded border border-border bg-surface-0 text-muted hover:bg-surface-2 hover:text-ink-1 disabled:opacity-40"
          title="Move down"
        >
          <ArrowDown className="h-3 w-3" />
        </button>
        <button
          type="button"
          onClick={onRemove}
          className="inline-flex h-6 w-6 items-center justify-center rounded border border-border bg-surface-0 text-muted hover:bg-danger/10 hover:text-danger"
          title="Remove from featured"
        >
          <Trash2 className="h-3 w-3" />
        </button>
      </div>
    </li>
  );
}

// ---------------------------------------------------------------
// Adder panel
// ---------------------------------------------------------------

function Adder({
  items,
  query,
  onQuery,
  onPick,
  onClose,
}: {
  items: ItemSummary[];
  query: string;
  onQuery: (next: string) => void;
  onPick: (id: string) => void;
  onClose: () => void;
}) {
  return (
    <div className="rounded-md border border-border bg-surface-0 p-3">
      <header className="mb-2 flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-ink-0">
          Add a public item to the featured list
        </span>
        <button
          type="button"
          onClick={onClose}
          className="inline-flex h-5 w-5 items-center justify-center rounded border border-border bg-surface-1 text-muted hover:bg-surface-2 hover:text-ink-1"
        >
          <X className="h-3 w-3" />
        </button>
      </header>
      <div className="relative mb-2">
        <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" />
        <input
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          placeholder="Search public items…"
          className="w-full rounded border border-border bg-surface-1 py-1.5 pl-7 pr-2 text-xs"
          autoFocus
        />
      </div>
      {items.length === 0 ? (
        <p className="py-3 text-center text-xs text-muted">
          {query
            ? 'No public items match that search.'
            : 'No more public items to add.'}
        </p>
      ) : (
        <ul className="max-h-72 space-y-1 overflow-y-auto">
          {items.map((it) => {
            const Icon = getItemTypeIcon(it.type);
            const accent = getItemTypeAccent(it.type);
            return (
              <li key={it.id}>
                <button
                  type="button"
                  onClick={() => onPick(it.id)}
                  className="flex w-full items-center gap-2 rounded border border-transparent bg-surface-1 px-2 py-1.5 text-left text-xs hover:border-accent/50 hover:bg-surface-2"
                >
                  <Icon className={`h-4 w-4 shrink-0 ${accent}`} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium text-ink-0">
                      {it.title}
                    </p>
                    <p className="truncate text-[11px] text-muted">
                      {prettyType(it.type)}
                    </p>
                  </div>
                  <Plus className="h-3.5 w-3.5 shrink-0 text-muted" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function prettyType(t: ItemType): string {
  const labels: Partial<Record<ItemType, string>> = {
    map: 'Map',
    data_layer: 'Data layer',
    arcgis_service: 'ArcGIS service',
    form: 'Form',
    web_app: 'Web app',
    report_template: 'Report template',
    dashboard: 'Dashboard',
    file: 'File',
    notebook: 'Notebook',
    tool: 'Tool',
    pick_list: 'Pick list',
    geo_boundary: 'Boundary',
  };
  return labels[t] ?? t;
}
