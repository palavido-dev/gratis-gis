'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ChevronDown,
  FlaskConical,
  Layers,
  Search,
  X,
} from 'lucide-react';
import {
  DEFAULT_DERIVED_LAYER_FEATURE_LIMIT,
  MAX_BUFFER_DISTANCE_METERS,
  type DerivedLayerData,
  type Item,
  type ToolStep,
} from '@gratis-gis/shared-types';

/**
 * Inline builder for derived layers.
 *
 * The recipe (source data layer + ordered tool pipeline) is structural
 * to a derived layer's identity, so the wizard collects it up front
 * rather than starting with an empty scaffold the user fills in on
 * the detail page (the pattern data_layer / pick_list / geo_boundary
 * use). v1 ships one tool, buffer; this component renders a single
 * step UI and emits a one-element pipeline. When more tools land,
 * step ordering moves into the same component without restructuring
 * the wizard.
 *
 * The component emits a complete DerivedLayerData; the server
 * recomputes `outputSchema` and `bbox` regardless, so the values we
 * send for those are placeholders and can be empty arrays.
 */
export function DerivedLayerBuilder({
  value,
  onChange,
}: {
  value: DerivedLayerData;
  onChange: (next: DerivedLayerData) => void;
}) {
  // Buffer step is the only tool in v1, so we surface it directly
  // rather than via a "pick a tool" intermediate step. When more
  // tools land, this becomes a tool selector and per-tool form
  // fragments.
  //
  // Default buffer distance shown in the input on first render.
  // Pulled into a constant so the seed-on-mount effect below and
  // the input value derivation agree on the same number.
  const DEFAULT_BUFFER_DISTANCE = 100;
  const bufferStep = value.pipeline.find(
    (s): s is Extract<ToolStep, { tool: 'buffer' }> => s.tool === 'buffer',
  );
  const bufferDistance = bufferStep?.params.distance ?? DEFAULT_BUFFER_DISTANCE;

  // Seed the pipeline with a default buffer step the moment the
  // builder mounts. Without this, the input shows "100" via the
  // `?? DEFAULT_BUFFER_DISTANCE` fallback but `value.pipeline` stays
  // empty until the user edits the field, which causes the wizard's
  // "at least one step" guard to (correctly) reject the submit even
  // though the form looks filled in.
  useEffect(() => {
    if (value.pipeline.length === 0) {
      onChange({
        ...value,
        pipeline: [
          {
            tool: 'buffer',
            params: { distance: DEFAULT_BUFFER_DISTANCE, unit: 'meters' },
          },
        ],
      });
    }
    // We deliberately depend only on the pipeline length so this
    // effect doesn't re-fire on every keystroke that mutates
    // `value`. The intent is "ensure a step exists at startup or
    // after a reset"; per-keystroke mutations go through
    // `setBufferDistance` instead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value.pipeline.length]);

  const setSourceItem = useCallback(
    (id: string) => {
      onChange({
        ...value,
        source: { kind: 'data_layer', itemId: id },
      });
    },
    [value, onChange],
  );

  const setBufferDistance = useCallback(
    (distance: number) => {
      const safe =
        Number.isFinite(distance) && distance > 0
          ? Math.min(distance, MAX_BUFFER_DISTANCE_METERS)
          : 0;
      const next: ToolStep = {
        tool: 'buffer',
        params: { distance: safe, unit: 'meters' },
      };
      onChange({
        ...value,
        pipeline: [next],
      });
    },
    [value, onChange],
  );

  const setFeatureLimit = useCallback(
    (limit: number) => {
      const safe =
        Number.isFinite(limit) && limit > 0
          ? Math.floor(limit)
          : DEFAULT_DERIVED_LAYER_FEATURE_LIMIT;
      onChange({ ...value, featureLimit: safe });
    },
    [value, onChange],
  );

  return (
    <div className="space-y-6 rounded-lg border border-border bg-surface-1 p-4">
      <header className="flex items-start gap-3">
        <span className="mt-0.5 inline-flex h-8 w-8 items-center justify-center rounded-md bg-blue-700/90 text-white">
          <FlaskConical className="h-4 w-4" />
        </span>
        <div>
          <h3 className="text-sm font-medium text-ink-0">
            Recipe
          </h3>
          <p className="mt-1 text-xs text-muted">
            Pick a source data layer, then choose how to transform it.
            Results are computed live: when the source's features
            change, this layer reflects the change on the next read.
          </p>
        </div>
      </header>

      <section className="space-y-2">
        <h4 className="text-xs font-medium uppercase tracking-wide text-muted">
          Source layer
        </h4>
        <SourceLayerPicker
          selectedId={value.source.itemId}
          onSelect={setSourceItem}
        />
        <p className="text-[11px] text-muted">
          The list shows data layers you own and ones shared with you.
        </p>
      </section>

      <section className="space-y-2">
        <h4 className="text-xs font-medium uppercase tracking-wide text-muted">
          Tool: Buffer
        </h4>
        <p className="text-xs text-muted">
          Expand each feature outward by a fixed distance. The result
          is a polygon layer that lines up with the source's halo on
          every map read.
        </p>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-ink-1">Distance</span>
          <span className="flex items-center gap-2">
            <input
              type="number"
              min={1}
              max={MAX_BUFFER_DISTANCE_METERS}
              step={1}
              value={bufferDistance}
              onChange={(e) => setBufferDistance(Number(e.target.value))}
              className="h-10 w-32 rounded-md border border-border bg-surface-0 px-3 text-sm text-ink-0 focus:border-accent focus:outline-none"
            />
            <span className="text-sm text-muted">meters</span>
          </span>
        </label>
        <p className="text-[11px] text-muted">
          Up to {MAX_BUFFER_DISTANCE_METERS.toLocaleString()} m. Other
          units arrive when the reproject tool ships.
        </p>
      </section>

      <section className="space-y-2">
        <h4 className="text-xs font-medium uppercase tracking-wide text-muted">
          Feature limit (advanced)
        </h4>
        <p className="text-xs text-muted">
          Hard ceiling on features returned by a single read. The map
          UI passes its current view extent so this rarely bites
          on map workflows; it's the safety net for opening the
          layer with no map context.
        </p>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-ink-1">Maximum features per read</span>
          <input
            type="number"
            min={1}
            max={50000}
            step={1}
            value={value.featureLimit}
            onChange={(e) => setFeatureLimit(Number(e.target.value))}
            className="h-10 w-32 rounded-md border border-border bg-surface-0 px-3 text-sm text-ink-0 focus:border-accent focus:outline-none"
          />
        </label>
      </section>
    </div>
  );
}

/**
 * Combobox-style picker for a single data_layer Item.
 *
 * Closed state is a button showing the selected layer's title (or a
 * placeholder). Click opens a popover with a search input and the
 * filtered list of data layers visible to the caller. Search runs
 * server-side via `?q=` on the items list endpoint, debounced 200ms
 * so a rapid typist doesn't fire a request per keystroke. Click-
 * outside or Escape closes the popover; clicking a row selects and
 * closes.
 *
 * The fetch follows the same pattern as the map's add-layer dialog
 * (`?type=data_layer&lite=1`), which already returns items the
 * caller can see, so no extra "shared with me" filtering is needed
 * here. The list is sorted server-side by updatedAt desc so the
 * most-recently-touched layers float to the top.
 */
function SourceLayerPicker({
  selectedId,
  onSelect,
}: {
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Item[] | null>(null);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Cache the selected item separately so the trigger keeps showing
  // the right title even after the popover's list refetches with a
  // narrowed query that excludes it.
  const [cachedSelection, setCachedSelection] = useState<Item | null>(null);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  // Debounced server-side search. Aborts any in-flight request when
  // the query changes again so we don't hold a stale Prisma
  // connection on the API side.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const controller = new AbortController();
    setLoading(true);
    setErr(null);
    const handle = setTimeout(async () => {
      try {
        const qs = new URLSearchParams({ type: 'data_layer', lite: '1' });
        const q = query.trim();
        if (q) qs.set('q', q);
        const res = await fetch(`/api/portal/items?${qs}`, {
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as Item[] | { items?: Item[] };
        const list = Array.isArray(body) ? body : (body.items ?? []);
        if (!cancelled) setItems(list);
      } catch (e) {
        if ((e as Error)?.name === 'AbortError') return;
        if (!cancelled) {
          setErr(
            e instanceof Error ? e.message : 'Could not load data layers',
          );
          setItems([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(handle);
      controller.abort();
    };
  }, [open, query]);

  // Resolve the selected id to a full Item once on mount (and again
  // if the parent passes a new id we don't already have cached).
  // Avoids a "selected but trigger shows blank" gap when the picker
  // mounts with a value already set.
  useEffect(() => {
    if (!selectedId || cachedSelection?.id === selectedId) return;
    let cancelled = false;
    fetch(`/api/portal/items/${selectedId}?lite=1`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const body = (await r.json()) as Item;
        if (!cancelled) setCachedSelection(body);
      })
      .catch(() => {
        // Best-effort: leave the trigger showing the bare id if the
        // resolve fails. Probably means the item was deleted or
        // un-shared between save and re-render.
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId, cachedSelection?.id]);

  // Close on click outside.
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  // Focus the search input when the popover opens, so the user can
  // start typing immediately. Wrapped in rAF so the input has been
  // mounted before we try to focus it.
  useEffect(() => {
    if (!open) return;
    const id = requestAnimationFrame(() => searchInputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [open]);

  const handleSelect = useCallback(
    (item: Item) => {
      setCachedSelection(item);
      onSelect(item.id);
      setOpen(false);
      setQuery('');
    },
    [onSelect],
  );

  // Items currently visible in the popover. We let the server do the
  // search but ALSO drop the selected item from the list when there's
  // no query, so the popover doesn't waste a slot showing what's
  // already chosen. Selected item still appears when the user is
  // searching, so a typo recovery doesn't hide it.
  const visibleItems = useMemo(() => {
    if (!items) return null;
    if (!selectedId || query.trim().length > 0) return items;
    return items.filter((i) => i.id !== selectedId);
  }, [items, selectedId, query]);

  const triggerLabel =
    cachedSelection && cachedSelection.id === selectedId
      ? cachedSelection.title
      : selectedId
        ? '(Resolving selected layer…)'
        : 'Pick a source data layer…';

  const triggerSubtitle =
    cachedSelection && cachedSelection.id === selectedId
      ? cachedSelection.description
      : '';

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-start gap-3 rounded-md border border-border bg-surface-0 px-3 py-2 text-left hover:bg-surface-2 focus:border-accent focus:outline-none"
      >
        <Layers className="mt-0.5 h-4 w-4 shrink-0 text-sky-600" />
        <span className="min-w-0 flex-1">
          <span
            className={`block truncate text-sm font-medium ${
              selectedId ? 'text-ink-0' : 'text-muted'
            }`}
          >
            {triggerLabel}
          </span>
          {triggerSubtitle ? (
            <span className="mt-0.5 block truncate text-xs text-muted">
              {triggerSubtitle}
            </span>
          ) : null}
        </span>
        <ChevronDown
          className={`mt-1 h-4 w-4 shrink-0 text-muted transition-transform ${
            open ? 'rotate-180' : ''
          }`}
          aria-hidden="true"
        />
      </button>

      {open ? (
        <div
          role="listbox"
          aria-label="Data layers"
          className="absolute left-0 right-0 z-20 mt-1 overflow-hidden rounded-md border border-border bg-surface-0 shadow-lg"
        >
          <div className="relative border-b border-border p-2">
            <Search
              className="pointer-events-none absolute left-5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted"
              aria-hidden="true"
            />
            <input
              ref={searchInputRef}
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.preventDefault();
                  setOpen(false);
                }
              }}
              placeholder="Search data layers…"
              className="h-9 w-full rounded-md border border-border bg-surface-1 pl-9 pr-8 text-sm text-ink-0 placeholder:text-muted focus:border-accent focus:outline-none"
            />
            {query ? (
              <button
                type="button"
                onClick={() => setQuery('')}
                aria-label="Clear search"
                className="absolute right-4 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted hover:bg-surface-2"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            ) : null}
          </div>

          <div className="max-h-64 overflow-y-auto p-1">
            {err ? (
              <p className="px-3 py-2 text-xs text-danger">
                Could not load data layers: {err}
              </p>
            ) : loading && !visibleItems ? (
              <p className="px-3 py-2 text-xs text-muted">
                Loading data layers…
              </p>
            ) : !visibleItems || visibleItems.length === 0 ? (
              <p className="px-3 py-2 text-xs text-muted">
                {query
                  ? `No data layers match "${query}".`
                  : 'No data layers visible to you yet. Create one under Data > Data layer first.'}
              </p>
            ) : (
              <ul className="space-y-0.5">
                {visibleItems.map((s) => {
                  const selected = selectedId === s.id;
                  return (
                    <li key={s.id}>
                      <button
                        type="button"
                        role="option"
                        aria-selected={selected}
                        onClick={() => handleSelect(s)}
                        className={`flex w-full items-start gap-3 rounded-md px-3 py-2 text-left text-sm hover:bg-surface-2 ${
                          selected ? 'bg-accent/10 ring-1 ring-accent' : ''
                        }`}
                      >
                        <Layers className="mt-0.5 h-4 w-4 shrink-0 text-sky-600" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium text-ink-0">
                            {s.title}
                          </span>
                          {s.description ? (
                            <span className="mt-0.5 block truncate text-xs text-muted">
                              {s.description}
                            </span>
                          ) : null}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
