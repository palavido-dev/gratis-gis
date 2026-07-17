// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import { useMemo } from 'react';
import { ArrowDown, ArrowUp, Trash2 } from 'lucide-react';
import type { MapLayerPopup } from '@gratis-gis/shared-types';
import type { LayerMetadata } from './layer-metadata';
import { TemplateInput } from './template-input';

interface Props {
  value: MapLayerPopup;
  metadata: LayerMetadata;
  onChange: (next: MapLayerPopup) => void;
}

/**
 * Click-popup editor with three body modes:
 *
 *   - All fields: list every property on the feature (zero config).
 *   - Picked fields: ordered allow-list of fields.
 *   - Template: hand-written Handlebars-lite string with {{field}}
 *     interpolation and optional `| formatter` pipes. A live preview
 *     renders against a real feature pulled from layer metadata.
 *
 * Mixed-mode popups (custom title + picked body, etc.) fall out
 * naturally from the independent title template + body mode knobs.
 */
export function PopupEditor({ value, metadata, onChange }: Props) {
  function patch(p: Partial<MapLayerPopup>) {
    onChange({ ...value, ...p });
  }

  // The popup-trigger toggles ("Click shows popup", "Popup on
  // hover") live in the Interactions section now (they're behavior
  // toggles; this section is content configuration). When neither
  // trigger is on the section renders an empty-state nudge instead
  // of the title/body editors so a no-op section doesn't sit
  // open with no effect.
  const triggerActive = value.enabled || value.showOnHover === true;

  return (
    <div className="space-y-3">
      {!triggerActive ? (
        <p className="rounded-md border border-border bg-surface-2 px-3 py-2 text-xs text-muted">
          Popups are off for this layer. Turn on{' '}
          <em>Click shows popup</em> or <em>Popup on hover</em> in
          Interactions to configure the popup&rsquo;s content.
        </p>
      ) : (
        <>
          <TitleEditor value={value} metadata={metadata} onPatch={patch} />

          <div>
            <label className="mb-2 block text-2xs uppercase tracking-wide text-muted">
              Body
            </label>
            <div className="grid grid-cols-3 gap-2">
              <ModeBtn
                active={value.mode === 'all'}
                onClick={() => patch({ mode: 'all' })}
                label="All fields"
              />
              <ModeBtn
                active={value.mode === 'picked'}
                onClick={() => patch({ mode: 'picked' })}
                label="Picked"
              />
              <ModeBtn
                active={value.mode === 'template'}
                onClick={() => patch({ mode: 'template' })}
                label="Template"
              />
            </div>
          </div>

          {value.mode === 'picked' ? (
            <PickedEditor value={value} metadata={metadata} onPatch={patch} />
          ) : null}
          {value.mode === 'template' ? (
            <TemplateEditor value={value} metadata={metadata} onPatch={patch} />
          ) : null}
        </>
      )}
    </div>
  );
}

function TitleEditor({
  value,
  metadata,
  onPatch,
}: {
  value: MapLayerPopup;
  metadata: LayerMetadata;
  onPatch: (p: Partial<MapLayerPopup>) => void;
}) {
  const sample = useMemo(
    () => metadata.sampleProperties ?? synthesizeSample(metadata),
    [metadata],
  );
  return (
    <div>
      <label className="mb-1 block text-2xs uppercase tracking-wide text-muted">
        Title template
      </label>
      <TemplateInput
        value={value.titleTemplate}
        onChange={(next) => onPatch({ titleTemplate: next })}
        fields={metadata.fields}
        sampleProperties={sample}
        placeholder={`{{name}}  (defaults to layer title)`}
      />
    </div>
  );
}

