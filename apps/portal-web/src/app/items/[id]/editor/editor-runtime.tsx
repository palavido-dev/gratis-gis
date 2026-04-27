'use client';

import { useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  ArrowLeft,
  Eye,
  Layers,
  MousePointer2,
  PencilRuler,
  Plus,
  Redo2,
  Ruler,
  Trash2,
  Undo2,
  Wand2,
} from 'lucide-react';
import type {
  EditorData,
  EditorTool,
  Item,
  MapData,
} from '@gratis-gis/shared-types';
import type { CustomBasemap } from '@/lib/custom-basemap';
import { MapCanvas, type MapCanvasHandle } from '../map/map-canvas';
import { EDITOR_TARGET_LAYER_PREFIX } from './build-map-data';

interface Props {
  /** The Editor item id (used for the back link). */
  editorId: string;
  /** The Editor item's title (rendered in the runtime header). */
  editorTitle: string;
  /** Persisted Editor configuration. Targets, tools, snapping. */
  editor: EditorData;
  /**
   * Title of the referenced map, if any. Server resolves this so we
   * can show "Reference map: <title>" in the header without a
   * client-side fetch.
   */
  referencedMapTitle: string | null;
  /**
   * Synthesized MapData composed of the referenced map's layers + the
   * Editor's targets as new layers. See build-map-data.ts.
   */
  initialMapData: MapData;
  /** Synthetic ids for the target-layer entries within initialMapData. */
  targetLayerIds: string[];
  /** Basemap items in the org, for MapCanvas's basemap library. */
  basemaps: CustomBasemap[];
  /** Whether the caller has edit rights on the Editor item. Drives
   *  whether tool buttons are enabled at all. The runtime in slice
   *  3b-1 is read-only regardless; the flag is wired now so slice
   *  3b-2 can flip tools on cleanly. */
  canEdit: boolean;
}

/**
 * Editor runtime canvas (slice 3b-1, read-only).
 *
 * Renders the editor's composed MapData via MapCanvas. The tool
 * palette is on screen but every action is a no-op stub; clicking
 * any action button surfaces a small "coming in slice 3b-2+" toast
 * so users see the planned shape without thinking the buttons are
 * broken.
 *
 * Layer panel splits the canvas's layers into Editing (target) vs
 * Reference (everything else from the referenced map). Targets are
 * the layers MapCanvas paints in the editor's purple accent; click
 * a target row to (later) make it the active drawing target.
 *
 * What's wired now:
 *   - Basemap from referenced map (or default fallback)
 *   - Reference layers from the referenced map render with their
 *     existing symbology / labels / popups
 *   - Target layers render with the editor's accent style and pull
 *     features from /items/<id>/layers/<key>/geojson
 *   - Read-only selection (click a feature, see popup; no edit yet)
 *
 * What lands in 3b-2+:
 *   - Add tool: draw geometry per layer's geometryType, attribute
 *     panel from the layer schema, POST to v3 features
 *   - Edit, Delete, Snap toggle, Measure, Undo/Redo
 *   - Server-side conjunctive policy enforcement layered over the
 *     existing v3 share/edit checks
 */
