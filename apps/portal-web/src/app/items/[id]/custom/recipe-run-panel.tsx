// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

/**
 * Runtime parameter UI for tool recipes (#90).
 *
 * When a Button widget is bound to a tool whose action is a
 * `recipe`, clicking the button opens this panel.  The panel
 * resolves every recipe parameter into a concrete value, fires
 * `POST /api/tools/:id/run`, and applies the output (today: a
 * selection update on the host map(s)) before closing.
 *
 * v1 input shapes per parameter kind:
 *   - feature-source / runtime-host:      layer picker from the
 *                                         host app's available
 *                                         layers
 *   - feature-source / runtime-draw:      "Use current map view"
 *                                         shortcut (rectangle of
 *                                         the bound map's bbox)
 *                                         plus inline GeoJSON
 *                                         paste as an escape
 *                                         hatch.  Full drawing UI
 *                                         lands once the runtime
 *                                         grows a freehand draw
 *                                         tool.
 *   - feature-source / runtime-selection: layer picker; uses the
 *                                         currently-selected
 *                                         feature ids on that
 *                                         layer.
 *   - predicate / runtime-pick:           chip strip constrained
 *                                         to the parameter's
 *                                         allowed set
 *   - distance / runtime-input:           number field (meters)
 *   - number  / runtime-input:            number field
 *   - text    / runtime-input:            text field
 *
 * Hardcoded parameters and runtime-* params with defaults that the
 * user doesn't need to override don't appear in the panel; they
 * carry into the request payload silently.
 */

import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Loader2, Pencil, X } from 'lucide-react';
import type maplibregl from 'maplibre-gl';
import type {
  DistanceParameter,
  FeatureSourceParameter,
  FeatureSourceValue,
  LengthUnit,
  NumberParameter,
  OsmFeatureParameter,
  OsmRelationalQueryAction,
  OsmTagFilter,
  PointParameter,
  PredicateParameter,
  RecipeAction,
  SpatialPredicate,
  TextParameter,
  ToolParameter,
} from '@gratis-gis/shared-types';
import {
  LENGTH_UNITS,
  METERS_PER_UNIT,
  UNIT_LABELS,
} from '@gratis-gis/shared-types';

import {
  MapDrawingOverlay,
  type DrawableGeometryType,
} from './map-drawing-overlay';

const PREDICATE_LABELS: Record<SpatialPredicate, string> = {
  intersects: 'Intersects',
  within: 'Within',
  contains: 'Contains',
  touches: 'Touches',
  near: 'Within distance',
};

export interface HostLayerOption {
  /** MapLayer.id inside the runtime's mapData -- used to read
   *  current selection and to apply selection back. */
  mapLayerId: string;
  /** Backing data_layer item id. */
  itemId: string;
  /** Optional sublayer key (v3 multi-layer data_layer items). */
  layerKey?: string;
  /** Display label for the picker. */
  title: string;
  /** Geometry type if known, used to filter the picker. */
  geometryType?: 'point' | 'line' | 'polygon' | 'any';
  /** Currently-selected feature ids on this layer in the host
   *  runtime; populated for runtime-selection mode. */
  selectedIds?: Array<string | number>;
  /** Visible bbox of the map this layer is on, when the recipe
   *  needs "Use current map view" to seed a runtime-draw AOI. */
  mapBbox?: [number, number, number, number];
}

/**
 * Wire-shape returned by POST /api/portal/tools/:id/run.  Two
 * variants today; future output sinks add more.
 */
export type RecipeRunResult =
  | {
      output: {
        kind: 'selection';
        layer: { itemId: string; layerKey?: string };
        featureIds: Array<string | number>;
        truncated: boolean;
      };
    }
  | {
      output: {
        kind: 'osm-features-overlay';
        features: Array<{
          type: 'Feature';
          id: string;
          properties: Record<string, unknown>;
          geometry: unknown;
        }>;
        attribution: string;
        featureCount: number;
        truncated: boolean;
        /** Human-readable preset labels resolved by the runner (e.g.
         *  ["School", "Park"]).  Used to title the result MapLayer
         *  with what was actually searched for.  Optional so the
         *  type stays back-compat with API responses that predate
         *  the field. */
        presetLabels?: string[];
      };
    }
  | {
      output: {
        kind: 'osm-relational-result';
        anchor: {
          preset: string;
          presetLabel: string;
          features: Array<{
            type: 'Feature';
            id: string;
            properties: Record<string, unknown>;
            geometry: unknown;
          }>;
          candidateCount: number;
        };
        conditions: Array<{
          preset: string;
          presetLabel: string;
          distanceMeters: number;
          candidateCount: number;
          /** Per-condition supporting features used by the
           *  bearing-arc viz (#153 follow-up). */
          supporting: Array<{
            type: 'Feature';
            id: string;
            properties: Record<string, unknown>;
            geometry: unknown;
          }>;
        }>;
        supporting: Array<{
          type: 'Feature';
          id: string;
          properties: Record<string, unknown>;
          geometry: unknown;
        }>;
        buffers: Array<{
          type: 'Feature';
          id: string;
          properties: Record<string, unknown>;
          geometry: unknown;
        }>;
        /** Bearing predicates echoed from the action so the
         *  client can render arcs.  Empty when no bearings. */
        bearings: Array<{
          conditionIndex: number;
          bearingDegrees: number;
          toleranceDegrees: number;
        }>;
        attribution: string;
        truncated: boolean;
      };
    };

