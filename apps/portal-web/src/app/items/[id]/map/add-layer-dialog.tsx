'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ClipboardPaste,
  Database,
  Globe,
  Layers,
  Link2,
  Loader2,
  Search,
  Sparkles,
  Upload,
  X,
} from 'lucide-react';
import type { Item, MapLayer, MapLayerSource } from '@gratis-gis/shared-types';
import {
  DEFAULT_LAYER_ACCESS,
  DEFAULT_LAYER_LABELS,
  DEFAULT_LAYER_SCALE,
  DEFAULT_LAYER_SEARCH,
  DEFAULT_LAYER_STYLE,
  DEFAULT_LAYER_POPUP,
  DEFAULT_LAYER_INTERACTIONS,
  DEFAULT_LAYER_RENDERER,
} from '@gratis-gis/shared-types';
import { CURATED_SOURCES, type CuratedSource } from './curated-sources';
import { fileToGeoJson } from './kml-convert';
import {
  probeService,
  type ArcgisServiceDescription,
  type ArcgisServiceLayer,
} from '@/lib/arcgis-rest';

interface Props {
  open: boolean;
  onClose: () => void;
  onAdd: (layer: MapLayer) => void;
}

type Tab = 'url' | 'paste' | 'file' | 'portal' | 'curated' | 'arcgis';

/**
 * Four-tab layer catalog:
 *   1. URL: paste a GeoJSON URL and go.
 *   2. Paste: drop inline GeoJSON for tiny datasets.
 *   3. Portal: data_layer items from this portal.
 *   4. Curated: hand-picked, well-maintained public datasets.
 *
 * The dialog itself stays stateless about which source wins: it builds a
 * MapLayer and fires onAdd, the parent decides what to do with it.
 */
