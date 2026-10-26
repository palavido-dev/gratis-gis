// SPDX-License-Identifier: AGPL-3.0-or-later
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  AREA_UNITS,
  AREA_UNIT_LABELS,
  DEFAULT_BUFFER_STEP,
  DEFAULT_DERIVED_LAYER_FEATURE_LIMIT,
  DEFAULT_STEPS,
  ExpressionError,
  LENGTH_UNITS,
  MAX_BUFFER_DISTANCE_METERS,
  METERS_PER_UNIT,
  UNIT_LABELS,
  fieldRefTypeFor,
  parseExpression,
  validateExpression,
  type AreaUnit,
  type BufferParams,
  type CalculateGeometryParams,
  type DerivedLayerData,
  type FeatureField,
  type Item,
  type LengthUnit,
  type ToolStep,
} from '@gratis-gis/shared-types';
import { useFormat } from '@/lib/i18n/format';
import { useT } from '@/lib/i18n/locale-context';
import { useDerivedLayerCatalog } from './use-derived-layer-catalog';

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
  const t = useT();
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
    (ref: {
      kind: 'data_layer' | 'derived_layer';
      itemId: string;
      layerKey?: string;
    }) => {
      onChange({
        ...value,
        source: {
          kind: ref.kind,
          itemId: ref.itemId,
          // layerKey is meaningless for derived_layer sources (a
          // derived layer has a single output), so suppress it on
          // that path even if a stale value is sitting in state.
          ...(ref.kind === 'data_layer' && ref.layerKey
            ? { layerKey: ref.layerKey }
            : {}),
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
            {t('derivedLayerBuilder.recipeTitle')}
          </h3>
          <p className="mt-1 text-xs text-muted">
            {t('derivedLayerBuilder.recipeIntro')}
          </p>
        </div>
      </header>

      <section className="space-y-2">
        <h4 className="text-xs font-medium uppercase tracking-wide text-muted">
          {t('derivedLayerBuilder.sourceHeading')}
        </h4>
        <SourceLayerPicker
          selectedRef={
            value.source.itemId
              ? {
                  kind: value.source.kind,
                  itemId: value.source.itemId,
                  ...(value.source.layerKey
                    ? { layerKey: value.source.layerKey }
                    : {}),
                }
              : null
          }
          onSelect={setSourceItem}
        />
        <p className="text-2xs text-muted">
          {t('derivedLayerBuilder.sourceFootnote')}
        </p>
      </section>

      <PipelineSection
        pipeline={value.pipeline}
        source={value.source}
        sourceFields={sourceFields}
        sourcePicked={Boolean(value.source.itemId)}
        onReplaceStep={replaceStep}
        onRemoveStep={removeStep}
        onInsertStep={insertStepAt}
      />

      <section className="space-y-2">
        <h4 className="text-xs font-medium uppercase tracking-wide text-muted">
          {t('derivedLayerBuilder.featureLimitHeading')}
        </h4>
        <p className="text-xs text-muted">
          {t('derivedLayerBuilder.featureLimitIntro')}
        </p>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-ink-1">{t('derivedLayerBuilder.maxFeaturesPerRead')}</span>
          <input
            type="number"
            min={1}
            max={50000}
            step={1}
            value={value.featureLimit}
            onChange={(e) => setFeatureLimit(Number(e.target.value))}
            className="h-10 w-32 rounded-md border border-border bg-surface-0 px-3 text-sm text-ink-0 focus:border-accent focus:outline-hidden"
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
  /** Unique within the rendered list. itemId for v2 or derived_layer, itemId#layerKey for v3. */
  key: string;
  /** Backing item (carries title, description, etc.). */
  item: Item;
  /** What kind of source this row is (#78). */
  sourceKind: 'data_layer' | 'derived_layer';
  /** Sublayer key when the row is a v3 sublayer; absent for v2 / derived. */
  layerKey?: string;
  /** Sublayer label when v3; for v2 / derived the row uses item.title directly. */
  sublayerLabel?: string;
  /** Geometry type when v3; informational, not surfaced for v2 / derived. */
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
  selectedRef: {
    kind: 'data_layer' | 'derived_layer';
    itemId: string;
    layerKey?: string;
  } | null;
  onSelect: (ref: {
    kind: 'data_layer' | 'derived_layer';
    itemId: string;
    layerKey?: string;
  }) => void;
}) {
  const { t, toolLabels, toolDescriptions, toolGroups, noParamBodies } = useDerivedLayerCatalog();

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
        const q = query.trim();
        const qs1 = new URLSearchParams({ type: 'data_layer', lite: '1' });
        if (q) qs1.set('q', q);
        const qs2 = new URLSearchParams({ type: 'derived_layer', lite: '1' });
        if (q) qs2.set('q', q);
        // Two parallel fetches: the items endpoint accepts a single
        // `type` so we fan out to keep each response simple to parse.
        const [r1, r2] = await Promise.all([
          fetch(`/api/portal/items?${qs1}`, { signal: controller.signal }),
          fetch(`/api/portal/items?${qs2}`, { signal: controller.signal }),
        ]);
        if (!r1.ok) throw new Error(`HTTP ${r1.status} on data_layer fetch`);
        if (!r2.ok) throw new Error(`HTTP ${r2.status} on derived_layer fetch`);
        const dataLayerBody = (await r1.json()) as
          | ItemWithLite[]
          | { items?: ItemWithLite[] };
        const derivedLayerBody = (await r2.json()) as
          | ItemWithLite[]
          | { items?: ItemWithLite[] };
        const dataLayerList = Array.isArray(dataLayerBody)
          ? dataLayerBody
          : (dataLayerBody.items ?? []);
        const derivedLayerList = Array.isArray(derivedLayerBody)
          ? derivedLayerBody
          : (derivedLayerBody.items ?? []);
        const compatible = dataLayerList.filter(
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
                sourceKind: 'data_layer',
                layerKey: l.id,
                sublayerLabel: l.label,
                ...(l.geometryType ? { geometryType: l.geometryType } : {}),
              });
            }
          } else {
            flattened.push({ key: item.id, item, sourceKind: 'data_layer' });
          }
        }
        // Each derived_layer item is a single row (no sublayer
        // flattening; derived layers have one output).  #78 lets a
        // recipe consume another recipe's output as input.
        for (const item of derivedLayerList) {
          flattened.push({ key: item.id, item, sourceKind: 'derived_layer' });
        }
        if (!cancelled) {
          setRows(flattened);
          // Items with NO spatial sublayers (attribute-only v3 items
          // or v3 items still empty in the builder) effectively count
          // as incompatible from the user's POV. Track them in the
          // hidden count so the empty-state message is honest.
          const hiddenItems = dataLayerList.length - compatible.length;
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
          sourceKind: selectedRef.kind,
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
        kind: row.sourceKind,
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
    if (selectedRefKey) return t('derivedLayerBuilder.sourcePickerResolving');
    return t('derivedLayerBuilder.sourcePickerPlaceholder');
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
        className="flex w-full items-start gap-3 rounded-md border border-border bg-surface-0 px-3 py-2 text-left hover:bg-surface-2 focus:border-accent focus:outline-hidden"
      >
        <Layers className="mt-0.5 h-4 w-4 shrink-0 text-info" />
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
          aria-label={t('derivedLayerBuilder.sourcePickerListAria')}
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
              placeholder={t('derivedLayerBuilder.sourcePickerSearch')}
              className="h-9 w-full rounded-md border border-border bg-surface-1 pl-9 pr-8 text-sm text-ink-0 placeholder:text-muted focus:border-accent focus:outline-hidden"
            />
            {query ? (
              <button
                type="button"
                onClick={() => setQuery('')}
                aria-label={t('derivedLayerBuilder.clearSearchAria')}
                className="absolute right-4 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted hover:bg-surface-2"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            ) : null}
          </div>

          <div className="max-h-64 overflow-y-auto p-1">
            {err ? (
              <p className="px-3 py-2 text-xs text-danger">
                {t('derivedLayerBuilder.sourcePickerLoadFailed', { error: err })}
              </p>
            ) : loading && !visibleRows ? (
              <p className="px-3 py-2 text-xs text-muted">
                {t('derivedLayerBuilder.sourcePickerLoading')}
              </p>
            ) : !visibleRows || visibleRows.length === 0 ? (
              <div className="px-3 py-2 text-xs text-muted">
                <p>
                  {query
                    ? t('derivedLayerBuilder.sourcePickerNoMatch', { query })
                    : t('derivedLayerBuilder.sourcePickerNoQuery')}
                </p>
                {hiddenIncompatibleCount > 0 ? (
                  <p className="mt-1 text-2xs">
                    {t('derivedLayerBuilder.sourcePickerHidden', {
                      count: hiddenIncompatibleCount,
                    })}
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
                        <Layers
                          className={`mt-0.5 h-4 w-4 shrink-0 ${
                            row.sourceKind === 'derived_layer'
                              ? 'text-violet-600 dark:text-violet-400'
                              : 'text-info'
                          }`}
                        />
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
                        {row.sourceKind === 'derived_layer' ? (
                          // #78 -- mark chained derived sources so the
                          // user knows they're picking a recipe, not a
                          // raw layer.  Violet matches the FlaskConical
                          // recipe accent in the wizard header.
                          <span className="ml-2 mt-0.5 shrink-0 rounded bg-violet-100 dark:bg-violet-950 px-1.5 py-0.5 text-2xs uppercase tracking-wide text-violet-800 dark:text-violet-300">
                            {t('derivedLayerBuilder.badgeDerived')}
                          </span>
                        ) : row.geometryType ? (
                          <span className="ml-2 mt-0.5 shrink-0 rounded bg-info/15 px-1.5 py-0.5 text-2xs uppercase tracking-wide text-info">
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
      className="h-10 rounded-md border border-border bg-surface-0 px-2 text-sm text-ink-0 focus:border-accent focus:outline-hidden"
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
  const { t } = useDerivedLayerCatalog();

  const numericFields = sourceFields.filter((f) => f.type === 'number');
  return (
    <div className="space-y-2 pt-1">
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-ink-1">{t('derivedLayerBuilder.numericField')}</span>
        <select
          value={field}
          onChange={(e) => onFieldChange(e.target.value)}
          disabled={!sourcePicked || numericFields.length === 0}
          className="h-10 rounded-md border border-border bg-surface-0 px-3 text-sm text-ink-0 focus:border-accent focus:outline-hidden disabled:opacity-60"
        >
          {field === '' ? (
            <option value="">
              {!sourcePicked
                ? t('derivedLayerBuilder.pickSourceFirst')
                : numericFields.length === 0
                  ? t('derivedLayerBuilder.noNumericFields')
                  : t('derivedLayerBuilder.pickNumericField')}
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
        <span className="text-ink-1">{t('derivedLayerBuilder.unit')}</span>
        <UnitSelect value={unit} onChange={onUnitChange} />
        <span className="text-2xs text-muted">
{t('derivedLayerBuilder.fieldUnitHint')}
        </span>
      </label>

      {sourcePicked && numericFields.length === 0 ? (
        <p className="text-2xs text-warn">
{t('derivedLayerBuilder.noNumericFieldsWarn')}
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
  const d = data as {
    version?: unknown;
    layers?: unknown;
    fields?: unknown;
    outputSchema?: unknown;
  };
  // derived_layer items: schema lives at top-level `outputSchema`,
  // stamped on save by DerivedLayersService.validateAndEnrich.
  if (Array.isArray(d.outputSchema)) {
    return d.outputSchema as FeatureField[];
  }
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
  source,
  sourceFields,
  sourcePicked,
  onReplaceStep,
  onRemoveStep,
  onInsertStep,
}: {
  pipeline: ToolStep[];
  source: DerivedLayerData['source'];
  sourceFields: FeatureField[];
  sourcePicked: boolean;
  onReplaceStep: (index: number, next: ToolStep) => void;
  onRemoveStep: (index: number) => void;
  onInsertStep: (index: number, kind: ToolStep['tool']) => void;
}) {
  const { t, toolLabels, toolDescriptions, toolGroups, noParamBodies } = useDerivedLayerCatalog();

  // Toolbox modal state lives at the section level so a single modal
  // instance serves every "Add a step" affordance. `pickerSlotIndex`
  // is the pipeline index where the picked tool will be spliced in
  // when the user makes a selection; null means the modal is closed.
  const [pickerSlotIndex, setPickerSlotIndex] = useState<number | null>(null);
  return (
    <section className="space-y-2">
      <h4 className="text-xs font-medium uppercase tracking-wide text-muted">
        {t('derivedLayerBuilder.pipelineHeading')}
      </h4>
      <p className="text-xs text-muted">
        {t('derivedLayerBuilder.pipelineIntro')}
      </p>

      <div className="space-y-2">
        {/* Insertion slot before everything: lets the user prepend
            a step without first having to add at the end and then
            reorder. */}
        <AddStepRow
          onClick={() => setPickerSlotIndex(0)}
          variant="slot"
        />

        {pipeline.map((step, idx) => (
          <div key={idx} className="space-y-2">
            <StepCard
              index={idx}
              step={step}
              pipeline={pipeline}
              source={source}
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
              onClick={() => setPickerSlotIndex(idx + 1)}
              variant={idx === pipeline.length - 1 ? 'primary' : 'slot'}
            />
          </div>
        ))}

        {pipeline.length === 0 ? (
          <p className="text-2xs text-muted">
            {t('derivedLayerBuilder.pipelineEmpty')}
          </p>
        ) : null}
      </div>

      <ToolToolbox
        open={pickerSlotIndex !== null}
        onClose={() => setPickerSlotIndex(null)}
        onPick={(kind) => {
          if (pickerSlotIndex !== null) {
            onInsertStep(pickerSlotIndex, kind);
          }
          setPickerSlotIndex(null);
        }}
      />
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
  pipeline,
  source,
  sourceFields,
  sourcePicked,
  onChange,
  onRemove,
}: {
  index: number;
  step: ToolStep;
  pipeline: ToolStep[];
  source: DerivedLayerData['source'];
  sourceFields: FeatureField[];
  sourcePicked: boolean;
  onChange: (next: ToolStep) => void;
  onRemove: () => void;
}) {
  const { t, toolLabels, toolDescriptions, toolGroups, noParamBodies } = useDerivedLayerCatalog();

  return (
    <div className="rounded-md border border-border bg-surface-0 p-3">
      <header className="mb-2 flex items-start justify-between gap-2">
        <div className="flex items-start gap-2">
          <span className="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-blue-700/90 text-2xs font-semibold text-white">
            {index + 1}
          </span>
          <div>
            <p className="text-sm font-medium text-ink-0">
              {toolLabels[step.tool] ?? step.tool}
            </p>
            <p className="text-2xs text-muted">
              {toolDescriptions[step.tool] ?? ''}
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={onRemove}
          aria-label={t('derivedLayerBuilder.removeStepAria', { n: index + 1 })}
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
        <NoParamInfo body={noParamBodies.dissolve} />
      ) : step.tool === 'centroid' ? (
        <NoParamInfo body={noParamBodies.centroid} />
      ) : step.tool === 'convex-hull' ? (
        <NoParamInfo body={noParamBodies['convex-hull']} />
      ) : step.tool === 'bbox' ? (
        <NoParamInfo body={noParamBodies.bbox} />
      ) : step.tool === 'simplify' ? (
        <SimplifyStepEditor
          params={step.params}
          onChange={(params) => onChange({ tool: 'simplify', params })}
        />
      ) : step.tool === 'vertices' ? (
        <NoParamInfo body={noParamBodies.vertices} />
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
        <NoParamInfo body={noParamBodies['nearest-neighbor']} />
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
      ) : step.tool === 'filter' ? (
        <FilterStepEditor
          params={step.params}
          onChange={(params) => onChange({ tool: 'filter', params })}
          sourceFields={sourceFields}
        />
      ) : step.tool === 'calculate-field' ? (
        <CalculateFieldStepEditor
          params={step.params}
          onChange={(params) =>
            onChange({ tool: 'calculate-field', params })
          }
          sourceFields={sourceFields}
        />
      ) : step.tool === 'aggregate' ? (
        <AggregateStepEditor
          params={step.params}
          onChange={(params) => onChange({ tool: 'aggregate', params })}
          sourceFields={sourceFields}
        />
      ) : step.tool === 'spatial-join' ? (
        <SpatialJoinStepEditor
          params={step.params}
          onChange={(params) => onChange({ tool: 'spatial-join', params })}
        />
      ) : step.tool === 'spatial-filter' ? (
        <SpatialFilterStepEditor
          params={step.params}
          onChange={(params) => onChange({ tool: 'spatial-filter', params })}
        />
      ) : step.tool === 'clip' ? (
        <OtherLayerOnlyStepEditor
          params={step.params}
          onChange={(params) => onChange({ tool: 'clip', params })}
          label={t('derivedLayerBuilder.clipLabel')}
          hint={t('derivedLayerBuilder.clipHint')}
        />
      ) : step.tool === 'erase' ? (
        <OtherLayerOnlyStepEditor
          params={step.params}
          onChange={(params) => onChange({ tool: 'erase', params })}
          label={t('derivedLayerBuilder.eraseLabel')}
          hint={t('derivedLayerBuilder.eraseHint')}
        />
      ) : step.tool === 'contour' ? (
        <ContourStepEditor
          params={step.params}
          onChange={(params) => onChange({ tool: 'contour', params })}
          sourceFields={sourceFields}
        />
      ) : (
        // Forward-compat fallback for a tool kind a newer server
        // might emit that this client doesn't recognize. Surface
        // the raw kind so the user can still see the step exists.
        <p className="text-xs text-muted">
          {t('derivedLayerBuilder.unknownTool', {
            tool: (step as { tool: string }).tool,
          })}
        </p>
      )}

      {/* #81 -- per-step preview.  Renders below the step editor so
          authors can see what the step produces with the current
          source + draft pipeline.  Disabled until a source is
          picked; the picker enforces the same precondition for the
          editors above. */}
      <StepPreviewPanel
        index={index}
        pipeline={pipeline}
        source={source}
        disabled={!sourcePicked}
      />
    </div>
  );
}

/**
 * #81 per-step preview panel.  Lives inside StepCard so each card
 * has its own collapsed/expanded state and result cache.  Posts the
 * full draft pipeline to `/api/portal/items/derived-layer:preview`
 * with `upTo = index` so the server runs the recipe up to and
 * including the current step and returns a small sample.
 *
 * The fetch is on-demand (button click) rather than auto-running on
 * every keystroke so a malformed step doesn't fire a flood of 400s
 * against the API.  Results are cached until the user collapses the
 * panel or clicks Refresh.
 */
function StepPreviewPanel({
  index,
  pipeline,
  source,
  disabled,
}: {
  index: number;
  pipeline: ToolStep[];
  source: DerivedLayerData['source'];
  disabled: boolean;
}) {
  const { t } = useDerivedLayerCatalog();

  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // #86 -- optional "as of" timestamp.  YYYY-MM-DD from a native
  // <input type="date">; we extend to a full ISO at request time
  // so the source CTE's `valid_from <= $ts AND valid_to > $ts`
  // filter has a real timestamptz to compare against.
  const [asOfDate, setAsOfDate] = useState<string>('');
  const [result, setResult] = useState<{
    rowCount: number;
    truncated: boolean;
    sample: Array<{
      id: string | number | null;
      geometry: unknown;
      properties: Record<string, unknown>;
    }>;
    outputSchema: FeatureField[];
  } | null>(null);

  const runPreview = useCallback(async () => {
    if (disabled) return;
    setLoading(true);
    setErr(null);
    try {
      const atIso = asOfDate
        ? // Anchor the picked date at end-of-day local time so a
          // user who picks "March 5" sees what the data looked like
          // at the end of that day -- matches AGO's "as of date"
          // intuition.  Browser timezone is intentional.
          new Date(`${asOfDate}T23:59:59`).toISOString()
        : '';
      const res = await fetch('/api/portal/items/derived-layer:preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source,
          pipeline,
          upTo: index,
          limit: 10,
          ...(atIso ? { at: atIso } : {}),
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as
          | { message?: string }
          | null;
        throw new Error(
          body?.message ?? t('derivedLayerBuilder.previewFailedHttp', { status: res.status }),
        );
      }
      const body = (await res.json()) as typeof result;
      setResult(body);
    } catch (e) {
      setErr(e instanceof Error ? e.message : t('derivedLayerBuilder.previewFailed'));
      setResult(null);
    } finally {
      setLoading(false);
    }
  }, [disabled, source, pipeline, index, asOfDate]);

  // Column list for the preview table.  Sourced from the response so
  // it reflects the actual step output (calc-field / spatial-join /
  // aggregate all change the column set).
  const columns = result?.outputSchema ?? [];

  return (
    <div className="mt-2 border-t border-border/60 pt-2">
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => {
            const next = !open;
            setOpen(next);
            if (next && !result && !loading) {
              void runPreview();
            }
          }}
          disabled={disabled}
          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-2xs font-medium text-muted hover:bg-surface-1 hover:text-ink-1 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <ChevronDown
            className={`h-3 w-3 transition-transform ${open ? '' : '-rotate-90'}`}
          />
          {open ? t('derivedLayerBuilder.previewHide') : t('derivedLayerBuilder.previewShow')}
        </button>
        {open ? (
          <button
            type="button"
            onClick={() => void runPreview()}
            disabled={disabled || loading}
            className="text-2xs text-accent hover:underline disabled:opacity-50"
          >
            {loading ? t('derivedLayerBuilder.loading') : t('derivedLayerBuilder.refresh')}
          </button>
        ) : null}
      </div>
      {open ? (
        <div className="mt-2 space-y-2">
          {disabled ? (
            <p className="text-2xs text-muted">
              {t('derivedLayerBuilder.previewPickSource')}
            </p>
          ) : null}
          {!disabled ? (
            // #86 -- "as of" date picker.  Empty value means current
            // truth; a date asks the engine to run the recipe
            // against the source's bitemporal projection at the end
            // of the picked day.  Useful for "what did this look
            // like a month ago?" diff-against-now workflows.
            <label className="flex items-center gap-2 text-2xs text-muted">
              <span>{t('derivedLayerBuilder.asOf')}</span>
              <input
                type="date"
                value={asOfDate}
                onChange={(e) => setAsOfDate(e.target.value)}
                className="h-7 rounded-md border border-border bg-surface-0 px-2 text-2xs text-ink-0 focus:border-accent focus:outline-hidden"
              />
              {asOfDate ? (
                <button
                  type="button"
                  onClick={() => setAsOfDate('')}
                  className="text-accent hover:underline"
                >
                  {t('derivedLayerBuilder.clear')}
                </button>
              ) : (
                <span className="text-muted">
                  {t('derivedLayerBuilder.asOfBlank')}
                </span>
              )}
            </label>
          ) : null}
          {err ? (
            <p className="rounded-md bg-danger/10 px-2 py-1 text-2xs text-danger">
              {err}
            </p>
          ) : null}
          {loading && !result ? (
            <p className="text-2xs text-muted">{t('derivedLayerBuilder.previewRunning')}</p>
          ) : null}
          {result ? (
            <div className="space-y-1">
              <p className="text-2xs text-muted">
                {result.truncated
                  ? t('derivedLayerBuilder.previewTruncated', {
                      shown: result.sample.length,
                    })
                  : t('derivedLayerBuilder.previewRowCount', {
                      count: result.rowCount,
                    })}
              </p>
              {result.sample.length > 0 ? (
                <div className="overflow-x-auto rounded-md border border-border bg-surface-1">
                  <table className="min-w-full text-2xs">
                    <thead className="bg-surface-2 text-ink-1">
                      <tr>
                        {columns.map((c) => (
                          <th
                            key={c.name}
                            className="border-b border-border px-2 py-1 text-left font-medium"
                          >
                            {c.label || c.name}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {result.sample.map((row, i) => (
                        <tr
                          key={(row.id ?? i).toString()}
                          className="odd:bg-surface-1 even:bg-surface-0"
                        >
                          {columns.map((c) => (
                            <td
                              key={c.name}
                              className="border-b border-border/40 px-2 py-1 align-top text-ink-0"
                            >
                              {formatCell(row.properties?.[c.name])}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="text-2xs text-muted">
                  {t('derivedLayerBuilder.previewNoRows')}
                </p>
              )}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Render a single cell value as a compact string.  Numbers and
 * booleans stringify directly; objects (rare in user-facing
 * properties but possible from spatial-join's count attr) get
 * JSON-rendered; null / undefined render as a dash placeholder.
 */
function formatCell(v: unknown): string {
  if (v === null || v === undefined) return '-';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/**
 * Insertion-slot trigger between (or after) pipeline cards. The "slot"
 * variant is the small dashed-line affordance between two cards; the
 * "primary" variant is the call-to-action button after the last step.
 * Both trigger the same toolbox modal; the parent owns the modal
 * state so multiple slots share one modal instance.
 */
function AddStepRow({
  onClick,
  variant,
}: {
  onClick: () => void;
  variant: 'slot' | 'primary';
}) {
  const { t } = useDerivedLayerCatalog();

  const triggerClasses =
    variant === 'primary'
      ? 'inline-flex h-9 items-center gap-1 rounded-md border border-accent/40 bg-accent/5 px-3 text-xs font-medium text-accent hover:bg-accent/10'
      : 'inline-flex h-7 items-center gap-1 rounded-md border border-dashed border-border bg-transparent px-2 text-2xs text-muted hover:border-accent/50 hover:text-ink-1';

  return (
    <div className="flex justify-center">
      <button
        type="button"
        onClick={onClick}
        className={triggerClasses}
      >
        <Plus className="h-3.5 w-3.5" />
        {t('derivedLayerBuilder.addStep')}
      </button>
    </div>
  );
}

/**
 * Modal "toolbox" for picking a tool to splice into the pipeline.
 * Tools are organized into logical groups (see TOOL_GROUPS) so the
 * list stays scannable as more tools are added. A search field at
 * the top filters across all groups by name and description so a
 * user who knows what they want doesn't have to scroll.
 *
 * Keyboard:
 *   - Esc closes the modal
 *   - "/" anywhere inside the modal jumps focus to the search input
 *   - Tab / Shift-Tab walks through tool buttons in display order;
 *     Enter on a focused button selects (this is just standard
 *     button behavior, not custom)
 *
 * Click on the dimmed backdrop also dismisses; click on the inner
 * card stops propagation so the modal stays open.
 */
function ToolToolbox({
  open,
  onClose,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  onPick: (kind: ToolStep['tool']) => void;
}) {
  const { t, toolLabels, toolDescriptions, toolGroups } = useDerivedLayerCatalog();

  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement | null>(null);

  // Reset the search query and focus the search input when the modal
  // opens. Using rAF so the input has been mounted before focus().
  useEffect(() => {
    if (!open) return;
    setQuery('');
    const id = requestAnimationFrame(() => searchRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [open]);

  // "/" focuses the search bar while the modal is open (skipped when
  // the user is already typing in it so the slash isn't swallowed).
  // Escape is handled by the shared Dialog primitive.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === '/' && document.activeElement !== searchRef.current) {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  // Filter tool list by query against label / description / kind.
  // Empty query keeps every group; otherwise empty groups are
  // dropped from the rendered output entirely so a search like
  // "buffer" doesn't show empty Reshape / Filter / etc. headings.
  const q = query.trim().toLowerCase();
  const visibleGroups = toolGroups.map((g) => ({
    ...g,
    tools: g.tools.filter((kind) => {
      if (!q) return true;
      const haystack = [toolLabels[kind], toolDescriptions[kind], kind]
        .join(' ')
        .toLowerCase();
      return haystack.includes(q);
    }),
  })).filter((g) => g.tools.length > 0);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent
        size="lg"
        className="flex max-h-[85vh] !max-w-3xl flex-col overflow-hidden bg-surface-0 p-0 shadow-xl"
      >
        <header className="border-b border-border p-4 pr-12">
          <DialogTitle className="text-base font-semibold text-ink-0">
            {t('derivedLayerBuilder.toolboxTitle')}
          </DialogTitle>
          <DialogDescription className="mt-0.5 text-xs text-muted">
            {t('derivedLayerBuilder.toolboxDesc')}
          </DialogDescription>
          <div className="relative mt-3">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted"
              aria-hidden="true"
            />
            <input
              ref={searchRef}
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('derivedLayerBuilder.toolboxFilterPlaceholder')}
              className="h-10 w-full rounded-md border border-border bg-surface-1 pl-10 pr-3 text-sm text-ink-0 placeholder:text-muted focus:border-accent focus:outline-hidden"
            />
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {visibleGroups.length === 0 ? (
            <p className="text-center text-sm text-muted">
              {t('derivedLayerBuilder.noToolsMatch', { query })}
            </p>
          ) : (
            <div className="space-y-5">
              {visibleGroups.map((g) => (
                <section key={g.label}>
                  <h3 className="text-xs font-medium uppercase tracking-wide text-muted">
                    {g.label}
                  </h3>
                  <p className="mt-0.5 text-2xs text-muted">
                    {g.description}
                  </p>
                  <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                    {g.tools.map((kind) => (
                      <button
                        key={kind}
                        type="button"
                        onClick={() => onPick(kind)}
                        className="flex flex-col items-start gap-1 rounded-md border border-border bg-surface-1 p-3 text-left transition-colors hover:border-accent/50 hover:bg-surface-2 focus:border-accent focus:outline-hidden focus:ring-2 focus:ring-accent/30"
                      >
                        <span className="text-sm font-medium text-ink-0">
                          {toolLabels[kind]}
                        </span>
                        <span className="text-2xs text-muted">
                          {toolDescriptions[kind]}
                        </span>
                      </button>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Reusable data_layer picker for step editors that take an "other
 * source" parameter (spatial-join, spatial-filter, ...).  Combobox
 * over the user's accessible data_layer items + a free-text
 * sublayer-key input below it.  v3 data_layer items have multiple
 * sublayers and the sublayer key lives on the URL of the layer's
 * detail page; a real per-layer sublayer dropdown is a follow-up
 * once we expose layer schemas in the item-list payload.
 *
 * Fetches the list once on mount and caches it locally.  When a
 * widget references an itemId the user can't read (deleted or
 * sharing changed since the recipe was saved), it stays in the
 * select as "(unknown layer · <id-prefix>)" so editing doesn't
 * silently drop the binding.
 */
function DataLayerPicker({
  itemId,
  layerKey,
  onChange,
  label,
  hint,
}: {
  itemId: string;
  layerKey: string | undefined;
  onChange: (next: { itemId: string; layerKey?: string }) => void;
  label?: string;
  hint?: string;
}) {
  const { t } = useDerivedLayerCatalog();
  const resolvedLabel =
    label ?? t('derivedLayerBuilder.otherLayerDefault');

  const [available, setAvailable] = useState<
    Array<{ id: string; title: string }> | null
  >(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/portal/items?type=data_layer', {
          cache: 'no-store',
        });
        if (!res.ok) {
          if (!cancelled) setAvailable([]);
          return;
        }
        const rows = (await res.json()) as Array<{
          id: string;
          title: string;
        }>;
        if (!cancelled) {
          setAvailable(
            rows
              .map((r) => ({ id: r.id, title: r.title }))
              .sort((a, b) => a.title.localeCompare(b.title)),
          );
        }
      } catch {
        if (!cancelled) setAvailable([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const knownItem = available?.find((x) => x.id === itemId);

  return (
    <div className="space-y-2">
      <label className="flex flex-col gap-1">
        <span className="text-2xs uppercase tracking-wide text-muted">
          {resolvedLabel}
        </span>
        <select
          value={itemId}
          disabled={available === null}
          onChange={(e) =>
            onChange({
              itemId: e.target.value,
              ...(layerKey ? { layerKey } : {}),
            })
          }
          className="h-9 rounded-md border border-border bg-surface-1 px-3 text-xs focus:border-accent focus:outline-hidden"
        >
          {available === null ? (
            <option value="">{t('derivedLayerBuilder.loading')}</option>
          ) : (
            <>
              <option value="">{t('derivedLayerBuilder.pickDataLayer')}</option>
              {available.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.title}
                </option>
              ))}
              {itemId && !knownItem ? (
                <option value={itemId} key="__unknown">
                  {t('derivedLayerBuilder.unknownLayer', { id: itemId.slice(0, 8) })}
                </option>
              ) : null}
            </>
          )}
        </select>
        {hint ? (
          <span className="text-2xs text-muted">{hint}</span>
        ) : null}
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-2xs uppercase tracking-wide text-muted">
          {t('derivedLayerBuilder.sublayerKey')}
        </span>
        <input
          type="text"
          value={layerKey ?? ''}
          onChange={(e) => {
            const v = e.target.value.trim();
            onChange({ itemId, ...(v ? { layerKey: v } : {}) });
          }}
          placeholder={t('derivedLayerBuilder.sublayerPlaceholder')}
          className="h-9 rounded-md border border-border bg-surface-1 px-3 font-mono text-xs focus:border-accent focus:outline-hidden"
        />
        <span className="text-2xs text-muted">
          {t('derivedLayerBuilder.sublayerHint')}
        </span>
      </label>
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
  const { t } = useDerivedLayerCatalog();

  const fmt = useFormat();
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
        aria-label={t('derivedLayerBuilder.bufferDistanceAria')}
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
          <span className="text-sm font-medium text-ink-1">{t('derivedLayerBuilder.bufferFixed')}</span>
          <span className="text-2xs text-muted">
            {t('derivedLayerBuilder.bufferFixedHint')}
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
              ? t('derivedLayerBuilder.bufferPickSourceTitle')
              : undefined
          }
          className={`flex flex-col items-start gap-0.5 rounded-md border p-2.5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
            params.mode === 'field'
              ? 'border-accent bg-accent/5 ring-2 ring-accent/30'
              : 'border-border bg-surface-1 hover:bg-surface-2'
          }`}
        >
          <span className="text-sm font-medium text-ink-1">{t('derivedLayerBuilder.bufferFromField')}</span>
          <span className="text-2xs text-muted">
            {t('derivedLayerBuilder.bufferFromFieldHint')}
          </span>
        </button>
      </div>

      {params.mode === 'fixed' ? (
        <label className="flex flex-col gap-1 pt-1 text-sm">
          <span className="text-ink-1">{t('derivedLayerBuilder.distance')}</span>
          <span className="flex items-center gap-2">
            <input
              type="number"
              min={0}
              step={1}
              value={Number.isFinite(params.distance) ? params.distance : 0}
              onChange={(e) => setDistance(Number(e.target.value))}
              className="h-10 w-32 rounded-md border border-border bg-surface-1 px-3 text-sm text-ink-0 focus:border-accent focus:outline-hidden"
            />
            <UnitSelect value={params.unit} onChange={setUnit} />
          </span>
          <span className="text-2xs text-muted">
            {t('derivedLayerBuilder.bufferMaxHint', {
              max: fmt.number(MAX_BUFFER_DISTANCE_METERS),
            })}
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
  return <p className="text-2xs text-muted">{body}</p>;
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
          className="h-10 w-32 rounded-md border border-border bg-surface-1 px-3 text-sm text-ink-0 focus:border-accent focus:outline-hidden"
        />
        <UnitSelect value={unit} onChange={onUnitChange} />
      </span>
      {hint ? <span className="text-2xs text-muted">{hint}</span> : null}
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
  const { t } = useDerivedLayerCatalog();
  return (
    <ToleranceEditor
      label={t('derivedLayerBuilder.tolerance')}
      hint={t('derivedLayerBuilder.simplifyHint')}
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
  const { t } = useDerivedLayerCatalog();
  return (
    <ToleranceEditor
      label={t('derivedLayerBuilder.maxSegmentLength')}
      hint={t('derivedLayerBuilder.densifyHint')}
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
  const { t } = useDerivedLayerCatalog();

  const numericFields = sourceFields.filter((f) => f.type === 'number');
  return (
    <div className="space-y-2">
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-ink-1">Numeric field</span>
        <select
          value={params.field}
          onChange={(e) => onChange({ ...params, field: e.target.value })}
          disabled={!sourcePicked || numericFields.length === 0}
          className="h-10 rounded-md border border-border bg-surface-1 px-3 text-sm text-ink-0 focus:border-accent focus:outline-hidden disabled:opacity-60"
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
        <span className="text-ink-1">{t('derivedLayerBuilder.keep')}</span>
        <span className="flex items-center gap-2">
          <input
            type="number"
            min={1}
            step={1}
            value={Number.isFinite(params.n) ? params.n : 1}
            onChange={(e) =>
              onChange({ ...params, n: Math.max(1, Math.floor(Number(e.target.value))) })
            }
            className="h-10 w-24 rounded-md border border-border bg-surface-1 px-3 text-sm text-ink-0 focus:border-accent focus:outline-hidden"
          />
          <select
            value={params.direction}
            onChange={(e) =>
              onChange({
                ...params,
                direction: e.target.value === 'asc' ? 'asc' : 'desc',
              })
            }
            className="h-10 rounded-md border border-border bg-surface-1 px-2 text-sm text-ink-0 focus:border-accent focus:outline-hidden"
          >
            <option value="desc">{t('derivedLayerBuilder.highest')}</option>
            <option value="asc">{t('derivedLayerBuilder.lowest')}</option>
          </select>
        </span>
        <span className="text-2xs text-muted">
          {t('derivedLayerBuilder.topNHint', {
            direction:
              params.direction === 'asc'
                ? t('derivedLayerBuilder.lowest')
                : t('derivedLayerBuilder.highest'),
          })}
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
  const { t } = useDerivedLayerCatalog();

  // Persist a stable seed once the user inserts the step. The
  // generator's validate() also subs a default for seed=0, so the
  // wizard never needs to ship a fresh random integer; preserving
  // whatever seed lands here keeps the sample stable across edits.
  const seed = params.seed || Math.floor(Math.random() * 2147483646) + 1;
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label={t('derivedLayerBuilder.sampleModeAria')}>
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
          <span className="text-sm font-medium text-ink-1">{t('derivedLayerBuilder.percentage')}</span>
          <span className="text-2xs text-muted">{t('derivedLayerBuilder.percentageHint')}</span>
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
          <span className="text-sm font-medium text-ink-1">{t('derivedLayerBuilder.exactCount')}</span>
          <span className="text-2xs text-muted">{t('derivedLayerBuilder.exactCountHint')}</span>
        </button>
      </div>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-ink-1">
          {params.mode === 'percentage' ? t('derivedLayerBuilder.percent') : t('derivedLayerBuilder.numberOfRows')}
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
          className="h-10 w-32 rounded-md border border-border bg-surface-1 px-3 text-sm text-ink-0 focus:border-accent focus:outline-hidden"
        />
        <span className="text-2xs text-muted">
{t('derivedLayerBuilder.sampleSeedHint')}
        </span>
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-ink-1">{t('derivedLayerBuilder.seed')}</span>
        <span className="flex items-center gap-2">
          <input
            type="number"
            value={seed}
            onChange={(e) =>
              onChange({ ...params, seed: Number(e.target.value) || 1 })
            }
            className="h-10 w-32 rounded-md border border-border bg-surface-1 px-3 text-sm text-ink-0 focus:border-accent focus:outline-hidden"
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
            {t('derivedLayerBuilder.shuffle')}
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
  const { t } = useDerivedLayerCatalog();

  return (
    <div className="space-y-2">
      <ToleranceEditor
        label={t('derivedLayerBuilder.cellSize')}
        hint={t('derivedLayerBuilder.fishnetCellHint')}
        value={params.cellSize}
        unit={params.unit}
        onValueChange={(cellSize) => onChange({ ...params, cellSize })}
        onUnitChange={(unit) => onChange({ ...params, unit })}
      />
      <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label={t('derivedLayerBuilder.outputModeAria')}>
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
          <span className="text-sm font-medium text-ink-1">{t('derivedLayerBuilder.polygons')}</span>
          <span className="text-2xs text-muted">{t('derivedLayerBuilder.polygonsHint')}</span>
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
          <span className="text-sm font-medium text-ink-1">{t('derivedLayerBuilder.lines')}</span>
          <span className="text-2xs text-muted">{t('derivedLayerBuilder.linesHint')}</span>
        </button>
      </div>
      <p className="text-2xs text-muted">
{t('derivedLayerBuilder.fishnetFootnote')}
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
  const { t } = useDerivedLayerCatalog();

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
      <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label={t('derivedLayerBuilder.measurementAria')}>
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
            className="h-10 rounded-md border border-border bg-surface-1 px-3 text-sm text-ink-0 focus:border-accent focus:outline-hidden"
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
        <span className="text-ink-1">{t('derivedLayerBuilder.fieldName')}</span>
        <input
          type="text"
          value={params.fieldName}
          onChange={(e) =>
            onChange({ ...params, fieldName: e.target.value } as CalculateGeometryParams)
          }
          maxLength={60}
          placeholder={t('derivedLayerBuilder.calcGeomPlaceholder')}
          className="h-10 rounded-md border border-border bg-surface-1 px-3 text-sm text-ink-0 focus:border-accent focus:outline-hidden"
        />
        <span className="text-2xs text-muted">
{t('derivedLayerBuilder.calcGeomNameHint')}
        </span>
      </label>
    </div>
  );
}

/**
 * Filter step editor (#76).  Renders a chip strip of upstream
 * fields the author can click to insert as {{name}} references,
 * plus an expression textarea.  The shared expression engine
 * validates the typed expression in real time and surfaces parse /
 * schema errors below the textarea so the author can correct them
 * before saving.
 */
function FilterStepEditor({
  params,
  onChange,
  sourceFields,
}: {
  params: { expression: string };
  onChange: (next: { expression: string }) => void;
  sourceFields: FeatureField[];
}) {
  const { t } = useDerivedLayerCatalog();

  return (
    <ExpressionEditor
      label={t('derivedLayerBuilder.predicate')}
      hint={t('derivedLayerBuilder.filterHint')}
      value={params.expression}
      onChange={(expression) => onChange({ expression })}
      sourceFields={sourceFields}
      resultMode="boolean"
    />
  );
}

/**
 * Calculate-field step editor (#77).  Same expression editor as
 * filter plus an output-name + output-type pair so the new column
 * is named + typed correctly.
 */
function CalculateFieldStepEditor({
  params,
  onChange,
  sourceFields,
}: {
  params: { outputName: string; outputType: 'number' | 'string' | 'boolean'; expression: string };
  onChange: (next: {
    outputName: string;
    outputType: 'number' | 'string' | 'boolean';
    expression: string;
  }) => void;
  sourceFields: FeatureField[];
}) {
  const { t } = useDerivedLayerCatalog();

  return (
    <div className="space-y-3">
      <div className="grid gap-2 sm:grid-cols-[1fr_140px]">
        <label className="flex flex-col gap-1">
          <span className="text-2xs uppercase tracking-wide text-muted">
            {t('derivedLayerBuilder.newColumnName')}
          </span>
          <input
            type="text"
            value={params.outputName}
            onChange={(e) => onChange({ ...params, outputName: e.target.value })}
            placeholder={t('derivedLayerBuilder.calcFieldPlaceholder')}
            className="h-9 rounded-md border border-border bg-surface-1 px-3 text-sm focus:border-accent focus:outline-hidden"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-2xs uppercase tracking-wide text-muted">
            {t('derivedLayerBuilder.outputType')}
          </span>
          <select
            value={params.outputType}
            onChange={(e) =>
              onChange({
                ...params,
                outputType: e.target.value as 'number' | 'string' | 'boolean',
              })
            }
            className="h-9 rounded-md border border-border bg-surface-1 px-2 text-sm focus:border-accent focus:outline-hidden"
          >
            <option value="number">{t('derivedLayerBuilder.outputTypeNumber')}</option>
            <option value="string">{t('derivedLayerBuilder.outputTypeString')}</option>
            <option value="boolean">{t('derivedLayerBuilder.outputTypeBoolean')}</option>
          </select>
        </label>
      </div>
      <ExpressionEditor
        label={t('derivedLayerBuilder.expression')}
        hint={t('derivedLayerBuilder.calcFieldHint')}
        value={params.expression}
        onChange={(expression) => onChange({ ...params, expression })}
        sourceFields={sourceFields}
        resultMode={params.outputType}
      />
    </div>
  );
}

/**
 * Shared expression editor: chip strip of fields + textarea +
 * inline parse / validate feedback.  Used by both filter (boolean
 * predicate) and calculate-field (any-typed expression) so the two
 * steps share authoring affordances.
 */
function ExpressionEditor({
  label,
  hint,
  value,
  onChange,
  sourceFields,
  resultMode,
}: {
  label: string;
  hint: string;
  value: string;
  onChange: (next: string) => void;
  sourceFields: FeatureField[];
  resultMode: 'boolean' | 'number' | 'string';
}) {
  const { t } = useDerivedLayerCatalog();

  const ref = useRef<HTMLTextAreaElement | null>(null);
  function insert(text: string) {
    const el = ref.current;
    if (!el) return;
    const start = el.selectionStart ?? value.length;
    const end = el.selectionEnd ?? value.length;
    const next = value.slice(0, start) + text + value.slice(end);
    onChange(next);
    requestAnimationFrame(() => {
      el.focus();
      const caret = start + text.length;
      try {
        el.setSelectionRange(caret, caret);
      } catch {
        /* element may be hidden mid-update */
      }
    });
  }

  // Parse + validate live for inline error feedback.  Empty
  // expression is fine here; the save-time validator surfaces the
  // "expression required" error and we let the user keep typing
  // without yelling about it on first focus.
  const validation = useMemo(() => {
    if (value.trim().length === 0) return { errors: [], info: null };
    try {
      const ast = parseExpression(value);
      const errors = validateExpression(
        ast,
        sourceFields.map((f) => ({
          name: f.name,
          type: fieldRefTypeFor(f.type),
        })),
      );
      return { errors, info: null as string | null };
    } catch (err) {
      if (err instanceof ExpressionError) {
        return {
          errors: [t('derivedLayerBuilder.exprErrorAt', { message: err.message, pos: err.pos })],
          info: null,
        };
      }
      return { errors: [t('derivedLayerBuilder.unknownParseError')], info: null };
    }
  }, [value, sourceFields]);

  return (
    <div className="space-y-2">
      <p className="text-2xs uppercase tracking-wide text-muted">{label}</p>
      <p className="text-2xs text-muted">{hint}</p>
      {sourceFields.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1">
          <span className="text-2xs uppercase tracking-wide text-muted">
            {t('derivedLayerBuilder.insert')}
          </span>
          {sourceFields.map((f) => (
            <button
              key={f.name}
              type="button"
              onClick={() => insert(`{{${f.name}}}`)}
              className="inline-flex items-center gap-1 rounded-md border border-border bg-surface-1 px-2 py-0.5 font-mono text-2xs text-ink-1 hover:bg-surface-2"
              title={`Insert {{${f.name}}}`}
            >
              <span className="text-muted">{'{{'}</span>
              {f.name}
              <span className="text-muted">{'}}'}</span>
            </button>
          ))}
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-1">
        <span className="text-2xs uppercase tracking-wide text-muted">
          {t('derivedLayerBuilder.operators')}
        </span>
        {['==', '!=', '<', '<=', '>', '>=', 'AND', 'OR', 'NOT', '+', '-', '*', '/', '(', ')'].map((op) => (
          <button
            key={op}
            type="button"
            onClick={() => insert(op === 'AND' || op === 'OR' || op === 'NOT' ? ` ${op} ` : op)}
            className="inline-flex h-6 items-center gap-1 rounded border border-border bg-surface-1 px-2 font-mono text-2xs text-ink-1 hover:bg-surface-2"
          >
            {op}
          </button>
        ))}
        {(['if', 'upper', 'lower', 'concat', 'coalesce', 'abs', 'round'] as const).map((fn) => (
          <button
            key={fn}
            type="button"
            onClick={() => insert(`${fn}()`)}
            className="inline-flex h-6 items-center gap-1 rounded border border-border bg-surface-1 px-2 font-mono text-2xs text-ink-1 hover:bg-surface-2"
          >
            {fn}()
          </button>
        ))}
      </div>
      <textarea
        ref={ref}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={3}
        placeholder={
          resultMode === 'boolean'
            ? "{{acres}} > 5 AND {{zoning}} == 'R1'"
            : resultMode === 'number'
              ? '{{acres}} * 0.4047'
              : "concat({{first_name}}, ' ', {{last_name}})"
        }
        className="w-full rounded-md border border-border bg-surface-0 px-3 py-2 font-mono text-xs text-ink-0 focus:border-accent focus:outline-hidden"
      />
      {validation.errors.length > 0 ? (
        <ul className="space-y-0.5 text-2xs text-danger">
          {validation.errors.map((e, i) => (
            <li key={i}>{e}</li>
          ))}
        </ul>
      ) : value.trim().length > 0 ? (
        <p className="text-2xs text-success">
          {t('derivedLayerBuilder.exprParsesOk')}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Contour step editor (#88).  Author picks the numeric source
 * field + a mode (auto / manual) + the interval or explicit
 * levels.  cachedLevels is server-computed on save so the wizard
 * doesn't surface it directly.
 */
function ContourStepEditor({
  params,
  onChange,
  sourceFields,
}: {
  params: {
    field: string;
    mode: 'auto' | 'manual';
    interval?: number;
    minLevel?: number;
    maxLevel?: number;
    levels?: number[];
    cachedLevels?: number[];
  };
  onChange: (next: {
    field: string;
    mode: 'auto' | 'manual';
    interval?: number;
    minLevel?: number;
    maxLevel?: number;
    levels?: number[];
    cachedLevels?: number[];
  }) => void;
  sourceFields: FeatureField[];
}) {
  const { t } = useDerivedLayerCatalog();

  const numericFields = sourceFields.filter((f) => f.type === 'number');
  return (
    <div className="space-y-3">
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-2xs uppercase tracking-wide text-muted">
          {t('derivedLayerBuilder.contourSourceField')}
        </span>
        <select
          value={params.field}
          onChange={(e) => onChange({ ...params, field: e.target.value })}
          className="h-9 rounded-md border border-border bg-surface-1 px-2 text-sm focus:border-accent focus:outline-hidden"
        >
          <option value="">{t('derivedLayerBuilder.pickNumericFieldOption')}</option>
          {numericFields.map((f) => (
            <option key={f.name} value={f.name}>
              {f.label ?? f.name}
            </option>
          ))}
        </select>
        {numericFields.length === 0 ? (
          <span className="text-2xs text-warn">
{t('derivedLayerBuilder.contourNoNumeric')}
          </span>
        ) : null}
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-2xs uppercase tracking-wide text-muted">
          {t('derivedLayerBuilder.levels')}
        </span>
        <select
          value={params.mode}
          onChange={(e) =>
            onChange({
              ...params,
              mode: e.target.value as 'auto' | 'manual',
            })
          }
          className="h-9 rounded-md border border-border bg-surface-1 px-2 text-sm focus:border-accent focus:outline-hidden"
        >
          <option value="auto">
            {t('derivedLayerBuilder.contourAuto')}
          </option>
          <option value="manual">{t('derivedLayerBuilder.contourManual')}</option>
        </select>
      </label>
      {params.mode === 'auto' ? (
        <div className="grid gap-2 sm:grid-cols-3">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-2xs uppercase tracking-wide text-muted">
              {t('derivedLayerBuilder.interval')}
            </span>
            <input
              type="number"
              min={0}
              step="any"
              value={params.interval ?? 10}
              onChange={(e) =>
                onChange({
                  ...params,
                  interval: Number(e.target.value),
                })
              }
              className="h-9 rounded-md border border-border bg-surface-1 px-2 text-sm focus:border-accent focus:outline-hidden"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-2xs uppercase tracking-wide text-muted">
              {t('derivedLayerBuilder.minLevelOptional')}
            </span>
            <input
              type="number"
              step="any"
              value={params.minLevel ?? ''}
              onChange={(e) => {
                const v = e.target.value;
                // Build next params without minLevel, then add it
                // back only when the input has a real value.
                // exactOptionalPropertyTypes treats `{ x: undefined }`
                // as distinct from `{}`, so we have to omit the
                // key entirely.
                const { minLevel: _drop, ...rest } = params;
                void _drop;
                onChange(
                  v === '' ? rest : { ...rest, minLevel: Number(v) },
                );
              }}
              placeholder={t('derivedLayerBuilder.autoFromData')}
              className="h-9 rounded-md border border-border bg-surface-1 px-2 text-sm focus:border-accent focus:outline-hidden"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-2xs uppercase tracking-wide text-muted">
              {t('derivedLayerBuilder.maxLevelOptional')}
            </span>
            <input
              type="number"
              step="any"
              value={params.maxLevel ?? ''}
              onChange={(e) => {
                const v = e.target.value;
                const { maxLevel: _drop, ...rest } = params;
                void _drop;
                onChange(
                  v === '' ? rest : { ...rest, maxLevel: Number(v) },
                );
              }}
              placeholder="auto from data"
              className="h-9 rounded-md border border-border bg-surface-1 px-2 text-sm focus:border-accent focus:outline-hidden"
            />
          </label>
        </div>
      ) : (
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-2xs uppercase tracking-wide text-muted">
            {t('derivedLayerBuilder.levelsCsv')}
          </span>
          <input
            type="text"
            value={(params.levels ?? []).join(', ')}
            onChange={(e) => {
              const parts = e.target.value
                .split(',')
                .map((s) => s.trim())
                .filter((s) => s.length > 0);
              const nums: number[] = [];
              let bad = false;
              for (const p of parts) {
                const n = Number(p);
                if (!Number.isFinite(n)) {
                  bad = true;
                  break;
                }
                nums.push(n);
              }
              const next = bad ? params.levels : nums;
              const { levels: _drop, ...rest } = params;
              void _drop;
              onChange(next === undefined ? rest : { ...rest, levels: next });
            }}
            placeholder={t('derivedLayerBuilder.levelsPlaceholder')}
            className="h-9 rounded-md border border-border bg-surface-1 px-2 text-sm focus:border-accent focus:outline-hidden"
          />
        </label>
      )}
      <p className="text-2xs text-muted">
{t('derivedLayerBuilder.contourFootnote')}
      </p>
    </div>
  );
}

/**
 * Aggregate step editor (#80).  Group-by chip strip + aggregation
 * row list (op + field + outputName).  Empty groupBy collapses to
 * a single output row (dissolve-with-extras).
 */
function AggregateStepEditor({
  params,
  onChange,
  sourceFields,
}: {
  params: {
    groupBy: string[];
    aggs: Array<{ field: string; op: 'count' | 'sum' | 'avg' | 'min' | 'max' | 'first'; outputName: string }>;
  };
  onChange: (next: {
    groupBy: string[];
    aggs: Array<{ field: string; op: 'count' | 'sum' | 'avg' | 'min' | 'max' | 'first'; outputName: string }>;
  }) => void;
  sourceFields: FeatureField[];
}) {
  const { t } = useDerivedLayerCatalog();

  const numericFields = sourceFields.filter((f) => f.type === 'number');
  const groupCandidates = sourceFields.filter(
    (f) => !params.groupBy.includes(f.name),
  );

  function toggleGroup(name: string, on: boolean) {
    const next = on
      ? [...params.groupBy, name]
      : params.groupBy.filter((g) => g !== name);
    onChange({ ...params, groupBy: next });
  }
  function addAgg() {
    onChange({
      ...params,
      aggs: [
        ...params.aggs,
        { op: 'count', field: '', outputName: `agg_${params.aggs.length + 1}` },
      ],
    });
  }
  function updateAgg(idx: number, patch: Partial<typeof params.aggs[number]>) {
    onChange({
      ...params,
      aggs: params.aggs.map((a, i) => (i === idx ? { ...a, ...patch } : a)),
    });
  }
  function removeAgg(idx: number) {
    onChange({
      ...params,
      aggs: params.aggs.filter((_, i) => i !== idx),
    });
  }

  return (
    <div className="space-y-3">
      <div>
        <p className="mb-1 text-2xs uppercase tracking-wide text-muted">
          {t('derivedLayerBuilder.groupBy')}
        </p>
        <p className="text-2xs text-muted">
{t('derivedLayerBuilder.groupByHint')}
        </p>
        {params.groupBy.length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-1">
            {params.groupBy.map((g) => (
              <span
                key={g}
                className="inline-flex items-center gap-1 rounded-md border border-accent/40 bg-accent/10 px-2 py-0.5 text-2xs font-mono text-accent"
              >
                {g}
                <button
                  type="button"
                  onClick={() => toggleGroup(g, false)}
                  aria-label={t('derivedLayerBuilder.removeGroupKeyAria', { name: g })}
                  className="ml-1 text-accent/70 hover:text-danger"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
        ) : null}
        {groupCandidates.length > 0 ? (
          <div className="mt-2 flex flex-wrap items-center gap-1">
            <span className="text-2xs uppercase tracking-wide text-muted">
              {t('derivedLayerBuilder.add')}
            </span>
            {groupCandidates.map((f) => (
              <button
                key={f.name}
                type="button"
                onClick={() => toggleGroup(f.name, true)}
                className="inline-flex items-center gap-1 rounded-md border border-border bg-surface-1 px-2 py-0.5 font-mono text-2xs text-ink-1 hover:bg-surface-2"
              >
                + {f.name}
              </button>
            ))}
          </div>
        ) : null}
      </div>
      <div>
        <div className="mb-1 flex items-center justify-between">
          <p className="text-2xs uppercase tracking-wide text-muted">
            {t('derivedLayerBuilder.aggregations')}
          </p>
          <button
            type="button"
            onClick={addAgg}
            className="inline-flex h-6 items-center gap-1 rounded border border-border bg-surface-1 px-2 text-2xs text-ink-1 hover:bg-surface-2"
          >
            <Plus className="h-3 w-3" />
            {t('derivedLayerBuilder.aggAdd')}
          </button>
        </div>
        <div className="space-y-1.5">
          {params.aggs.map((a, idx) => (
            <div
              key={idx}
              className="grid grid-cols-[110px_minmax(0,1fr)_minmax(0,1fr)_28px] items-center gap-1.5"
            >
              <select
                value={a.op}
                onChange={(e) =>
                  updateAgg(idx, {
                    op: e.target.value as typeof a.op,
                    // Reset field for count so an old field doesn't
                    // leak into a count agg.
                    ...(e.target.value === 'count' ? { field: '' } : {}),
                  })
                }
                className="h-8 rounded border border-border bg-surface-1 px-2 text-xs focus:border-accent focus:outline-hidden"
              >
                <option value="count">count</option>
                <option value="sum">sum</option>
                <option value="avg">avg</option>
                <option value="min">min</option>
                <option value="max">max</option>
                <option value="first">first</option>
              </select>
              {a.op === 'count' ? (
                <span className="rounded border border-border bg-surface-1 px-2 py-1 text-2xs text-muted">
                  {t('derivedLayerBuilder.aggNoField')}
                </span>
              ) : (
                <select
                  value={a.field}
                  onChange={(e) => updateAgg(idx, { field: e.target.value })}
                  className="h-8 min-w-0 rounded border border-border bg-surface-1 px-2 text-xs focus:border-accent focus:outline-hidden"
                >
                  <option value="">{t('derivedLayerBuilder.pickField')}</option>
                  {(a.op === 'first' ? sourceFields : numericFields).map((f) => (
                    <option key={f.name} value={f.name}>
                      {f.name}
                    </option>
                  ))}
                </select>
              )}
              <input
                type="text"
                value={a.outputName}
                onChange={(e) =>
                  updateAgg(idx, { outputName: e.target.value })
                }
                placeholder={t('derivedLayerBuilder.outputColumnPlaceholder')}
                className="h-8 min-w-0 rounded border border-border bg-surface-1 px-2 text-xs focus:border-accent focus:outline-hidden"
              />
              <button
                type="button"
                onClick={() => removeAgg(idx)}
                aria-label={t('derivedLayerBuilder.removeAggregationAria')}
                className="inline-flex h-7 w-7 items-center justify-center rounded text-muted hover:bg-danger/10 hover:text-danger"
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </div>
          ))}
          {params.aggs.length === 0 ? (
            <p className="text-2xs text-muted">
              {t('derivedLayerBuilder.aggEmpty')}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * Spatial-join step editor (#79).  Three knobs:
 *   - the second source data_layer (otherSource.itemId)
 *   - the spatial predicate (within / intersects / nearest)
 *   - the attribute strategy (count adds a numeric count, first
 *     joins picked attributes from the closest / first match)
 * 'nearest' surfaces a meters-distance input; 'first' surfaces an
 * attrs-to-keep input.  Output attribute prefix is editable so
 * authors can avoid collisions with upstream field names.
 *
 * The second-source picker is intentionally simple here: a UUID
 * text input + helper text.  Wiring up a full picker like the
 * top-level source picker is a polish follow-up; the field name
 * "right source item id" is enough to use the tool once you know
 * what you're picking.
 */
function SpatialJoinStepEditor({
  params,
  onChange,
}: {
  params: {
    otherSource: { kind: 'data_layer'; itemId: string; layerKey?: string };
    predicate: 'within' | 'intersects' | 'nearest';
    nearestMaxMeters?: number;
    attributeStrategy: 'count' | 'first';
    attrsToKeep?: string[];
    attrPrefix?: string;
  };
  onChange: (next: typeof params) => void;
}) {
  const { t } = useDerivedLayerCatalog();

  const prefix = params.attrPrefix ?? 'joined_';
  const attrsText = (params.attrsToKeep ?? []).join(', ');
  return (
    <div className="space-y-3">
      <DataLayerPicker
        itemId={params.otherSource.itemId}
        layerKey={params.otherSource.layerKey}
        onChange={(next) =>
          onChange({
            ...params,
            otherSource: { kind: 'data_layer', ...next },
          })
        }
        label={t('derivedLayerBuilder.otherSource')}
        hint={t('derivedLayerBuilder.spatialJoinOtherHint')}
      />

      <div>
        <p className="mb-1 text-2xs uppercase tracking-wide text-muted">
          {t('derivedLayerBuilder.predicate')}
        </p>
        <div className="grid grid-cols-3 gap-2" role="radiogroup">
          {(['intersects', 'within', 'nearest'] as const).map((p) => (
            <button
              key={p}
              type="button"
              role="radio"
              aria-checked={params.predicate === p}
              onClick={() => onChange({ ...params, predicate: p })}
              className={`flex items-center justify-center rounded-md border p-2 text-xs capitalize transition-colors ${
                params.predicate === p
                  ? 'border-accent bg-accent/5 text-ink-0 ring-2 ring-accent/30'
                  : 'border-border bg-surface-1 text-ink-1 hover:bg-surface-2'
              }`}
            >
              {p}
            </button>
          ))}
        </div>
        <p className="mt-1 text-2xs text-muted">
          {params.predicate === 'within'
            ? t('derivedLayerBuilder.spatialJoinWithin')
            : params.predicate === 'intersects'
              ? t('derivedLayerBuilder.spatialJoinIntersects')
              : t('derivedLayerBuilder.spatialJoinNearest')}
        </p>
      </div>

      {params.predicate === 'nearest' ? (
        <label className="flex flex-col gap-1">
          <span className="text-2xs uppercase tracking-wide text-muted">
            {t('derivedLayerBuilder.maxDistanceMeters')}
          </span>
          <input
            type="number"
            min={1}
            max={1_000_000}
            value={params.nearestMaxMeters ?? 1000}
            onChange={(e) =>
              onChange({
                ...params,
                nearestMaxMeters: Number(e.target.value),
              })
            }
            className="h-9 w-40 rounded-md border border-border bg-surface-1 px-3 text-xs focus:border-accent focus:outline-hidden"
          />
        </label>
      ) : null}

      <div>
        <p className="mb-1 text-2xs uppercase tracking-wide text-muted">
          {t('derivedLayerBuilder.bringOver')}
        </p>
        <div className="grid grid-cols-2 gap-2" role="radiogroup">
          {(['count', 'first'] as const).map((s) => (
            <button
              key={s}
              type="button"
              role="radio"
              aria-checked={params.attributeStrategy === s}
              onClick={() => onChange({ ...params, attributeStrategy: s })}
              className={`flex items-center justify-center rounded-md border p-2 text-xs capitalize transition-colors ${
                params.attributeStrategy === s
                  ? 'border-accent bg-accent/5 text-ink-0 ring-2 ring-accent/30'
                  : 'border-border bg-surface-1 text-ink-1 hover:bg-surface-2'
              }`}
            >
              {s === 'count' ? t('derivedLayerBuilder.countOfMatches') : t('derivedLayerBuilder.attrsFromFirst')}
            </button>
          ))}
        </div>
      </div>

      {params.attributeStrategy === 'first' ? (
        <label className="flex flex-col gap-1">
          <span className="text-2xs uppercase tracking-wide text-muted">
            {t('derivedLayerBuilder.attrsToKeep')}
          </span>
          <input
            type="text"
            value={attrsText}
            onChange={(e) =>
              onChange({
                ...params,
                attrsToKeep: e.target.value
                  .split(',')
                  .map((s) => s.trim())
                  .filter(Boolean),
              })
            }
            placeholder={t('derivedLayerBuilder.attrsToKeepPlaceholder')}
            className="h-9 rounded-md border border-border bg-surface-1 px-3 font-mono text-xs focus:border-accent focus:outline-hidden"
          />
          <span className="text-2xs text-muted">
            {t('derivedLayerBuilder.attrsToKeepHint', { prefix })}
          </span>
        </label>
      ) : null}

      <label className="flex flex-col gap-1">
        <span className="text-2xs uppercase tracking-wide text-muted">
          {t('derivedLayerBuilder.outputPrefix')}
        </span>
        <input
          type="text"
          value={prefix}
          onChange={(e) =>
            onChange({
              ...params,
              attrPrefix: e.target.value.replace(/[^a-zA-Z0-9_]/g, '_'),
            })
          }
          className="h-9 w-40 rounded-md border border-border bg-surface-1 px-3 font-mono text-xs focus:border-accent focus:outline-hidden"
        />
        <span className="text-2xs text-muted">
{t('derivedLayerBuilder.outputPrefixHint')}
        </span>
      </label>
    </div>
  );
}

/**
 * Shared editor for "one-input + one-data-layer" steps. Both clip
 * and erase have the same params shape: just an otherSource that
 * picks a data_layer. The label / hint are passed in so the
 * caller controls the wording per tool.
 */
function OtherLayerOnlyStepEditor({
  params,
  onChange,
  label,
  hint,
}: {
  params: {
    otherSource: { kind: 'data_layer'; itemId: string; layerKey?: string };
  };
  onChange: (next: typeof params) => void;
  label: string;
  hint: string;
}) {
  return (
    <div className="space-y-3">
      <DataLayerPicker
        itemId={params.otherSource.itemId}
        layerKey={params.otherSource.layerKey}
        onChange={(next) =>
          onChange({
            otherSource: { kind: 'data_layer', ...next },
          })
        }
        label={label}
        hint={hint}
      />
    </div>
  );
}

/**
 * Spatial-filter step editor inside the derived_layer wizard
 * (#90).  Lighter than spatial-join because filter steps don't
 * decorate the upstream schema -- the editor only collects an
 * other-source layer, a predicate, and (for predicate='near') a
 * distance.  Inside derived_layer recipes the otherSource is
 * always a hardcoded data_layer; parameter refs aren't allowed
 * (those live in tool recipes via the recipe-editor surface).
 */
function SpatialFilterStepEditor({
  params,
  onChange,
}: {
  // Mirrors the underlying SpatialFilterStep params shape; we
  // import the union via shared-types to stay in lockstep when new
  // SourceRef / Ref variants land (e.g. the osm-query variant).
  // The wizard surface only edits the resolved `data_layer` shape;
  // unsupported variants fall back to an empty data_layer when the
  // user opens the editor, which is the safest "narrow my way out"
  // for v1.
  params: import('@gratis-gis/shared-types').SpatialFilterStep['params'];
  onChange: (next: typeof params) => void;
}) {
  const { t } = useDerivedLayerCatalog();

  // The wizard only supports the resolved-by-default shape; the
  // backend save-time validator rejects unresolved refs from a
  // derived_layer save anyway, so narrow at the editor level too.
  const dataLayerSource =
    params.otherSource.kind === 'data_layer'
      ? params.otherSource
      : { kind: 'data_layer' as const, itemId: '' };
  const fixedPredicate =
    params.predicate.kind === 'fixed' ? params.predicate.value : 'intersects';
  const fixedDistanceMeters =
    params.distance && params.distance.kind === 'fixed'
      ? params.distance.meters
      : undefined;

  const setOther = (next: { itemId: string; layerKey?: string }) =>
    onChange({
      ...params,
      otherSource: { kind: 'data_layer', ...next },
    });

  const setPredicate = (
    p: 'intersects' | 'within' | 'contains' | 'touches' | 'near',
  ) => {
    const base = { ...params, predicate: { kind: 'fixed' as const, value: p } };
    if (p === 'near') {
      // Seed a distance when the user picks near and we don't have one;
      // leaves existing distances untouched so the value persists across
      // predicate toggles.
      if (!params.distance) {
        return onChange({
          ...base,
          distance: { kind: 'fixed', meters: 100 },
        });
      }
    } else {
      // Drop distance when switching away from near; it's ignored by
      // the SQL emitter for other predicates and saved-shape lint will
      // strip it anyway, but we keep the persisted recipe tidy.
      const { distance: _unused, ...rest } = base;
      return onChange(rest);
    }
    onChange(base);
  };

  const setDistanceMeters = (m: number) => {
    if (!Number.isFinite(m) || m < 0) return;
    onChange({ ...params, distance: { kind: 'fixed', meters: m } });
  };

  return (
    <div className="space-y-3">
      <DataLayerPicker
        itemId={dataLayerSource.itemId}
        layerKey={dataLayerSource.layerKey}
        onChange={setOther}
        label={t('derivedLayerBuilder.filterAgainst')}
        hint={t('derivedLayerBuilder.spatialFilterHint')}
      />

      <div>
        <p className="mb-1 text-2xs uppercase tracking-wide text-muted">
          Predicate
        </p>
        <div className="grid grid-cols-5 gap-2" role="radiogroup">
          {(['intersects', 'within', 'contains', 'touches', 'near'] as const).map((p) => (
            <button
              key={p}
              type="button"
              role="radio"
              aria-checked={fixedPredicate === p}
              onClick={() => setPredicate(p)}
              className={`flex items-center justify-center rounded-md border p-2 text-xs capitalize transition-colors ${
                fixedPredicate === p
                  ? 'border-accent bg-accent/5 text-ink-0 ring-2 ring-accent/30'
                  : 'border-border bg-surface-1 text-ink-1 hover:bg-surface-2'
              }`}
            >
              {p}
            </button>
          ))}
        </div>
        <p className="mt-1 text-2xs text-muted">
          {fixedPredicate === 'intersects'
            ? t('derivedLayerBuilder.spatialFilterIntersects')
            : fixedPredicate === 'within'
              ? t('derivedLayerBuilder.spatialFilterWithin')
              : fixedPredicate === 'contains'
                ? t('derivedLayerBuilder.spatialFilterContains')
                : fixedPredicate === 'touches'
                  ? t('derivedLayerBuilder.spatialFilterTouches')
                  : t('derivedLayerBuilder.spatialFilterNear')}
        </p>
      </div>

      {fixedPredicate === 'near' ? (
        <label className="flex flex-col gap-1">
          <span className="text-2xs uppercase tracking-wide text-muted">
            {t('derivedLayerBuilder.distanceMeters')}
          </span>
          <input
            type="number"
            min={1}
            max={1_000_000}
            value={fixedDistanceMeters ?? 100}
            onChange={(e) => setDistanceMeters(Number(e.target.value))}
            className="h-9 w-40 rounded-md border border-border bg-surface-1 px-3 text-xs focus:border-accent focus:outline-hidden"
          />
        </label>
      ) : null}
    </div>
  );
}
