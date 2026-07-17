// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import { useEffect, useState } from 'react';
import { Loader2, Search } from 'lucide-react';
import type { BasemapData, Item } from '@gratis-gis/shared-types';

/**
 * Basemap source editor (#298 / #144). Source-aware: the user picks
 * how the basemap is served (probe-a-URL, pick a service item,
 * paste an XYZ template, paste a WMS GetMap URL, or paste a
 * MapLibre style.json URL) and fills in the matching fields. The
 * saved BasemapData uses one of the three concrete renderer kinds
 * (tile-url, wms, style-url) so the renderer doesn't need to know
 * about the authoring shape.
 *
 * Lives at the component level (not embedded in the wizard) so the
 * same editor can be reused from a future basemap detail page when
 * an admin needs to fix the source of an existing basemap without
 * recreating it from scratch.
 *
 * Probe URL tab (#144): the user pastes any URL (XYZ template,
 * ArcGIS MapServer, WMTS/WMS GetCapabilities, MapLibre style.json)
 * and the backend probe identifies the format and returns a
 * populated BasemapData skeleton. On success we auto-switch to the
 * matching tab so the user can see + tweak the resolved fields
 * before saving.
 */

/**
 * Wire shape returned by GET /admin/basemap/probe. Mirrors the
 * BasemapProbeResult interface on the API side (see
 * apps/portal-api/src/admin/admin-basemap-probe.controller.ts).
 *
 * minZoom / maxZoom are reported by the API for WMTS + ArcGIS
 * MapServer probes but BasemapData has no slot for them today;
 * the component drops them. If zoom hints need to be honored at
 * render time, BasemapData itself needs a schema extension and
 * map-canvas needs to read it; that's a separate change.
 */
interface BasemapProbeResult {
  kind: 'tile-url' | 'wms' | 'style-url';
  tileUrl?: string;
  styleUrl?: string;
  wmsUrl?: string;
  wmsConfig?: {
    layers: string;
    format?: string;
    transparent?: boolean;
    version?: string;
    crs?: string;
  };
  title?: string;
  attribution?: string;
  thumbnailUrl?: string;
  minZoom?: number;
  maxZoom?: number;
}

type SourceMode = 'probe' | 'tile-url' | 'wms' | 'style-url' | 'from-service';

interface Props {
  value: BasemapData;
  onChange: (next: BasemapData) => void;
}

/**
 * Pick the tab a freshly-mounted editor should open on. A
 * fully-configured basemap opens on the tab matching its kind so
 * the user sees what's already there; an empty / unconfigured one
 * opens on the Probe tab as the quickest path to a working state.
 */
function inferInitialMode(value: BasemapData): SourceMode {
  if (value.kind === 'composed-map') return 'probe';
  if (value.kind === 'tile-url') return value.tileUrl ? 'tile-url' : 'probe';
  if (value.kind === 'wms') return value.wmsUrl ? 'wms' : 'probe';
  if (value.kind === 'style-url') return value.styleUrl ? 'style-url' : 'probe';
  return 'probe';
}

