'use client';

import { useMemo, useState } from 'react';
import type { MapLayerStyle, PointSymbol } from '@gratis-gis/shared-types';
import type { GeometryFamily } from './layer-metadata';
import {
  MAP_ICONS,
  MAP_ICON_CATEGORIES,
  renderIconSvg,
} from './map-icons';

interface Props {
  value: MapLayerStyle;
  onChange: (next: MapLayerStyle) => void;
  /**
   * Which geometry families to surface. Empty (or undefined) means
   * "show everything": appropriate while metadata is still loading.
   * Once the layer's data is sampled we narrow to only what's present.
   */
  geometryTypes?: Set<GeometryFamily>;
}

/**
 * Simple renderer editor. Shows one section per geometry family that
 * the layer's data actually contains. When the metadata sampler hasn't
 * told us what's in the source yet, we fall back to showing all three
 * so a brand-new layer isn't missing controls: geometry narrowing
 * takes over as soon as the first sample comes back.
 *
 * Deliberately spartan: color + size are 80% of styling decisions.
 * Unique-value / class-break renderers ship as a separate panel.
 */
export function StyleEditor({ value, onChange, geometryTypes }: Props) {
  function patch<K extends keyof MapLayerStyle>(
    section: K,
    patch: Partial<MapLayerStyle[K]>,
  ) {
    onChange({
      ...value,
      [section]: { ...value[section], ...patch },
    });
  }

  const showAll = !geometryTypes || geometryTypes.size === 0;
  const showPolygon = showAll || geometryTypes.has('polygon');
  const showLine = showAll || geometryTypes.has('line');
  const showPoint = showAll || geometryTypes.has('point');

  return (
    <div className="space-y-4">
      {showPolygon ? (
      <section>
        <h4 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">
          Polygons
        </h4>
        <div className="grid grid-cols-2 gap-2">
          <Color
            label="Fill"
            value={value.polygon.fillColor}
            onChange={(c) => patch('polygon', { fillColor: c })}
          />
          <Slider
            label="Fill opacity"
            min={0}
            max={1}
            step={0.05}
            value={value.polygon.fillOpacity}
            onChange={(n) => patch('polygon', { fillOpacity: n })}
          />
          <Color
            label="Outline"
            value={value.polygon.strokeColor}
            onChange={(c) => patch('polygon', { strokeColor: c })}
          />
          <Slider
            label="Outline width"
            min={0}
            max={8}
            step={0.5}
            value={value.polygon.strokeWidth}
            onChange={(n) => patch('polygon', { strokeWidth: n })}
          />
        </div>
      </section>
      ) : null}

      {showLine ? (
      <section>
        <h4 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">
          Lines
        </h4>
        <div className="grid grid-cols-2 gap-2">
          <Color
            label="Color"
            value={value.line.color}
            onChange={(c) => patch('line', { color: c })}
          />
          <Slider
            label="Width"
            min={0.5}
            max={12}
            step={0.5}
            value={value.line.width}
            onChange={(n) => patch('line', { width: n })}
          />
        </div>
      </section>
      ) : null}

      {showPoint ? (
        <section>
          <h4 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">
            Points
          </h4>
          <div className="mb-2 grid grid-cols-2 gap-2">
            <SymbolBtn
              active={(value.point.symbol ?? 'circle') === 'circle'}
              onClick={() => patch('point', { symbol: 'circle' })}
              label="Circle"
            />
            <SymbolBtn
              active={value.point.symbol === 'icon'}
              onClick={() =>
                patch('point', {
                  symbol: 'icon',
                  iconName: value.point.iconName || 'map-pin',
                })
              }
              label="Icon"
            />
          </div>

          {value.point.symbol === 'icon' ? (
            <>
              <IconPicker
                value={value.point.iconName}
                onChange={(iconName) => patch('point', { iconName })}
              />
              <div className="mt-3 space-y-3">
                <Slider
                  label="Icon size"
                  min={0.5}
                  max={3}
                  step={0.1}
                  value={value.point.iconSize ?? 1}
                  onChange={(n) => patch('point', { iconSize: n })}
                />
                <label className="flex cursor-pointer items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={value.point.iconTint !== false}
                    onChange={(e) =>
                      patch('point', { iconTint: e.target.checked })
                    }
                    className="h-3.5 w-3.5 rounded border-border text-accent focus:ring-accent/30"
                  />
                  <span className="text-ink-1">Tint with fill color</span>
                </label>
                {value.point.iconTint !== false ? (
                  <Color
                    label="Fill"
                    value={value.point.color}
                    onChange={(c) => patch('point', { color: c })}
                  />
                ) : null}
              </div>
              <p className="mt-2 text-[11px] text-muted">
                Tinting renders the icon as a signed-distance field
                so the fill color applies cleanly at any size.
                Un-tick if you want the icon to stay in its shipped
                color.
              </p>
            </>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              <Color
                label="Fill"
                value={value.point.color}
                onChange={(c) => patch('point', { color: c })}
              />
              <Slider
                label="Radius"
                min={2}
                max={24}
                step={1}
                value={value.point.radius}
                onChange={(n) => patch('point', { radius: n })}
              />
              <Color
                label="Outline"
                value={value.point.strokeColor}
                onChange={(c) => patch('point', { strokeColor: c })}
              />
              <Slider
                label="Outline width"
                min={0}
                max={6}
                step={0.5}
                value={value.point.strokeWidth}
                onChange={(n) => patch('point', { strokeWidth: n })}
              />
            </div>
          )}
        </section>
      ) : null}
    </div>
  );
}