interface Props {
  toolId: string;
  toolTitle: string;
  /**
   * Optional descriptive text shown when the tool has no runtime
   * inputs. Prefer the tool's `hint` (a short blurb authored on
   * the Tool item, set via the action editor or the item header);
   * fall back to the Tool item's `description` field. When both
   * are empty, the panel shows a generic "Click Run" placeholder.
   * Lets a tool that "just runs" still tell the user what it
   * actually does before they commit.
   */
  toolHint?: string;
  toolDescription?: string;
  /**
   * The tool's action.  The panel only reads `.parameters` from
   * here, so it accepts either a RecipeAction (selection or
   * osm-features-overlay output) or an OsmRelationalQueryAction
   * (#142): both expose the same parameter-array shape and the
   * backend dispatches on action.kind once the panel POSTs to
   * /api/portal/tools/:id/run.
   */
  recipe: RecipeAction | OsmRelationalQueryAction;
  hostLayers: HostLayerOption[];
  /** Optional bbox of the host's currently-focused map; supplied
   *  separately from hostLayers so a runtime-draw param without a
   *  matching layer can still grab a bbox. */
  hostBbox?: [number, number, number, number];
  /** Resolver for the host's MapLibre instance the freehand-draw
   *  affordance attaches to.  Returns null when no map is mounted;
   *  the panel falls back to the bbox / paste-GeoJSON path in that
   *  case.  A function (rather than a captured value) so the panel
   *  always grabs the live instance at the moment the user clicks
   *  Draw -- the map may have re-mounted since the panel opened. */
  getDrawMap?: () => maplibregl.Map | null;
  onClose: () => void;
  onResult: (result: RecipeRunResult) => void;
}

