// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

/**
 * Visual builder for the OsmRelationalQueryAction shape (#142).
 *
 * The relational action declares an anchor preset, one or more
 * "near A AND near B" conditions, optional negations ("AND NOT
 * near C"), and optional bearings ("with A roughly NW of B").
 * Before this component, the tool detail page just rendered a
 * "JSON edit it for now" note when the user switched the action
 * kind to osm-relational-query; this surface gives authors a
 * proper form so they don't need to hand-craft the JSON.
 *
 * Reuses the OsmPresetMultiSelect component from the recipe
 * editor (constrained to a single preset for the anchor + each
 * condition slot via `firstOnly` semantics).  The AOI parameter
 * stays the defaulted-drawn-polygon that `emptyOsmRelationalQueryAction`
 * mints; advanced authors who want a different AOI parameter
 * can still drop to JSON.
 */
import { useEffect, useMemo, useState } from 'react';
import { Plus, X } from 'lucide-react';
import type {
  OsmRelationalQueryAction,
  OsmTagFilter,
} from '@gratis-gis/shared-types';

interface Props {
  action: OsmRelationalQueryAction;
  canEdit: boolean;
  onChange: (next: OsmRelationalQueryAction) => void;
}

const labelCls = 'block text-xs font-medium text-ink-1 mb-1';
const inputCls =
  'w-full rounded-md border border-border bg-surface-0 px-2 py-1.5 text-sm text-ink-0 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30';
const sectionCls =
  'rounded-md border border-border bg-surface-1 p-3 space-y-2';
const sectionHeaderCls =
  'flex items-center justify-between text-xs font-semibold uppercase tracking-wide text-muted';
const sectionAddBtnCls =
  'inline-flex items-center gap-1 rounded-md border border-dashed border-border bg-surface-2 px-2 py-1 text-[11px] text-ink-1 hover:bg-surface-1 disabled:opacity-50';
const rowRemoveBtnCls =
  'self-start rounded-md border border-border bg-surface-0 px-2 py-1 text-[11px] text-danger hover:bg-danger/10';

type Catalog = Array<{ id: string; label: string; category: string }>;