export function AddLayerDialog({ open, onClose, onAdd }: Props) {
  const [tab, setTab] = useState<Tab>('portal');
  const [title, setTitle] = useState('');
  const [url, setUrl] = useState('');
  const [paste, setPaste] = useState('');
  const [fileBusy, setFileBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Portal tab state: list of data_layer items + search query.
  const [portalQ, setPortalQ] = useState('');
  const [portalItems, setPortalItems] = useState<Item[]>([]);
  const [portalLoading, setPortalLoading] = useState(false);
  // When the user picks an arcgis_service item that exposes more than
  // one sublayer, we surface this follow-up prompt: pick which of
  // the available sublayers to add (#45) and whether to bundle them
  // under a group header. Carries the resolved, ordered sublayer
  // list so the modal can render checkboxes without re-deriving.
  const [pendingSublayerChoice, setPendingSublayerChoice] = useState<{
    item: Item;
    sublayers: Array<{ id: number; name?: string; geometryType?: string }>;
  } | null>(null);

  // Curated tab state: search narrows the curated list.
  const [curatedQ, setCuratedQ] = useState('');

  // ArcGIS REST tab state: url, probe result, picked layer.
  const [arcgisUrl, setArcgisUrl] = useState('');
  const [arcgisProbing, setArcgisProbing] = useState(false);
  const [arcgisService, setArcgisService] =
    useState<ArcgisServiceDescription | null>(null);
  const [arcgisLayerId, setArcgisLayerId] = useState<number | null>(null);
  const arcgisAbortRef = useRef<AbortController | null>(null);

  const reset = useCallback(() => {
    setTab('portal');
    setTitle('');
    setUrl('');
    setPaste('');
    setPortalQ('');
    setCuratedQ('');
    setArcgisUrl('');
    setArcgisProbing(false);
    setArcgisService(null);
    setArcgisLayerId(null);
    arcgisAbortRef.current?.abort();
    arcgisAbortRef.current = null;
    setError(null);
    setPendingSublayerChoice(null);
  }, []);

  // Load portal items when the portal tab activates or the query
  // changes. One fetch (?type=data_layer,arcgis_service&lite=1)
  // covers both supported types; lite mode strips the heavy data
  // JSONB from each row so the wire payload is small and the
  // backend skips serialising hundreds of KB of layer metadata
  // per arcgis_service. The badge count comes from the derived
  // `_subLayerCount` field the server attaches in lite mode. Full
  // `data` is fetched lazily when the user clicks an item below.
  //
  // The fetch wires through an AbortController so when the user
  // navigates away mid-load (or types another character) the
  // cleanup aborts the in-flight request all the way to the
  // server. Without this, leaving a slow fetch alive holds a
  // Prisma connection on the API side and serialises the next
  // visit's request behind it - which is the most likely cause
  // of "first time fast, second time 30s" on dialog re-open.
  useEffect(() => {
    if (!open || tab !== 'portal') return;
    let cancelled = false;
    const controller = new AbortController();
    setPortalLoading(true);
    const handle = setTimeout(async () => {
      const t0 = performance.now();
      try {
        const q = portalQ.trim();
        const qs = new URLSearchParams({
          type: 'data_layer,arcgis_service',
          lite: '1',
        });
        if (q) qs.set('q', q);
        const res = await fetch(`/api/portal/items?${qs}`, {
          signal: controller.signal,
        });
        if (!res.ok) {
          // eslint-disable-next-line no-console
          console.warn('[portal] fetch failed:', res.status);
          if (!cancelled) setPortalItems([]);
          return;
        }
        const items = (await res.json()) as Item[];
        if (cancelled) return;
        items.sort((a, b) => {
          const at = new Date(a.updatedAt ?? 0).getTime();
          const bt = new Date(b.updatedAt ?? 0).getTime();
          return bt - at;
        });
        setPortalItems(items);
        // eslint-disable-next-line no-console
        console.log(
          `[portal] loaded ${items.length} items in ${Math.round(performance.now() - t0)}ms`,
        );
      } catch (err) {
        if ((err as Error)?.name === 'AbortError') return;
        // eslint-disable-next-line no-console
        console.warn('[portal] fetch error:', err);
      } finally {
        if (!cancelled) setPortalLoading(false);
      }
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(handle);
      controller.abort();
    };
  }, [open, tab, portalQ]);

  const filteredCurated = useMemo(() => {
    const q = curatedQ.trim().toLowerCase();
    if (!q) return CURATED_SOURCES;
    return CURATED_SOURCES.filter(
      (s) =>
        s.title.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q) ||
        s.tags.some((t) => t.toLowerCase().includes(q)),
    );
  }, [curatedQ]);

  function makeLayer(title: string, source: MapLayerSource): MapLayer {
    return {
      id: crypto.randomUUID(),
      title,
      visible: true,
      opacity: 1,
      source,
      style: structuredClone(DEFAULT_LAYER_STYLE),
      renderer: structuredClone(DEFAULT_LAYER_RENDERER),
      popup: structuredClone(DEFAULT_LAYER_POPUP),
      interactions: structuredClone(DEFAULT_LAYER_INTERACTIONS),
      labels: structuredClone(DEFAULT_LAYER_LABELS),
      search: structuredClone(DEFAULT_LAYER_SEARCH),
      scale: structuredClone(DEFAULT_LAYER_SCALE),
      access: structuredClone(DEFAULT_LAYER_ACCESS),
      filter: null,
    };
  }

  async function runArcgisProbe(raw: string) {
    setError(null);
    if (!raw.trim()) {
      setError('Paste an ArcGIS MapServer or FeatureServer URL.');
      return;
    }
    arcgisAbortRef.current?.abort();
    const controller = new AbortController();
    arcgisAbortRef.current = controller;
    setArcgisProbing(true);
    setArcgisService(null);
    setArcgisLayerId(null);
    try {
      const desc = await probeService(raw.trim(), controller.signal);
      if (controller.signal.aborted) return;
      setArcgisService(desc);
      // Auto-pick the first polygon/line/point layer (skip tables when
      // something else is available); or the first layer at all.
      const pick =
        desc.layers.find((l) => l.geometryType) ?? desc.layers[0] ?? null;
      setArcgisLayerId(pick?.id ?? null);
      if (!title.trim()) {
        setTitle(pick?.name ?? desc.name);
      }
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') return;
      setError(
        (err as Error).message ||
          'Could not read that service. Check the URL and CORS config.',
      );
    } finally {
      if (!controller.signal.aborted) setArcgisProbing(false);
    }
  }

  function submitArcgis() {
    setError(null);
    if (!arcgisService) {
      setError('Probe the service first so we know which layers it offers.');
      return;
    }
    if (arcgisLayerId == null) {
      setError('Pick a layer from the service.');
      return;
    }
    if (!title.trim()) {
      setError('Give the layer a name so it shows up in the list.');
      return;
    }
    onAdd(
      makeLayer(title.trim(), {
        kind: 'arcgis-rest',
        url: arcgisService.url,
        layerId: arcgisLayerId,
        serviceType: arcgisService.serviceType,
      }),
    );
    reset();
    onClose();
  }

  function submitUrlOrPaste() {
    setError(null);
    if (!title.trim()) {
      setError('Give the layer a name so it shows up in the list.');
      return;
    }
    let source: MapLayerSource;
    if (tab === 'url') {
      if (!url.trim()) {
        setError('Paste a GeoJSON URL.');
        return;
      }
      source = { kind: 'geojson-url', url: url.trim() };
    } else {
      let parsed: unknown;
      try {
        parsed = JSON.parse(paste);
      } catch {
        setError('That is not valid JSON. Check for a missing brace or quote.');
        return;
      }
      if (
        !parsed ||
        typeof parsed !== 'object' ||
        (parsed as { type?: string }).type !== 'FeatureCollection'
      ) {
        setError('Paste a GeoJSON FeatureCollection (not a bare Feature or geometry).');
        return;
      }
      source = { kind: 'geojson-inline', geojson: parsed };
    }
    onAdd(makeLayer(title.trim(), source));
    reset();
    onClose();
  }

  /**
   * Adds the selected portal item's layer(s) to the map. For
   * arcgis_service items with more than one sublayer, this defers
   * to a follow-up inline modal to decide group vs flat; otherwise
   * it commits immediately. Splitting the function lets the inline
   * modal call back in with the chosen mode without re-running any
   * of the lookup logic.
   *
   * The list is fetched in lite mode (#52) so the row's `data` is
   * absent. We hydrate the full item here on click so all the
   * downstream logic (URL, sublayer ordering, label overrides)
   * keeps reading from `item.data` without caring how the list
   * arrived. data_layer items don't need `data` at all (they pass
   * just `itemId` to the layer source) so they skip the hydrate.
   */
  async function submitPortalItem(item: Item) {
    if (item.type !== 'arcgis_service') {
      onAdd(makeLayer(item.title, { kind: 'data-layer', itemId: item.id }));
      reset();
      onClose();
      return;
    }
    const hydrated = await hydratePortalItem(item);
    if (hydrated === null) return; // setError already fired
    const ordered = orderedSublayersForPortalItem(hydrated);
    if (ordered === null) return;
    if (ordered.length > 1) {
      // Defer the actual add to the inline modal. The modal lets the
      // user pick a subset (#45) and choose group vs flat, then calls
      // addArcgisPortalItem against the hydrated copy without a re-
      // fetch.
      setPendingSublayerChoice({ item: hydrated, sublayers: ordered });
      return;
    }
    addArcgisPortalItem(
      hydrated,
      'flat',
      new Set(ordered.map((l) => l.id)),
    );
  }

  /**
   * Hydrate a lite-mode portal item by fetching its full record
   * (including `data`) by id. Returns the hydrated item, or null
   * if the fetch failed (setError populated). Items already
   * carrying `data` (e.g. from a non-lite caller) short-circuit.
   */
  async function hydratePortalItem(item: Item): Promise<Item | null> {
    if (item.data && Object.keys(item.data as object).length > 0) {
      return item;
    }
    try {
      const res = await fetch(`/api/portal/items/${item.id}`);
      if (!res.ok) {
        setError(`Could not load ${item.title} (HTTP ${res.status}).`);
        return null;
      }
      return (await res.json()) as Item;
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : `Could not load ${item.title}.`,
      );
      return null;
    }
  }

  /**
   * Pull the curated, ordered sublayer list out of an arcgis_service
   * item's data blob. Returns null if the item is missing a URL or
   * has no curated layers selected; in those cases setError has
   * already populated the right message for the dialog footer.
   */
  function orderedSublayersForPortalItem(
    item: Item,
  ): Array<{ id: number; name?: string; geometryType?: string }> | null {
    const d = (item.data ?? {}) as {
      url?: string;
      defaultLayerId?: number;
      selectedLayerIds?: Array<string | number>;
      layers?: Array<{ id: number; name?: string; geometryType?: string }>;
    };
    if (!d.url) {
      setError(`${item.title} has no service URL yet. Open it and paste one.`);
      return null;
    }
    const allLayers = d.layers ?? [];
    const curated = d.selectedLayerIds
      ? allLayers.filter((l) =>
          d.selectedLayerIds!.map(String).includes(String(l.id)),
        )
      : allLayers;
    if (curated.length === 0) {
      setError(
        `${item.title} has no layers selected for web-map use. Open the item and pick at least one layer.`,
      );
      return null;
    }
    return [
      ...curated.filter((l) => l.id === d.defaultLayerId),
      ...curated.filter((l) => l.id !== d.defaultLayerId),
    ];
  }

  /**
   * Commit an arcgis_service item to the layer panel using the
   * caller's chosen group / flat mode and selected sublayer subset
   * (#45). Group mode emits a parent header layer (kind=group)
   * followed by N children whose groupId references it; flat mode
   * emits N independent siblings. `selectedIds` lets the user opt
   * out of layers they don't want -- a common case when an ArcGIS
   * service exposes a giant catalog and the map only needs one or
   * two of them. Empty selection is treated as "no-op" (cancel-
   * equivalent) so the user doesn't end up with a stray group
   * header and no children.
   */
  function addArcgisPortalItem(
    item: Item,
    mode: 'group' | 'flat',
    selectedIds: Set<number>,
  ) {
    const d = (item.data ?? {}) as {
      url?: string;
      serviceType?: 'MapServer' | 'FeatureServer';
      defaultLayerId?: number;
      selectedLayerIds?: Array<string | number>;
      layerConfig?: Record<string, { label?: string; visible?: boolean }>;
      layers?: Array<{ id: number; name?: string; geometryType?: string }>;
    };
    const ordered = orderedSublayersForPortalItem(item);
    if (ordered === null) return;
    const picked = ordered.filter((l) => selectedIds.has(l.id));
    if (picked.length === 0) {
      // No-op: every sublayer was unchecked. Reset and close so the
      // user lands back at the dialog instead of staring at a half-
      // committed group with nothing inside it.
      reset();
      onClose();
      return;
    }
    let groupId: string | undefined;
    if (mode === 'group' && picked.length > 1) {
      const header = makeLayer(item.title, { kind: 'group' });
      groupId = header.id;
      onAdd(header);
    }
    for (const l of picked) {
      const override = d.layerConfig?.[String(l.id)];
      const subName = l.name ?? `Layer ${l.id}`;
      const title =
        override?.label ?? (picked.length === 1 ? item.title : subName);
      const layer = makeLayer(title, {
        kind: 'arcgis-rest',
        url: d.url!,
        layerId: l.id,
        serviceType: d.serviceType ?? 'MapServer',
        sourceItemId: item.id,
      });
      if (groupId) layer.groupId = groupId;
      onAdd(layer);
    }
    reset();
    onClose();
  }

  /**
   * File-upload handler for GeoJSON / KML / KMZ. Reads the file entirely
   * in-browser, converts to a GeoJSON FeatureCollection, and stores it
   * inline on the new layer. Inline is fine up to a few hundred KB;
   * larger datasets should be brought in through the feature-service
   * pillar once that stores data server-side.
   */
  async function submitFile(file: File) {
    setError(null);
    setFileBusy(true);
    try {
      const lname = file.name.toLowerCase();
      let geojson: GeoJSON.FeatureCollection;
      if (lname.endsWith('.geojson') || lname.endsWith('.json')) {
        const text = await file.text();
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          setError('That file is not valid JSON.');
          return;
        }
        if (
          !parsed ||
          typeof parsed !== 'object' ||
          (parsed as { type?: string }).type !== 'FeatureCollection'
        ) {
          setError('Top-level object must be a GeoJSON FeatureCollection.');
          return;
        }
        geojson = parsed as GeoJSON.FeatureCollection;
      } else {
        geojson = await fileToGeoJson(file);
      }
      const derivedTitle =
        title.trim() || file.name.replace(/\.[^.]+$/, '');
      onAdd(
        makeLayer(derivedTitle, {
          kind: 'geojson-inline',
          geojson,
        }),
      );
      reset();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to read file.');
    } finally {
      setFileBusy(false);
    }
  }

  function submitCurated(src: CuratedSource) {
    onAdd(
      makeLayer(src.title, { kind: 'geojson-url', url: src.url }),
    );
    reset();
    onClose();
  }

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Add layer"
      className="fixed inset-0 z-30 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-lg border border-border bg-surface-1 shadow-overlay"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="text-base font-semibold">Add layer</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted hover:bg-surface-2"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

