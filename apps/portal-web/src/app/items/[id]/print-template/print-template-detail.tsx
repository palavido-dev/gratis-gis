// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

/**
 * #101: Print template designer.
 *
 * Edits a PrintTemplateData blueprint stored on a print_template
 * item.  The designer feels intentionally similar to the Custom Web
 * App designer the user is already using:
 *
 *   - Paper-sized canvas in the center, scrollable, with a soft
 *     margin shadow so the printable area is obvious.
 *   - Left palette of element types (Text, Image, Map, Legend,
 *     Scalebar, North arrow, Line, Rectangle) -- drag onto canvas
 *     or click "Add" to drop at the center.
 *   - Right rail: paper config (size + orientation + margin),
 *     selected-element property panel, and parameter editor.
 *
 * Out of scope for this first cut (acknowledged followups):
 *   - Multi-page print + page-break elements
 *   - Image-upload UX for the image element (URL paste works)
 *   - String-expression escape hatch (token chips only)
 *   - Live PDF preview of the rendered output (designer shows a
 *     WYSIWYG-ish DOM render; runtime renders to PDF separately)
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Compass,
  Image as ImageIcon,
  Layers,
  Map as MapIcon,
  Minus,
  Plus,
  Printer,
  Ruler,
  Save,
  Settings,
  Square,
  Trash2,
  Type as TypeIcon,
} from 'lucide-react';
import { BuilderShell } from '@/components/builder-shell/builder-shell';
import {
  DYNAMIC_TOKEN_IDS,
  resolvePaperInches,
  type DynamicTokenId,
  type PrintElement,
  type PrintElementBox,
  type PrintElementKind,
  type PrintImageElement,
  type PrintLegendElement,
  type PrintLineElement,
  type PrintMapElement,
  type PrintNorthArrowElement,
  type PrintPaperSize,
  type PrintPaperSpec,
  type PrintRectangleElement,
  type PrintScalebarElement,
  type PrintTemplateData,
  type PrintTemplateParameter,
  type PrintTextElement,
  type PrintTextSegment,
} from '@gratis-gis/shared-types';

interface PrintTemplateDetailProps {
  itemId: string;
  initialBlueprint: PrintTemplateData;
  seedKind: string | null;
  canEdit: boolean;
}

/** Pixels per inch on the design surface.  Picked so a Letter page
 *  (8.5 x 11 in) takes ~816 x 1056 px at 100% zoom -- comfortable on
 *  a typical 1440-wide layout pane.  Independent of the print DPI;
 *  the server renders at its own (higher) DPI. */
const DESIGN_DPI = 96;

const PAPER_SIZE_OPTIONS: { value: PrintPaperSize; label: string }[] = [
  { value: 'letter', label: 'Letter (8.5 × 11 in)' },
  { value: 'legal', label: 'Legal (8.5 × 14 in)' },
  { value: 'tabloid', label: 'Tabloid (11 × 17 in)' },
  { value: 'a3', label: 'A3 (297 × 420 mm)' },
  { value: 'a4', label: 'A4 (210 × 297 mm)' },
];

const ELEMENT_PALETTE: {
  kind: PrintElementKind;
  label: string;
  Icon: typeof TypeIcon;
}[] = [
  { kind: 'text', label: 'Text', Icon: TypeIcon },
  { kind: 'map', label: 'Map', Icon: MapIcon },
  { kind: 'legend', label: 'Legend', Icon: Layers },
  { kind: 'scalebar', label: 'Scalebar', Icon: Ruler },
  { kind: 'north-arrow', label: 'North arrow', Icon: Compass },
  { kind: 'image', label: 'Image', Icon: ImageIcon },
  { kind: 'line', label: 'Line', Icon: Minus },
  { kind: 'rectangle', label: 'Rectangle', Icon: Square },
];

const DYNAMIC_TOKEN_LABELS: Record<DynamicTokenId, string> = {
  today_date: "Today's date",
  today_datetime: "Today's date + time",
  now_time: 'Current time',
  map_scale: 'Map scale',
  map_extent_bbox: 'Map extent (BBOX)',
  map_center_latlon: 'Map center (lat, lon)',
  user_display_name: 'User name',
  org_name: 'Org name',
  app_name: 'App name',
  page_number: 'Page number',
};

let elementIdCounter = 0;
function freshElementId(kind: PrintElementKind): string {
  elementIdCounter += 1;
  return `${kind}-${Date.now().toString(36)}-${elementIdCounter}`;
}

function defaultElement(kind: PrintElementKind, box: PrintElementBox): PrintElement {
  const id = freshElementId(kind);
  switch (kind) {
    case 'text':
      return {
        id,
        kind: 'text',
        box,
        segments: [{ kind: 'literal', text: 'Text' }],
        fontSizePt: 12,
        align: 'left',
      };
    case 'image':
      return {
        id,
        kind: 'image',
        box,
        url: '',
        objectFit: 'contain',
      };
    case 'map':
      return {
        id,
        kind: 'map',
        box,
        border: { widthPt: 0.75, color: '#444' },
        grid: 'none',
      };
    case 'legend':
      return {
        id,
        kind: 'legend',
        box,
        title: 'Legend',
        fontSizePt: 9,
        border: { widthPt: 0.5, color: '#888' },
      };
    case 'scalebar':
      return {
        id,
        kind: 'scalebar',
        box,
        style: 'bar',
        units: 'imperial',
      };
    case 'north-arrow':
      return {
        id,
        kind: 'north-arrow',
        box,
        style: 'compass',
      };
    case 'line':
      return {
        id,
        kind: 'line',
        box: { ...box, h: 0.02 },
        thicknessPt: 0.75,
        color: '#888',
      };
    case 'rectangle':
      return {
        id,
        kind: 'rectangle',
        box,
        border: { widthPt: 0.5, color: '#888' },
      };
  }
}