export function EditorRuntime({
  editorId,
  editorTitle,
  editor,
  referencedMapTitle,
  initialMapData,
  targetLayerIds,
  basemaps,
  canEdit,
}: Props) {
  // Camera state mirrors what MapCanvas reports back. Right now we
  // hold it locally and don't persist (only Map items persist their
  // viewport). When the runtime grows a "remember last view" toggle
  // we can wire this through to PATCH the editor item's data.
  const [mapData, setMapData] = useState<MapData>(initialMapData);

  const canvasRef = useRef<MapCanvasHandle | null>(null);
  // Toast for "coming soon" feedback when a stub tool is clicked.
  // Self-clearing after a short delay so it never accumulates state
  // beyond the most recent action.
  const [toast, setToast] = useState<string | null>(null);

  // Layer split for the side panel: target layers (purple, editable
  // in slice 3b-2) vs reference layers (read-only context). Computed
  // from the synthesized MapData using EDITOR_TARGET_LAYER_PREFIX.
  const { targetLayers, referenceLayers } = useMemo(() => {
    const targetSet = new Set(targetLayerIds);
    const targets = mapData.layers.filter((l) => targetSet.has(l.id));
    const references = mapData.layers.filter(
      (l) => !targetSet.has(l.id) && l.source.kind !== 'group',
    );
    return { targetLayers: targets, referenceLayers: references };
  }, [mapData.layers, targetLayerIds]);

  function comingSoon(tool: EditorTool) {
    setToast(`${TOOL_LABELS[tool]} lands in the next slice.`);
    if (typeof window !== 'undefined') {
      window.setTimeout(() => setToast(null), 2200);
    }
  }

  return (
    <div className="flex h-full min-h-[calc(100vh-3.5rem)] flex-col bg-surface-0">
      {/* Top bar: back link + title + reference map breadcrumb. Kept
          intentionally thin so the canvas gets the full vertical
          budget. */}
      <header className="flex shrink-0 items-center justify-between gap-4 border-b border-border bg-surface-1 px-4 py-2">
        <div className="flex min-w-0 items-center gap-3">
          <Link
            href={`/items/${editorId}`}
            className="inline-flex items-center gap-1 text-xs text-muted hover:text-ink-0"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Back to config
          </Link>
          <span className="text-muted">/</span>
          <span className="inline-flex items-center gap-1.5 text-sm font-medium text-ink-0">
            <PencilRuler className="h-4 w-4 text-purple-600" />
            {editorTitle}
          </span>
          {referencedMapTitle ? (
            <span className="hidden items-center gap-1 text-xs text-muted sm:inline-flex">
              <span>against</span>
              <span className="font-medium text-ink-1">
                {referencedMapTitle}
              </span>
            </span>
          ) : null}
          {!canEdit ? (
            <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[11px] uppercase tracking-wide text-muted">
              View only
            </span>
          ) : (
            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-900">
              Read-only preview (tools coming soon)
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 text-xs text-muted">
          {targetLayers.length} editable layer
          {targetLayers.length === 1 ? '' : 's'}
        </div>
      </header>

      <div className="relative flex flex-1 overflow-hidden">
        {/* Tool palette: floats over the canvas in the top-left so
            the layer panel can take the right side. Buttons match
            the editor.tools list configured on the detail page;
            tools the author disabled don't appear at all. */}
        <div className="pointer-events-none absolute inset-0 z-10">
          <div className="pointer-events-auto absolute left-3 top-3 flex flex-col gap-1 rounded-md border border-border bg-surface-1 p-1 shadow-card">
            {ALL_TOOLS.filter((t) => editor.tools.includes(t.key)).map((t) => (
              <button
                key={t.key}
                type="button"
                disabled={!canEdit}
                onClick={() => comingSoon(t.key)}
                className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted hover:bg-surface-2 hover:text-ink-0 disabled:cursor-not-allowed disabled:opacity-40"
                title={`${t.label} (coming soon)`}
                aria-label={t.label}
              >
                <t.Icon className="h-4 w-4" />
              </button>
            ))}
          </div>

          {/* Layer panel: floats over the canvas top-right. Splits
              targets (editing surface) from reference layers (the
              referenced map's other layers). Visibility / opacity
              controls land in slice 3b-2 alongside the active-target
              picker. */}
          <aside className="pointer-events-auto absolute right-3 top-3 flex w-72 max-h-[calc(100%-1.5rem)] flex-col overflow-hidden rounded-md border border-border bg-surface-1 shadow-card">
            <div className="border-b border-border px-3 py-2">
              <h2 className="flex items-center gap-1.5 text-xs font-semibold text-ink-0">
                <Layers className="h-3.5 w-3.5 text-muted" />
                Layers
              </h2>
            </div>
            <div className="overflow-auto">
              <div className="px-3 py-2 text-[10px] font-medium uppercase tracking-wide text-muted">
                Editing ({targetLayers.length})
              </div>
              {targetLayers.length === 0 ? (
                <p className="px-3 pb-3 text-xs text-muted">
                  No targets configured. Pick layers in the editor's
                  configuration page.
                </p>
              ) : (
                <ul>
                  {targetLayers.map((l) => (
                    <li
                      key={l.id}
                      className="flex items-center gap-2 px-3 py-1.5 text-xs"
                    >
                      <span className="h-2.5 w-2.5 rounded-sm bg-purple-500" />
                      <span className="truncate text-ink-1" title={l.title}>
                        {l.title}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <div className="border-t border-border px-3 py-2 text-[10px] font-medium uppercase tracking-wide text-muted">
                Reference ({referenceLayers.length})
              </div>
              {referenceLayers.length === 0 ? (
                <p className="px-3 pb-3 text-xs text-muted">
                  {referencedMapTitle
                    ? 'The referenced map has no overlay layers.'
                    : 'No reference map. Pick one on the config page to add context layers here.'}
                </p>
              ) : (
                <ul>
                  {referenceLayers.map((l) => (
                    <li
                      key={l.id}
                      className="flex items-center gap-2 px-3 py-1.5 text-xs"
                    >
                      <Eye className="h-3 w-3 shrink-0 text-muted" />
                      <span className="truncate text-ink-1" title={l.title}>
                        {l.title}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </aside>

          {/* Coming-soon toast for stub tool clicks. */}
          {toast ? (
            <div className="pointer-events-auto absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full border border-border bg-surface-1 px-3 py-1.5 text-xs text-ink-1 shadow-card">
              {toast}
            </div>
          ) : null}
        </div>

        {/* The canvas itself fills the remaining space. MapCanvas
            takes a "dumb" prop set; we pass no-op stubs for the
            selection/onSelectionChange handlers since slice 3b-1 is
            read-only. The select tool stays 'off' so MapCanvas's
            built-in box / lasso doesn't intercept clicks reserved
            for editing tools in 3b-2. */}
        <div className="absolute inset-0">
          <MapCanvas
            ref={canvasRef}
            map={mapData}
            basemaps={basemaps}
            onCameraChange={(next) =>
              setMapData((cur) => ({ ...cur, ...next }))
            }
            selection={{}}
            selectTool="off"
            onSelectionChange={() => {
              /* no-op until slice 3b-2 wires the editing tools */
            }}
          />
        </div>
      </div>
    </div>
  );
}

const TOOL_LABELS: Record<EditorTool, string> = {
  select: 'Select',
  add: 'Add',
  edit: 'Edit',
  delete: 'Delete',
  snap: 'Snap toggle',
  measure: 'Measure',
  undo: 'Undo',
  redo: 'Redo',
};

const ALL_TOOLS: Array<{
  key: EditorTool;
  label: string;
  Icon: typeof MousePointer2;
}> = [
  { key: 'select', label: 'Select', Icon: MousePointer2 },
  { key: 'add', label: 'Add', Icon: Plus },
  { key: 'edit', label: 'Edit', Icon: PencilRuler },
  { key: 'delete', label: 'Delete', Icon: Trash2 },
  { key: 'snap', label: 'Snap', Icon: Wand2 },
  { key: 'measure', label: 'Measure', Icon: Ruler },
  { key: 'undo', label: 'Undo', Icon: Undo2 },
  { key: 'redo', label: 'Redo', Icon: Redo2 },
];
