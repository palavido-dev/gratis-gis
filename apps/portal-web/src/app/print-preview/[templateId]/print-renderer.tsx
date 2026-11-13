// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * #159 Phase 2.1 server-side print renderer.
 *
 * Reads a PrintTemplateData blob plus runtime parameter values
 * and emits absolute-positioned HTML that paints every layout
 * element at the template's design DPI. The Puppeteer pipeline
 * navigates the headless browser to a page that mounts this
 * component and calls page.pdf at the same paper dimensions, so
 * what the chromium sidecar captures matches what the print
 * designer's WYSIWYG showed.
 *
 * Elements:
 *   - Text elements render with the same font / color / align /
 *     border / background rules as the designer.
 *   - Image elements render via plain <img>.
 *   - Line + Rectangle elements render via styled divs.
 *   - Legend lists the bound map's visible layers; Scalebar and
 *     North arrow follow the map as printed.
 *   - Map element renders an inline MapLibre snapshot
 *     (map-snapshot.tsx), and PrintReadySignal tells the pipeline
 *     when every map on the sheet has finished.
 *
 * Token resolution: text segments referencing parameter tokens
 * resolve to the runtime-supplied value or the parameter's
 * declared defaultValue. Dynamic tokens (today_date, etc.)
 * resolve to the computed value in the requester's locale and time
 * zone; the map_* tokens follow the map as printed.
 */
import type { JSX } from 'react';
import type {
  DynamicTokenId,
  MapData,
  MapLayer,
  PrintElement,
  PrintImageElement,
  PrintLegendElement,
  PrintLineElement,
  PrintMapElement,
  PrintNorthArrowElement,
  PrintRectangleElement,
  PrintScalebarElement,
  PrintTemplateData,
  PrintTemplateParameter,
  PrintTextElement,
  PrintTextSegment,
} from '@gratis-gis/shared-types';
import { resolvePaperInches } from '@gratis-gis/shared-types';
import type { BasemapData } from '@gratis-gis/shared-types';

import { MapSnapshot } from './map-snapshot';
import { PrintReadySignal } from './print-ready-signal';
import {
  PRINT_FONT,
  PRINT_INK as INK,
  PRINT_MUTED as MUTED,
  PRINT_HAIRLINE as HAIRLINE,
  PRINT_HAIRLINE_STRONG as HAIRLINE_STRONG,
  PRINT_SAGE as SAGE,
  PRINT_SAGE_DEEP as SAGE_DEEP,
  PRINT_PAPER as PAPER,
  PRINT_CARD as CARD,
} from '@/lib/print-theme';
import { formatDate, formatDateTime, formatNumber } from '@/lib/i18n/format';
import { DEFAULT_LOCALE, type SupportedLocale } from '@/lib/i18n/locales';
import {
  metersPerPixel,
  scaleBar,
  scaleDenominator,
  zoomForScale,
} from '@/lib/web-mercator';

const DESIGN_DPI = 96;

const DYNAMIC_RESOLVERS: Record<
  DynamicTokenId,
  (ctx: RenderContext) => string
