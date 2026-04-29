'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { FlaskConical, Layers, Search } from 'lucide-react';
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
  // Source layer picker state. We resolve the items list once on
  // mount and let the user filter inline; for orgs with hundreds of
  // data_layer items this should still feel snappy because the
  // existing list endpoint streams them in bulk.
  const [sources, setSources] = useState<Item[] | null>(null);
  const [sourceFilter, setSourceFilter] = useState('');
  const [sourceErr, setSourceErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/portal/items?type=data_layer')
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const body = (await r.json()) as { items?: Item[] } | Item[];
        const list = Array.isArray(body) ? body : (body.items ?? []);
        if (!cancelled) setSources(list);
      })
      .catch((err) => {
        if (!cancelled) {
          setSourceErr(
            err instanceof Error ? err.message : 'Could not load data layers',
          );
          setSources([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const visibleSources = useMemo(() => {
    if (!sources) return [];
    const q = sourceFilter.trim().toLowerCase();
    if (q.length === 0) return sources;
    return sources.filter(
      (s) =>
        s.title.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q),
    );
  }, [sources, sourceFilter]);

  // Buffer step is the only tool in v1, so we surface it directly
  // rather than via a "pick a tool" intermediate step. When more
  // tools land, this becomes a tool selector and per-tool form
  // fragments.
  const bufferStep = value.pipeline.find(
    (s): s is Extract<ToolStep, { tool: 'buffer' }> => s.tool === 'buffer',
  );
  const bufferDistance = bufferStep?.params.distance ?? 100;

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
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
          <input
            type="search"
            value={sourceFilter}
            onChange={(e) => setSourceFilter(e.target.value)}
            placeholder="Filter by title or description"
            className="h-10 w-full rounded-md border border-border bg-surface-0 pl-9 pr-3 text-sm text-ink-0 placeholder:text-muted focus:border-accent focus:outline-none"
          />
        </div>
        {sourceErr ? (
          <p className="text-xs text-danger">Could not load data layers: {sourceErr}</p>
        ) : null}
        {sources === null ? (
          <p className="text-xs text-muted">Loading data layers…</p>
        ) : visibleSources.length === 0 ? (
          <p className="text-xs text-muted">
            No data layers match the filter. Create one first under
            Data {'>'} Data layer, then come back here.
          </p>
        ) : (
          <ul
            role="radiogroup"
            aria-label="Source data layer"
            className="max-h-64 space-y-1 overflow-y-auto rounded-md border border-border bg-surface-0 p-1"
          >
            {visibleSources.map((s) => {
              const selected = value.source.itemId === s.id;
              return (
                <li key={s.id}>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    onClick={() => setSourceItem(s.id)}
                    className={`flex w-full items-start gap-3 rounded-md px-3 py-2 text-left text-sm hover:bg-surface-2 ${
                      selected
                        ? 'bg-accent/10 ring-1 ring-accent'
                        : ''
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
