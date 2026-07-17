// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

/**
 * Recipe-action editor for tool items v2 (#90).
 *
 * Surfaces three concerns on the tool detail page:
 *   1. Parameters: the slots authors expose for hardcoded /
 *      runtime-resolved inputs (AOI, target layer, predicate,
 *      distance, ...).
 *   2. Pipeline: the ordered ToolStep recipe that consumes
 *      parameters and produces output rows.  Only spatial-filter is
 *      param-aware in v1; the editor still shows the slot so future
 *      param-aware steps slot in additively.
 *   3. Output: the sink that fires when the recipe finishes.
 *      Selection-on-target-layer is the v1 default; derived-layer
 *      and data-layer sinks light up once the backend lands them.
 *
 * Kept in one file because every section talks to the same
 * RecipeAction blob -- breaking out per-section would just shuffle
 * the same prop drilling around.  Sub-renderers are factored out
 * within the file when one section's UI is non-trivial.
 */

import { useEffect, useMemo, useState } from 'react';
import { Trash2, Plus, Sparkles } from 'lucide-react';
import type {
  DistanceParameter,
  FeatureSourceParameter,
  LengthUnit,
  NumberParameter,
  PredicateParameter,
  RecipeAction,
  SpatialPredicate,
  TextParameter,
  ToolOutput,
  ToolParameter,
  ToolStep,
} from '@gratis-gis/shared-types';
import {
  DEFAULT_TOOL_SELECTION_LIMIT,
  LENGTH_UNITS,
  METERS_PER_UNIT,
  RECIPE_TEMPLATES,
  UNIT_LABELS,
} from '@gratis-gis/shared-types';

const PREDICATE_LABELS: Record<SpatialPredicate, string> = {
  intersects: 'Intersects',
  within: 'Within',
  contains: 'Contains',
  touches: 'Touches',
  near: 'Within distance (near)',
};

const PREDICATES: SpatialPredicate[] = [
  'intersects',
  'within',
  'contains',
  'touches',
  'near',
];

interface Props {
  recipe: RecipeAction;
  canEdit: boolean;
  onChange: (next: RecipeAction) => void;
}

export function RecipeEditor({ recipe, canEdit, onChange }: Props) {
  const labelCls =
    'block text-xs font-medium uppercase tracking-wide text-muted';
  const inputCls =
    'mt-1 w-full rounded-md border border-border bg-surface-0 px-2 py-1.5 text-sm text-ink-0 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30 disabled:opacity-60';

  function setParameters(next: ToolParameter[]) {
    onChange({ ...recipe, parameters: next });
  }
  function setPipeline(next: ToolStep[]) {
    onChange({ ...recipe, pipeline: next });
  }
  function setOutput(next: ToolOutput) {
    onChange({ ...recipe, output: next });
  }

  // A recipe is "empty" when it has no parameters AND no pipeline
  // steps -- the state right after the author switches the action
  // kind to recipe.  We only offer the "Start from template" path
  // in that state so a half-built custom recipe isn't accidentally
  // wiped by the picker.
  const isEmpty = recipe.parameters.length === 0 && recipe.pipeline.length === 0;

  return (
    <div className="space-y-5">
      <p className="rounded-md border border-border bg-surface-2 px-3 py-2 text-xs text-muted">
        A recipe is an on-demand action authors can drop on a map.  At
        run time the user fills in any runtime parameters, the recipe
        executes the pipeline, and the output fires (e.g. updates the
        host map&apos;s selection).
      </p>

      {isEmpty && canEdit && RECIPE_TEMPLATES.length > 0 ? (
        <div className="space-y-2 rounded-md border border-accent/30 bg-accent/5 p-3">
          <div className="flex items-center gap-2 text-sm text-ink-0">
            <Sparkles className="h-4 w-4 text-accent" />
            <span className="font-medium">Start from a template</span>
          </div>
          <p className="text-2xs text-muted">
            Stamp out a working recipe in one click.  You can edit
            anything afterward.
          </p>
          <div className="flex flex-wrap gap-2">
            {RECIPE_TEMPLATES.flatMap((tpl) => {
              // The recipe-editor authors a RecipeAction; stamping
              // a relational-query template into it would round-trip
              // through the wrong action shape.  Skip those here so
              // only generic-recipe templates appear in this picker.
              // The new-tool wizard's tool-picker shows all
              // templates (it picks the right detail-page renderer
              // by action.kind).
              const stamped = tpl.build();
              if (stamped.kind !== 'recipe') return [];
              return [
                <button
                  key={tpl.id}
                  type="button"
                  onClick={() => onChange(stamped)}
                  className="rounded-md border border-border bg-surface-0 px-3 py-2 text-left text-xs hover:border-accent hover:bg-surface-1"
                >
                  <div className="font-medium text-ink-0">{tpl.label}</div>
                  <div className="text-2xs text-muted">{tpl.description}</div>
                </button>,
              ];
            })}
          </div>
        </div>
      ) : null}

      <ParametersSection
        parameters={recipe.parameters}
        canEdit={canEdit}
        onChange={setParameters}
        labelCls={labelCls}
        inputCls={inputCls}
      />

      <PipelineSection
        pipeline={recipe.pipeline}
        parameters={recipe.parameters}
        canEdit={canEdit}
        onChange={setPipeline}
        labelCls={labelCls}
        inputCls={inputCls}
      />

      <OutputSection
        recipe={recipe}
        canEdit={canEdit}
        onChange={onChange}
        labelCls={labelCls}
        inputCls={inputCls}
      />

      <div>
        <label className={labelCls}>Selection cap</label>
        <input
          type="number"
          disabled={!canEdit}
          min={1}
          max={50_000}
          value={recipe.selectionLimit ?? DEFAULT_TOOL_SELECTION_LIMIT}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (!Number.isFinite(v) || v <= 0) return;
            onChange({ ...recipe, selectionLimit: Math.floor(v) });
          }}
          className={inputCls}
        />
        <p className="mt-1 text-2xs text-muted">
          Maximum feature ids returned per run.  The runtime banner
          warns the user when the limit is reached so they know the
          selection is incomplete.
        </p>
      </div>
    </div>
  );
}

// ---- Parameters -----------------------------------------------------------

