'use client';

import { useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  Filter,
  GripVertical,
  MousePointerClick,
  Palette,
  Plus,
  Search,
  Sparkles,
  Tag,
  Telescope,
  Trash2,
  X,
} from 'lucide-react';
import type {
  MapLayer,
  MapLayerScale,
  MapLayerSearch,
} from '@gratis-gis/shared-types';
import { DEFAULT_LAYER_SCALE, ZOOM_MAX, ZOOM_MIN } from '@gratis-gis/shared-types';
import { StyleEditor } from './style-editor';
import { RendererEditor } from './renderer-editor';
import { FilterEditor } from './filter-editor';
import { PopupEditor } from './popup-editor';
import { LabelsEditor } from './labels-editor';
import type { LayerMetadata } from './layer-metadata';

interface Props {
  layers: MapLayer[];
  metadata: Record<string, LayerMetadata>;
  canEdit: boolean;
  /**
   * Current camera zoom. Rendered as a tick under each scale-range
   * slider so authors can see at a glance whether their thumbs bracket
   * the current view. Updates whenever the map camera changes.
   */
  currentZoom: number;
  onOpenAdd: () => void;
  onChange: (next: MapLayer[]) => void;
}

const DRAG_MIME = 'application/x-gg-layer';

/**
 * Left-side layer panel.
 *
 * Per-row affordances:
 *   - Drag handle (HTML5 native drag-and-drop) for reorder.
 *   - Visibility toggle.
 *   - Remove.
 *   - Expand for Symbology / Filters / Popups / Interactions.
 *
 * Layer order mirrors render order (top of list draws on top).
 */
