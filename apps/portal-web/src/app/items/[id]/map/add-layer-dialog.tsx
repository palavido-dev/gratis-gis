// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronRight,
  ClipboardPaste,
  Database,
  Folder,
  FolderOpen,
  Layers,
  Link2,
  Loader2,
  Search,
  Sparkles,
  Upload,
  Users,
} from 'lucide-react';
import type { Item, MapLayer, MapLayerSource } from '@gratis-gis/shared-types';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/dialog';
import { fileToGeoJson } from './kml-convert';
import {
  arcgisSublayers,
  buildArcgisLayers,
  buildDataLayerLayers,
  buildPointCloudLayer,
  buildTileLayer,
  fetchHydratedItem,
  makeLayer,
  type PortalItemWithSublayers,
} from './portal-item-layers';
import {
  probeService,
  type ArcgisServiceDescription,
  type ArcgisServiceLayer,
} from '@/lib/arcgis-rest';
import { useT } from '@/lib/i18n/locale-context';

interface Props {
  open: boolean;
  onClose: () => void;
  onAdd: (layer: MapLayer) => void;
}

type Tab = 'url' | 'paste' | 'file' | 'portal' | 'arcgis' | 'new';

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
  const t = useT();
  const [tab, setTab] = useState<Tab>('portal');
  const [title, setTitle] = useState('');
  const [url, setUrl] = useState('');
  const [paste, setPaste] = useState('');
  const [fileBusy, setFileBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // "New" tab (#brand-new-layer): create an empty, editable data
  // layer without ever leaving the map. The item is created behind
  // the scenes and the layer lands on the map immediately; schema
  // details beyond the geometry type live on the item page for
  // later. Saves the create-item / find-it / add-it round trip.
  const [newName, setNewName] = useState('');
  const [newGeom, setNewGeom] = useState<'point' | 'line' | 'polygon'>(
    'polygon',
  );
  const [newBusy, setNewBusy] = useState(false);

  async function createNewLayer() {
    const name = newName.trim();
    if (!name) {
      setError(t('mapAddLayer.errors.newNameRequired'));
      return;
    }
    setNewBusy(true);
    setError(null);
    try {
      const layerKey = crypto.randomUUID();
      const res = await fetch('/api/portal/items', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'data_layer',
          title: name,
          data: {
            version: 3,
            storageType: 'postgis',
            layers: [
              {
                id: layerKey,
                label: name,
                name: name
                  .toLowerCase()
                  .replace(/[^a-z0-9]+/g, '-')
                  .replace(/^-+|-+$/g, '')
                  .slice(0, 60) || 'layer',
                geometryType: newGeom,
                // A single Name field so popups, labels, and the
                // attribute form have something useful from the
                // first feature. More fields: item page.
                fields: [
                  {
                    name: 'name',
                    type: 'string',
                    label: t('mapAddLayer.defaultFieldLabel'),
                    nullable: true,
                  },
                ],
                editingEnabled: true,
                attachmentsEnabled: false,
              },
            ],
          },
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          message?: string | string[];
        } | null;
        const msg = Array.isArray(body?.message)
          ? body.message.join(' ')
          : body?.message;
        setError(msg || t('mapAddLayer.errors.createFailed'));
        return;
      }
      const created = (await res.json()) as { id: string };
      onAdd(
        makeLayer(name, {
          kind: 'data-layer',
          itemId: created.id,
          layerKey,
        }),
      );
      setNewName('');
      onClose();
    } catch {
      setError(t('mapAddLayer.errors.createFailed'));
    } finally {
      setNewBusy(false);
    }
  }

  // Portal tab state. The Portal tab has three view modes (#100):
  //
  //   - 'items'   : flat list of every data_layer / arcgis_service
  //                 item the user can see (with search).
  //   - 'groups'  : top level lists groups the user belongs to.
  //                 Drilling into a group (via selectedGroup) shows
  //                 the items shared with that group.
  //   - 'folders' : top level lists root folders. Drilling in (via
  //                 folderPath) walks the folder tree with a
  //                 breadcrumb, showing subfolders + items at each
  //                 level.
  //
  // Search lives next to the view-mode tabs and applies to whatever
  // is in view (items list, group list, or folder/items at the
  // current folder level).
  type PortalViewMode = 'items' | 'groups' | 'folders';
  const [portalViewMode, setPortalViewMode] = useState<PortalViewMode>('items');
  const [portalQ, setPortalQ] = useState('');
  const [portalItems, setPortalItems] = useState<Item[]>([]);
  const [portalFolders, setPortalFolders] = useState<Item[]>([]);
  const [portalLoading, setPortalLoading] = useState(false);
  // Groups view state: list of groups visible to the user, plus the
  // group currently drilled into (null at the top level). The
  // group's items are fetched lazily when one is picked.
  interface PortalGroup {
    id: string;
    title: string;
    description?: string | null;
  }
  const [portalGroups, setPortalGroups] = useState<PortalGroup[]>([]);
  const [selectedGroup, setSelectedGroup] = useState<PortalGroup | null>(null);
  const [groupItems, setGroupItems] = useState<Item[]>([]);
  const [groupLoading, setGroupLoading] = useState(false);
  // Folders view state: breadcrumb path. Empty array = top level
  // (showing root folders). Each entry is one level deeper. The
  // current folder is the last entry; click a breadcrumb to truncate
  // back. `folderContents` holds the resolved children of the
  // current folder (a mix of subfolders + leaf items).
  const [folderPath, setFolderPath] = useState<
    Array<{ id: string; title: string }>
  >([]);
  const [folderContents, setFolderContents] = useState<Item[]>([]);
  const [folderLoading, setFolderLoading] = useState(false);
  // When the user picks an item that exposes more than one sublayer
  // we surface this follow-up prompt: which sublayers to include
  // (#45) and whether to bundle them under a group header (#46).
  // Used by two paths today:
  //   - arcgis_service items with 2+ sublayers (numeric ids)
  //   - v3 data_layer items with 2+ sublayers (string ids, #189)
  // The modal stays generic over id type; each path supplies its
  // own `onConfirm` so the commit step (URL shape, source kind)
  // stays specialised. The picker selection passes through as
  // `Set<number | string>`; each onConfirm narrows back to its
  // specific id type.
  const [pendingSublayerChoice, setPendingSublayerChoice] = useState<{
    item: Item;
    sublayers: Array<{
      id: number | string;
      name?: string;
      geometryType?: string;
    }>;
    onConfirm: (
      mode: 'group' | 'flat',
      selectedIds: Set<number | string>,
    ) => void;
  } | null>(null);

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
    setPortalViewMode('items');
    setSelectedGroup(null);
    setFolderPath([]);
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
  // changes. One fetch
  // (?type=data_layer,derived_layer,arcgis_service&lite=1) covers
  // every supported source type; lite mode strips the heavy data
  // JSONB from each row so the wire payload is small and the
  // backend skips serialising hundreds of KB of layer metadata
  // per arcgis_service. The badge count comes from the derived
  // `_subLayerCount` field the server attaches in lite mode. Full
  // `data` is fetched lazily when the user clicks an item below.
  // Derived layers join the list because the map renderer treats
  // them as `kind: 'data-layer'` sources -- /items/:id/geojson on
  // a derived_layer routes to derivedLayers.getGeoJson on the
  // backend, so MapLibre fetches the same shape it does for a
  // regular data layer.
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
      try {
        const q = portalQ.trim();
        const qs = new URLSearchParams({
          // #304 slice 5 / #301: include the unified `service` type
          // (Connected Service items, the new way) plus the legacy
          // wms_service / wfs_service item types so existing rows
          // surface in the picker too. ArcGIS protocols on `service`
          // route through the existing arcgis-rest source kind for
          // free; WMS / WFS / WMTS surface in the list with a
          // "rendering coming up" indicator until the canvas
          // renderer for those source kinds lands (#305).
          // #179 unit 3: point_cloud items are addable as 3D layers.
          // #185: tile_layer items (uploaded imagery, analysis
          // results like hillshades) are addable as image overlays.
          type:
            'data_layer,derived_layer,arcgis_service,service,wms_service,wfs_service,point_cloud,tile_layer',
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

  // Load the folder list once when the Portal tab opens (#100). The
  // top-level Folders view derives "root folders" client-side as the
  // folders that aren't claimed as children by any other folder, so
  // we need every folder's `data.childItemIds` to compute that set.
  // Folders rarely change during a dialog session; one fetch per
  // open is plenty.
  useEffect(() => {
    if (!open || tab !== 'portal') return;
    let cancelled = false;
    const controller = new AbortController();
    void (async () => {
      try {
        // NOT lite -- we need data.childItemIds to compute root
        // folders + drill-in children. Folders are tiny rows; the
        // payload cost is negligible vs the data_layer / arcgis_service
        // list we lite-mode for.
        const res = await fetch('/api/portal/items?type=folder&full=1', {
          signal: controller.signal,
        });
        if (!res.ok || cancelled) return;
        const folders = (await res.json()) as Item[];
        folders.sort((a, b) => a.title.localeCompare(b.title));
        if (!cancelled) setPortalFolders(folders);
      } catch (err) {
        if ((err as Error)?.name === 'AbortError') return;
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [open, tab]);

  // Load groups when entering the Groups view (#100). Same shape as
  // the folder fetch -- once per open is enough; the user rarely
  // creates a group mid-add-layer.
  useEffect(() => {
    if (!open || tab !== 'portal' || portalViewMode !== 'groups') return;
    if (selectedGroup) return; // we're drilled in; the group-items effect handles fetching
    let cancelled = false;
    const controller = new AbortController();
    void (async () => {
      try {
        const res = await fetch('/api/portal/groups', {
          signal: controller.signal,
        });
        if (!res.ok || cancelled) return;
        const groups = (await res.json()) as PortalGroup[];
        groups.sort((a, b) => a.title.localeCompare(b.title));
        if (!cancelled) setPortalGroups(groups);
      } catch (err) {
        if ((err as Error)?.name === 'AbortError') return;
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [open, tab, portalViewMode, selectedGroup]);

  // Load items shared with the drilled-into group (#100). Uses the
  // new `sharedWithGroupId` filter on /items so the server applies
  // visibleWhere intersected with "has a share row for this group".
  // Re-runs when the search query changes so the user can filter
  // within a group.
  useEffect(() => {
    if (!open || tab !== 'portal' || portalViewMode !== 'groups') return;
    if (!selectedGroup) return;
    let cancelled = false;
    const controller = new AbortController();
    setGroupLoading(true);
    const handle = setTimeout(async () => {
      try {
        const qs = new URLSearchParams({
          // Same expansion as the items-view filter: include the
          // unified `service` type and the legacy OGC types
          // (#304 slice 5).
          type:
            'data_layer,arcgis_service,service,wms_service,wfs_service',
          lite: '1',
          sharedWithGroupId: selectedGroup.id,
        });
        const q = portalQ.trim();
        if (q) qs.set('q', q);
        const res = await fetch(`/api/portal/items?${qs}`, {
          signal: controller.signal,
        });
        if (!res.ok || cancelled) {
          if (!cancelled) setGroupItems([]);
          return;
        }
        const items = (await res.json()) as Item[];
        if (!cancelled) setGroupItems(items);
      } catch (err) {
        if ((err as Error)?.name === 'AbortError') return;
      } finally {
        if (!cancelled) setGroupLoading(false);
      }
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(handle);
      controller.abort();
    };
  }, [open, tab, portalViewMode, selectedGroup, portalQ]);

  // Load the current folder's contents when drilled in (#100).
  // Top-level (folderPath = []) doesn't need a fetch -- we render
  // root folders directly from the already-loaded folder list.
  useEffect(() => {
    if (!open || tab !== 'portal' || portalViewMode !== 'folders') return;
    if (folderPath.length === 0) return;
    const current = folderPath[folderPath.length - 1];
    if (!current) return;
    let cancelled = false;
    const controller = new AbortController();
    setFolderLoading(true);
    void (async () => {
      try {
        const res = await fetch(
          `/api/portal/items/${current.id}/folder-contents`,
          { signal: controller.signal },
        );
        if (!res.ok || cancelled) {
          if (!cancelled) setFolderContents([]);
          return;
        }
        const items = (await res.json()) as Item[];
        if (!cancelled) setFolderContents(items);
      } catch (err) {
        if ((err as Error)?.name === 'AbortError') return;
      } finally {
        if (!cancelled) setFolderLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [open, tab, portalViewMode, folderPath]);

  // Top-level Folders view (folderPath empty): the "roots" are
  // folders that aren't claimed as children by any other folder.
  // Mirrors the folder-rail tree-building logic (apps/portal-web/
  // src/app/items/folder-rail.tsx). Subfolders only show up after
  // the user drills into their parent.
  const rootFolders = useMemo(() => {
    if (portalFolders.length === 0) return [];
    const claimed = new Set<string>();
    for (const f of portalFolders) {
      const childIds = (f.data as { childItemIds?: unknown } | null)
        ?.childItemIds;
      if (Array.isArray(childIds)) {
        for (const c of childIds) {
          if (typeof c === 'string') claimed.add(c);
        }
      }
    }
    return portalFolders.filter((f) => !claimed.has(f.id));
  }, [portalFolders]);

  // Apply the search query client-side to whichever list is in view.
  // For Items mode the server already did the matching via ?q=, so
  // visiblePortalItems = portalItems unchanged. For Groups list and
  // Folders contents, the search runs against title client-side
  // because re-fetching on every keystroke would be wasteful when
  // the lists are small.
  const visiblePortalItems = portalItems;
  const visibleGroups = useMemo(() => {
    const q = portalQ.trim().toLowerCase();
    if (!q) return portalGroups;
    return portalGroups.filter(
      (g) =>
        g.title.toLowerCase().includes(q) ||
        (g.description ?? '').toLowerCase().includes(q),
    );
  }, [portalGroups, portalQ]);
  const visibleRootFolders = useMemo(() => {
    const q = portalQ.trim().toLowerCase();
    if (!q) return rootFolders;
    return rootFolders.filter((f) => f.title.toLowerCase().includes(q));
  }, [rootFolders, portalQ]);
  const visibleFolderContents = useMemo(() => {
    const q = portalQ.trim().toLowerCase();
    if (!q) return folderContents;
    return folderContents.filter((i) => i.title.toLowerCase().includes(q));
  }, [folderContents, portalQ]);
  const visibleGroupItems = useMemo(() => {
    // Group items go through the server with ?q=, but do a
    // belt-and-braces client-side filter too in case the request is
    // still in flight.
    const q = portalQ.trim().toLowerCase();
    if (!q) return groupItems;
    return groupItems.filter((i) => i.title.toLowerCase().includes(q));
  }, [groupItems, portalQ]);

  async function runArcgisProbe(raw: string) {
    setError(null);
    if (!raw.trim()) {
      setError(t('mapAddLayer.errors.arcgisUrlRequired'));
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
          t('mapAddLayer.errors.arcgisProbeFailed'),
      );
    } finally {
      if (!controller.signal.aborted) setArcgisProbing(false);
    }
  }

  function submitArcgis() {
    setError(null);
    if (!arcgisService) {
      setError(t('mapAddLayer.errors.arcgisProbeFirst'));
      return;
    }
    if (arcgisService.serviceType === 'GeocodeServer') {
      // The Add Layer dialog adds rendered map layers; a
      // GeocodeServer has no sublayers to render (#75). Refuse
      // explicitly rather than handing the runtime a layer-ref
      // pointing at a geocoder.
      setError(t('mapAddLayer.errors.arcgisGeocodeServer'));
      return;
    }
    if (arcgisLayerId == null) {
      setError(t('mapAddLayer.errors.arcgisPickLayer'));
      return;
    }
    if (!title.trim()) {
      setError(t('mapAddLayer.errors.nameRequired'));
      return;
    }
    onAdd(
      makeLayer(title.trim(), {
        kind: 'arcgis-rest',
        url: arcgisService.url,
        layerId: arcgisLayerId,
        // Narrow: the GeocodeServer branch returned above so this
        // assignment only runs for Map / Feature services, which
        // is what the runtime's arcgis-rest layer kind expects.
        serviceType: arcgisService.serviceType as
          | 'MapServer'
          | 'FeatureServer',
      }),
    );
    reset();
    onClose();
  }

  function submitUrlOrPaste() {
    setError(null);
    if (!title.trim()) {
      setError(t('mapAddLayer.errors.nameRequired'));
      return;
    }
    let source: MapLayerSource;
    if (tab === 'url') {
      if (!url.trim()) {
        setError(t('mapAddLayer.errors.geojsonUrlRequired'));
        return;
      }
      source = { kind: 'geojson-url', url: url.trim() };
    } else {
      let parsed: unknown;
      try {
        parsed = JSON.parse(paste);
      } catch {
        setError(t('mapAddLayer.errors.invalidJson'));
        return;
      }
      if (
        !parsed ||
        typeof parsed !== 'object' ||
        (parsed as { type?: string }).type !== 'FeatureCollection'
      ) {
        setError(t('mapAddLayer.errors.featureCollectionRequired'));
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
    // #304 slice 5: unified Connected Service items branch on the
    // `protocol` discriminator inside data_json. ArcGIS variants
    // (arcgis_map / arcgis_feature) reuse the arcgis-rest path
    // since the source kind + URL conventions are identical;
    // WMS / WFS / WMTS surface a clear "renderer coming up"
    // message until #305 ships the canvas support for those source
    // kinds. We also fold the legacy wms_service / wfs_service
    // items into the same not-yet-renderable bucket so the user
    // gets one consistent message regardless of how the item was
    // authored.
    if (
      item.type === 'service' ||
      item.type === 'wms_service' ||
      item.type === 'wfs_service'
    ) {
      await submitServicePortalItem(item);
      return;
    }
    // #179 unit 3: point_cloud items become 3D layers. Hydrate to
    // read the streaming URL + metadata off item.data, stamp them
    // on the source so no runtime ever needs an item fetch to
    // render, and refuse items whose upload never finished (no
    // dataUrl yet) with a plain message instead of a dead layer.
    if (item.type === 'point_cloud') {
      const hydrated = await hydratePortalItem(item);
      if (hydrated === null) return;
      const built = buildPointCloudLayer(hydrated);
      if (!built.layer) {
        setError(built.error);
        return;
      }
      onAdd(built.layer);
      reset();
      onClose();
      return;
    }
    // #185: tile_layer items become image overlay layers. Hydrate to
    // read tileUrl + coverage off item.data and stamp them on the
    // source (same no-runtime-item-fetch rule as point clouds).
    // Vector tile caches need authored styling we don't have here;
    // those stay basemap-only for now, with a plain message.
    if (item.type === 'tile_layer') {
      const hydrated = await hydratePortalItem(item);
      if (hydrated === null) return;
      const built = buildTileLayer(hydrated);
      if (!built.layer) {
        setError(built.error);
        return;
      }
      onAdd(built.layer);
      reset();
      onClose();
      return;
    }
    if (item.type !== 'arcgis_service') {
      // v3 data_layers carry one or more sublayers (each mapped to
      // its own PostGIS table). The lite-mode list response attaches
      // `_layers: [{id, label, geometryType}]` so we can fan out
      // without a hydrate round-trip. v1/v2 single-table data_layers
      // (and any other non-arcgis kind) have no _layers and continue
      // to add as a single MapLayer pointing at the legacy item-level
      // /geojson endpoint.
      const lite = item as Item & {
        _layers?: Array<{
          id: string;
          label: string;
          geometryType: string | null;
        }>;
      };
      const sublayers = lite._layers ?? [];
      if (item.type === 'data_layer' && sublayers.length > 1) {
        // Same UX as arcgis_service: defer to the picker so the user
        // can opt out of sublayers and pick group vs flat. The id
        // type here is string (v3 sublayer keys), normalised through
        // the modal's `number | string` selection set; the
        // `onConfirm` callback narrows it back at commit time.
        setPendingSublayerChoice({
          item,
          sublayers: sublayers.map((s) => ({
            id: s.id,
            name: s.label,
            ...(s.geometryType ? { geometryType: s.geometryType } : {}),
          })),
          onConfirm: (mode, ids) =>
            addDataLayerPortalItem(item, mode, ids as Set<string>),
        });
        return;
      }
      if (item.type === 'data_layer' && sublayers.length === 1) {
        const only = sublayers[0]!;
        onAdd(
          makeLayer(item.title, {
            kind: 'data-layer',
            itemId: item.id,
            layerKey: only.id,
          }),
        );
        reset();
        onClose();
        return;
      }
      // v1/v2 single-table data_layer (no _layers) and any other
      // non-arcgis kind (derived_layer): add as a single MapLayer
      // hitting the item-level /geojson endpoint. layerKey omitted.
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
      setPendingSublayerChoice({
        item: hydrated,
        sublayers: ordered,
        onConfirm: (mode, ids) =>
          addArcgisPortalItem(hydrated, mode, ids as Set<number>),
      });
      return;
    }
    addArcgisPortalItem(
      hydrated,
      'flat',
      new Set(ordered.map((l) => l.id)),
    );
  }

  /**
   * Click handler for unified `service` items (#304 slice 5) and
   * for legacy wms_service / wfs_service items that haven't been
   * migrated yet. Routes ArcGIS protocols (the bulk of the value)
   * through the existing arcgis-rest source kind for free; non-
   * ArcGIS protocols surface a clear "rendering coming up" toast
   * pointing at #305.
   */
  async function submitServicePortalItem(item: Item) {
    const hydrated = await hydratePortalItem(item);
    if (hydrated === null) return;
    const d = (hydrated.data ?? {}) as {
      protocol?: string;
      url?: string;
      layers?: Array<{
        name?: string;
        title?: string;
        geometryType?: string;
      }>;
      selectedLayerIds?: number[];
      defaultLayerIndex?: number;
      requiresAuth?: boolean;
    };
    // Legacy wms_service / wfs_service items: protocol is implied
    // by item.type. Fold both into one decision branch.
    const protocol =
      hydrated.type === 'service'
        ? d.protocol ?? ''
        : hydrated.type === 'wms_service'
          ? 'wms'
          : 'wfs';
    if (protocol !== 'arcgis_map' && protocol !== 'arcgis_feature') {
      setError(
        t('mapAddLayer.errors.protocolNotRenderable', {
          protocol: protocol.toUpperCase().replace('_', ' '),
        }),
      );
      return;
    }
    if (!d.url) {
      setError(
        t('mapAddLayer.errors.noServiceUrl', { title: hydrated.title }),
      );
      return;
    }
    const allLayers = d.layers ?? [];
    if (allLayers.length === 0) {
      setError(
        t('mapAddLayer.errors.noLayersCaptured', { title: hydrated.title }),
      );
      return;
    }
    // selectedLayerIds in the unified shape is indices into layers[].
    const selectedIndices =
      d.selectedLayerIds && d.selectedLayerIds.length > 0
        ? d.selectedLayerIds
        : allLayers.map((_, i) => i);
    if (selectedIndices.length === 0) {
      setError(
        t('mapAddLayer.errors.noLayersSelected', { title: hydrated.title }),
      );
      return;
    }
    // The Connected Service shape stringifies the integer sublayer
    // id into `name` at probe time (see lib/service-probe.ts
    // arcgisToServiceData). Reconstruct {id, name} pairs for the
    // sublayer modal + the arcgis-rest source kind.
    const serviceType: 'MapServer' | 'FeatureServer' =
      protocol === 'arcgis_feature' ? 'FeatureServer' : 'MapServer';
    const orderedSubs: Array<{
      id: number;
      name?: string;
      geometryType?: string;
    }> = [];
    const defaultIdx =
      typeof d.defaultLayerIndex === 'number' ? d.defaultLayerIndex : -1;
    const indexOrder = [
      ...selectedIndices.filter((i) => i === defaultIdx),
      ...selectedIndices.filter((i) => i !== defaultIdx),
    ];
    for (const i of indexOrder) {
      const l = allLayers[i];
      if (!l) continue;
      const id = Number(l.name);
      if (!Number.isFinite(id)) continue;
      const out: { id: number; name?: string; geometryType?: string } = {
        id,
      };
      if (l.title) out.name = l.title;
      if (l.geometryType) out.geometryType = l.geometryType;
      orderedSubs.push(out);
    }
    if (orderedSubs.length === 0) {
      setError(
        t('mapAddLayer.errors.noArcgisLayerIds', { title: hydrated.title }),
      );
      return;
    }
    if (orderedSubs.length > 1) {
      setPendingSublayerChoice({
        item: hydrated,
        sublayers: orderedSubs,
        onConfirm: (mode, ids) =>
          addArcgisServiceShapedItem(
            hydrated,
            d.url!,
            serviceType,
            allLayers,
            ids as Set<number>,
            mode,
            d.requiresAuth ?? false,
          ),
      });
      return;
    }
    addArcgisServiceShapedItem(
      hydrated,
      d.url,
      serviceType,
      allLayers,
      new Set(orderedSubs.map((l) => l.id)),
      'flat',
      d.requiresAuth ?? false,
    );
  }

  /**
   * Commit an arcgis-shaped subset (from a unified `service` item
   * with arcgis_map / arcgis_feature protocol) to the layer panel.
   * Mirrors addArcgisPortalItem but pulls the metadata out of the
   * unified ServiceData shape (layers[] indexed by string `name`,
   * not by integer `id`). Routes through the per-item proxy for the
   * same usage-tracking + CORS reasons.
   */
  function addArcgisServiceShapedItem(
    item: Item,
    url: string,
    serviceType: 'MapServer' | 'FeatureServer',
    allLayers: Array<{
      name?: string;
      title?: string;
      geometryType?: string;
    }>,
    selectedIds: Set<number>,
    mode: 'group' | 'flat',
    _requiresAuth: boolean,
  ) {
    if (selectedIds.size === 0) return;
    const proxyUrl = `/api/portal/items/${item.id}/proxy`;
    const picked = allLayers.filter((sub) => {
      const id = Number(sub?.name);
      return Number.isFinite(id) && selectedIds.has(id);
    });
    if (picked.length === 0) {
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
    for (const sub of picked) {
      const id = Number(sub.name);
      const layerTitle =
        picked.length === 1 ? item.title : sub.title || `Layer ${id}`;
      const child = makeLayer(layerTitle, {
        kind: 'arcgis-rest',
        url,
        layerId: id,
        serviceType,
        sourceItemId: item.id,
        proxyUrl,
      });
      if (groupId) child.groupId = groupId;
      onAdd(child);
    }
    reset();
    onClose();
  }

  /**
   * Hydrate a lite-mode portal item by fetching its full record
   * (including `data`) by id. Returns the hydrated item, or null
   * if the fetch failed (setError populated). Items already
   * carrying `data` (e.g. from a non-lite caller) short-circuit.
   */
  /** Shared fetch with the dialog's error-state plumbing attached. */
  async function hydratePortalItem(item: Item): Promise<Item | null> {
    const { item: hydrated, error } = await fetchHydratedItem(item);
    if (!hydrated) {
      setError(
        error ?? t('mapAddLayer.errors.loadItemFailed', { title: item.title }),
      );
      return null;
    }
    return hydrated;
  }

  /**
   * Shared sublayer extraction with the dialog's error-state
   * plumbing attached; see portal-item-layers.ts for the logic.
   */
  function orderedSublayersForPortalItem(
    item: Item,
  ): Array<{ id: number; name?: string; geometryType?: string }> | null {
    const result = arcgisSublayers(item);
    if (!result.ordered) {
      setError(result.error);
      return null;
    }
    return result.ordered;
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
    const ordered = orderedSublayersForPortalItem(item);
    if (ordered === null) return;
    // Empty selection is a no-op (cancel-equivalent): reset and
    // close so the user doesn't end up with a stray group header.
    const layers = buildArcgisLayers(item, ordered, mode, selectedIds);
    for (const layer of layers) onAdd(layer);
    reset();
    onClose();
  }

  /**
   * v3 data_layer counterpart to addArcgisPortalItem (#189). Takes
   * the same group-vs-flat decision and the user-picked subset of
   * sublayers, and emits one MapLayer per sublayer with `layerKey`
   * set so the renderer hits the v3 per-sublayer geojson endpoint
   * (`/items/<id>/layers/<layerKey>/geojson`) rather than the
   * legacy item-level path. Group mode adds a parent header layer
   * with no source; flat mode adds them as siblings. Empty
   * selection is a no-op (cancel-equivalent), matching the arcgis
   * path.
   */
  function addDataLayerPortalItem(
    item: Item,
    mode: 'group' | 'flat',
    selectedIds: Set<string>,
  ) {
    const layers = buildDataLayerLayers(
      item as PortalItemWithSublayers,
      mode,
      selectedIds,
    );
    for (const layer of layers) onAdd(layer);
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
          setError(t('mapAddLayer.errors.fileInvalidJson'));
          return;
        }
        if (
          !parsed ||
          typeof parsed !== 'object' ||
          (parsed as { type?: string }).type !== 'FeatureCollection'
        ) {
          setError(t('mapAddLayer.errors.fileFeatureCollection'));
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
      setError(
        err instanceof Error
          ? err.message
          : t('mapAddLayer.errors.fileReadFailed'),
      );
    } finally {
      setFileBusy(false);
    }
  }

  return (
    <>
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent
        size="lg"
        className="flex max-h-[85vh] flex-col overflow-hidden p-0 shadow-overlay"
      >
        <div className="border-b border-border px-4 py-3 pr-12">
          <DialogTitle className="text-base font-semibold">
            {t('mapAddLayer.title')}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {t('mapAddLayer.description')}
          </DialogDescription>
        </div>

        <div className="flex gap-0 border-b border-border px-2 pt-2">
          {/* Portal first: content inside this org's catalog is the
              most common "add a layer" path once maps exist. The
              Curated tab was removed (#91) -- it shipped a
              hand-coded GeoJSON URL list with no admin UI to
              manage it; if a deployment wants curated layers it
              should seed them as real items in a "Curated"
              folder/group. The Portal tab now supports filtering
              by folder so finding one of many items is fast. File
              / Paste / URL are progressively more manual. */}
          <TabButton
            Icon={Database}
            label={t('mapAddLayer.tabs.portal')}
            active={tab === 'portal'}
            onClick={() => setTab('portal')}
          />
          <TabButton
            Icon={Upload}
            label={t('mapAddLayer.tabs.file')}
            active={tab === 'file'}
            onClick={() => setTab('file')}
          />
          <TabButton
            Icon={ClipboardPaste}
            label={t('mapAddLayer.tabs.paste')}
            active={tab === 'paste'}
            onClick={() => setTab('paste')}
          />
          <TabButton
            Icon={Link2}
            label={t('mapAddLayer.tabs.url')}
            active={tab === 'url'}
            onClick={() => setTab('url')}
          />
          <TabButton
            Icon={Layers}
            label={t('mapAddLayer.tabs.arcgis')}
            active={tab === 'arcgis'}
            onClick={() => setTab('arcgis')}
          />
          <TabButton
            Icon={Sparkles}
            label={t('mapAddLayer.tabs.new')}
            active={tab === 'new'}
            onClick={() => setTab('new')}
          />
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-4">
          {tab === 'new' && (
            <div className="space-y-4">
              <p className="text-sm text-muted">
                {t('mapAddLayer.newIntro')}
              </p>
              <div>
                <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted">
                  {t('mapAddLayer.nameLabel')}
                </label>
                <input
                  type="text"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder={t('mapAddLayer.newNamePlaceholder')}
                  autoFocus
                  className="w-full rounded-md border border-border bg-surface-1 px-3 py-2 text-sm text-ink-0"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted">
                  {t('mapAddLayer.newGeomLabel')}
                </label>
                <div className="flex gap-2">
                  {(
                    [
                      ['point', t('itemDetail.geometryPoint')],
                      ['line', t('itemDetail.geometryLine')],
                      ['polygon', t('itemDetail.geometryPolygon')],
                    ] as const
                  ).map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      onClick={() => setNewGeom(value)}
                      className={`flex-1 rounded-md border px-3 py-2 text-sm ${
                        newGeom === value
                          ? 'border-accent bg-accent/10 font-medium text-ink-0'
                          : 'border-border text-ink-1 hover:bg-surface-2'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              <button
                type="button"
                onClick={() => void createNewLayer()}
                disabled={newBusy || newName.trim().length === 0}
                className="inline-flex h-9 items-center gap-1.5 rounded-md bg-accent px-3 text-sm font-medium text-accent-foreground hover:opacity-90 disabled:opacity-50"
              >
                {newBusy ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Sparkles className="h-4 w-4" />
                )}
                {t('mapAddLayer.newCreateButton')}
              </button>
              <p className="text-xs text-muted">
                {t('mapAddLayer.newFieldsHint')}
              </p>
            </div>
          )}
          {(tab === 'url' || tab === 'paste') && (
            <div className="space-y-4">
              <div>
                <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted">
                  {t('mapAddLayer.nameLabel')}
                </label>
                <input
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder={t('mapAddLayer.layerNamePlaceholder')}
                  maxLength={200}
                  className="h-9 w-full rounded-md border border-border bg-surface-1 px-3 text-sm focus:border-accent focus:outline-hidden focus:ring-2 focus:ring-accent/30"
                />
              </div>
              {tab === 'url' ? (
                <div>
                  <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted">
                    {t('mapAddLayer.geojsonUrlLabel')}
                  </label>
                  <input
                    type="url"
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    placeholder={t('mapAddLayer.geojsonUrlPlaceholder')}
                    className="h-9 w-full rounded-md border border-border bg-surface-1 px-3 text-sm focus:border-accent focus:outline-hidden focus:ring-2 focus:ring-accent/30"
                  />
                  <p className="mt-1 text-xs text-muted">
                    {t('mapAddLayer.geojsonUrlHint')}
                  </p>
                </div>
              ) : (
                <div>
                  <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted">
                    {t('mapAddLayer.geojsonPasteLabel')}
                  </label>
                  <textarea
                    value={paste}
                    onChange={(e) => setPaste(e.target.value)}
                    placeholder='{"type":"FeatureCollection","features":[...]}'
                    rows={10}
                    className="w-full rounded-md border border-border bg-surface-0 px-3 py-2 font-mono text-xs focus:border-accent focus:outline-hidden focus:ring-2 focus:ring-accent/30"
                  />
                  <p className="mt-1 text-xs text-muted">
                    {t('mapAddLayer.geojsonPasteHint')}
                  </p>
                </div>
              )}
            </div>
          )}

          {tab === 'file' && (
            <div className="space-y-3">
              <div>
                <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted">
                  {t('mapAddLayer.nameLabel')}
                </label>
                <input
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder={t('mapAddLayer.fileNamePlaceholder')}
                  maxLength={200}
                  className="h-9 w-full rounded-md border border-border bg-surface-1 px-3 text-sm focus:border-accent focus:outline-hidden focus:ring-2 focus:ring-accent/30"
                />
              </div>
              <FileDropZone
                busy={fileBusy}
                onFile={submitFile}
                accept=".kml,.kmz,.geojson,.json,.zip,application/vnd.google-earth.kml+xml,application/vnd.google-earth.kmz,application/geo+json,application/json,application/zip"
                t={t}
              />
              <p className="text-2xs text-muted">
                {t('mapAddLayer.fileFormatsHint')}
              </p>
            </div>
          )}

          {tab === 'portal' && (
            <div className="space-y-3">
              {/* View-mode tabs (#100). Three sibling views: a flat
                  Items list, a Groups list (drillable into items
                  shared with that group), and a Folders tree
                  (drillable with breadcrumb). Search is shared and
                  applies to whichever list is in view. */}
              <div className="flex items-center gap-1 rounded-md border border-border bg-surface-2 p-0.5 text-xs">
                {(
                  [
                    ['items', t('nav.items'), Database],
                    ['groups', t('nav.groups'), Users],
                    ['folders', t('nav.folders'), Folder],
                  ] as const
                ).map(([key, lbl, Icon]) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => {
                      setPortalViewMode(key);
                      setSelectedGroup(null);
                      setFolderPath([]);
                      setPortalQ('');
                    }}
                    className={`inline-flex flex-1 items-center justify-center gap-1.5 rounded px-3 py-1.5 ${
                      portalViewMode === key
                        ? 'bg-surface-0 font-medium text-ink-0 shadow-xs'
                        : 'text-muted hover:text-ink-1'
                    }`}
                  >
                    <Icon className="h-3.5 w-3.5" />
                    {lbl}
                  </button>
                ))}
              </div>
              {/* Search bar */}
              <label className="relative block">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
                <input
                  type="text"
                  value={portalQ}
                  onChange={(e) => setPortalQ(e.target.value)}
                  placeholder={
                    portalViewMode === 'groups' && !selectedGroup
                      ? t('mapAddLayer.searchGroups')
                      : portalViewMode === 'folders' && folderPath.length === 0
                        ? t('mapAddLayer.searchFolders')
                        : t('mapAddLayer.searchServices')
                  }
                  className="h-9 w-full rounded-md border border-border bg-surface-1 pl-9 pr-3 text-sm focus:border-accent focus:outline-hidden focus:ring-2 focus:ring-accent/30"
                />
              </label>

              {/* Groups view: drilled into a group -> show items.
                  Otherwise show the group list. */}
              {portalViewMode === 'groups' && selectedGroup ? (
                <div className="space-y-2">
                  <button
                    type="button"
                    onClick={() => setSelectedGroup(null)}
                    className="inline-flex items-center gap-1 text-xs text-accent hover:underline"
                  >
                    <ChevronRight className="h-3 w-3 rotate-180" />
                    {t('mapAddLayer.backToGroups')}
                  </button>
                  <div className="rounded-md border border-border bg-surface-2 px-3 py-1.5 text-xs">
                    <span className="text-muted">
                      {t('mapAddLayer.showingItemsSharedWith')}{' '}
                    </span>
                    <span className="font-medium text-ink-0">
                      {selectedGroup.title}
                    </span>
                  </div>
                  {groupLoading ? (
                    <LoadingShell
                      label={t('mapAddLayer.loadingGroupItems')}
                    />
                  ) : visibleGroupItems.length === 0 ? (
                    <EmptyShell label={t('mapAddLayer.emptyGroupItems')} />
                  ) : (
                    <PortalItemList
                      items={visibleGroupItems}
                      onPick={submitPortalItem}
                      t={t}
                    />
                  )}
                </div>
              ) : portalViewMode === 'groups' ? (
                visibleGroups.length === 0 ? (
                  <EmptyShell label={t('mapAddLayer.emptyNoGroups')} />
                ) : (
                  <ul className="divide-y divide-border overflow-hidden rounded-md border border-border bg-surface-1">
                    {visibleGroups.map((g) => (
                      <li key={g.id}>
                        <button
                          type="button"
                          onClick={() => setSelectedGroup(g)}
                          className="flex w-full items-center gap-2 px-3 py-2.5 text-left transition-colors hover:bg-surface-2"
                        >
                          <Users className="h-4 w-4 shrink-0 text-muted" />
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-medium text-ink-0">
                              {g.title}
                            </p>
                            {g.description ? (
                              <p className="line-clamp-1 text-xs text-muted">
                                {g.description}
                              </p>
                            ) : null}
                          </div>
                          <ChevronRight className="h-4 w-4 shrink-0 text-muted" />
                        </button>
                      </li>
                    ))}
                  </ul>
                )
              ) : null}

              {/* Folders view: top level shows root folders. Drilled
                  in shows breadcrumb + (subfolders + items). */}
              {portalViewMode === 'folders' && folderPath.length > 0 ? (
                <div className="space-y-2">
                  {/* Breadcrumb */}
                  <nav className="flex flex-wrap items-center gap-1 text-xs text-muted">
                    <button
                      type="button"
                      onClick={() => setFolderPath([])}
                      className="inline-flex items-center gap-1 rounded px-1 py-0.5 hover:bg-surface-2"
                    >
                      <Folder className="h-3 w-3" />
                      {t('mapAddLayer.allFolders')}
                    </button>
                    {folderPath.map((seg, i) => (
                      <span
                        key={seg.id}
                        className="inline-flex items-center gap-1"
                      >
                        <ChevronRight className="h-3 w-3" />
                        <button
                          type="button"
                          onClick={() =>
                            setFolderPath(folderPath.slice(0, i + 1))
                          }
                          className={`rounded px-1 py-0.5 hover:bg-surface-2 ${
                            i === folderPath.length - 1
                              ? 'font-medium text-ink-0'
                              : ''
                          }`}
                        >
                          {seg.title}
                        </button>
                      </span>
                    ))}
                  </nav>
                  {folderLoading ? (
                    <LoadingShell label={t('mapAddLayer.loadingFolder')} />
                  ) : visibleFolderContents.length === 0 ? (
                    <EmptyShell label={t('mapAddLayer.emptyFolder')} />
                  ) : (
                    <ul className="divide-y divide-border overflow-hidden rounded-md border border-border bg-surface-1">
                      {visibleFolderContents.map((item) =>
                        item.type === 'folder' ? (
                          <li key={item.id}>
                            <button
                              type="button"
                              onClick={() =>
                                setFolderPath([
                                  ...folderPath,
                                  { id: item.id, title: item.title },
                                ])
                              }
                              className="flex w-full items-center gap-2 px-3 py-2.5 text-left transition-colors hover:bg-surface-2"
                            >
                              <FolderOpen className="h-4 w-4 shrink-0 text-muted" />
                              <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink-0">
                                {item.title}
                              </span>
                              <ChevronRight className="h-4 w-4 shrink-0 text-muted" />
                            </button>
                          </li>
                        ) : item.type === 'data_layer' ||
                          item.type === 'arcgis_service' ||
                          item.type === 'service' ||
                          item.type === 'wms_service' ||
                          item.type === 'wfs_service' ? (
                          <PortalItemRow
                            key={item.id}
                            item={item}
                            onPick={submitPortalItem}
                            t={t}
                          />
                        ) : null,
                      )}
                    </ul>
                  )}
                </div>
              ) : portalViewMode === 'folders' ? (
                visibleRootFolders.length === 0 ? (
                  <EmptyShell label={t('mapAddLayer.emptyNoFolders')} />
                ) : (
                  <ul className="divide-y divide-border overflow-hidden rounded-md border border-border bg-surface-1">
                    {visibleRootFolders.map((f) => (
                      <li key={f.id}>
                        <button
                          type="button"
                          onClick={() =>
                            setFolderPath([{ id: f.id, title: f.title }])
                          }
                          className="flex w-full items-center gap-2 px-3 py-2.5 text-left transition-colors hover:bg-surface-2"
                        >
                          <Folder className="h-4 w-4 shrink-0 text-muted" />
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-medium text-ink-0">
                              {f.title}
                            </p>
                            {f.description ? (
                              <p className="line-clamp-1 text-xs text-muted">
                                {f.description}
                              </p>
                            ) : null}
                          </div>
                          <ChevronRight className="h-4 w-4 shrink-0 text-muted" />
                        </button>
                      </li>
                    ))}
                  </ul>
                )
              ) : null}

              {/* Items view: flat list with server-side search. */}
              {portalViewMode === 'items' && (
                portalLoading ? (
                  <LoadingShell
                    label={t('mapAddLayer.loadingPortalItems')}
                  />
                ) : visiblePortalItems.length === 0 ? (
                  <EmptyShell label={t('mapAddLayer.emptyNoServices')} />
                ) : (
                <PortalItemList
                  items={visiblePortalItems}
                  onPick={submitPortalItem}
                  t={t}
                />
                )
              )}
              <p className="text-2xs text-muted">
                {t('mapAddLayer.portalFootnote')}
              </p>
            </div>
          )}

          {/* Curated tab removed (#91): see comment near the tab
              button row above. */}

          {tab === 'arcgis' && (
            <div className="space-y-4">
              <div>
                <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted">
                  {t('mapAddLayer.nameLabel')}
                </label>
                <input
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder={t('mapAddLayer.arcgisNamePlaceholder')}
                  maxLength={200}
                  className="h-9 w-full rounded-md border border-border bg-surface-1 px-3 text-sm focus:border-accent focus:outline-hidden focus:ring-2 focus:ring-accent/30"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted">
                  {t('mapAddLayer.arcgisUrlLabel')}
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
                    placeholder={t('mapAddLayer.arcgisUrlPlaceholder')}
                    className="h-9 min-w-0 flex-1 rounded-md border border-border bg-surface-1 px-3 text-sm focus:border-accent focus:outline-hidden focus:ring-2 focus:ring-accent/30"
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
                    {t('mapAddLayer.probeButton')}
                  </button>
                </div>
                <p className="mt-1 text-xs text-muted">
                  {t('mapAddLayer.arcgisUrlHint')}
                </p>
              </div>

              {arcgisService ? (
                <div className="rounded-md border border-border bg-surface-1 p-3">
                  <div className="mb-2 flex items-baseline justify-between gap-3">
                    <div>
                      <div className="text-sm font-medium">
                        {arcgisService.name}
                      </div>
                      <div className="text-2xs text-muted">
                        {arcgisService.serviceType} •{' '}
                        {t('mapAddLayer.layerCount', {
                          count: arcgisService.layers.length,
                        })}
                      </div>
                    </div>
                  </div>
                  {arcgisService.description ? (
                    <p className="mb-2 line-clamp-3 text-xs text-muted">
                      {arcgisService.description}
                    </p>
                  ) : null}
                  <label className="mb-1 block text-2xs uppercase tracking-wide text-muted">
                    {t('mapAddLayer.pickLayerLabel')}
                  </label>
                  <ArcgisLayerPicker
                    layers={arcgisService.layers}
                    value={arcgisLayerId}
                    t={t}
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
              <p className="text-2xs text-muted">
                {t('mapAddLayer.arcgisFootnote')}
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
              {t('common.cancel')}
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
              {t('mapAddLayer.addLayerButton')}
            </button>
          </div>
        )}
      </DialogContent>
    </Dialog>
    {pendingSublayerChoice ? (
      <SublayerChoiceModal
        item={pendingSublayerChoice.item}
        sublayers={pendingSublayerChoice.sublayers}
        t={t}
        onPick={(mode, selectedIds) => {
          const onConfirm = pendingSublayerChoice.onConfirm;
          setPendingSublayerChoice(null);
          onConfirm(mode, selectedIds);
        }}
        onCancel={() => setPendingSublayerChoice(null)}
      />
    ) : null}
    </>
  );
}

/**
 * Inline follow-up dialog shown after the user picks an item that
 * exposes more than one sublayer. Lets the user (#45) pick which
 * sublayers to include via checkboxes, and (#46) choose whether to
 * bundle them under a group header or add as separate top-level
 * layers.
 *
 * Generic over sublayer id type so it serves both arcgis_service
 * (numeric ids) and v3 data_layer (string ids, #189). The caller
 * supplies an `onConfirm` callback that knows how to commit the
 * specific item type.
 *
 * Defaults: every sublayer checked, "Add as a group" highlighted.
 * The modal sits above the parent Add Layer dialog; we intercept
 * the backdrop click so it closes only the modal, not both.
 */
type MapAddLayerT = (
  key: string,
  params?: Record<string, string | number>,
) => string;

function SublayerChoiceModal({
  item,
  sublayers,
  t,
  onPick,
  onCancel,
}: {
  item: Item;
  sublayers: Array<{
    id: number | string;
    name?: string;
    geometryType?: string;
  }>;
  t: MapAddLayerT;
  onPick: (
    mode: 'group' | 'flat',
    selectedIds: Set<number | string>,
  ) => void;
  onCancel: () => void;
}) {
  // All sublayers selected by default -- the most common case is
  // "give me everything, like the old behaviour." Users who want to
  // narrow can untick before clicking Add.
  const [selected, setSelected] = useState<Set<number | string>>(
    () => new Set(sublayers.map((l) => l.id)),
  );
  const allChecked = selected.size === sublayers.length;
  const noneChecked = selected.size === 0;
  function toggle(id: number | string) {
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
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <DialogContent
        size="md"
        className="flex max-h-[85vh] flex-col overflow-hidden p-0 shadow-overlay"
      >
        <div className="shrink-0 border-b border-border px-4 py-3 pr-12">
          <DialogTitle className="text-base font-semibold">
            {t('mapAddLayer.sublayerModalTitle', { title: item.title })}
          </DialogTitle>
          <DialogDescription className="mt-1 text-sm text-muted">
            {t('mapAddLayer.sublayerModalIntro', { count: sublayers.length })}
          </DialogDescription>
        </div>
        <div className="flex-1 overflow-y-auto px-4 py-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-medium uppercase tracking-wide text-muted">
              {t('mapAddLayer.sublayersHeading')}
            </span>
            <button
              type="button"
              onClick={toggleAll}
              className="text-xs text-accent hover:underline"
            >
              {allChecked
                ? t('mapAddLayer.deselectAll')
                : t('mapAddLayer.selectAll')}
            </button>
          </div>
          <ul className="divide-y divide-border overflow-hidden rounded-md border border-border bg-surface-1">
            {sublayers.map((l) => {
              const checked = selected.has(l.id);
              const subName =
                l.name ?? t('mapAddLayer.layerFallbackName', { id: l.id });
              const geom = geometryShortLabel(l.geometryType, t);
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
                    <span className="shrink-0 text-2xs uppercase tracking-wide text-muted">
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
                  {selected.size > 1
                    ? t('mapAddLayer.addAsGroupMany', { count: selected.size })
                    : t('mapAddLayer.addAsGroup')}
                </span>
                <span className="rounded bg-accent/10 px-1.5 py-0.5 text-2xs font-medium uppercase tracking-wide text-accent">
                  {t('mapAddLayer.recommended')}
                </span>
              </div>
              <p className="mt-0.5 text-xs text-muted">
                {t('mapAddLayer.addAsGroupHint')}
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
                {selected.size > 1
                  ? t('mapAddLayer.addAsFlatMany', { count: selected.size })
                  : t('mapAddLayer.addAsFlat')}
              </span>
              <p className="mt-0.5 text-xs text-muted">
                {t('mapAddLayer.addAsFlatHint')}
              </p>
            </div>
          </button>
        </div>
        <DialogFooter className="shrink-0 px-4 py-3">
          <button
            type="button"
            onClick={onCancel}
            className="h-9 rounded-md border border-border bg-surface-1 px-3 text-sm text-ink-1 hover:bg-surface-2"
          >
            {t('common.cancel')}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function FileDropZone({
  busy,
  accept,
  onFile,
  t,
}: {
  busy: boolean;
  accept: string;
  onFile: (file: File) => void;
  t: MapAddLayerT;
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
        {busy ? t('mapAddLayer.readingFile') : t('mapAddLayer.dropFile')}
      </p>
      <p className="text-xs text-muted">{t('mapAddLayer.or')}</p>
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={busy}
        className="inline-flex h-8 items-center rounded-md border border-border bg-surface-1 px-3 text-xs font-medium text-ink-1 hover:bg-surface-2 disabled:opacity-50"
      >
        {t('mapAddLayer.chooseFile')}
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
  t,
  onChange,
}: {
  layers: ArcgisServiceLayer[];
  value: number | null;
  t: MapAddLayerT;
  onChange: (id: number) => void;
}) {
  if (layers.length === 0) {
    return (
      <p className="text-xs text-muted">{t('mapAddLayer.arcgisNoLayers')}</p>
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
                  <span className="ml-1 text-2xs text-muted">
                    {t('mapAddLayer.arcgisGroupSuffix')}
                  </span>
                ) : null}
              </span>
              <span className="shrink-0 text-2xs uppercase tracking-wide text-muted">
                {geometryShortLabel(l.geometryType, t)}
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

// ---- Portal-tab list helpers (#100) -----------------------------
//
// The Portal tab now has three view modes (Items / Groups / Folders),
// and several of them end up rendering an item list. These helpers
// keep the row JSX in one place so the +N-layers / Feature / ArcGIS
// badges stay consistent across views.

function LoadingShell({ label }: { label: string }) {
  return (
    <div className="flex items-center justify-center gap-2 rounded-md border border-border bg-surface-2 px-4 py-6 text-sm text-muted">
      <Loader2 className="h-4 w-4 animate-spin" />
      {label}
    </div>
  );
}

function EmptyShell({ label }: { label: string }) {
  return (
    <div className="rounded-md border border-border bg-surface-2 p-4 text-center text-xs text-muted">
      <Sparkles className="mx-auto mb-2 h-5 w-5" />
      {label}
    </div>
  );
}

function PortalItemList({
  items,
  onPick,
  t,
}: {
  items: Item[];
  onPick: (item: Item) => void;
  t: MapAddLayerT;
}) {
  return (
    <ul className="divide-y divide-border overflow-hidden rounded-md border border-border bg-surface-1">
      {items.map((item) => (
        <PortalItemRow key={item.id} item={item} onPick={onPick} t={t} />
      ))}
    </ul>
  );
}

function PortalItemRow({
  item,
  onPick,
  t,
}: {
  item: Item;
  onPick: (item: Item) => void;
  t: MapAddLayerT;
}) {
  // The list is fetched in lite mode (#52) so `data` is omitted from
  // the row payload; the server attaches a derived `_subLayerCount`
  // for arcgis_service rows. Fall back to the legacy `data`-derived
  // count if a non-lite caller ever re-uses this same component.
  let sublayerCount = 0;
  if (
    item.type === 'arcgis_service' ||
    item.type === 'service' ||
    item.type === 'wms_service' ||
    item.type === 'wfs_service'
  ) {
    const fromLite = (item as Item & { _subLayerCount?: number })
      ._subLayerCount;
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
  const { typeLabel, typeClasses } = portalItemTypeBadge(item, t);
  return (
    <li>
      <button
        type="button"
        onClick={() => onPick(item)}
        className="flex w-full flex-col items-start gap-1 px-3 py-2.5 text-left transition-colors hover:bg-surface-2"
      >
        <div className="flex w-full items-center gap-2">
          <div className="min-w-0 flex-1 truncate text-sm font-medium text-ink-0">
            {item.title}
          </div>
          {sublayerCount > 1 ? (
            <span
              className="shrink-0 rounded bg-warn/15 px-1.5 py-0.5 text-2xs font-medium text-warn"
              title={t('mapAddLayer.sublayerBadgeTitle', {
                count: sublayerCount,
              })}
            >
              {t('mapAddLayer.sublayerBadge', { count: sublayerCount })}
            </span>
          ) : null}
          <span
            className={`shrink-0 rounded px-1.5 py-0.5 text-2xs uppercase tracking-wide ${typeClasses}`}
          >
            {typeLabel}
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
}

function portalItemTypeBadge(
  item: Item,
  t: MapAddLayerT,
): { typeLabel: string; typeClasses: string } {
  let typeClasses =
    'bg-cyan-100 dark:bg-cyan-950 text-cyan-800 dark:text-cyan-300';
  if (item.type === 'arcgis_service') {
    return { typeLabel: t('mapAddLayer.typeArcgis'), typeClasses };
  }
  if (item.type === 'derived_layer') {
    return {
      typeLabel: t('mapAddLayer.typeDerived'),
      typeClasses: 'bg-info/15 text-info',
    };
  }
  if (item.type === 'service') {
    const protocol = (item.data as { protocol?: string } | null)?.protocol;
    const typeLabel =
      protocol === 'arcgis_map' || protocol === 'arcgis_feature'
        ? t('mapAddLayer.typeArcgis')
        : protocol === 'wms'
          ? t('mapAddLayer.typeWms')
          : protocol === 'wfs'
            ? t('mapAddLayer.typeWfs')
            : protocol === 'wmts'
              ? t('mapAddLayer.typeWmts')
              : t('mapAddLayer.typeService');
    return { typeLabel, typeClasses };
  }
  if (item.type === 'wms_service') {
    return { typeLabel: t('mapAddLayer.typeWms'), typeClasses };
  }
  if (item.type === 'wfs_service') {
    return { typeLabel: t('mapAddLayer.typeWfs'), typeClasses };
  }
  if (item.type === 'point_cloud') {
    return {
      typeLabel: t('mapAddLayer.type3d'),
      typeClasses: 'bg-accent/15 text-accent',
    };
  }
  if (item.type === 'tile_layer') {
    return {
      typeLabel: t('mapAddLayer.typeImagery'),
      typeClasses: 'bg-warn/15 text-warn',
    };
  }
  return {
    typeLabel: t('mapAddLayer.typeFeature'),
    typeClasses: 'bg-info/15 text-info',
  };
}

function geometryShortLabel(g?: string, t?: MapAddLayerT): string {
  const raw = geometryShort(g);
  if (raw === 'table' && t) return t('mapAddLayer.geometryTable');
  return raw;
}