function ParametersSection({
  parameters,
  canEdit,
  onChange,
  labelCls,
  inputCls,
}: {
  parameters: ToolParameter[];
  canEdit: boolean;
  onChange: (next: ToolParameter[]) => void;
  labelCls: string;
  inputCls: string;
}) {
  function add(kind: ToolParameter['kind']) {
    const seedName = nextParamName(parameters, kind);
    const next: ToolParameter = paramSeed(kind, seedName);
    onChange([...parameters, next]);
  }
  function update(index: number, patch: Partial<ToolParameter>) {
    onChange(
      parameters.map((p, i) =>
        i === index ? ({ ...p, ...patch } as ToolParameter) : p,
      ),
    );
  }
  function remove(index: number) {
    onChange(parameters.filter((_, i) => i !== index));
  }

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-medium text-ink-0">Parameters</h3>
          <p className="text-2xs text-muted">
            Slots the recipe exposes.  A parameter can be hardcoded
            into the tool or filled at run time by the host app /
            end-user.
          </p>
        </div>
        {canEdit ? (
          <div className="flex items-center gap-1">
            <select
              value=""
              onChange={(e) => {
                if (e.target.value) {
                  add(e.target.value as ToolParameter['kind']);
                  e.target.value = '';
                }
              }}
              className="rounded-md border border-border bg-surface-1 px-2 py-1 text-xs text-ink-0"
            >
              <option value="">+ Add parameter</option>
              <option value="feature-source">Feature source (layer / AOI)</option>
              <option value="osm-feature">OSM feature (live query)</option>
              <option value="predicate">Predicate</option>
              <option value="distance">Distance (meters)</option>
              <option value="number">Number</option>
              <option value="text">Text</option>
            </select>
          </div>
        ) : null}
      </div>

      {parameters.length === 0 ? (
        <div className="rounded-md border border-dashed border-border bg-surface-2 px-3 py-4 text-center text-2xs text-muted">
          No parameters yet.  Add at least one so the runtime knows
          which layer to operate on.
        </div>
      ) : (
        <div className="space-y-2">
          {parameters.map((p, i) => (
            <ParameterCard
              key={`${p.name}-${i}`}
              parameter={p}
              canEdit={canEdit}
              onChange={(next) => update(i, next)}
              onRemove={() => remove(i)}
              labelCls={labelCls}
              inputCls={inputCls}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function ParameterCard({
  parameter,
  canEdit,
  onChange,
  onRemove,
  labelCls,
  inputCls,
}: {
  parameter: ToolParameter;
  canEdit: boolean;
  onChange: (next: Partial<ToolParameter>) => void;
  onRemove: () => void;
  labelCls: string;
  inputCls: string;
}) {
  return (
    <div className="rounded-md border border-border bg-surface-2 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className={labelCls}>ID</label>
              <input
                type="text"
                disabled={!canEdit}
                value={parameter.name}
                onChange={(e) =>
                  onChange({ name: e.target.value.replace(/[^a-zA-Z0-9_]/g, '') })
                }
                placeholder="aoi"
                className={`${inputCls} font-mono`}
              />
              <p className="mt-0.5 text-2xs text-muted">
                Internal name.  Auto-filled when you add the
                parameter; change it only if another part of the
                recipe (like the pipeline step&apos;s pickers) needs
                to point at it.
              </p>
            </div>
            <div>
              <label className={labelCls}>Label</label>
              <input
                type="text"
                disabled={!canEdit}
                value={parameter.label}
                onChange={(e) => onChange({ label: e.target.value })}
                placeholder="Area of interest"
                className={inputCls}
              />
            </div>
          </div>
          <div>
            <label className={labelCls}>Hint (optional)</label>
            <input
              type="text"
              disabled={!canEdit}
              value={parameter.hint ?? ''}
              onChange={(e) => {
                const v = e.target.value;
                onChange(v ? { hint: v } : ({ hint: undefined as never } as Partial<ToolParameter>));
              }}
              placeholder="Shown under the field at run time"
              className={inputCls}
            />
          </div>
          <label className="flex items-center gap-2 text-xs text-ink-1">
            <input
              type="checkbox"
              disabled={!canEdit}
              checked={!!parameter.required}
              onChange={(e) => onChange({ required: e.target.checked })}
            />
            Required
          </label>

          <ParameterBindingEditor
            parameter={parameter}
            canEdit={canEdit}
            onChange={onChange}
            labelCls={labelCls}
            inputCls={inputCls}
          />
        </div>
        <div className="flex flex-col items-end gap-2">
          <span className="rounded-full bg-surface-1 px-2 py-0.5 font-mono text-2xs uppercase tracking-wide text-muted">
            {parameter.kind}
          </span>
          {canEdit ? (
            <button
              type="button"
              onClick={onRemove}
              className="rounded-md border border-border bg-surface-1 p-1 text-danger hover:bg-danger/10"
              title="Remove parameter"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function ParameterBindingEditor({
  parameter,
  canEdit,
  onChange,
  labelCls,
  inputCls,
}: {
  parameter: ToolParameter;
  canEdit: boolean;
  onChange: (next: Partial<ToolParameter>) => void;
  labelCls: string;
  inputCls: string;
}) {
  switch (parameter.kind) {
    case 'feature-source':
      return (
        <FeatureSourceBindingEditor
          parameter={parameter}
          canEdit={canEdit}
          onChange={onChange}
          labelCls={labelCls}
          inputCls={inputCls}
        />
      );
    case 'predicate':
      return (
        <PredicateBindingEditor
          parameter={parameter}
          canEdit={canEdit}
          onChange={onChange}
          labelCls={labelCls}
        />
      );
    case 'distance':
      return (
        <DistanceBindingEditor
          parameter={parameter}
          canEdit={canEdit}
          onChange={onChange}
          labelCls={labelCls}
          inputCls={inputCls}
        />
      );
    case 'number':
      return (
        <NumberBindingEditor
          parameter={parameter}
          canEdit={canEdit}
          onChange={onChange}
          labelCls={labelCls}
          inputCls={inputCls}
        />
      );
    case 'text':
      return (
        <TextBindingEditor
          parameter={parameter}
          canEdit={canEdit}
          onChange={onChange}
          labelCls={labelCls}
          inputCls={inputCls}
        />
      );
    case 'osm-feature':
      return (
        <OsmFeatureBindingEditor
          parameter={parameter}
          canEdit={canEdit}
          onChange={onChange}
          labelCls={labelCls}
          inputCls={inputCls}
        />
      );
  }
}

function FeatureSourceBindingEditor({
  parameter,
  canEdit,
  onChange,
  labelCls,
  inputCls,
}: {
  parameter: FeatureSourceParameter;
  canEdit: boolean;
  onChange: (next: Partial<ToolParameter>) => void;
  labelCls: string;
  inputCls: string;
}) {
  const mode = parameter.binding.mode;
  function setMode(next: FeatureSourceParameter['binding']['mode']) {
    let binding: FeatureSourceParameter['binding'];
    if (next === 'hardcoded') {
      binding = { mode: 'hardcoded', value: { kind: 'data_layer', itemId: '' } };
    } else if (next === 'runtime-host') {
      binding = { mode: 'runtime-host' };
    } else if (next === 'runtime-draw') {
      binding = { mode: 'runtime-draw' };
    } else {
      binding = { mode: 'runtime-selection' };
    }
    onChange({ binding });
  }
  return (
    <div className="space-y-2 rounded-md border border-border bg-surface-1 p-2">
      <label className={labelCls}>Binding</label>
      <select
        disabled={!canEdit}
        value={mode}
        onChange={(e) => setMode(e.target.value as typeof mode)}
        className={inputCls}
      >
        <option value="hardcoded">Hardcoded — baked into the tool</option>
        <option value="runtime-host">From host app (auto-binds at runtime)</option>
        <option value="runtime-draw">User draws geometry at run time</option>
        <option value="runtime-selection">Use current selection</option>
      </select>
      {mode === 'hardcoded' ? (
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className={labelCls}>data_layer item id</label>
            <input
              type="text"
              disabled={!canEdit}
              value={parameter.binding.mode === 'hardcoded' ? (parameter.binding.value.itemId ?? '') : ''}
              onChange={(e) => {
                if (parameter.binding.mode !== 'hardcoded') return;
                onChange({
                  binding: {
                    mode: 'hardcoded',
                    value: {
                      ...parameter.binding.value,
                      kind: 'data_layer',
                      itemId: e.target.value.trim(),
                    },
                  },
                });
              }}
              className={`${inputCls} font-mono`}
              placeholder="00000000-..."
            />
          </div>
          <div>
            <label className={labelCls}>Sublayer key (optional)</label>
            <input
              type="text"
              disabled={!canEdit}
              value={parameter.binding.mode === 'hardcoded' ? (parameter.binding.value.layerKey ?? '') : ''}
              onChange={(e) => {
                if (parameter.binding.mode !== 'hardcoded') return;
                const layerKey = e.target.value.trim();
                onChange({
                  binding: {
                    mode: 'hardcoded',
                    value: {
                      ...parameter.binding.value,
                      ...(layerKey ? { layerKey } : { layerKey: undefined }),
                    } as FeatureSourceParameter['binding'] extends { mode: 'hardcoded' }
                      ? { mode: 'hardcoded'; value: import('@gratis-gis/shared-types').FeatureSourceValue }['value']
                      : never,
                  },
                });
              }}
              className={`${inputCls} font-mono`}
              placeholder="default"
            />
          </div>
        </div>
      ) : null}
      <p className="text-2xs text-muted">
        Geometry type:&nbsp;
        <select
          disabled={!canEdit}
          value={parameter.geometryType ?? 'any'}
          onChange={(e) =>
            onChange({
              geometryType: e.target.value as NonNullable<FeatureSourceParameter['geometryType']>,
            })
          }
          className="rounded-md border border-border bg-surface-1 px-2 py-0.5 text-xs"
        >
          <option value="any">Any</option>
          <option value="point">Point</option>
          <option value="line">Line</option>
          <option value="polygon">Polygon</option>
        </select>
      </p>
    </div>
  );
}

function PredicateBindingEditor({
  parameter,
  canEdit,
  onChange,
  labelCls,
}: {
  parameter: PredicateParameter;
  canEdit: boolean;
  onChange: (next: Partial<ToolParameter>) => void;
  labelCls: string;
}) {
  const mode = parameter.binding.mode;
  function setMode(next: 'hardcoded' | 'runtime-pick') {
    let binding: PredicateParameter['binding'];
    if (next === 'hardcoded') {
      binding = { mode: 'hardcoded', value: 'intersects' };
    } else {
      binding = { mode: 'runtime-pick', defaultValue: 'intersects' };
    }
    onChange({ binding });
  }
  return (
    <div className="space-y-2 rounded-md border border-border bg-surface-1 p-2">
      <label className={labelCls}>Binding</label>
      <select
        disabled={!canEdit}
        value={mode}
        onChange={(e) => setMode(e.target.value as 'hardcoded' | 'runtime-pick')}
        className="w-full rounded-md border border-border bg-surface-0 px-2 py-1.5 text-sm"
      >
        <option value="hardcoded">Hardcoded</option>
        <option value="runtime-pick">User picks at run time</option>
      </select>
      <div>
        <label className={labelCls}>
          {mode === 'hardcoded' ? 'Predicate' : 'Default predicate'}
        </label>
        <select
          disabled={!canEdit}
          value={
            mode === 'hardcoded'
              ? parameter.binding.value
              : (parameter.binding as Extract<PredicateParameter['binding'], { mode: 'runtime-pick' }>).defaultValue
          }
          onChange={(e) => {
            const val = e.target.value as SpatialPredicate;
            if (mode === 'hardcoded') {
              onChange({ binding: { mode: 'hardcoded', value: val } });
            } else {
              onChange({
                binding: {
                  mode: 'runtime-pick',
                  defaultValue: val,
                  ...((parameter.binding as Extract<PredicateParameter['binding'], { mode: 'runtime-pick' }>).allowed
                    ? { allowed: (parameter.binding as Extract<PredicateParameter['binding'], { mode: 'runtime-pick' }>).allowed }
                    : {}),
                },
              });
            }
          }}
          className="w-full rounded-md border border-border bg-surface-0 px-2 py-1.5 text-sm"
        >
          {PREDICATES.map((p) => (
            <option key={p} value={p}>
              {PREDICATE_LABELS[p]}
            </option>
          ))}
        </select>
      </div>
      {mode === 'runtime-pick' ? (
        <div>
          <label className={labelCls}>Allowed at run time (leave all checked = all)</label>
          <div className="flex flex-wrap gap-2 pt-1">
            {PREDICATES.map((p) => {
              const allowed =
                (parameter.binding as Extract<PredicateParameter['binding'], { mode: 'runtime-pick' }>).allowed ?? PREDICATES;
              const on = allowed.includes(p);
              return (
                <label key={p} className="flex items-center gap-1 rounded-md border border-border bg-surface-0 px-2 py-0.5 text-2xs">
                  <input
                    type="checkbox"
                    disabled={!canEdit}
                    checked={on}
                    onChange={(e) => {
                      const cur = new Set(allowed);
                      if (e.target.checked) cur.add(p);
                      else cur.delete(p);
                      const next = PREDICATES.filter((x) => cur.has(x));
                      onChange({
                        binding: {
                          mode: 'runtime-pick',
                          defaultValue: (parameter.binding as Extract<PredicateParameter['binding'], { mode: 'runtime-pick' }>).defaultValue,
                          allowed: next,
                        },
                      });
                    }}
                  />
                  {PREDICATE_LABELS[p]}
                </label>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function DistanceBindingEditor({
  parameter,
  canEdit,
  onChange,
  labelCls,
  inputCls,
}: {
  parameter: DistanceParameter;
  canEdit: boolean;
  onChange: (next: Partial<ToolParameter>) => void;
  labelCls: string;
  inputCls: string;
}) {
  const mode = parameter.binding.mode;
  // Display unit; defaults to meters when the parameter doesn't
  // carry one (older recipes saved before this field existed).
  const unit: LengthUnit = parameter.unit ?? 'meters';
  const factor = METERS_PER_UNIT[unit];

  // Convert stored meters into the chosen unit for display.
  const displayValue =
    mode === 'hardcoded'
      ? parameter.binding.meters / factor
      : (parameter.binding as Extract<DistanceParameter['binding'], { mode: 'runtime-input' }>).defaultMeters / factor;

  function setMode(next: 'hardcoded' | 'runtime-input') {
    let binding: DistanceParameter['binding'];
    if (next === 'hardcoded') {
      binding = { mode: 'hardcoded', meters: 100 };
    } else {
      binding = { mode: 'runtime-input', defaultMeters: 100 };
    }
    onChange({ binding });
  }
  function setUnit(next: LengthUnit) {
    // Storage stays in meters; only the display unit changes.
    onChange({ unit: next });
  }
  function setDisplayValue(raw: number) {
    if (!Number.isFinite(raw) || raw < 0) return;
    const meters = raw * factor;
    if (mode === 'hardcoded') {
      onChange({ binding: { mode: 'hardcoded', meters } });
    } else {
      const cur = parameter.binding as Extract<DistanceParameter['binding'], { mode: 'runtime-input' }>;
      onChange({
        binding: {
          mode: 'runtime-input',
          defaultMeters: meters,
          ...(cur.minMeters !== undefined ? { minMeters: cur.minMeters } : {}),
          ...(cur.maxMeters !== undefined ? { maxMeters: cur.maxMeters } : {}),
        },
      });
    }
  }
  return (
    <div className="space-y-2 rounded-md border border-border bg-surface-1 p-2">
      <label className={labelCls}>Binding</label>
      <select
        disabled={!canEdit}
        value={mode}
        onChange={(e) => setMode(e.target.value as 'hardcoded' | 'runtime-input')}
        className={inputCls}
      >
        <option value="hardcoded">Hardcoded value</option>
        <option value="runtime-input">User types at run time</option>
      </select>
      <div>
        <label className={labelCls}>
          {mode === 'hardcoded' ? 'Distance' : 'Default distance'}
        </label>
        <div className="mt-1 flex gap-2">
          <input
            type="number"
            disabled={!canEdit}
            min={0}
            step="any"
            value={Number.isFinite(displayValue) ? displayValue : 0}
            onChange={(e) => setDisplayValue(Number(e.target.value))}
            className={`${inputCls} flex-1`}
          />
          <select
            disabled={!canEdit}
            value={unit}
            onChange={(e) => setUnit(e.target.value as LengthUnit)}
            className="rounded-md border border-border bg-surface-0 px-2 py-1.5 text-sm"
          >
            {LENGTH_UNITS.map((u) => (
              <option key={u} value={u}>
                {UNIT_LABELS[u]}
              </option>
            ))}
          </select>
        </div>
        <p className="mt-1 text-2xs text-muted">
          Stored internally in meters so the recipe runner doesn&apos;t
          have to convert; you only see + edit in the unit picked
          here.  The end-user can still flip to a different unit at
          run time.
        </p>
      </div>
    </div>
  );
}

function NumberBindingEditor({
  parameter,
  canEdit,
  onChange,
  labelCls,
  inputCls,
}: {
  parameter: NumberParameter;
  canEdit: boolean;
  onChange: (next: Partial<ToolParameter>) => void;
  labelCls: string;
  inputCls: string;
}) {
  const mode = parameter.binding.mode;
  function setMode(next: 'hardcoded' | 'runtime-input') {
    let binding: NumberParameter['binding'];
    if (next === 'hardcoded') {
      binding = { mode: 'hardcoded', value: 0 };
    } else {
      binding = { mode: 'runtime-input', defaultValue: 0 };
    }
    onChange({ binding });
  }
  return (
    <div className="space-y-2 rounded-md border border-border bg-surface-1 p-2">
      <label className={labelCls}>Binding</label>
      <select
        disabled={!canEdit}
        value={mode}
        onChange={(e) => setMode(e.target.value as 'hardcoded' | 'runtime-input')}
        className={inputCls}
      >
        <option value="hardcoded">Hardcoded number</option>
        <option value="runtime-input">User types at run time</option>
      </select>
      <div>
        <label className={labelCls}>
          {mode === 'hardcoded' ? 'Value' : 'Default value'}
        </label>
        <input
          type="number"
          disabled={!canEdit}
          value={
            mode === 'hardcoded'
              ? parameter.binding.value
              : (parameter.binding as Extract<NumberParameter['binding'], { mode: 'runtime-input' }>).defaultValue
          }
          onChange={(e) => {
            const n = Number(e.target.value);
            if (!Number.isFinite(n)) return;
            if (mode === 'hardcoded') {
              onChange({ binding: { mode: 'hardcoded', value: n } });
            } else {
              onChange({ binding: { mode: 'runtime-input', defaultValue: n } });
            }
          }}
          className={inputCls}
        />
      </div>
    </div>
  );
}

function TextBindingEditor({
  parameter,
  canEdit,
  onChange,
  labelCls,
  inputCls,
}: {
  parameter: TextParameter;
  canEdit: boolean;
  onChange: (next: Partial<ToolParameter>) => void;
  labelCls: string;
  inputCls: string;
}) {
  const mode = parameter.binding.mode;
  function setMode(next: 'hardcoded' | 'runtime-input') {
    let binding: TextParameter['binding'];
    if (next === 'hardcoded') {
      binding = { mode: 'hardcoded', value: '' };
    } else {
      binding = { mode: 'runtime-input' };
    }
    onChange({ binding });
  }
  return (
    <div className="space-y-2 rounded-md border border-border bg-surface-1 p-2">
      <label className={labelCls}>Binding</label>
      <select
        disabled={!canEdit}
        value={mode}
        onChange={(e) => setMode(e.target.value as 'hardcoded' | 'runtime-input')}
        className={inputCls}
      >
        <option value="hardcoded">Hardcoded text</option>
        <option value="runtime-input">User types at run time</option>
      </select>
      <div>
        <label className={labelCls}>
          {mode === 'hardcoded' ? 'Value' : 'Default value'}
        </label>
        <input
          type="text"
          disabled={!canEdit}
          value={
            mode === 'hardcoded'
              ? parameter.binding.value
              : ((parameter.binding as Extract<TextParameter['binding'], { mode: 'runtime-input' }>).defaultValue ?? '')
          }
          onChange={(e) => {
            const v = e.target.value;
            if (mode === 'hardcoded') {
              onChange({ binding: { mode: 'hardcoded', value: v } });
            } else {
              onChange({ binding: { mode: 'runtime-input', ...(v ? { defaultValue: v } : {}) } });
            }
          }}
          className={inputCls}
        />
      </div>
    </div>
  );
}

/**
 * OSM-feature parameter binding editor (#OSM).  Authors choose
 * between two modes:
 *
 *   - Hardcoded: bake in a set of preset ids + optional tag
 *     filters.  Used when the tool is dedicated to one specific
 *     OSM lookup ("Find pharmacies near my facility").  At
 *     runtime the user just provides AOI + distance.
 *
 *   - Runtime-pick: end-user picks at run time which presets to
 *     query + (optionally) adds tag filters.  The flexible
 *     guided-query mode that drives "Show me [user picks: gas
 *     stations] (filter: brand=Citgo) within 1 mile".  Author
 *     restricts via allowedPresetIds + allowCustomTagFilters
 *     toggles.
 *
 * The picker UI for picking actual presets (1,600+ of them) is the
 * shared <OsmPresetMultiSelect>; the binding editor wraps it with
 * the binding-mode chrome and the tag-filter row editor.
 */
function OsmFeatureBindingEditor({
  parameter,
  canEdit,
  onChange,
  labelCls,
  inputCls,
}: {
  parameter: Extract<ToolParameter, { kind: 'osm-feature' }>;
  canEdit: boolean;
  onChange: (next: Partial<ToolParameter>) => void;
  labelCls: string;
  inputCls: string;
}) {
  const mode = parameter.binding.mode;
  function setMode(next: 'hardcoded' | 'runtime-pick') {
    if (next === mode) return;
    if (next === 'hardcoded') {
      onChange({ binding: { mode: 'hardcoded', presetIds: [] } });
    } else {
      onChange({
        binding: { mode: 'runtime-pick', allowCustomTagFilters: true },
      });
    }
  }
  return (
    <div className="space-y-2 rounded-md border border-border bg-surface-1 p-2">
      <label className={labelCls}>Binding</label>
      <select
        disabled={!canEdit}
        value={mode}
        onChange={(e) => setMode(e.target.value as 'hardcoded' | 'runtime-pick')}
        className={inputCls}
      >
        <option value="hardcoded">Hardcoded — author picks now</option>
        <option value="runtime-pick">User picks at run time</option>
      </select>
      {mode === 'hardcoded' ? (
        <HardcodedOsmBindingFields
          binding={parameter.binding as Extract<typeof parameter.binding, { mode: 'hardcoded' }>}
          canEdit={canEdit}
          onChange={(b) => onChange({ binding: b })}
          labelCls={labelCls}
          inputCls={inputCls}
        />
      ) : (
        <RuntimePickOsmBindingFields
          binding={parameter.binding as Extract<typeof parameter.binding, { mode: 'runtime-pick' }>}
          canEdit={canEdit}
          onChange={(b) => onChange({ binding: b })}
          labelCls={labelCls}
          inputCls={inputCls}
        />
      )}
    </div>
  );
}

function HardcodedOsmBindingFields({
  binding,
  canEdit,
  onChange,
  labelCls,
  inputCls,
}: {
  binding: { mode: 'hardcoded'; presetIds: string[]; tagFilters?: Array<{ key: string; value: string }> };
  canEdit: boolean;
  onChange: (next: typeof binding) => void;
  labelCls: string;
  inputCls: string;
}) {
  return (
    <>
      <div>
        <label className={labelCls}>Presets to query</label>
        <OsmPresetMultiSelect
          selected={binding.presetIds}
          canEdit={canEdit}
          onChange={(presetIds) => onChange({ ...binding, presetIds })}
        />
      </div>
      <div>
        <label className={labelCls}>Tag filters (optional)</label>
        <OsmTagFilterRows
          filters={binding.tagFilters ?? []}
          canEdit={canEdit}
          onChange={(tagFilters) =>
            onChange({
              ...binding,
              ...(tagFilters.length > 0 ? { tagFilters } : { tagFilters: undefined as never }),
            })
          }
          labelCls={labelCls}
          inputCls={inputCls}
        />
      </div>
    </>
  );
}

function RuntimePickOsmBindingFields({
  binding,
  canEdit,
  onChange,
  labelCls,
  inputCls,
}: {
  binding: {
    mode: 'runtime-pick';
    defaultPresetIds?: string[];
    defaultTagFilters?: Array<{ key: string; value: string }>;
    allowedCategories?: string[];
    allowedPresetIds?: string[];
    allowCustomTagFilters?: boolean;
  };
  canEdit: boolean;
  onChange: (next: typeof binding) => void;
  labelCls: string;
  inputCls: string;
}) {
  const allowFilters = binding.allowCustomTagFilters !== false;
  return (
    <>
      <div>
        <label className={labelCls}>Default presets (optional)</label>
        <OsmPresetMultiSelect
          selected={binding.defaultPresetIds ?? []}
          canEdit={canEdit}
          onChange={(ids) =>
            onChange({
              ...binding,
              ...(ids.length > 0
                ? { defaultPresetIds: ids }
                : { defaultPresetIds: undefined as never }),
            })
          }
        />
        <p className="mt-1 text-2xs text-muted">
          Seeded into the runtime picker.  The user can still change
          their picks unless you restrict via the allowlist below.
        </p>
      </div>
      <div>
        <label className={labelCls}>Limit user to these preset ids (optional)</label>
        <OsmPresetMultiSelect
          selected={binding.allowedPresetIds ?? []}
          canEdit={canEdit}
          onChange={(ids) =>
            onChange({
              ...binding,
              ...(ids.length > 0
                ? { allowedPresetIds: ids }
                : { allowedPresetIds: undefined as never }),
            })
          }
        />
        <p className="mt-1 text-2xs text-muted">
          Leave empty to allow any preset.  Add entries to narrow
          the runtime picker (e.g. only food + drink).
        </p>
      </div>
      <label className="flex items-center gap-2 text-xs text-ink-1">
        <input
          type="checkbox"
          disabled={!canEdit}
          checked={allowFilters}
          onChange={(e) =>
            onChange({ ...binding, allowCustomTagFilters: e.target.checked })
          }
        />
        Allow user to add tag filters at run time
      </label>
      {allowFilters ? (
        <div>
          <label className={labelCls}>Default tag filters (optional)</label>
          <OsmTagFilterRows
            filters={binding.defaultTagFilters ?? []}
            canEdit={canEdit}
            onChange={(tagFilters) =>
              onChange({
                ...binding,
                ...(tagFilters.length > 0
                  ? { defaultTagFilters: tagFilters }
                  : { defaultTagFilters: undefined as never }),
              })
            }
            labelCls={labelCls}
            inputCls={inputCls}
          />
        </div>
      ) : null}
    </>
  );
}

/**
 * Search + multi-select picker over the vendored iD preset catalog.
 * Loads the catalog from the dedicated `/api/portal/public/osm/presets`
 * endpoint the next commit ships; until then, the picker shows a
 * "(catalog loading)" hint and falls back to a free-text input the
 * author can type known preset ids into.  Author flow: type to
 * filter, click to add, click an existing chip to remove.
 *
 * The catalog is ~1MB; this component lazy-loads it on mount so the
 * recipe editor's first paint isn't paying for an OSM picker the
 * user might never open.
 */
function OsmPresetMultiSelect({
  selected,
  canEdit,
  onChange,
}: {
  selected: string[];
  canEdit: boolean;
  onChange: (next: string[]) => void;
}) {
  const [catalog, setCatalog] = useState<Array<{ id: string; label: string; category: string }> | null>(null);
  const [query, setQuery] = useState('');

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
        const body = (await res.json()) as {
          presets: Array<{ id: string; label: string; category: string }>;
        };
        if (!cancelled) setCatalog(body.presets ?? []);
      } catch {
        if (!cancelled) setCatalog([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const matches = useMemo(() => {
    if (!catalog || query.trim().length < 2) return [];
    const q = query.trim().toLowerCase();
    const sel = new Set(selected);
    const hits: Array<{ id: string; label: string; category: string }> = [];
    for (const p of catalog) {
      if (sel.has(p.id)) continue;
      if (
        p.label.toLowerCase().includes(q) ||
        p.id.toLowerCase().includes(q) ||
        p.category.toLowerCase().includes(q)
      ) {
        hits.push(p);
        if (hits.length >= 20) break;
      }
    }
    return hits;
  }, [catalog, query, selected]);

  return (
    <div className="space-y-1.5">
      {selected.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {selected.map((id) => {
            const p = catalog?.find((x) => x.id === id);
            return (
              <span
                key={id}
                className="inline-flex items-center gap-1 rounded-full border border-border bg-surface-0 px-2 py-0.5 text-2xs"
              >
                {p?.label ?? id}
                {canEdit ? (
                  <button
                    type="button"
                    onClick={() => onChange(selected.filter((x) => x !== id))}
                    className="text-muted hover:text-danger"
                    aria-label={`Remove ${p?.label ?? id}`}
                  >
                    ×
                  </button>
                ) : null}
              </span>
            );
          })}
        </div>
      ) : null}
      <input
        type="text"
        value={query}
        disabled={!canEdit}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={
          catalog === null
            ? 'Loading OSM preset catalog…'
            : 'Type to search (e.g. "fuel", "restaurant", "school")'
        }
        className="w-full rounded-md border border-border bg-surface-0 px-2 py-1.5 text-sm"
      />
      {matches.length > 0 ? (
        <div className="max-h-40 overflow-y-auto rounded-md border border-border bg-surface-0">
          {matches.map((p) => (
            <button
              type="button"
              key={p.id}
              onClick={() => {
                onChange([...selected, p.id]);
                setQuery('');
              }}
              className="block w-full px-2 py-1 text-left text-xs hover:bg-surface-2"
            >
              <span className="font-medium text-ink-0">{p.label}</span>
              <span className="ml-2 text-2xs text-muted">{p.category}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Add / remove key=value tag filter rows.  Used by both the
 * hardcoded and runtime-pick OSM-feature binding editors.  Pure
 * controlled component; the parent owns the filters array.
 */
function OsmTagFilterRows({
  filters,
  canEdit,
  onChange,
  labelCls: _labelCls,
  inputCls,
}: {
  filters: Array<{ key: string; value: string }>;
  canEdit: boolean;
  onChange: (next: Array<{ key: string; value: string }>) => void;
  labelCls: string;
  inputCls: string;
}) {
  void _labelCls;
  function set(index: number, patch: Partial<{ key: string; value: string }>) {
    onChange(filters.map((f, i) => (i === index ? { ...f, ...patch } : f)));
  }
  function add() {
    onChange([...filters, { key: '', value: '' }]);
  }
  function remove(index: number) {
    onChange(filters.filter((_, i) => i !== index));
  }
  return (
    <div className="space-y-1.5">
      {filters.map((f, i) => (
        <div key={i} className="flex gap-1.5">
          <input
            type="text"
            disabled={!canEdit}
            value={f.key}
            onChange={(e) => set(i, { key: e.target.value.trim() })}
            placeholder="key (e.g. brand)"
            className={`${inputCls} flex-1 font-mono text-xs`}
          />
          <span className="self-center text-muted">=</span>
          <input
            type="text"
            disabled={!canEdit}
            value={f.value}
            onChange={(e) => set(i, { value: e.target.value })}
            placeholder="value (e.g. Citgo)"
            className={`${inputCls} flex-1 font-mono text-xs`}
          />
          {canEdit ? (
            <button
              type="button"
              onClick={() => remove(i)}
              className="rounded-md border border-border bg-surface-1 px-2 text-2xs text-danger hover:bg-danger/10"
            >
              <Trash2 className="h-3 w-3" />
            </button>
          ) : null}
        </div>
      ))}
      {canEdit ? (
        <button
          type="button"
          onClick={add}
          className="inline-flex items-center gap-1 rounded-md border border-dashed border-border bg-surface-2 px-2 py-1 text-2xs text-ink-1 hover:bg-surface-1"
        >
          <Plus className="h-3 w-3" />
          Add filter
        </button>
      ) : null}
    </div>
  );
}

// ---- Pipeline -------------------------------------------------------------

function PipelineSection({
  pipeline,
  parameters,
  canEdit,
  onChange,
  labelCls,
  inputCls,
}: {
  pipeline: ToolStep[];
  parameters: ToolParameter[];
  canEdit: boolean;
  onChange: (next: ToolStep[]) => void;
  labelCls: string;
  inputCls: string;
}) {
  function addStep(kind: ToolStep['tool']) {
    if (kind === 'spatial-filter') {
      onChange([
        ...pipeline,
        {
          tool: 'spatial-filter',
          params: {
            otherSource: { kind: 'data_layer', itemId: '' },
            predicate: { kind: 'fixed', value: 'intersects' },
          },
        },
      ]);
    }
  }
  function update(index: number, next: ToolStep) {
    onChange(pipeline.map((s, i) => (i === index ? next : s)));
  }
  function remove(index: number) {
    onChange(pipeline.filter((_, i) => i !== index));
  }

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-medium text-ink-0">Pipeline</h3>
          <p className="text-2xs text-muted">
            Ordered steps that run when the recipe executes.  Each
            step&apos;s output feeds the next.
          </p>
        </div>
        {canEdit ? (
          <select
            value=""
            onChange={(e) => {
              if (e.target.value) {
                addStep(e.target.value as ToolStep['tool']);
                e.target.value = '';
              }
            }}
            className="rounded-md border border-border bg-surface-1 px-2 py-1 text-xs text-ink-0"
          >
            <option value="">+ Add step</option>
            <option value="spatial-filter">Spatial filter</option>
          </select>
        ) : null}
      </div>
      {pipeline.length === 0 ? (
        <div className="rounded-md border border-dashed border-border bg-surface-2 px-3 py-4 text-center text-2xs text-muted">
          No steps yet.  Add a Spatial filter to build a
          Select-By-Location-style recipe.
        </div>
      ) : (
        <div className="space-y-2">
          {pipeline.map((step, i) => (
            <StepCard
              key={`${step.tool}-${i}`}
              step={step}
              parameters={parameters}
              canEdit={canEdit}
              onChange={(next) => update(i, next)}
              onRemove={() => remove(i)}
              labelCls={labelCls}
              inputCls={inputCls}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function StepCard({
  step,
  parameters,
  canEdit,
  onChange,
  onRemove,
  labelCls,
  inputCls,
}: {
  step: ToolStep;
  parameters: ToolParameter[];
  canEdit: boolean;
  onChange: (next: ToolStep) => void;
  onRemove: () => void;
  labelCls: string;
  inputCls: string;
}) {
  return (
    <div className="rounded-md border border-border bg-surface-2 p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="font-mono text-2xs uppercase tracking-wide text-muted">
          {step.tool}
        </span>
        {canEdit ? (
          <button
            type="button"
            onClick={onRemove}
            className="rounded-md border border-border bg-surface-1 p-1 text-danger hover:bg-danger/10"
            title="Remove step"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </div>
      {step.tool === 'spatial-filter' ? (
        <SpatialFilterStepEditor
          step={step}
          parameters={parameters}
          canEdit={canEdit}
          onChange={onChange}
          labelCls={labelCls}
          inputCls={inputCls}
        />
      ) : (
        <p className="text-2xs text-muted">
          {step.tool} editing is not yet wired into the recipe
          designer.  Edit the JSON via the API if you need it
          before the editor lands.
        </p>
      )}
    </div>
  );
}

function SpatialFilterStepEditor({
  step,
  parameters,
  canEdit,
  onChange,
  labelCls,
  inputCls,
}: {
  step: Extract<ToolStep, { tool: 'spatial-filter' }>;
  parameters: ToolParameter[];
  canEdit: boolean;
  onChange: (next: ToolStep) => void;
  labelCls: string;
  inputCls: string;
}) {
  const featureSourceParams = parameters.filter(
    (p): p is FeatureSourceParameter => p.kind === 'feature-source',
  );
  const predicateParams = parameters.filter(
    (p): p is PredicateParameter => p.kind === 'predicate',
  );
  const distanceParams = parameters.filter(
    (p): p is DistanceParameter => p.kind === 'distance',
  );

  const otherSource = step.params.otherSource;
  const predicate = step.params.predicate;
  const distance = step.params.distance;

  function patch(patch: Partial<typeof step.params>) {
    onChange({
      tool: 'spatial-filter',
      params: { ...step.params, ...patch },
    });
  }

  // ---- other-source row -------------------------------------------------
  const otherSourceKind =
    otherSource.kind === 'parameter' ? 'parameter' : 'data_layer';

  // ---- predicate row ----------------------------------------------------
  const predicateKind = predicate.kind === 'parameter' ? 'parameter' : 'fixed';

  // ---- distance row -----------------------------------------------------
  const distanceKind =
    !distance ? undefined : distance.kind === 'parameter' ? 'parameter' : 'fixed';

  return (
    <div className="space-y-3">
      <div>
        <label className={labelCls}>Other source (filter against)</label>
        <div className="mt-1 flex gap-2">
          <select
            disabled={!canEdit}
            value={otherSourceKind}
            onChange={(e) => {
              const next = e.target.value;
              if (next === 'parameter') {
                patch({
                  otherSource: {
                    kind: 'parameter',
                    name: featureSourceParams[0]?.name ?? '',
                  },
                });
              } else {
                patch({ otherSource: { kind: 'data_layer', itemId: '' } });
              }
            }}
            className="rounded-md border border-border bg-surface-1 px-2 py-1.5 text-sm"
          >
            <option value="data_layer">Pick a layer</option>
            <option value="parameter">Use a parameter</option>
          </select>
          {otherSource.kind === 'parameter' ? (
            <select
              disabled={!canEdit}
              value={otherSource.name}
              onChange={(e) => patch({ otherSource: { kind: 'parameter', name: e.target.value } })}
              className="flex-1 rounded-md border border-border bg-surface-1 px-2 py-1.5 text-sm"
            >
              <option value="">(pick a parameter)</option>
              {featureSourceParams.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.label} — {p.name}
                </option>
              ))}
            </select>
          ) : (
            <input
              type="text"
              disabled={!canEdit}
              value={(otherSource as { itemId?: string }).itemId ?? ''}
              onChange={(e) =>
                patch({
                  otherSource: {
                    kind: 'data_layer',
                    itemId: e.target.value.trim(),
                  },
                })
              }
              placeholder="data_layer item id"
              className={`${inputCls} flex-1 font-mono`}
            />
          )}
        </div>
      </div>

      <div>
        <label className={labelCls}>Predicate</label>
        <div className="mt-1 flex gap-2">
          <select
            disabled={!canEdit}
            value={predicateKind}
            onChange={(e) => {
              const next = e.target.value;
              if (next === 'parameter') {
                patch({
                  predicate: {
                    kind: 'parameter',
                    name: predicateParams[0]?.name ?? '',
                  },
                });
              } else {
                patch({ predicate: { kind: 'fixed', value: 'intersects' } });
              }
            }}
            className="rounded-md border border-border bg-surface-1 px-2 py-1.5 text-sm"
          >
            <option value="fixed">Hardcoded</option>
            <option value="parameter">Use a parameter</option>
          </select>
          {predicate.kind === 'parameter' ? (
            <select
              disabled={!canEdit}
              value={predicate.name}
              onChange={(e) => patch({ predicate: { kind: 'parameter', name: e.target.value } })}
              className="flex-1 rounded-md border border-border bg-surface-1 px-2 py-1.5 text-sm"
            >
              <option value="">(pick a parameter)</option>
              {predicateParams.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.label} — {p.name}
                </option>
              ))}
            </select>
          ) : (
            <select
              disabled={!canEdit}
              value={predicate.value}
              onChange={(e) => patch({ predicate: { kind: 'fixed', value: e.target.value as SpatialPredicate } })}
              className="flex-1 rounded-md border border-border bg-surface-1 px-2 py-1.5 text-sm"
            >
              {PREDICATES.map((p) => (
                <option key={p} value={p}>
                  {PREDICATE_LABELS[p]}
                </option>
              ))}
            </select>
          )}
        </div>
      </div>

      <div>
        <label className={labelCls}>Distance (only used when predicate is &quot;near&quot;)</label>
        <div className="mt-1 flex gap-2">
          <select
            disabled={!canEdit}
            value={distanceKind ?? 'none'}
            onChange={(e) => {
              const next = e.target.value;
              if (next === 'none') {
                // exactOptionalPropertyTypes: we can't set distance
                // to undefined; rebuild the step without the key.
                const { distance: _unused, ...rest } = step.params;
                onChange({ tool: 'spatial-filter', params: rest });
              } else if (next === 'parameter') {
                patch({
                  distance: {
                    kind: 'parameter',
                    name: distanceParams[0]?.name ?? '',
                  },
                });
              } else {
                patch({ distance: { kind: 'fixed', meters: 100 } });
              }
            }}
            className="rounded-md border border-border bg-surface-1 px-2 py-1.5 text-sm"
          >
            <option value="none">No distance</option>
            <option value="fixed">Hardcoded meters</option>
            <option value="parameter">Use a parameter</option>
          </select>
          {distance && distance.kind === 'parameter' ? (
            <select
              disabled={!canEdit}
              value={distance.name}
              onChange={(e) => patch({ distance: { kind: 'parameter', name: e.target.value } })}
              className="flex-1 rounded-md border border-border bg-surface-1 px-2 py-1.5 text-sm"
            >
              <option value="">(pick a parameter)</option>
              {distanceParams.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.label} — {p.name}
                </option>
              ))}
            </select>
          ) : distance && distance.kind === 'fixed' ? (
            <input
              type="number"
              disabled={!canEdit}
              min={0}
              value={distance.meters}
              onChange={(e) => {
                const n = Number(e.target.value);
                if (!Number.isFinite(n)) return;
                patch({ distance: { kind: 'fixed', meters: n } });
              }}
              className={`${inputCls} flex-1`}
            />
          ) : (
            <div className="flex-1" />
          )}
        </div>
      </div>
    </div>
  );
}

// ---- Output ---------------------------------------------------------------

function OutputSection({
  recipe,
  canEdit,
  onChange,
  labelCls,
  inputCls,
}: {
  recipe: RecipeAction;
  canEdit: boolean;
  onChange: (next: RecipeAction) => void;
  labelCls: string;
  inputCls: string;
}) {
  const parameters = recipe.parameters;
  const output = recipe.output;
  const featureSourceParams = parameters.filter(
    (p): p is FeatureSourceParameter => p.kind === 'feature-source',
  );
  const osmFeatureParams = parameters.filter(
    (p) => p.kind === 'osm-feature',
  );

  function setOutput(next: ToolOutput) {
    onChange({ ...recipe, output: next });
  }
  function setSourceRef(next: string | undefined) {
    if (next === undefined || next.length === 0) {
      const { sourceParameterRef: _u, ...rest } = recipe;
      onChange(rest);
    } else {
      onChange({ ...recipe, sourceParameterRef: next });
    }
  }
  function setAoiRef(next: string | undefined) {
    if (next === undefined || next.length === 0) {
      const { aoiParameterRef: _u, ...rest } = recipe;
      onChange(rest);
    } else {
      onChange({ ...recipe, aoiParameterRef: next });
    }
  }

  return (
    <section className="space-y-3">
      <h3 className="text-sm font-medium text-ink-0">Output</h3>
      <p className="text-2xs text-muted">
        What happens when the recipe finishes.  Selection updates the
        host map&apos;s selection state on the chosen target layer.
        OSM overlay renders OSM features the user picked on top of
        the host map (attribution baked in).
      </p>
      <div>
        <label className={labelCls}>Sink</label>
        <select
          disabled={!canEdit}
          value={output.kind}
          onChange={(e) => {
            const next = e.target.value as ToolOutput['kind'];
            if (next === 'selection') {
              setOutput({ kind: 'selection', targetParameterRef: featureSourceParams[0]?.name ?? '' });
            } else if (next === 'osm-features-overlay') {
              setOutput({ kind: 'osm-features-overlay' });
              // Auto-seed sourceParameterRef + aoiParameterRef when
              // the recipe already has the right shape so authors
              // don't have to click two more dropdowns after picking
              // the sink.  Idempotent: only sets when the field is
              // empty.
              if (!recipe.sourceParameterRef && osmFeatureParams[0]) {
                setSourceRef(osmFeatureParams[0].name);
              }
              if (!recipe.aoiParameterRef && featureSourceParams[0]) {
                setAoiRef(featureSourceParams[0].name);
              }
            } else if (next === 'derived-layer') {
              setOutput({ kind: 'derived-layer', titleTemplate: 'Result of {{toolName}}' });
            } else {
              setOutput({ kind: 'data-layer', titleTemplate: 'Result of {{toolName}}' });
            }
          }}
          className={inputCls}
        >
          <option value="selection">Selection (transient)</option>
          <option value="osm-features-overlay">OSM features on map</option>
          <option value="derived-layer" disabled>
            Derived layer — coming soon
          </option>
          <option value="data-layer" disabled>
            Data layer (materialise) — coming soon
          </option>
        </select>
      </div>
      {output.kind === 'selection' ? (
        <div>
          <label className={labelCls}>Target layer parameter</label>
          <select
            disabled={!canEdit}
            value={output.targetParameterRef}
            onChange={(e) =>
              setOutput({ kind: 'selection', targetParameterRef: e.target.value })
            }
            className={inputCls}
          >
            <option value="">(pick a feature-source parameter)</option>
            {featureSourceParams.map((p) => (
              <option key={p.name} value={p.name}>
                {p.label} — {p.name}
              </option>
            ))}
          </select>
          <p className="mt-1 text-2xs text-muted">
            Selection is applied on this parameter&apos;s layer.  Only
            feature-source parameters appear in the list because
            other kinds don&apos;t identify a layer.
          </p>
        </div>
      ) : output.kind === 'osm-features-overlay' ? (
        <div className="space-y-2">
          <div>
            <label className={labelCls}>OSM source parameter</label>
            <select
              disabled={!canEdit}
              value={recipe.sourceParameterRef ?? ''}
              onChange={(e) => setSourceRef(e.target.value || undefined)}
              className={inputCls}
            >
              <option value="">(pick an osm-feature parameter)</option>
              {osmFeatureParams.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.label} — {p.name}
                </option>
              ))}
            </select>
            <p className="mt-1 text-2xs text-muted">
              The OSM-feature parameter whose preset / tag-filter
              picks drive the Overpass query.  Required.
            </p>
          </div>
          <div>
            <label className={labelCls}>Area of interest parameter</label>
            <select
              disabled={!canEdit}
              value={recipe.aoiParameterRef ?? ''}
              onChange={(e) => setAoiRef(e.target.value || undefined)}
              className={inputCls}
            >
              <option value="">(pick a feature-source parameter)</option>
              {featureSourceParams.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.label} — {p.name}
                </option>
              ))}
            </select>
            <p className="mt-1 text-2xs text-muted">
              The Overpass call is bounded by this parameter&apos;s
              bbox (padded by any distance parameter).  v1 supports
              drawn AOIs; layer / selection AOIs land in wave 2.
            </p>
          </div>
        </div>
      ) : null}
    </section>
  );
}

// ---- Helpers --------------------------------------------------------------

function nextParamName(existing: ToolParameter[], kind: ToolParameter['kind']): string {
  const base = paramNameBase(kind);
  const taken = new Set(existing.map((p) => p.name));
  if (!taken.has(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}_${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}_${Date.now()}`;
}

function paramNameBase(kind: ToolParameter['kind']): string {
  switch (kind) {
    case 'feature-source':
      return 'layer';
    case 'predicate':
      return 'predicate';
    case 'distance':
      return 'distance';
    case 'number':
      return 'number';
    case 'text':
      return 'text';
    case 'osm-feature':
      return 'osm';
    case 'point':
      return 'point';
  }
}

function paramSeed(kind: ToolParameter['kind'], name: string): ToolParameter {
  switch (kind) {
    case 'feature-source':
      return {
        kind: 'feature-source',
        name,
        label: 'Feature source',
        binding: { mode: 'runtime-host' },
      };
    case 'osm-feature':
      return {
        kind: 'osm-feature',
        name,
        label: 'OSM features',
        binding: { mode: 'runtime-pick', allowCustomTagFilters: true },
      };
    case 'predicate':
      return {
        kind: 'predicate',
        name,
        label: 'Predicate',
        binding: { mode: 'runtime-pick', defaultValue: 'intersects' },
      };
    case 'distance':
      return {
        kind: 'distance',
        name,
        label: 'Distance (m)',
        binding: { mode: 'runtime-input', defaultMeters: 100 },
      };
    case 'number':
      return {
        kind: 'number',
        name,
        label: 'Number',
        binding: { mode: 'runtime-input', defaultValue: 0 },
      };
    case 'text':
      return {
        kind: 'text',
        name,
        label: 'Text',
        binding: { mode: 'runtime-input' },
      };
    case 'point':
      return {
        kind: 'point',
        name,
        label: 'Location',
        hint: 'Drop a pin on the map or paste latitude / longitude.',
        binding: { mode: 'runtime-pick' },
      };
  }
}
