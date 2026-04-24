'use client';

import 'maplibre-gl/dist/maplibre-gl.css';
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import maplibregl from 'maplibre-gl';
import type {
  BasemapKey,
  MapData,
  MapLayer,
  MapLayerFilter,
  MapLayerFilterClause,
} from '@gratis-gis/shared-types';
import { DEFAULT_LAYER_SCALE, ZOOM_MAX, ZOOM_MIN } from '@gratis-gis/shared-types';
import { BASEMAPS } from '@/lib/basemaps';
import {
  customBasemapToStyle,
  type CustomBasemap,
} from '@/lib/custom-basemap';
import {
  MAP_ICONS,
  iconImageId,
  iconSdfImageId,
  renderIconSvg,
  renderIconSvgForSdf,
} from './map-icons';
import { svgToSdf } from './sdf';
import { fetchLayerBBox } from '@/lib/arcgis-rest';
import type { SelectToolMode } from './select-tool';

interface Props {
  /** Controlled camera + basemap + layer list. */
  map: MapData;
  /**
   * Custom basemaps from the org's library. If the Map's
   * `customBasemapId` is set and present in this list, we
   * materialize a MapLibre style from the row instead of the
   * built-in `map.basemap` key.
   */
  customBasemaps?: CustomBasemap[];
  /** Fired whenever the user pans, zooms, rotates, or pitches. */
  onCameraChange: (next: Pick<MapData, 'center' | 'zoom' | 'bearing' | 'pitch'>) => void;
  /** Per-layer sets of selected feature ids (identical to feature indexes). */
  selection: Record<string, Set<number>>;
  /**
   * Active selection tool. When `'off'`, clicks show popups and drags
   * pan the camera (today's default). Any other mode suppresses popups
   * and re-routes pointer events into the selection handlers.
   */
  selectTool: SelectToolMode;
  /**
   * Commit a new selection. Called by the click / rectangle / polygon
   * handlers once they resolve a feature set. The canvas never mutates
   * the selection state directly — parent owns the canonical copy.
   */
  onSelectionChange: (
    next: Record<string, Set<number>>,
  ) => void;
}

export interface MapCanvasHandle {
  /** Fly the camera to a bbox, padded so features aren't flush against the edges. */
  zoomTo: (bbox: [number, number, number, number]) => void;
  /**
   * Fly to a bbox or point and briefly highlight a specific feature on
   * the given layer. Used by the search bar so picking a result is
   * visually obvious even on dense maps.
   */
  flyAndHighlight: (args: {
    bbox: [number, number, number, number] | null;
    center: [number, number] | null;
    layerId?: string;
    featureId?: string | number;
    /** Feature properties used for best-effort match when no stable id. */
    featureProps?: Record<string, unknown>;
  }) => void;
}

/**
 * MapLibre canvas wired up to the declarative MapData shape.
 *
 * Why this is a "dumb" component: all editing actions (add layer,
 * restyle, reorder) happen outside this file. The canvas just mirrors
 * the current state — so a state update anywhere else always produces
 * a correct render with no hand-synced imperative code.
 *
 * The synchronization strategy is blunt by design: on any layer-list
 * change we tear down and rebuild our overlay sources. The underlying
 * basemap and camera survive, so the user never sees a flash. A smarter
 * diff is possible later; for now simplicity beats theoretical perf.
 */
