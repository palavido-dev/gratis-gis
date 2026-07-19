// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

/**
 * #101: render a print template at paper-sized scale, with parameter
 * values resolved into bound segments, and trigger the browser's
 * print dialog when ready.
 *
 * v1 simplifications:
 *   - Map elements render as a labeled placeholder.  Real raster
 *     rendering needs MapLibre + extent/scale plumbing from the
 *     parent web app; tracked as a followup.
 *   - Dynamic tokens that depend on map state (map_scale,
 *     map_extent_bbox, map_center_latlon) resolve to placeholder
 *     text until the map-render path lands.
 *   - The whole template renders to a single page; multi-page is
 *     out of scope per the original design (no bands).
 */

import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { useSearchParams } from 'next/navigation';
import {
  DYNAMIC_TOKEN_IDS,
  PAPER_SIZE_INCHES,
  resolvePaperInches,
  type DynamicTokenId,
  type PrintElement,
  type PrintImageElement,
  type PrintLegendElement,
  type PrintLineElement,
  type PrintMapElement,
  type PrintNorthArrowElement,
  type PrintRectangleElement,
  type PrintScalebarElement,
  type PrintTemplateData,
  type PrintTemplateParameter,
  type PrintTextElement,
  type PrintTextSegment,
} from '@gratis-gis/shared-types';
import {
  PRINT_FONT,
  PRINT_INK,
  PRINT_MUTED,
  PRINT_HAIRLINE,
  PRINT_HAIRLINE_STRONG,
  PRINT_SAGE_DEEP,
  PRINT_PAPER,
} from '@/lib/print-theme';

interface PrintRenderClientProps {
  templateId: string;
}

/** Resolution used to translate inches -> pixels on the print page.
 *  Browsers use 96 DPI for `@page` size in CSS, so matching that gives
 *  predictable WYSIWYG between the design canvas and the printed
 *  output.  The user's printer driver handles the scale to physical
 *  paper. */
const PRINT_DPI = 96;

interface MapSnapshot {
  dataUrl: string;
  center: [number, number];
  zoom: number;
  bearing: number;
  widthPx: number;
  heightPx: number;
  capturedAt: number;
}

