// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * #159 Phase 2.4 print-snapshot paint generator.
 *
 * The on-screen map canvas (map-canvas.tsx) emits MapLibre layers
 * with full renderer-aware paint: unique-values, class-breaks,
 * time-bins, and labels. The Phase 2.2 / 2.3 snapshot only
 * honored the layer's simple style, so a parcels layer styled by
 * zoning type with five colors would print as a single indigo
 * fill regardless. This module brings the snapshot to parity with
 * the canvas for those four renderer kinds + labels, without
 * dragging in the canvas's cluster / zoom-step / hover-highlight
 * complexity (none of which matter to a one-shot print render).
 *
 * Architecture: addPaintForLayer(map, sourceId, layerId, layer)
 * adds the right combination of fill / line / circle layers with
 * paint expressions derived from the layer's renderer. Labels go
 * via a separate addLabelLayer call so the caller can skip them
 * when a layer doesn't carry text.
 *
 * Long-term we should consolidate templateToExpression /
 * rendererColorExpression with the canvas's copies via a shared
 * module so the two surfaces don't drift; for this phase the
 * helpers are inlined and marked with a `MIRROR:` comment so the
 * unification work is easy to spot.
 */
import type * as maplibregl from 'maplibre-gl';
import {
  dashArrayFor,
  type MapLayer,
  type MapLayerRenderer,
} from '@gratis-gis/shared-types';
import { zoomForScale } from '@/lib/web-mercator';
import {
  combineFilter,
  timeBinsColorExpression,
} from '@/lib/map-layer-expressions';

/**
 * Add the fill / line / circle paint layers for `layer` against
 * `sourceId`. Picks renderer-appropriate color expressions and
 * applies the layer's opacity multiplier across every paint
 * property. Geometry-type filters keep fill / line / circle
 * scoped to the right feature kinds even when the source is a
 * mixed-geometry collection.
 */
export function addPaintForLayer(
  map: maplibregl.Map,
  sourceId: string,
  layerId: string,
  layer: MapLayer,
): boolean {
  const op = clamp01(layer.opacity ?? 1);
  const style = layer.style;
  const renderer = layer.renderer;
  // The layer's attribute filter applies to every paint layer, as on
  // the canvas, so the PDF shows the same features the map does.
  const where = (geom: unknown[]) => combineFilter(geom, layer.filter);
  let ok = true;

  // Polygon fill. Color expression derives from the renderer, falls
  // back to style.polygon.fillColor.
  ok =
    safeAddLayer(map, {
      id: `pg:${layerId}:fill`,
      type: 'fill',
      source: sourceId,
      filter: where(['==', ['geometry-type'], 'Polygon']),
      paint: {
        'fill-color': colorExpression(
          renderer,
          style.polygon.fillColor,
        ) as maplibregl.ExpressionSpecification,
        'fill-opacity': (style.polygon.fillOpacity ?? 0.25) * op,
      },
    }) && ok;

  // Polygon outline, from the polygon stroke settings as the canvas
  // draws it (the renderer color, else strokeColor). It used to share
  // one layer with lines and took the line color and width.
  ok =
    safeAddLayer(map, {
      id: `pg:${layerId}:poly-line`,
      type: 'line',
      source: sourceId,
      filter: where(['==', ['geometry-type'], 'Polygon']),
      paint: {
        'line-color': colorExpression(
          renderer,
          style.polygon.strokeColor,
        ) as maplibregl.ExpressionSpecification,
        'line-width': style.polygon.strokeWidth ?? 1.5,
        'line-opacity': op,
        ...(style.polygon.strokeDashStyle &&
        style.polygon.strokeDashStyle !== 'solid'
          ? { 'line-dasharray': dashArrayFor(style.polygon.strokeDashStyle) }
          : {}),
      },
    }) && ok;

  // Lines.
  ok =
    safeAddLayer(map, {
      id: `pg:${layerId}:line`,
      type: 'line',
      source: sourceId,
      filter: where(['==', ['geometry-type'], 'LineString']),
      paint: {
        'line-color': colorExpression(
          renderer,
          style.line.color,
        ) as maplibregl.ExpressionSpecification,
        'line-width': style.line.width ?? 1.5,
        'line-opacity': op,
        ...(style.line.dashStyle && style.line.dashStyle !== 'solid'
          ? { 'line-dasharray': dashArrayFor(style.line.dashStyle) }
          : {}),
      },
    }) && ok;

  // Points / circles. Color expression follows the renderer.
  ok =
    safeAddLayer(map, {
      id: `pg:${layerId}:circle`,
      type: 'circle',
      source: sourceId,
      filter: where(['==', ['geometry-type'], 'Point']),
      paint: {
        'circle-color': colorExpression(
          renderer,
          style.point.color,
        ) as maplibregl.ExpressionSpecification,
        'circle-radius': style.point.radius ?? 5,
        'circle-stroke-color': style.point.strokeColor ?? '#ffffff',
        'circle-stroke-width': style.point.strokeWidth ?? 1.5,
        'circle-opacity': op,
        'circle-stroke-opacity': op,
      },
    }) && ok;
  return ok;
}

/**
 * Add the per-layer label symbol layer when labels are enabled
 * AND carry a non-empty template. Mirrors the canvas's symbol
 * layer spec.
 */
