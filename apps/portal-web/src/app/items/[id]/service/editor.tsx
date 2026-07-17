// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  Check,
  ExternalLink,
  Loader2,
  RefreshCw,
  Save,
} from 'lucide-react';
import type {
  ServiceData,
  ServiceProtocol,
} from '@gratis-gis/shared-types';
import { serviceProtocolLabel } from '@gratis-gis/shared-types';
import {
  probeService as autoProbeService,
} from '@/lib/service-probe';

interface Props {
  itemId: string;
  initial: ServiceData;
  canEdit: boolean;
}

/**
 * Detail-page editor for the unified Connected Service item type
 * (#304 slice 4). One component handles all six protocol variants
 * (arcgis_map / arcgis_feature / arcgis_image / wms / wfs / wmts);
 * per-protocol options surface in cards gated on `protocol`.
 *
 * Owns the item's data_json: URL, protocol version, layer list,
 * selectedLayerIds, format / CRS / output options. Edits stage
 * locally; Save PATCHes the item's `data` JSON. Re-probe refreshes
 * the layer snapshot from the live server, preserving prior
 * selection where the probed names still match. The auto-detect
 * probe is the same one the wizard uses, so a service that flips
 * protocol on the server side (rare but possible) updates the
 * item's protocol cleanly via re-probe.
 *
 * No feature payload lives here: like the legacy per-protocol items,
 * `service` is a live pointer. The runtime (map editor, item-detail
 * preview, basemap composer) resolves URL + selected layers and
 * renders directly against the remote server.
 */
