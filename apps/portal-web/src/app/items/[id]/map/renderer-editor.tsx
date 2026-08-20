// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import { useState } from 'react';
import { BarChart3, Loader2, Plus, Shuffle, Trash2 } from 'lucide-react';
import type {
  MapLayer,
  MapLayerRenderer,
  MapUniqueValueCategory,
} from '@gratis-gis/shared-types';
import {
  CLASS_BREAK_RAMPS,
  DEFAULT_CLASS_BREAK_RAMP,
  UNIQUE_VALUE_PALETTE,
  sampleRamp,
} from '@gratis-gis/shared-types';
import type { LayerMetadata } from './layer-metadata';

interface Props {
  value: MapLayerRenderer;
  metadata: LayerMetadata;
  /** Needed to ask the server for distinct values; see autoPopulate. */
  layer: MapLayer;
  onChange: (next: MapLayerRenderer) => void;
}

/**
 * Picker + editor for the layer's rendering strategy.
 *
 * Simple vs. unique-values is a radio; when unique-values is active the
 * editor shows a field dropdown (populated from discovered metadata)
 * and a color-per-category list. An "Auto-populate" button seeds the
 * categories from the metadata's distinct values with palette colors.
 *
 * Keeping this focused: no class-breaks yet. The UI makes the missing
 * strategy obvious so the user knows what's coming.
 */
/**
 * How many categories Auto fill will create.
 *
 * Past a couple of dozen the map stops being readable and the legend
 * stops fitting, so the cap is a cartographic limit rather than a
 * technical one. The rest fall through to the layer's single colour,
 * and the editor says so.
 */
const MAX_AUTO_CATEGORIES = 24;