> = {
  // This renders on the server, whose clock zone is UTC. The zone
  // and locale of the person who asked for the PDF come with the
  // request, so the sheet shows their date and time.
  today_date: (ctx) => formatDate(new Date(), ctx.locale, dateOpts(ctx, { dateStyle: 'medium' })),
  today_datetime: (ctx) =>
    formatDateTime(
      new Date(),
      ctx.locale,
      dateOpts(ctx, { dateStyle: 'medium', timeStyle: 'short' }),
    ),
  now_time: (ctx) =>
    new Intl.DateTimeFormat(ctx.locale, dateOpts(ctx, { timeStyle: 'short' })).format(
      new Date(),
    ),
  // The map_* tokens follow the map as printed, including the Map
  // element's scale override, and match the browser print path.
  map_scale: (ctx) => {
    if (!ctx.mapData || ctx.mapZoom === null) return '';
    const denom = Math.round(
      scaleDenominator(ctx.mapData.center?.[1] ?? 0, ctx.mapZoom),
    );
    return `1:${formatNumber(denom, ctx.locale)}`;
  },
  map_extent_bbox: (ctx) => {
    if (!ctx.mapData?.center || ctx.mapZoom === null) return '';
    const [lng, lat] = ctx.mapData.center;
    return `center ${lat.toFixed(5)}, ${lng.toFixed(5)} z${ctx.mapZoom.toFixed(1)}`;
  },
  map_center_latlon: (ctx) => {
    if (!ctx.mapData?.center) return '';
    const [lng, lat] = ctx.mapData.center;
    return `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
  },
  user_display_name: (ctx) => ctx.userDisplayName,
  org_name: () => '',
  app_name: () => 'GratisGIS',
  page_number: () => '1',
};

function dateOpts(
  ctx: RenderContext,
  base: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormatOptions {
  return ctx.timeZone ? { ...base, timeZone: ctx.timeZone } : base;
}

/**
 * The zoom the map is printed at: the first Map element's scale
 * override when it has one, else the map's saved zoom. The scale bar
 * used the saved zoom even when the map was drawn at the override,
 * so distances read off the bar were wrong.
 */
function printZoom(
  template: PrintTemplateData,
  mapData: MapData | null,
): number | null {
  if (!mapData) return null;
  const mapEl = (template.elements ?? []).find(
    (el): el is PrintMapElement => el.kind === 'map',
  );
  const override = mapEl?.scaleOverride;
  if (typeof override === 'number' && override > 0) {
    return zoomForScale(override, mapData.center?.[1] ?? 0);
  }
  return mapData.zoom;
}

interface RenderContext {
  locale: SupportedLocale;
  /** IANA zone of the person who asked for the PDF, when known. */
  timeZone: string | null;
  /** Zoom the map is printed at; see printZoom. */
  mapZoom: number | null;
  mapId: string;
  mapData: MapData | null;
  /** Resolved basemap blob for `mapData.basemap`. Null when the
   *  bound map has no basemap, or when the bundle didn't include
   *  one (e.g. the basemap item is no longer visible). The
   *  MapSnapshot falls back to OSM raster in that case. */
  basemapData: BasemapData | null;
  parameterValues: Record<string, string>;
  parameters: PrintTemplateParameter[];
  userDisplayName: string;
}

interface Props {
  template: PrintTemplateData;
  mapId: string;
  /** Resolved MapData blob from the bound map item. Phase 2.2:
   *  flows through from the load-job endpoint so the MapSnapshot
   *  inline renderer + the layer-bound legend can read it. */
  mapData: MapData | null;
  /** Phase 2.4: resolved basemap blob, threaded through the same
   *  load-job endpoint so the print PDF uses the bound map's own
   *  basemap rather than vanilla OSM. */
  basemapData: BasemapData | null;
  parameterValues: Record<string, string>;
  userDisplayName: string;
  /** Requester's locale and time zone, already validated. */
  locale?: SupportedLocale;
  timeZone?: string | null;
}

export function PrintRenderer({
  template,
  mapId,
  mapData,
  basemapData,
  parameterValues,
  userDisplayName,
  locale = DEFAULT_LOCALE,
  timeZone = null,
}: Props): JSX.Element {
  const inches = resolvePaperInches(template.paper);
  const pageStyle: React.CSSProperties = {
    position: 'relative',
    width: `${inches.w * DESIGN_DPI}px`,
    height: `${inches.h * DESIGN_DPI}px`,
    background: 'white',
    overflow: 'hidden',
  };
  const ctx: RenderContext = {
    locale,
    timeZone,
    mapZoom: printZoom(template, mapData),
    mapId,
    mapData,
    basemapData,
    parameterValues,
    parameters: template.parameters,
    userDisplayName,
  };
  // MapBody draws a snapshot only when map data is bound.
  const mapCount = mapData
    ? (template.elements ?? []).filter((el) => el.kind === 'map').length
    : 0;
  return (
    <div style={pageStyle}>
      {(template.elements ?? []).map((el) => (
        <ElementBlock key={el.id} element={el} ctx={ctx} />
      ))}
      <PrintReadySignal mapCount={mapCount} />
    </div>
  );
}

function ElementBlock({
  element,
  ctx,
}: {
  element: PrintElement;
  ctx: RenderContext;
}) {
  const px = (n: number) => n * DESIGN_DPI;
  const wrapStyle: React.CSSProperties = {
    position: 'absolute',
    left: px(element.box.x),
    top: px(element.box.y),
    width: px(element.box.w),
    height: px(element.box.h),
  };
  let body: React.ReactNode = null;
  switch (element.kind) {
    case 'text':
      body = <TextBody element={element} ctx={ctx} />;
      break;
    case 'image':
      body = <ImageBody element={element} />;
      break;
    case 'map':
      body = <MapBody element={element} ctx={ctx} />;
      break;
    case 'legend':
      body = <LegendBody element={element} ctx={ctx} />;
      break;
    case 'scalebar':
      body = <ScalebarBody element={element} ctx={ctx} />;
      break;
    case 'north-arrow':
      body = <NorthArrowBody element={element} ctx={ctx} />;
      break;
    case 'line':
      body = <LineBody element={element} />;
      break;
    case 'rectangle':
      body = <RectangleBody element={element} />;
      break;
  }
  return <div style={wrapStyle}>{body}</div>;
}

function TextBody({
  element,
  ctx,
}: {
  element: PrintTextElement;
  ctx: RenderContext;
}) {
  const fontPx = (element.fontSizePt / 72) * DESIGN_DPI;
  const style: React.CSSProperties = {
    fontFamily: element.fontFamily ?? PRINT_FONT,
    fontSize: `${fontPx}px`,
    fontWeight: element.fontWeight,
    fontStyle: element.fontStyle,
    color: element.color ?? INK,
    textAlign: element.align ?? 'left',
    display: 'flex',
    alignItems:
      element.vAlign === 'top'
        ? 'flex-start'
        : element.vAlign === 'bottom'
          ? 'flex-end'
          : 'center',
    justifyContent:
      element.align === 'right'
        ? 'flex-end'
        : element.align === 'center'
          ? 'center'
          : 'flex-start',
    height: '100%',
    width: '100%',
    padding: '2px 4px',
    background: element.backgroundColor,
    border: element.border
      ? `${element.border.widthPt ?? 0.5}px ${element.border.style ?? 'solid'} ${element.border.color ?? HAIRLINE_STRONG}`
      : undefined,
    overflow: 'hidden',
    whiteSpace: 'pre-wrap',
    boxSizing: 'border-box',
  };
  return (
    <div style={style}>
      <span>
        {element.segments.map((seg, i) => (
          <span key={i}>{resolveSegment(seg, ctx)}</span>
        ))}
      </span>
    </div>
  );
}

function resolveSegment(segment: PrintTextSegment, ctx: RenderContext): string {
  if (segment.kind === 'literal') return segment.text;
  if (segment.source === 'parameter') {
    const supplied = ctx.parameterValues[segment.tokenId];
    if (supplied !== undefined && supplied !== '') return String(supplied);
    const decl = ctx.parameters.find((p) => p.id === segment.tokenId);
    return decl?.defaultValue ?? '';
  }
  if (segment.source === 'dynamic') {
    const fn = DYNAMIC_RESOLVERS[segment.tokenId as DynamicTokenId];
    return fn ? fn(ctx) : '';
  }
  return '';
}

function ImageBody({ element }: { element: PrintImageElement }) {
  if (!element.url) return null;
  return (
    <img
      src={element.url}
      alt={element.alt ?? ''}
      style={{
        width: '100%',
        height: '100%',
        objectFit: element.objectFit ?? 'contain',
      }}
    />
  );
}

function MapBody({
  element,
  ctx,
}: {
  element: PrintMapElement;
  ctx: RenderContext;
}) {
  const border: React.CSSProperties = element.border
    ? {
        border: `${element.border.widthPt ?? 0.75}px ${element.border.style ?? 'solid'} ${element.border.color ?? HAIRLINE_STRONG}`,
        boxSizing: 'border-box',
      }
    : {};
  if (!ctx.mapData) {
    return (
      <div
        style={{
          width: '100%',
          height: '100%',
          background: PAPER,
          ...border,
        }}
      />
    );
  }
  return (
    <div style={{ width: '100%', height: '100%', ...border }}>
      <MapSnapshot
        mapData={ctx.mapData}
        basemapData={ctx.basemapData}
        {...(typeof element.scaleOverride === 'number' &&
        element.scaleOverride > 0
          ? { scaleOverride: element.scaleOverride }
          : {})}
      />
    </div>
  );
}

function LegendBody({
  element,
  ctx,
}: {
  element: PrintLegendElement;
  ctx: RenderContext;
}) {
  const style: React.CSSProperties = {
    width: '100%',
    height: '100%',
    padding: '7px 9px',
    background: element.backgroundColor ?? CARD,
    // A legend reads as a card even when the author leaves the border
    // unset, so it never floats untethered over the map.
    border: element.border
      ? `${element.border.widthPt ?? 0.5}px ${element.border.style ?? 'solid'} ${element.border.color ?? HAIRLINE}`
      : `0.5px solid ${HAIRLINE}`,
    borderRadius: '2px',
    boxSizing: 'border-box',
    fontFamily: PRINT_FONT,
    fontSize: '10px',
    color: INK,
    overflow: 'hidden',
  };
  const layers: MapLayer[] = (ctx.mapData?.layers ?? []).filter(
    (l) => l.visible && l.source.kind !== 'group',
  );
  return (
    <div style={style}>
      <div
        style={{
          fontSize: '10px',
          fontWeight: 600,
          textTransform: 'uppercase',
          letterSpacing: '0.04em',
          color: SAGE_DEEP,
          borderBottom: `0.5px solid ${HAIRLINE}`,
          paddingBottom: '4px',
          marginBottom: '5px',
        }}
      >
        {element.title ?? 'Legend'}
      </div>
      {layers.length === 0 ? (
        <div style={{ color: MUTED }}>No visible layers</div>
      ) : (
        <ul style={{ margin: 0, padding: 0, listStyle: 'none' }}>
          {layers.map((layer) => (
            <li
              key={layer.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                marginBottom: '3px',
              }}
            >
              <LegendSwatch layer={layer} />
              <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {layer.title}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function LegendSwatch({ layer }: { layer: MapLayer }) {
  // Pick a tiny visual that matches what the layer paints:
  // colored circle for points, line for line, filled rect for
  // polygon. Falls back to the polygon family when the source
  // doesn't declare a geometry.
  const point = layer.style?.point;
  const line = layer.style?.line;
  const polygon = layer.style?.polygon;
  if (point && polygon?.fillOpacity === undefined && !line) {
    return (
      <span
        style={{
          width: '10px',
          height: '10px',
          borderRadius: '50%',
          background: point.color ?? SAGE,
          border: `${point.strokeWidth ?? 1}px solid ${point.strokeColor ?? '#fff'}`,
          flexShrink: 0,
        }}
      />
    );
  }
  if (line && !polygon) {
    return (
      <span
        style={{
          width: '14px',
          height: '3px',
          background: line.color ?? SAGE_DEEP,
          flexShrink: 0,
        }}
      />
    );
  }
  return (
    <span
      style={{
        width: '12px',
        height: '10px',
        background: polygon?.fillColor ?? point?.color ?? SAGE,
        opacity: polygon?.fillOpacity ?? 0.75,
        border: `${polygon?.strokeWidth ?? 1}px solid ${polygon?.strokeColor ?? SAGE_DEEP}`,
        flexShrink: 0,
      }}
    />
  );
}

function ScalebarBody({
  element,
  ctx,
}: {
  element: PrintScalebarElement;
  ctx: RenderContext;
}) {
  // Compute the bar's ground length using the standard
  // web-mercator pixels-per-meter at the bound map's center
  // latitude + zoom. Falls back to a 50px-wide "?" bar when
  // no map data is bound (template authoring with no map).
  // The bar segment width is fixed at 80px on paper; we pick
  // the largest nice round number that fits within that width.
  const lat = ctx.mapData?.center?.[1] ?? 0;
  const zoom = ctx.mapZoom ?? 0;
  // Up to 80 px of bar; the bar is then drawn at the length of the
  // round distance it is labelled with, so it stays to scale.
  const bar = scaleBar(
    metersPerPixel(lat, zoom),
    80,
    element.units === 'metric' ? 'metric' : 'imperial',
  );
  const displayValue = bar.value;
  const unitLabel = bar.unit;
  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        fontFamily: PRINT_FONT,
        fontSize: '9px',
        color: INK,
      }}
    >
      <div style={{ width: `${Math.round(bar.px)}px`, maxWidth: '100%' }}>
        <div style={{ display: 'flex', height: '7px', border: `1px solid ${INK}` }}>
          <div style={{ flex: 1, background: INK }} />
          <div style={{ flex: 1, background: CARD }} />
          <div style={{ flex: 1, background: INK }} />
          <div style={{ flex: 1, background: CARD }} />
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '2px' }}>
          <span>0</span>
          <span>
            {formatNumber(displayValue, ctx.locale)} {unitLabel}
          </span>
        </div>
      </div>
    </div>
  );
}

function NorthArrowBody({
  element: _element,
  ctx,
}: {
  element: PrintNorthArrowElement;
  ctx: RenderContext;
}) {
  // Rotate by minus the map bearing so the arrow always points
  // to true north regardless of which way the map is oriented
  // (a bearing of 90 means the map is rotated 90° east; the
  // arrow rotates -90° to keep N up relative to the world).
  const bearing = ctx.mapData?.bearing ?? 0;
  return (
    <svg
      viewBox="0 0 100 100"
      style={{
        width: '100%',
        height: '100%',
        transform: `rotate(${-bearing}deg)`,
      }}
      stroke={INK}
      strokeWidth={2}
      fill="none"
    >
      <polygon points="50,10 60,55 50,45 40,55" fill={SAGE_DEEP} />
      <polygon points="50,90 60,55 50,65 40,55" fill={CARD} />
      <text
        x="50"
        y="20"
        textAnchor="middle"
        fontSize="18"
        fontFamily={PRINT_FONT}
        fill={INK}
        stroke="none"
      >
        N
      </text>
    </svg>
  );
}

function LineBody({ element }: { element: PrintLineElement }) {
  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        background: element.color ?? INK,
      }}
    />
  );
}

function RectangleBody({ element }: { element: PrintRectangleElement }) {
  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        background: element.backgroundColor ?? 'transparent',
        border: element.border
          ? `${element.border.widthPt ?? 0.5}px ${element.border.style ?? 'solid'} ${element.border.color ?? '#888'}`
          : '1px solid #888',
        borderRadius: element.cornerRadiusPt
          ? `${element.cornerRadiusPt}px`
          : undefined,
        boxSizing: 'border-box',
      }}
    />
  );
}