<div className="flex gap-0 border-b border-border px-2 pt-2">
          {/* Portal first: content inside this org's catalog is the
              most common "add a layer" path once maps exist. Curated
              sources come next as the guided-browse option. File /
              Paste / URL are progressively more manual. */}
          <TabButton
            Icon={Database}
            label="Portal"
            active={tab === 'portal'}
            onClick={() => setTab('portal')}
          />
          <TabButton
            Icon={Globe}
            label="Curated"
            active={tab === 'curated'}
            onClick={() => setTab('curated')}
          />
          <TabButton
            Icon={Upload}
            label="File"
            active={tab === 'file'}
            onClick={() => setTab('file')}
          />
          <TabButton
            Icon={ClipboardPaste}
            label="Paste"
            active={tab === 'paste'}
            onClick={() => setTab('paste')}
          />
          <TabButton
            Icon={Link2}
            label="URL"
            active={tab === 'url'}
            onClick={() => setTab('url')}
          />
          <TabButton
            Icon={Layers}
            label="ArcGIS"
            active={tab === 'arcgis'}
            onClick={() => setTab('arcgis')}
          />
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-4">
          {(tab === 'url' || tab === 'paste') && (
            <div className="space-y-4">
              <div>
                <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted">
                  Name
                </label>
                <input
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Parcels, roads, observations..."
                  maxLength={200}
                  className="h-9 w-full rounded-md border border-border bg-surface-1 px-3 text-sm focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
                />
              </div>
              {tab === 'url' ? (
                <div>
                  <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted">
                    GeoJSON URL
                  </label>
                  <input
                    type="url"
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    placeholder="https://example.org/parcels.geojson"
                    className="h-9 w-full rounded-md border border-border bg-surface-1 px-3 text-sm focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
                  />
                  <p className="mt-1 text-xs text-muted">
                    Must be reachable from a browser (CORS-enabled) and return
                    a GeoJSON FeatureCollection.
                  </p>
                </div>
              ) : (
                <div>
                  <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted">
                    GeoJSON
                  </label>
                  <textarea
                    value={paste}
                    onChange={(e) => setPaste(e.target.value)}
                    placeholder='{"type":"FeatureCollection","features":[...]}'
                    rows={10}
                    className="w-full rounded-md border border-border bg-surface-0 px-3 py-2 font-mono text-xs focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
                  />
                  <p className="mt-1 text-xs text-muted">
                    Small datasets only. Inline features are stored in the item
                    itself; for anything over a few hundred rows use a URL.
                  </p>
                </div>
              )}
            </div>
          )}

          {tab === 'file' && (
            <div className="space-y-3">
              <div>
                <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted">
                  Name
                </label>
                <input
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Optional. Defaults to the filename."
                  maxLength={200}
                  className="h-9 w-full rounded-md border border-border bg-surface-1 px-3 text-sm focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
                />
              </div>
              <FileDropZone
                busy={fileBusy}
                onFile={submitFile}
                accept=".kml,.kmz,.geojson,.json,.zip,application/vnd.google-earth.kml+xml,application/vnd.google-earth.kmz,application/geo+json,application/json,application/zip"
              />
              <p className="text-[11px] text-muted">
                Accepts GeoJSON, KML, KMZ, and zipped Shapefiles. Files are
                parsed in your browser and stored inline on the layer;
                keep them under a few hundred KB. For larger datasets,
                ingest as a feature service instead.
              </p>
            </div>
          )}

          {tab === 'portal' && (
            <div className="space-y-3">
              <label className="relative block">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
                <input
                  type="text"
                  value={portalQ}
                  onChange={(e) => setPortalQ(e.target.value)}
                  placeholder="Search feature & ArcGIS services..."
                  className="h-9 w-full rounded-md border border-border bg-surface-1 pl-9 pr-3 text-sm focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
                />
              </label>
              {portalLoading ? (
                <div className="flex items-center justify-center gap-2 rounded-md border border-border bg-surface-2 px-4 py-6 text-sm text-muted">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Loading services from your portal...
                </div>
              ) : portalItems.length === 0 ? (
                <div className="rounded-md border border-border bg-surface-2 p-4 text-center text-xs text-muted">
                  <Sparkles className="mx-auto mb-2 h-5 w-5" />
                  No services match. Upload vector data as a feature
                  service, or save an ArcGIS REST URL as an ArcGIS
                  service item to pick it here.
                </div>
              ) : (
                <ul className="divide-y divide-border overflow-hidden rounded-md border border-border bg-surface-1">
                  {portalItems.map((item) => {
                    // The list is fetched in lite mode (#52) so
                    // `data` is omitted from the row payload; the
                    // server attaches a derived `_subLayerCount` for
                    // arcgis_service rows. Fall back to the legacy
                    // `data`-derived count if a non-lite caller ever
                    // re-uses this same list component.
                    let sublayerCount = 0;
                    if (item.type === 'arcgis_service') {
                      const fromLite = (item as Item & {
                        _subLayerCount?: number;
                      })._subLayerCount;
                      if (typeof fromLite === 'number') {
                        sublayerCount = fromLite;
                      } else {
                        const d = (item.data ?? {}) as {
                          selectedLayerIds?: Array<string | number>;
                          layers?: Array<unknown>;
                        };
                        sublayerCount = d.selectedLayerIds
                          ? d.selectedLayerIds.length
                          : Array.isArray(d.layers)
                            ? d.layers.length
                            : 0;
                      }
                    }
                    return (
                    <li key={item.id}>
                      <button
                        type="button"
                        onClick={() => submitPortalItem(item)}
                        className="flex w-full flex-col items-start gap-1 px-3 py-2.5 text-left transition-colors hover:bg-surface-2"
                      >
                        <div className="flex w-full items-center gap-2">
                          <div className="min-w-0 flex-1 truncate text-sm font-medium text-ink-0">
                            {item.title}
                          </div>
                          {sublayerCount > 1 ? (
                            <span
                              className="shrink-0 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-800"
                              title={`This service exposes ${sublayerCount} sublayers; clicking adds them all.`}
                            >
                              +{sublayerCount} layers
                            </span>
                          ) : null}
                          <span
                            className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${
                              item.type === 'arcgis_service'
                                ? 'bg-cyan-100 text-cyan-800'
                                : 'bg-sky-100 text-sky-800'
                            }`}
                          >
                            {item.type === 'arcgis_service'
                              ? 'ArcGIS'
                              : 'Feature'}
                          </span>
                        </div>
                        {item.description ? (
                          <div className="line-clamp-1 text-xs text-muted">
                            {item.description}
                          </div>
                        ) : null}
                      </button>
                    </li>
                    );
                  })}
                </ul>
              )}
              <p className="text-[11px] text-muted">
                Feature services stream from PostGIS; ArcGIS services
                query the origin live as you pan and zoom.
              </p>
            </div>
          )}

          {tab === 'curated' && (
            <div className="space-y-3">
              <label className="relative block">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
                <input
                  type="text"
                  value={curatedQ}
                  onChange={(e) => setCuratedQ(e.target.value)}
                  placeholder="Search curated datasets..."
                  className="h-9 w-full rounded-md border border-border bg-surface-1 pl-9 pr-3 text-sm focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
                />
              </label>
              <ul className="divide-y divide-border overflow-hidden rounded-md border border-border bg-surface-1">
                {filteredCurated.map((src) => (
                  <li key={src.url}>
                    <button
                      type="button"
                      onClick={() => submitCurated(src)}
                      className="flex w-full flex-col items-start gap-1 px-3 py-2.5 text-left transition-colors hover:bg-surface-2"
                    >
                      <div className="flex w-full items-center justify-between gap-3">
                        <span className="truncate text-sm font-medium text-ink-0">
                          {src.title}
                        </span>
                        <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted">
                          {src.category}
                        </span>
                      </div>
                      <div className="line-clamp-2 text-xs text-muted">
                        {src.description}
                      </div>
                      <div className="mt-1 flex flex-wrap gap-1">
                        {src.tags.map((t) => (
                          <span
                            key={t}
                            className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] text-muted"
                          >
                            {t}
                          </span>
                        ))}
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
              {filteredCurated.length === 0 ? (
                <p className="text-xs text-muted">No datasets match.</p>
              ) : null}
              <p className="text-[11px] text-muted">
                Links point to public, permissively-licensed data. Attribution
                is the responsibility of the map author.
              </p>
            </div>
          )}

          {tab === 'arcgis' && (
            <div className="space-y-4">
              <div>
                <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted">
                  Name
                </label>
                <input
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Assessor parcels, roads, ..."
                  maxLength={200}
                  className="h-9 w-full rounded-md border border-border bg-surface-1 px-3 text-sm focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted">
                  ArcGIS REST URL
                </label>
                <div className="flex gap-2">
                  <input
                    type="url"
                    value={arcgisUrl}
                    onChange={(e) => setArcgisUrl(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        void runArcgisProbe(arcgisUrl);
                      }
                    }}
                    placeholder="https://host/arcgis/rest/services/OpenData/Assessor/MapServer"
                    className="h-9 min-w-0 flex-1 rounded-md border border-border bg-surface-1 px-3 text-sm focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
                  />
                  <button
                    type="button"
                    onClick={() => void runArcgisProbe(arcgisUrl)}
                    disabled={arcgisProbing || !arcgisUrl.trim()}
                    className="inline-flex h-9 items-center gap-1 rounded-md border border-border bg-surface-1 px-3 text-xs font-medium text-ink-1 hover:bg-surface-2 disabled:opacity-50"
                  >
                    {arcgisProbing ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : null}
                    Probe
                  </button>
                </div>
                <p className="mt-1 text-xs text-muted">
                  Paste the service root (<code>.../MapServer</code> or
                  <code> .../FeatureServer</code>) or a specific layer URL
                  (<code>.../MapServer/0</code>). The viewer will query
                  features live by bbox as you pan and zoom.
                </p>
              </div>

              {arcgisService ? (
                <div className="rounded-md border border-border bg-surface-1 p-3">
                  <div className="mb-2 flex items-baseline justify-between gap-3">
                    <div>
                      <div className="text-sm font-medium">
                        {arcgisService.name}
                      </div>
                      <div className="text-[11px] text-muted">
                        {arcgisService.serviceType} • {arcgisService.layers.length}{' '}
                        layer{arcgisService.layers.length === 1 ? '' : 's'}
                      </div>
                    </div>
                  </div>
                  {arcgisService.description ? (
                    <p className="mb-2 line-clamp-3 text-xs text-muted">
                      {arcgisService.description}
                    </p>
                  ) : null}
                  <label className="mb-1 block text-[10px] uppercase tracking-wide text-muted">
                    Pick a layer
                  </label>
                  <ArcgisLayerPicker
                    layers={arcgisService.layers}
                    value={arcgisLayerId}
                    onChange={(id) => {
                      setArcgisLayerId(id);
                      const l = arcgisService.layers.find((x) => x.id === id);
                      if (l && (!title.trim() || arcgisService.layers.find((x) => x.name === title))) {
                        setTitle(l.name);
                      }
                    }}
                  />
                </div>
              ) : null}
              <p className="text-[11px] text-muted">
                The service must allow cross-origin requests from this
                portal. Paginated fetches cap at ~5000 features per
                viewport: zoom in for denser layers, or pull the data
                to a local copy from the layer&apos;s item page (coming
                next).
              </p>
            </div>
          )}

          {error ? (
            <p role="alert" className="mt-3 text-sm text-danger">
              {error}
            </p>
          ) : null}
        </div>

        {(tab === 'url' || tab === 'paste' || tab === 'arcgis') && (
          <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-3">
            <button
              type="button"
              onClick={onClose}
              className="h-9 rounded-md border border-border bg-surface-1 px-3 text-sm text-ink-1 hover:bg-surface-2"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={tab === 'arcgis' ? submitArcgis : submitUrlOrPaste}
              className="h-9 rounded-md bg-accent px-3 text-sm font-medium text-accent-foreground shadow-card hover:opacity-90 disabled:opacity-50"
              disabled={
                tab === 'arcgis' &&
                (!arcgisService || arcgisLayerId == null || arcgisProbing)
              }
            >
              Add layer
            </button>
          </div>
        )}
      </div>
      {pendingSublayerChoice ? (
        <SublayerChoiceModal
          item={pendingSublayerChoice.item}
          sublayers={pendingSublayerChoice.sublayers}
          onPick={(mode, selectedIds) => {
            const item = pendingSublayerChoice.item;
            setPendingSublayerChoice(null);
            addArcgisPortalItem(item, mode, selectedIds);
          }}
          onCancel={() => setPendingSublayerChoice(null)}
        />
      ) : null}
    </div>
  );
}

/**
 * Inline follow-up dialog shown after the user picks an
 * arcgis_service item that exposes more than one sublayer. Lets
 * the user (#45) pick which sublayers to include via checkboxes,
 * and (#46) choose whether to bundle them under a group header
 * or add as separate top-level layers.
 *
 * Defaults: every sublayer checked, "Add as a group" highlighted.
 * The modal sits above the parent Add Layer dialog; we intercept
 * the backdrop click so it closes only the modal, not both.
 */
function SublayerChoiceModal({
  item,
  sublayers,
  onPick,
  onCancel,
}: {
  item: Item;
  sublayers: Array<{ id: number; name?: string; geometryType?: string }>;
  onPick: (mode: 'group' | 'flat', selectedIds: Set<number>) => void;
  onCancel: () => void;
}) {
  // All sublayers selected by default -- the most common case is
  // "give me everything, like the old behaviour." Users who want to
  // narrow can untick before clicking Add.
  const [selected, setSelected] = useState<Set<number>>(
    () => new Set(sublayers.map((l) => l.id)),
  );
  const allChecked = selected.size === sublayers.length;
  const noneChecked = selected.size === 0;
  function toggle(id: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function toggleAll() {
    if (allChecked) setSelected(new Set());
    else setSelected(new Set(sublayers.map((l) => l.id)));
  }
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Add sublayers"
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/50 p-4"
      onClick={onCancel}
    >
      <div
        className="flex max-h-[85vh] w-full max-w-lg flex-col rounded-lg border border-border bg-surface-1 shadow-overlay"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="shrink-0 border-b border-border px-4 py-3">
          <h3 className="text-base font-semibold">
            Add &ldquo;{item.title}&rdquo;
          </h3>
          <p className="mt-1 text-sm text-muted">
            This service exposes <strong>{sublayers.length} sublayers</strong>.
            Pick which to include, then choose how to add them.
          </p>
        </div>
        <div className="flex-1 overflow-y-auto px-4 py-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-medium uppercase tracking-wide text-muted">
              Sublayers
            </span>
            <button
              type="button"
              onClick={toggleAll}
              className="text-xs text-accent hover:underline"
            >
              {allChecked ? 'Deselect all' : 'Select all'}
            </button>
          </div>
          <ul className="divide-y divide-border overflow-hidden rounded-md border border-border bg-surface-1">
            {sublayers.map((l) => {
              const checked = selected.has(l.id);
              const subName = l.name ?? `Layer ${l.id}`;
              const geom = geometryShort(l.geometryType);
              return (
                <li key={l.id}>
                  <label
                    className="flex cursor-pointer items-center gap-3 px-3 py-2 transition-colors hover:bg-surface-2"
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggle(l.id)}
                      className="h-4 w-4 shrink-0 rounded border-border text-accent focus:ring-accent"
                    />
                    <span className="min-w-0 flex-1 truncate text-sm text-ink-0">
                      {subName}
                    </span>
                    <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted">
                      {geom}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        </div>
        <div className="shrink-0 space-y-2 border-t border-border px-4 py-3">
          <button
            type="button"
            autoFocus
            disabled={noneChecked}
            onClick={() => onPick('group', selected)}
            className="flex w-full items-start gap-3 rounded-md border border-border bg-surface-1 px-3 py-3 text-left transition-colors hover:border-accent hover:bg-accent/5 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-border disabled:hover:bg-surface-1"
          >
            <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-accent/10 text-accent">
              <Layers className="h-4 w-4" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-ink-0">
                  Add {selected.size > 1 ? `${selected.size} ` : ''}as a group
                </span>
                <span className="rounded bg-accent/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-accent">
                  Recommended
                </span>
              </div>
              <p className="mt-0.5 text-xs text-muted">
                One parent header that controls visibility, opacity, and
                removal for every sublayer at once.
              </p>
            </div>
          </button>
          <button
            type="button"
            disabled={noneChecked}
            onClick={() => onPick('flat', selected)}
            className="flex w-full items-start gap-3 rounded-md border border-border bg-surface-1 px-3 py-3 text-left transition-colors hover:border-accent hover:bg-accent/5 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-border disabled:hover:bg-surface-1"
          >
            <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-surface-2 text-muted">
              <Database className="h-4 w-4" />
            </div>
            <div className="min-w-0 flex-1">
              <span className="text-sm font-medium text-ink-0">
                Add {selected.size > 1 ? `${selected.size} ` : ''}as separate layers
              </span>
              <p className="mt-0.5 text-xs text-muted">
                Independent top-level entries. Best if you plan to mix them
                with other map content.
              </p>
            </div>
          </button>
        </div>
        <div className="flex shrink-0 items-center justify-end border-t border-border px-4 py-3">
          <button
            type="button"
            onClick={onCancel}
            className="h-9 rounded-md border border-border bg-surface-1 px-3 text-sm text-ink-1 hover:bg-surface-2"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

function FileDropZone({
  busy,
  accept,
  onFile,
}: {
  busy: boolean;
  accept: string;
  onFile: (file: File) => void;
}) {
  const [over, setOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  function handleDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) onFile(file);
  }

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={handleDrop}
      className={`flex min-h-[120px] flex-col items-center justify-center gap-2 rounded-md border-2 border-dashed p-6 text-center transition-colors ${
        over ? 'border-accent bg-accent/5' : 'border-border bg-surface-1'
      } ${busy ? 'pointer-events-none opacity-60' : ''}`}
    >
      {busy ? (
        <Loader2 className="h-5 w-5 animate-spin text-muted" />
      ) : (
        <Upload className="h-5 w-5 text-muted" />
      )}
      <p className="text-sm text-ink-1">
        {busy ? 'Reading file...' : 'Drop a file here'}
      </p>
      <p className="text-xs text-muted">or</p>
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={busy}
        className="inline-flex h-8 items-center rounded-md border border-border bg-surface-1 px-3 text-xs font-medium text-ink-1 hover:bg-surface-2 disabled:opacity-50"
      >
        Choose file
      </button>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onFile(file);
          e.target.value = '';
        }}
      />
    </div>
  );
}

function TabButton({
  Icon,
  label,
  active,
  onClick,
}: {
  Icon: typeof Link2;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm transition-colors ${
        active
          ? 'border-accent text-ink-0'
          : 'border-transparent text-muted hover:text-ink-1'
      }`}
    >
      <Icon className="h-4 w-4" />
      {label}
    </button>
  );
}

/**
 * Scrollable layer picker for an ArcGIS service probe. Nested group
 * layers (MapServers often wrap sub-layers in folders) are rendered
 * with a subtle indent so hierarchy is visible without an accordion.
 * Empty-geometry rows (tables) are greyed but still selectable: the
 * attribute table view works even when there's nothing to draw.
 */
function ArcgisLayerPicker({
  layers,
  value,
  onChange,
}: {
  layers: ArcgisServiceLayer[];
  value: number | null;
  onChange: (id: number) => void;
}) {
  if (layers.length === 0) {
    return (
      <p className="text-xs text-muted">
        Service reported no layers. Is this URL pointing at something
        other than a MapServer / FeatureServer?
      </p>
    );
  }
  const parentIds = new Set(
    layers
      .map((l) => l.parentLayerId)
      .filter((x): x is number => typeof x === 'number' && x >= 0),
  );
  return (
    <ul className="max-h-48 space-y-0.5 overflow-y-auto rounded border border-border bg-surface-0 p-1">
      {layers.map((l) => {
        const indented = typeof l.parentLayerId === 'number' && l.parentLayerId >= 0;
        const isGroup = parentIds.has(l.id);
        const active = l.id === value;
        return (
          <li key={l.id}>
            <button
              type="button"
              onClick={() => onChange(l.id)}
              className={`flex w-full items-center justify-between gap-2 rounded px-2 py-1 text-left text-xs transition-colors ${
                active
                  ? 'bg-accent/10 text-ink-0 ring-1 ring-accent/40'
                  : 'text-ink-1 hover:bg-surface-2'
              } ${indented ? 'pl-6' : ''}`}
            >
              <span className="truncate">
                <span className="tabular-nums text-muted">{l.id}</span>{' '}
                {l.name}
                {isGroup ? (
                  <span className="ml-1 text-[10px] text-muted">(group)</span>
                ) : null}
              </span>
              <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted">
                {geometryShort(l.geometryType)}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function geometryShort(g?: string): string {
  if (!g) return 'table';
  const m = g.match(/esriGeometry(\w+)/);
  return (m?.[1] ?? g).toLowerCase();
}