export function RecipeRunPanel({
  toolId,
  toolTitle,
  toolHint,
  toolDescription,
  recipe,
  hostLayers,
  hostBbox,
  getDrawMap,
  onClose,
  onResult,
}: Props) {
  // Visible parameter list: the ones the user needs to touch.
  // Hardcoded params and defaults-with-no-override-needed roll
  // straight into the request without a UI row.
  const visibleParams = useMemo(
    () => recipe.parameters.filter(isInteractiveParam),
    [recipe.parameters],
  );

  // Per-parameter staged value.  Keyed by parameter name.  Each
  // value is the same shape the API expects in `parameters[name]`.
  const [values, setValues] = useState<Record<string, unknown>>(() =>
    seedValues(recipe.parameters, hostLayers, hostBbox),
  );
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // When non-null, the panel collapses to a thin banner and lets
  // the user click on the host map to draw an AOI for the named
  // parameter.  The `mapInstance` is captured up front (at the
  // moment the user hits the Draw button) so React state churn
  // doesn't cause the drawing overlay to re-mount mid-interaction.
  const [drawing, setDrawing] = useState<{
    paramName: string;
    geometryType: DrawableGeometryType;
    mapInstance: maplibregl.Map;
  } | null>(null);

  function patch(name: string, next: unknown) {
    setValues((v) => ({ ...v, [name]: next }));
  }

  /** Called by FeatureSourceInput when the user clicks "Draw on
   *  map" for a runtime-draw parameter.  Falls back silently if no
   *  map is available -- the input keeps its bbox + paste-GeoJSON
   *  affordances as the recovery path. */
  function startDrawing(paramName: string, geometryType: DrawableGeometryType) {
    const m = getDrawMap?.();
    if (!m) return;
    setDrawing({ paramName, geometryType, mapInstance: m });
  }

  function finishDrawing(geometry: GeoJSON.Geometry) {
    if (!drawing) return;
    // PointParameter (#150 / #152) consumes the drawn point as a
    // bare lat/lon pair rather than the AOI's inline-geojson
    // wrapper.  Detect by parameter kind so the same drawing
    // overlay serves both flows without forking the UI.
    const param = recipe.parameters.find((p) => p.name === drawing.paramName);
    if (
      param?.kind === 'point' &&
      geometry.type === 'Point' &&
      Array.isArray(geometry.coordinates) &&
      geometry.coordinates.length >= 2
    ) {
      const [lng, lat] = geometry.coordinates as number[];
      if (typeof lng === 'number' && typeof lat === 'number') {
        patch(drawing.paramName, { kind: 'point-input', lng, lat });
        setDrawing(null);
        return;
      }
    }
    patch(drawing.paramName, { kind: 'inline-geojson', geojson: geometry });
    setDrawing(null);
  }
  function cancelDrawing() {
    setDrawing(null);
  }

  async function run(): Promise<void> {
    setRunning(true);
    setError(null);
    try {
      const res = await fetch(`/api/portal/tools/${toolId}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parameters: values }),
      });
      if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try {
          const body = (await res.json()) as { message?: string };
          if (body.message) msg = body.message;
        } catch {
          /* fall through */
        }
        throw new Error(msg);
      }
      const body = (await res.json()) as RecipeRunResult;
      onResult(body);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  }

  // When drawing, the modal collapses to a thin top banner so the
  // user can see and click the map.  The dim-overlay backdrop also
  // drops away so canvas events can reach the map.  Cancel + a
  // "what to do" hint stay visible in the banner; finishing the
  // draw flips us back to the full modal with the AOI captured.
  if (drawing) {
    const drawBanner = (
      <>
        <MapDrawingOverlay
          map={drawing.mapInstance}
          geometryType={drawing.geometryType}
          onComplete={finishDrawing}
          onCancel={cancelDrawing}
        />
        <div
          className="pointer-events-none fixed inset-x-0 top-4 z-[1000] flex justify-center"
          aria-live="polite"
        >
          <div className="pointer-events-auto flex items-center gap-3 rounded-full border border-border bg-surface-0/95 px-4 py-2 text-xs shadow-raised backdrop-blur">
            <Pencil className="h-3.5 w-3.5 text-accent" />
            <span className="text-ink-0">
              {drawing.geometryType === 'point'
                ? 'Click on the map to drop a point.'
                : drawing.geometryType === 'line'
                  ? 'Click to add vertices; double-click to finish the line.'
                  : 'Click to add vertices; double-click to close the polygon.'}
            </span>
            <button
              type="button"
              onClick={cancelDrawing}
              className="rounded-md border border-border bg-surface-1 px-2 py-0.5 text-2xs text-ink-1 hover:bg-surface-2"
            >
              Cancel
            </button>
          </div>
        </div>
      </>
    );
    return createPortal(drawBanner, document.body);
  }

  const modal = (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="recipe-run-title"
      className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/40 px-4 py-8"
      onClick={(e) => {
        // Click outside closes; click inside doesn't bubble.
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-md rounded-lg border border-border bg-surface-0 p-4 shadow-xl">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <h2 id="recipe-run-title" className="text-sm font-medium text-ink-0">
              {toolTitle}
            </h2>
            <p className="text-2xs text-muted">
              Fill in the inputs below, then click Run.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-border bg-surface-1 p-1 text-muted hover:text-ink-1"
            title="Cancel"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        <div className="space-y-3">
          {visibleParams.length === 0 ? (
            <div className="rounded-md border border-dashed border-border bg-surface-2 px-3 py-3 text-2xs text-ink-1">
              {/* Prefer the action's hint, then the tool item's
                  description, then a generic placeholder. Lets a
                  tool that runs without runtime inputs still tell
                  the user what it will do before they hit Run. */}
              {toolHint && toolHint.trim().length > 0 ? (
                <p className="whitespace-pre-wrap">{toolHint}</p>
              ) : toolDescription && toolDescription.trim().length > 0 ? (
                <p className="whitespace-pre-wrap">{toolDescription}</p>
              ) : (
                <p className="text-muted">
                  This tool has no runtime inputs. Click Run to execute.
                </p>
              )}
            </div>
          ) : (
            visibleParams.map((p) => (
              <ParamInputRow
                key={p.name}
                parameter={p}
                value={values[p.name]}
                onChange={(v) => patch(p.name, v)}
                hostLayers={hostLayers}
                {...(hostBbox ? { hostBbox } : {})}
                {...(getDrawMap ? { onStartDraw: startDrawing } : {})}
              />
            ))
          )}
        </div>

        {error ? (
          <div className="mt-3 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-2xs text-danger">
            {error}
          </div>
        ) : null}

        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={running}
            className="rounded-md border border-border bg-surface-1 px-3 py-1.5 text-xs text-ink-1 hover:bg-surface-2"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void run()}
            disabled={running}
            className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
          >
            {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            Run
          </button>
        </div>
      </div>
      {/* Shared <datalist> the OSM tag-filter rows reference via
          list="osm-common-tag-keys".  Lives once at the modal root
          so multiple filter rows share the same hint set without
          re-rendering it per-row. */}
      <datalist id="osm-common-tag-keys">
        {OSM_COMMON_TAG_KEYS.map((k) => (
          <option key={k} value={k} />
        ))}
      </datalist>
    </div>
  );

  return createPortal(modal, document.body);
}

/**
 * Top-of-funnel OSM tag keys for the runtime tag-filter editor's
 * autocomplete hint set.  Not exhaustive -- the long tail is in
 * the wiki -- but covers the keys 90% of "Show me X with brand /
 * cuisine / operator Y" workflows need.  Kept short on purpose;
 * the input is still free-text, so power users can type any key.
 */
const OSM_COMMON_TAG_KEYS = [
  // identity / branding
  'name',
  'brand',
  'operator',
  'ref',
  'website',
  // domain hints
  'cuisine',
  'capacity',
  'fuel',
  'tourism',
  'shop',
  'amenity',
  'sport',
  'religion',
  // address
  'addr:city',
  'addr:state',
  'addr:postcode',
  'addr:housenumber',
  'addr:street',
  // hours + access
  'opening_hours',
  'fee',
  'access',
  'wheelchair',
  // building / feature physical
  'building',
  'building:levels',
  'surface',
  'lanes',
  // identity / xref
  'wikipedia',
  'wikidata',
  'phone',
  // boolean-style
  'drive_through',
  'takeaway',
  'delivery',
  'internet_access',
] as const;

// ---- Per-parameter input rows --------------------------------------------

function ParamInputRow({
  parameter,
  value,
  onChange,
  hostLayers,
  hostBbox,
  onStartDraw,
}: {
  parameter: ToolParameter;
  value: unknown;
  onChange: (next: unknown) => void;
  hostLayers: HostLayerOption[];
  hostBbox?: [number, number, number, number];
  onStartDraw?: (paramName: string, geometryType: DrawableGeometryType) => void;
}) {
  switch (parameter.kind) {
    case 'feature-source':
      return (
        <FeatureSourceInput
          parameter={parameter}
          value={value as FeatureSourceValue | undefined}
          onChange={onChange}
          hostLayers={hostLayers}
          {...(hostBbox ? { hostBbox } : {})}
          {...(onStartDraw ? { onStartDraw } : {})}
        />
      );
    case 'predicate':
      return (
        <PredicateInput
          parameter={parameter}
          value={value as SpatialPredicate | undefined}
          onChange={onChange}
        />
      );
    case 'distance':
      return (
        <DistanceInput
          parameter={parameter}
          value={value as number | undefined}
          onChange={onChange}
        />
      );
    case 'number':
      return (
        <NumberInput
          parameter={parameter}
          value={value as number | undefined}
          onChange={onChange}
        />
      );
    case 'text':
      return (
        <TextInput
          parameter={parameter}
          value={value as string | undefined}
          onChange={onChange}
        />
      );
    case 'osm-feature':
      return (
        <OsmFeatureInput
          parameter={parameter}
          value={value as
            | { kind: 'osm-feature-input'; presetIds: string[]; tagFilters?: OsmTagFilter[] }
            | undefined}
          onChange={onChange}
        />
      );
    case 'point':
      return (
        <PointInput
          parameter={parameter}
          value={value as
            | { kind: 'point-input'; lng: number; lat: number }
            | undefined}
          onChange={onChange}
          {...(onStartDraw ? { onStartDraw } : {})}
        />
      );
  }
}

function FeatureSourceInput({
  parameter,
  value,
  onChange,
  hostLayers,
  hostBbox,
  onStartDraw,
}: {
  parameter: FeatureSourceParameter;
  value: FeatureSourceValue | undefined;
  onChange: (next: FeatureSourceValue) => void;
  hostLayers: HostLayerOption[];
  hostBbox?: [number, number, number, number];
  onStartDraw?: (paramName: string, geometryType: DrawableGeometryType) => void;
}) {
  const mode = parameter.binding.mode;
  // Filter host layers to the parameter's geometry type if specified.
  const compatible = hostLayers.filter((h) => {
    const gt = parameter.geometryType ?? 'any';
    if (gt === 'any' || !h.geometryType || h.geometryType === 'any') return true;
    return h.geometryType === gt;
  });

  if (mode === 'runtime-host') {
    const current = value?.kind === 'data_layer' ? value : undefined;
    return (
      <div className="space-y-1">
        <Label parameter={parameter} />
        <select
          value={current ? `${current.itemId}::${current.layerKey ?? ''}` : ''}
          onChange={(e) => {
            const v = e.target.value;
            if (!v) return;
            const [itemId, layerKey] = v.split('::');
            onChange({
              kind: 'data_layer',
              itemId: itemId!,
              ...(layerKey ? { layerKey } : {}),
            });
          }}
          className={inputCls}
        >
          <option value="">(pick a layer)</option>
          {compatible.map((h) => (
            <option key={h.mapLayerId} value={`${h.itemId}::${h.layerKey ?? ''}`}>
              {h.title}
            </option>
          ))}
        </select>
      </div>
    );
  }

  if (mode === 'runtime-draw') {
    const inlineGeo = value?.kind === 'inline-geojson' ? value.geojson : undefined;
    function useBboxAsRectangle() {
      const bbox = hostBbox ?? hostLayers[0]?.mapBbox;
      if (!bbox) return;
      const [w, s, e, n] = bbox;
      const polygon: GeoJSON.Polygon = {
        type: 'Polygon',
        coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]],
      };
      onChange({ kind: 'inline-geojson', geojson: polygon });
    }
    // Translate the parameter's declared geometry type into the
    // narrower set the drawing overlay understands.  'any' falls
    // back to polygon because that's the most common AOI shape and
    // both line + point AOIs are degenerate cases for almost every
    // spatial-filter predicate.
    const drawGeometryType: DrawableGeometryType =
      parameter.geometryType === 'point'
        ? 'point'
        : parameter.geometryType === 'line'
          ? 'line'
          : 'polygon';
    return (
      <div className="space-y-2">
        <Label parameter={parameter} />
        <p className="text-2xs text-muted">
          Draw an area on the map, snap the current view as a
          rectangle, or paste GeoJSON.
        </p>
        <div className="flex flex-wrap gap-2">
          {onStartDraw ? (
            <button
              type="button"
              onClick={() => onStartDraw(parameter.name, drawGeometryType)}
              className="inline-flex items-center gap-1 rounded-md border border-accent bg-accent/5 px-2 py-1 text-2xs text-ink-0 hover:bg-accent/10"
            >
              <Pencil className="h-3 w-3 text-accent" />
              Draw on map
            </button>
          ) : null}
          <button
            type="button"
            onClick={useBboxAsRectangle}
            disabled={!hostBbox && !hostLayers[0]?.mapBbox}
            className="rounded-md border border-border bg-surface-1 px-2 py-1 text-2xs hover:bg-surface-2 disabled:opacity-50"
          >
            Use current map view
          </button>
          {inlineGeo ? (
            <span className="rounded-md border border-success/40 bg-success/10 px-2 py-1 text-2xs text-success">
              AOI set
            </span>
          ) : null}
        </div>
        <details className="text-2xs">
          <summary className="cursor-pointer text-muted">
            Paste GeoJSON (advanced)
          </summary>
          <textarea
            value={inlineGeo ? JSON.stringify(inlineGeo) : ''}
            onChange={(e) => {
              const raw = e.target.value.trim();
              if (!raw) return;
              try {
                const parsed = JSON.parse(raw);
                onChange({ kind: 'inline-geojson', geojson: parsed });
              } catch {
                /* keep the textarea editable; the runner will reject
                   invalid JSON when Run is clicked. */
              }
            }}
            rows={4}
            placeholder='{"type":"Polygon","coordinates":[[[...]]]}'
            className="mt-1 w-full rounded-md border border-border bg-surface-0 px-2 py-1.5 font-mono text-2xs"
          />
        </details>
      </div>
    );
  }

  if (mode === 'runtime-selection') {
    const current =
      value?.kind === 'data_layer' && value.featureIds && value.featureIds.length > 0
        ? value
        : undefined;
    // Only show layers with a non-empty selection.  If none do, the
    // user can pick a layer but the recipe will fail at run time.
    const eligible = compatible.filter((h) => (h.selectedIds?.length ?? 0) > 0);
    const pool = eligible.length > 0 ? eligible : compatible;
    return (
      <div className="space-y-1">
        <Label parameter={parameter} />
        <p className="text-2xs text-muted">
          Uses the current selection on the chosen layer.
        </p>
        <select
          value={current ? `${current.itemId}::${current.layerKey ?? ''}` : ''}
          onChange={(e) => {
            const v = e.target.value;
            if (!v) return;
            const [itemId, layerKey] = v.split('::');
            const host = pool.find(
              (h) => h.itemId === itemId && (h.layerKey ?? '') === (layerKey ?? ''),
            );
            const selectedIds = host?.selectedIds ?? [];
            onChange({
              kind: 'data_layer',
              itemId: itemId!,
              ...(layerKey ? { layerKey } : {}),
              featureIds: selectedIds,
            });
          }}
          className={inputCls}
        >
          <option value="">(pick a layer)</option>
          {pool.map((h) => (
            <option key={h.mapLayerId} value={`${h.itemId}::${h.layerKey ?? ''}`}>
              {h.title} ({h.selectedIds?.length ?? 0} selected)
            </option>
          ))}
        </select>
      </div>
    );
  }

  // Hardcoded: nothing to ask, but show what the tool will use.
  return null;
}

function PredicateInput({
  parameter,
  value,
  onChange,
}: {
  parameter: PredicateParameter;
  value: SpatialPredicate | undefined;
  onChange: (next: SpatialPredicate) => void;
}) {
  if (parameter.binding.mode !== 'runtime-pick') return null;
  const allowed = parameter.binding.allowed ?? [
    'intersects',
    'within',
    'contains',
    'touches',
    'near',
  ];
  const current = value ?? parameter.binding.defaultValue;
  return (
    <div className="space-y-1">
      <Label parameter={parameter} />
      <select
        value={current}
        onChange={(e) => onChange(e.target.value as SpatialPredicate)}
        className={inputCls}
      >
        {allowed.map((p) => (
          <option key={p} value={p}>
            {PREDICATE_LABELS[p]}
          </option>
        ))}
      </select>
    </div>
  );
}

function DistanceInput({
  parameter,
  value,
  onChange,
}: {
  parameter: DistanceParameter;
  value: number | undefined;
  onChange: (next: number) => void;
}) {
  // Display unit defaults to whatever the author saved on the
  // parameter (meters for legacy recipes); the user can flip the
  // unit on the input at run time and we convert back to meters
  // before emitting `onChange`.  Local state survives across
  // renders so a unit pick doesn't bounce back to the default.
  const [unit, setUnit] = useState<LengthUnit>(parameter.unit ?? 'meters');
  if (parameter.binding.mode !== 'runtime-input') return null;
  const factor = METERS_PER_UNIT[unit];
  const meters = value ?? parameter.binding.defaultMeters;
  const display = meters / factor;
  const minDisplay =
    parameter.binding.minMeters !== undefined
      ? parameter.binding.minMeters / factor
      : 0;
  const maxDisplay =
    parameter.binding.maxMeters !== undefined
      ? parameter.binding.maxMeters / factor
      : undefined;
  return (
    <div className="space-y-1">
      <Label parameter={parameter} />
      <div className="flex items-center gap-2">
        <input
          type="number"
          min={minDisplay}
          step="any"
          {...(maxDisplay !== undefined ? { max: maxDisplay } : {})}
          value={Number.isFinite(display) ? display : 0}
          onChange={(e) => {
            const n = Number(e.target.value);
            if (Number.isFinite(n)) onChange(n * factor);
          }}
          className={`${inputCls} flex-1`}
        />
        <select
          value={unit}
          onChange={(e) => setUnit(e.target.value as LengthUnit)}
          className="rounded-md border border-border bg-surface-0 px-2 py-1.5 text-sm"
        >
          {LENGTH_UNITS.map((u) => (
            <option key={u} value={u}>
              {UNIT_LABELS[u]}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

function NumberInput({
  parameter,
  value,
  onChange,
}: {
  parameter: NumberParameter;
  value: number | undefined;
  onChange: (next: number) => void;
}) {
  if (parameter.binding.mode !== 'runtime-input') return null;
  const current = value ?? parameter.binding.defaultValue;
  return (
    <div className="space-y-1">
      <Label parameter={parameter} />
      <input
        type="number"
        {...(parameter.binding.min !== undefined ? { min: parameter.binding.min } : {})}
        {...(parameter.binding.max !== undefined ? { max: parameter.binding.max } : {})}
        value={current}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (Number.isFinite(n)) onChange(n);
        }}
        className={inputCls}
      />
    </div>
  );
}

function TextInput({
  parameter,
  value,
  onChange,
}: {
  parameter: TextParameter;
  value: string | undefined;
  onChange: (next: string) => void;
}) {
  if (parameter.binding.mode !== 'runtime-input') return null;
  const current = value ?? parameter.binding.defaultValue ?? '';
  return (
    <div className="space-y-1">
      <Label parameter={parameter} />
      <input
        type="text"
        value={current}
        onChange={(e) => onChange(e.target.value)}
        className={inputCls}
      />
    </div>
  );
}

/**
 * OSM-feature parameter runtime input (#OSM).  Renders only when
 * the binding is runtime-pick (hardcoded osm-feature parameters
 * are silent at runtime).  Two stacked controls:
 *
 *   1. Preset multi-select: search + chip-add over the vendored
 *      iD catalog.  Respects the parameter's allowedPresetIds /
 *      allowedCategories restrictions.  Lazy-loads the catalog
 *      from the public endpoint with `force-cache` so the picker
 *      is cheap to open.
 *
 *   2. Tag-filter rows: only shown when allowCustomTagFilters !=
 *      false.  Add / remove key=value rows; values are free text.
 *      Per the design, equals is the only op in v1.
 *
 * The component owns the `{kind: 'osm-feature-input', ...}` shape
 * the backend recipe runner expects; the parent panel forwards it
 * to the API verbatim.
 */
function OsmFeatureInput({
  parameter,
  value,
  onChange,
}: {
  parameter: OsmFeatureParameter;
  value: { kind: 'osm-feature-input'; presetIds: string[]; tagFilters?: OsmTagFilter[] } | undefined;
  onChange: (next: { kind: 'osm-feature-input'; presetIds: string[]; tagFilters?: OsmTagFilter[] }) => void;
}) {
  if (parameter.binding.mode !== 'runtime-pick') return null;
  const allowFilters = parameter.binding.allowCustomTagFilters !== false;
  const allowedPresetIds = parameter.binding.allowedPresetIds;
  const presetIds = value?.presetIds ?? parameter.binding.defaultPresetIds ?? [];
  const tagFilters = value?.tagFilters ?? parameter.binding.defaultTagFilters ?? [];

  function setPresets(next: string[]) {
    onChange({
      kind: 'osm-feature-input',
      presetIds: next,
      ...(tagFilters.length > 0 ? { tagFilters } : {}),
    });
  }
  function setTagFilters(next: OsmTagFilter[]) {
    onChange({
      kind: 'osm-feature-input',
      presetIds,
      ...(next.length > 0 ? { tagFilters: next } : {}),
    });
  }

  return (
    <div className="space-y-2">
      <Label parameter={parameter} />
      <OsmPresetMultiSelectRuntime
        selected={presetIds}
        onChange={setPresets}
        {...(allowedPresetIds && allowedPresetIds.length > 0
          ? { allowedPresetIds }
          : {})}
      />
      {allowFilters ? (
        <div>
          <label className="block text-2xs font-medium uppercase tracking-wide text-muted">
            Filters (optional)
          </label>
          <p className="mb-1 text-2xs text-muted">
            Narrow the result, e.g. <code>brand = Citgo</code> or
            <code className="ml-1">cuisine = pizza</code>.
          </p>
          <OsmTagFilterRowsRuntime
            filters={tagFilters}
            onChange={setTagFilters}
          />
        </div>
      ) : null}
    </div>
  );
}

function OsmPresetMultiSelectRuntime({
  selected,
  onChange,
  allowedPresetIds,
}: {
  selected: string[];
  onChange: (next: string[]) => void;
  allowedPresetIds?: string[];
}) {
  const [catalog, setCatalog] = useState<
    Array<{ id: string; label: string; category: string; terms?: string[] }> | null
  >(null);
  const [query, setQuery] = useState('');

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/portal/public/osm/presets', {
          cache: 'force-cache',
        });
        if (!res.ok) {
          if (!cancelled) setCatalog([]);
          return;
        }
        const body = (await res.json()) as {
          presets: Array<{ id: string; label: string; category: string; terms?: string[] }>;
        };
        if (!cancelled) setCatalog(body.presets ?? []);
      } catch {
        if (!cancelled) setCatalog([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const matches = useMemo(() => {
    if (!catalog) return [];
    const allowedSet = allowedPresetIds && allowedPresetIds.length > 0
      ? new Set(allowedPresetIds)
      : null;
    const q = query.trim().toLowerCase();
    if (!q && allowedSet) {
      // No query but an allowlist exists: show the allowed entries
      // immediately so the user knows what they can pick from.
      return catalog
        .filter((p) => allowedSet.has(p.id) && !selected.includes(p.id))
        .slice(0, 50);
    }
    if (q.length < 2) return [];
    const sel = new Set(selected);
    const hits: typeof catalog = [];
    for (const p of catalog) {
      if (sel.has(p.id)) continue;
      if (allowedSet && !allowedSet.has(p.id)) continue;
      const hay =
        `${p.label} ${p.id} ${p.category} ${(p.terms ?? []).join(' ')}`.toLowerCase();
      if (hay.includes(q)) {
        hits.push(p);
        if (hits.length >= 20) break;
      }
    }
    return hits;
  }, [catalog, query, selected, allowedPresetIds]);

  return (
    <div className="space-y-1.5">
      {selected.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {selected.map((id) => {
            const p = catalog?.find((x) => x.id === id);
            return (
              <span
                key={id}
                className="inline-flex items-center gap-1 rounded-full border border-border bg-surface-0 px-2 py-0.5 text-2xs"
              >
                {p?.label ?? id}
                <button
                  type="button"
                  onClick={() => onChange(selected.filter((x) => x !== id))}
                  className="text-muted hover:text-danger"
                  aria-label={`Remove ${p?.label ?? id}`}
                >
                  ×
                </button>
              </span>
            );
          })}
        </div>
      ) : null}
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={
          catalog === null
            ? 'Loading OSM catalog…'
            : 'Type to search (e.g. "gas", "restaurant", "school")'
        }
        className={inputCls}
      />
      {matches.length > 0 ? (
        <div className="max-h-40 overflow-y-auto rounded-md border border-border bg-surface-0">
          {matches.map((p) => (
            <button
              type="button"
              key={p.id}
              onClick={() => {
                onChange([...selected, p.id]);
                setQuery('');
              }}
              className="block w-full px-2 py-1 text-left text-xs hover:bg-surface-2"
            >
              <span className="font-medium text-ink-0">{p.label}</span>
              <span className="ml-2 text-2xs text-muted">{p.category}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Runtime input for a PointParameter (#150 / #152).  Primary
 * affordance is a "Drop pin on map" button that hands control to
 * the existing MapDrawingOverlay; the user clicks the host map
 * once and the resulting lat/lon flows back in via the
 * `finishDrawing` handler.  Lat/lon text inputs are the fallback
 * for users who already have coordinates in hand.
 *
 * Owns the `{ kind: 'point-input', lng, lat }` wire shape the
 * backend recipe runner expects.
 */
function PointInput({
  parameter,
  value,
  onChange,
  onStartDraw,
}: {
  parameter: PointParameter;
  value: { kind: 'point-input'; lng: number; lat: number } | undefined;
  onChange: (next: { kind: 'point-input'; lng: number; lat: number }) => void;
  onStartDraw?: (paramName: string, geometryType: DrawableGeometryType) => void;
}) {
  if (parameter.binding.mode !== 'runtime-pick') return null;
  const lng = value?.lng;
  const lat = value?.lat;
  const hasPoint = typeof lng === 'number' && typeof lat === 'number';
  function setLng(raw: string) {
    const n = Number(raw);
    if (!Number.isFinite(n)) return;
    onChange({ kind: 'point-input', lng: n, lat: lat ?? 0 });
  }
  function setLat(raw: string) {
    const n = Number(raw);
    if (!Number.isFinite(n)) return;
    onChange({ kind: 'point-input', lng: lng ?? 0, lat: n });
  }
  return (
    <div className="space-y-2">
      <Label parameter={parameter} />
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => onStartDraw?.(parameter.name, 'point')}
          className="inline-flex items-center gap-1.5 rounded-md border border-accent bg-accent/10 px-2 py-1 text-xs font-medium text-accent hover:bg-accent/20"
        >
          <Pencil className="h-3 w-3" />
          {hasPoint ? 'Drop new pin' : 'Drop pin on map'}
        </button>
        {hasPoint ? (
          <span className="self-center text-2xs font-mono text-muted">
            {lat!.toFixed(6)}, {lng!.toFixed(6)}
          </span>
        ) : (
          <span className="self-center text-2xs italic text-muted">
            No location set
          </span>
        )}
      </div>
      <div className="flex gap-1.5">
        <div className="flex-1">
          <label className="block text-2xs uppercase tracking-wide text-muted">
            Latitude
          </label>
          <input
            type="number"
            step="any"
            value={typeof lat === 'number' ? lat : ''}
            onChange={(e) => setLat(e.target.value)}
            placeholder="38.9072"
            className={`${inputCls} font-mono text-xs`}
          />
        </div>
        <div className="flex-1">
          <label className="block text-2xs uppercase tracking-wide text-muted">
            Longitude
          </label>
          <input
            type="number"
            step="any"
            value={typeof lng === 'number' ? lng : ''}
            onChange={(e) => setLng(e.target.value)}
            placeholder="-77.0369"
            className={`${inputCls} font-mono text-xs`}
          />
        </div>
      </div>
    </div>
  );
}

function OsmTagFilterRowsRuntime({
  filters,
  onChange,
}: {
  filters: OsmTagFilter[];
  onChange: (next: OsmTagFilter[]) => void;
}) {
  function set(index: number, patch: Partial<OsmTagFilter>) {
    onChange(filters.map((f, i) => (i === index ? { ...f, ...patch } : f)));
  }
  function add() {
    onChange([...filters, { key: '', value: '' }]);
  }
  function remove(index: number) {
    onChange(filters.filter((_, i) => i !== index));
  }
  return (
    <div className="space-y-1.5">
      {filters.map((f, i) => (
        <div key={i} className="flex gap-1.5">
          <input
            type="text"
            value={f.key}
            onChange={(e) => set(i, { key: e.target.value.trim() })}
            placeholder="key"
            list="osm-common-tag-keys"
            className={`${inputCls} flex-1 font-mono text-xs`}
          />
          {/* Op picker (#149).  `=` exact match (default), `~`
              case-insensitive substring (op='contains'), `~/.../`
              regex.  Tiny dropdown rather than three radio
              buttons so the row stays compact; the symbols are
              the ones Overpass QL itself uses. */}
          <select
            value={f.op ?? 'equals'}
            onChange={(e) => {
              const op = e.target.value as NonNullable<OsmTagFilter['op']>;
              set(i, { op });
            }}
            aria-label="Match operator"
            className={`${inputCls} w-16 font-mono text-xs`}
          >
            <option value="equals">=</option>
            <option value="contains">~</option>
            <option value="regex">~/./</option>
          </select>
          <input
            type="text"
            value={f.value}
            onChange={(e) => set(i, { value: e.target.value })}
            placeholder={
              f.op === 'contains'
                ? 'substring'
                : f.op === 'regex'
                  ? 'regex'
                  : 'value'
            }
            className={`${inputCls} flex-1 font-mono text-xs`}
          />
          <button
            type="button"
            onClick={() => remove(i)}
            className="rounded-md border border-border bg-surface-1 px-2 text-2xs text-danger hover:bg-danger/10"
            aria-label="Remove filter"
          >
            ×
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={add}
        className="inline-flex items-center gap-1 rounded-md border border-dashed border-border bg-surface-2 px-2 py-1 text-2xs text-ink-1 hover:bg-surface-1"
      >
        + Add filter
      </button>
    </div>
  );
}

function Label({ parameter }: { parameter: ToolParameter }) {
  return (
    <label className="block text-2xs font-medium text-ink-1">
      {parameter.label}
      {parameter.required ? <span className="text-danger"> *</span> : null}
      {parameter.hint ? (
        <span className="block text-2xs font-normal text-muted">
          {parameter.hint}
        </span>
      ) : null}
    </label>
  );
}

const inputCls =
  'w-full rounded-md border border-border bg-surface-0 px-2 py-1.5 text-sm text-ink-0 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30';

// ---- Helpers --------------------------------------------------------------

/**
 * True when this parameter needs a UI row in the runtime panel.
 * Hardcoded parameters are silent (the runtime sends nothing for them
 * and the backend uses the saved value).  Runtime-host params with a
 * pre-bound default that the host has already filled in are silent
 * too -- the panel seeds them and the user only edits if they want.
 */
function isInteractiveParam(p: ToolParameter): boolean {
  switch (p.kind) {
    case 'feature-source':
      return (
        p.binding.mode === 'runtime-host' ||
        p.binding.mode === 'runtime-draw' ||
        p.binding.mode === 'runtime-selection'
      );
    case 'predicate':
      return p.binding.mode === 'runtime-pick';
    case 'distance':
    case 'number':
    case 'text':
      return p.binding.mode === 'runtime-input';
    case 'osm-feature':
      return p.binding.mode === 'runtime-pick';
    case 'point':
      return p.binding.mode === 'runtime-pick';
  }
}

/**
 * Pre-fill values for parameters that have sensible runtime defaults
 * (the predicate's default, the distance's default meters, the
 * host's first matching layer).  The user can still override
 * anything; this just keeps a blank Run from failing on a required
 * parameter the runtime could have auto-resolved.
 */
function seedValues(
  parameters: ToolParameter[],
  hostLayers: HostLayerOption[],
  hostBbox?: [number, number, number, number],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of parameters) {
    if (p.kind === 'feature-source') {
      if (p.binding.mode === 'runtime-host') {
        const compatible = hostLayers.filter((h) => {
          const gt = p.geometryType ?? 'any';
          if (gt === 'any' || !h.geometryType || h.geometryType === 'any') return true;
          return h.geometryType === gt;
        });
        if (p.binding.defaultValue) out[p.name] = p.binding.defaultValue;
        else if (compatible[0]) {
          out[p.name] = {
            kind: 'data_layer',
            itemId: compatible[0].itemId,
            ...(compatible[0].layerKey ? { layerKey: compatible[0].layerKey } : {}),
          };
        }
      }
      // runtime-draw: leave empty; the user must explicitly seed via
      // "Use current map view" or pasting GeoJSON.  Don't auto-fill
      // the bbox because that would silently treat "I clicked Run
      // without setting an AOI" as "select everything in the view".
      if (p.binding.mode === 'runtime-selection') {
        // Pick the first layer with a non-empty selection so the Run
        // button is wired to something useful by default.
        const eligible = hostLayers.filter((h) => (h.selectedIds?.length ?? 0) > 0);
        const pick = eligible[0];
        if (pick) {
          out[p.name] = {
            kind: 'data_layer',
            itemId: pick.itemId,
            ...(pick.layerKey ? { layerKey: pick.layerKey } : {}),
            featureIds: pick.selectedIds ?? [],
          };
        }
      }
    } else if (p.kind === 'predicate') {
      if (p.binding.mode === 'runtime-pick') out[p.name] = p.binding.defaultValue;
    } else if (p.kind === 'distance') {
      if (p.binding.mode === 'runtime-input') out[p.name] = p.binding.defaultMeters;
    } else if (p.kind === 'number') {
      if (p.binding.mode === 'runtime-input') out[p.name] = p.binding.defaultValue;
    } else if (p.kind === 'text') {
      if (p.binding.mode === 'runtime-input' && p.binding.defaultValue !== undefined)
        out[p.name] = p.binding.defaultValue;
    } else if (p.kind === 'osm-feature') {
      // Seed the runtime panel's staged value with the binding's
      // defaults so a "click Run with defaults" flow works for
      // recipes whose author pre-filled the preset / filter set.
      if (p.binding.mode === 'runtime-pick') {
        const defaults = {
          kind: 'osm-feature-input' as const,
          presetIds: p.binding.defaultPresetIds ?? [],
          ...(p.binding.defaultTagFilters && p.binding.defaultTagFilters.length > 0
            ? { tagFilters: p.binding.defaultTagFilters }
            : {}),
        };
        if (defaults.presetIds.length > 0 || ('tagFilters' in defaults && defaults.tagFilters)) {
          out[p.name] = defaults;
        }
      }
    } else if (p.kind === 'point') {
      // Seed the runtime point picker with the author-supplied
      // defaults so the user can click Run immediately if the
      // preset starting point is what they wanted.  Half-defaults
      // (lat but no lng, or vice versa) intentionally don't seed
      // because the runtime UI's "Drop pin" flow expects a
      // complete pair or nothing.
      if (
        p.binding.mode === 'runtime-pick' &&
        typeof p.binding.defaultLng === 'number' &&
        typeof p.binding.defaultLat === 'number'
      ) {
        out[p.name] = {
          kind: 'point-input',
          lng: p.binding.defaultLng,
          lat: p.binding.defaultLat,
        };
      }
    }
  }
  // Avoid the unused-var warning when hostBbox is supplied but no
  // parameter consumes it (every consumer reads it from the panel,
  // not from seed values, so this is intentional).
  void hostBbox;
  return out;
}