export function ServiceEditor({ itemId, initial, canEdit }: Props) {
  const router = useRouter();
  const [data, setData] = useState<ServiceData>(initial);
  const [urlDraft, setUrlDraft] = useState(data.url);
  const [probing, setProbing] = useState(false);
  const [probeError, setProbeError] = useState<string | null>(null);
  const [pendingData, setPendingData] = useState<ServiceData | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  // Selection by name (rather than by index) so re-probe preserves
  // the user's curated subset across server-side reorderings. Same
  // approach OgcServiceEditor (#299) uses.
  const initialSelectedNames = new Set<string>(
    (data.selectedLayerIds && data.selectedLayerIds.length > 0
      ? data.selectedLayerIds
      : data.layers.map((_, i) => i)
    )
      .map((i) => data.layers[i]?.name ?? '')
      .filter((n) => n.length > 0),
  );
  const [selectedNames, setSelectedNames] = useState<Set<string>>(
    initialSelectedNames,
  );

  // Active staged shape -- merges the saved data with any uncommitted
  // probe result. Save commits this.
  const staged: ServiceData = pendingData ?? data;
  const stagedSelectedIds = staged.layers
    .map((l, i) => (selectedNames.has(l.name) ? i : -1))
    .filter((i) => i >= 0);

  const storedSelectedIds: number[] = (data.selectedLayerIds ?? []).map(
    (id) => (typeof id === 'number' ? id : Number(id)),
  );
  const hasChanges =
    pendingData !== null ||
    arraysDiffer(stagedSelectedIds, storedSelectedIds) ||
    optionsDiffer(staged, data);

  async function runProbe() {
    if (!canEdit) return;
    const raw = urlDraft.trim();
    if (!raw) {
      setProbeError('URL is required.');
      return;
    }
    setProbeError(null);
    setProbing(true);
    try {
      const result = await autoProbeService(raw);
      // Carry forward selection by name. Layers that disappeared
      // drop out; new layers stay unselected so the author opts
      // them in deliberately. Empty prior selection (legacy item)
      // defaults to "all selected" for the same reason as #299.
      const nextNames = new Set<string>();
      for (const l of result.data.layers) {
        if (selectedNames.has(l.name)) nextNames.add(l.name);
      }
      if (nextNames.size === 0 && selectedNames.size === 0) {
        for (const l of result.data.layers) nextNames.add(l.name);
      }
      setSelectedNames(nextNames);
      setPendingData(result.data);
    } catch (err) {
      setProbeError(
        err instanceof Error
          ? err.message
          : 'Could not read that service.',
      );
    } finally {
      setProbing(false);
    }
  }

  function discardProbe() {
    setPendingData(null);
    setProbeError(null);
    setUrlDraft(data.url);
    const resetIndices: number[] = data.selectedLayerIds
      ? data.selectedLayerIds
          .map((id) => (typeof id === 'number' ? id : Number(id)))
          .filter((n) => Number.isInteger(n))
      : data.layers.map((_, i) => i);
    setSelectedNames(
      new Set(
        resetIndices
          .map((i) => data.layers[i]?.name ?? '')
          .filter((n) => n.length > 0),
      ),
    );
  }

  async function save() {
    if (!canEdit) return;
    setError(null);
    setSaving(true);
    try {
      const payload: ServiceData = {
        ...staged,
        selectedLayerIds: stagedSelectedIds,
      };
      const res = await fetch(`/api/portal/items/${itemId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ data: payload }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        setError(`Save failed: ${res.status}${body ? ` - ${body}` : ''}`);
        return;
      }
      setData(payload);
      setPendingData(null);
      setProbeError(null);
      setSaved(true);
      startTransition(() => router.refresh());
      setTimeout(() => setSaved(false), 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed.');
    } finally {
      setSaving(false);
    }
  }

  const protocolPrettyLabel = serviceProtocolLabel(staged.protocol);
  const layerWord = layerWordFor(staged.protocol);
  const capabilitiesLink = capabilitiesUrlFor(staged);

  return (
    <div className="space-y-4">
      {/* Connection card. */}
      <section className="rounded-lg border border-border bg-surface-1 p-4 shadow-card">
        <div className="mb-1 flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-medium text-ink-0">Connection</h2>
          <span className="rounded border border-accent/40 bg-accent/10 px-1.5 py-0.5 text-2xs font-medium uppercase tracking-wide text-accent">
            {protocolPrettyLabel}
          </span>
        </div>
        <p className="mb-3 text-xs text-muted">
          {staged.serviceTitle ? (
            <>
              <span className="font-medium text-ink-0">{staged.serviceTitle}</span>
              {' · '}
            </>
          ) : null}
          probed {staged.probedAt ? formatRelative(staged.probedAt) : 'not yet'}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="url"
            inputMode="url"
            value={urlDraft}
            onChange={(e) => setUrlDraft(e.target.value)}
            disabled={!canEdit || probing}
            className="h-9 min-w-0 flex-1 rounded-md border border-border bg-surface-1 px-2 font-mono text-sm"
          />
          {capabilitiesLink ? (
            <a
              href={capabilitiesLink}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-9 items-center gap-1 rounded-md border border-border bg-surface-1 px-2 text-xs text-ink-1 hover:bg-surface-2"
              title={
                staged.protocol.startsWith('arcgis_')
                  ? 'Open service root JSON in a new tab'
                  : 'Open GetCapabilities in a new tab'
              }
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          ) : null}
          {canEdit ? (
            <button
              type="button"
              onClick={runProbe}
              disabled={probing}
              className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border bg-surface-1 px-3 text-xs font-medium text-ink-1 hover:bg-surface-2 disabled:opacity-50"
            >
              {probing ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" />
              )}
              {probing ? 'Probing...' : 'Re-probe'}
            </button>
          ) : null}
        </div>
        {probeError ? (
          <p className="mt-2 text-xs text-danger" role="alert">
            {probeError}
          </p>
        ) : null}
        <ProtocolOptions
          data={staged}
          canEdit={canEdit}
          onChange={(patch) => {
            // Per-protocol options edit the saved `data` (or the
            // pending probe result) directly. Stage on whichever is
            // currently active so a probe-pending edit doesn't drop
            // when the user toggles a format.
            if (pendingData) {
              setPendingData({ ...pendingData, ...patch } as ServiceData);
            } else {
              setData((d) => ({ ...d, ...patch } as ServiceData));
            }
          }}
        />
      </section>

      {/* Geocoder details (#75): GeocodeServers have no sublayer
          concept; render the address-field shape + capabilities
          read-only instead of the layer picker, which would just
          show "no layers" awkwardly. */}
      {staged.protocol === 'arcgis_geocode' ? (
        <GeocoderDetails data={staged} />
      ) : (
      <section className="rounded-lg border border-border bg-surface-1 p-4 shadow-card">
        <div className="mb-2 flex items-center justify-between gap-2">
          <h2 className="text-sm font-medium text-ink-0">
            {capitalize(layerWord)}
            {staged.layers.length === 1 ? '' : 's'}
          </h2>
          <div className="flex items-center gap-2 text-xs text-muted">
            <span>
              {selectedNames.size} of {staged.layers.length} selected
            </span>
            {canEdit ? (
              <>
                <button
                  type="button"
                  onClick={() =>
                    setSelectedNames(new Set(staged.layers.map((l) => l.name)))
                  }
                  className="h-7 rounded border border-border bg-surface-1 px-2 hover:bg-surface-2"
                >
                  Select all
                </button>
                <button
                  type="button"
                  onClick={() => setSelectedNames(new Set())}
                  className="h-7 rounded border border-border bg-surface-1 px-2 hover:bg-surface-2"
                >
                  Clear
                </button>
              </>
            ) : null}
          </div>
        </div>
        {staged.layers.length === 0 ? (
          <p className="text-xs text-muted">
            No {layerWord}s captured yet. Re-probe to load the list from the
            server.
          </p>
        ) : (
          <ul className="max-h-96 overflow-y-auto rounded border border-border bg-surface-2 text-xs">
            {staged.layers.map((l) => {
              const checked = selectedNames.has(l.name);
              const bboxLabel = l.bbox ? formatBbox(l.bbox) : '';
              return (
                <li
                  key={l.name}
                  className="flex items-start gap-2 border-b border-border px-2 py-1.5 last:border-0"
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={!canEdit}
                    onChange={() => {
                      if (!canEdit) return;
                      const next = new Set(selectedNames);
                      if (checked) next.delete(l.name);
                      else next.add(l.name);
                      setSelectedNames(next);
                    }}
                    className="mt-0.5"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-ink-0">
                      <span className="font-medium">{l.title}</span>
                      {l.title !== l.name ? (
                        <span className="ml-2 font-mono text-muted">
                          {l.name}
                        </span>
                      ) : null}
                      {l.geometryType ? (
                        <span className="ml-2 rounded border border-border bg-surface-1 px-1 py-0.5 text-2xs text-muted">
                          {l.geometryType}
                        </span>
                      ) : null}
                    </div>
                    {bboxLabel ? (
                      <div className="mt-0.5 truncate font-mono text-2xs text-muted">
                        {bboxLabel}
                      </div>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
      )}

      {/* Save / discard footer. */}
      {canEdit && hasChanges ? (
        <div className="sticky bottom-2 z-10 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-accent/40 bg-accent/5 p-3 text-sm shadow-card">
          <span className="text-ink-1">Unsaved changes.</span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={discardProbe}
              disabled={saving}
              className="h-9 rounded-md border border-border bg-surface-1 px-3 text-xs text-ink-1 hover:bg-surface-2 disabled:opacity-50"
            >
              Discard
            </button>
            <button
              type="button"
              onClick={save}
              disabled={saving}
              className="inline-flex h-9 items-center gap-1.5 rounded-md bg-accent px-3 text-xs font-medium text-accent-foreground shadow-card hover:opacity-90 disabled:opacity-50"
            >
              {saving ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : saved ? (
                <Check className="h-3.5 w-3.5" />
              ) : (
                <Save className="h-3.5 w-3.5" />
              )}
              {saving ? 'Saving...' : saved ? 'Saved' : 'Save'}
            </button>
          </div>
        </div>
      ) : null}
      {error ? (
        <p className="text-xs text-danger" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** Per-protocol rendering / connection options. Inline so the
 *  per-card layout in the connection section can keep them visually
 *  attached to the URL row. ArcGIS variants don't expose any options
 *  on this page in Phase 1 -- they may grow as we add image-server
 *  options + cached/dynamic toggles. */
function ProtocolOptions({
  data,
  canEdit,
  onChange,
}: {
  data: ServiceData;
  canEdit: boolean;
  onChange: (patch: Partial<ServiceData>) => void;
}) {
  if (data.protocol === 'wms') {
    return (
      <div className="mt-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
        <label className="block">
          <span className="text-muted">Format</span>
          <select
            value={data.format ?? 'image/png'}
            disabled={!canEdit}
            onChange={(e) =>
              onChange({ format: e.target.value } as Partial<ServiceData>)
            }
            className="mt-0.5 h-8 w-full rounded-md border border-border bg-surface-1 px-2"
          >
            <option value="image/png">image/png</option>
            <option value="image/jpeg">image/jpeg</option>
          </select>
        </label>
        <label className="block">
          <span className="text-muted">Transparent</span>
          <select
            value={data.transparent === false ? 'no' : 'yes'}
            disabled={!canEdit}
            onChange={(e) =>
              onChange({
                transparent: e.target.value === 'yes',
              } as Partial<ServiceData>)
            }
            className="mt-0.5 h-8 w-full rounded-md border border-border bg-surface-1 px-2"
          >
            <option value="yes">Yes</option>
            <option value="no">No</option>
          </select>
        </label>
        <label className="block">
          <span className="text-muted">CRS</span>
          <input
            type="text"
            value={data.crs ?? 'EPSG:3857'}
            disabled={!canEdit}
            onChange={(e) =>
              onChange({ crs: e.target.value } as Partial<ServiceData>)
            }
            className="mt-0.5 h-8 w-full rounded-md border border-border bg-surface-1 px-2 font-mono"
          />
        </label>
        <label className="block">
          <span className="text-muted">Version</span>
          <select
            value={data.protocolVersion}
            disabled={!canEdit}
            onChange={(e) =>
              onChange({
                protocolVersion: e.target.value,
              } as Partial<ServiceData>)
            }
            className="mt-0.5 h-8 w-full rounded-md border border-border bg-surface-1 px-2"
          >
            <option value="1.3.0">1.3.0</option>
            <option value="1.1.1">1.1.1</option>
          </select>
        </label>
      </div>
    );
  }
  if (data.protocol === 'wfs') {
    return (
      <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
        <label className="block">
          <span className="text-muted">Output format</span>
          <select
            value={data.outputFormat ?? 'application/json'}
            disabled={!canEdit}
            onChange={(e) =>
              onChange({ outputFormat: e.target.value } as Partial<ServiceData>)
            }
            className="mt-0.5 h-8 w-full rounded-md border border-border bg-surface-1 px-2"
          >
            <option value="application/json">application/json (GeoJSON)</option>
            <option value="GML2">GML 2</option>
            <option value="GML3">GML 3</option>
          </select>
        </label>
        <label className="block">
          <span className="text-muted">Version</span>
          <select
            value={data.protocolVersion}
            disabled={!canEdit}
            onChange={(e) =>
              onChange({
                protocolVersion: e.target.value,
              } as Partial<ServiceData>)
            }
            className="mt-0.5 h-8 w-full rounded-md border border-border bg-surface-1 px-2"
          >
            <option value="2.0.0">2.0.0</option>
            <option value="1.1.0">1.1.0</option>
          </select>
        </label>
      </div>
    );
  }
  if (data.protocol === 'wmts') {
    return (
      <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
        <label className="block">
          <span className="text-muted">Default tile matrix set</span>
          <input
            type="text"
            value={data.defaultTileMatrixSet ?? ''}
            disabled={!canEdit}
            placeholder="(per-layer)"
            onChange={(e) =>
              onChange({
                defaultTileMatrixSet: e.target.value || undefined,
              } as Partial<ServiceData>)
            }
            className="mt-0.5 h-8 w-full rounded-md border border-border bg-surface-1 px-2 font-mono"
          />
        </label>
        <label className="block">
          <span className="text-muted">Version</span>
          <input
            type="text"
            value={data.protocolVersion}
            disabled
            className="mt-0.5 h-8 w-full rounded-md border border-border bg-surface-2 px-2"
          />
        </label>
      </div>
    );
  }
  // ArcGIS variants: no options card today. Service version /
  // capabilities surface in the connection summary above.
  return null;
}

/**
 * Read-only details card for an ArcGIS GeocodeServer (#75). Replaces
 * the layer-picker section for `protocol === 'arcgis_geocode'` since
 * a geocoder has no sublayer concept. Shows the address-field input
 * shape, capability list, and country coverage the probe lifted from
 * the server's `?f=json` response. Editing requires re-probing the
 * source URL.
 */
function GeocoderDetails({ data }: { data: import('@gratis-gis/shared-types').ArcgisGeocodeService }) {
  return (
    <section className="rounded-lg border border-border bg-surface-1 p-4 shadow-card">
      <h2 className="mb-3 text-sm font-medium text-ink-0">Geocoder details</h2>
      <div className="grid grid-cols-1 gap-3 text-xs sm:grid-cols-2">
        <div className="rounded-md border border-border bg-surface-2 p-3">
          <p className="text-muted">Single-line address field</p>
          <p className="mt-0.5 font-mono text-ink-0">
            {data.singleLineFieldName ?? <span className="text-muted">(none)</span>}
          </p>
        </div>
        <div className="rounded-md border border-border bg-surface-2 p-3">
          <p className="text-muted">Capabilities</p>
          <p className="mt-0.5 text-ink-0">
            {data.capabilities && data.capabilities.length > 0
              ? data.capabilities.join(', ')
              : <span className="text-muted">(not advertised)</span>}
          </p>
        </div>
      </div>
      {data.addressFields && data.addressFields.length > 0 ? (
        <div className="mt-3">
          <p className="text-xs text-muted">Multi-line address fields</p>
          <ul className="mt-1 grid grid-cols-1 gap-1 sm:grid-cols-2">
            {data.addressFields.map((f) => (
              <li
                key={f.name}
                className="flex items-baseline gap-2 rounded border border-border bg-surface-2 px-2 py-1 text-xs"
              >
                <span className="font-mono text-ink-0">{f.name}</span>
                {f.alias && f.alias !== f.name ? (
                  <span className="text-muted">({f.alias})</span>
                ) : null}
                {f.required ? (
                  <span className="rounded bg-accent/10 px-1 text-2xs uppercase tracking-wide text-accent">
                    required
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {data.supportedCountries && data.supportedCountries.length > 0 ? (
        <div className="mt-3 text-xs">
          <p className="text-muted">Supported countries</p>
          <p className="mt-0.5 font-mono text-ink-1">
            {data.supportedCountries.join(', ')}
          </p>
        </div>
      ) : null}
      <p className="mt-3 text-2xs text-muted">
        Re-probe the source URL to refresh these fields after the
        server&rsquo;s configuration changes.
      </p>
    </section>
  );
}

/** Word a protocol uses for the addressable units it advertises. */
function layerWordFor(p: ServiceProtocol): string {
  if (p === 'wfs') return 'feature type';
  if (p === 'arcgis_feature') return 'feature layer';
  if (p === 'arcgis_image') return 'image';
  return 'layer';
}

/** Build a "preview the raw service response" link the user can open
 *  in a new tab. ArcGIS uses ?f=json on the service root; OGC trio
 *  uses GetCapabilities. */
function capabilitiesUrlFor(d: ServiceData): string | null {
  if (!d.url) return null;
  const base = d.url.replace(/\?.*$/, '').replace(/\/+$/, '');
  if (
    d.protocol === 'arcgis_map' ||
    d.protocol === 'arcgis_feature' ||
    d.protocol === 'arcgis_image' ||
    d.protocol === 'arcgis_geocode'
  ) {
    return `${base}?f=json`;
  }
  if (d.protocol === 'wms') {
    return `${base}?service=WMS&request=GetCapabilities&version=${d.protocolVersion}`;
  }
  if (d.protocol === 'wfs') {
    return `${base}?service=WFS&request=GetCapabilities&version=${d.protocolVersion}`;
  }
  if (d.protocol === 'wmts') {
    return `${base}?service=WMTS&request=GetCapabilities&version=1.0.0`;
  }
  return null;
}

function arraysDiffer(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return true;
  const sa = [...a].sort((x, y) => x - y);
  const sb = [...b].sort((x, y) => x - y);
  for (let i = 0; i < sa.length; i += 1) {
    if (sa[i] !== sb[i]) return true;
  }
  return false;
}

/** Compare per-protocol options between two ServiceData shapes. */
function optionsDiffer(a: ServiceData, b: ServiceData): boolean {
  if (a.protocol !== b.protocol) return true;
  if (a.url !== b.url) return true;
  if (a.protocol === 'wms' && b.protocol === 'wms') {
    if (a.protocolVersion !== b.protocolVersion) return true;
    if ((a.format ?? '') !== (b.format ?? '')) return true;
    if ((a.transparent ?? true) !== (b.transparent ?? true)) return true;
    if ((a.crs ?? '') !== (b.crs ?? '')) return true;
  }
  if (a.protocol === 'wfs' && b.protocol === 'wfs') {
    if (a.protocolVersion !== b.protocolVersion) return true;
    if ((a.outputFormat ?? '') !== (b.outputFormat ?? '')) return true;
  }
  if (a.protocol === 'wmts' && b.protocol === 'wmts') {
    if ((a.defaultTileMatrixSet ?? '') !== (b.defaultTileMatrixSet ?? '')) return true;
  }
  return false;
}

function formatBbox(b: [number, number, number, number]): string {
  const [w, s, e, n] = b;
  return `${w.toFixed(3)}, ${s.toFixed(3)} → ${e.toFixed(3)}, ${n.toFixed(3)}`;
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1);
}

function formatRelative(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    const ms = Date.now() - d.getTime();
    const sec = Math.round(ms / 1000);
    if (sec < 60) return 'just now';
    const min = Math.round(sec / 60);
    if (min < 60) return `${min}m ago`;
    const hr = Math.round(min / 60);
    if (hr < 24) return `${hr}h ago`;
    const day = Math.round(hr / 24);
    if (day < 30) return `${day}d ago`;
    return d.toLocaleDateString();
  } catch {
    return iso;
  }
}
