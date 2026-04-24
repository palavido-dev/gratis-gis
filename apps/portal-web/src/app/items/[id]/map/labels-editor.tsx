'use client';

import { useEffect, useRef } from 'react';
import type { MapLayerLabels } from '@gratis-gis/shared-types';
import type { LayerMetadata } from './layer-metadata';

interface Props {
  value: MapLayerLabels;
  metadata: LayerMetadata;
  onChange: (next: MapLayerLabels) => void;
}

/**
 * Label-engine editor.
 *
 * The label text is an expression — the same `{{field | formatter}}`
 * grammar as popups — rather than a single field name. That means a
 * user can produce "Population: 1,234" instead of just "1234", or
 * combine multiple fields ("{{name}} ({{pop | number}})"). Insert-field
 * and insert-formatter menus drop canned snippets at the caret so the
 * grammar isn't a memorization test.
 *
 * X/Y offsets are in em (multiples of text size). A positive Y pushes
 * the label below a point marker, which is usually what you want.
 */
export function LabelsEditor({ value, metadata, onChange }: Props) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // "Along line" only makes sense for layers that actually contain line
  // geometry. Hide it otherwise, and self-heal the saved state if an
  // older layer was stuck on `line` but only has points/polygons now.
  const hasLine = metadata.geometryTypes.has('line');

  function patch(p: Partial<MapLayerLabels>) {
    onChange({ ...value, ...p });
  }

  useEffect(() => {
    if (!hasLine && value.placement === 'line') {
      patch({ placement: 'auto' });
    }
    // hasLine flips when metadata arrives; patch is stable per render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasLine, value.placement]);

  function insert(text: string) {
    const el = textareaRef.current;
    if (!el) {
      patch({ template: value.template + text });
      return;
    }
    const start = el.selectionStart ?? value.template.length;
    const end = el.selectionEnd ?? value.template.length;
    const next = value.template.slice(0, start) + text + value.template.slice(end);
    patch({ template: next });
    requestAnimationFrame(() => {
      el.focus();
      const caret = start + text.length;
      el.setSelectionRange(caret, caret);
    });
  }

  return (
    <div className="space-y-3">
      <label className="flex cursor-pointer items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={value.enabled}
          onChange={(e) => patch({ enabled: e.target.checked })}
          className="h-3.5 w-3.5 rounded border-border text-accent focus:ring-accent/30"
        />
        <span className="text-ink-1">Show labels</span>
      </label>

      {value.enabled ? (
        <div className="space-y-3 rounded-md border border-border bg-surface-1 p-3">
          <div>
            <div className="mb-1 flex items-center justify-between">
              <label className="block text-[10px] uppercase tracking-wide text-muted">
                Label text
              </label>
              <div className="flex gap-1">
                {metadata.fields.length > 0 ? (
                  <select
                    value=""
                    onChange={(e) => {
                      if (e.target.value) insert(`{{${e.target.value}}}`);
                      e.target.value = '';
                    }}
                    className="h-6 rounded border border-border bg-surface-1 px-1 text-[11px] focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
                  >
                    <option value="">+ field...</option>
                    {metadata.fields.map((f) => (
                      <option key={f} value={f}>
                        {f}
                      </option>
                    ))}
                  </select>
                ) : null}
                <select
                  value=""
                  onChange={(e) => {
                    if (e.target.value) insert(e.target.value);
                    e.target.value = '';
                  }}
                  className="h-6 rounded border border-border bg-surface-1 px-1 text-[11px] focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
                >
                  <option value="">+ format...</option>
                  <option value="| upper">| upper</option>
                  <option value="| lower">| lower</option>
                  <option value="| number">| number</option>
                </select>
              </div>
            </div>
            <textarea
              ref={textareaRef}
              value={value.template}
              onChange={(e) => patch({ template: e.target.value })}
              placeholder={`{{name}}\nor: {{name}} ({{pop | number}})`}
              rows={2}
              className="w-full rounded border border-border bg-surface-1 px-2 py-1 font-mono text-xs focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
            />
            <p className="mt-1 text-[11px] text-muted">
              Static text renders as-is; wrap fields in{' '}
              <code className="rounded bg-surface-2 px-1">{`{{ }}`}</code>.
              Formatters: upper, lower, number.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <Slider
              label="Size"
              min={8}
              max={28}
              step={1}
              value={value.size}
              onChange={(n) => patch({ size: n })}
              unit="px"
            />
            <Color
              label="Color"
              value={value.color}
              onChange={(c) => patch({ color: c })}
            />
            <Color
              label="Halo"
              value={value.haloColor}
              onChange={(c) => patch({ haloColor: c })}
            />
            <Slider
              label="Halo width"
              min={0}
              max={4}
              step={0.25}
              value={value.haloWidth}
              onChange={(n) => patch({ haloWidth: n })}
              unit="px"
            />
          </div>

          {hasLine ? (
            <div>
              <label className="mb-1 block text-[10px] uppercase tracking-wide text-muted">
                Placement
              </label>
              <div className="grid grid-cols-2 gap-2">
                <ModeBtn
                  active={value.placement === 'auto'}
                  onClick={() => patch({ placement: 'auto' })}
                  label="Point-anchored"
                  hint="Centered on points and polygons."
                />
                <ModeBtn
                  active={value.placement === 'line'}
                  onClick={() => patch({ placement: 'line' })}
                  label="Along line"
                  hint="Labels follow line geometry."
                />
              </div>
            </div>
          ) : null}

          <div>
            <label className="mb-1 block text-[10px] uppercase tracking-wide text-muted">
              Anchor
            </label>
            <select
              value={value.anchor}
              onChange={(e) =>
                patch({ anchor: e.target.value as MapLayerLabels['anchor'] })
              }
              className="h-8 w-full rounded border border-border bg-surface-1 px-2 text-xs focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
            >
              <option value="center">center</option>
              <option value="top">top</option>
              <option value="bottom">bottom</option>
              <option value="left">left</option>
              <option value="right">right</option>
            </select>
            <p className="mt-1 text-[11px] text-muted">
              Anchor picks which part of the label sits on the feature
              point; offsets below nudge it from there.
            </p>
          </div>

          <div>
            <div className="mb-1 flex items-center justify-between">
              <label className="text-[10px] uppercase tracking-wide text-muted">
                Offset from anchor
              </label>
              <span className="text-[10px] text-muted">em (multiples of size)</span>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Slider
                label="X"
                min={-4}
                max={4}
                step={0.1}
                value={value.offsetX}
                onChange={(n) => patch({ offsetX: n })}
              />
              <Slider
                label="Y (â†“ is positive)"
                min={-4}
                max={4}
                step={0.1}
                value={value.offsetY}
                onChange={(n) => patch({ offsetY: n })}
              />
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Slider({
  label,
  min,
  max,
  step,
  value,
  onChange,
  unit,
}: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (n: number) => void;
  unit?: string;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="flex items-center justify-between text-[10px] text-muted">
        <span>{label}</span>
        <span className="tabular-nums">
          {value}
          {unit ? ` ${unit}` : ''}
        </span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="accent-accent"
      />
    </label>
  );
}

function Color({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (c: string) => void;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] text-muted">{label}</span>
      <div className="flex items-center gap-2">
        <input
          type="color"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="h-7 w-10 cursor-pointer rounded border border-border bg-surface-1 p-0.5"
        />
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="h-7 min-w-0 flex-1 rounded border border-border bg-surface-1 px-2 font-mono text-xs focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
        />
      </div>
    </label>
  );
}

function ModeBtn({
  active,
  onClick,
  label,
  hint,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  hint: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-md border p-2 text-left text-xs font-medium transition-colors ${
        active
          ? 'border-accent bg-accent/5 text-ink-0 ring-2 ring-accent/30'
          : 'border-border bg-surface-1 text-muted hover:bg-surface-2'
      }`}
    >
      <div>{label}</div>
      <div className="mt-0.5 text-[10px] font-normal text-muted">{hint}</div>
    </button>
  );
}
