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
  DEFAULT_BUFFER_STEP,
  DEFAULT_DERIVED_LAYER_FEATURE_LIMIT,
  LENGTH_UNITS,
  MAX_BUFFER_DISTANCE_METERS,
  METERS_PER_UNIT,
  UNIT_LABELS,
  type BufferParams,
  type DerivedLayerData,
  type FeatureField,
  type Item,
  type LengthUnit,
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
  const bufferStep = value.pipeline.find(
    (s): s is Extract<ToolStep, { tool: 'buffer' }> => s.tool === 'buffer',
  );
  const bufferParams: BufferParams =
    bufferStep?.params ?? DEFAULT_BUFFER_STEP.params;

  // Seed the pipeline with a default buffer step the moment the
  // builder mounts. Without this, the input shows "100" via the
  // default fallback but `value.pipeline` stays empty until the user
  // edits the field, which causes the wizard's "at least one step"
  // guard to (correctly) reject the submit even though the form
  // looks filled in.
  useEffect(() => {
    if (value.pipeline.length === 0) {
      onChange({
        ...value,
        pipeline: [DEFAULT_BUFFER_STEP],
      });
    }
    // We deliberately depend only on the pipeline length so this
    // effect doesn't re-fire on every keystroke that mutates
    // `value`. The intent is "ensure a step exists at startup or
    // after a reset"; per-keystroke mutations go through the
    // setBuffer* helpers instead.
  }, [value.pipeline.length]);

  const setSourceItem = useCallback(
    (ref: { itemId: string; layerKey?: string }) => {
      onChange({
        ...value,
        source: {
          kind: 'data_layer',
          itemId: ref.itemId,
          ...(ref.layerKey ? { layerKey: ref.layerKey } : {}),
        },
      });
    },
    [value, onChange],
  );

  // Lookup the source's schema once a source is selected, so the
  // field-mode picker can list numeric fields. Best-effort: if the
  // fetch fails, the field selector falls back to a "no fields
  // available" empty state and the user can switch to fixed mode.
  const [sourceFields, setSourceFields] = useState<FeatureField[]>([]);
  useEffect(() => {
    if (!value.source.itemId) {
      setSourceFields([]);
      return;
    }
    let cancelled = false;
    fetch(`/api/portal/items/${value.source.itemId}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<Item>;
      })
      .then((it) => {
        if (cancelled) return;
        setSourceFields(extractFields(it.data, value.source.layerKey));
      })
      .catch(() => {
        if (!cancelled) setSourceFields([]);
      });
    return () => {
      cancelled = true;
    };
  }, [value.source.itemId, value.source.layerKey]);

  // Helper: write a new buffer params object back into the recipe.
  // The pipeline is a one-element list in v1, so this is a single-
  // step replace; the call sites below pass the params they want
  // committed (post-clamping) and we wrap in the ToolStep envelope.
  const setBufferParams = useCallback(
    (params: BufferParams) => {
      onChange({
        ...value,
        pipeline: [{ tool: 'buffer', params }],
      });
    },
    [value, onChange],
  );

  const setBufferMode = useCallback(
    (mode: 'fixed' | 'field') => {
      if (mode === bufferParams.mode) return;
      // Preserve the unit across mode switches so a user who chose
      // "kilometers" doesn't have to re-pick when toggling to field
      // mode and back. Other fields reset to sensible defaults.
      if (mode === 'fixed') {
        setBufferParams({
          mode: 'fixed',
          distance: 100,
          unit: bufferParams.unit,
        });
      } else {
        // Pre-pick the first numeric field if one is available; the
        // user can change it. Without a default the picker shows a
        // placeholder until they make a choice.
        const firstNumeric = sourceFields.find((f) => f.type === 'number');
        setBufferParams({
          mode: 'field',
          field: firstNumeric?.name ?? '',
          unit: bufferParams.unit,
          // cachedMaxMeters is server-computed at save time; the
          // wizard always sends 0 and the API replaces it.
          cachedMaxMeters: 0,
        });
      }
    },
    [bufferParams, sourceFields, setBufferParams],
  );

  const setBufferDistance = useCallback(
    (distance: number) => {
      if (bufferParams.mode !== 'fixed') return;
      // Clamp the user-typed value to the meters ceiling, expressed
      // in the chosen unit. A user typing "999" with unit=miles
      // shouldn't sail past 100 km; converting to meters first keeps
      // the cap absolute.
      const meters = Number.isFinite(distance)
        ? distance * METERS_PER_UNIT[bufferParams.unit]
        : 0;
      const cappedMeters = Math.max(0, Math.min(meters, MAX_BUFFER_DISTANCE_METERS));
      const safe = cappedMeters / METERS_PER_UNIT[bufferParams.unit];
      setBufferParams({
        mode: 'fixed',
        distance: safe,
        unit: bufferParams.unit,
      });
    },
    [bufferParams, setBufferParams],
  );

  const setBufferUnit = useCallback(
    (unit: LengthUnit) => {
      if (bufferParams.mode === 'fixed') {
        setBufferParams({
          mode: 'fixed',
          distance: bufferParams.distance,
          unit,
        });
      } else {
        setBufferParams({
          mode: 'field',
          field: bufferParams.field,
          unit,
          cachedMaxMeters: 0,
        });
      }
    },
    [bufferParams, setBufferParams],
  );

  const setBufferField = useCallback(
    (field: string) => {
      if (bufferParams.mode !== 'field') return;
      setBufferParams({
        mode: 'field',
        field,
        unit: bufferParams.unit,
        cachedMaxMeters: 0,
      });
    },
    [bufferParams, setBufferParams],
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
          selectedRef={
            value.source.itemId
              ? {
                  itemId: value.source.itemId,
                  ...(value.source.layerKey
                    ? { layerKey: value.source.layerKey }
                    : {}),
                }
              : null
          }
          onSelect={setSourceItem}
        />
        <p className="text-[11px] text-muted">
          Lists data layers you own or have been shared with. v3
          multi-layer items expand to one row per spatial sublayer;
          v1 inline-GeoJSON layers are hidden because the buffer
          tool runs SQL against the source's feature table.
        </p>
      </section>

      <section className="space-y-2">
        <h4 className="text-xs font-medium uppercase tracking-wide text-muted">
          Tool: Buffer
        </h4>
        <p className="text-xs text-muted">
          Expand each feature outward into a polygon halo. Distance
          can be a fixed value applied to every feature, or read from
          a numeric field on each row so different features get
          different buffers.
        </p>
        <div
          className="grid grid-cols-2 gap-2"
          role="radiogroup"
          aria-label="Buffer distance source"
        >
          <button
            type="button"
            role="radio"
            aria-checked={bufferParams.mode === 'fixed'}
            onClick={() => setBufferMode('fixed')}
            className={`flex flex-col items-start gap-0.5 rounded-md border p-2.5 text-left transition-colors ${
              bufferParams.mode === 'fixed'
                ? 'border-accent bg-accent/5 ring-2 ring-accent/30'
                : 'border-border bg-surface-0 hover:bg-surface-2'
            }`}
          >
            <span className="text-sm font-medium text-ink-1">Fixed</span>
            <span className="text-[11px] text-muted">
              The same distance for every feature.
            </span>
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={bufferParams.mode === 'field'}
            onClick={() => setBufferMode('field')}
            disabled={!value.source.itemId}
            title={
              !value.source.itemId
                ? 'Pick a source layer first to see its numeric fields'
                : undefined
            }
            className={`flex flex-col items-start gap-0.5 rounded-md border p-2.5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
              bufferParams.mode === 'field'
                ? 'border-accent bg-accent/5 ring-2 ring-accent/30'
                : 'border-border bg-surface-0 hover:bg-surface-2'
            }`}
          >
            <span className="text-sm font-medium text-ink-1">From a field</span>
            <span className="text-[11px] text-muted">
              Read the distance from a numeric column on each row.
            </span>
          </button>
        </div>

        {bufferParams.mode === 'fixed' ? (
          <label className="flex flex-col gap-1 pt-1 text-sm">
            <span className="text-ink-1">Distance</span>
            <span className="flex items-center gap-2">
              <input
                type="number"
                min={0}
                step={1}
                value={
                  Number.isFinite(bufferParams.distance)
                    ? bufferParams.distance
                    : 0
                }
                onChange={(e) => setBufferDistance(Number(e.target.value))}
                className="h-10 w-32 rounded-md border border-border bg-surface-0 px-3 text-sm text-ink-0 focus:border-accent focus:outline-none"
              />
              <UnitSelect
                value={bufferParams.unit}
                onChange={setBufferUnit}
              />
            </span>
            <span className="text-[11px] text-muted">
              Up to {MAX_BUFFER_DISTANCE_METERS.toLocaleString()} m. Try
              kilometers, feet, yards, or miles.
            </span>
          </label>
        ) : (
          <FieldModeControls
            sourceFields={sourceFields}
            field={bufferParams.field}
            unit={bufferParams.unit}
            onFieldChange={setBufferField}
            onUnitChange={setBufferUnit}
            sourcePicked={Boolean(value.source.itemId)}
          />
        )}
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
/**
 * Compact descriptor of a row in the popover's list. v3 items
 * expand into one row per spatial sublayer; v2 items collapse to a
 * single row. The composite `key` is used as React key + selection
 * identity; downstream `onSelect` receives the full ref so the
 * parent can write { itemId, layerKey? } into the recipe.
 */
interface PickerRow {
  /** Unique within the rendered list. itemId for v2, itemId#layerKey for v3. */
  key: string;
  /** Backing item (carries title, description, etc.). */
  item: Item;
  /** Sublayer key when the row is a v3 sublayer; absent for v2. */
  layerKey?: string;
  /** Sublayer label when v3; for v2 the row uses item.title directly. */
  sublayerLabel?: string;
  /** Geometry type when v3; informational, not surfaced for v2. */
  geometryType?: string;
}

interface ItemWithLite extends Item {
  _storageType?: string;
  _layers?: Array<{ id: string; label: string; geometryType: string | null }>;
}

function SourceLayerPicker({
  selectedRef,
  onSelect,
}: {
  selectedRef: { itemId: string; layerKey?: string } | null;
  onSelect: (ref: { itemId: string; layerKey?: string }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<PickerRow[] | null>(null);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Count of data layers that exist for the user but are hidden
  // because they aren't v2 / v3 PostGIS-backed. Drives the footnote
  // in the empty / footer state so the user understands why a layer
  // they remember creating doesn't appear in the list.
  const [hiddenIncompatibleCount, setHiddenIncompatibleCount] = useState(0);

  // Cache the selected row separately so the trigger keeps showing
  // the right title even after the popover's list refetches with a
  // narrowed query that excludes it.
  const [cachedSelection, setCachedSelection] = useState<PickerRow | null>(
    null,
  );

  const containerRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  // Debounced server-side search. Aborts any in-flight request when
  // the query changes again so we don't hold a stale Prisma
  // connection on the API side.
  //
  // The list is filtered to PostGIS-backed data layers only. v1
  // inline-GeoJSON has no PostGIS table for buffer to query against
  // and selecting one would silently produce an empty result. The
  // server attaches `_storageType` and (for v3) `_layers` to lite-
  // mode data_layer rows so we can filter and flatten sublayers
  // without paying the full data-blob cost.
  //
  // After filtering by storage type, each item is flattened into one
  // PickerRow per spatial sublayer (for v3) or a single PickerRow
  // (for v2). Attribute-only "tables" inside v3 items are dropped
  // here because buffer needs geometry to operate on.
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
        const body = (await res.json()) as
          | ItemWithLite[]
          | { items?: ItemWithLite[] };
        const list = Array.isArray(body) ? body : (body.items ?? []);
        const compatible = list.filter(
          (i) => i._storageType === 'postgis',
        );
        const flattened: PickerRow[] = [];
        for (const item of compatible) {
          const layers = item._layers ?? [];
          // v3 = at least one declared layer; flatten spatial layers.
          // v2 = no _layers entry (or empty); single row for the
          // whole item.
          const spatial = layers.filter(
            (l) => typeof l.geometryType === 'string',
          );
          if (spatial.length > 0) {
            for (const l of spatial) {
              flattened.push({
                key: `${item.id}#${l.id}`,
                item,
                layerKey: l.id,
                sublayerLabel: l.label,
                ...(l.geometryType ? { geometryType: l.geometryType } : {}),
              });
            }
          } else {
            flattened.push({ key: item.id, item });
          }
        }
        if (!cancelled) {
          setRows(flattened);
          // Items with NO spatial sublayers (attribute-only v3 items
          // or v3 items still empty in the builder) effectively count
          // as incompatible from the user's POV. Track them in the
          // hidden count so the empty-state message is honest.
          const hiddenItems = list.length - compatible.length;
          const itemsWithNoSpatial = compatible.filter(
            (i) => !(i._layers ?? []).some(
              (l) => typeof l.geometryType === 'string',
            ),
          ).length;
          // Subtract v2 items (which don't have _layers but ARE
          // valid sources) so we don't count them as hidden.
          const v2Count = compatible.filter(
            (i) => (i._layers ?? []).length === 0,
          ).length;
          setHiddenIncompatibleCount(
            hiddenItems + Math.max(0, itemsWithNoSpatial - v2Count),
          );
        }
      } catch (e) {
        if ((e as Error)?.name === 'AbortError') return;
        if (!cancelled) {
          setErr(
            e instanceof Error ? e.message : 'Could not load data layers',
          );
          setRows([]);
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

  // Resolve the selected ref to a full PickerRow once on mount (and
  // again if the parent passes a new ref we don't already have
  // cached). Avoids a "selected but trigger shows blank" gap when
  // the picker mounts with a value already set.
  const selectedRefKey = selectedRef
    ? selectedRef.layerKey
      ? `${selectedRef.itemId}#${selectedRef.layerKey}`
      : selectedRef.itemId
    : null;
  useEffect(() => {
    if (!selectedRef || cachedSelection?.key === selectedRefKey) return;
    let cancelled = false;
    fetch(`/api/portal/items/${selectedRef.itemId}?lite=1`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const body = (await r.json()) as ItemWithLite;
        if (cancelled) return;
        // Locate the matching sublayer label when the ref points at
        // one; for v2 sources the sublayerLabel stays absent.
        const sub =
          selectedRef.layerKey && Array.isArray(body._layers)
            ? body._layers.find((l) => l.id === selectedRef.layerKey)
            : undefined;
        setCachedSelection({
          key: selectedRefKey ?? body.id,
          item: body,
          ...(selectedRef.layerKey ? { layerKey: selectedRef.layerKey } : {}),
          ...(sub?.label ? { sublayerLabel: sub.label } : {}),
          ...(typeof sub?.geometryType === 'string'
            ? { geometryType: sub.geometryType }
            : {}),
        });
      })
      .catch(() => {
        // Best-effort: leave the trigger showing the bare id if the
        // resolve fails. Probably means the item was deleted or
        // un-shared between save and re-render.
      });
    return () => {
      cancelled = true;
    };
  }, [selectedRef, selectedRefKey, cachedSelection?.key]);

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
    (row: PickerRow) => {
      setCachedSelection(row);
      onSelect({
        itemId: row.item.id,
        ...(row.layerKey ? { layerKey: row.layerKey } : {}),
      });
      setOpen(false);
      setQuery('');
    },
    [onSelect],
  );

  // Rows currently visible in the popover. We let the server do the
  // search but ALSO drop the selected row from the list when there's
  // no query, so the popover doesn't waste a slot showing what's
  // already chosen. The selected row still appears when the user is
  // searching, so a typo recovery doesn't hide it.
  const visibleRows = useMemo(() => {
    if (!rows) return null;
    if (!selectedRefKey || query.trim().length > 0) return rows;
    return rows.filter((r) => r.key !== selectedRefKey);
  }, [rows, selectedRefKey, query]);

  // Trigger text: prefer "Item title - Sublayer label" when a v3
  // sublayer is selected, fall back to the bare item title for v2.
  const triggerLabel = (() => {
    if (cachedSelection && cachedSelection.key === selectedRefKey) {
      const base = cachedSelection.item.title;
      return cachedSelection.sublayerLabel
        ? `${base} - ${cachedSelection.sublayerLabel}`
        : base;
    }
    if (selectedRefKey) return '(Resolving selected layer…)';
    return 'Pick a source data layer…';
  })();

  const triggerSubtitle =
    cachedSelection && cachedSelection.key === selectedRefKey
      ? cachedSelection.item.description
      : '';

  const triggerHasSelection = Boolean(selectedRefKey);

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
              triggerHasSelection ? 'text-ink-0' : 'text-muted'
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
            ) : loading && !visibleRows ? (
              <p className="px-3 py-2 text-xs text-muted">
                Loading data layers…
              </p>
            ) : !visibleRows || visibleRows.length === 0 ? (
              <div className="px-3 py-2 text-xs text-muted">
                <p>
                  {query
                    ? `No compatible data layers match "${query}".`
                    : 'No compatible data layers visible to you yet. Create one under Data > Data layer first.'}
                </p>
                {hiddenIncompatibleCount > 0 ? (
                  <p className="mt-1 text-[11px]">
                    {hiddenIncompatibleCount} layer
                    {hiddenIncompatibleCount === 1 ? ' is' : 's are'}{' '}
                    hidden because the buffer tool needs a PostGIS-backed
                    source with at least one spatial sublayer.
                  </p>
                ) : null}
              </div>
            ) : (
              <ul className="space-y-0.5">
                {visibleRows.map((row) => {
                  const selected = selectedRefKey === row.key;
                  // Headline shows the item title for v2 (one row per
                  // item) or "title - sublayer" for v3 sublayers, so a
                  // multi-layer item with several spatial sublayers
                  // reads cleanly down the list.
                  const headline = row.sublayerLabel
                    ? `${row.item.title} - ${row.sublayerLabel}`
                    : row.item.title;
                  return (
                    <li key={row.key}>
                      <button
                        type="button"
                        role="option"
                        aria-selected={selected}
                        onClick={() => handleSelect(row)}
                        className={`flex w-full items-start gap-3 rounded-md px-3 py-2 text-left text-sm hover:bg-surface-2 ${
                          selected ? 'bg-accent/10 ring-1 ring-accent' : ''
                        }`}
                      >
                        <Layers className="mt-0.5 h-4 w-4 shrink-0 text-sky-600" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium text-ink-0">
                            {headline}
                          </span>
                          {row.item.description ? (
                            <span className="mt-0.5 block truncate text-xs text-muted">
                              {row.item.description}
                            </span>
                          ) : null}
                        </span>
                        {row.geometryType ? (
                          <span className="ml-2 mt-0.5 shrink-0 rounded bg-sky-100 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-sky-800">
                            {row.geometryType}
                          </span>
                        ) : null}
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

/**
 * Lightweight `<select>` for picking a length unit. Pulls the option
 * list from `LENGTH_UNITS` (shared-types) so a new unit added there
 * shows up here automatically. Sized small enough to live inline next
 * to a numeric input without dominating the row.
 */
function UnitSelect({
  value,
  onChange,
}: {
  value: LengthUnit;
  onChange: (u: LengthUnit) => void;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as LengthUnit)}
      className="h-10 rounded-md border border-border bg-surface-0 px-2 text-sm text-ink-0 focus:border-accent focus:outline-none"
    >
      {LENGTH_UNITS.map((u) => (
        <option key={u} value={u}>
          {u} ({UNIT_LABELS[u]})
        </option>
      ))}
    </select>
  );
}

/**
 * Field-mode controls for the buffer step: a numeric-field picker
 * plus a unit dropdown. The picker is filtered to `type: 'number'`
 * fields off the source's schema; non-numeric fields are not eligible
 * because the SQL pipeline can't divide a string by a unit factor.
 *
 * The user is NOT asked for a maximum distance. The server queries
 * MAX(field) at recipe-save time and stamps `cachedMaxMeters` on the
 * recipe (see docs/derived-layers.md). That cap drives bbox padding
 * and per-row clamping in SQL.
 */
function FieldModeControls({
  sourceFields,
  field,
  unit,
  onFieldChange,
  onUnitChange,
  sourcePicked,
}: {
  sourceFields: FeatureField[];
  field: string;
  unit: LengthUnit;
  onFieldChange: (name: string) => void;
  onUnitChange: (u: LengthUnit) => void;
  sourcePicked: boolean;
}) {
  const numericFields = sourceFields.filter((f) => f.type === 'number');
  return (
    <div className="space-y-2 pt-1">
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-ink-1">Numeric field</span>
        <select
          value={field}
          onChange={(e) => onFieldChange(e.target.value)}
          disabled={!sourcePicked || numericFields.length === 0}
          className="h-10 rounded-md border border-border bg-surface-0 px-3 text-sm text-ink-0 focus:border-accent focus:outline-none disabled:opacity-60"
        >
          {field === '' ? (
            <option value="">
              {!sourcePicked
                ? 'Pick a source layer first'
                : numericFields.length === 0
                  ? 'No numeric fields on the source'
                  : 'Pick a numeric field…'}
            </option>
          ) : null}
          {numericFields.map((f) => (
            <option key={f.name} value={f.name}>
              {f.label || f.name}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-ink-1">Unit</span>
        <UnitSelect value={unit} onChange={onUnitChange} />
        <span className="text-[11px] text-muted">
          The field's stored value is interpreted in this unit. The
          server figures out the upper bound by reading the largest
          value when the recipe saves.
        </span>
      </label>

      {sourcePicked && numericFields.length === 0 ? (
        <p className="text-[11px] text-amber-700">
          The selected source has no numeric fields. Add a numeric
          column to the source layer or switch to fixed mode.
        </p>
      ) : null}
    </div>
  );
}

/**
 * Pull the FeatureField list from a data_layer item's `data` blob,
 * narrowing to the requested sublayer when one is given. Tolerant
 * of malformed shapes: returns `[]` for anything we don't recognize
 * so the field-mode picker degrades to "no fields available" rather
 * than crashing the wizard.
 */
function extractFields(data: unknown, layerKey: string | undefined): FeatureField[] {
  if (!data || typeof data !== 'object') return [];
  const d = data as { version?: unknown; layers?: unknown; fields?: unknown };
  if (Array.isArray(d.layers)) {
    const layers = d.layers as Array<{
      id?: string;
      fields?: FeatureField[];
    }>;
    if (layerKey) {
      const match = layers.find((l) => l.id === layerKey);
      return Array.isArray(match?.fields) ? match!.fields : [];
    }
    // No layerKey: a v3 source with exactly one spatial layer is the
    // common single-layer case; surface its fields. Otherwise we
    // can't pick on the user's behalf without ambiguity, so return
    // nothing.
    if (layers.length === 1 && Array.isArray(layers[0]?.fields)) {
      return layers[0]!.fields ?? [];
    }
    return [];
  }
  if (Array.isArray(d.fields)) {
    return d.fields as FeatureField[];
  }
  return [];
}
