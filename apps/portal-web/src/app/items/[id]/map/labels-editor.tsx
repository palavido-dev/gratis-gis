// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import { useEffect, useRef } from 'react';
import type { MapLayerLabels } from '@gratis-gis/shared-types';
import type { LayerMetadata } from './layer-metadata';
import { useT } from '@/lib/i18n/locale-context';

interface Props {
  value: MapLayerLabels;
  metadata: LayerMetadata;
  onChange: (next: MapLayerLabels) => void;
}

/**
 * Label-engine editor.
 *
 * The label text is an expression: the same `{{field | formatter}}`
 * grammar as popups: rather than a single field name. That means a
 * user can produce "Population: 1,234" instead of just "1234", or
 * combine multiple fields ("{{name}} ({{pop | number}})"). Insert-field
 * and insert-formatter menus drop canned snippets at the caret so the
 * grammar isn't a memorization test.
 *
 * X/Y offsets are in em (multiples of text size). A positive Y pushes
 * the label below a point marker, which is usually what you want.
 */
export function LabelsEditor({ value, metadata, onChange }: Props) {
  const t = useT();
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
        <span className="text-ink-1">{t('mapLabelsEditor.showLabels')}</span>
      </label>

      {value.enabled ? (
        <div className="space-y-3 rounded-md border border-border bg-surface-1 p-3">
          <div>
            <div className="mb-1 flex items-center justify-between">
              <label className="block text-2xs uppercase tracking-wide text-muted">
                {t('mapLabelsEditor.labelText')}
              </label>
              <div className="flex gap-1">
                {metadata.fields.length > 0 ? (
                  <select
                    value=""
                    onChange={(e) => {
                      if (e.target.value) insert(`{{${e.target.value}}}`);
                      e.target.value = '';
                    }}
                    className="h-6 rounded border border-border bg-surface-1 px-1 text-2xs focus:border-accent focus:outline-hidden focus:ring-1 focus:ring-accent/30"
                  >
                    <option value="">{t('mapLabelsEditor.insertField')}</option>
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
                  className="h-6 rounded border border-border bg-surface-1 px-1 text-2xs focus:border-accent focus:outline-hidden focus:ring-1 focus:ring-accent/30"
                >
                  <option value="">{t('mapLabelsEditor.insertFormat')}</option>
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
              placeholder={t('mapLabelsEditor.templatePlaceholder')}
              rows={2}
              className="w-full rounded border border-border bg-surface-1 px-2 py-1 font-mono text-xs focus:border-accent focus:outline-hidden focus:ring-1 focus:ring-accent/30"
            />
            <p className="mt-1 text-2xs text-muted">
              {t('mapLabelsEditor.templateHint')}
            </p>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <Slider
              label={t('mapLabelsEditor.size')}
              min={8}
              max={28}
              step={1}
              value={value.size}
              onChange={(n) => patch({ size: n })}
              unit="px"
            />
            <Color
              label={t('mapLayerPanel.symbology.color')}
              value={value.color}
              onChange={(c) => patch({ color: c })}
            />
            <Color
              label={t('mapLabelsEditor.halo')}
              value={value.haloColor}
              onChange={(c) => patch({ haloColor: c })}
            />
            <Slider
              label={t('mapLabelsEditor.haloWidth')}
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
              <label className="mb-1 block text-2xs uppercase tracking-wide text-muted">
                {t('mapLabelsEditor.placement')}
              </label>
              <div className="grid grid-cols-2 gap-2">
                <ModeBtn
                  active={value.placement === 'auto'}
                  onClick={() => patch({ placement: 'auto' })}
                  label={t('mapLabelsEditor.pointAnchored')}
                  hint={t('mapLabelsEditor.pointAnchoredHint')}
                />
                <ModeBtn
                  active={value.placement === 'line'}
                  onClick={() => patch({ placement: 'line' })}
                  label={t('mapLabelsEditor.alongLine')}
                  hint={t('mapLabelsEditor.alongLineHint')}
                />
              </div>
            </div>
          ) : null}

          <div>
            <label className="mb-1 block text-2xs uppercase tracking-wide text-muted">
              {t('mapLabelsEditor.anchor')}
            </label>
            <select
              value={value.anchor}
              onChange={(e) =>
                patch({ anchor: e.target.value as MapLayerLabels['anchor'] })
              }
              className="h-8 w-full rounded border border-border bg-surface-1 px-2 text-xs focus:border-accent focus:outline-hidden focus:ring-1 focus:ring-accent/30"
            >
              <option value="center">{t('mapLabelsEditor.anchorCenter')}</option>
              <option value="top">{t('mapLabelsEditor.anchorTop')}</option>
              <option value="bottom">{t('mapLabelsEditor.anchorBottom')}</option>
              <option value="left">{t('mapLabelsEditor.anchorLeft')}</option>
              <option value="right">{t('mapLabelsEditor.anchorRight')}</option>
            </select>
            <p className="mt-1 text-2xs text-muted">{t('mapLabelsEditor.anchorHint')}</p>
          </div>

          <div>
            <div className="mb-1 flex items-center justify-between">
              <label className="text-2xs uppercase tracking-wide text-muted">
                {t('mapLabelsEditor.offsetFromAnchor')}
              </label>
              <span className="text-2xs text-muted">
                {t('mapLabelsEditor.offsetEmHint')}
              </span>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Slider
                label={t('mapLabelsEditor.offsetX')}
                min={-4}
                max={4}
                step={0.1}
                value={value.offsetX}
                onChange={(n) => patch({ offsetX: n })}
              />
              <Slider
                label={t('mapLabelsEditor.offsetY')}
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
      <span className="flex items-center justify-between text-2xs text-muted">
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
      <span className="text-2xs text-muted">{label}</span>
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
          className="h-7 min-w-0 flex-1 rounded border border-border bg-surface-1 px-2 font-mono text-xs focus:border-accent focus:outline-hidden focus:ring-1 focus:ring-accent/30"
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
      <div className="mt-0.5 text-2xs font-normal text-muted">{hint}</div>
    </button>
  );
}
