'use client';

import { useEffect, useMemo, useState } from 'react';
import { Check, Loader2, Map as MapIcon, Search } from 'lucide-react';
import type { Item } from '@gratis-gis/shared-types';

/**
 * Inline picker for the wizard's data_collection step.
 *
 * mapId is structural for a data_collection (a deployment without a
 * map has nothing to deploy), so the wizard surfaces a one-step
 * picker that lists every `map` item the author can see. Form
 * bindings, offline configuration, and field-mode UI presets stay
 * additive on the detail page so the path from "I have a map" to
 * "I have a deployment" is exactly two clicks: pick a type, pick a
 * map. Field Maps' equivalent is similar but split across an
 * additional "share" step we don't need (sharing flows through the
 * standard item share grants).
 *
 * No fetch caching: the list is small in practice (org-scoped maps
 * typically <100) and the user lands here exactly once per create.
 */
export function DataCollectionBuilder({
  value,
  onChange,
}: {
  /** Current selection. null = nothing picked yet. */
  value: string | null;
  /** Called with the chosen map item id. */
  onChange: (mapId: string) => void;
}) {
  const [maps, setMaps] = useState<Item[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    void (async () => {
      try {
        const res = await fetch('/api/portal/items?type=map&lite=1', {
          signal: controller.signal,
        });
        if (!res.ok) {
          setError(`Could not load maps (${res.status}).`);
          return;
        }
        const rows = (await res.json()) as Item[];
        if (cancelled) return;
        rows.sort((a, b) => {
          const at = new Date(a.updatedAt ?? 0).getTime();
          const bt = new Date(b.updatedAt ?? 0).getTime();
          return bt - at;
        });
        setMaps(rows);
      } catch (err) {
        if ((err as Error)?.name === 'AbortError') return;
        setError(
          err instanceof Error
            ? err.message
            : 'Could not load maps.',
        );
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, []);

  // Trivial substring filter; case-insensitive over title +
  // description. The list is small enough that a debounce isn't
  // worth the complexity.
  const filtered = useMemo(() => {
    if (!maps) return null;
    const term = q.trim().toLowerCase();
    if (term.length === 0) return maps;
    return maps.filter((m) => {
      const t = (m.title ?? '').toLowerCase();
      const d = (m.description ?? '').toLowerCase();
      return t.includes(term) || d.includes(term);
    });
  }, [maps, q]);

  return (
    <section className="space-y-3 rounded-md border border-border bg-surface-1 p-4">
      <header className="flex items-center gap-2">
        <MapIcon className="h-4 w-4 text-accent" />
        <h2 className="text-sm font-semibold">Pick the map to deploy</h2>
      </header>
      <p className="text-xs text-muted">
        Field collectors see this map's editable layers. Tap a feature to
        edit it; tap empty space to add a new feature using a form drawn
        from the layer's schema (or a custom one you bind on the detail
        page later).
      </p>

      <label className="flex items-center gap-2 rounded-md border border-border bg-surface-0 px-2 focus-within:border-accent">
        <Search className="h-4 w-4 text-muted" />
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search maps in your organization..."
          className="h-9 flex-1 bg-transparent text-sm text-ink-0 outline-none placeholder:text-muted"
        />
      </label>

      {error ? (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      ) : null}

      {!maps ? (
        <div className="flex items-center gap-2 text-xs text-muted">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Loading maps...
        </div>
      ) : filtered && filtered.length === 0 ? (
        <p className="rounded-md border border-dashed border-border bg-surface-0 px-3 py-4 text-center text-xs text-muted">
          {q.trim().length > 0
            ? 'No maps match that search.'
            : "You don't have any maps yet. Create one first, then come back here."}
        </p>
      ) : (
        <ul className="max-h-72 divide-y divide-border overflow-y-auto rounded-md border border-border bg-surface-0">
          {(filtered ?? []).map((m) => {
            const picked = value === m.id;
            return (
              <li key={m.id}>
                <button
                  type="button"
                  onClick={() => onChange(m.id)}
                  className={`flex w-full items-start gap-3 px-3 py-2 text-left transition-colors hover:bg-surface-2 ${
                    picked ? 'bg-accent/10' : ''
                  }`}
                >
                  <span
                    className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded border ${
                      picked
                        ? 'border-accent bg-accent text-accent-foreground'
                        : 'border-border bg-surface-1'
                    }`}
                  >
                    {picked ? <Check className="h-3 w-3" /> : null}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-ink-0">
                      {m.title || 'Untitled map'}
                    </span>
                    {m.description ? (
                      <span className="mt-0.5 block truncate text-xs text-muted">
                        {m.description}
                      </span>
                    ) : null}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
