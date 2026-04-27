'use client';

import { List, X } from 'lucide-react';
import type { MapLayer } from '@gratis-gis/shared-types';
import { isTableLayer } from './layer-metadata';
import type { GeometryFamily, LayerMetadata } from './layer-metadata';
import { renderIconSvg } from './map-icons';

interface Props {
  open: boolean;
  layers: MapLayer[];
  metadata: Record<string, LayerMetadata>;
  onClose: () => void;
}

/**
 * Floating legend that stays in sync with the map's visible layer
 * state. Renderer-aware: a simple layer gets one swatch, unique-values
 * lists its categories with colors, class-breaks shows a gradient
 * plus numeric range labels.
 *
 * Kept as a presentational component: it doesn't subscribe to map
 * events or manage its own selection, it just renders the current
 * MapLayer[] shape. That keeps the legend honest about what the
 * map is actually drawing.
 */
export function Legend({ open, layers, metadata, onClose }: Props) {
  if (!open) return null;

  // Group headers and non-spatial tables don't render anything on
  // the map, so they don't belong in the legend either. (#73)
  // isTableLayer accepts a metadata-less default so a layer that
  // hasn't loaded yet still gets the title-suffix shortcut, which
  // is the only reliable signal for arcgis-rest tables (their
  // geojson query against a table often fails outright).
  const emptyMeta = {
    fields: [] as string[],
    valuesByField: {} as Record<string, string[]>,
    sampleProperties: null,
    featureCollection: null,
    geometryTypes: new Set<GeometryFamily>(),
    isTable: false,
    error: null,
    loading: false,
  };
  const visible = layers.filter((l) => {
    if (!l.visible) return false;
    if (l.source.kind === 'group') return false;
    if (isTableLayer(l, metadata[l.id] ?? emptyMeta)) return false;
    return true;
  });

  return (
    <div className="absolute right-4 top-4 z-10 flex max-h-[60%] w-72 flex-col overflow-hidden rounded-lg border border-border bg-surface-1/95 shadow-raised backdrop-blur">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <h3 className="inline-flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted">
          <List className="h-3.5 w-3.5" />
          Legend
        </h3>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close legend"
          className="inline-flex h-6 w-6 items-center justify-center rounded text-muted hover:bg-surface-2"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      {visible.length === 0 ? (
        <div className="p-4 text-center text-xs text-muted">
          No visible layers.
        </div>
      ) : (
        <ul className="flex-1 overflow-y-auto">
          {visible.map((layer) => (
            <li
              key={layer.id}
              className="border-b border-border px-3 py-2.5 last:border-0"
            >
              <div
                className="truncate text-sm font-medium text-ink-0"
                title={layer.title}
              >
                {layer.title}
              </div>
              <div className="mt-2">
                {(() => {
                  const g = metadata[layer.id]?.geometryTypes;
                  return (
                    <LayerSwatch
                      layer={layer}
                      {...(g ? { geometryTypes: g } : {})}
                    />
                  );
                })()}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function LayerSwatch({
  layer,
  geometryTypes,
}: {
  layer: MapLayer;
  geometryTypes?: Set<GeometryFamily>;
}) {
  const r = layer.renderer;

  if (r.kind === 'unique-values' && r.categories.length > 0 && r.field) {
    return (
      <div>
        <div className="mb-1 text-[10px] uppercase tracking-wide text-muted">
          by {r.field}
        </div>
        <ul className="space-y-1">
          {r.categories.map((c) => (
            <li key={c.value} className="flex items-center gap-2 text-xs">
              <span
                aria-hidden="true"
                className="inline-block h-3.5 w-3.5 shrink-0 rounded-sm border border-border"
                style={{ backgroundColor: c.color }}
              />
              <span className="truncate">{c.value || '(empty)'}</span>
            </li>
          ))}
          <FallbackRow layer={layer} />
        </ul>
      </div>
    );
  }

  if (
    r.kind === 'class-breaks' &&
    r.field &&
    r.stops.length > 0 &&
    r.colors.length === r.stops.length + 1
  ) {
    // Linear gradient as the visual hook, individual class ranges in a
    // list below so the numbers are readable.
    const gradient = r.colors.join(', ');
    return (
      <div>
        <div className="mb-1 text-[10px] uppercase tracking-wide text-muted">
          {r.field}
        </div>
        <div
          aria-hidden="true"
          className="h-2 rounded border border-border"
          style={{ backgroundImage: `linear-gradient(to right, ${gradient})` }}
        />
        <ul className="mt-1 space-y-0.5 text-[11px]">
          {r.colors.map((color, i) => {
            const label =
              i === 0
                ? `< ${r.stops[0]}`
                : i === r.colors.length - 1
                  ? `â‰¥ ${r.stops[r.stops.length - 1]}`
                  : `${r.stops[i - 1]} to < ${r.stops[i]}`;
            return (
              <li key={i} className="flex items-center gap-2">
                <span
                  aria-hidden="true"
                  className="inline-block h-3 w-3 shrink-0 rounded-sm border border-border"
                  style={{ backgroundColor: color }}
                />
                <span className="truncate text-muted">{label}</span>
              </li>
            );
          })}
        </ul>
      </div>
    );
  }

  // Simple renderer (or an in-progress unique-values / class-breaks).
  // Only show swatches for geometries the layer actually contains.
  // If metadata hasn't told us yet, show everything: it's better than
  // missing a mark for a geometry the user knows is there.
  return (
    <SimpleSwatches
      layer={layer}
      {...(geometryTypes ? { geometryTypes } : {})}
    />
  );
}

function SimpleSwatches({
  layer,
  geometryTypes,
}: {
  layer: MapLayer;
  geometryTypes?: Set<GeometryFamily>;
}) {
  const s = layer.style;
  const showAll = !geometryTypes || geometryTypes.size === 0;
  const showPolygon = showAll || geometryTypes.has('polygon');
  const showLine = showAll || geometryTypes.has('line');
  const showPoint = showAll || geometryTypes.has('point');

  return (
    <ul className="space-y-1 text-xs">
      {showPolygon ? (
        <li className="flex items-center gap-2">
          <PolygonMark
            fill={s.polygon.fillColor}
            stroke={s.polygon.strokeColor}
            fillOpacity={s.polygon.fillOpacity}
          />
          <span className="text-muted">polygon</span>
        </li>
      ) : null}
      {showLine ? (
        <li className="flex items-center gap-2">
          <LineMark color={s.line.color} />
          <span className="text-muted">line</span>
        </li>
      ) : null}
      {showPoint ? (
        <li className="flex items-center gap-2">
          {s.point.symbol === 'icon' && s.point.iconName ? (
            <IconMark
              iconName={s.point.iconName}
              color={s.point.iconTint !== false ? s.point.color : '#111827'}
            />
          ) : (
            <PointMark
              fill={s.point.color}
              stroke={s.point.strokeColor}
              radius={s.point.radius}
            />
          )}
          <span className="text-muted">point</span>
        </li>
      ) : null}
    </ul>
  );
}

function FallbackRow({ layer }: { layer: MapLayer }) {
  return (
    <li className="flex items-center gap-2 text-xs">
      <span
        aria-hidden="true"
        className="inline-block h-3.5 w-3.5 shrink-0 rounded-sm border border-dashed border-border"
        style={{ backgroundColor: layer.style.polygon.fillColor }}
      />
      <span className="truncate text-muted">other</span>
    </li>
  );
}

function PolygonMark({
  fill,
  stroke,
  fillOpacity,
}: {
  fill: string;
  stroke: string;
  fillOpacity: number;
}) {
  return (
    <span
      aria-hidden="true"
      className="inline-block h-4 w-4 shrink-0 rounded-sm"
      style={{
        backgroundColor: fill,
        opacity: Math.max(fillOpacity, 0.15),
        border: `1px solid ${stroke}`,
      }}
    />
  );
}

function LineMark({ color }: { color: string }) {
  return (
    <span
      aria-hidden="true"
      className="inline-block h-0.5 w-4 shrink-0 rounded"
      style={{ backgroundColor: color }}
    />
  );
}

function IconMark({
  iconName,
  color,
}: {
  iconName: string;
  color: string;
}) {
  const svg = renderIconSvg(iconName, color) ?? '';
  return (
    <span
      aria-hidden="true"
      className="inline-flex h-4 w-4 shrink-0 items-center justify-center"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

function PointMark({
  fill,
  stroke,
  radius,
}: {
  fill: string;
  stroke: string;
  radius: number;
}) {
  const px = Math.min(Math.max(radius, 4), 10);
  return (
    <span
      aria-hidden="true"
      className="inline-block shrink-0 rounded-full"
      style={{
        width: `${px * 1.5}px`,
        height: `${px * 1.5}px`,
        backgroundColor: fill,
        border: `1px solid ${stroke}`,
      }}
    />
  );
}