export function addLabelLayer(
  map: maplibregl.Map,
  sourceId: string,
  layerId: string,
  layer: MapLayer,
): boolean {
  const labels = layer.labels;
  if (!labels?.enabled || !labels.template) return true;
  const op = clamp01(layer.opacity ?? 1);
  const textExpr = templateToExpression(labels.template);
  return safeAddLayer(map, {
    id: `pg:${layerId}:label`,
    type: 'symbol',
    source: sourceId,
    ...(layer.filter && layer.filter.clauses.length > 0
      ? { filter: combineFilter(['all'], layer.filter) }
      : {}),
    layout: {
      'text-field':
        textExpr as maplibregl.DataDrivenPropertyValueSpecification<string>,
      'text-size': labels.size ?? 12,
      'text-anchor': labels.anchor ?? 'center',
      'text-offset': [labels.offsetX ?? 0, labels.offsetY ?? 0],
      'text-allow-overlap': false,
      'text-ignore-placement': false,
      'text-padding': 2,
      'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'],
      'symbol-placement': labels.placement === 'line' ? 'line' : 'point',
    },
    paint: {
      'text-color': labels.color ?? '#111827',
      'text-halo-color': labels.haloColor ?? '#ffffff',
      'text-halo-width': labels.haloWidth ?? 1,
      'text-opacity': op,
    },
  });
}

/**
 * Build a MapLibre color expression for the given renderer. Falls
 * back to `defaultColor` when the renderer is `simple` or any of
 * the typed-renderer fields are empty.
 *
 * MIRROR: this mirrors the canvas's color-expression logic
 * (map-canvas.tsx, around line 2700). When unifying later, lift
 * this into a shared module both consume.
 */
function colorExpression(
  renderer: MapLayerRenderer | null | undefined,
  defaultColor: string,
): unknown {
  if (!renderer || renderer.kind === 'simple') return defaultColor;

  if (renderer.kind === 'unique-values') {
    if (renderer.categories.length === 0) return defaultColor;
    // MapLibre `match`: ['match', input, value, output, ..., default].
    // Field is coerced to string so a numeric "ZONE 5" matches.
    const matchArgs: unknown[] = [
      'match',
      ['to-string', ['get', renderer.field]],
    ];
    for (const c of renderer.categories) {
      matchArgs.push(c.value, c.color);
    }
    matchArgs.push(defaultColor);
    return matchArgs;
  }

  if (renderer.kind === 'class-breaks') {
    // MapLibre `step`: ['step', input, color0, stop1, color1, ...].
    // colors[] has stops.length + 1 entries.
    if (renderer.stops.length === 0 || renderer.colors.length === 0) {
      return defaultColor;
    }
    const stepArgs: unknown[] = [
      'step',
      ['to-number', ['get', renderer.field]],
      renderer.colors[0] ?? defaultColor,
    ];
    for (let i = 0; i < renderer.stops.length; i++) {
      stepArgs.push(renderer.stops[i], renderer.colors[i + 1] ?? defaultColor);
    }
    return stepArgs;
  }

  if (renderer.kind === 'time-bins') {
    // MapLibre `step` takes numbers only, so an ISO-string `step` was
    // an invalid expression and the whole layer vanished. Same case
    // chain as the canvas.
    return timeBinsColorExpression(renderer) ?? renderer.defaultColor;
  }

  return defaultColor;
}

/**
 * Handlebars-lite template -> MapLibre text-field expression.
 *
 * MIRROR of map-canvas.tsx's templateToExpression. Kept inline
 * for this phase; long-term lift into a shared module.
 */
function templateToExpression(template: string): unknown {
  const re = /\{\{\s*([\w.-]+)\s*(?:\|\s*([\w.-]+)(?:\s*:\s*([^}]+))?\s*)?\}\}/g;
  const parts: unknown[] = [];
  let lastIndex = 0;
  for (
    let match = re.exec(template);
    match !== null;
    match = re.exec(template)
  ) {
    const [full, field, formatter, arg] = match;
    if (match.index > lastIndex) {
      parts.push(template.slice(lastIndex, match.index));
    }
    parts.push(formatterExpression(field!, formatter, arg));
    lastIndex = match.index + full.length;
  }
  if (lastIndex < template.length) {
    parts.push(template.slice(lastIndex));
  }
  if (parts.length === 0) return '';
  if (parts.length === 1 && typeof parts[0] === 'string') return parts[0];
  return ['concat', ...parts];
}

function formatterExpression(
  field: string,
  formatter?: string,
  _arg?: string,
): unknown {
  const base = ['to-string', ['get', field]];
  switch (formatter?.toLowerCase()) {
    case 'upper':
      return ['upcase', base];
    case 'lower':
      return ['downcase', base];
    case 'number':
      return [
        'number-format',
        ['to-number', ['get', field]],
        { 'min-fraction-digits': 0 },
      ];
    default:
      return base;
  }
}

/**
 * Scale denominator to MapLibre zoom, so MapSnapshot can honor
 * PrintMapElement.scaleOverride (50000 for 1:50,000) over the bound
 * map's persisted zoom. See lib/web-mercator.ts for why this is not
 * the 256 px tile formula.
 */
export function scaleToZoom(scale: number, latDeg: number): number {
  return zoomForScale(scale, latDeg);
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 1;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/**
 * Add a layer and say whether it is actually on the map. MapLibre
 * reports an invalid paint expression through its `error` event and
 * skips the layer instead of throwing, so check for it afterwards.
 * The caller lists a failed layer in the sheet's "incomplete" notice.
 */
function safeAddLayer(
  map: maplibregl.Map,
  spec: maplibregl.LayerSpecification,
): boolean {
  try {
    map.addLayer(spec);
  } catch {
    return false;
  }
  return Boolean(map.getLayer(spec.id));
}
