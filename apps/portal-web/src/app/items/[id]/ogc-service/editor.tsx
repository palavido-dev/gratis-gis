// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import { useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  Check,
  ExternalLink,
  Loader2,
  RefreshCw,
  Save,
} from 'lucide-react';
import type {
  ISODateString,
  WfsServiceData,
  WmsServiceData,
} from '@gratis-gis/shared-types';
import {
  DEFAULT_WFS_SERVICE,
  DEFAULT_WMS_SERVICE,
} from '@gratis-gis/shared-types';
import {
  probeWfs,
  probeWms,
  type OgcCapabilities,
} from '@/lib/ogc-rest';

type OgcKind = 'wms' | 'wfs';

interface Props {
  itemId: string;
  kind: OgcKind;
  initial: WmsServiceData | WfsServiceData;
  canEdit: boolean;
}

/**
 * Detail-page editor for wms_service / wfs_service items (#297 follow
 * up). Owns the item's dataJson: URL, protocol version, layer list,
 * which layers are selected for inclusion. Edits stage locally; Save
 * PATCHes the item's `data` JSON. Re-probe refreshes the layer
 * snapshot from the live server, preserving prior selection where the
 * probed names still match.
 *
 * Both protocols share the editor because WmsServiceData and
 * WfsServiceData are structurally parallel (url, protocolVersion,
 * layers, selectedLayerIds, bbox). Per-protocol fields surface in
 * sections gated on `kind`.
 *
 * No feature payload lives here: like arcgis_service these are live
 * pointers. The runtime (map editor, item-detail map preview)
 * resolves the URL + selected layers and renders directly against
 * the remote server.
 */