function SymbolBtn({
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
 * Icon grid for the point symbol picker. Searchable across label +
 * category so users can type what they're looking for rather than
 * browse the whole library. Selecting an entry sets the layer's
 * iconName; an SVG preview renders each option at 24x24.
 */
function IconPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (name: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<string>('all');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return Object.entries(MAP_ICONS).filter(([name, icon]) => {
      if (category !== 'all' && icon.category !== category) return false;
      if (!q) return true;
      return (
        name.includes(q) ||
        icon.label.toLowerCase().includes(q) ||
        icon.category.toLowerCase().includes(q)
      );
    });
  }, [query, category]);

  return (
    <div className="rounded-md border border-border bg-surface-1 p-2">
      <div className="mb-2 flex gap-2">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search icons..."
          className="h-7 min-w-0 flex-1 rounded border border-border bg-surface-1 px-2 text-xs focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
        />
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          className="h-7 rounded border border-border bg-surface-1 px-1 text-xs focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
        >
          <option value="all">all</option>
          {MAP_ICON_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </div>
      <div className="grid max-h-40 grid-cols-6 gap-1 overflow-y-auto">
        {filtered.map(([name, icon]) => {
          const svg = renderIconSvg(name) ?? '';
          const active = name === value;
          return (
            <button
              key={name}
              type="button"
              onClick={() => onChange(name)}
              title={icon.label}
              className={`flex aspect-square items-center justify-center rounded border p-1 transition-colors ${
                active
                  ? 'border-accent bg-accent/10 ring-2 ring-accent/30'
                  : 'border-border bg-surface-1 hover:bg-surface-2'
              }`}
              dangerouslySetInnerHTML={{ __html: svg }}
            />
          );
        })}
        {filtered.length === 0 ? (
          <div className="col-span-6 py-4 text-center text-[11px] text-muted">
            No icons match.
          </div>
        ) : null}
      </div>
    </div>
  );
}

function Color({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (hex: string) => void;
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
          className="h-7 min-w-0 flex-1 rounded border border-border bg-surface-1 px-2 text-xs font-mono focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
        />
      </div>
    </label>
  );
}

function Slider({
  label,
  min,
  max,
  step,
  value,
  onChange,
}: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (n: number) => void;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="flex items-center justify-between text-[10px] text-muted">
        <span>{label}</span>
        <span className="tabular-nums">{value}</span>
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
