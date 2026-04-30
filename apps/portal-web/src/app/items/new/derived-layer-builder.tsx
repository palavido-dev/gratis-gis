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
  Plus,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import {
  AREA_UNITS,
  AREA_UNIT_LABELS,
  DEFAULT_BUFFER_STEP,
  DEFAULT_DERIVED_LAYER_FEATURE_LIMIT,
  DEFAULT_STEPS,
  LENGTH_UNITS,
  MAX_BUFFER_DISTANCE_METERS,
  METERS_PER_UNIT,
  UNIT_LABELS,
  type AreaUnit,
  type BufferParams,
  type CalculateGeometryParams,
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
  // Seed the pipeline with a default buffer step on first mount when
  // it's empty. Mount-only (gated by a ref) so a user who later
  // removes every step doesn't see one re-appear -- removing the
  // last step is a deliberate intermediate state until they add a
  // fresh one via the picker. The wizard's submit-time validation
  // still rejects an empty pipeline, so a user can never save one.
  const seededRef = useRef(false);
  useEffect(() => {
    if (seededRef.current) return;
    seededRef.current = true;
    if (value.pipeline.length === 0) {
      onChange({
        ...value,
        pipeline: [DEFAULT_BUFFER_STEP],
      });
    }
    // Mount-only effect; deps intentionally empty.
  }, []);

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

  // Pipeline-level mutations. Each helper writes a fresh array back
  // into `value.pipeline` rather than mutating in place, so React's
  // reconciliation sees a new reference every change.
  const replaceStep = useCallback(
    (index: number, next: ToolStep) => {
      const pipeline = value.pipeline.map((s, i) => (i === index ? next : s));
      onChange({ ...value, pipeline });
    },
    [value, onChange],
  );

  const removeStep = useCallback(
    (index: number) => {
      const pipeline = value.pipeline.filter((_, i) => i !== index);
      onChange({ ...value, pipeline });
    },
    [value, onChange],
  );

  // Insert a fresh step at `index` (0 = before everything;
  // pipeline.length = at the end). The picker passes the tool kind;
  // we pull the corresponding default scaffold from shared-types so
  // every freshly-added step starts in a coherent state.
  const insertStepAt = useCallback(
    (index: number, kind: ToolStep['tool']) => {
      const fresh = DEFAULT_STEPS[kind];
      const pipeline = [
        ...value.pipeline.slice(0, index),
        fresh,
        ...value.pipeline.slice(index),
      ];
      onChange({ ...value, pipeline });
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

      <PipelineSection
        pipeline={value.pipeline}
        sourceFields={sourceFields}
        sourcePicked={Boolean(value.source.itemId)}
        onReplaceStep={replaceStep}
        onRemoveStep={removeStep}
        onInsertStep={insertStepAt}
      />

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

// ---------------------------------------------------------------------
// Pipeline UI: chained steps with add / remove / insert
// ---------------------------------------------------------------------

/**
 * Friendly label for each tool kind. Drives the step-card header and
 * the add-step picker. Kept as a flat record so adding a tool is a
 * one-line change here plus a new step editor below.
 */
const TOOL_LABELS: Record<ToolStep['tool'], string> = {
  buffer: 'Buffer',
  dissolve: 'Dissolve',
  centroid: 'Centroid',
  'convex-hull': 'Convex hull',
  bbox: 'Bounding box',
  simplify: 'Simplify',
  vertices: 'Vertices',
  densify: 'Densify',
  'top-n': 'Top N by attribute',
  'random-sample': 'Random sample',
  'nearest-neighbor': 'Nearest-neighbor distance',
  fishnet: 'Fishnet',
  'calculate-geometry': 'Calculate geometry',
};

const TOOL_DESCRIPTIONS: Record<ToolStep['tool'], string> = {
  buffer: 'Expand features outward into polygon halos.',
  dissolve: 'Merge every input geometry into a single feature.',
  centroid: 'Replace each feature with its center point.',
  'convex-hull': 'Replace each feature with its smallest enclosing convex polygon.',
  bbox: 'Replace each feature with its axis-aligned bounding rectangle.',
  simplify: 'Drop vertices closer than the given tolerance.',
  vertices: 'Explode each line / polygon into one point per vertex.',
  densify: 'Add intermediate vertices so no segment exceeds a length.',
  'top-n': 'Keep only the N highest or lowest values of a numeric field.',
  'random-sample': 'Keep a deterministic random subset of features.',
  'nearest-neighbor':
    'Add a numeric field with the distance to the closest other feature.',
  fishnet: 'Generate a grid of cells or transect lines over each polygon.',
  'calculate-geometry':
    'Add a length / perimeter / area field in your chosen unit.',
};

/**
 * Renders the pipeline as a vertical list of step cards. Between
 * each pair (and after the last, and before the first) sits an
 * "Add a step" button that opens a small picker showing every
 * available tool. Each card has a remove control. Step ordering is
 * positional: the output of step N is the input of step N+1, and
 * inserting a step in the middle is intentional, not a reorder
 * action.
 */
function PipelineSection({
  pipeline,
  sourceFields,
  sourcePicked,
  onReplaceStep,
  onRemoveStep,
  onInsertStep,
}: {
  pipeline: ToolStep[];
  sourceFields: FeatureField[];
  sourcePicked: boolean;
  onReplaceStep: (index: number, next: ToolStep) => void;
  onRemoveStep: (index: number) => void;
  onInsertStep: (index: number, kind: ToolStep['tool']) => void;
}) {
  return (
    <section className="space-y-2">
      <h4 className="text-xs font-medium uppercase tracking-wide text-muted">
        Pipeline
      </h4>
      <p className="text-xs text-muted">
        Each step takes the output of the one above it. The first step
        reads from the source layer; the last step's output is the
        derived layer's features.
      </p>

      <div className="space-y-2">
        {/* Insertion slot before everything: lets the user prepend
            a step without first having to add at the end and then
            reorder. */}
        <AddStepRow
          onPick={(kind) => onInsertStep(0, kind)}
          variant="slot"
        />

        {pipeline.map((step, idx) => (
          <div key={idx} className="space-y-2">
            <StepCard
              index={idx}
              step={step}
              sourceFields={sourceFields}
              sourcePicked={sourcePicked}
              onChange={(next) => onReplaceStep(idx, next)}
              onRemove={() => onRemoveStep(idx)}
            />
            {/* Insertion slot AFTER each step. The last one acts as
                the "Add a step" call to action at the bottom of the
                list, so we lift it to a primary visual when it's
                the last slot. */}
            <AddStepRow
              onPick={(kind) => onInsertStep(idx + 1, kind)}
              variant={idx === pipeline.length - 1 ? 'primary' : 'slot'}
            />
          </div>
        ))}

        {pipeline.length === 0 ? (
          <p className="text-[11px] text-muted">
            The pipeline is empty. Add at least one step before saving.
          </p>
        ) : null}
      </div>
    </section>
  );
}

/**
 * One step in the pipeline. Renders a numbered badge, the tool's
 * label, the per-tool editor, and a remove button. Per-tool editor
 * dispatch lives here so the parent doesn't have to know which
 * editor matches which kind.
 */
function StepCard({
  index,
  step,
  sourceFields,
  sourcePicked,
  onChange,
  onRemove,
}: {
  index: number;
  step: ToolStep;
  sourceFields: FeatureField[];
  sourcePicked: boolean;
  onChange: (next: ToolStep) => void;
  onRemove: () => void;
}) {
  return (
    <div className="rounded-md border border-border bg-surface-0 p-3">
      <header className="mb-2 flex items-start justify-between gap-2">
        <div className="flex items-start gap-2">
          <span className="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-blue-700/90 text-[11px] font-semibold text-white">
            {index + 1}
          </span>
          <div>
            <p className="text-sm font-medium text-ink-0">
              {TOOL_LABELS[step.tool] ?? step.tool}
            </p>
            <p className="text-[11px] text-muted">
              {TOOL_DESCRIPTIONS[step.tool] ?? ''}
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove step ${index + 1}`}
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-danger/10 hover:text-danger"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </header>

      {step.tool === 'buffer' ? (
        <BufferStepEditor
          params={step.params}
          onChange={(params) => onChange({ tool: 'buffer', params })}
          sourceFields={sourceFields}
          sourcePicked={sourcePicked}
        />
      ) : step.tool === 'dissolve' ? (
        <NoParamInfo body="Merges every feature into a single combined geometry. All attributes are dropped; downstream steps that need a specific column will fail validation if they sit after dissolve." />
      ) : step.tool === 'centroid' ? (
        <NoParamInfo body="Replaces each feature with its center point. Output is point geometry; attributes pass through." />
      ) : step.tool === 'convex-hull' ? (
        <NoParamInfo body="Replaces each feature with its convex hull (the smallest convex polygon enclosing it)." />
      ) : step.tool === 'bbox' ? (
        <NoParamInfo body="Replaces each feature with its axis-aligned bounding rectangle. Useful for extent-only views or spatial-bin clustering." />
      ) : step.tool === 'simplify' ? (
        <SimplifyStepEditor
          params={step.params}
          onChange={(params) => onChange({ tool: 'simplify', params })}
        />
      ) : step.tool === 'vertices' ? (
        <NoParamInfo body="Explodes each line or polygon into one point feature per vertex. Adds a vertex_index column. Source attributes pass through." />
      ) : step.tool === 'densify' ? (
        <DensifyStepEditor
          params={step.params}
          onChange={(params) => onChange({ tool: 'densify', params })}
        />
      ) : step.tool === 'top-n' ? (
        <TopNStepEditor
          params={step.params}
          onChange={(params) => onChange({ tool: 'top-n', params })}
          sourceFields={sourceFields}
          sourcePicked={sourcePicked}
        />
      ) : step.tool === 'random-sample' ? (
        <RandomSampleStepEditor
          params={step.params}
          onChange={(params) => onChange({ tool: 'random-sample', params })}
        />
      ) : step.tool === 'nearest-neighbor' ? (
        <NoParamInfo body="Adds a nearest_distance_m attribute to each feature: meters to its closest neighbor in this layer. Geometry passes through." />
      ) : step.tool === 'fishnet' ? (
        <FishnetStepEditor
          params={step.params}
          onChange={(params) => onChange({ tool: 'fishnet', params })}
        />
      ) : step.tool === 'calculate-geometry' ? (
        <CalculateGeometryStepEditor
          params={step.params}
          onChange={(params) =>
            onChange({ tool: 'calculate-geometry', params })
          }
        />
      ) : (
        // Forward-compat fallback for a tool kind a newer server
        // might emit that this client doesn't recognize. Surface
        // the raw kind so the user can still see the step exists.
        <p className="text-xs text-muted">
          Unknown tool kind {(step as { tool: string }).tool}; this
          client may be older than the server.
        </p>
      )}
    </div>
  );
}

/**
 * Inline insertion row. The "slot" variant is the small dashed-line
 * affordance between two cards; the "primary" variant is the
 * call-to-action button after the last step. Both open the same
 * picker; the variant is purely visual.
 */
function AddStepRow({
  onPick,
  variant,
}: {
  onPick: (kind: ToolStep['tool']) => void;
  variant: 'slot' | 'primary';
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Close on outside click. Same pattern the source picker uses;
  // each AddStepRow is independent so concurrent open states across
  // multiple slots don't collide.
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  const triggerClasses =
    variant === 'primary'
      ? 'inline-flex h-9 items-center gap-1 rounded-md border border-accent/40 bg-accent/5 px-3 text-xs font-medium text-accent hover:bg-accent/10'
      : 'inline-flex h-7 items-center gap-1 rounded-md border border-dashed border-border bg-transparent px-2 text-[11px] text-muted hover:border-accent/50 hover:text-ink-1';

  return (
    <div ref={containerRef} className="relative flex justify-center">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={triggerClasses}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <Plus className="h-3.5 w-3.5" />
        Add a step
      </button>
      {open ? (
        <div
          role="menu"
          className="absolute top-full z-20 mt-1 w-64 overflow-hidden rounded-md border border-border bg-surface-0 shadow-lg"
        >
          <ul className="p-1">
            {(Object.keys(TOOL_LABELS) as Array<ToolStep['tool']>).map((kind) => (
              <li key={kind}>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    onPick(kind);
                    setOpen(false);
                  }}
                  className="flex w-full flex-col items-start gap-0.5 rounded-md px-3 py-2 text-left text-sm hover:bg-surface-2"
                >
                  <span className="font-medium text-ink-0">
                    {TOOL_LABELS[kind]}
                  </span>
                  <span className="text-[11px] text-muted">
                    {TOOL_DESCRIPTIONS[kind]}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Self-contained editor for a buffer step's params. Owns the mode
 * toggle (Fixed / From a field), the unit dropdown, and the
 * mode-specific input (number for fixed, field combobox for
 * field). Emits a fresh BufferParams via `onChange` for every
 * change so the parent's pipeline state stays in sync.
 *
 * The editor also enforces the same client-side ceiling the
 * old single-step UI did: a fixed distance is clamped to
 * MAX_BUFFER_DISTANCE_METERS in the user's chosen unit, so a typed
 * "999 miles" can't bypass the cap.
 */
function BufferStepEditor({
  params,
  onChange,
  sourceFields,
  sourcePicked,
}: {
  params: BufferParams;
  onChange: (next: BufferParams) => void;
  sourceFields: FeatureField[];
  sourcePicked: boolean;
}) {
  const setMode = (mode: 'fixed' | 'field') => {
    if (mode === params.mode) return;
    if (mode === 'fixed') {
      onChange({ mode: 'fixed', distance: 100, unit: params.unit });
      return;
    }
    const firstNumeric = sourceFields.find((f) => f.type === 'number');
    onChange({
      mode: 'field',
      field: firstNumeric?.name ?? '',
      unit: params.unit,
      cachedMaxMeters: 0,
    });
  };

  const setUnit = (unit: LengthUnit) => {
    if (params.mode === 'fixed') {
      onChange({ mode: 'fixed', distance: params.distance, unit });
    } else {
      onChange({
        mode: 'field',
        field: params.field,
        unit,
        cachedMaxMeters: 0,
      });
    }
  };

  const setDistance = (raw: number) => {
    if (params.mode !== 'fixed') return;
    const meters = Number.isFinite(raw)
      ? raw * METERS_PER_UNIT[params.unit]
      : 0;
    const cappedMeters = Math.max(
      0,
      Math.min(meters, MAX_BUFFER_DISTANCE_METERS),
    );
    onChange({
      mode: 'fixed',
      distance: cappedMeters / METERS_PER_UNIT[params.unit],
      unit: params.unit,
    });
  };

  const setField = (field: string) => {
    if (params.mode !== 'field') return;
    onChange({
      mode: 'field',
      field,
      unit: params.unit,
      cachedMaxMeters: 0,
    });
  };

  return (
    <div className="space-y-2">
      <div
        className="grid grid-cols-2 gap-2"
        role="radiogroup"
        aria-label="Buffer distance source"
      >
        <button
          type="button"
          role="radio"
          aria-checked={params.mode === 'fixed'}
          onClick={() => setMode('fixed')}
          className={`flex flex-col items-start gap-0.5 rounded-md border p-2.5 text-left transition-colors ${
            params.mode === 'fixed'
              ? 'border-accent bg-accent/5 ring-2 ring-accent/30'
              : 'border-border bg-surface-1 hover:bg-surface-2'
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
          aria-checked={params.mode === 'field'}
          onClick={() => setMode('field')}
          disabled={!sourcePicked}
          title={
            !sourcePicked
              ? 'Pick a source layer first to see its numeric fields'
              : undefined
          }
          className={`flex flex-col items-start gap-0.5 rounded-md border p-2.5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
            params.mode === 'field'
              ? 'border-accent bg-accent/5 ring-2 ring-accent/30'
              : 'border-border bg-surface-1 hover:bg-surface-2'
          }`}
        >
          <span className="text-sm font-medium text-ink-1">From a field</span>
          <span className="text-[11px] text-muted">
            Read the distance from a numeric column on each row.
          </span>
        </button>
      </div>

      {params.mode === 'fixed' ? (
        <label className="flex flex-col gap-1 pt-1 text-sm">
          <span className="text-ink-1">Distance</span>
          <span className="flex items-center gap-2">
            <input
              type="number"
              min={0}
              step={1}
              value={Number.isFinite(params.distance) ? params.distance : 0}
              onChange={(e) => setDistance(Number(e.target.value))}
              className="h-10 w-32 rounded-md border border-border bg-surface-1 px-3 text-sm text-ink-0 focus:border-accent focus:outline-none"
            />
            <UnitSelect value={params.unit} onChange={setUnit} />
          </span>
          <span className="text-[11px] text-muted">
            Up to {MAX_BUFFER_DISTANCE_METERS.toLocaleString()} m. Try
            kilometers, feet, yards, or miles.
          </span>
        </label>
      ) : (
        <FieldModeControls
          sourceFields={sourceFields}
          field={params.field}
          unit={params.unit}
          onFieldChange={setField}
          onUnitChange={setUnit}
          sourcePicked={sourcePicked}
        />
      )}
    </div>
  );
}

/**
 * Reusable info-only step editor for tools that take no params.
 * Several tools (dissolve, centroid, convex-hull, bbox, vertices,
 * nearest-neighbor) fit this shape; rather than duplicating the
 * informational paragraph for each, the dispatch passes the
 * tool-specific copy in.
 */
function NoParamInfo({ body }: { body: string }) {
  return <p className="text-[11px] text-muted">{body}</p>;
}

/**
 * Tolerance editor shared by simplify and densify. Both take a
 * positive number plus a length unit, so the editor accepts a
 * label and value/unit setters from the parent.
 */
function ToleranceEditor({
  label,
  hint,
  value,
  unit,
  onValueChange,
  onUnitChange,
}: {
  label: string;
  hint?: string;
  value: number;
  unit: LengthUnit;
  onValueChange: (n: number) => void;
  onUnitChange: (u: LengthUnit) => void;
}) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-ink-1">{label}</span>
      <span className="flex items-center gap-2">
        <input
          type="number"
          min={0}
          step={1}
          value={Number.isFinite(value) ? value : 0}
          onChange={(e) => onValueChange(Number(e.target.value))}
          className="h-10 w-32 rounded-md border border-border bg-surface-1 px-3 text-sm text-ink-0 focus:border-accent focus:outline-none"
        />
        <UnitSelect value={unit} onChange={onUnitChange} />
      </span>
      {hint ? <span className="text-[11px] text-muted">{hint}</span> : null}
    </label>
  );
}

function SimplifyStepEditor({
  params,
  onChange,
}: {
  params: { tolerance: number; unit: LengthUnit };
  onChange: (next: { tolerance: number; unit: LengthUnit }) => void;
}) {
  return (
    <ToleranceEditor
      label="Tolerance"
      hint="Vertices closer than this distance are dropped. Higher = simpler shapes; smaller = closer to the original."
      value={params.tolerance}
      unit={params.unit}
      onValueChange={(tolerance) => onChange({ tolerance, unit: params.unit })}
      onUnitChange={(unit) => onChange({ tolerance: params.tolerance, unit })}
    />
  );
}

function DensifyStepEditor({
  params,
  onChange,
}: {
  params: { maxSegmentLength: number; unit: LengthUnit };
  onChange: (next: { maxSegmentLength: number; unit: LengthUnit }) => void;
}) {
  return (
    <ToleranceEditor
      label="Max segment length"
      hint="Adds intermediate vertices so no segment is longer than this."
      value={params.maxSegmentLength}
      unit={params.unit}
      onValueChange={(maxSegmentLength) =>
        onChange({ maxSegmentLength, unit: params.unit })
      }
      onUnitChange={(unit) =>
        onChange({ maxSegmentLength: params.maxSegmentLength, unit })
      }
    />
  );
}

function TopNStepEditor({
  params,
  onChange,
  sourceFields,
  sourcePicked,
}: {
  params: { field: string; n: number; direction: 'asc' | 'desc' };
  onChange: (next: {
    field: string;
    n: number;
    direction: 'asc' | 'desc';
  }) => void;
  sourceFields: FeatureField[];
  sourcePicked: boolean;
}) {
  const numericFields = sourceFields.filter((f) => f.type === 'number');
  return (
    <div className="space-y-2">
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-ink-1">Numeric field</span>
        <select
          value={params.field}
          onChange={(e) => onChange({ ...params, field: e.target.value })}
          disabled={!sourcePicked || numericFields.length === 0}
          className="h-10 rounded-md border border-border bg-surface-1 px-3 text-sm text-ink-0 focus:border-accent focus:outline-none disabled:opacity-60"
        >
          {params.field === '' ? (
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
        <span className="text-ink-1">Keep</span>
        <span className="flex items-center gap-2">
          <input
            type="number"
            min={1}
            step={1}
            value={Number.isFinite(params.n) ? params.n : 1}
            onChange={(e) =>
              onChange({ ...params, n: Math.max(1, Math.floor(Number(e.target.value))) })
            }
            className="h-10 w-24 rounded-md border border-border bg-surface-1 px-3 text-sm text-ink-0 focus:border-accent focus:outline-none"
          />
          <select
            value={params.direction}
            onChange={(e) =>
              onChange({
                ...params,
                direction: e.target.value === 'asc' ? 'asc' : 'desc',
              })
            }
            className="h-10 rounded-md border border-border bg-surface-1 px-2 text-sm text-ink-0 focus:border-accent focus:outline-none"
          >
            <option value="desc">highest</option>
            <option value="asc">lowest</option>
          </select>
        </span>
        <span className="text-[11px] text-muted">
          The N rows with the {params.direction === 'asc' ? 'lowest' : 'highest'}{' '}
          values of the chosen field. NULLs are dropped.
        </span>
      </label>
    </div>
  );
}

function RandomSampleStepEditor({
  params,
  onChange,
}: {
  params: { mode: 'percentage' | 'count'; value: number; seed: number };
  onChange: (next: {
    mode: 'percentage' | 'count';
    value: number;
    seed: number;
  }) => void;
}) {
  // Persist a stable seed once the user inserts the step. The
  // generator's validate() also subs a default for seed=0, so the
  // wizard never needs to ship a fresh random integer; preserving
  // whatever seed lands here keeps the sample stable across edits.
  const seed = params.seed || Math.floor(Math.random() * 2147483646) + 1;
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Sample mode">
        <button
          type="button"
          role="radio"
          aria-checked={params.mode === 'percentage'}
          onClick={() => onChange({ mode: 'percentage', value: 10, seed })}
          className={`flex flex-col items-start gap-0.5 rounded-md border p-2.5 text-left transition-colors ${
            params.mode === 'percentage'
              ? 'border-accent bg-accent/5 ring-2 ring-accent/30'
              : 'border-border bg-surface-1 hover:bg-surface-2'
          }`}
        >
          <span className="text-sm font-medium text-ink-1">Percentage</span>
          <span className="text-[11px] text-muted">Approximately N percent of rows.</span>
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={params.mode === 'count'}
          onClick={() => onChange({ mode: 'count', value: 100, seed })}
          className={`flex flex-col items-start gap-0.5 rounded-md border p-2.5 text-left transition-colors ${
            params.mode === 'count'
              ? 'border-accent bg-accent/5 ring-2 ring-accent/30'
              : 'border-border bg-surface-1 hover:bg-surface-2'
          }`}
        >
          <span className="text-sm font-medium text-ink-1">Exact count</span>
          <span className="text-[11px] text-muted">Exactly N rows.</span>
        </button>
      </div>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-ink-1">
          {params.mode === 'percentage' ? 'Percent' : 'Number of rows'}
        </span>
        <input
          type="number"
          min={1}
          max={params.mode === 'percentage' ? 100 : undefined}
          step={1}
          value={Number.isFinite(params.value) ? params.value : 1}
          onChange={(e) =>
            onChange({ ...params, value: Number(e.target.value), seed })
          }
          className="h-10 w-32 rounded-md border border-border bg-surface-1 px-3 text-sm text-ink-0 focus:border-accent focus:outline-none"
        />
        <span className="text-[11px] text-muted">
          Sample is deterministic given the seed below; same recipe = same
          rows on every read.
        </span>
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-ink-1">Seed</span>
        <span className="flex items-center gap-2">
          <input
            type="number"
            value={seed}
            onChange={(e) =>
              onChange({ ...params, seed: Number(e.target.value) || 1 })
            }
            className="h-10 w-32 rounded-md border border-border bg-surface-1 px-3 text-sm text-ink-0 focus:border-accent focus:outline-none"
          />
          <button
            type="button"
            onClick={() =>
              onChange({
                ...params,
                seed: Math.floor(Math.random() * 2147483646) + 1,
              })
            }
            className="h-10 rounded-md border border-border bg-surface-1 px-3 text-xs text-ink-1 hover:bg-surface-2"
          >
            Shuffle
          </button>
        </span>
      </label>
    </div>
  );
}

function FishnetStepEditor({
  params,
  onChange,
}: {
  params: { cellSize: number; unit: LengthUnit; output: 'polygons' | 'lines' };
  onChange: (next: {
    cellSize: number;
    unit: LengthUnit;
    output: 'polygons' | 'lines';
  }) => void;
}) {
  return (
    <div className="space-y-2">
      <ToleranceEditor
        label="Cell size"
        hint="Side length of each grid cell. Smaller = more cells = more compute."
        value={params.cellSize}
        unit={params.unit}
        onValueChange={(cellSize) => onChange({ ...params, cellSize })}
        onUnitChange={(unit) => onChange({ ...params, unit })}
      />
      <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Output mode">
        <button
          type="button"
          role="radio"
          aria-checked={params.output === 'polygons'}
          onClick={() => onChange({ ...params, output: 'polygons' })}
          className={`flex flex-col items-start gap-0.5 rounded-md border p-2.5 text-left transition-colors ${
            params.output === 'polygons'
              ? 'border-accent bg-accent/5 ring-2 ring-accent/30'
              : 'border-border bg-surface-1 hover:bg-surface-2'
          }`}
        >
          <span className="text-sm font-medium text-ink-1">Polygons</span>
          <span className="text-[11px] text-muted">Filled grid cells.</span>
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={params.output === 'lines'}
          onClick={() => onChange({ ...params, output: 'lines' })}
          className={`flex flex-col items-start gap-0.5 rounded-md border p-2.5 text-left transition-colors ${
            params.output === 'lines'
              ? 'border-accent bg-accent/5 ring-2 ring-accent/30'
              : 'border-border bg-surface-1 hover:bg-surface-2'
          }`}
        >
          <span className="text-sm font-medium text-ink-1">Lines</span>
          <span className="text-[11px] text-muted">Grid lines / transects only.</span>
        </button>
      </div>
      <p className="text-[11px] text-muted">
        Restricted to polygon input. Output drops source attributes; each
        cell carries cell_row and cell_col.
      </p>
    </div>
  );
}

function CalculateGeometryStepEditor({
  params,
  onChange,
}: {
  params: CalculateGeometryParams;
  onChange: (next: CalculateGeometryParams) => void;
}) {
  // Switching measurement re-keys the unit because length and area
  // use different unit unions. Persist the field name across
  // measurement changes so a user who picked a name doesn't have to
  // retype it after toggling.
  const setMeasurement = (m: 'length' | 'perimeter' | 'area') => {
    if (m === params.measurement) return;
    if (m === 'area') {
      onChange({
        measurement: 'area',
        unit: 'square-meters',
        fieldName: params.fieldName,
      });
    } else {
      onChange({
        measurement: m,
        unit: 'meters',
        fieldName: params.fieldName,
      });
    }
  };

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Measurement">
        {(['length', 'perimeter', 'area'] as const).map((m) => (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={params.measurement === m}
            onClick={() => setMeasurement(m)}
            className={`flex items-center justify-center rounded-md border p-2 text-sm capitalize transition-colors ${
              params.measurement === m
                ? 'border-accent bg-accent/5 ring-2 ring-accent/30 text-ink-0'
                : 'border-border bg-surface-1 text-ink-1 hover:bg-surface-2'
            }`}
          >
            {m}
          </button>
        ))}
      </div>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-ink-1">Unit</span>
        {params.measurement === 'area' ? (
          <select
            value={params.unit}
            onChange={(e) =>
              onChange({
                ...params,
                measurement: 'area',
                unit: e.target.value as AreaUnit,
              })
            }
            className="h-10 rounded-md border border-border bg-surface-1 px-3 text-sm text-ink-0 focus:border-accent focus:outline-none"
          >
            {AREA_UNITS.map((u) => (
              <option key={u} value={u}>
                {u} ({AREA_UNIT_LABELS[u]})
              </option>
            ))}
          </select>
        ) : (
          <UnitSelect
            value={params.unit}
            onChange={(unit) =>
              onChange({
                ...params,
                measurement: params.measurement,
                unit,
              })
            }
          />
        )}
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-ink-1">Field name</span>
        <input
          type="text"
          value={params.fieldName}
          onChange={(e) =>
            onChange({ ...params, fieldName: e.target.value } as CalculateGeometryParams)
          }
          maxLength={60}
          placeholder="e.g. area_ha, length_km"
          className="h-10 rounded-md border border-border bg-surface-1 px-3 text-sm text-ink-0 focus:border-accent focus:outline-none"
        />
        <span className="text-[11px] text-muted">
          Letters, numbers, and underscores. Cannot match an existing field
          on the source.
        </span>
      </label>
    </div>
  );
}