export function RendererEditor({ value, metadata, layer, onChange }: Props) {
  const isUnique = value.kind === 'unique-values';

  const isBreaks = value.kind === 'class-breaks';
  const [filling, setFilling] = useState(false);
  const [fillNote, setFillNote] = useState<string | null>(null);

  function setSimple() {
    onChange({ kind: 'simple' });
  }
  function setUnique(field?: string) {
    onChange({
      kind: 'unique-values',
      field: field ?? (isUnique ? value.field : ''),
      categories: isUnique ? value.categories : [],
    });
  }
  function setBreaks(field?: string) {
    // When switching in, pre-seed with a neutral 3-class ramp so the
    // user sees something immediately; they can replace stops to match
    // their data distribution.
    const colors = sampleRamp(CLASS_BREAK_RAMPS[DEFAULT_CLASS_BREAK_RAMP]!, 4);
    onChange({
      kind: 'class-breaks',
      field: field ?? (isBreaks ? value.field : ''),
      stops: isBreaks && value.stops.length ? value.stops : [33, 66, 100],
      colors: isBreaks && value.colors.length === 4 ? value.colors : colors,
    });
  }

  /**
   * Seed one category per distinct value of the field.
   *
   * The cached `valuesByField` is only populated for layers small
   * enough to have been sampled whole. On a v3 data layer that sample
   * is deliberately skipped, because doing it to the 1.4M-row parcels
   * layer either 500s the endpoint or wedges the browser. So on
   * exactly the layers people most want to symbolize, the cache was
   * empty and this button quietly did nothing: it wrote zero
   * categories and left the "No categories yet" message in place,
   * which reads as broken rather than as unimplemented.
   *
   * `layer-metadata.ts` anticipated this and called for a fetch-on-
   * demand endpoint. The aggregate endpoint is it: grouping by the
   * field returns exactly the distinct values, computed server-side,
   * capped, scoped to what this viewer may read, and ordered by
   * frequency. Frequency order is a bonus rather than an accident:
   * the palette's most distinct colours land on the categories a
   * reader will actually see.
   */
  async function autoPopulate(field: string) {
    const cached = metadata.valuesByField[field] ?? [];
    if (cached.length > 0) {
      applyValues(field, cached);
      return;
    }
    const src = layer.source;
    if (src.kind !== 'data-layer') {
      setFillNote(
        'This layer type does not report its values yet; add categories by hand.',
      );
      return;
    }
    setFilling(true);
    setFillNote(null);
    try {
      const params = new URLSearchParams({
        agg: 'count',
        groupBy: field,
        limit: String(MAX_AUTO_CATEGORIES),
      });
      const res = await fetch(
        `/api/portal/items/${src.itemId}/layers/${src.layerKey ?? ''}` +
          `/aggregate?${params.toString()}`,
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          message?: string | string[];
        } | null;
        const m = body?.message;
        throw new Error(
          (Array.isArray(m) ? m.join('; ') : m) ||
            `Could not read values (HTTP ${res.status}).`,
        );
      }
      const data = (await res.json()) as {
        groups: Array<{ key: Record<string, string | null> }>;
        truncated: boolean;
      };
      const values = data.groups
        .map((g) => g.key[field])
        .filter((v): v is string => typeof v === 'string' && v.length > 0);
      if (values.length === 0) {
        setFillNote('No values found in this field.');
        return;
      }
      applyValues(field, values);
      if (data.truncated) {
        setFillNote(
          `Showing the ${MAX_AUTO_CATEGORIES} most common values; the rest use the fallback colour.`,
        );
      }
    } catch (err) {
      setFillNote(
        err instanceof Error ? err.message : 'Could not read values.',
      );
    } finally {
      setFilling(false);
    }
  }

  function applyValues(field: string, values: string[]) {
    const categories: MapUniqueValueCategory[] = values
      .slice(0, MAX_AUTO_CATEGORIES)
      .map((v, i) => ({
        value: v,
        color: UNIQUE_VALUE_PALETTE[i % UNIQUE_VALUE_PALETTE.length]!,
      }));
    onChange({ kind: 'unique-values', field, categories });
  }

  function patchCategory(idx: number, patch: Partial<MapUniqueValueCategory>) {
    if (!isUnique) return;
    const next = value.categories.map((c, i) => (i === idx ? { ...c, ...patch } : c));
    onChange({ ...value, categories: next });
  }
  function addCategory() {
    if (!isUnique) return;
    onChange({
      ...value,
      categories: [
        ...value.categories,
        {
          value: '',
          color:
            UNIQUE_VALUE_PALETTE[value.categories.length % UNIQUE_VALUE_PALETTE.length]!,
        },
      ],
    });
  }
  function removeCategory(idx: number) {
    if (!isUnique) return;
    onChange({ ...value, categories: value.categories.filter((_, i) => i !== idx) });
  }

  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <ModeBtn
          active={value.kind === 'simple'}
          onClick={setSimple}
          label="Single"
        />
        <ModeBtn
          active={isUnique}
          onClick={() => setUnique()}
          label="By category"
          Icon={Shuffle}
        />
        <ModeBtn
          active={isBreaks}
          onClick={() => setBreaks()}
          label="By range"
          Icon={BarChart3}
        />
      </div>

      {isBreaks ? (
        <ClassBreaksEditor value={value} metadata={metadata} onChange={onChange} />
      ) : null}

      {isUnique ? (
        <div className="space-y-3 rounded-md border border-border bg-surface-1 p-3">
          <div>
            <label className="mb-1 block text-2xs uppercase tracking-wide text-muted">
              Attribute
            </label>
            {metadata.fields.length > 0 ? (
              <div className="flex gap-2">
                <select
                  value={value.field}
                  onChange={(e) => setUnique(e.target.value)}
                  className="h-8 min-w-0 flex-1 rounded border border-border bg-surface-1 px-2 text-xs focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
                >
                  <option value="">Pick a field...</option>
                  {metadata.fields.map((f) => (
                    <option key={f} value={f}>
                      {f}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => {
                    if (value.field) void autoPopulate(value.field);
                  }}
                  disabled={!value.field || filling}
                  className="inline-flex h-8 items-center gap-1 rounded border border-border bg-surface-1 px-2 text-2xs font-medium text-ink-1 hover:bg-surface-2 disabled:opacity-50"
                >
                  {filling ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : null}
                  Auto fill
                </button>
              </div>
            ) : (
              <input
                type="text"
                value={value.field}
                onChange={(e) => setUnique(e.target.value)}
                placeholder="field name"
                className="h-8 w-full rounded border border-border bg-surface-1 px-2 text-xs focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
              />
            )}
            {metadata.loading ? (
              <p className="mt-1 text-2xs text-muted">
                Loading field options...
              </p>
            ) : metadata.error ? (
              <p className="mt-1 text-2xs text-warn">{metadata.error}</p>
            ) : fillNote ? (
              <p className="mt-1 text-2xs text-warn">{fillNote}</p>
            ) : null}
          </div>

          {value.field ? (
            <div>
              <div className="mb-1 flex items-center justify-between">
                <span className="text-2xs uppercase tracking-wide text-muted">
                  Categories
                </span>
                {value.field &&
                (metadata.valuesByField[value.field]?.length ?? 0) >= 64 ? (
                  <span className="text-2xs text-warn">
                    &gt; 64 unique values; showing first 64
                  </span>
                ) : null}
              </div>
              {value.categories.length === 0 ? (
                <div className="rounded border border-dashed border-border px-2 py-3 text-center text-2xs text-muted">
                  No categories yet. Click <strong>Auto fill</strong> above or
                  add rows manually.
                </div>
              ) : (
                <ul className="space-y-1">
                  {value.categories.map((c, i) => (
                    <li key={i} className="flex items-center gap-2">
                      <input
                        type="color"
                        value={c.color}
                        onChange={(e) =>
                          patchCategory(i, { color: e.target.value })
                        }
                        className="h-7 w-8 shrink-0 cursor-pointer rounded border border-border bg-surface-1 p-0.5"
                      />
                      <input
                        type="text"
                        value={c.value}
                        onChange={(e) =>
                          patchCategory(i, { value: e.target.value })
                        }
                        placeholder="value"
                        className="h-7 min-w-0 flex-1 rounded border border-border bg-surface-1 px-2 text-xs focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
                      />
                      {/* #78: optional per-category icon override.
                          v1 ships as a small text input next to the
                          color so authors can type a known icon
                          name (matching what they picked in the
                          layer-level Style editor below). A picker
                          dropdown matching the Style editor's grid
                          is queued as polish; the canvas already
                          renders whatever value lands here so the
                          end-to-end works today. Empty string = no
                          override (falls back to the layer-level
                          icon). */}
                      <input
                        type="text"
                        value={c.iconName ?? ''}
                        onChange={(e) => {
                          const v = e.target.value;
                          // exactOptionalPropertyTypes: rebuild the
                          // category from scratch so an empty input
                          // physically removes the iconName key
                          // (rather than persisting it as the empty
                          // string, which the canvas helper would
                          // treat as "no override" anyway but reads
                          // sloppily).
                          if (!isUnique) return;
                          const next = value.categories.map((c2, ii) => {
                            if (ii !== i) return c2;
                            const rebuilt: MapUniqueValueCategory = {
                              value: c2.value,
                              color: c2.color,
                            };
                            if (v) rebuilt.iconName = v;
                            return rebuilt;
                          });
                          onChange({ ...value, categories: next });
                        }}
                        placeholder="icon (optional)"
                        title="Icon name to render features in this category. Leave empty to inherit the layer's icon."
                        className="h-7 w-28 shrink-0 rounded border border-border bg-surface-1 px-2 text-2xs text-ink-1 focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
                      />
                      <button
                        type="button"
                        onClick={() => removeCategory(i)}
                        aria-label="Remove category"
                        className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted hover:bg-surface-2 hover:text-danger"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <button
                type="button"
                onClick={addCategory}
                className="mt-2 inline-flex h-7 items-center gap-1 rounded text-2xs text-accent hover:underline"
              >
                <Plus className="h-3 w-3" />
                Add category
              </button>
              <p className="mt-1 text-2xs text-muted">
                Features whose value isn&apos;t listed fall back to the single
                color from the style editor below.
              </p>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function ClassBreaksEditor({
  value,
  metadata,
  onChange,
}: {
  value: Extract<MapLayerRenderer, { kind: 'class-breaks' }>;
  metadata: LayerMetadata;
  onChange: (next: MapLayerRenderer) => void;
}) {
  const numericFields = metadata.fields.filter((f) => {
    const vals = metadata.valuesByField[f] ?? [];
    if (vals.length === 0) return true; // can't tell; offer it
    return vals.every((v) => v === '' || !Number.isNaN(Number(v)));
  });

  function resample(stopsCount: number, rampName: string) {
    const colors = sampleRamp(CLASS_BREAK_RAMPS[rampName]!, stopsCount + 1);
    onChange({ ...value, colors });
  }

  function patch(p: Partial<Extract<MapLayerRenderer, { kind: 'class-breaks' }>>) {
    onChange({ ...value, ...p });
  }

  function setStopCount(n: number) {
    if (n < 1 || n > 7) return;
    const nextStops =
      n > value.stops.length
        ? [...value.stops, ...Array(n - value.stops.length).fill(value.stops.at(-1) ?? 1)]
        : value.stops.slice(0, n);
    const colors = sampleRamp(
      CLASS_BREAK_RAMPS[DEFAULT_CLASS_BREAK_RAMP]!,
      n + 1,
    );
    onChange({ ...value, stops: nextStops, colors });
  }

  function updateStop(idx: number, val: string) {
    const n = Number(val);
    if (Number.isNaN(n)) return;
    const next = [...value.stops];
    next[idx] = n;
    patch({ stops: next });
  }

  function updateColor(idx: number, color: string) {
    const next = [...value.colors];
    next[idx] = color;
    patch({ colors: next });
  }

  const currentRamp =
    Object.entries(CLASS_BREAK_RAMPS).find(
      ([, colors]) =>
        JSON.stringify(sampleRamp(colors, value.colors.length)) ===
        JSON.stringify(value.colors),
    )?.[0] ?? 'custom';

  return (
    <div className="space-y-3 rounded-md border border-border bg-surface-1 p-3">
      <div>
        <label className="mb-1 block text-2xs uppercase tracking-wide text-muted">
          Numeric field
        </label>
        {numericFields.length > 0 ? (
          <select
            value={value.field}
            onChange={(e) => patch({ field: e.target.value })}
            className="h-8 w-full rounded border border-border bg-surface-1 px-2 text-xs focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
          >
            <option value="">Pick a field...</option>
            {numericFields.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        ) : (
          <input
            type="text"
            value={value.field}
            onChange={(e) => patch({ field: e.target.value })}
            placeholder="field name"
            className="h-8 w-full rounded border border-border bg-surface-1 px-2 text-xs focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
          />
        )}
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="mb-1 block text-2xs uppercase tracking-wide text-muted">
            Classes
          </label>
          <select
            value={value.stops.length}
            onChange={(e) => setStopCount(Number(e.target.value))}
            className="h-8 w-full rounded border border-border bg-surface-1 px-2 text-xs focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
          >
            {[1, 2, 3, 4, 5, 6, 7].map((n) => (
              <option key={n} value={n}>
                {n + 1}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="mb-1 block text-2xs uppercase tracking-wide text-muted">
            Color ramp
          </label>
          <select
            value={currentRamp === 'custom' ? '' : currentRamp}
            onChange={(e) =>
              e.target.value && resample(value.stops.length, e.target.value)
            }
            className="h-8 w-full rounded border border-border bg-surface-1 px-2 text-xs focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
          >
            {currentRamp === 'custom' ? <option value="">custom</option> : null}
            {Object.keys(CLASS_BREAK_RAMPS).map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div>
        <div className="mb-1 flex items-center justify-between">
          <span className="text-2xs uppercase tracking-wide text-muted">
            Breaks
          </span>
          <span className="text-2xs text-muted">
            {value.colors.length} colors
          </span>
        </div>
        <ul className="space-y-1">
          <ClassRow
            label={value.stops[0] !== undefined ? `< ${value.stops[0]}` : 'all'}
            color={value.colors[0] ?? '#000'}
            onColor={(c) => updateColor(0, c)}
            stop={null}
            onStop={() => {}}
          />
          {value.stops.map((stop, i) => (
            <ClassRow
              key={i}
              label={
                i < value.stops.length - 1
                  ? `${stop} to < ${value.stops[i + 1]}`
                  : `â‰¥ ${stop}`
              }
              color={value.colors[i + 1] ?? '#000'}
              onColor={(c) => updateColor(i + 1, c)}
              stop={stop}
              onStop={(v) => updateStop(i, v)}
            />
          ))}
        </ul>
        <p className="mt-2 text-2xs text-muted">
          Features whose value isn&apos;t numeric fall back to the single
          color below.
        </p>
      </div>
    </div>
  );
}

function ClassRow({
  label,
  color,
  onColor,
  stop,
  onStop,
}: {
  label: string;
  color: string;
  onColor: (c: string) => void;
  stop: number | null;
  onStop: (v: string) => void;
}) {
  return (
    <li className="flex items-center gap-2">
      <input
        type="color"
        value={color}
        onChange={(e) => onColor(e.target.value)}
        className="h-7 w-8 shrink-0 cursor-pointer rounded border border-border bg-surface-1 p-0.5"
      />
      <span className="flex-1 truncate text-2xs text-muted">{label}</span>
      {stop !== null ? (
        <input
          type="number"
          value={stop}
          onChange={(e) => onStop(e.target.value)}
          className="h-7 w-20 shrink-0 rounded border border-border bg-surface-1 px-2 text-xs focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
        />
      ) : (
        <span className="h-7 w-20" />
      )}
    </li>
  );
}

function ModeBtn({
  active,
  onClick,
  label,
  Icon,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  Icon?: typeof Shuffle;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex-1 rounded-md border p-2 text-xs font-medium transition-colors ${
        active
          ? 'border-accent bg-accent/5 text-ink-0 ring-2 ring-accent/30'
          : 'border-border bg-surface-1 text-muted hover:bg-surface-2'
      }`}
    >
      <span className="inline-flex items-center gap-1.5">
        {Icon ? <Icon className="h-3.5 w-3.5" /> : null}
        {label}
      </span>
    </button>
  );
}