interface ActiveGesture {
  kind: 'move' | 'resize-br';
  elementId: string;
  startX: number;
  startY: number;
  startBox: PrintElementBox;
}

export function PrintTemplateDetail({
  itemId,
  initialBlueprint,
  seedKind,
  canEdit,
}: PrintTemplateDetailProps) {
  const [data, setData] = useState<PrintTemplateData>(() => initialBlueprint);
  const [dirty, setDirty] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(0.85);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const [gesture, setGesture] = useState<ActiveGesture | null>(null);

  useEffect(() => {
    setData(initialBlueprint);
    setDirty(false);
  }, [initialBlueprint]);

  const paperIn = useMemo(() => resolvePaperInches(data.paper), [data.paper]);
  const canvasW = paperIn.w * DESIGN_DPI * zoom;
  const canvasH = paperIn.h * DESIGN_DPI * zoom;
  const margin = data.paper.marginIn;

  const selected = useMemo(
    () => data.elements.find((e) => e.id === selectedId) ?? null,
    [data.elements, selectedId],
  );

  // ---- Save ------------------------------------------------------

  const onSave = useCallback(async () => {
    if (!canEdit) return;
    setSaving(true);
    setSaveError(null);
    try {
      const res = await fetch(`/api/portal/items/${itemId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ data }),
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new Error(`${res.status} ${txt}`);
      }
      setDirty(false);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [canEdit, data, itemId]);

  // ---- Element CRUD ----------------------------------------------

  const addElement = useCallback(
    (kind: PrintElementKind) => {
      if (!canEdit) return;
      // Drop near top-left, leaving room inside the margin.  Author
      // can drag to wherever they want from there.
      const initialBox: PrintElementBox = {
        x: margin + 0.5,
        y: margin + 0.5,
        w: kind === 'map' ? 4 : kind === 'line' ? 3 : 2,
        h: kind === 'map' ? 3 : kind === 'line' ? 0.02 : 0.5,
      };
      const el = defaultElement(kind, initialBox);
      setData((cur) => ({ ...cur, elements: [...cur.elements, el] }));
      setSelectedId(el.id);
      setDirty(true);
    },
    [canEdit, margin],
  );

  const updateElement = useCallback(
    (id: string, patch: Partial<PrintElement>) => {
      setData((cur) => ({
        ...cur,
        elements: cur.elements.map((e) =>
          e.id === id ? ({ ...e, ...patch } as PrintElement) : e,
        ),
      }));
      setDirty(true);
    },
    [],
  );

  const updateElementBox = useCallback(
    (id: string, box: PrintElementBox) => {
      setData((cur) => ({
        ...cur,
        elements: cur.elements.map((e) =>
          e.id === id ? { ...e, box } : e,
        ),
      }));
      setDirty(true);
    },
    [],
  );

  const deleteElement = useCallback((id: string) => {
    setData((cur) => ({
      ...cur,
      elements: cur.elements.filter((e) => e.id !== id),
    }));
    setSelectedId(null);
    setDirty(true);
  }, []);

  // ---- Paper config ----------------------------------------------

  const updatePaper = useCallback((patch: Partial<PrintPaperSpec>) => {
    setData((cur) => ({ ...cur, paper: { ...cur.paper, ...patch } }));
    setDirty(true);
  }, []);

  // ---- Parameter CRUD --------------------------------------------

  const addParameter = useCallback(() => {
    setData((cur) => {
      // Generate a fresh id that doesn't collide.
      let i = 1;
      const existing = new Set(cur.parameters.map((p) => p.id));
      let id = `param${i}`;
      while (existing.has(id)) {
        i++;
        id = `param${i}`;
      }
      return {
        ...cur,
        parameters: [
          ...cur.parameters,
          {
            id,
            label: `Parameter ${i}`,
            type: 'text',
            defaultValue: '',
          },
        ],
      };
    });
    setDirty(true);
  }, []);

  const updateParameter = useCallback(
    (id: string, patch: Partial<PrintTemplateParameter>) => {
      setData((cur) => ({
        ...cur,
        parameters: cur.parameters.map((p) =>
          p.id === id ? { ...p, ...patch } : p,
        ),
      }));
      setDirty(true);
    },
    [],
  );

  const deleteParameter = useCallback((id: string) => {
    setData((cur) => ({
      ...cur,
      parameters: cur.parameters.filter((p) => p.id !== id),
    }));
    setDirty(true);
  }, []);

  // ---- Drag gesture -----------------------------------------------
  //
  // Click + drag on an element body moves it on the canvas; click +
  // drag on the bottom-right handle resizes.  Same machinery as the
  // Custom Web App canvas, just in inch coordinates.

  const beginGesture = useCallback(
    (
      kind: ActiveGesture['kind'],
      element: PrintElement,
      e: ReactMouseEvent<HTMLDivElement>,
    ) => {
      if (!canEdit) return;
      e.stopPropagation();
      setGesture({
        kind,
        elementId: element.id,
        startX: e.clientX,
        startY: e.clientY,
        startBox: element.box,
      });
    },
    [canEdit],
  );

  useEffect(() => {
    if (!gesture) return;
    const g = gesture;
    function pxPerInch(): number {
      return DESIGN_DPI * zoom;
    }
    function onMove(e: MouseEvent) {
      const dx = (e.clientX - g.startX) / pxPerInch();
      const dy = (e.clientY - g.startY) / pxPerInch();
      if (g.kind === 'move') {
        updateElementBox(g.elementId, {
          ...g.startBox,
          x: Math.max(0, g.startBox.x + dx),
          y: Math.max(0, g.startBox.y + dy),
        });
      } else {
        updateElementBox(g.elementId, {
          ...g.startBox,
          w: Math.max(0.1, g.startBox.w + dx),
          h: Math.max(0.05, g.startBox.h + dy),
        });
      }
    }
    function onUp() {
      setGesture(null);
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [gesture, updateElementBox, zoom]);

  // ---- Render (BuilderShell-wrapped) ------------------------------

  const titleSummary = `${data.elements.length} element${data.elements.length === 1 ? '' : 's'} · ${data.parameters.length} parameter${data.parameters.length === 1 ? '' : 's'}`;

  const toolbarRight = (
    <div className="flex items-center gap-2">
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => setZoom((z) => Math.max(0.4, z - 0.1))}
          className="rounded border border-border bg-surface-0 px-2 py-1 text-xs hover:bg-surface-2"
          aria-label="Zoom out"
        >
          <Minus className="h-3.5 w-3.5" />
        </button>
        <span className="w-12 text-center text-xs text-muted">
          {Math.round(zoom * 100)}%
        </span>
        <button
          type="button"
          onClick={() => setZoom((z) => Math.min(1.5, z + 0.1))}
          className="rounded border border-border bg-surface-0 px-2 py-1 text-xs hover:bg-surface-2"
          aria-label="Zoom in"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>
      <button
        type="button"
        onClick={onSave}
        disabled={!canEdit || !dirty || saving}
        className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white shadow-sm transition-colors hover:bg-accent/90 disabled:cursor-not-allowed disabled:bg-muted disabled:text-ink-2"
      >
        <Save className="h-3.5 w-3.5" />
        {saving ? 'Saving…' : dirty ? 'Save changes' : 'Saved'}
      </button>
    </div>
  );

  const leftPanel = (
    <div className="p-2">
      <div className="grid grid-cols-2 gap-1.5">
        {ELEMENT_PALETTE.map(({ kind, label, Icon }) => (
          <button
            key={kind}
            type="button"
            disabled={!canEdit}
            onClick={() => addElement(kind)}
            className="flex flex-col items-center gap-1 rounded-md border border-border bg-surface-0 px-2 py-2 text-[10px] font-medium text-ink-1 transition-colors hover:bg-surface-2 disabled:opacity-50"
            title={`Add ${label}`}
          >
            <Icon className="h-4 w-4" strokeWidth={1.75} />
            {label}
          </button>
        ))}
      </div>
      {seedKind ? (
        <div className="mt-3 rounded bg-warn/15 px-2 py-1 text-[10px] font-medium text-warn">
          Built-in starter
        </div>
      ) : null}
    </div>
  );

  const rightPanel = (
    <div className="space-y-3 p-2">
      <PaperPanel paper={data.paper} canEdit={canEdit} onChange={updatePaper} />
      {selected ? (
        <ElementPanel
          element={selected}
          parameters={data.parameters}
          canEdit={canEdit}
          onChange={(patch) => updateElement(selected.id, patch)}
          onDelete={() => deleteElement(selected.id)}
        />
      ) : (
        <div className="rounded-md border border-border bg-surface-1 p-3 text-xs text-muted">
          Select an element on the canvas to edit its properties.
        </div>
      )}
      <ParameterPanel
        parameters={data.parameters}
        canEdit={canEdit}
        onAdd={addParameter}
        onUpdate={updateParameter}
        onDelete={deleteParameter}
      />
    </div>
  );

  return (
    <BuilderShell
      storageKey="builder-shell:print-template"
      backHref={`/items/${itemId}`}
      title={titleSummary}
      icon={<Printer className="h-4 w-4 text-ink-1" strokeWidth={1.75} />}
      toolbarRight={toolbarRight}
      leftPanel={leftPanel}
      leftPanelTitle="Elements"
      leftRailIcon={<Printer className="h-4 w-4" />}
      rightPanel={rightPanel}
      rightPanelTitle="Properties"
      rightRailIcon={<Settings className="h-4 w-4" />}
    >
      <div className="absolute inset-0 overflow-auto bg-surface-2/40 p-6">
        {saveError ? (
          <div className="mx-auto mb-3 max-w-3xl rounded border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
            Save failed: {saveError}
          </div>
        ) : null}
        <div
          className="relative mx-auto shadow-lg"
          style={{
            width: `${canvasW}px`,
            height: `${canvasH}px`,
            background: '#ffffff',
          }}
          ref={canvasRef}
          onClick={() => setSelectedId(null)}
        >
          {/* Margin guide */}
          <div
            className="pointer-events-none absolute border border-dashed border-border"
            style={{
              left: margin * DESIGN_DPI * zoom,
              top: margin * DESIGN_DPI * zoom,
              width: (paperIn.w - margin * 2) * DESIGN_DPI * zoom,
              height: (paperIn.h - margin * 2) * DESIGN_DPI * zoom,
            }}
          />
          {data.elements.map((el) => (
            <ElementRenderer
              key={el.id}
              element={el}
              zoom={zoom}
              parameters={data.parameters}
              selected={el.id === selectedId}
              canEdit={canEdit}
              onSelect={(e) => {
                e.stopPropagation();
                setSelectedId(el.id);
              }}
              onMoveStart={(e) => beginGesture('move', el, e)}
              onResizeStart={(e) => beginGesture('resize-br', el, e)}
            />
          ))}
        </div>
      </div>
    </BuilderShell>
  );
}

// ---- Canvas element renderer ----------------------------------

interface ElementRendererProps {
  element: PrintElement;
  zoom: number;
  parameters: PrintTemplateParameter[];
  selected: boolean;
  canEdit: boolean;
  onSelect: (e: ReactMouseEvent<HTMLDivElement>) => void;
  onMoveStart: (e: ReactMouseEvent<HTMLDivElement>) => void;
  onResizeStart: (e: ReactMouseEvent<HTMLDivElement>) => void;
}

function ElementRenderer({
  element,
  zoom,
  parameters,
  selected,
  canEdit,
  onSelect,
  onMoveStart,
  onResizeStart,
}: ElementRendererProps) {
  const px = (n: number) => n * DESIGN_DPI * zoom;
  const style: CSSProperties = {
    position: 'absolute',
    left: px(element.box.x),
    top: px(element.box.y),
    width: px(element.box.w),
    height: px(element.box.h),
    cursor: canEdit ? 'grab' : 'default',
    outline: selected ? '2px solid var(--color-accent, #2563eb)' : undefined,
    outlineOffset: '1px',
  };

  let body: React.ReactNode = null;
  switch (element.kind) {
    case 'text':
      body = <TextElementBody element={element} parameters={parameters} zoom={zoom} />;
      break;
    case 'image':
      body = <ImageElementBody element={element} />;
      break;
    case 'map':
      body = <MapElementPreview element={element} />;
      break;
    case 'legend':
      body = <LegendElementPreview element={element} />;
      break;
    case 'scalebar':
      body = <ScalebarElementPreview element={element} />;
      break;
    case 'north-arrow':
      body = <NorthArrowElementPreview element={element} />;
      break;
    case 'line':
      body = <LineElementBody element={element} />;
      break;
    case 'rectangle':
      body = <RectangleElementBody element={element} />;
      break;
  }

  return (
    <div
      role="button"
      tabIndex={0}
      style={style}
      onClick={onSelect}
      onMouseDown={canEdit ? onMoveStart : undefined}
    >
      {body}
      {selected && canEdit ? (
        <div
          className="absolute -bottom-1.5 -right-1.5 h-3 w-3 cursor-nwse-resize rounded-sm bg-accent"
          onMouseDown={onResizeStart}
        />
      ) : null}
    </div>
  );
}

// ---- Element body renderers ----------------------------------

function TextElementBody({
  element,
  parameters,
  zoom,
}: {
  element: PrintTextElement;
  parameters: PrintTemplateParameter[];
  zoom: number;
}) {
  // Render literal text inline and bindings as small chip tokens
  // so the author can see which parts will be substituted at print
  // time.  Font size is in points -- convert to px at design DPI.
  const fontPx = (element.fontSizePt / 72) * DESIGN_DPI * zoom;
  const style: CSSProperties = {
    fontFamily: element.fontFamily ?? 'Arial, sans-serif',
    fontSize: `${fontPx}px`,
    fontWeight: element.fontWeight,
    fontStyle: element.fontStyle,
    color: element.color ?? '#000',
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
      ? `${element.border.widthPt ?? 0.5}px ${element.border.style ?? 'solid'} ${element.border.color ?? '#888'}`
      : undefined,
    overflow: 'hidden',
    whiteSpace: 'pre-wrap',
  };
  return (
    <div style={style}>
      <span>
        {element.segments.map((seg, i) => (
          <SegmentToken key={i} segment={seg} parameters={parameters} />
        ))}
      </span>
    </div>
  );
}

function SegmentToken({
  segment,
  parameters,
}: {
  segment: PrintTextSegment;
  parameters: PrintTemplateParameter[];
}) {
  if (segment.kind === 'literal') {
    return <>{segment.text}</>;
  }
  let label = segment.tokenId;
  if (segment.source === 'parameter') {
    const p = parameters.find((p) => p.id === segment.tokenId);
    label = p?.label ?? segment.tokenId;
  } else if (segment.source === 'dynamic') {
    label = DYNAMIC_TOKEN_LABELS[segment.tokenId as DynamicTokenId] ?? segment.tokenId;
  }
  return (
    <span
      className="mx-0.5 inline-block rounded bg-accent/15 px-1 text-[0.85em] font-medium text-accent"
      title={`{${segment.source}.${segment.tokenId}}`}
    >
      {label}
    </span>
  );
}

function ImageElementBody({ element }: { element: PrintImageElement }) {
  if (!element.url) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-surface-2 text-[10px] text-muted">
        Image: set URL in properties
      </div>
    );
  }
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

function MapElementPreview({ element }: { element: PrintMapElement }) {
  const borderStyle: CSSProperties = element.border
    ? {
        border: `${element.border.widthPt ?? 0.75}px ${element.border.style ?? 'solid'} ${element.border.color ?? '#444'}`,
      }
    : {};
  return (
    <div
      className="flex h-full w-full items-center justify-center bg-success/10 text-[10px] text-success"
      style={borderStyle}
    >
      <MapIcon className="mr-1 h-4 w-4" /> Map
      {element.scaleOverride ? ` · 1:${element.scaleOverride.toLocaleString()}` : ''}
    </div>
  );
}

function LegendElementPreview({ element }: { element: PrintLegendElement }) {
  const borderStyle: CSSProperties = element.border
    ? {
        border: `${element.border.widthPt ?? 0.5}px ${element.border.style ?? 'solid'} ${element.border.color ?? '#888'}`,
      }
    : {};
  return (
    <div
      className="flex h-full w-full flex-col p-1 text-[9px] text-ink-1"
      style={{ ...borderStyle, background: element.backgroundColor ?? '#fff' }}
    >
      <strong className="mb-0.5 text-[10px]">{element.title ?? 'Legend'}</strong>
      <span>Layer 1</span>
      <span>Layer 2</span>
      <span>…</span>
    </div>
  );
}

function ScalebarElementPreview({ element }: { element: PrintScalebarElement }) {
  return (
    <div className="flex h-full w-full flex-col justify-center text-[9px] text-ink-1">
      <div className="flex h-2 w-full">
        <div className="flex-1 bg-slate-900" />
        <div className="flex-1 bg-white" />
        <div className="flex-1 bg-slate-900" />
        <div className="flex-1 bg-white" />
      </div>
      <div className="flex justify-between">
        <span>0</span>
        <span>{element.units === 'metric' ? 'km' : 'mi'}</span>
      </div>
    </div>
  );
}

function NorthArrowElementPreview({ element: _element }: { element: PrintNorthArrowElement }) {
  return (
    <div className="flex h-full w-full items-center justify-center text-ink-1">
      <Compass className="h-full w-full" strokeWidth={1.25} />
    </div>
  );
}

function LineElementBody({ element }: { element: PrintLineElement }) {
  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        background: element.color ?? '#888',
      }}
    />
  );
}

function RectangleElementBody({ element }: { element: PrintRectangleElement }) {
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
      }}
    />
  );
}

// ---- Right-rail panels ----------------------------------------

function PaperPanel({
  paper,
  canEdit,
  onChange,
}: {
  paper: PrintPaperSpec;
  canEdit: boolean;
  onChange: (patch: Partial<PrintPaperSpec>) => void;
}) {
  return (
    <div className="rounded-md border border-border bg-surface-1 p-3">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
        Paper
      </h3>
      <label className="block text-xs text-ink-1">
        Size
        <select
          value={paper.size}
          disabled={!canEdit}
          onChange={(e) => onChange({ size: e.target.value as PrintPaperSize })}
          className="mt-1 h-8 w-full rounded-md border border-border bg-surface-0 px-2 text-xs"
        >
          {PAPER_SIZE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      <fieldset className="mt-2 flex gap-1.5">
        <legend className="sr-only">Orientation</legend>
        <button
          type="button"
          disabled={!canEdit}
          onClick={() => onChange({ orientation: 'portrait' })}
          className={`flex-1 rounded-md border px-2 py-1.5 text-xs font-medium ${
            paper.orientation === 'portrait'
              ? 'border-accent bg-accent/10 text-accent'
              : 'border-border bg-surface-0 text-ink-1'
          }`}
        >
          Portrait
        </button>
        <button
          type="button"
          disabled={!canEdit}
          onClick={() => onChange({ orientation: 'landscape' })}
          className={`flex-1 rounded-md border px-2 py-1.5 text-xs font-medium ${
            paper.orientation === 'landscape'
              ? 'border-accent bg-accent/10 text-accent'
              : 'border-border bg-surface-0 text-ink-1'
          }`}
        >
          Landscape
        </button>
      </fieldset>
      <label className="mt-2 block text-xs text-ink-1">
        Margin (inches)
        <input
          type="number"
          min={0}
          step={0.05}
          value={paper.marginIn}
          disabled={!canEdit}
          onChange={(e) => onChange({ marginIn: Number(e.target.value) || 0 })}
          className="mt-1 h-8 w-full rounded-md border border-border bg-surface-0 px-2 text-xs"
        />
      </label>
    </div>
  );
}

function ElementPanel({
  element,
  parameters,
  canEdit,
  onChange,
  onDelete,
}: {
  element: PrintElement;
  parameters: PrintTemplateParameter[];
  canEdit: boolean;
  onChange: (patch: Partial<PrintElement>) => void;
  onDelete: () => void;
}) {
  return (
    <div className="rounded-md border border-border bg-surface-1 p-3">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">
          {element.kind} properties
        </h3>
        <button
          type="button"
          disabled={!canEdit}
          onClick={onDelete}
          className="text-xs text-danger hover:underline disabled:opacity-50"
        >
          <Trash2 className="inline h-3 w-3" /> Delete
        </button>
      </div>
      <BoxControls
        box={element.box}
        canEdit={canEdit}
        onChange={(box) => onChange({ box } as Partial<PrintElement>)}
      />
      {element.kind === 'text' ? (
        <TextProps
          element={element}
          parameters={parameters}
          canEdit={canEdit}
          onChange={onChange as (p: Partial<PrintTextElement>) => void}
        />
      ) : null}
      {element.kind === 'image' ? (
        <ImageProps
          element={element}
          canEdit={canEdit}
          onChange={onChange as (p: Partial<PrintImageElement>) => void}
        />
      ) : null}
      {element.kind === 'map' ? (
        <MapProps
          element={element}
          canEdit={canEdit}
          onChange={onChange as (p: Partial<PrintMapElement>) => void}
        />
      ) : null}
      {element.kind === 'legend' ? (
        <LegendProps
          element={element}
          canEdit={canEdit}
          onChange={onChange as (p: Partial<PrintLegendElement>) => void}
        />
      ) : null}
      {element.kind === 'scalebar' ? (
        <ScalebarProps
          element={element}
          canEdit={canEdit}
          onChange={onChange as (p: Partial<PrintScalebarElement>) => void}
        />
      ) : null}
    </div>
  );
}

function BoxControls({
  box,
  canEdit,
  onChange,
}: {
  box: PrintElementBox;
  canEdit: boolean;
  onChange: (box: PrintElementBox) => void;
}) {
  function field(key: keyof PrintElementBox, label: string) {
    return (
      <label className="block text-[11px] text-ink-1">
        {label}
        <input
          type="number"
          step={0.05}
          value={box[key]}
          disabled={!canEdit}
          onChange={(e) => onChange({ ...box, [key]: Number(e.target.value) || 0 })}
          className="mt-0.5 h-7 w-full rounded border border-border bg-surface-0 px-1.5 text-[11px]"
        />
      </label>
    );
  }
  return (
    <div className="mb-2 grid grid-cols-4 gap-1.5">
      {field('x', 'X')}
      {field('y', 'Y')}
      {field('w', 'W')}
      {field('h', 'H')}
    </div>
  );
}

function TextProps({
  element,
  parameters,
  canEdit,
  onChange,
}: {
  element: PrintTextElement;
  parameters: PrintTemplateParameter[];
  canEdit: boolean;
  onChange: (patch: Partial<PrintTextElement>) => void;
}) {
  const [literalDraft, setLiteralDraft] = useState('');

  const insertBinding = useCallback(
    (source: 'parameter' | 'dynamic', tokenId: string) => {
      if (!canEdit) return;
      // If the user has typed some literal text in the draft, push it
      // first as a literal segment so the chip appears AFTER what they
      // typed.  Then add the chip.  Clear the draft.
      const segs: PrintTextSegment[] = [...element.segments];
      if (literalDraft.length > 0) {
        const last = segs[segs.length - 1];
        if (last?.kind === 'literal') {
          segs[segs.length - 1] = { kind: 'literal', text: last.text + literalDraft };
        } else {
          segs.push({ kind: 'literal', text: literalDraft });
        }
      }
      segs.push({ kind: 'binding', source, tokenId });
      onChange({ segments: segs });
      setLiteralDraft('');
    },
    [canEdit, element.segments, literalDraft, onChange],
  );

  const removeSegment = useCallback(
    (idx: number) => {
      if (!canEdit) return;
      onChange({ segments: element.segments.filter((_, i) => i !== idx) });
    },
    [canEdit, element.segments, onChange],
  );

  const commitLiteralDraft = useCallback(() => {
    if (literalDraft.length === 0) return;
    const segs: PrintTextSegment[] = [...element.segments];
    const last = segs[segs.length - 1];
    if (last?.kind === 'literal') {
      segs[segs.length - 1] = { kind: 'literal', text: last.text + literalDraft };
    } else {
      segs.push({ kind: 'literal', text: literalDraft });
    }
    onChange({ segments: segs });
    setLiteralDraft('');
  }, [element.segments, literalDraft, onChange]);

  return (
    <div className="space-y-2">
      <div>
        <div className="text-[11px] font-medium text-muted">Content</div>
        <div className="mt-1 flex flex-wrap items-center gap-1 rounded border border-border bg-surface-0 p-1.5 text-[11px]">
          {element.segments.map((seg, i) =>
            seg.kind === 'literal' ? (
              <span key={i} className="px-0.5 text-ink-0">
                {seg.text}
                <button
                  type="button"
                  disabled={!canEdit}
                  onClick={() => removeSegment(i)}
                  className="ml-0.5 text-muted hover:text-danger"
                  aria-label="Remove text"
                >
                  ×
                </button>
              </span>
            ) : (
              <span
                key={i}
                className="inline-flex items-center gap-0.5 rounded bg-accent/15 px-1 font-medium text-accent"
              >
                {seg.source === 'parameter'
                  ? parameters.find((p) => p.id === seg.tokenId)?.label ?? seg.tokenId
                  : DYNAMIC_TOKEN_LABELS[seg.tokenId as DynamicTokenId] ?? seg.tokenId}
                <button
                  type="button"
                  disabled={!canEdit}
                  onClick={() => removeSegment(i)}
                  className="text-accent hover:text-danger"
                  aria-label="Remove chip"
                >
                  ×
                </button>
              </span>
            ),
          )}
          <input
            type="text"
            value={literalDraft}
            disabled={!canEdit}
            onChange={(e) => setLiteralDraft(e.target.value)}
            onBlur={commitLiteralDraft}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                commitLiteralDraft();
              }
            }}
            placeholder="Type text…"
            className="min-w-[60px] flex-1 bg-transparent text-[11px] outline-none"
          />
        </div>
      </div>
      <details className="rounded border border-border bg-surface-0 p-1.5 text-[11px]">
        <summary className="cursor-pointer text-muted">Insert chip…</summary>
        <div className="mt-1.5 space-y-1.5">
          {parameters.length > 0 ? (
            <div>
              <div className="text-[10px] uppercase tracking-wide text-muted">Parameters</div>
              <div className="mt-0.5 flex flex-wrap gap-1">
                {parameters.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    disabled={!canEdit}
                    onClick={() => insertBinding('parameter', p.id)}
                    className="rounded bg-accent/10 px-1.5 py-0.5 text-[10px] text-accent hover:bg-accent/20"
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          <div>
            <div className="text-[10px] uppercase tracking-wide text-muted">Dynamic</div>
            <div className="mt-0.5 flex flex-wrap gap-1">
              {DYNAMIC_TOKEN_IDS.map((id) => (
                <button
                  key={id}
                  type="button"
                  disabled={!canEdit}
                  onClick={() => insertBinding('dynamic', id)}
                  className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] text-ink-1 hover:bg-surface-2"
                >
                  {DYNAMIC_TOKEN_LABELS[id]}
                </button>
              ))}
            </div>
          </div>
        </div>
      </details>
      <div className="grid grid-cols-2 gap-1.5">
        <label className="block text-[11px] text-ink-1">
          Font size (pt)
          <input
            type="number"
            min={4}
            max={72}
            value={element.fontSizePt}
            disabled={!canEdit}
            onChange={(e) => onChange({ fontSizePt: Number(e.target.value) || 12 })}
            className="mt-0.5 h-7 w-full rounded border border-border bg-surface-0 px-1.5 text-[11px]"
          />
        </label>
        <label className="block text-[11px] text-ink-1">
          Color
          <input
            type="color"
            value={element.color ?? '#000000'}
            disabled={!canEdit}
            onChange={(e) => onChange({ color: e.target.value })}
            className="mt-0.5 h-7 w-full rounded border border-border bg-surface-0 px-1.5"
          />
        </label>
      </div>
      <div className="grid grid-cols-3 gap-1.5">
        {(['left', 'center', 'right'] as const).map((a) => {
          const Icon = a === 'left' ? AlignLeft : a === 'center' ? AlignCenter : AlignRight;
          return (
            <button
              key={a}
              type="button"
              disabled={!canEdit}
              onClick={() => onChange({ align: a })}
              className={`flex items-center justify-center rounded border px-1.5 py-1 ${
                (element.align ?? 'left') === a
                  ? 'border-accent bg-accent/10 text-accent'
                  : 'border-border bg-surface-0 text-ink-1'
              }`}
              aria-label={`Align ${a}`}
            >
              <Icon className="h-3.5 w-3.5" />
            </button>
          );
        })}
      </div>
      <div className="flex gap-1.5">
        <button
          type="button"
          disabled={!canEdit}
          onClick={() => onChange({ fontWeight: element.fontWeight === 'bold' ? 'normal' : 'bold' })}
          className={`flex-1 rounded border px-2 py-1 text-[11px] font-bold ${
            element.fontWeight === 'bold'
              ? 'border-accent bg-accent/10 text-accent'
              : 'border-border bg-surface-0 text-ink-1'
          }`}
        >
          Bold
        </button>
        <button
          type="button"
          disabled={!canEdit}
          onClick={() => onChange({ fontStyle: element.fontStyle === 'italic' ? 'normal' : 'italic' })}
          className={`flex-1 rounded border px-2 py-1 text-[11px] italic ${
            element.fontStyle === 'italic'
              ? 'border-accent bg-accent/10 text-accent'
              : 'border-border bg-surface-0 text-ink-1'
          }`}
        >
          Italic
        </button>
      </div>
    </div>
  );
}

function ImageProps({
  element,
  canEdit,
  onChange,
}: {
  element: PrintImageElement;
  canEdit: boolean;
  onChange: (patch: Partial<PrintImageElement>) => void;
}) {
  return (
    <div className="space-y-2">
      <label className="block text-[11px] text-ink-1">
        Image URL (https:// or data:)
        <input
          type="text"
          value={element.url}
          disabled={!canEdit}
          onChange={(e) => onChange({ url: e.target.value })}
          className="mt-0.5 h-7 w-full rounded border border-border bg-surface-0 px-1.5 text-[11px]"
        />
      </label>
      <label className="block text-[11px] text-ink-1">
        Object fit
        <select
          value={element.objectFit ?? 'contain'}
          disabled={!canEdit}
          onChange={(e) =>
            onChange({
              objectFit: e.target.value as NonNullable<PrintImageElement['objectFit']>,
            })
          }
          className="mt-0.5 h-7 w-full rounded border border-border bg-surface-0 px-1.5 text-[11px]"
        >
          <option value="contain">Contain</option>
          <option value="cover">Cover</option>
          <option value="fill">Fill</option>
        </select>
      </label>
    </div>
  );
}

function MapProps({
  element,
  canEdit,
  onChange,
}: {
  element: PrintMapElement;
  canEdit: boolean;
  onChange: (patch: Partial<PrintMapElement>) => void;
}) {
  return (
    <div className="space-y-2">
      <label className="block text-[11px] text-ink-1">
        Scale override (denominator, blank to use form value)
        <input
          type="number"
          min={1}
          value={element.scaleOverride ?? ''}
          disabled={!canEdit}
          onChange={(e) => {
            // Cast through Partial<PrintMapElement> to allow undefined
            // under exactOptionalPropertyTypes -- semantically "unset
            // the override" is the right behavior for an empty input.
            const patch: Partial<PrintMapElement> = e.target.value
              ? { scaleOverride: Number(e.target.value) }
              : ({ scaleOverride: undefined } as unknown as Partial<PrintMapElement>);
            onChange(patch);
          }}
          className="mt-0.5 h-7 w-full rounded border border-border bg-surface-0 px-1.5 text-[11px]"
        />
      </label>
      <label className="block text-[11px] text-ink-1">
        Grid
        <select
          value={element.grid ?? 'none'}
          disabled={!canEdit}
          onChange={(e) =>
            onChange({ grid: e.target.value as NonNullable<PrintMapElement['grid']> })
          }
          className="mt-0.5 h-7 w-full rounded border border-border bg-surface-0 px-1.5 text-[11px]"
        >
          <option value="none">None</option>
          <option value="decimal">Decimal degrees</option>
          <option value="dms">Degrees / minutes / seconds</option>
          <option value="utm">UTM</option>
        </select>
      </label>
    </div>
  );
}

function LegendProps({
  element,
  canEdit,
  onChange,
}: {
  element: PrintLegendElement;
  canEdit: boolean;
  onChange: (patch: Partial<PrintLegendElement>) => void;
}) {
  return (
    <div className="space-y-2">
      <label className="block text-[11px] text-ink-1">
        Title
        <input
          type="text"
          value={element.title ?? ''}
          disabled={!canEdit}
          onChange={(e) => onChange({ title: e.target.value })}
          className="mt-0.5 h-7 w-full rounded border border-border bg-surface-0 px-1.5 text-[11px]"
        />
      </label>
      <label className="block text-[11px] text-ink-1">
        Font size (pt)
        <input
          type="number"
          min={6}
          max={20}
          value={element.fontSizePt ?? 9}
          disabled={!canEdit}
          onChange={(e) => onChange({ fontSizePt: Number(e.target.value) || 9 })}
          className="mt-0.5 h-7 w-full rounded border border-border bg-surface-0 px-1.5 text-[11px]"
        />
      </label>
    </div>
  );
}

function ScalebarProps({
  element,
  canEdit,
  onChange,
}: {
  element: PrintScalebarElement;
  canEdit: boolean;
  onChange: (patch: Partial<PrintScalebarElement>) => void;
}) {
  return (
    <div className="space-y-2">
      <label className="block text-[11px] text-ink-1">
        Units
        <select
          value={element.units ?? 'imperial'}
          disabled={!canEdit}
          onChange={(e) =>
            onChange({
              units: e.target.value as NonNullable<PrintScalebarElement['units']>,
            })
          }
          className="mt-0.5 h-7 w-full rounded border border-border bg-surface-0 px-1.5 text-[11px]"
        >
          <option value="imperial">Imperial (miles)</option>
          <option value="metric">Metric (km)</option>
          <option value="both">Both</option>
        </select>
      </label>
    </div>
  );
}

function ParameterPanel({
  parameters,
  canEdit,
  onAdd,
  onUpdate,
  onDelete,
}: {
  parameters: PrintTemplateParameter[];
  canEdit: boolean;
  onAdd: () => void;
  onUpdate: (id: string, patch: Partial<PrintTemplateParameter>) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <div className="rounded-md border border-border bg-surface-1 p-3">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">
          Parameters
        </h3>
        <button
          type="button"
          disabled={!canEdit}
          onClick={onAdd}
          className="text-xs text-accent hover:underline disabled:opacity-50"
        >
          <Plus className="inline h-3 w-3" /> Add
        </button>
      </div>
      {parameters.length === 0 ? (
        <p className="text-[11px] text-muted">
          Parameters become form fields the user fills before printing.
        </p>
      ) : (
        <div className="space-y-2">
          {parameters.map((p) => (
            <div key={p.id} className="rounded border border-border bg-surface-0 p-2">
              <div className="flex items-center gap-1">
                <input
                  type="text"
                  value={p.label}
                  disabled={!canEdit}
                  onChange={(e) => onUpdate(p.id, { label: e.target.value })}
                  className="h-7 flex-1 rounded border border-border bg-surface-0 px-1.5 text-[11px]"
                  placeholder="Label"
                />
                <button
                  type="button"
                  disabled={!canEdit}
                  onClick={() => onDelete(p.id)}
                  className="text-xs text-danger hover:underline disabled:opacity-50"
                  aria-label="Delete parameter"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
              <div className="mt-1 grid grid-cols-2 gap-1.5">
                <select
                  value={p.type}
                  disabled={!canEdit}
                  onChange={(e) =>
                    onUpdate(p.id, {
                      type: e.target.value as PrintTemplateParameter['type'],
                    })
                  }
                  className="h-7 w-full rounded border border-border bg-surface-0 px-1.5 text-[11px]"
                >
                  <option value="text">Text</option>
                  <option value="longtext">Long text</option>
                  <option value="number">Number</option>
                  <option value="date">Date</option>
                  <option value="dropdown">Dropdown</option>
                </select>
                <input
                  type="text"
                  value={p.defaultValue ?? ''}
                  disabled={!canEdit}
                  onChange={(e) => onUpdate(p.id, { defaultValue: e.target.value })}
                  className="h-7 w-full rounded border border-border bg-surface-0 px-1.5 text-[11px]"
                  placeholder="Default value"
                />
              </div>
              <div className="mt-1 text-[10px] text-muted">
                ID: <code>{p.id}</code>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