function PickedEditor({
  value,
  metadata,
  onPatch,
}: {
  value: MapLayerPopup;
  metadata: LayerMetadata;
  onPatch: (p: Partial<MapLayerPopup>) => void;
}) {
  function moveField(idx: number, dir: -1 | 1) {
    const target = idx + dir;
    if (target < 0 || target >= value.fields.length) return;
    const next = [...value.fields];
    const tmp = next[idx]!;
    next[idx] = next[target]!;
    next[target] = tmp;
    onPatch({ fields: next });
  }
  function removeField(idx: number) {
    onPatch({ fields: value.fields.filter((_, i) => i !== idx) });
  }
  function addField(name: string) {
    if (!name || value.fields.includes(name)) return;
    onPatch({ fields: [...value.fields, name] });
  }
  const unpicked = metadata.fields.filter((f) => !value.fields.includes(f));

  return (
    <div className="space-y-2 rounded-md border border-border bg-surface-1 p-2">
      {value.fields.length === 0 ? (
        <p className="text-2xs text-muted">
          No fields yet. Add one from the dropdown below.
        </p>
      ) : (
        <ul className="space-y-1">
          {value.fields.map((f, i) => (
            <li key={f} className="flex items-center gap-1">
              <span className="flex-1 truncate text-xs">{f}</span>
              <button
                type="button"
                onClick={() => moveField(i, -1)}
                disabled={i === 0}
                aria-label="Move up"
                className="inline-flex h-6 w-6 items-center justify-center rounded text-muted hover:bg-surface-2 disabled:opacity-30"
              >
                <ArrowUp className="h-3 w-3" />
              </button>
              <button
                type="button"
                onClick={() => moveField(i, 1)}
                disabled={i === value.fields.length - 1}
                aria-label="Move down"
                className="inline-flex h-6 w-6 items-center justify-center rounded text-muted hover:bg-surface-2 disabled:opacity-30"
              >
                <ArrowDown className="h-3 w-3" />
              </button>
              <button
                type="button"
                onClick={() => removeField(i)}
                aria-label="Remove"
                className="inline-flex h-6 w-6 items-center justify-center rounded text-muted hover:bg-surface-2 hover:text-danger"
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex gap-2">
        {metadata.fields.length > 0 ? (
          <select
            value=""
            onChange={(e) => {
              addField(e.target.value);
              e.target.value = '';
            }}
            disabled={unpicked.length === 0}
            className="h-8 min-w-0 flex-1 rounded border border-border bg-surface-1 px-2 text-xs focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30 disabled:opacity-50"
          >
            <option value="">
              {unpicked.length === 0 ? 'All fields added' : 'Add a field...'}
            </option>
            {unpicked.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        ) : (
          <input
            type="text"
            placeholder="field name"
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                addField((e.target as HTMLInputElement).value.trim());
                (e.target as HTMLInputElement).value = '';
              }
            }}
            className="h-8 min-w-0 flex-1 rounded border border-border bg-surface-1 px-2 text-xs focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
          />
        )}
        {metadata.loading ? (
          <span className="self-center text-2xs text-muted">loading...</span>
        ) : null}
      </div>
    </div>
  );
}

function TemplateEditor({
  value,
  metadata,
  onPatch,
}: {
  value: MapLayerPopup;
  metadata: LayerMetadata;
  onPatch: (p: Partial<MapLayerPopup>) => void;
}) {
  // Live preview: render the body against a sample feature, falling
  // back to a synthetic one if the layer hasn't loaded any yet.
  const sample = useMemo(
    () => metadata.sampleProperties ?? synthesizeSample(metadata),
    [metadata],
  );

  return (
    <div className="space-y-2">
      <TemplateInput
        value={value.bodyTemplate}
        onChange={(next) => onPatch({ bodyTemplate: next })}
        fields={metadata.fields}
        sampleProperties={sample}
        placeholder={`<strong>{{name}}</strong><br>\nCategory: {{category}}<br>\nFloors: {{floors | number}}`}
        multiline
        rows={6}
        previewAsHtml
        extraInserts={[{ label: '+line break', insert: '<br>' }]}
      />
      <p className="text-2xs text-muted">
        <code className="rounded bg-surface-2 px-1">{`{{field}}`}</code> reads
        a property;{' '}
        <code className="rounded bg-surface-2 px-1">{`{{field | fmt}}`}</code>{' '}
        formats it. Field values are always HTML-escaped; wrap them in
        your own markup for styling.
      </p>
    </div>
  );
}

function ModeBtn({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-md border p-2 text-xs font-medium transition-colors ${
        active
          ? 'border-accent bg-accent/5 text-ink-0 ring-2 ring-accent/30'
          : 'border-border bg-surface-1 text-muted hover:bg-surface-2'
      }`}
    >
      {label}
    </button>
  );
}

/**
 * Build a sample feature for the live preview when the canvas hasn't
 * loaded a real one yet.  Each known field gets either the first
 * cached value or a `<field>` placeholder so the template renders
 * readably while the author is typing.
 */
function synthesizeSample(metadata: LayerMetadata): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of metadata.fields) {
    out[f] = metadata.valuesByField[f]?.[0] ?? `<${f}>`;
  }
  return out;
}