export function PrintRenderClient({ templateId }: PrintRenderClientProps) {
  const search = useSearchParams();
  const valuesParam = search?.get('values') ?? '{}';
  const mapWidgetId = search?.get('mapWidgetId') ?? '';
  const snapToken = search?.get('snap') ?? '';

  const values: Record<string, string> = useMemo(() => {
    try {
      return JSON.parse(valuesParam) as Record<string, string>;
    } catch {
      return {};
    }
  }, [valuesParam]);

  void mapWidgetId; // mapWidgetId is consumed via the snap token now

  // #106: pull the bound map's PNG snapshot out of sessionStorage.
  // The parent app stashed it under `snapToken` right before
  // window.open(...).  We free the entry as soon as we've parsed it
  // so a stale snapshot doesn't pile up if the user re-prints.
  const mapSnapshot: MapSnapshot | null = useMemo(() => {
    if (!snapToken || typeof window === 'undefined') return null;
    try {
      const raw = window.sessionStorage.getItem(snapToken);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as MapSnapshot;
      // Don't remove the key here -- React Strict Mode would parse
      // it on the second mount and find nothing.  The token is
      // short-lived (one print session) and sessionStorage clears
      // when the tab closes, so leaving it costs nothing.
      return parsed;
    } catch {
      return null;
    }
  }, [snapToken]);

  const [template, setTemplate] = useState<PrintTemplateData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/portal/items/${templateId}`, {
          cache: 'no-store',
        });
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const body = (await res.json()) as { data: PrintTemplateData };
        if (!cancelled) setTemplate(body.data);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [templateId]);

  // Trigger the browser print dialog once the template is loaded.
  // Delay by a tick so the layout has a frame to settle (images,
  // fonts) before the print preview snapshot.
  useEffect(() => {
    if (!template) return;
    const t = setTimeout(() => {
      try {
        window.print();
      } catch {
        /* user can hit Cmd+P manually */
      }
    }, 400);
    return () => clearTimeout(t);
  }, [template]);

  if (error) {
    return (
      <div style={{ padding: 24, color: '#900', fontFamily: 'system-ui' }}>
        Failed to load print template: {error}
      </div>
    );
  }
  if (!template) {
    return (
      <div style={{ padding: 24, color: '#666', fontFamily: 'system-ui' }}>
        Loading…
      </div>
    );
  }

  const paperIn = resolvePaperInches(template.paper);
  const widthPx = paperIn.w * PRINT_DPI;
  const heightPx = paperIn.h * PRINT_DPI;

  return (
    <>
      <style jsx global>{`
        @page {
          size: ${paperIn.w}in ${paperIn.h}in;
          margin: 0;
        }
        body {
          margin: 0;
          background: #e5e7eb;
        }
        .print-page {
          width: ${widthPx}px;
          height: ${heightPx}px;
          background: white;
          margin: 24px auto;
          box-shadow: 0 4px 16px rgba(0, 0, 0, 0.1);
          position: relative;
          overflow: hidden;
        }
        @media print {
          body {
            background: white;
          }
          .print-page {
            margin: 0;
            box-shadow: none;
          }
          .no-print {
            display: none !important;
          }
        }
      `}</style>
      <div className="no-print" style={{ padding: 12, textAlign: 'center', fontFamily: 'system-ui', fontSize: 13 }}>
        Use your browser's <strong>Print → Save as PDF</strong> to produce a PDF.
      </div>
      <div className="print-page">
        {template.elements.map((el) => (
          <ElementRender
            key={el.id}
            element={el}
            parameters={template.parameters}
            values={values}
            mapSnapshot={mapSnapshot}
          />
        ))}
      </div>
    </>
  );
}

function ElementRender({
  element,
  parameters,
  values,
  mapSnapshot,
}: {
  element: PrintElement;
  parameters: PrintTemplateParameter[];
  values: Record<string, string>;
  mapSnapshot: MapSnapshot | null;
}) {
  const px = (n: number) => n * PRINT_DPI;
  const baseStyle: CSSProperties = {
    position: 'absolute',
    left: px(element.box.x),
    top: px(element.box.y),
    width: px(element.box.w),
    height: px(element.box.h),
  };
  switch (element.kind) {
    case 'text':
      return (
        <TextRender
          element={element}
          parameters={parameters}
          values={values}
          baseStyle={baseStyle}
          mapSnapshot={mapSnapshot}
        />
      );
    case 'image':
      return <ImageRender element={element} baseStyle={baseStyle} />;
    case 'map':
      return (
        <MapPlaceholderRender
          element={element}
          baseStyle={baseStyle}
          mapSnapshot={mapSnapshot}
        />
      );
    case 'legend':
      return <LegendRender element={element} baseStyle={baseStyle} />;
    case 'scalebar':
      return <ScalebarRender element={element} baseStyle={baseStyle} />;
    case 'north-arrow':
      return <NorthArrowRender element={element} baseStyle={baseStyle} />;
    case 'line':
      return <LineRender element={element} baseStyle={baseStyle} />;
    case 'rectangle':
      return <RectangleRender element={element} baseStyle={baseStyle} />;
  }
}

function resolveSegment(
  seg: PrintTextSegment,
  parameters: PrintTemplateParameter[],
  values: Record<string, string>,
  mapSnapshot: MapSnapshot | null,
): string {
  if (seg.kind === 'literal') return seg.text;
  if (seg.source === 'parameter') {
    const v = values[seg.tokenId];
    if (typeof v === 'string' && v.length > 0) return v;
    const p = parameters.find((p) => p.id === seg.tokenId);
    return p?.defaultValue ?? '';
  }
  // dynamic
  const id = seg.tokenId as DynamicTokenId;
  if (id === 'today_date') return new Date().toLocaleDateString();
  if (id === 'today_datetime') return new Date().toLocaleString();
  if (id === 'now_time') return new Date().toLocaleTimeString();
  if (id === 'page_number') return '1';
  if (id === 'user_display_name') return '';
  if (id === 'org_name') return '';
  if (id === 'app_name') return '';
  // #106: map_* dynamic tokens are populated from the parent app's
  // captured map state when available.  Without a snapshot we
  // resolve to empty so the parent's literal text still flows.
  // Scale is approximated from Web Mercator zoom: each step doubles
  // resolution, so a denominator at zoom z is roughly
  // 559082264 / 2^z at the equator.  Rough but recognizable to
  // mapmakers; "1:24,000" reads correctly to the user.
  if (id === 'map_scale') {
    if (!mapSnapshot) return '';
    const denom = Math.round(559082264 / Math.pow(2, mapSnapshot.zoom));
    return `1:${denom.toLocaleString()}`;
  }
  if (id === 'map_extent_bbox') {
    // bbox isn't in the snapshot today (followup); for now emit
    // center + zoom so the user has SOMETHING locating the print.
    if (!mapSnapshot) return '';
    return `center ${mapSnapshot.center[1].toFixed(5)}, ${mapSnapshot.center[0].toFixed(5)} z${mapSnapshot.zoom.toFixed(1)}`;
  }
  if (id === 'map_center_latlon') {
    if (!mapSnapshot) return '';
    return `${mapSnapshot.center[1].toFixed(5)}, ${mapSnapshot.center[0].toFixed(5)}`;
  }
  // Unknown dynamic ids resolve to empty so a renamed token doesn't
  // print a raw `{dynamic.unknown}` to the user.
  return '';
}

function TextRender({
  element,
  parameters,
  values,
  baseStyle,
  mapSnapshot,
}: {
  element: PrintTextElement;
  parameters: PrintTemplateParameter[];
  values: Record<string, string>;
  baseStyle: CSSProperties;
  mapSnapshot: MapSnapshot | null;
}) {
  const fontPx = (element.fontSizePt / 72) * PRINT_DPI;
  const style: CSSProperties = {
    ...baseStyle,
    fontFamily: element.fontFamily ?? PRINT_FONT,
    fontSize: `${fontPx}px`,
    fontWeight: element.fontWeight,
    fontStyle: element.fontStyle,
    color: element.color ?? PRINT_INK,
    background: element.backgroundColor,
    border: element.border
      ? `${element.border.widthPt ?? 0.5}px ${element.border.style ?? 'solid'} ${element.border.color ?? PRINT_HAIRLINE_STRONG}`
      : undefined,
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
    padding: '2px 4px',
    overflow: 'hidden',
    whiteSpace: 'pre-wrap',
    boxSizing: 'border-box',
  };
  const resolved = element.segments
    .map((s) => resolveSegment(s, parameters, values, mapSnapshot))
    .join('');
  return (
    <div style={style}>
      <span style={{ textAlign: element.align ?? 'left' as const }}>
        {resolved}
      </span>
    </div>
  );
}

function ImageRender({
  element,
  baseStyle,
}: {
  element: PrintImageElement;
  baseStyle: CSSProperties;
}) {
  if (!element.url) {
    return (
      <div
        style={{
          ...baseStyle,
          background: '#f3f4f6',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#9ca3af',
          fontSize: 11,
          fontFamily: 'system-ui',
        }}
      >
        (no image)
      </div>
    );
  }
  return (
    <img
      src={element.url}
      alt={element.alt ?? ''}
      style={{
        ...baseStyle,
        objectFit: element.objectFit ?? 'contain',
      }}
    />
  );
}

/**
 * Map element renderer.  Two modes:
 *
 * - When the parent app handed off a PNG snapshot of the live map
 *   via sessionStorage (#106), render it as a paintable image that
 *   fills the configured map box.  `object-fit: cover` reframes the
 *   snapshot to fit the print box's aspect ratio without bars,
 *   which is the right behavior for AGOL-style print: the box on
 *   paper IS the viewport, so users expect "what fit the screen,
 *   cropped to fit the paper."  A future polish can swap this for
 *   an off-screen re-render at the box's exact pixel dimensions so
 *   nothing crops, but that needs full MapData + basemap + idle
 *   plumbing and the screen snapshot is a real, recognizable map
 *   today.
 *
 * - Without a snapshot (eg the user opened the print URL directly,
 *   or the snapshot capture failed because of a tile cross-origin
 *   issue), fall back to the v1 hatch placeholder so the rest of
 *   the template still prints cleanly.
 */
function MapPlaceholderRender({
  element,
  baseStyle,
  mapSnapshot,
}: {
  element: PrintMapElement;
  baseStyle: CSSProperties;
  mapSnapshot: MapSnapshot | null;
}) {
  const borderStyle: CSSProperties = element.border
    ? {
        border: `${element.border.widthPt ?? 0.75}px ${element.border.style ?? 'solid'} ${element.border.color ?? PRINT_HAIRLINE_STRONG}`,
        boxSizing: 'border-box',
      }
    : {};
  if (mapSnapshot) {
    return (
      <div
        style={{
          ...baseStyle,
          ...borderStyle,
          overflow: 'hidden',
          background: PRINT_PAPER,
        }}
      >
        <img
          src={mapSnapshot.dataUrl}
          alt="Map"
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            display: 'block',
          }}
          // The image is a data: URL so we don't need crossOrigin,
          // and it's already fully loaded before the browser paints
          // it -- no need to gate window.print() on an onload event.
        />
      </div>
    );
  }
  return (
    <div
      style={{
        ...baseStyle,
        ...borderStyle,
        background:
          'repeating-linear-gradient(45deg, #f0fdf4, #f0fdf4 8px, #dcfce7 8px, #dcfce7 16px)',
        color: '#166534',
        fontFamily: 'system-ui',
        fontSize: 12,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      Map preview unavailable (no snapshot captured)
    </div>
  );
}

function LegendRender({
  element,
  baseStyle,
}: {
  element: PrintLegendElement;
  baseStyle: CSSProperties;
}) {
  const fontPx = ((element.fontSizePt ?? 9) / 72) * PRINT_DPI;
  return (
    <div
      style={{
        ...baseStyle,
        background: element.backgroundColor ?? '#fffdf9',
        border: element.border
          ? `${element.border.widthPt ?? 0.5}px ${element.border.style ?? 'solid'} ${element.border.color ?? PRINT_HAIRLINE}`
          : `0.5px solid ${PRINT_HAIRLINE}`,
        borderRadius: 2,
        padding: '7px 9px',
        fontFamily: PRINT_FONT,
        fontSize: `${fontPx}px`,
        color: PRINT_INK,
        overflow: 'hidden',
        boxSizing: 'border-box',
      }}
    >
      <div
        style={{
          fontSize: '10px',
          fontWeight: 600,
          textTransform: 'uppercase',
          letterSpacing: '0.04em',
          color: PRINT_SAGE_DEEP,
          borderBottom: `0.5px solid ${PRINT_HAIRLINE}`,
          paddingBottom: 4,
          marginBottom: 5,
        }}
      >
        {element.title ?? 'Legend'}
      </div>
      <div style={{ color: PRINT_MUTED }}>(see map for layers)</div>
    </div>
  );
}

function ScalebarRender({
  element,
  baseStyle,
}: {
  element: PrintScalebarElement;
  baseStyle: CSSProperties;
}) {
  return (
    <div
      style={{
        ...baseStyle,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        fontFamily: PRINT_FONT,
        fontSize: 9,
        color: PRINT_INK,
      }}
    >
      <div style={{ display: 'flex', height: 7 }}>
        <div style={{ flex: 1, background: PRINT_INK }} />
        <div style={{ flex: 1, background: '#fffdf9', border: `1px solid ${PRINT_INK}` }} />
        <div style={{ flex: 1, background: PRINT_INK }} />
        <div style={{ flex: 1, background: '#fffdf9', border: `1px solid ${PRINT_INK}` }} />
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
        <span>0</span>
        <span>{element.units === 'metric' ? 'km' : 'mi'}</span>
      </div>
    </div>
  );
}

function NorthArrowRender({
  element: _element,
  baseStyle,
}: {
  element: PrintNorthArrowElement;
  baseStyle: CSSProperties;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      style={{ ...baseStyle, color: PRINT_INK }}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.25}
    >
      <circle cx={12} cy={12} r={10} />
      <path d="M12 2 L12 22 M2 12 L22 12" />
      <path d="M12 4 L9 12 L12 10 L15 12 Z" fill={PRINT_SAGE_DEEP} stroke="none" />
      <text
        x={12}
        y={7}
        textAnchor="middle"
        fontSize={4}
        fill="currentColor"
        stroke="none"
      >
        N
      </text>
    </svg>
  );
}

function LineRender({
  element,
  baseStyle,
}: {
  element: PrintLineElement;
  baseStyle: CSSProperties;
}) {
  return (
    <div
      style={{
        ...baseStyle,
        background: element.color ?? PRINT_INK,
        borderStyle: element.style ?? 'solid',
      }}
    />
  );
}

function RectangleRender({
  element,
  baseStyle,
}: {
  element: PrintRectangleElement;
  baseStyle: CSSProperties;
}) {
  return (
    <div
      style={{
        ...baseStyle,
        background: element.backgroundColor ?? 'transparent',
        border: element.border
          ? `${element.border.widthPt ?? 0.5}px ${element.border.style ?? 'solid'} ${element.border.color ?? PRINT_HAIRLINE}`
          : `1px solid ${PRINT_HAIRLINE}`,
        borderRadius: element.cornerRadiusPt
          ? `${element.cornerRadiusPt}px`
          : undefined,
        boxSizing: 'border-box',
      }}
    />
  );
}

// Reference the DYNAMIC_TOKEN_IDS import so future-token unhandled
// in `resolveSegment` triggers a TS narrowing exhaustiveness check
// when we add new ids.
void DYNAMIC_TOKEN_IDS;
void PAPER_SIZE_INCHES;