export const MapCanvas = forwardRef<MapCanvasHandle, Props>(function MapCanvas(
  {
    map,
    customBasemaps = [],
    onCameraChange,
    selection,
    selectTool,
    onSelectionChange,
  }: Props,
  ref,
) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  // Stable ref to the current customBasemaps array so the basemap-
  // swap effect can read the latest list without re-running on every
  // identity change of the prop.
  const customBasemapsRef = useRef<CustomBasemap[]>(customBasemaps);
  customBasemapsRef.current = customBasemaps;
  const mapRef = useRef<maplibregl.Map | null>(null);
  const hoveredRef = useRef<{ sourceId: string; featureId: string | number } | null>(null);
  const popupRef = useRef<maplibregl.Popup | null>(null);
  // Mirror of map.layers so async callbacks (basemap swap's
  // styledata handler, deferred icon loads) see the latest layer
  // list without re-running their setup effect on every prop update.
  const layersRef = useRef<typeof map.layers>(map.layers);
  layersRef.current = map.layers;
  // Refs the selection handlers read so we don't have to re-wire
  // mouse listeners every time the selection or tool changes.
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const selectToolRef = useRef<SelectToolMode>(selectTool);
  selectToolRef.current = selectTool;
  const onSelectionChangeRef = useRef(onSelectionChange);
  onSelectionChangeRef.current = onSelectionChange;

  // Select-tool local state. Refs mirror the state so the MapLibre
  // event handlers (which live in a useEffect closure) can read the
  // latest values without re-binding on every keystroke.
  const [rectDrag, setRectDrag] = useState<null | {
    startX: number;
    startY: number;
    curX: number;
    curY: number;
  }>(null);
  const rectDragRef = useRef(rectDrag);
  rectDragRef.current = rectDrag;
  const [polygonVerts, setPolygonVerts] = useState<Array<[number, number]>>([]);
  const polygonVertsRef = useRef(polygonVerts);
  polygonVertsRef.current = polygonVerts;
  const [polygonCursor, setPolygonCursor] = useState<
    [number, number] | null
  >(null);
  const [lassoPoints, setLassoPoints] = useState<Array<[number, number]>>([]);
  const lassoPointsRef = useRef(lassoPoints);
  lassoPointsRef.current = lassoPoints;

  // Tick that invalidates projected pixel positions for polygon
  // vertices whenever the camera moves. Vertices live in lng/lat so
  // they anchor to the map, but we render them in pixel space via
  // map.project(); bumping this ensures the render picks up fresh
  // projections after a pan/zoom.
  const [projectTick, setProjectTick] = useState(0);
  useEffect(() => {
    const m = mapRef.current;
    if (!m) return;
    const onMove = () => setProjectTick((t) => t + 1);
    m.on('move', onMove);
    return () => {
      m.off('move', onMove);
    };
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      zoomTo: (bbox) => {
        const m = mapRef.current;
        if (!m) return;
        m.fitBounds(
          [
            [bbox[0], bbox[1]],
            [bbox[2], bbox[3]],
          ],
          { padding: 60, duration: 600, maxZoom: 16 },
        );
      },
      flyAndHighlight: ({ bbox, center, layerId, featureProps }) => {
        const m = mapRef.current;
        if (!m) return;
        if (bbox) {
          m.fitBounds(
            [
              [bbox[0], bbox[1]],
              [bbox[2], bbox[3]],
            ],
            { padding: 80, duration: 700, maxZoom: 18 },
          );
        } else if (center) {
          m.flyTo({ center, zoom: 17, duration: 700 });
        }
        // Hover-state highlight on the matched feature. `generateId`
        // assigns stable per-session ids to geojson sources, so we can
        // queryRenderedFeatures after the camera animation settles and
        // set feature-state.
        if (!layerId) return;
        const sourceId = `gg:${layerId}`;
        const handle = () => {
          const rendered = m.querySourceFeatures(sourceId);
          const match = featureProps
            ? rendered.find((f) => propertiesMatch(f.properties, featureProps))
            : rendered[0];
          if (!match || match.id === undefined) return;
          const prevId = match.id as string | number;
          m.setFeatureState({ source: sourceId, id: prevId }, { hover: true });
          // Clear after a couple seconds so the pulse feels temporary.
          setTimeout(() => {
            m.setFeatureState({ source: sourceId, id: prevId }, { hover: false });
          }, 2500);
        };
        m.once('moveend', handle);
      },
    }),
    [],
  );

  // Tick bumped whenever a batch of icons finishes registering, so the
  // layer-sync effect can re-run and pick up the new images.
  const [iconsTick, setIconsTick] = useState(0);

  // Remember the last selection we applied to MapLibre's feature-state,
  // so we know which ids to clear when the selection shrinks. A bare
  // ref is enough — we don't need this in React state.
  const appliedSelectionRef = useRef<Record<string, Set<number>>>({});

  // Sync shared selection state â†’ MapLibre feature-state. Diffs against
  // the previously-applied map so we only touch what changed rather
  // than walking every feature on every render.
  useEffect(() => {
    const m = mapRef.current;
    if (!m) return;
    const prevApplied = appliedSelectionRef.current;
    const nextApplied: Record<string, Set<number>> = {};

    for (const layerId of new Set([
      ...Object.keys(prevApplied),
      ...Object.keys(selection),
    ])) {
      const sourceId = `gg:${layerId}`;
      // If the source isn't in the style (layer was deleted or still
      // loading), skip — the next syncOverlays will handle it.
      if (!m.getSource(sourceId)) continue;

      const prev = prevApplied[layerId] ?? new Set<number>();
      const next = selection[layerId] ?? new Set<number>();
      nextApplied[layerId] = next;

      for (const id of prev) {
        if (!next.has(id)) {
          m.setFeatureState({ source: sourceId, id }, { selected: false });
        }
      }
      for (const id of next) {
        if (!prev.has(id)) {
          m.setFeatureState({ source: sourceId, id }, { selected: true });
        }
      }
    }
    appliedSelectionRef.current = nextApplied;
  }, [selection, iconsTick]);

  // Wrap the callback in a ref so the stable effect below doesn't need
  // to re-bind listeners every render.
  const onCameraChangeRef = useRef(onCameraChange);
  useEffect(() => {
    onCameraChangeRef.current = onCameraChange;
  }, [onCameraChange]);

  // Resolve the MapLibre style for the current MapData. Custom
  // basemap wins if still present in the library; otherwise fall back
  // to the built-in key. MapLibre's setStyle() accepts either a
  // StyleSpecification or a URL string, so this returns whichever
  // variant the source kind implies.
  function resolveStyle(): maplibregl.StyleSpecification | string {
    if (map.customBasemapId) {
      const row = customBasemapsRef.current.find(
        (b) => b.id === map.customBasemapId,
      );
      if (row) {
        const cs = customBasemapToStyle(row);
        return cs.kind === 'url' ? cs.url : cs.style;
      }
    }
    return BASEMAPS[map.basemap].style;
  }

  // Create the map once; tear down on unmount.
  useEffect(() => {
    if (mapRef.current || !containerRef.current) return;
    const m = new maplibregl.Map({
      container: containerRef.current,
      style: resolveStyle(),
      center: map.center,
      zoom: map.zoom,
      bearing: map.bearing,
      pitch: map.pitch,
      attributionControl: false,
    });
    m.addControl(new maplibregl.NavigationControl({ showCompass: true }), 'top-right');
    m.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');
    m.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');

    const markCamera = (e: { originalEvent?: unknown }) => {
      if (!e.originalEvent) return;
      const c = m.getCenter();
      onCameraChangeRef.current({
        center: [c.lng, c.lat],
        zoom: m.getZoom(),
        bearing: m.getBearing(),
        pitch: m.getPitch(),
      });
    };
    m.on('moveend', markCamera);
    m.on('zoomend', markCamera);
    m.on('rotateend', markCamera);
    m.on('pitchend', markCamera);

    // Register the default icon library. Layer sync waits on this via
    // the `iconsTick` state: each time a batch of icons finishes
    // registering we bump the tick so the sync effect re-runs and any
    // symbol layers that were waiting on their images finally render.
    //
    // Registration is idempotent per-id, so basemap swaps that replay
    // this via 'styledata' don't duplicate images. We track a ref to
    // the tick setter so the async load callback doesn't capture a
    // stale React state function.
    let cancelled = false;
    const kickLoadIfReady = () => {
      if (!m.isStyleLoaded()) return;
      void loadAllIcons(m).then(() => {
        if (!cancelled) setIconsTick((t) => t + 1);
      });
    };
    m.on('load', kickLoadIfReady);
    m.on('styledata', kickLoadIfReady);
    kickLoadIfReady();

    mapRef.current = m;
    return () => {
      cancelled = true;
      m.remove();
      mapRef.current = null;
    };
    // We intentionally create the map from initial props only; updates
    // are handled by the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);


  // Basemap swap. Preserves camera + overlays so it feels seamless.
  //
  // Polling isStyleLoaded on a short interval turned out to be more
  // reliable than hooking `styledata` — when MapLibre falls back to
  // "rebuild from scratch" (which the console warning flagged),
  // `styledata` events can fire in a state where `isStyleLoaded`
  // briefly returns true but the style isn't really ready for
  // addSource/addLayer. Polling plus an explicit `idle` event as
  // the "fully done" signal catches both fast and slow basemaps.
  useEffect(() => {
    const m = mapRef.current;
    if (!m) return;
    // Tag for the loaded style so we can tell when a new basemap
    // choice needs a reset. Includes customBasemapId so a swap
    // between two custom basemaps (same built-in fallback key) also
    // triggers a setStyle.
    const desiredTag = map.customBasemapId
      ? `custom:${map.customBasemapId}`
      : `builtin:${map.basemap}`;
    const current = (
      m.getStyle() as { metadata?: { basemapTag?: string } } | null
    )?.metadata?.basemapTag;
    if (current === desiredTag) return;

    const c = m.getCenter();
    const z = m.getZoom();
    const b = m.getBearing();
    const p = m.getPitch();

    for (const name of Object.keys(MAP_ICONS)) {
      const plainId = iconImageId(name);
      const sdfId = iconSdfImageId(name);
      if (m.hasImage(plainId)) m.removeImage(plainId);
      if (m.hasImage(sdfId)) m.removeImage(sdfId);
    }

    const resolved = resolveStyle();
    if (typeof resolved === 'string') {
      // Vector style.json URL — MapLibre fetches it. We can't tag the
      // style object directly, so fall back to marking after it loads.
      // eslint-disable-next-line no-console
      console.debug('[basemap] setStyle URL â†’', desiredTag);
      m.setStyle(resolved);
      m.once('styledata', () => {
        // Best-effort tag so the `current !== desired` check above
        // short-circuits on subsequent renders.
        const s = m.getStyle() as { metadata?: Record<string, unknown> } | null;
        if (s) {
          (s.metadata ??= {}).basemapTag = desiredTag;
        }
      });
    } else {
      const style = {
        ...resolved,
        metadata: { ...(resolved.metadata ?? {}), basemapTag: desiredTag },
      };
      // eslint-disable-next-line no-console
      console.debug('[basemap] setStyle â†’', desiredTag);
      m.setStyle(style);
    }

    let cancelled = false;
    let done = false;
    const applyOverlays = async () => {
      if (cancelled || done) return;
      done = true;
      // eslint-disable-next-line no-console
      console.debug('[basemap] applying overlays for', map.basemap);
      m.jumpTo({ center: [c.lng, c.lat], zoom: z, bearing: b, pitch: p });
      await loadAllIcons(m);
      if (cancelled) return;
      syncOverlays(m, layersRef.current, hoveredRef);
      setIconsTick((t) => t + 1);
    };

    // Primary trigger: `idle` fires once everything — style, tiles,
    // pending data — has settled. MapLibre emits it on style swaps
    // reliably, so it's the right "fully ready" signal.
    const onIdle = () => {
      m.off('idle', onIdle);
      void applyOverlays();
    };
    m.on('idle', onIdle);

    // Safety net: if `idle` doesn't fire within a reasonable window
    // (e.g., a slow raster basemap where a tile stays pending), poll
    // isStyleLoaded and proceed anyway. Overlays live above tiles,
    // so we don't need raster tiles to be done.
    const pollHandle = window.setInterval(() => {
      if (done || cancelled) {
        window.clearInterval(pollHandle);
        return;
      }
      if (m.isStyleLoaded()) {
        window.clearInterval(pollHandle);
        m.off('idle', onIdle);
        void applyOverlays();
      }
    }, 120);

    return () => {
      cancelled = true;
      window.clearInterval(pollHandle);
      m.off('idle', onIdle);
    };
    // Re-run on either built-in or custom basemap changes so swapping
    // between custom rows (or from a custom back to a built-in)
    // triggers a setStyle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map.basemap, map.customBasemapId]);

  // Keep overlay layers (everything after the basemap) in sync with
  // props. Depends on iconsTick so the sync re-runs once each icon
  // batch finishes registering — otherwise a symbol layer can be
  // added referencing an image that MapLibre hasn't received yet,
  // and it silently renders nothing.
  //
  // When the style is mid-load we listen on `styledata` rather than
  // `load`; `load` does not reliably fire on subsequent setStyle
  // calls, so the basemap-swap path wouldn't unstick itself without
  // this.
  useEffect(() => {
    const m = mapRef.current;
    if (!m) return;
    if (!m.isStyleLoaded()) {
      const once = () => {
        if (!m.isStyleLoaded()) return;
        m.off('styledata', once);
        syncOverlays(m, map.layers, hoveredRef);
      };
      m.on('styledata', once);
      return () => {
        m.off('styledata', once);
      };
    }
    syncOverlays(m, map.layers, hoveredRef);
  }, [map.layers, iconsTick]);

  // Live bbox-driven refetch for ArcGIS REST layers. Runs after
  // syncOverlays (same dep array, later in the file), so the sources
  // those layers registered are already in place when we try to
  // setData on them. Abort in-flight requests on camera churn so we
  // don't race; cap at ~5000 features per bbox to keep the browser
  // responsive on dense services. Users can pull-to-local as a
  // separate flow when they want the full dataset.
  const arcgisControllers = useRef<Record<string, AbortController>>({});
  useEffect(() => {
    const m = mapRef.current;
    if (!m) return;
    const arcgisLayers = map.layers.filter(
      (l) => l.visible && l.source.kind === 'arcgis-rest',
    );
    // Drop any controllers for layers that are no longer in the list.
    for (const id of Object.keys(arcgisControllers.current)) {
      if (!arcgisLayers.some((l) => l.id === id)) {
        arcgisControllers.current[id]?.abort();
        delete arcgisControllers.current[id];
      }
    }
    if (arcgisLayers.length === 0) return;

    const refetchAll = () => {
      const b = m.getBounds();
      const bbox: [number, number, number, number] = [
        b.getWest(),
        b.getSouth(),
        b.getEast(),
        b.getNorth(),
      ];
      for (const layer of arcgisLayers) {
        const src = m.getSource(`gg:${layer.id}`) as
          | maplibregl.GeoJSONSource
          | undefined;
        if (!src) continue;
        arcgisControllers.current[layer.id]?.abort();
        const controller = new AbortController();
        arcgisControllers.current[layer.id] = controller;
        const arc = layer.source as {
          kind: 'arcgis-rest';
          url: string;
          layerId: number;
        };
        fetchLayerBBox(arc.url, arc.layerId, bbox, {
          signal: controller.signal,
        })
          .then(({ featureCollection }) => {
            if (controller.signal.aborted) return;
            src.setData(featureCollection);
          })
          .catch((err) => {
            if ((err as Error)?.name === 'AbortError') return;
            // Surface errors via console — a user-facing banner can
            // land with the item detail page rather than scattering
            // fetch notifications across the canvas.
            // eslint-disable-next-line no-console
            console.warn(`[arcgis] ${layer.title}:`, (err as Error).message);
          });
      }
    };
    refetchAll();
    m.on('moveend', refetchAll);
    return () => {
      m.off('moveend', refetchAll);
    };
  }, [map.layers, iconsTick]);

  // Click handlers for popups, hover handlers for highlight + cursor.
  // Attached once, dispatches dynamically based on the current layer set.
  useEffect(() => {
    const m = mapRef.current;
    if (!m) return;

    // Only query layer ids that actually exist in the current style.
    // Asking MapLibre to filter by an unknown layer silently returns
    // zero hits, which made popups and hover appear totally dead when
    // a layer's optional variants (e.g. `-label`) weren't registered.
    // Only layers whose effective permissions allow querying should
    // participate in hover / popup / click-select. Server-filtered
    // maps (viewer-only access) set `effective.query === false` on
    // layers the matrix narrowed to view-only; leaving them out of
    // queryRenderedFeatures keeps the cursor from turning into a
    // "clickable" pointer and stops hover highlight from firing on
    // data the user isn't cleared to read.
    const interactiveLayerIds = (): string[] => {
      // getStyle() can return undefined before the initial style load
      // completes and during style transitions. Bail out with an empty
      // list — the hover / popup / click paths all no-op cleanly when
      // there are no interactive layer ids to query.
      const style = m.getStyle();
      if (!style) return [];
      const existing = new Set((style.layers ?? []).map((sl) => sl.id));
      const queryable = map.layers.filter(
        (l) => l.effective === undefined || l.effective.query !== false,
      );
      const wanted = queryable.flatMap((l) => overlayLayerIds(l.id));
      return wanted.filter((id) => existing.has(id));
    };

    function onMouseMove(e: maplibregl.MapMouseEvent) {
      // Skip the hover + "pointer over feature" cursor while any
      // selection tool is active. Otherwise the cursor flickers
      // between the tool indicator and the pointer as the user
      // passes over features, and hover highlights fire mid-drag
      // of a box/polygon/lasso.
      if (selectToolRef.current !== 'off') {
        const cur = hoveredRef.current;
        if (cur) {
          m!.setFeatureState(
            { source: cur.sourceId, id: cur.featureId },
            { hover: false },
          );
          hoveredRef.current = null;
        }
        return;
      }

      const hits = m!.queryRenderedFeatures(e.point, {
        layers: interactiveLayerIds(),
      });
      m!.getCanvas().style.cursor = hits.length > 0 ? 'pointer' : '';

      // Clear previous hover state, then set the new one.
      const cur = hoveredRef.current;
      if (cur) {
        m!.setFeatureState(
          { source: cur.sourceId, id: cur.featureId },
          { hover: false },
        );
        hoveredRef.current = null;
      }
      const hit = hits[0];
      if (hit && hit.id !== undefined) {
        // feature-state needs ids; GeoJSON features have `id` only if
        // the source was added with generateId: true (we do).
        m!.setFeatureState(
          { source: hit.source, id: hit.id },
          { hover: true },
        );
        hoveredRef.current = {
          sourceId: hit.source,
          featureId: hit.id as string | number,
        };
      }
    }
    function onMouseLeave() {
      const cur = hoveredRef.current;
      if (!cur || !m) return;
      m.setFeatureState(
        { source: cur.sourceId, id: cur.featureId },
        { hover: false },
      );
      hoveredRef.current = null;
      m.getCanvas().style.cursor = '';
    }
    function onClick(e: maplibregl.MapMouseEvent) {
      const tool = selectToolRef.current;
      // Rectangle & polygon tools have their own handlers — a plain
      // click should never compete with their drag/vertex logic.
      if (tool === 'rectangle' || tool === 'polygon') return;
      const hits = m!.queryRenderedFeatures(e.point, {
        layers: interactiveLayerIds(),
      });

      if (tool === 'click') {
        const hit = hits[0];
        const layer = hit
          ? map.layers.find((l) =>
              overlayLayerIds(l.id).some((id) => id === hit.layer.id),
            )
          : null;
        applySelectionMutation({
          current: selectionRef.current,
          layers: map.layers,
          hit:
            hit && layer && layer.interactions.selectable !== false
              ? { layerId: layer.id, featureId: hit.id as number }
              : null,
          mods: {
            shift: (e.originalEvent as MouseEvent).shiftKey,
            meta:
              (e.originalEvent as MouseEvent).ctrlKey ||
              (e.originalEvent as MouseEvent).metaKey,
          },
          apply: onSelectionChangeRef.current,
        });
        return;
      }

      // tool === 'off' â†’ popup behaviour.
      const hit = hits[0];
      if (!hit) {
        popupRef.current?.remove();
        popupRef.current = null;
        return;
      }
      const layer = map.layers.find((l) =>
        overlayLayerIds(l.id).some((id) => id === hit.layer.id),
      );
      // Honour server-computed permissions when present — viewers
      // get `effective.query === false` for any layer the access
      // matrix narrowed to view-only, and popups should stay closed.
      if (!layer || !layer.popup.enabled) return;
      if (layer.effective && layer.effective.query === false) return;
      popupRef.current?.remove();
      popupRef.current = new maplibregl.Popup({ closeOnClick: true, maxWidth: '320px' })
        .setLngLat(e.lngLat)
        .setHTML(renderPopupHtml(layer, hit.properties ?? {}))
        .addTo(m!);
    }

    m.on('mousemove', onMouseMove);
    m.on('mouseleave', onMouseLeave);
    m.on('click', onClick);
    return () => {
      m.off('mousemove', onMouseMove);
      m.off('mouseleave', onMouseLeave);
      m.off('click', onClick);
    };
  }, [map.layers]);

  // Rectangle-select tool. Disables pan while active so drag starts
  // a box; on mouseup we queryRenderedFeatures against the pixel
  // bbox and turn the result into per-layer id sets. Shift extends
  // the current selection; no modifier replaces.
  useEffect(() => {
    const m = mapRef.current;
    if (!m) return;
    if (selectTool !== 'rectangle') return;

    m.dragPan.disable();
    m.boxZoom.disable();
    const canvas = m.getCanvas();

    const toPixel = (ev: MouseEvent): [number, number] => {
      const rect = canvas.getBoundingClientRect();
      return [ev.clientX - rect.left, ev.clientY - rect.top];
    };

    let localDrag:
      | { startX: number; startY: number; curX: number; curY: number }
      | null = null;

    const onMouseDown = (ev: MouseEvent) => {
      if (ev.button !== 0) return;
      ev.preventDefault();
      const [x, y] = toPixel(ev);
      localDrag = { startX: x, startY: y, curX: x, curY: y };
      setRectDrag({ ...localDrag });
    };
    const onMouseMove = (ev: MouseEvent) => {
      if (!localDrag) return;
      const [x, y] = toPixel(ev);
      localDrag.curX = x;
      localDrag.curY = y;
      setRectDrag({ ...localDrag });
    };
    const onMouseUp = (ev: MouseEvent) => {
      if (!localDrag) return;
      const box = localDrag;
      localDrag = null;
      setRectDrag(null);
      if (
        Math.abs(box.curX - box.startX) < 3 &&
        Math.abs(box.curY - box.startY) < 3
      ) {
        return;
      }
      const bbox: [[number, number], [number, number]] = [
        [Math.min(box.startX, box.curX), Math.min(box.startY, box.curY)],
        [Math.max(box.startX, box.curX), Math.max(box.startY, box.curY)],
      ];
      const picked = collectFeaturesInBbox(m, layersRef.current, bbox);
      applyShiftOrReplace(picked, ev.shiftKey);
    };

    canvas.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      canvas.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      m.dragPan.enable();
      m.boxZoom.enable();
      setRectDrag(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectTool]);

  // Polygon-select tool. Click adds a vertex; clicking near the
  // first vertex (within ~10 px) or pressing Enter closes the shape
  // and runs the selection. Escape discards the in-progress polygon.
  // Pan stays enabled so authors can pan the map mid-draw if they
  // need to reach far vertices.
  useEffect(() => {
    const m = mapRef.current;
    if (!m) return;
    if (selectTool !== 'polygon') return;

    m.doubleClickZoom.disable();

    const closePolygon = (shift: boolean) => {
      const verts = polygonVertsRef.current;
      if (verts.length < 3) return;
      const picked = collectFeaturesInPolygon(m, layersRef.current, verts);
      applyShiftOrReplace(picked, shift);
      setPolygonVerts([]);
    };

    const onClick = (e: maplibregl.MapMouseEvent) => {
      const verts = polygonVertsRef.current;
      if (verts.length >= 3) {
        const first = verts[0]!;
        const firstPx = m.project(first);
        const dx = firstPx.x - e.point.x;
        const dy = firstPx.y - e.point.y;
        if (dx * dx + dy * dy < 12 * 12) {
          closePolygon((e.originalEvent as MouseEvent).shiftKey);
          return;
        }
      }
      setPolygonVerts([...verts, [e.lngLat.lng, e.lngLat.lat]]);
    };
    const onDblClick = (e: maplibregl.MapMouseEvent) => {
      if (polygonVertsRef.current.length < 3) return;
      e.preventDefault();
      closePolygon((e.originalEvent as MouseEvent).shiftKey);
    };
    const onMouseMove = (e: maplibregl.MapMouseEvent) => {
      setPolygonCursor([e.point.x, e.point.y]);
    };
    const onMouseLeave = () => setPolygonCursor(null);
    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') {
        setPolygonVerts([]);
      } else if (ev.key === 'Enter') {
        closePolygon(ev.shiftKey);
      }
    };

    m.on('click', onClick);
    m.on('dblclick', onDblClick);
    m.on('mousemove', onMouseMove);
    m.on('mouseleave', onMouseLeave);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      m.off('click', onClick);
      m.off('dblclick', onDblClick);
      m.off('mousemove', onMouseMove);
      m.off('mouseleave', onMouseLeave);
      m.doubleClickZoom.enable();
      window.removeEventListener('keydown', onKeyDown);
      setPolygonVerts([]);
      setPolygonCursor(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectTool]);

  // Tool-cursor bridge. Each select tool gets a cursor cut from its
  // toolbar icon so authors always know which mode they're in just
  // by looking at the pointer. Applied as a data-URI SVG cursor on
  // the MapLibre canvas; off-mode restores whatever the canvas was
  // doing (pointer on feature hover, grab during pan).
  useEffect(() => {
    const m = mapRef.current;
    if (!m) return;
    const canvas = m.getCanvas();
    const prev = canvas.style.cursor;
    canvas.style.cursor = toolCursor(selectTool);
    return () => {
      canvas.style.cursor = prev;
    };
  }, [selectTool]);

  // Freehand lasso tool. Mouse-down starts the stroke, move appends
  // lng/lat points, mouseup closes the loop and runs the polygon
  // selection (same centroid-based filter). Like rectangle we
  // disable pan so drag is unambiguously the lasso gesture.
  useEffect(() => {
    const m = mapRef.current;
    if (!m) return;
    if (selectTool !== 'lasso') return;

    m.dragPan.disable();
    m.boxZoom.disable();
    const canvas = m.getCanvas();

    let drawing = false;

    const onMouseDown = (ev: MouseEvent) => {
      if (ev.button !== 0) return;
      ev.preventDefault();
      drawing = true;
      const rect = canvas.getBoundingClientRect();
      const px = ev.clientX - rect.left;
      const py = ev.clientY - rect.top;
      const ll = m.unproject([px, py]);
      setLassoPoints([[ll.lng, ll.lat]]);
    };
    const onMouseMove = (ev: MouseEvent) => {
      if (!drawing) return;
      const rect = canvas.getBoundingClientRect();
      const px = ev.clientX - rect.left;
      const py = ev.clientY - rect.top;
      const ll = m.unproject([px, py]);
      // Throttle point count: skip points closer than ~2 px to the
      // last one so the path stays smooth without exploding state
      // on fast drags.
      const last = lassoPointsRef.current[lassoPointsRef.current.length - 1];
      if (last) {
        const lp = m.project(last);
        const dx = lp.x - px;
        const dy = lp.y - py;
        if (dx * dx + dy * dy < 4) return;
      }
      setLassoPoints([...lassoPointsRef.current, [ll.lng, ll.lat]]);
    };
    const onMouseUp = (ev: MouseEvent) => {
      if (!drawing) return;
      drawing = false;
      const pts = lassoPointsRef.current;
      setLassoPoints([]);
      if (pts.length < 3) return;
      const picked = collectFeaturesInPolygon(m, layersRef.current, pts);
      applyShiftOrReplace(picked, ev.shiftKey);
    };

    canvas.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      canvas.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      m.dragPan.enable();
      m.boxZoom.enable();
      setLassoPoints([]);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectTool]);

  // Helper: either replace the selection wholesale (plain click) or
  // merge into it (shift click). Used by both rectangle and polygon
  // closers so modifier handling stays consistent.
  function applyShiftOrReplace(
    picked: Record<string, Set<number>>,
    shift: boolean,
  ): void {
    if (!shift) {
      onSelectionChangeRef.current(picked);
      return;
    }
    const merged = { ...selectionRef.current };
    for (const [lid, ids] of Object.entries(picked)) {
      const cur = merged[lid] ?? new Set<number>();
      const next = new Set(cur);
      for (const id of ids) next.add(id);
      merged[lid] = next;
    }
    onSelectionChangeRef.current(merged);
  }

  // Camera sync: only push external camera changes into MapLibre, don't
  // fight the user's pan/zoom gestures.
  const externalCamera = useMemo(
    () => ({
      center: map.center,
      zoom: map.zoom,
      bearing: map.bearing,
      pitch: map.pitch,
    }),
    [map.center, map.zoom, map.bearing, map.pitch],
  );
  useEffect(() => {
    const m = mapRef.current;
    if (!m) return;
    const c = m.getCenter();
    const sameCenter =
      Math.abs(c.lng - externalCamera.center[0]) < 1e-9 &&
      Math.abs(c.lat - externalCamera.center[1]) < 1e-9;
    if (
      sameCenter &&
      m.getZoom() === externalCamera.zoom &&
      m.getBearing() === externalCamera.bearing &&
      m.getPitch() === externalCamera.pitch
    ) {
      return;
    }
    // Reset: programmatic moves shouldn't echo as user changes.
    m.jumpTo({
      center: externalCamera.center,
      zoom: externalCamera.zoom,
      bearing: externalCamera.bearing,
      pitch: externalCamera.pitch,
    });
  }, [externalCamera]);

  // Compute projected pixel positions for the in-progress polygon so
  // the SVG overlay can render vertex handles + the closing edge.
  // Depends on projectTick so camera moves repaint the vertices at
  // their new screen positions.
  const projectedVerts = useMemo(() => {
    const m = mapRef.current;
    if (!m) return [] as Array<{ x: number; y: number }>;
    return polygonVerts.map((v) => m.project(v));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [polygonVerts, projectTick]);
  const firstVertHover =
    polygonCursor && projectedVerts.length >= 3
      ? (() => {
          const f = projectedVerts[0]!;
          const dx = f.x - polygonCursor[0];
          const dy = f.y - polygonCursor[1];
          return dx * dx + dy * dy < 12 * 12;
        })()
      : false;

  return (
    <div className="relative h-full w-full">
      <div
        ref={containerRef}
        className="h-full w-full overflow-hidden rounded-lg border border-border shadow-card"
      />
      {/* Rectangle drag overlay. Rendered only while an active drag
          is happening so it doesn't catch pointer events otherwise. */}
      {rectDrag ? (
        <div
          className="pointer-events-none absolute rounded-sm border-2 border-accent bg-accent/10"
          style={{
            left: Math.min(rectDrag.startX, rectDrag.curX),
            top: Math.min(rectDrag.startY, rectDrag.curY),
            width: Math.abs(rectDrag.curX - rectDrag.startX),
            height: Math.abs(rectDrag.curY - rectDrag.startY),
          }}
        />
      ) : null}
      {/* Polygon in-progress overlay. Vertices are re-projected on
          every camera move via projectTick so they stay anchored to
          the map. A rubber-band edge tracks the cursor until the
          polygon closes. */}
      {/* Lasso in-progress path. Uses the same project-on-render
          trick as polygon so the path stays anchored to the map
          while drawing. */}
      {lassoPoints.length > 1 ? (
        <svg className="pointer-events-none absolute inset-0 h-full w-full">
          <polyline
            points={lassoPoints
              .map((p) => {
                const xy = mapRef.current?.project(p);
                return xy ? `${xy.x},${xy.y}` : '';
              })
              .filter(Boolean)
              .join(' ')}
            fill="rgba(37,99,235,0.08)"
            stroke="hsl(var(--accent))"
            strokeWidth={2}
            strokeLinejoin="round"
          />
        </svg>
      ) : null}
      {polygonVerts.length > 0 ? (
        <svg
          className="pointer-events-none absolute inset-0 h-full w-full"
          viewBox={undefined}
        >
          {/* Edge path including rubber-band to cursor */}
          <polyline
            points={[
              ...projectedVerts.map((p) => `${p.x},${p.y}`),
              polygonCursor ? `${polygonCursor[0]},${polygonCursor[1]}` : '',
            ]
              .filter(Boolean)
              .join(' ')}
            fill="none"
            stroke="hsl(var(--accent))"
            strokeWidth={2}
            strokeDasharray="4 3"
          />
          {/* Closing segment preview when the cursor nears the first vertex */}
          {firstVertHover && polygonCursor ? (
            <line
              x1={polygonCursor[0]}
              y1={polygonCursor[1]}
              x2={projectedVerts[0]!.x}
              y2={projectedVerts[0]!.y}
              stroke="hsl(var(--accent))"
              strokeWidth={2}
            />
          ) : null}
          {projectedVerts.map((p, i) => (
            <circle
              key={i}
              cx={p.x}
              cy={p.y}
              r={i === 0 && firstVertHover ? 7 : 4}
              fill={i === 0 && firstVertHover ? 'hsl(var(--accent))' : 'white'}
              stroke="hsl(var(--accent))"
              strokeWidth={2}
            />
          ))}
        </svg>
      ) : null}
    </div>
  );
});

/**
 * Load an SVG string onto a canvas and return the raw pixels. Used to
 * turn the bundled icon library into images MapLibre can register via
 * addImage(). We render at 2x physical pixels (96 Ã— 96 pixels for a
 * 48 Ã— 48 icon) so high-DPI displays stay crisp.
 */
async function rasterizeSvg(svg: string, size: number): Promise<ImageData> {
  const scale = 2;
  const w = size * scale;
  const h = size * scale;
  const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = (e) => reject(e);
      i.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas 2D unavailable');
    ctx.drawImage(img, 0, 0, w, h);
    return ctx.getImageData(0, 0, w, h);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Register every bundled icon (plain + SDF variant) with the map.
 * Idempotent via `hasImage` checks — caller is free to invoke this
 * on every basemap swap or style event without risking duplicates.
 * Failures are per-icon and silent so one bad SVG doesn't kill the
 * whole batch. Module-scoped so the init useEffect and the basemap
 * swap share a single implementation.
 */
async function loadAllIcons(m: maplibregl.Map): Promise<void> {
  await Promise.all(
    Object.keys(MAP_ICONS).map(async (name) => {
      const plainId = iconImageId(name);
      const sdfId = iconSdfImageId(name);
      if (!m.hasImage(plainId)) {
        try {
          const svg = renderIconSvg(name);
          if (svg) {
            const img = await rasterizeSvg(svg, 48);
            if (!m.hasImage(plainId)) {
              m.addImage(plainId, img, { pixelRatio: 2 });
            }
          }
        } catch {
          /* non-fatal */
        }
      }
      if (!m.hasImage(sdfId)) {
        try {
          const svg = renderIconSvgForSdf(name);
          if (svg) {
            const sdf = await svgToSdf(svg, 48);
            if (!m.hasImage(sdfId)) {
              m.addImage(sdfId, sdf, { pixelRatio: 2, sdf: true });
            }
          }
        } catch {
          /* non-fatal */
        }
      }
    }),
  );
}

/**
 * Shallow property-match. Used only for search highlight fallback
 * where feature ids aren't stable across fetches. We compare the
 * stringified primitives of the subset we care about (search result
 * carries the exact properties the result was built from).
 */
function propertiesMatch(
  a: Record<string, unknown> | null | undefined,
  b: Record<string, unknown>,
): boolean {
  if (!a) return false;
  for (const [k, v] of Object.entries(b)) {
    if (v === undefined || v === null) continue;
    if (String(a[k]) !== String(v)) return false;
  }
  return true;
}

/**
 * Apply a single-feature click to the current selection with modifier
 * keys honored.
 *
 *   - No modifiers, miss: clear all layers (drags the "click empty
 *     space to deselect" convention from most GIS apps).
 *   - No modifiers, hit:  replace selection with just this feature.
 *   - Shift + hit:        add this feature to existing selection.
 *   - Ctrl/Cmd + hit:     toggle this feature in/out of selection.
 *
 * Pure function that dispatches via the caller's `apply` callback.
 * Placed at module scope so the canvas's click handler can stay tiny.
 */
function applySelectionMutation({
  current,
  hit,
  mods,
  apply,
}: {
  current: Record<string, Set<number>>;
  layers: MapLayer[];
  hit: { layerId: string; featureId: number } | null;
  mods: { shift: boolean; meta: boolean };
  apply: (next: Record<string, Set<number>>) => void;
}): void {
  if (!hit) {
    if (!mods.shift && !mods.meta) apply({});
    return;
  }
  const { layerId, featureId } = hit;
  const cur = current[layerId] ?? new Set<number>();
  if (mods.meta) {
    const set = new Set(cur);
    if (set.has(featureId)) set.delete(featureId);
    else set.add(featureId);
    const next = { ...current };
    if (set.size === 0) delete next[layerId];
    else next[layerId] = set;
    apply(next);
    return;
  }
  if (mods.shift) {
    const next = { ...current };
    next[layerId] = new Set([...cur, featureId]);
    apply(next);
    return;
  }
  apply({ [layerId]: new Set([featureId]) });
}

/**
 * Ask MapLibre which features intersect a pixel bbox, then group the
 * hits by MapLayer id. Skips layers whose `interactions.selectable`
 * is explicitly false. Feature ids come from the source's generateId
 * setting — matches the indexes the attribute table uses.
 */
function collectFeaturesInBbox(
  m: maplibregl.Map,
  layers: MapLayer[],
  bbox: [[number, number], [number, number]],
): Record<string, Set<number>> {
  const wanted = layers
    .filter((l) => l.interactions.selectable !== false)
    .flatMap((l) => overlayLayerIds(l.id));
  // Guard against getStyle() returning undefined during style transitions.
  const style = m.getStyle();
  if (!style) return {};
  const existing = new Set((style.layers ?? []).map((sl) => sl.id));
  const mapLayerIds = wanted.filter((id) => existing.has(id));
  const hits = m.queryRenderedFeatures(bbox, { layers: mapLayerIds });
  return hitsByLayer(hits, layers);
}

/**
 * Pick features whose geometry centroid lies inside a polygon (vertex
 * list is lng/lat). We bbox-query MapLibre first to narrow the
 * candidate set, then ray-cast each candidate's centroid. Using the
 * centroid is a deliberate simplification — it doesn't distinguish a
 * feature straddling the polygon's edge from one fully inside, but
 * it lands within a few percent of the right answer on typical
 * parcel/building datasets and keeps us out of the turf.js size
 * budget. Swap in a real intersection test when the inaccuracy bites.
 */
function collectFeaturesInPolygon(
  m: maplibregl.Map,
  layers: MapLayer[],
  polygon: Array<[number, number]>,
): Record<string, Set<number>> {
  if (polygon.length < 3) return {};
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of polygon) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  const p1 = m.project([minX, minY]);
  const p2 = m.project([maxX, maxY]);
  const bbox: [[number, number], [number, number]] = [
    [Math.min(p1.x, p2.x), Math.min(p1.y, p2.y)],
    [Math.max(p1.x, p2.x), Math.max(p1.y, p2.y)],
  ];
  const wanted = layers
    .filter((l) => l.interactions.selectable !== false)
    .flatMap((l) => overlayLayerIds(l.id));
  // Guard against getStyle() returning undefined during style transitions.
  const style = m.getStyle();
  if (!style) return {};
  const existing = new Set((style.layers ?? []).map((sl) => sl.id));
  const mapLayerIds = wanted.filter((id) => existing.has(id));
  const hits = m.queryRenderedFeatures(bbox, { layers: mapLayerIds });
  const filtered = hits.filter((h) => {
    const c = geometryCentroid(h.geometry);
    return c !== null && pointInRing(c, polygon);
  });
  return hitsByLayer(filtered, layers);
}

function hitsByLayer(
  hits: maplibregl.MapGeoJSONFeature[],
  layers: MapLayer[],
): Record<string, Set<number>> {
  const result: Record<string, Set<number>> = {};
  for (const hit of hits) {
    if (hit.id === undefined || hit.id === null) continue;
    const layer = layers.find((l) =>
      overlayLayerIds(l.id).includes(hit.layer.id),
    );
    if (!layer || layer.interactions.selectable === false) continue;
    const fid = typeof hit.id === 'number' ? hit.id : Number(hit.id);
    if (!Number.isFinite(fid)) continue;
    const set = result[layer.id] ?? new Set<number>();
    set.add(fid);
    result[layer.id] = set;
  }
  return result;
}

/**
 * Classic ray-casting point-in-polygon. Polygon is a flat vertex
 * ring (no holes for now — selection polygons are user-drawn, always
 * simple). 1e-12 epsilon avoids divide-by-zero on horizontal edges.
 */
function pointInRing(
  pt: [number, number],
  ring: Array<[number, number]>,
): boolean {
  const [x, y] = pt;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    const intersect =
      yi > y !== yj > y &&
      x < ((xj - xi) * (y - yi)) / (yj - yi + 1e-12) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/**
 * Cheap geometry centroid: bbox mid for anything that isn't a Point.
 * Not a true geometric centroid, but the tradeoff is consistency
 * across geometry types and a tiny constant-time pass per feature.
 */
function geometryCentroid(
  geom: GeoJSON.Geometry | null | undefined,
): [number, number] | null {
  if (!geom) return null;
  if (geom.type === 'Point') {
    const [x, y] = geom.coordinates as number[];
    return typeof x === 'number' && typeof y === 'number' ? [x, y] : null;
  }
  const all: Array<[number, number]> = [];
  const visit = (v: unknown): void => {
    if (Array.isArray(v)) {
      if (
        v.length >= 2 &&
        typeof v[0] === 'number' &&
        typeof v[1] === 'number'
      ) {
        all.push([v[0] as number, v[1] as number]);
      } else {
        for (const c of v) visit(c);
      }
    }
  };
  if ('coordinates' in geom) visit(geom.coordinates);
  if (all.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of all) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return [(minX + maxX) / 2, (minY + maxY) / 2];
}

/** Ids of the MapLibre style-layers this MapLayer may contribute. */
function overlayLayerIds(layerId: string): string[] {
  return [
    `gg:${layerId}-fill`,
    `gg:${layerId}-poly-line`,
    `gg:${layerId}-line`,
    `gg:${layerId}-icon-halo`,
    `gg:${layerId}-circle`,
    `gg:${layerId}-label`,
  ];
}

/**
 * Cursor definitions for each select tool. Each entry is an inline
 * SVG + the (x, y) hot-spot in SVG pixel coords. Rendered as a
 * data-URI cursor so the browser handles the rest — no asset files,
 * no preload timing. Cursor size is capped at 24px which is the
 * largest all major browsers render reliably.
 *
 * White fill + black stroke makes the cursor readable on both light
 * (positron) and dark (carto-dark) basemaps without a backdrop.
 */
const TOOL_CURSORS: Record<
  Exclude<SelectToolMode, 'off'>,
  { svg: string; hx: number; hy: number }
> = {
  click: {
    svg: `<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='white' stroke='black' stroke-width='1.5' stroke-linejoin='round'><path d='M4 2 L4 18 L8 14 L11 21 L13.5 20 L10.5 13 L16 13 Z'/></svg>`,
    hx: 4,
    hy: 2,
  },
  rectangle: {
    svg: `<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round'><rect x='4' y='4' width='16' height='16' stroke-dasharray='3 2' fill='white'/><line x1='12' y1='9' x2='12' y2='15' stroke='black'/><line x1='9' y1='12' x2='15' y2='12' stroke='black'/></svg>`,
    hx: 12,
    hy: 12,
  },
  polygon: {
    svg: `<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='white' stroke='black' stroke-width='2' stroke-linejoin='round'><polygon points='12,3 22,10 18,21 6,21 2,10' stroke-dasharray='3 2'/><circle cx='12' cy='12' r='1.5' fill='black'/></svg>`,
    hx: 12,
    hy: 12,
  },
  lasso: {
    svg: `<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='white' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M5 18 C 4 6 20 4 20 13 Q 20 20 13 19 Q 5 18 8 12'/><circle cx='5' cy='18' r='1.5' fill='black'/></svg>`,
    hx: 5,
    hy: 18,
  },
};

function toolCursor(mode: SelectToolMode): string {
  if (mode === 'off') return '';
  const def = TOOL_CURSORS[mode];
  const encoded = encodeURIComponent(def.svg).replace(/'/g, '%27');
  return `url("data:image/svg+xml;utf8,${encoded}") ${def.hx} ${def.hy}, crosshair`;
}

/**
 * Remove any overlay sources + layers from a previous render, then add
 * the current set. Stable identifiers mean teardown is mechanical.
 */
function syncOverlays(
  m: maplibregl.Map,
  layers: MapLayer[],
  hoveredRef: React.MutableRefObject<{ sourceId: string; featureId: string | number } | null>,
) {
  // Remove previously-added overlay layers. Everything we own starts
  // with `gg:` so we can distinguish from basemap layers.
  const style = m.getStyle();
  if (style?.layers) {
    for (const l of style.layers) {
      if (l.id.startsWith('gg:')) m.removeLayer(l.id);
    }
  }
  if (style?.sources) {
    for (const id of Object.keys(style.sources)) {
      if (id.startsWith('gg:')) {
        try {
          m.removeSource(id);
        } catch {
          // Ignore races; a subsequent render will fix it.
        }
      }
    }
  }
  hoveredRef.current = null;

  for (const layer of layers) {
    if (!layer.visible) continue;
    const sourceId = `gg:${layer.id}`;
    const data = sourceData(layer);
    if (!data) continue;
    m.addSource(sourceId, {
      type: 'geojson',
      data,
      generateId: true,
    });

    const op = layer.opacity;
    const s = layer.style;
    const hover = layer.interactions.hoverHighlight;
    const scale = layer.scale ?? DEFAULT_LAYER_SCALE;
    const minzoom = scale.minZoom ?? ZOOM_MIN;
    const maxzoom = scale.maxZoom ?? ZOOM_MAX;
    const labelsMinzoom = scale.labelsMinZoom ?? minzoom;
    const labelsMaxzoom = scale.labelsMaxZoom ?? maxzoom;
    const zoomScaling = scale.scaleWithZoom !== false;

    // Colors may be driven by an attribute (unique-value renderer). The
    // helper returns either a MapLibre match expression or the plain
    // hex we were using before.
    const polyFill = rendererColor(layer, s.polygon.fillColor);
    const polyStroke = rendererColor(layer, s.polygon.strokeColor);
    const lineColor = rendererColor(layer, s.line.color);
    const pointFill = rendererColor(layer, s.point.color);

    // Build a state-aware "case" expression. `selected` beats `hover`
    // which beats the base value. Includes an optional hover branch
    // only when hover highlighting is enabled on the layer, so we
    // don't bloat the expression when nobody's hovering anywhere.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stateCase = (base: any, selectedValue: any, hoverValue: any): any => {
      const expr: any[] = ['case'];
      expr.push(['boolean', ['feature-state', 'selected'], false], selectedValue);
      if (hover) {
        expr.push(['boolean', ['feature-state', 'hover'], false], hoverValue);
      }
      expr.push(base);
      return expr;
    };

    const SEL_ACCENT = '#2563eb';

    // Point sizes grow smoothly with zoom so features don't dominate
    // the view at continent-level zooms and stay legible at street
    // level. Baseline at zoom 14 (roughly neighbourhood scale) with
    // gentle shrink below and mild growth above — tuned to match the
    // "feels right" curve most web map styles ship. When the layer
    // opts out of zoom scaling, the helpers return the flat value.
    const ZOOM_SCALE_STOPS: Array<[number, number]> = [
      [3, 0.3],
      [8, 0.6],
      [14, 1.0],
      [18, 1.3],
    ];

    // Interpolate a single numeric base across the zoom curve. Used
    // for layout properties (icon-size) where feature-state expressions
    // aren't allowed.
    const zoomScaleNumber = (base: number): unknown => {
      if (!zoomScaling) return base;
      const expr: unknown[] = ['interpolate', ['linear'], ['zoom']];
      for (const [z, k] of ZOOM_SCALE_STOPS) expr.push(z, base * k);
      return expr;
    };

    // Interpolate across zoom while preserving feature-state branches
    // at each stop. Used for circle-radius and icon-halo radius, where
    // hover/selected values share the same zoom curve.
    const zoomScaleState = (
      base: number,
      selectedValue: number,
      hoverValue: number,
    ): unknown => {
      if (!zoomScaling) return stateCase(base, selectedValue, hoverValue);
      const expr: unknown[] = ['interpolate', ['linear'], ['zoom']];
      for (const [z, k] of ZOOM_SCALE_STOPS) {
        expr.push(z, stateCase(base * k, selectedValue * k, hoverValue * k));
      }
      return expr;
    };

    // Polygon fill. Selection bumps opacity so picked polygons read as
    // highlighted even against a translucent base style.
    m.addLayer({
      id: `gg:${layer.id}-fill`,
      type: 'fill',
      source: sourceId,
      minzoom,
      maxzoom,
      filter: combineFilter(['==', ['geometry-type'], 'Polygon'], layer.filter),
      paint: {
        'fill-color': polyFill,
        'fill-opacity': stateCase(
          s.polygon.fillOpacity * op,
          Math.min(1, s.polygon.fillOpacity + 0.4) * op,
          Math.min(1, s.polygon.fillOpacity + 0.25) * op,
        ) as unknown as number,
      },
    });

    // Polygon outline (separate layer so paint rules stay simple).
    // Selected polygons get an accent color and a thicker outline so
    // the pick is obvious without repainting the fill.
    m.addLayer({
      id: `gg:${layer.id}-poly-line`,
      type: 'line',
      source: sourceId,
      minzoom,
      maxzoom,
      filter: combineFilter(['==', ['geometry-type'], 'Polygon'], layer.filter),
      paint: {
        'line-color': stateCase(
          polyStroke,
          SEL_ACCENT,
          polyStroke,
        ) as unknown as string,
        'line-width': stateCase(
          s.polygon.strokeWidth,
          s.polygon.strokeWidth + 2,
          s.polygon.strokeWidth + 1,
        ) as unknown as number,
        'line-opacity': op,
      },
    });

    // LineString geometries
    m.addLayer({
      id: `gg:${layer.id}-line`,
      type: 'line',
      source: sourceId,
      minzoom,
      maxzoom,
      filter: combineFilter(['==', ['geometry-type'], 'LineString'], layer.filter),
      paint: {
        'line-color': stateCase(
          lineColor,
          SEL_ACCENT,
          lineColor,
        ) as unknown as string,
        'line-width': stateCase(
          s.line.width,
          s.line.width + 2,
          s.line.width + 1,
        ) as unknown as number,
        'line-opacity': op,
      },
    });

    // Point geometries. When the layer's point style picks an icon
    // symbol, render a MapLibre symbol layer with the right image
    // variant. Two variants are registered per icon: a plain raster
    // (renders in the icon's shipped color) and an SDF copy (takes
    // the layer's fill via MapLibre's `icon-color` paint property).
    // We prefer the SDF when iconTint is on AND the SDF image is
    // registered; otherwise we fall back to the plain raster. If
    // even the plain image isn't registered yet, we fall through to
    // the circle renderer so the feature stays visible.
    const wantsIcon = s.point.symbol === 'icon' && !!s.point.iconName;
    const tint = s.point.iconTint !== false; // default true
    const sdfId = wantsIcon ? iconSdfImageId(s.point.iconName) : '';
    const plainId = wantsIcon ? iconImageId(s.point.iconName) : '';
    const useSdf = tint && wantsIcon && m.hasImage(sdfId);
    const preferredId = useSdf ? sdfId : plainId;
    const iconReady = wantsIcon && m.hasImage(preferredId);
    if (iconReady) {
      // Selection halo under the icon. Rendered as a separate circle
      // layer so it reads through whatever the symbol shows on top —
      // works for both SDF and plain icon variants.
      m.addLayer({
        id: `gg:${layer.id}-icon-halo`,
        type: 'circle',
        source: sourceId,
        minzoom,
        maxzoom,
        filter: combineFilter(['==', ['geometry-type'], 'Point'], layer.filter),
        paint: {
          'circle-color': 'rgba(37, 99, 235, 0.25)',
          'circle-radius': zoomScaleState(
            0,
            14 * s.point.iconSize,
            0,
          ) as unknown as number,
          'circle-stroke-color': SEL_ACCENT,
          'circle-stroke-width': stateCase(0, 2, 0) as unknown as number,
          'circle-opacity': op,
        },
      });
      m.addLayer({
        id: `gg:${layer.id}-circle`,
        type: 'symbol',
        source: sourceId,
        minzoom,
        maxzoom,
        filter: combineFilter(['==', ['geometry-type'], 'Point'], layer.filter),
        layout: {
          'icon-image': preferredId,
          // Zoom-interpolated size. Feature-state expressions aren't
          // allowed in layout properties, so the halo circle above
          // carries selected/hover — this property only tracks zoom.
          'icon-size': zoomScaleNumber(
            s.point.iconSize,
          ) as unknown as number,
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
          'icon-anchor': 'bottom',
        },
        paint: {
          'icon-opacity': op,
          // icon-color only takes effect when the image was registered
          // with sdf: true. For the plain variant this paint property
          // is silently ignored, so emitting it only matters when we
          // actually resolved to the SDF image.
          ...(useSdf ? { 'icon-color': pointFill } : {}),
        },
      });
    } else {
      m.addLayer({
        id: `gg:${layer.id}-circle`,
        type: 'circle',
        source: sourceId,
        minzoom,
        maxzoom,
        filter: combineFilter(['==', ['geometry-type'], 'Point'], layer.filter),
        paint: {
          'circle-color': pointFill,
          'circle-radius': zoomScaleState(
            s.point.radius,
            s.point.radius + 3,
            s.point.radius + 2,
          ) as unknown as number,
          'circle-stroke-color': stateCase(
            s.point.strokeColor,
            SEL_ACCENT,
            s.point.strokeColor,
          ) as unknown as string,
          'circle-stroke-width': stateCase(
            s.point.strokeWidth,
            s.point.strokeWidth + 2,
            s.point.strokeWidth,
          ) as unknown as number,
          'circle-opacity': op,
          'circle-stroke-opacity': op,
        },
      });
    }

    // Text labels. Only add the symbol layer when enabled + a non-
    // empty template is present; an empty text-field renders as blank
    // symbols and still incurs MapLibre's layout cost.
    const labels = layer.labels;
    if (labels?.enabled && labels.template) {
      const textExpr = templateToExpression(labels.template);
      const symbolLayer: maplibregl.SymbolLayerSpecification = {
        id: `gg:${layer.id}-label`,
        type: 'symbol',
        source: sourceId,
        minzoom: labelsMinzoom,
        maxzoom: labelsMaxzoom,
        layout: {
          'text-field': textExpr as unknown as maplibregl.DataDrivenPropertyValueSpecification<string>,
          'text-size': labels.size,
          'text-anchor': labels.anchor,
          'text-offset': [labels.offsetX, labels.offsetY],
          'text-allow-overlap': false,
          'text-ignore-placement': false,
          'text-padding': 2,
          'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'],
          'symbol-placement': labels.placement === 'line' ? 'line' : 'point',
        },
        paint: {
          'text-color': labels.color,
          'text-halo-color': labels.haloColor,
          'text-halo-width': labels.haloWidth,
          'text-opacity': op,
        },
      };
      if (layer.filter) {
        symbolLayer.filter = combineFilter(
          ['all'],
          layer.filter,
        ) as maplibregl.FilterSpecification;
      }
      m.addLayer(symbolLayer);
    }
  }
}

/**
 * Translate a Handlebars-lite template into a MapLibre text-field
 * expression. `"Pop: {{pop | number}}"` becomes
 * `['concat', 'Pop: ', <to-string get pop>]`; `"{{name}}"` becomes a
 * straight `to-string(get(name))`. Formatter pipes are honored
 * client-side at layout time by concatenating a formatted value into
 * the text; we keep the vocabulary aligned with popup formatters so
 * authors only have to learn one mental model.
 *
 * If the template has no tokens, the whole string renders as literal
 * text, which MapLibre accepts directly.
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

/**
 * Per-token MapLibre expression. Formatters that map cleanly to
 * MapLibre's expression language (upper/lower/number with locale
 * coercion) are inlined; formatters MapLibre can't express
 * (currency with a specific locale, date with a style) fall back to
 * plain to-string with a comment — the popup renderer still honors
 * them on click, this just means the *label* won't format them.
 */
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
    case 'number': {
      // MapLibre has `number-format`; we coerce to number first so
      // string-valued numerics still format.
      return [
        'number-format',
        ['to-number', ['get', field]],
        { 'min-fraction-digits': 0 },
      ];
    }
    default:
      return base;
  }
}

type MlFilter = maplibregl.FilterSpecification;

/**
 * Translate a single filter clause to a MapLibre expression, or return
 * null if the clause is incomplete / unfit for the chosen operator
 * (e.g. a numeric comparison whose value is not a valid number).
 */
function clauseToExpr(clause: MapLayerFilterClause): unknown[] | null {
  if (!clause.field) return null;
  const prop = ['get', clause.field];
  switch (clause.op) {
    case '==':
      return ['==', prop, clause.value];
    case '!=':
      return ['!=', prop, clause.value];
    case '>':
    case '>=':
    case '<':
    case '<=': {
      const n = Number(clause.value);
      if (Number.isNaN(n)) return null;
      return [clause.op, prop, n];
    }
    case 'contains':
      return ['>=', ['index-of', clause.value, ['to-string', prop]], 0];
    case 'is-null':
      return ['!', ['has', clause.field]];
    case 'is-not-null':
      return ['has', clause.field];
  }
}

/**
 * Combine the always-on geometry-type filter with any attribute clauses.
 * Clauses are joined via the user's chosen combinator (all == AND,
 * any == OR). Incomplete clauses (no field picked yet, or numeric
 * comparison with a non-numeric value) are silently dropped so the
 * map keeps rendering while the user is mid-edit.
 */
function combineFilter(
  geomFilter: unknown[],
  filter: MapLayerFilter | null,
): MlFilter {
  if (!filter || filter.clauses.length === 0) return geomFilter as MlFilter;
  const exprs = filter.clauses
    .map((c) => clauseToExpr(c))
    .filter((e): e is unknown[] => e !== null);
  if (exprs.length === 0) return geomFilter as MlFilter;
  const joined = [filter.combinator === 'any' ? 'any' : 'all', ...exprs];
  return (['all', geomFilter, joined] as unknown) as MlFilter;
}

/**
 * Build a MapLibre paint color for a given style slot, honoring the
 * layer's renderer. Simple renderer â†’ raw hex. Unique-values renderer
 * â†’ a `match` expression against the field, defaulting to the simple
 * color for anything unlisted.
 *
 * Returns `any` because MapLibre paint values are typed as massive
 * unions; TS check isn't losing much here and gains a lot of
 * readability.
 */
// Return type is MapLibre's DataDrivenPropertyValueSpecification<string>
// in practice, but that union is huge. Use `any` at this boundary to
// keep the call sites clean; the runtime shape is exactly what the
// paint-property validator expects.
function rendererColor(
  layer: MapLayer,
  fallback: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): any {
  const r = layer.renderer;
  if (r.kind === 'simple') return fallback;

  if (r.kind === 'unique-values') {
    if (r.categories.length === 0 || !r.field) return fallback;
    const matchExpr: unknown[] = ['match', ['to-string', ['get', r.field]]];
    for (const cat of r.categories) {
      matchExpr.push(cat.value, cat.color);
    }
    matchExpr.push(fallback); // default
    return matchExpr;
  }

  // class-breaks. MapLibre `step(input, out0, stop1, out1, stop2, out2, ...)`
  // returns out0 when input < stop1, out1 when stop1 <= input < stop2, etc.
  // We need one more color than stops; fall back to the simple color if
  // the editor hasn't finished wiring this up.
  if (r.kind === 'class-breaks') {
    if (!r.field || r.stops.length === 0 || r.colors.length !== r.stops.length + 1) {
      return fallback;
    }
    const input = ['to-number', ['get', r.field]];
    const stepExpr: unknown[] = ['step', input, r.colors[0]];
    for (let i = 0; i < r.stops.length; i += 1) {
      stepExpr.push(r.stops[i]);
      stepExpr.push(r.colors[i + 1]);
    }
    return stepExpr;
  }

  return fallback;
}

/**
 * Resolve a layer source into something MapLibre can chew on:
 *   - `geojson-url` returns the URL as-is.
 *   - `geojson-inline` returns the inline collection as-is.
 *   - `feature-service` returns the portal API URL that serves the
 *     referenced item; an upstream cookie-bearing request resolves to
 *     the GeoJSON inside the item's dataJson.
 *
 * Returning a URL for feature-service means MapLibre handles the fetch
 * (and its own cache / cancellation). The API route passes through
 * our auth, so no credentials juggling client-side.
 */
function sourceData(layer: MapLayer): GeoJSON.FeatureCollection | string | null {
  if (layer.source.kind === 'geojson-url') return layer.source.url;
  if (layer.source.kind === 'geojson-inline') {
    return layer.source.geojson as GeoJSON.FeatureCollection;
  }
  if (layer.source.kind === 'data-layer') {
    // The server-side API endpoint emits the GeoJSON directly; see
    // apps/portal-api/src/items/items.controller.ts `@Get(':id/geojson')`.
    return `/api/portal/items/${layer.source.itemId}/geojson`;
  }
  if (layer.source.kind === 'arcgis-rest') {
    // Start with an empty collection. The camera-driven refetch
    // effect below calls setData once the initial viewport query
    // resolves; this keeps syncOverlays synchronous (no awaits in
    // the hot path) and lets MapLibre add the source immediately
    // so downstream paint / hover / click layers attach.
    return { type: 'FeatureCollection', features: [] };
  }
  return null;
}

/**
 * Build popup HTML from a feature's properties. Honors popup.fields
 * (order + subset) when non-empty; otherwise shows everything.
 * Renders as a definition list for screen readers.
 *
 * Values are HTML-escaped because they're user-provided data.
 */
function renderPopupHtml(
  layer: MapLayer,
  props: Record<string, unknown>,
): string {
  const title = layer.popup.titleTemplate
    ? renderTemplate(layer.popup.titleTemplate, props)
    : layer.title;

  // Body shape depends on mode. Template mode passes through author
  // markup with values HTML-escaped; picked / all render as a
  // definition list so unstyled layers still look decent.
  let body: string;
  if (layer.popup.mode === 'template' && layer.popup.bodyTemplate) {
    body = `<div class="gg-popup-body">${renderTemplate(
      layer.popup.bodyTemplate,
      props,
    )}</div>`;
  } else {
    const keys =
      layer.popup.mode === 'picked'
        ? layer.popup.fields
        : Object.keys(props).sort();
    const rows = keys
      .map((k) => {
        const v = props[k];
        if (v === null || v === undefined || v === '') return '';
        return `
          <div class="gg-popup-row">
            <dt>${escapeHtml(k)}</dt>
            <dd>${escapeHtml(String(v))}</dd>
          </div>
        `;
      })
      .filter(Boolean)
      .join('');
    body = `<dl>${rows || '<div class="gg-popup-empty">No properties</div>'}</dl>`;
  }

  return `
    <div class="gg-popup">
      <div class="gg-popup-title">${escapeHtml(title)}</div>
      ${body}
    </div>
  `;
}

/**
 * Handlebars-lite interpolation.
 *
 *   {{field}}               â†’ raw value
 *   {{field | upper}}       â†’ uppercased
 *   {{field | lower}}       â†’ lowercased
 *   {{price | number}}      â†’ locale-formatted number
 *   {{price | currency}}    â†’ locale currency (user's default)
 *   {{date | date}}         â†’ locale-formatted date/time
 *   {{date | date:short}}   â†’ short date
 *
 * Template literals are rendered as HTML so authors can use small
 * markup (`<br>`, `<strong>`). Values are always HTML-escaped, so a
 * property containing `<script>` can't inject behavior.
 */
function renderTemplate(template: string, props: Record<string, unknown>): string {
  return template.replace(
    /\{\{\s*([\w.-]+)\s*(?:\|\s*([\w.-]+)(?:\s*:\s*([^}]+))?\s*)?\}\}/g,
    (_, key: string, formatter?: string, arg?: string) => {
      const raw = props[key];
      if (raw === undefined || raw === null) return '';
      const formatted = applyFormatter(raw, formatter, arg);
      return escapeHtml(formatted);
    },
  );
}

function applyFormatter(
  raw: unknown,
  formatter: string | undefined,
  arg: string | undefined,
): string {
  const str = String(raw);
  if (!formatter) return str;
  switch (formatter.toLowerCase()) {
    case 'upper':
      return str.toUpperCase();
    case 'lower':
      return str.toLowerCase();
    case 'number': {
      const n = Number(str);
      if (Number.isNaN(n)) return str;
      return n.toLocaleString();
    }
    case 'currency': {
      const n = Number(str);
      if (Number.isNaN(n)) return str;
      const currency = arg?.trim() || 'USD';
      try {
        return n.toLocaleString(undefined, { style: 'currency', currency });
      } catch {
        return n.toLocaleString();
      }
    }
    case 'date': {
      const d = new Date(str);
      if (Number.isNaN(d.getTime())) return str;
      const style = (arg?.trim() as 'short' | 'long' | 'full' | undefined) ?? 'medium';
      try {
        return d.toLocaleDateString(undefined, { dateStyle: style });
      } catch {
        return d.toLocaleDateString();
      }
    }
    default:
      return str;
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