export function LayerPanel({
  layers,
  metadata,
  canEdit,
  currentZoom,
  onOpenAdd,
  onChange,
}: Props) {
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);

  function updateLayer(id: string, patch: Partial<MapLayer>) {
    onChange(layers.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  }
  function removeLayer(id: string) {
    onChange(layers.filter((l) => l.id !== id));
  }
  function moveLayer(from: number, to: number) {
    if (from === to || from < 0 || to < 0) return;
    const next = [...layers];
    const [moved] = next.splice(from, 1);
    if (!moved) return;
    next.splice(to, 0, moved);
    onChange(next);
  }

  return (
    <div className="flex h-full flex-col border-r border-border bg-surface-1">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <h3 className="text-xs font-medium uppercase tracking-wide text-muted">
          Layers
        </h3>
        {canEdit ? (
          <button
            type="button"
            onClick={onOpenAdd}
            className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-surface-1 px-2 text-xs font-medium text-ink-1 shadow-card hover:bg-surface-2"
          >
            <Plus className="h-3.5 w-3.5" />
            Add layer
          </button>
        ) : null}
      </div>

      {layers.length === 0 ? (
        <div className="flex flex-1 items-center justify-center p-6 text-center">
          <div className="max-w-[18rem]">
            <Sparkles className="mx-auto mb-2 h-5 w-5 text-muted" />
            <p className="text-xs text-muted">
              No layers yet.{' '}
              {canEdit
                ? 'Add one from a URL, the portal, or the curated catalog.'
                : 'The owner has not added any layers.'}
            </p>
          </div>
        </div>
      ) : (
        <ul className="flex-1 overflow-y-auto">
          {layers.map((layer, i) => (
            <LayerRow
              key={layer.id}
              layer={layer}
              index={i}
              metadata={metadata[layer.id] ?? {
                fields: [],
                valuesByField: {},
                sampleProperties: null,
                featureCollection: null,
                geometryTypes: new Set(),
                error: null,
                loading: true,
              }}
              canEdit={canEdit}
              currentZoom={currentZoom}
              dragging={dragFrom === i}
              dropTarget={dragOver === i}
              onDragStart={() => setDragFrom(i)}
              onDragEnd={() => {
                setDragFrom(null);
                setDragOver(null);
              }}
              onDragEnter={() => setDragOver(i)}
              onDrop={(sourceIdx) => moveLayer(sourceIdx, i)}
              onToggle={() => updateLayer(layer.id, { visible: !layer.visible })}
              onOpacity={(n) => updateLayer(layer.id, { opacity: n })}
              onRemove={() => removeLayer(layer.id)}
              onPatch={(p) => updateLayer(layer.id, p)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

interface RowProps {
  layer: MapLayer;
  index: number;
  metadata: LayerMetadata;
  canEdit: boolean;
  currentZoom: number;
  dragging: boolean;
  dropTarget: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDragEnter: () => void;
  onDrop: (sourceIdx: number) => void;
  onToggle: () => void;
  onOpacity: (n: number) => void;
  onRemove: () => void;
  onPatch: (patch: Partial<MapLayer>) => void;
}

type SectionKey =
  | 'symbology'
  | 'labels'
  | 'filters'
  | 'popups'
  | 'interactions'
  | 'scale';

function LayerRow({
  layer,
  index,
  metadata,
  canEdit,
  currentZoom,
  dragging,
  dropTarget,
  onDragStart,
  onDragEnd,
  onDragEnter,
  onDrop,
  onToggle,
  onOpacity,
  onRemove,
  onPatch,
}: RowProps) {
  const [expanded, setExpanded] = useState(false);
  const [openSections, setOpenSections] = useState<Record<SectionKey, boolean>>({
    symbology: true,
    labels: false,
    filters: false,
    popups: false,
    interactions: false,
    scale: false,
  });
  function toggle(k: SectionKey) {
    setOpenSections((s) => ({ ...s, [k]: !s[k] }));
  }

  // Drag-and-drop: the row itself is the drag source and drop target.
  // We carry the source index in dataTransfer so cross-list drops would
  // also work if we ever add them; today the list is intra-panel.
  function handleDragStart(e: React.DragEvent) {
    e.dataTransfer.setData(DRAG_MIME, String(index));
    e.dataTransfer.effectAllowed = 'move';
    onDragStart();
  }
  function handleDragOver(e: React.DragEvent) {
    if (!e.dataTransfer.types.includes(DRAG_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  }
  function handleDragEnter() {
    onDragEnter();
  }
  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    const raw = e.dataTransfer.getData(DRAG_MIME);
    const from = Number(raw);
    if (!Number.isFinite(from)) return;
    onDrop(from);
    onDragEnd();
  }

  return (
    <li
      onDragOver={canEdit ? handleDragOver : undefined}
      onDragEnter={canEdit ? handleDragEnter : undefined}
      onDrop={canEdit ? handleDrop : undefined}
      className={`border-b border-border transition-colors last:border-0 ${
        dropTarget && !dragging ? 'bg-accent/5' : ''
      } ${dragging ? 'opacity-50' : ''}`}
    >
      <div className="flex items-center gap-1 px-1.5 py-2">
        {canEdit ? (
          <span
            draggable
            onDragStart={handleDragStart}
            onDragEnd={onDragEnd}
            aria-label="Drag to reorder"
            className="inline-flex h-6 w-5 shrink-0 cursor-grab items-center justify-center text-muted hover:text-ink-1 active:cursor-grabbing"
          >
            <GripVertical className="h-3.5 w-3.5" />
          </span>
        ) : (
          <span className="inline-block h-6 w-5 shrink-0" />
        )}
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-label={expanded ? 'Collapse' : 'Expand'}
          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted hover:bg-surface-2"
        >
          <ChevronRight
            className={`h-3.5 w-3.5 transition-transform ${expanded ? 'rotate-90' : ''}`}
          />
        </button>
        <button
          type="button"
          onClick={canEdit ? onToggle : undefined}
          disabled={!canEdit}
          aria-label={layer.visible ? 'Hide layer' : 'Show layer'}
          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted hover:bg-surface-2 disabled:opacity-50"
        >
          {layer.visible ? (
            <Eye className="h-3.5 w-3.5" />
          ) : (
            <EyeOff className="h-3.5 w-3.5 text-muted" />
          )}
        </button>

        <div
          className="min-w-0 flex-1 cursor-pointer truncate text-sm"
          onClick={() => setExpanded((v) => !v)}
          title={layer.title}
        >
          <span className={layer.visible ? 'text-ink-0' : 'text-muted'}>
            {layer.title}
          </span>
        </div>

        {canEdit ? (
          <button
            type="button"
            onClick={onRemove}
            aria-label="Remove layer"
            className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted hover:bg-surface-2 hover:text-danger"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </div>

      {expanded ? (
        <div className="space-y-0 border-t border-border bg-surface-2">
          <div className="px-3 py-3">
            <label className="flex items-center justify-between text-[10px] uppercase tracking-wide text-muted">
              <span>Opacity</span>
              <span className="tabular-nums">{Math.round(layer.opacity * 100)}%</span>
            </label>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={layer.opacity}
              disabled={!canEdit}
              onChange={(e) => onOpacity(Number(e.target.value))}
              className="mt-1 w-full accent-accent disabled:opacity-50"
            />
          </div>

          {canEdit ? (
            <>
              <Section
                Icon={Palette}
                label="Symbology"
                open={openSections.symbology}
                onToggle={() => toggle('symbology')}
              >
                <RendererEditor
                  value={layer.renderer}
                  metadata={metadata}
                  onChange={(renderer) => onPatch({ renderer })}
                />
                <div className="mt-3 border-t border-border pt-3">
                  <StyleEditor
                    value={layer.style}
                    onChange={(style) => onPatch({ style })}
                    {...(metadata.geometryTypes
                      ? { geometryTypes: metadata.geometryTypes }
                      : {})}
                  />
                </div>
              </Section>

              <Section
                Icon={Tag}
                label="Labels"
                open={openSections.labels}
                onToggle={() => toggle('labels')}
              >
                <LabelsEditor
                  value={layer.labels}
                  metadata={metadata}
                  onChange={(labels) => onPatch({ labels })}
                />
              </Section>

              <Section
                Icon={Filter}
                label="Filters"
                open={openSections.filters}
                onToggle={() => toggle('filters')}
              >
                <FilterEditor
                  value={layer.filter}
                  metadata={metadata}
                  onChange={(filter) => onPatch({ filter })}
                />
              </Section>

              <Section
                Icon={MousePointerClick}
                label="Popups"
                open={openSections.popups}
                onToggle={() => toggle('popups')}
              >
                <PopupEditor
                  value={layer.popup}
                  metadata={metadata}
                  onChange={(popup) => onPatch({ popup })}
                />
              </Section>

              <Section
                Icon={Sparkles}
                label="Interactions"
                open={openSections.interactions}
                onToggle={() => toggle('interactions')}
              >
                <div className="space-y-1.5 text-sm">
                  <Toggle
                    Icon={Sparkles}
                    label="Highlight on hover"
                    checked={layer.interactions.hoverHighlight}
                    onChange={(v) =>
                      onPatch({
                        interactions: {
                          ...layer.interactions,
                          hoverHighlight: v,
                        },
                      })
                    }
                  />
                  <Toggle
                    Icon={MousePointerClick}
                    label="Selectable"
                    checked={layer.interactions.selectable !== false}
                    onChange={(v) =>
                      onPatch({
                        interactions: {
                          ...layer.interactions,
                          selectable: v,
                        },
                      })
                    }
                  />
                </div>
                <SearchConfig
                  value={layer.search}
                  fields={metadata.fields}
                  onChange={(search) => onPatch({ search })}
                />
                <p className="mt-2 text-[11px] text-muted">
                  Feature editing unlocks when the layer&apos;s source
                  supports writes.
                </p>
              </Section>

              <Section
                Icon={Telescope}
                label="Scale"
                open={openSections.scale}
                onToggle={() => toggle('scale')}
              >
                <ScaleEditor
                  value={layer.scale ?? DEFAULT_LAYER_SCALE}
                  currentZoom={currentZoom}
                  onChange={(scale) => onPatch({ scale })}
                />
              </Section>
            </>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

function Section({
  Icon,
  label,
  open,
  onToggle,
  children,
}: {
  Icon: typeof Palette;
  label: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="border-t border-border">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 text-xs font-medium uppercase tracking-wide text-muted hover:bg-surface-1"
      >
        {open ? (
          <ChevronDown className="h-3.5 w-3.5" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5" />
        )}
        <Icon className="h-3.5 w-3.5" />
        {label}
      </button>
      {open ? <div className="px-3 pb-3">{children}</div> : null}
    </div>
  );
}

/**
 * Per-layer search config. A layer is searchable once the owner ticks
 * the box and adds one or more fields; the map-level search bar then
 * walks this layer's cached feature collection for substring matches
 * against those fields.
 */
function SearchConfig({
  value,
  fields,
  onChange,
}: {
  value: MapLayerSearch;
  fields: string[];
  onChange: (next: MapLayerSearch) => void;
}) {
  function patch(p: Partial<MapLayerSearch>) {
    onChange({ ...value, ...p });
  }
  function addField(name: string) {
    if (!name || value.fields.includes(name)) return;
    patch({ fields: [...value.fields, name] });
  }
  function removeField(name: string) {
    patch({ fields: value.fields.filter((f) => f !== name) });
  }
  const unpicked = fields.filter((f) => !value.fields.includes(f));

  return (
    <div className="mt-3 border-t border-border pt-3">
      <label className="mb-2 flex cursor-pointer items-center gap-2 text-xs">
        <input
          type="checkbox"
          checked={value.enabled}
          onChange={(e) => patch({ enabled: e.target.checked })}
          className="h-3.5 w-3.5 rounded border-border text-accent focus:ring-accent/30"
        />
        <Search className="h-3.5 w-3.5 text-muted" />
        <span className="text-ink-1">Searchable</span>
      </label>
      {value.enabled ? (
        <div className="space-y-2 rounded-md border border-border bg-surface-1 p-2">
          <div>
            <div className="mb-1 text-[10px] uppercase tracking-wide text-muted">
              Fields to search
            </div>
            {value.fields.length === 0 ? (
              <p className="text-[11px] text-muted">
                Pick at least one field so the search bar knows what to
                match.
              </p>
            ) : (
              <ul className="flex flex-wrap gap-1">
                {value.fields.map((f) => (
                  <li
                    key={f}
                    className="inline-flex items-center gap-1 rounded-full border border-border bg-surface-2 px-2 py-0.5 text-[11px]"
                  >
                    <span className="font-medium">{f}</span>
                    <button
                      type="button"
                      onClick={() => removeField(f)}
                      aria-label={`Remove ${f}`}
                      className="inline-flex h-4 w-4 items-center justify-center rounded-full text-muted hover:text-danger"
                    >
                      <X className="h-2.5 w-2.5" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {fields.length > 0 ? (
              <select
                value=""
                onChange={(e) => {
                  addField(e.target.value);
                  e.target.value = '';
                }}
                disabled={unpicked.length === 0}
                className="mt-2 h-7 w-full rounded border border-border bg-surface-1 px-2 text-[11px] focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30 disabled:opacity-50"
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
                className="mt-2 h-7 w-full rounded border border-border bg-surface-1 px-2 text-[11px] focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
              />
            )}
          </div>
          <div>
            <div className="mb-1 text-[10px] uppercase tracking-wide text-muted">
              Result label (optional)
            </div>
            <input
              type="text"
              value={value.labelTemplate}
              onChange={(e) => patch({ labelTemplate: e.target.value })}
              placeholder={`{{apn}} — {{situs}}`}
              className="h-7 w-full rounded border border-border bg-surface-1 px-2 font-mono text-[11px] focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
            />
            <p className="mt-1 text-[11px] text-muted">
              Same{' '}
              <code className="rounded bg-surface-2 px-1">{`{{field}}`}</code>{' '}
              grammar as popups. Empty falls back to the first matching
              field&apos;s value.
            </p>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Toggle({
  Icon,
  label,
  checked,
  onChange,
}: {
  Icon: typeof Eye;
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-xs">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-3.5 w-3.5 rounded border-border text-accent focus:ring-accent/30"
      />
      <Icon className="h-3.5 w-3.5 text-muted" />
      <span className="text-ink-1">{label}</span>
    </label>
  );
}

/**
 * Scale controls: per-layer zoom-range visibility for features and
 * labels, plus an opt-out for the default icon/circle auto-scaling.
 * Ranges are inclusive and expressed in MapLibre zoom units (0 = world,
 * 22 = street). The slider reads cartographically from large scale on
 * the left (zoomed-in / building) to small scale on the right (zoomed-
 * out / world), mirroring how scale ranges are typically written
 * ("1:500 – 1:500,000"). A small tick tracks the current camera zoom
 * so authors can see whether their bounds bracket the live view.
 */
function ScaleEditor({
  value,
  currentZoom,
  onChange,
}: {
  value: MapLayerScale;
  currentZoom: number;
  onChange: (next: MapLayerScale) => void;
}) {
  function patch(p: Partial<MapLayerScale>) {
    onChange({ ...value, ...p });
  }

  return (
    <div className="space-y-3 text-sm">
      <ZoomRange
        label="Layer visible"
        minZoom={value.minZoom}
        maxZoom={value.maxZoom}
        currentZoom={currentZoom}
        onMin={(z) => patch({ minZoom: z })}
        onMax={(z) => patch({ maxZoom: z })}
      />
      <ZoomRange
        label="Labels visible"
        minZoom={value.labelsMinZoom}
        maxZoom={value.labelsMaxZoom}
        currentZoom={currentZoom}
        onMin={(z) => patch({ labelsMinZoom: z })}
        onMax={(z) => patch({ labelsMaxZoom: z })}
      />
      <label className="flex cursor-pointer items-center gap-2 text-xs">
        <input
          type="checkbox"
          checked={value.scaleWithZoom !== false}
          onChange={(e) => patch({ scaleWithZoom: e.target.checked })}
          className="h-3.5 w-3.5 rounded border-border text-accent focus:ring-accent/30"
        />
        <span className="text-ink-1">Scale icons &amp; points with zoom</span>
      </label>
      <p className="text-[11px] text-muted">
        Off keeps the exact size you set; on shrinks markers at low zooms
        so the map isn&apos;t overwhelmed and nudges them up at close
        range.
      </p>
    </div>
  );
}

function ZoomRange({
  label,
  minZoom,
  maxZoom,
  currentZoom,
  onMin,
  onMax,
}: {
  label: string;
  minZoom: number | null;
  maxZoom: number | null;
  currentZoom: number;
  onMin: (z: number | null) => void;
  onMax: (z: number | null) => void;
}) {
  // Clamp nullable bounds to the slider range for positioning. Storing
  // null when a thumb rests on the extreme keeps the persisted map's
  // intent clear — "no minimum" vs. "minimum happens to be zero".
  const minV = minZoom ?? ZOOM_MIN;
  const maxV = maxZoom ?? ZOOM_MAX;
  const span = ZOOM_MAX - ZOOM_MIN;
  // The slider reads right-to-left in zoom terms (left = zoomed-in =
  // large scale, right = zoomed-out = small scale). We reverse the
  // position math so a higher zoom value sits further to the left.
  const posOf = (z: number) => ((ZOOM_MAX - z) / span) * 100;
  const pctCurrent = Math.max(0, Math.min(100, posOf(currentZoom)));
  const leftEdge = posOf(maxV); // zoomed-in thumb — on the left
  const rightEdge = posOf(minV); // zoomed-out thumb — on the right
  // Mirror MapLibre exactly: minzoom is inclusive, maxzoom is
  // exclusive (the layer is hidden *at* maxzoom and above). Using the
  // same comparison the renderer uses keeps the tick's color honest
  // even near the thumbs, where raw position alone can mislead.
  const inRange =
    (minZoom == null || currentZoom >= minZoom) &&
    (maxZoom == null || currentZoom < maxZoom);

  return (
    <div className="rounded-md border border-border bg-surface-1 p-2">
      <div className="mb-2 flex items-center justify-between text-[10px] uppercase tracking-wide text-muted">
        <span>{label}</span>
        <span className="tabular-nums normal-case tracking-normal text-muted">
          {maxZoom == null ? 'any' : `z${maxZoom}`}
          {'  –  '}
          {minZoom == null ? 'any' : `z${minZoom}`}
        </span>
      </div>
      <div className="gg-dual-range">
        <div className="gg-dual-range__track" />
        <div
          className="gg-dual-range__fill"
          style={{ left: `${leftEdge}%`, right: `${100 - rightEdge}%` }}
        />
        {/* Current camera-zoom indicator. Sits above the track so both
            thumbs still overlap it. Colored by real in-range status so
            a tick nudged just past a thumb doesn't fool the eye into
            thinking the layer is drawn when it isn't. */}
        <div
          className={
            'gg-dual-range__now ' +
            (inRange
              ? 'gg-dual-range__now--in'
              : 'gg-dual-range__now--out')
          }
          style={{ left: `${pctCurrent}%` }}
          aria-hidden="true"
          title={
            `Current zoom: z${currentZoom.toFixed(1)} (${zoomToScaleLabel(currentZoom)})` +
            ` — ${inRange ? 'in range' : 'outside range'}`
          }
        />
        {/* Left thumb controls the zoomed-in (max) side. RTL on the
            input flips its native direction so dragging right lowers
            the max zoom. We also clamp against the other bound. */}
        <input
          type="range"
          dir="rtl"
          min={ZOOM_MIN}
          max={ZOOM_MAX}
          step={1}
          value={maxV}
          onChange={(e) => {
            let n = Number(e.target.value);
            if (n < minV) n = minV;
            onMax(n === ZOOM_MAX ? null : n);
          }}
          aria-label={`${label} maximum zoom (zoomed-in limit)`}
          className="gg-dual-range__input"
        />
        {/* Right thumb controls the zoomed-out (min) side. Same RTL
            trick so its drag direction matches the reversed axis. */}
        <input
          type="range"
          dir="rtl"
          min={ZOOM_MIN}
          max={ZOOM_MAX}
          step={1}
          value={minV}
          onChange={(e) => {
            let n = Number(e.target.value);
            if (n > maxV) n = maxV;
            onMin(n === ZOOM_MIN ? null : n);
          }}
          aria-label={`${label} minimum zoom (zoomed-out limit)`}
          className="gg-dual-range__input"
        />
      </div>
      <div className="mt-1 flex items-center justify-between text-[11px] text-muted">
        {/* Left label describes the zoomed-in end — large scale.
            Right label the zoomed-out end — small scale. */}
        <span className="tabular-nums">
          {maxZoom == null ? 'building' : zoomToScaleLabel(maxZoom)}
        </span>
        <span className="tabular-nums">
          {minZoom == null ? 'world' : zoomToScaleLabel(minZoom)}
        </span>
      </div>
    </div>
  );
}

/**
 * Rough zoom â†’ scale denominator conversion. Web Mercator ~1:500M at
 * zoom 0, halving per zoom level. Just a hint so users familiar with
 * scale-denominator thinking can orient — not a precise projection.
 */
function zoomToScaleLabel(zoom: number): string {
  const base = 500_000_000;
  const denom = base / Math.pow(2, zoom);
  if (denom >= 1_000_000) return `1:${Math.round(denom / 1_000_000)}M`;
  if (denom >= 1_000) return `1:${Math.round(denom / 1_000)}k`;
  return `1:${Math.round(denom)}`;
}