export function OsmRelationalEditor({ action, canEdit, onChange }: Props) {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/portal/public/osm/presets', {
          cache: 'force-cache',
        });
        if (!res.ok) {
          if (!cancelled) setCatalog([]);
          return;
        }
        const body = (await res.json()) as { presets: Catalog };
        if (!cancelled) setCatalog(body.presets ?? []);
      } catch {
        if (!cancelled) setCatalog([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Self-heal a relational action that was saved without an AOI
  // parameter. The Phase 1 editor described the AOI as "defaulted
  // to a drawn polygon" but never actually wrote the parameter,
  // so older tools 400 at run time because the runner can't find
  // any feature-source to drive the search area. When we detect
  // an empty aoiParameterRef + no feature-source parameter and
  // the user has edit access, stamp in a draw-polygon parameter
  // and point the action at it. The author just needs to save
  // afterward.
  useEffect(() => {
    if (!canEdit) return;
    const hasAoiRef =
      typeof action.aoiParameterRef === 'string' &&
      action.aoiParameterRef.trim().length > 0;
    const hasFeatureSource = (action.parameters ?? []).some(
      (p) => p.kind === 'feature-source',
    );
    if (hasAoiRef || hasFeatureSource) return;
    onChange({
      ...action,
      parameters: [
        ...(action.parameters ?? []),
        {
          kind: 'feature-source',
          name: 'aoi',
          label: 'Area of interest',
          hint: 'Draw the area to search inside.',
          required: true,
          binding: { mode: 'runtime-draw' },
        },
      ],
      aoiParameterRef: 'aoi',
    });
    // Only re-run when canEdit flips or the action reference
    // identity changes; auto-stamping on every keystroke would
    // race with manual edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canEdit, action.aoiParameterRef, action.parameters?.length]);

  function setAnchor(presetId: string): void {
    onChange({ ...action, anchorPreset: presetId });
  }

  function addCondition(): void {
    onChange({
      ...action,
      conditions: [
        ...action.conditions,
        { preset: '', distance: { value: 0.5, unit: 'mi' } },
      ],
    });
  }
  function setCondition(
    i: number,
    patch: Partial<OsmRelationalQueryAction['conditions'][number]>,
  ): void {
    const next = action.conditions.slice();
    next[i] = { ...next[i]!, ...patch };
    onChange({ ...action, conditions: next });
  }
  function removeCondition(i: number): void {
    onChange({
      ...action,
      conditions: action.conditions.filter((_, j) => j !== i),
      // Drop any bearings that referenced the removed condition or
      // shift their indices down to keep them pointed at the right
      // remaining condition.  Easier to drop than to shift; the
      // user can re-add the bearing if needed.
      ...(action.bearings
        ? {
            bearings: action.bearings
              .filter((b) => b.conditionIndex !== i)
              .map((b) =>
                b.conditionIndex > i
                  ? { ...b, conditionIndex: b.conditionIndex - 1 }
                  : b,
              ),
          }
        : {}),
    });
  }

  function addNegation(): void {
    onChange({
      ...action,
      negations: [
        ...(action.negations ?? []),
        { preset: '', distance: { value: 0.25, unit: 'mi' } },
      ],
    });
  }
  function setNegation(
    i: number,
    patch: Partial<NonNullable<OsmRelationalQueryAction['negations']>[number]>,
  ): void {
    const arr = (action.negations ?? []).slice();
    arr[i] = { ...arr[i]!, ...patch };
    onChange({ ...action, negations: arr });
  }
  function removeNegation(i: number): void {
    const arr = (action.negations ?? []).filter((_, j) => j !== i);
    if (arr.length === 0) {
      // Drop the empty array entirely so the action's JSON stays clean.
      const next = { ...action };
      delete (next as { negations?: unknown }).negations;
      onChange(next);
      return;
    }
    onChange({ ...action, negations: arr });
  }

  function addBearing(): void {
    onChange({
      ...action,
      bearings: [
        ...(action.bearings ?? []),
        { conditionIndex: 0, bearingDegrees: 0, toleranceDegrees: 30 },
      ],
    });
  }
  function setBearing(
    i: number,
    patch: Partial<NonNullable<OsmRelationalQueryAction['bearings']>[number]>,
  ): void {
    const arr = (action.bearings ?? []).slice();
    arr[i] = { ...arr[i]!, ...patch };
    onChange({ ...action, bearings: arr });
  }
  function removeBearing(i: number): void {
    const arr = (action.bearings ?? []).filter((_, j) => j !== i);
    if (arr.length === 0) {
      const next = { ...action };
      delete (next as { bearings?: unknown }).bearings;
      onChange(next);
      return;
    }
    onChange({ ...action, bearings: arr });
  }

  return (
    <div className="space-y-4">
      <div className={sectionCls}>
        <div className={sectionHeaderCls}>
          <span>What to find</span>
        </div>
        <p className="text-[11px] text-muted">
          Pick the kind of feature you want as a result. Every match
          will be one of these. Example: schools, gas stations,
          breweries.
        </p>
        <PresetPickerSingle
          value={action.anchorPreset}
          catalog={catalog}
          canEdit={canEdit}
          onChange={setAnchor}
          placeholder="Search feature types, e.g. school, gas station..."
        />
      </div>

      <div className={sectionCls}>
        <div className={sectionHeaderCls}>
          <span>Must be near</span>
          <button
            type="button"
            disabled={!canEdit}
            onClick={addCondition}
            className={sectionAddBtnCls}
          >
            <Plus className="h-3 w-3" /> Add &quot;must be near&quot;
          </button>
        </div>
        <p className="text-[11px] text-muted">
          A result only counts if it has at least one of each of these
          nearby. Example: keep only schools that have BOTH a park
          within 0.5 mi AND a library within 1 mi.
        </p>
        {action.conditions.length === 0 ? (
          <p className="text-[11px] italic text-muted">
            None yet. Add one to require the result to be near
            something else.
          </p>
        ) : (
          <div className="space-y-2">
            {action.conditions.map((c, i) => (
              <div
                key={i}
                className="flex items-start gap-2 rounded-md border border-border bg-surface-0 p-2"
              >
                <div className="flex-1 space-y-1.5">
                  <PresetPickerSingle
                    value={c.preset}
                    catalog={catalog}
                    canEdit={canEdit}
                    onChange={(presetId) => setCondition(i, { preset: presetId })}
                    placeholder="Search feature types, e.g. park, library..."
                  />
                  <DistanceRow
                    value={c.distance}
                    canEdit={canEdit}
                    onChange={(distance) => setCondition(i, { distance })}
                  />
                  <TagFilterRows
                    filters={c.tagFilters ?? []}
                    canEdit={canEdit}
                    onChange={(tagFilters) => {
                      // Drop the field entirely when the list is
                      // empty so the action JSON stays clean.
                      if (tagFilters.length === 0) {
                        const next = { ...c };
                        delete (next as { tagFilters?: unknown }).tagFilters;
                        setCondition(i, next);
                      } else {
                        setCondition(i, { tagFilters });
                      }
                    }}
                  />
                </div>
                {canEdit ? (
                  <button
                    type="button"
                    onClick={() => removeCondition(i)}
                    aria-label="Remove condition"
                    className={rowRemoveBtnCls}
                  >
                    <X className="h-3 w-3" />
                  </button>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className={sectionCls}>
        <div className={sectionHeaderCls}>
          <span>Must NOT be near</span>
          <button
            type="button"
            disabled={!canEdit}
            onClick={addNegation}
            className={sectionAddBtnCls}
          >
            <Plus className="h-3 w-3" /> Add &quot;must not be near&quot;
          </button>
        </div>
        <p className="text-[11px] text-muted">
          Optional. Drop any result that has one of these nearby.
          Example: schools near a park but NOT near a highway.
        </p>
        {(action.negations?.length ?? 0) === 0 ? (
          <p className="text-[11px] italic text-muted">
            None. Optional.
          </p>
        ) : (
          <div className="space-y-2">
            {(action.negations ?? []).map((n, i) => (
              <div
                key={i}
                className="flex items-start gap-2 rounded-md border border-border bg-surface-0 p-2"
              >
                <div className="flex-1 space-y-1.5">
                  <PresetPickerSingle
                    value={n.preset}
                    catalog={catalog}
                    canEdit={canEdit}
                    onChange={(presetId) => setNegation(i, { preset: presetId })}
                    placeholder="Search feature types, e.g. highway..."
                  />
                  <DistanceRow
                    value={n.distance}
                    canEdit={canEdit}
                    onChange={(distance) => setNegation(i, { distance })}
                  />
                </div>
                {canEdit ? (
                  <button
                    type="button"
                    onClick={() => removeNegation(i)}
                    aria-label="Remove negation"
                    className={rowRemoveBtnCls}
                  >
                    <X className="h-3 w-3" />
                  </button>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className={sectionCls}>
        <div className={sectionHeaderCls}>
          <span>Direction</span>
          <button
            type="button"
            disabled={!canEdit || action.conditions.length === 0}
            onClick={addBearing}
            className={sectionAddBtnCls}
            title={
              action.conditions.length === 0
                ? 'Add a "Must be near" rule first; direction rules reference one.'
                : undefined
            }
          >
            <Plus className="h-3 w-3" /> Add direction rule
          </button>
        </div>
        <p className="text-[11px] text-muted">
          Optional. Require the result to lie in a specific compass
          direction from one of the &quot;Must be near&quot; features.
          0 = North, 90 = East, 180 = South, 270 = West. Tolerance
          widens the arc on either side, so 45° tolerance means
          &quot;within 45° of the target bearing in either direction.&quot;
        </p>
        {(action.bearings?.length ?? 0) === 0 ? (
          <p className="text-[11px] italic text-muted">
            None. Optional.
          </p>
        ) : (
          <div className="space-y-2">
            {(action.bearings ?? []).map((b, i) => (
              <div
                key={i}
                className="flex items-start gap-2 rounded-md border border-border bg-surface-0 p-2"
              >
                <div className="flex-1 grid grid-cols-3 gap-2">
                  <div>
                    <label className="block text-[10px] uppercase tracking-wide text-muted">
                      Relative to
                    </label>
                    <select
                      disabled={!canEdit}
                      value={b.conditionIndex}
                      onChange={(e) =>
                        setBearing(i, {
                          conditionIndex: Number(e.target.value),
                        })
                      }
                      className={inputCls}
                    >
                      {action.conditions.map((c, ci) => (
                        <option key={ci} value={ci}>
                          {`#${ci + 1}: ${c.preset || '(unset)'}`}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-[10px] uppercase tracking-wide text-muted">
                      Bearing (deg)
                    </label>
                    <input
                      type="number"
                      disabled={!canEdit}
                      min={0}
                      max={359}
                      value={b.bearingDegrees}
                      onChange={(e) =>
                        setBearing(i, {
                          bearingDegrees: Number(e.target.value),
                        })
                      }
                      className={inputCls}
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] uppercase tracking-wide text-muted">
                      Tolerance (deg)
                    </label>
                    <input
                      type="number"
                      disabled={!canEdit}
                      min={1}
                      max={180}
                      value={b.toleranceDegrees}
                      onChange={(e) =>
                        setBearing(i, {
                          toleranceDegrees: Number(e.target.value),
                        })
                      }
                      className={inputCls}
                    />
                  </div>
                </div>
                {canEdit ? (
                  <button
                    type="button"
                    onClick={() => removeBearing(i)}
                    aria-label="Remove bearing"
                    className={rowRemoveBtnCls}
                  >
                    <X className="h-3 w-3" />
                  </button>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className={sectionCls}>
        <div className={sectionHeaderCls}>
          <span>Area of interest</span>
        </div>
        <p className="text-[11px] text-muted">
          Defaulted to a drawn polygon: the runtime user draws the
          search area when they run the tool. Advanced authors who
          need a different AOI parameter shape (e.g. bound to a
          host-app layer) can edit the action JSON directly.
        </p>
        <p className="text-[11px] font-mono text-muted">
          parameter: <code>{action.aoiParameterRef || '(unset)'}</code>
        </p>
      </div>

      <div className={sectionCls}>
        <div className={sectionHeaderCls}>
          <span>Advanced</span>
        </div>
        <p className="text-[11px] text-muted">
          Cache + result-cap knobs. Defaults are fine for most
          tools; touch these when you&apos;re working with a busy
          AOI or a long-lived configuration.
        </p>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className={labelCls}>
              Max anchor results
            </label>
            <input
              type="number"
              disabled={!canEdit}
              min={1}
              max={50000}
              value={
                typeof action.anchorMaxResults === 'number'
                  ? action.anchorMaxResults
                  : ''
              }
              placeholder="50000 (engine default)"
              onChange={(e) => {
                const raw = e.target.value.trim();
                const next = { ...action };
                if (raw === '') {
                  delete (next as { anchorMaxResults?: unknown })
                    .anchorMaxResults;
                  onChange(next);
                  return;
                }
                const n = Number(raw);
                if (Number.isFinite(n) && n > 0) {
                  next.anchorMaxResults = Math.floor(n);
                  onChange(next);
                }
              }}
              className={inputCls}
            />
            <p className="mt-1 text-[10px] text-muted">
              Cap on how many candidate anchors Overpass returns
              before the AND / negation / bearing checks narrow
              them.  Leave blank to use the engine default
              (50,000).
            </p>
          </div>
          <div>
            <label className={labelCls}>
              Cache TTL (minutes)
            </label>
            <input
              type="number"
              disabled={!canEdit}
              min={0}
              max={10080}
              value={
                typeof action.ttlMinutes === 'number'
                  ? action.ttlMinutes
                  : ''
              }
              placeholder="60 (engine default)"
              onChange={(e) => {
                const raw = e.target.value.trim();
                const next = { ...action };
                if (raw === '') {
                  delete (next as { ttlMinutes?: unknown }).ttlMinutes;
                  onChange(next);
                  return;
                }
                const n = Number(raw);
                if (Number.isFinite(n) && n >= 0) {
                  next.ttlMinutes = Math.floor(n);
                  onChange(next);
                }
              }}
              className={inputCls}
            />
            <p className="mt-1 text-[10px] text-muted">
              How long Overpass results stay cached before a
              fresh call.  0 = always refetch; blank = engine
              default (60 min).  Server clamps to a max of
              7 days regardless.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Per-condition tag-filter editor: zero or more key / op / value
 * rows that flow into the condition's `tagFilters` array.
 * Mirrors the runtime OsmTagFilterRowsRuntime shape so the
 * designer and the runtime share the same mental model
 * (`=` exact, `~` case-insensitive substring, `~/./` regex).
 */
function TagFilterRows({
  filters,
  canEdit,
  onChange,
}: {
  filters: OsmTagFilter[];
  canEdit: boolean;
  onChange: (next: OsmTagFilter[]) => void;
}) {
  function set(i: number, patch: Partial<OsmTagFilter>): void {
    onChange(filters.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  }
  function add(): void {
    onChange([...filters, { key: '', value: '' }]);
  }
  function remove(i: number): void {
    onChange(filters.filter((_, j) => j !== i));
  }
  return (
    <div className="space-y-1.5 border-l-2 border-border pl-2">
      <div className="text-[10px] font-medium uppercase tracking-wide text-muted">
        Tag filters (optional)
      </div>
      {filters.length === 0 ? (
        <p className="text-[10px] italic text-muted">
          No tag filters. Add one to require e.g. <code>name~&quot;Lincoln&quot;</code>.
        </p>
      ) : (
        filters.map((f, i) => (
          <div key={i} className="flex gap-1">
            <input
              type="text"
              disabled={!canEdit}
              value={f.key}
              onChange={(e) => set(i, { key: e.target.value.trim() })}
              placeholder="key"
              className={`${inputCls} flex-1 font-mono text-xs`}
            />
            <select
              disabled={!canEdit}
              value={f.op ?? 'equals'}
              onChange={(e) => {
                const op = e.target.value as NonNullable<OsmTagFilter['op']>;
                set(i, { op });
              }}
              aria-label="Match operator"
              className={`${inputCls} w-14 font-mono text-xs`}
            >
              <option value="equals">=</option>
              <option value="contains">~</option>
              <option value="regex">~/./</option>
            </select>
            <input
              type="text"
              disabled={!canEdit}
              value={f.value}
              onChange={(e) => set(i, { value: e.target.value })}
              placeholder={
                f.op === 'contains'
                  ? 'substring'
                  : f.op === 'regex'
                    ? 'regex'
                    : 'value'
              }
              className={`${inputCls} flex-1 font-mono text-xs`}
            />
            {canEdit ? (
              <button
                type="button"
                onClick={() => remove(i)}
                aria-label="Remove tag filter"
                className="rounded-md border border-border bg-surface-0 px-2 text-[11px] text-danger hover:bg-danger/10"
              >
                ×
              </button>
            ) : null}
          </div>
        ))
      )}
      {canEdit ? (
        <button
          type="button"
          onClick={add}
          className="inline-flex items-center gap-1 rounded-md border border-dashed border-border bg-surface-2 px-2 py-0.5 text-[10px] text-ink-1 hover:bg-surface-1"
        >
          <Plus className="h-2.5 w-2.5" /> Add tag filter
        </button>
      ) : null}
    </div>
  );
}

/**
 * Distance value + unit pair used by relational conditions and
 * negations.  Mirrors the runtime distance input but stays
 * editor-side and skips the meters fallback.
 */
function DistanceRow({
  value,
  canEdit,
  onChange,
}: {
  value: { value: number; unit: 'm' | 'km' | 'ft' | 'mi' };
  canEdit: boolean;
  onChange: (next: { value: number; unit: 'm' | 'km' | 'ft' | 'mi' }) => void;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="shrink-0 text-[11px] font-medium text-ink-1">
        Within
      </span>
      <input
        type="number"
        step="any"
        min={0}
        disabled={!canEdit}
        value={value.value}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (Number.isFinite(n)) onChange({ ...value, value: n });
        }}
        aria-label="Distance value"
        className={`${inputCls} w-24`}
      />
      <select
        disabled={!canEdit}
        value={value.unit}
        onChange={(e) =>
          onChange({
            ...value,
            unit: e.target.value as 'm' | 'km' | 'ft' | 'mi',
          })
        }
        aria-label="Distance unit"
        className={`${inputCls} w-28`}
      >
        <option value="mi">miles</option>
        <option value="ft">feet</option>
        <option value="km">kilometers</option>
        <option value="m">meters</option>
      </select>
      <span className="text-[11px] text-muted">
        of the result
      </span>
    </div>
  );
}

/**
 * Single-preset picker driven by the same iD catalog the multi-
 * select uses, but constrained to one chip.  Type to search;
 * picking a match replaces whatever was set.  Empty string means
 * "no preset chosen yet" (the action's save-time validator can
 * flag that).
 */
function PresetPickerSingle({
  value,
  catalog,
  canEdit,
  onChange,
  placeholder,
}: {
  value: string;
  catalog: Catalog | null;
  canEdit: boolean;
  onChange: (next: string) => void;
  placeholder: string;
}) {
  const [query, setQuery] = useState('');
  const matches = useMemo(() => {
    if (!catalog || query.trim().length < 2) return [];
    const q = query.trim().toLowerCase();
    const hits: Catalog = [];
    for (const p of catalog) {
      if (p.id === value) continue;
      if (
        p.label.toLowerCase().includes(q) ||
        p.id.toLowerCase().includes(q) ||
        p.category.toLowerCase().includes(q)
      ) {
        hits.push(p);
        if (hits.length >= 12) break;
      }
    }
    return hits;
  }, [catalog, query, value]);

  const currentLabel = catalog?.find((p) => p.id === value)?.label ?? value;

  return (
    <div className="space-y-1">
      {value ? (
        <div className="flex items-center gap-1">
          <span className="inline-flex items-center gap-1 rounded-full border border-border bg-surface-0 px-2 py-0.5 text-[11px]">
            {currentLabel}
            {canEdit ? (
              <button
                type="button"
                onClick={() => onChange('')}
                aria-label="Clear preset"
                className="text-muted hover:text-danger"
              >
                ×
              </button>
            ) : null}
          </span>
        </div>
      ) : null}
      {canEdit && !value ? (
        <>
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={placeholder}
            className={inputCls}
          />
          {matches.length > 0 ? (
            <div className="max-h-40 overflow-y-auto rounded-md border border-border bg-surface-0">
              {matches.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => {
                    onChange(p.id);
                    setQuery('');
                  }}
                  className="block w-full px-2 py-1 text-left text-xs hover:bg-surface-1"
                >
                  <span className="text-ink-0">{p.label}</span>
                  <span className="ml-1 text-[10px] text-muted">{p.id}</span>
                </button>
              ))}
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