export function BasemapConfigSection({ value, onChange }: Props) {
  const [sourceMode, setSourceMode] = useState<SourceMode>(() =>
    inferInitialMode(value),
  );
  const [serviceItems, setServiceItems] = useState<Item[] | null>(null);
  const [serviceLoading, setServiceLoading] = useState(false);
  const [serviceError, setServiceError] = useState<string | null>(null);

  // Probe state. The URL field is kept local to the component
  // because it isn't part of the BasemapData payload; it's just
  // the input we feed the probe endpoint.
  const [probeUrl, setProbeUrl] = useState('');
  const [probing, setProbing] = useState(false);
  const [probeError, setProbeError] = useState<string | null>(null);

  // Lazy-load the picker list the first time the user clicks
  // "From an existing service item". Filters to the types that can
  // realistically back a basemap: WMS, ArcGIS Map, and the unified
  // `service` items that route through one of those protocols.
  // WFS / non-cached services aren't basemap-shaped, so they're
  // filtered out at pick time rather than removed from the list.
  useEffect(() => {
    if (sourceMode !== 'from-service' || serviceItems !== null) return;
    let cancelled = false;
    setServiceLoading(true);
    setServiceError(null);
    void (async () => {
      try {
        const res = await fetch(
          '/api/portal/items?type=service,arcgis_service,wms_service&lite=1',
        );
        if (!res.ok) {
          if (!cancelled) {
            setServiceError(`Could not load services (HTTP ${res.status}).`);
          }
          return;
        }
        const items = (await res.json()) as Item[];
        if (!cancelled) setServiceItems(items);
      } catch (err) {
        if (!cancelled) {
          setServiceError(
            err instanceof Error ? err.message : 'Could not load services.',
          );
        }
      } finally {
        if (!cancelled) setServiceLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sourceMode, serviceItems]);

  const setKind = (mode: SourceMode) => {
    setSourceMode(mode);
    if (mode === 'from-service' || mode === 'probe') {
      // Don't touch `value` yet -- the actual BasemapData comes
      // from the picked service item or the probe response when
      // the user completes the action.
      return;
    }
    // Reset fields that don't apply to the new kind so we don't
    // leave stale URLs floating in data_json. attribution +
    // thumbnailUrl are kind-agnostic so they survive.
    const base: BasemapData = {
      version: 1,
      kind: mode,
    };
    if (value.attribution) base.attribution = value.attribution;
    if (value.thumbnailUrl) base.thumbnailUrl = value.thumbnailUrl;
    if (mode === 'wms') base.wmsConfig = { layers: '' };
    onChange(base);
  };

  async function runProbe() {
    const trimmed = probeUrl.trim();
    if (trimmed.length === 0) {
      setProbeError('Paste a URL first.');
      return;
    }
    setProbing(true);
    setProbeError(null);
    try {
      const res = await fetch(
        `/api/portal/admin/basemap/probe?url=${encodeURIComponent(trimmed)}`,
      );
      if (!res.ok) {
        let msg = `Probe failed (HTTP ${res.status}).`;
        // NestJS BadRequestException serializes as
        // `{ statusCode, message, error }` -- pull the message
        // if present so the user sees the controller's actual
        // reason ("No web-mercator TileMatrixSet...", etc.) not
        // a generic HTTP code.
        try {
          const body = (await res.json()) as { message?: unknown };
          if (typeof body.message === 'string') {
            msg = body.message;
          } else if (Array.isArray(body.message) && body.message.length > 0) {
            msg = String(body.message[0]);
          }
        } catch {
          /* response wasn't JSON; keep the HTTP-code fallback */
        }
        setProbeError(msg);
        return;
      }
      const result = (await res.json()) as BasemapProbeResult;
      const next: BasemapData = { version: 1, kind: result.kind };
      if (result.tileUrl) next.tileUrl = result.tileUrl;
      if (result.styleUrl) next.styleUrl = result.styleUrl;
      if (result.wmsUrl) next.wmsUrl = result.wmsUrl;
      if (result.wmsConfig) next.wmsConfig = result.wmsConfig;
      // Attribution: prefer the probe's discovery, but if the
      // probe didn't surface one keep whatever the user already
      // typed (so re-probing a URL doesn't blow away a manual
      // attribution they entered earlier).
      const attribution = result.attribution ?? value.attribution;
      if (attribution) next.attribution = attribution;
      if (result.thumbnailUrl) next.thumbnailUrl = result.thumbnailUrl;
      onChange(next);
      // Hop the user to the matching kind tab so they can see
      // and tweak the populated fields before saving.
      setSourceMode(result.kind);
    } catch (err) {
      setProbeError(err instanceof Error ? err.message : 'Probe failed.');
    } finally {
      setProbing(false);
    }
  }

  // Hydrate the picked service item and resolve to a BasemapData
  // payload. Only protocols that map cleanly to a renderable
  // basemap source are accepted; others surface a clear error so
  // the user knows why their pick didn't take.
  async function pickServiceItem(itemId: string) {
    setServiceError(null);
    try {
      const res = await fetch(`/api/portal/items/${itemId}`);
      if (!res.ok) {
        setServiceError(`Could not load service (HTTP ${res.status}).`);
        return;
      }
      const item = (await res.json()) as Item;
      const next = serviceItemToBasemapData(item, value);
      if (!next) {
        setServiceError(
          "That service can't back a basemap yet (only WMS and cached ArcGIS Map services work today).",
        );
        return;
      }
      onChange(next);
    } catch (err) {
      setServiceError(
        err instanceof Error ? err.message : 'Could not load service.',
      );
    }
  }

  return (
    <section className="rounded-lg border border-border bg-surface-1 p-4">
      <h2 className="mb-1 text-sm font-medium text-ink-0">Basemap source</h2>
      <p className="mb-3 text-xs text-muted">
        Pick how this basemap is served. Maps that reference this
        basemap pull from the source you configure here. The fastest
        path is Probe URL: paste any tile / service URL and we&rsquo;ll
        figure out the format and fill in the fields for you.
      </p>
      <div className="mb-3 flex flex-wrap gap-2 text-xs">
        {(
          [
            { k: 'probe', label: 'Probe URL' },
            { k: 'from-service', label: 'From a service item' },
            { k: 'tile-url', label: 'XYZ tiles' },
            { k: 'wms', label: 'WMS' },
            { k: 'style-url', label: 'Style URL' },
          ] as const
        ).map((opt) => {
          const active = sourceMode === opt.k;
          return (
            <button
              key={opt.k}
              type="button"
              onClick={() => setKind(opt.k)}
              className={
                'h-8 rounded-md border px-3 ' +
                (active
                  ? 'border-accent bg-accent/10 text-accent'
                  : 'border-border bg-surface-1 text-ink-1 hover:bg-surface-2')
              }
            >
              {opt.label}
            </button>
          );
        })}
      </div>

      {sourceMode === 'probe' ? (
        <div className="space-y-2">
          <label className="block text-xs">
            <span className="text-muted">Paste a URL</span>
            <div className="mt-0.5 flex gap-2">
              <input
                type="url"
                inputMode="url"
                value={probeUrl}
                onChange={(e) => setProbeUrl(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    void runProbe();
                  }
                }}
                placeholder="https://server/wmts/.../WMTSCapabilities.xml"
                className="h-9 min-w-0 flex-1 rounded-md border border-border bg-surface-1 px-2 font-mono text-sm"
              />
              <button
                type="button"
                onClick={() => void runProbe()}
                disabled={probing || probeUrl.trim().length === 0}
                className="inline-flex h-9 items-center gap-1.5 rounded-md bg-accent px-3 text-sm font-medium text-accent-foreground hover:opacity-90 disabled:opacity-50"
              >
                {probing ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Search className="h-4 w-4" />
                )}
                {probing ? 'Probing...' : 'Probe'}
              </button>
            </div>
            <span className="mt-1 block text-2xs text-muted">
              Recognized: XYZ tile templates (with{' '}
              <span className="font-mono">{'{z}/{x}/{y}'}</span>),
              ArcGIS MapServer, WMTS GetCapabilities, WMS
              GetCapabilities, MapLibre style.json.
            </span>
          </label>
          {probeError ? (
            <p className="text-xs text-danger" role="alert">
              {probeError}
            </p>
          ) : null}
        </div>
      ) : null}

      {sourceMode === 'from-service' ? (
        <div className="space-y-2">
          {serviceLoading ? (
            <div className="rounded-md border border-border bg-surface-2 p-3 text-xs text-muted">
              Loading services...
            </div>
          ) : serviceItems && serviceItems.length === 0 ? (
            <div className="rounded-md border border-border bg-surface-2 p-3 text-xs text-muted">
              No service items yet. Create a Connected service first, then come
              back here.
            </div>
          ) : serviceItems ? (
            <ul className="max-h-60 overflow-y-auto rounded-md border border-border bg-surface-2 text-xs">
              {serviceItems.map((it) => {
                const protocol = (it.data as { protocol?: string } | null)
                  ?.protocol;
                const protocolLabel =
                  it.type === 'wms_service'
                    ? 'WMS'
                    : it.type === 'arcgis_service'
                      ? 'ArcGIS'
                      : protocol === 'wms'
                        ? 'WMS'
                        : protocol === 'arcgis_map'
                          ? 'ArcGIS Map'
                          : protocol === 'arcgis_feature'
                            ? 'ArcGIS Feature'
                            : (protocol ?? 'Service');
                return (
                  <li
                    key={it.id}
                    className="flex items-center gap-2 border-b border-border px-2 py-1.5 last:border-0"
                  >
                    <button
                      type="button"
                      onClick={() => pickServiceItem(it.id)}
                      className="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left hover:bg-surface-1"
                    >
                      <span className="rounded border border-accent/40 bg-accent/10 px-1 py-0.5 text-2xs font-medium uppercase tracking-wide text-accent">
                        {protocolLabel}
                      </span>
                      <span className="min-w-0 flex-1 truncate font-medium text-ink-0">
                        {it.title}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : null}
          {serviceError ? (
            <p className="text-xs text-danger" role="alert">
              {serviceError}
            </p>
          ) : null}
          {/* Once a service is picked we render the resolved
              BasemapData below using the same per-kind input boxes
              the direct-URL flow uses, so the user can tweak it
              before hitting Create. */}
          {value.kind === 'wms' && value.wmsUrl ? (
            <div className="rounded-md border border-accent/40 bg-accent/5 p-3 text-xs">
              <p className="text-ink-0">
                Resolved as WMS. URL + layer pre-filled below.
              </p>
            </div>
          ) : null}
          {value.kind === 'tile-url' && value.tileUrl ? (
            <div className="rounded-md border border-accent/40 bg-accent/5 p-3 text-xs">
              <p className="text-ink-0">
                Resolved as XYZ tile template. URL pre-filled below.
              </p>
            </div>
          ) : null}
        </div>
      ) : null}

      {value.kind === 'tile-url' && sourceMode !== 'probe' ? (
        <label className="block text-xs">
          <span className="text-muted">XYZ tile template</span>
          <input
            type="url"
            inputMode="url"
            value={value.tileUrl ?? ''}
            onChange={(e) => onChange({ ...value, tileUrl: e.target.value })}
            placeholder="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
            className="mt-0.5 h-9 w-full rounded-md border border-border bg-surface-1 px-2 font-mono text-sm"
          />
          <span className="mt-1 block text-2xs text-muted">
            Use <span className="font-mono">{'{z}/{x}/{y}'}</span>{' '}
            placeholders. Works with any standard XYZ raster tile server
            (OpenStreetMap, ArcGIS cached MapServer&rsquo;s{' '}
            <span className="font-mono">/tile/</span> endpoint, custom
            rasters, etc.).
          </span>
        </label>
      ) : null}
      {value.kind === 'style-url' && sourceMode !== 'probe' ? (
        <label className="block text-xs">
          <span className="text-muted">Style JSON URL</span>
          <input
            type="url"
            inputMode="url"
            value={value.styleUrl ?? ''}
            onChange={(e) => onChange({ ...value, styleUrl: e.target.value })}
            placeholder="https://demotiles.maplibre.org/style.json"
            className="mt-0.5 h-9 w-full rounded-md border border-border bg-surface-1 px-2 font-mono text-sm"
          />
          <span className="mt-1 block text-2xs text-muted">
            A hosted MapLibre style.json. Works with MapTiler, Stadia,
            self-hosted tilesets, etc.
          </span>
        </label>
      ) : null}
      {value.kind === 'wms' && sourceMode !== 'probe' ? (
        <div className="space-y-2">
          <label className="block text-xs">
            <span className="text-muted">WMS GetMap URL</span>
            <input
              type="url"
              inputMode="url"
              value={value.wmsUrl ?? ''}
              onChange={(e) => onChange({ ...value, wmsUrl: e.target.value })}
              placeholder="https://example.org/geoserver/wms"
              className="mt-0.5 h-9 w-full rounded-md border border-border bg-surface-1 px-2 font-mono text-sm"
            />
          </label>
          <label className="block text-xs">
            <span className="text-muted">Layer name(s)</span>
            <input
              type="text"
              value={value.wmsConfig?.layers ?? ''}
              onChange={(e) =>
                onChange({
                  ...value,
                  wmsConfig: {
                    ...(value.wmsConfig ?? { layers: '' }),
                    layers: e.target.value,
                  },
                })
              }
              placeholder="topp:states"
              className="mt-0.5 h-9 w-full rounded-md border border-border bg-surface-1 px-2 font-mono text-sm"
            />
            <span className="mt-1 block text-2xs text-muted">
              Comma-separated WMS layer names. Match what the server
              advertises in GetCapabilities.
            </span>
          </label>
          <div className="grid grid-cols-2 gap-2 text-xs">
            <label className="block">
              <span className="text-muted">Format</span>
              <select
                value={value.wmsConfig?.format ?? 'image/png'}
                onChange={(e) =>
                  onChange({
                    ...value,
                    wmsConfig: {
                      ...(value.wmsConfig ?? { layers: '' }),
                      format: e.target.value,
                    },
                  })
                }
                className="mt-0.5 h-9 w-full rounded-md border border-border bg-surface-1 px-2"
              >
                <option value="image/png">image/png</option>
                <option value="image/jpeg">image/jpeg</option>
              </select>
            </label>
            <label className="block">
              <span className="text-muted">Version</span>
              <select
                value={value.wmsConfig?.version ?? '1.3.0'}
                onChange={(e) =>
                  onChange({
                    ...value,
                    wmsConfig: {
                      ...(value.wmsConfig ?? { layers: '' }),
                      version: e.target.value,
                    },
                  })
                }
                className="mt-0.5 h-9 w-full rounded-md border border-border bg-surface-1 px-2"
              >
                <option value="1.3.0">1.3.0</option>
                <option value="1.1.1">1.1.1</option>
              </select>
            </label>
          </div>
        </div>
      ) : null}

      {sourceMode !== 'probe' ? (
        <label className="mt-3 block text-xs">
          <span className="text-muted">Attribution (optional)</span>
          <input
            type="text"
            value={value.attribution ?? ''}
            onChange={(e) => onChange({ ...value, attribution: e.target.value })}
            placeholder="&copy; OpenStreetMap contributors"
            className="mt-0.5 h-9 w-full rounded-md border border-border bg-surface-1 px-2 text-sm"
          />
        </label>
      ) : null}
    </section>
  );
}

/**
 * Resolve a picked service item (Connected Service, legacy
 * arcgis_service, or legacy wms_service) into a BasemapData payload
 * the renderer can consume (#304 slice 6 / #302). Returns null if
 * the protocol can't reasonably back a basemap (WFS, ArcGIS Feature,
 * etc.).
 *
 * Mapping rules:
 *   - WMS (unified or legacy): kind=wms with wmsUrl + comma-joined
 *     selected layer names.
 *   - ArcGIS Map Service (cached MapServer): kind=tile-url with the
 *     `${url}/tile/{z}/{y}/{x}` template ArcGIS publishes for cached
 *     services. Dynamic-only services would need GetMap-style
 *     export URLs we don't compose today.
 *
 * The previously-typed attribution / thumbnail on `prev` survive
 * because they're kind-agnostic.
 */
function serviceItemToBasemapData(
  item: Item,
  prev: BasemapData,
): BasemapData | null {
  const data = (item.data ?? {}) as Record<string, unknown>;
  const url = typeof data.url === 'string' ? data.url : '';
  if (!url) return null;
  // Identify protocol either from the unified `service` data
  // (`protocol` field) or from the legacy item.type wrapper.
  const protocol =
    item.type === 'service'
      ? typeof data.protocol === 'string'
        ? data.protocol
        : ''
      : item.type === 'wms_service'
        ? 'wms'
        : item.type === 'arcgis_service'
          ? // serviceType on legacy ArcGIS items is 'MapServer' or
            // 'FeatureServer'; only MapServer maps cleanly to a
            // basemap. The Feature path returns null below.
            (data as { serviceType?: string }).serviceType === 'FeatureServer'
            ? 'arcgis_feature'
            : 'arcgis_map'
          : '';
  if (protocol === 'wms') {
    const layersArr = Array.isArray(data.layers)
      ? (data.layers as Array<{ name?: string }>)
      : [];
    const selectedIds = Array.isArray(data.selectedLayerIds)
      ? (data.selectedLayerIds as Array<number | string>).map((i) =>
          Number(i),
        )
      : layersArr.map((_, i) => i);
    const names = selectedIds
      .map((i) => layersArr[i]?.name)
      .filter((n): n is string => typeof n === 'string' && n.length > 0);
    const next: BasemapData = {
      version: 1,
      kind: 'wms',
      wmsUrl: url,
      wmsConfig: {
        layers: names.join(','),
        format: 'image/png',
        transparent: true,
        version: '1.3.0',
        crs: 'EPSG:3857',
      },
    };
    if (prev.attribution) next.attribution = prev.attribution;
    if (prev.thumbnailUrl) next.thumbnailUrl = prev.thumbnailUrl;
    return next;
  }
  if (protocol === 'arcgis_map') {
    // Cached ArcGIS MapServers publish at /tile/{level}/{row}/{col}.
    // We rewrite to MapLibre's {z}/{y}/{x} placeholders since
    // Esri's URL ordering is z/y/x (rows-then-cols), not z/x/y.
    const cleaned = url.replace(/\/+$/, '');
    const tileUrl = `${cleaned}/tile/{z}/{y}/{x}`;
    const next: BasemapData = {
      version: 1,
      kind: 'tile-url',
      tileUrl,
    };
    if (prev.attribution) next.attribution = prev.attribution;
    if (prev.thumbnailUrl) next.thumbnailUrl = prev.thumbnailUrl;
    return next;
  }
  // arcgis_feature, wfs, wmts, image: no basemap mapping today.
  return null;
}