export function OgcServiceEditor({ itemId, kind, initial, canEdit }: Props) {
  const router = useRouter();
  const fallback = (
    kind === 'wms' ? DEFAULT_WMS_SERVICE : DEFAULT_WFS_SERVICE
  ) as WmsServiceData | WfsServiceData;
  const [data, setData] = useState<WmsServiceData | WfsServiceData>({
    ...fallback,
    ...initial,
  });
  const [urlDraft, setUrlDraft] = useState(data.url);
  const [probing, setProbing] = useState(false);
  const [probeResult, setProbeResult] = useState<OgcCapabilities | null>(null);
  const [probeError, setProbeError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  const abortRef = useRef<AbortController | null>(null);

  // Selection set kept in component state so checkbox edits are
  // immediate. Initialized from the stored selectedLayerIds (indices
  // into layers[]; the shared shape allows string|number for
  // arcgis_service compat, so we coerce + clamp here) and resolved
  // to a name set so re-probe keeps the same logical layers selected
  // even if their indices shift.
  const initialIndices: number[] = data.selectedLayerIds
    ? data.selectedLayerIds
        .map((id) => (typeof id === 'number' ? id : Number(id)))
        .filter((n) => Number.isInteger(n))
    : data.layers.map((_, i) => i);
  const initialSelectedNames = new Set<string>(
    initialIndices
      .map((i) => data.layers[i]?.name ?? '')
      .filter((n) => n.length > 0),
  );
  const [selectedNames, setSelectedNames] = useState<Set<string>>(
    initialSelectedNames,
  );

  // The staged view merges the saved data with any uncommitted probe
  // result. Save commits this; Discard goes back to data.
  const staged: WmsServiceData | WfsServiceData = probeResult
    ? ({
        ...data,
        url: probeResult.url,
        protocolVersion: probeResult.protocolVersion,
        layers: probeResult.layers.map((l) => {
          const out: { name: string; title?: string; bbox?: [number, number, number, number] } = {
            name: l.name,
          };
          if (l.title) out.title = l.title;
          if (l.bbox) out.bbox = l.bbox;
          return out;
        }),
        ...(probeResult.bbox ? { bbox: probeResult.bbox } : {}),
        probedAt: new Date().toISOString() as ISODateString,
      } as WmsServiceData | WfsServiceData)
    : data;

  // Effective selectedLayerIds for the staged shape: indices into
  // staged.layers whose name matches the user's selection set.
  const stagedSelectedIds = staged.layers
    .map((l, i) => (selectedNames.has(l.name) ? i : -1))
    .filter((i) => i >= 0);

  // Coerce stored ids to numbers for the diff (ArcGIS-compat shape
  // allows string|number).
  const storedSelectedIdsAsNums: number[] = (data.selectedLayerIds ?? []).map(
    (id) => (typeof id === 'number' ? id : Number(id)),
  );
  const hasChanges =
    probeResult !== null ||
    arraysDiffer(stagedSelectedIds, storedSelectedIdsAsNums) ||
    formatsDiffer(staged, data);

  async function runProbe() {
    if (!canEdit) return;
    const raw = urlDraft.trim();
    if (!raw) {
      setProbeError('URL is required.');
      return;
    }
    setProbeError(null);
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setProbing(true);
    try {
      const result =
        kind === 'wms'
          ? await probeWms(raw, controller.signal)
          : await probeWfs(raw, controller.signal);
      if (controller.signal.aborted) return;
      // Defensive: kind shouldn't change on re-probe of the same
      // item, but if a user pasted the wrong endpoint we surface a
      // clear error rather than silently mutating the item type.
      if (result.kind !== kind) {
        setProbeError(
          `That URL responded as ${result.kind.toUpperCase()}; expected ${kind.toUpperCase()}.`,
        );
        return;
      }
      setProbeResult(result);
      // Carry forward selection by name. Layers that disappeared
      // drop out; new layers stay unselected (the author has to opt
      // them in explicitly).
      const next = new Set<string>();
      for (const l of result.layers) {
        if (selectedNames.has(l.name)) next.add(l.name);
      }
      // If the prior selection was empty (e.g. legacy item), default
      // to selecting everything so the editor doesn't strand the user
      // with a pile of layers and no checks.
      if (next.size === 0 && selectedNames.size === 0) {
        for (const l of result.layers) next.add(l.name);
      }
      setSelectedNames(next);
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') return;
      setProbeError(
        err instanceof Error
          ? err.message
          : 'Could not read that service.',
      );
    } finally {
      if (!controller.signal.aborted) setProbing(false);
    }
  }

  function discardProbe() {
    setProbeResult(null);
    setProbeError(null);
    setUrlDraft(data.url);
    // Reset selection to the saved set. Same string|number coercion
    // as the initial state computation.
    const resetIndices: number[] = data.selectedLayerIds
      ? data.selectedLayerIds
          .map((id) => (typeof id === 'number' ? id : Number(id)))
          .filter((n) => Number.isInteger(n))
      : data.layers.map((_, i) => i);
    const reset = new Set<string>(
      resetIndices
        .map((i) => data.layers[i]?.name ?? '')
        .filter((n) => n.length > 0),
    );
    setSelectedNames(reset);
  }

  async function save() {
    if (!canEdit) return;
    setError(null);
    setSaving(true);
    try {
      const payload = {
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
      setProbeResult(null);
      setProbeError(null);
      setSaved(true);
      // Refresh the dependency panel + anything else server-rendered.
      startTransition(() => router.refresh());
      setTimeout(() => setSaved(false), 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed.');
    } finally {
      setSaving(false);
    }
  }

  const protocolLabel = kind === 'wms' ? 'WMS' : 'WFS';
  const layerWord = kind === 'wms' ? 'layer' : 'feature type';

  return (
    <div className="space-y-4">
      {/* Connection card. */}
      <section className="rounded-lg border border-border bg-surface-1 p-4 shadow-card">
        <h2 className="mb-1 text-sm font-medium text-ink-0">Connection</h2>
        <p className="mb-3 text-xs text-muted">
          {protocolLabel} {staged.protocolVersion} &middot; probed{' '}
          {staged.probedAt ? formatRelative(staged.probedAt) : 'not yet'}
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
          <a
            href={`${data.url}?service=${protocolLabel}&request=GetCapabilities`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-9 items-center gap-1 rounded-md border border-border bg-surface-1 px-2 text-xs text-ink-1 hover:bg-surface-2"
            title="Open GetCapabilities in a new tab"
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
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
        {kind === 'wms' ? (
          <WmsRenderingCard
            data={staged as WmsServiceData}
            canEdit={canEdit}
            onChange={(patch) =>
              setData((d) => ({ ...(d as WmsServiceData), ...patch }))
            }
          />
        ) : (
          <WfsOutputCard
            data={staged as WfsServiceData}
            canEdit={canEdit}
            onChange={(patch) =>
              setData((d) => ({ ...(d as WfsServiceData), ...patch }))
            }
          />
        )}
      </section>

      {/* Layer / feature-type picker. */}
      <section className="rounded-lg border border-border bg-surface-1 p-4 shadow-card">
        <div className="mb-2 flex items-center justify-between gap-2">
          <h2 className="text-sm font-medium text-ink-0">
            {kind === 'wms' ? 'Layers' : 'Feature types'}
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
                      <span className="font-medium">{l.title ?? l.name}</span>
                      {l.title && l.title !== l.name ? (
                        <span className="ml-2 font-mono text-muted">{l.name}</span>
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

/** WMS rendering options card: format, version, transparent, CRS.
 *  Lives inside the connection panel since these are connection
 *  parameters more than authoring choices. */
function WmsRenderingCard({
  data,
  canEdit,
  onChange,
}: {
  data: WmsServiceData;
  canEdit: boolean;
  onChange: (patch: Partial<WmsServiceData>) => void;
}) {
  return (
    <div className="mt-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
      <label className="block">
        <span className="text-muted">Format</span>
        <select
          value={data.format ?? 'image/png'}
          disabled={!canEdit}
          onChange={(e) => onChange({ format: e.target.value })}
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
          onChange={(e) => onChange({ transparent: e.target.value === 'yes' })}
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
          onChange={(e) => onChange({ crs: e.target.value })}
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
              protocolVersion: e.target.value as WmsServiceData['protocolVersion'],
            })
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

/** WFS rendering options card: outputFormat + version. */
function WfsOutputCard({
  data,
  canEdit,
  onChange,
}: {
  data: WfsServiceData;
  canEdit: boolean;
  onChange: (patch: Partial<WfsServiceData>) => void;
}) {
  return (
    <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
      <label className="block">
        <span className="text-muted">Output format</span>
        <select
          value={data.outputFormat ?? 'application/json'}
          disabled={!canEdit}
          onChange={(e) => onChange({ outputFormat: e.target.value })}
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
              protocolVersion: e.target.value as WfsServiceData['protocolVersion'],
            })
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

function arraysDiffer(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return true;
  const sa = [...a].sort((x, y) => x - y);
  const sb = [...b].sort((x, y) => x - y);
  for (let i = 0; i < sa.length; i += 1) {
    if (sa[i] !== sb[i]) return true;
  }
  return false;
}

function formatsDiffer(
  a: WmsServiceData | WfsServiceData,
  b: WmsServiceData | WfsServiceData,
): boolean {
  if (a.protocolVersion !== b.protocolVersion) return true;
  if ('format' in a && 'format' in b) {
    const aw = a as WmsServiceData;
    const bw = b as WmsServiceData;
    if ((aw.format ?? '') !== (bw.format ?? '')) return true;
    if ((aw.transparent ?? true) !== (bw.transparent ?? true)) return true;
    if ((aw.crs ?? '') !== (bw.crs ?? '')) return true;
  }
  if ('outputFormat' in a && 'outputFormat' in b) {
    const af = a as WfsServiceData;
    const bf = b as WfsServiceData;
    if ((af.outputFormat ?? '') !== (bf.outputFormat ?? '')) return true;
  }
  return false;
}

function formatBbox(b: [number, number, number, number]): string {
  const [w, s, e, n] = b;
  return `${w.toFixed(3)}, ${s.toFixed(3)} → ${e.toFixed(3)}, ${n.toFixed(3)}`;
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
