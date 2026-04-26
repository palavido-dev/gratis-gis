'use client';

import { useCallback, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  Check,
  ExternalLink,
  Loader2,
  RefreshCw,
  Save,
  Search,
} from 'lucide-react';
import type { ArcgisServiceData, ISODateString } from '@gratis-gis/shared-types';
import {
  DEFAULT_ARCGIS_SERVICE,
} from '@gratis-gis/shared-types';
import {
  describeArcgisService,
  probeService,
  type ArcgisServiceDescription,
} from '@/lib/arcgis-rest';

interface Props {
  itemId: string;
  initial: ArcgisServiceData;
  canEdit: boolean;
}

/**
 * Detail-page editor for an arcgis_service item. Owns the item's
 * dataJson: the service URL, service type, default sublayer, and the
 * snapshot of sublayers that the Add Layer picker reads. Users can
 * paste a URL and probe the service; probe results are staged and
 * saved together so the item's data is always internally consistent
 * (url, serviceType, and layer list all come from the same probe).
 *
 * No feature payload lives here: arcgis_service is a live pointer,
 * so the runtime (web-map viewer) is what actually calls the service.
 */
export function ArcgisServiceEditor({ itemId, initial, canEdit }: Props) {
  const router = useRouter();
  const [data, setData] = useState<ArcgisServiceData>({
    ...DEFAULT_ARCGIS_SERVICE,
    ...initial,
  });
  const [urlDraft, setUrlDraft] = useState(data.url);
  const [probing, setProbing] = useState(false);
  const [probeResult, setProbeResult] =
    useState<ArcgisServiceDescription | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  const abortRef = useRef<AbortController | null>(null);

  // The "staged" view merges existing saved values with whatever the
  // probe returned. Once the user commits via Save, staged becomes
  // data and the probe result is cleared.
  const stagedDefault = (() => {
    if (!probeResult) return data.defaultLayerId;
    if (
      data.defaultLayerId != null &&
      probeResult.layers.some((l) => l.id === data.defaultLayerId)
    ) {
      return data.defaultLayerId;
    }
    const firstGeom = probeResult.layers.find((l) => l.geometryType);
    return firstGeom?.id ?? probeResult.layers[0]?.id;
  })();
  const staged: ArcgisServiceData = probeResult
    ? {
        ...data,
        url: probeResult.url,
        serviceType: probeResult.serviceType,
        layers: probeResult.layers.map((l) => {
          const base: { id: number; name: string; geometryType?: string } = {
            id: l.id,
            name: l.name,
          };
          if (l.geometryType) base.geometryType = l.geometryType;
          return base;
        }),
        ...(probeResult.bbox ? { bbox: probeResult.bbox } : {}),
        // defaultLayerId only included when resolved: the shared
        // type has it as optional, and exactOptionalPropertyTypes
        // means we need to omit rather than pass `undefined`.
        ...(stagedDefault !== undefined
          ? { defaultLayerId: stagedDefault }
          : {}),
        // Re-probing preserves existing selection when the probed
        // layer ids overlap; new ids discovered in the probe are
        // added to the selection so the 'all layers selected' default
        // extends to new additions. Items without a prior selection
        // (legacy) get 'all' on probe.
        selectedLayerIds: (() => {
          const prev = data.selectedLayerIds
            ? new Set(data.selectedLayerIds.map(String))
            : null;
          const ids = probeResult.layers.map((l) => l.id);
          if (!prev) return ids;
          const keptOrAdded = ids.filter(
            (id) => prev.has(String(id)) || !data.layers.some((dl) => dl.id === id),
          );
          return keptOrAdded.length > 0 ? keptOrAdded : ids;
        })(),
        probedAt: new Date().toISOString() as ISODateString,
      }
    : data;

  // Current effective selection (incl. 'all' fallback for legacy items).
  const effectiveSelected = new Set(
    (staged.selectedLayerIds
      ? staged.selectedLayerIds.map(String)
      : staged.layers.map((l) => String(l.id))),
  );

  const hasChanges =
    probeResult !== null ||
    staged.defaultLayerId !== data.defaultLayerId ||
    staged.url !== data.url ||
    // Selection or config diffs
    !sameIdSet(
      staged.selectedLayerIds ?? staged.layers.map((l) => l.id),
      data.selectedLayerIds ?? data.layers.map((l) => l.id),
    ) ||
    JSON.stringify(staged.layerConfig ?? {}) !==
      JSON.stringify(data.layerConfig ?? {});

  const toggleSelected = (id: number) => {
    const currentIds = staged.selectedLayerIds
      ? staged.selectedLayerIds.map(String)
      : staged.layers.map((l) => String(l.id));
    const asStr = String(id);
    const next = currentIds.includes(asStr)
      ? currentIds.filter((i) => i !== asStr)
      : [...currentIds, asStr];
    setData((prev) => ({
      ...prev,
      selectedLayerIds: next.map((s) => Number(s)),
    }));
  };

  const setLayerLabel = (id: number, label: string) => {
    const key = String(id);
    const next = { ...(staged.layerConfig ?? {}) };
    const trimmed = label.trim();
    if (trimmed) {
      next[key] = { ...next[key], label: trimmed };
    } else if (next[key]) {
      const { label: _l, ...rest } = next[key]!;
      void _l;
      if (Object.keys(rest).length === 0) delete next[key];
      else next[key] = rest;
    }
    setData((prev) => ({ ...prev, layerConfig: next }));
  };

  const selectAll = () =>
    setData((prev) => ({
      ...prev,
      selectedLayerIds: staged.layers.map((l) => l.id),
    }));
  const selectNone = () =>
    setData((prev) => ({ ...prev, selectedLayerIds: [] }));
  const selectSpatial = () =>
    setData((prev) => ({
      ...prev,
      selectedLayerIds: staged.layers
        .filter((l) => l.geometryType)
        .map((l) => l.id),
    }));

  const runProbe = useCallback(async () => {
    const raw = urlDraft.trim();
    if (!raw) {
      setError('Paste an ArcGIS MapServer or FeatureServer URL.');
      return;
    }
    setError(null);
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setProbing(true);
    try {
      let desc: ArcgisServiceDescription;
      if (data.requiresAuth) {
        // Route through the per-item proxy so the stored
        // credential is applied server-side. The proxy also
        // exchanges Basic for an ArcGIS token under the hood
        // when the upstream is an ArcGIS REST URL (#76, #79).
        // We hit /proxy?f=json so the proxy lands at the
        // service root with the JSON format param.
        const res = await fetch(
          `/api/portal/items/${itemId}/proxy?f=json`,
          { signal: controller.signal },
        );
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          throw new Error(
            `Proxy returned ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`,
          );
        }
        const json = (await res.json()) as unknown;
        // ArcGIS often returns 200 with an error envelope when
        // the token is invalid or expired. Treat that as a
        // probe failure so the user gets a clear message.
        if (
          json &&
          typeof json === 'object' &&
          'error' in (json as Record<string, unknown>)
        ) {
          const err = (json as {
            error?: { message?: unknown; code?: unknown };
          }).error;
          const msg =
            typeof err?.message === 'string' ? err.message : 'ArcGIS error';
          throw new Error(msg);
        }
        desc = await describeArcgisService(raw, json, controller.signal);
      } else {
        desc = await probeService(raw, controller.signal);
      }
      if (controller.signal.aborted) return;
      setProbeResult(desc);
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') return;
      setError(
        (err as Error).message ||
          'Could not read that service. Check the URL and CORS config.',
      );
    } finally {
      if (!controller.signal.aborted) setProbing(false);
    }
  }, [urlDraft, itemId, data.requiresAuth]);

  async function save() {
    setError(null);
    setSaving(true);
    try {
      const res = await fetch(`/api/portal/items/${itemId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ data: staged }),
      });
      if (!res.ok) {
        setError(`Save failed: ${res.status} ${await res.text()}`);
        return;
      }
      setData(staged);
      setProbeResult(null);
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
      startTransition(() => router.refresh());
    } finally {
      setSaving(false);
    }
  }

  return (
    <div id="configure-arcgis" className="space-y-5">
      <div className="rounded-lg border border-border bg-surface-1 p-4">
        <h3 className="mb-1 text-sm font-semibold">Service endpoint</h3>
        <p className="mb-3 text-xs text-muted">
          Paste the service root (<code>.../MapServer</code> or{' '}
          <code>.../FeatureServer</code>) or a specific layer URL. The
          viewer queries features live by bbox as authors pan and zoom.
        </p>
        <div className="flex gap-2">
          <input
            type="url"
            value={urlDraft}
            onChange={(e) => setUrlDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void runProbe();
              }
            }}
            disabled={!canEdit}
            placeholder="https://host/arcgis/rest/services/OpenData/Assessor/MapServer"
            className="h-9 min-w-0 flex-1 rounded-md border border-border bg-surface-1 px-3 text-sm focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30 disabled:opacity-60"
          />
          <button
            type="button"
            onClick={() => void runProbe()}
            disabled={!canEdit || probing || !urlDraft.trim()}
            className="inline-flex h-9 items-center gap-1 rounded-md border border-border bg-surface-1 px-3 text-xs font-medium text-ink-1 hover:bg-surface-2 disabled:opacity-50"
          >
            {probing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Search className="h-3.5 w-3.5" />
            )}
            Probe
          </button>
        </div>
        {data.url && !probeResult ? (
          <p className="mt-3 flex items-center gap-1 text-xs text-muted">
            <ExternalLink className="h-3 w-3" />
            <a
              href={`${data.url}?f=html`}
              target="_blank"
              rel="noreferrer"
              className="underline hover:text-ink-1"
            >
              Open the service page
            </a>
            <span className="mx-1">•</span>
            {data.serviceType}
            {data.probedAt ? (
              <>
                <span className="mx-1">•</span>
                last probed {formatDate(data.probedAt)}
              </>
            ) : null}
          </p>
        ) : null}
      </div>

      <CredentialsCard
        itemId={itemId}
        canEdit={canEdit}
        requiresAuth={!!data.requiresAuth}
        onToggleRequiresAuth={async (next) => {
          // Persist the flag against the item's data so the layer
          // source reads it when constructing the fetch URL.
          // Optimistic local state with rollback on failure.
          const prev = data.requiresAuth;
          setData((d) => ({ ...d, requiresAuth: next }));
          try {
            const res = await fetch(`/api/portal/items/${itemId}`, {
              method: 'PATCH',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                data: { ...data, requiresAuth: next },
              }),
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            startTransition(() => router.refresh());
          } catch (err) {
            setData((d) => ({ ...d, requiresAuth: prev ?? false }));
            setError(
              err instanceof Error
                ? err.message
                : 'Could not toggle proxy auth.',
            );
          }
        }}
      />

      {staged.layers.length > 0 ? (
        <div className="rounded-lg border border-border bg-surface-1 p-4">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="text-sm font-semibold">
                Layers
                <span className="ml-1.5 text-xs font-normal text-muted">
                  ({effectiveSelected.size} of {staged.layers.length}{' '}
                  selected)
                </span>
              </h3>
              <p className="text-xs text-muted">
                Check which layers this item exposes. Unchecked layers
                stay in the upstream service but won&apos;t appear when
                maps consume this item. Star the default layer.
              </p>
            </div>
            <div className="flex items-center gap-1">
              {canEdit ? (
                <>
                  <button
                    type="button"
                    onClick={selectAll}
                    className="h-7 rounded border border-border bg-surface-1 px-2 text-[11px] text-muted hover:bg-surface-2 hover:text-ink-1"
                  >
                    All
                  </button>
                  <button
                    type="button"
                    onClick={selectNone}
                    className="h-7 rounded border border-border bg-surface-1 px-2 text-[11px] text-muted hover:bg-surface-2 hover:text-ink-1"
                  >
                    None
                  </button>
                  <button
                    type="button"
                    onClick={selectSpatial}
                    title="Only layers with geometry"
                    className="h-7 rounded border border-border bg-surface-1 px-2 text-[11px] text-muted hover:bg-surface-2 hover:text-ink-1"
                  >
                    Spatial only
                  </button>
                </>
              ) : null}
              {probeResult ? (
                <button
                  type="button"
                  onClick={() => setProbeResult(null)}
                  className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-surface-1 px-2 text-[11px] text-muted hover:bg-surface-2"
                  title="Discard probe result"
                >
                  <RefreshCw className="h-3 w-3" />
                  Discard probe
                </button>
              ) : null}
            </div>
          </div>
          <ul className="max-h-96 space-y-0.5 overflow-y-auto rounded border border-border bg-surface-0 p-1">
            {staged.layers.map((l) => {
              const included = effectiveSelected.has(String(l.id));
              const isDefault = l.id === staged.defaultLayerId;
              const override = staged.layerConfig?.[String(l.id)];
              const currentLabel = override?.label ?? '';
              return (
                <li
                  key={l.id}
                  className={`grid grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-2 rounded px-2 py-1.5 text-xs ${
                    included ? 'bg-surface-1' : 'opacity-60'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={included}
                    onChange={() => toggleSelected(l.id)}
                    disabled={!canEdit}
                    className="h-3.5 w-3.5 rounded border-border text-accent focus:ring-accent/30 disabled:opacity-50"
                    aria-label={`Include layer ${l.name}`}
                  />
                  <div className="min-w-0">
                    <p className="truncate text-ink-1">
                      <span className="tabular-nums text-muted">{l.id}</span>{' '}
                      {l.name}
                    </p>
                    {canEdit ? (
                      <input
                        type="text"
                        value={currentLabel}
                        onChange={(e) => setLayerLabel(l.id, e.target.value)}
                        placeholder="Override display label (optional)"
                        disabled={!canEdit || !included}
                        className="mt-0.5 h-6 w-full rounded border border-border bg-surface-0 px-1.5 text-[11px] focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30 disabled:opacity-50"
                      />
                    ) : override?.label ? (
                      <p className="mt-0.5 text-[11px] text-muted">
                        label override:{' '}
                        <span className="text-ink-1">{override.label}</span>
                      </p>
                    ) : null}
                  </div>
                  <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted">
                    {geometryShort(l.geometryType)}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      if (!included) {
                        // Auto-include a layer when the user marks it
                        // as default, since a default that isn't in
                        // the selection makes no sense.
                        toggleSelected(l.id);
                      }
                      setData((prev) => ({ ...prev, defaultLayerId: l.id }));
                    }}
                    disabled={!canEdit}
                    aria-pressed={isDefault}
                    title={
                      isDefault
                        ? 'Default layer for maps consuming this item'
                        : 'Make this the default layer'
                    }
                    className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                      isDefault
                        ? 'bg-accent/15 text-accent'
                        : 'text-muted hover:bg-surface-2 hover:text-ink-1'
                    } disabled:opacity-50`}
                  >
                    {isDefault ? 'DEFAULT' : 'set default'}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}

      {canEdit ? (
        <div className="flex items-center justify-end gap-2">
          {saved ? (
            <span className="inline-flex items-center gap-1 text-xs text-success">
              <Check className="h-3.5 w-3.5" /> Saved
            </span>
          ) : null}
          <button
            type="button"
            onClick={save}
            disabled={saving || !hasChanges}
            className="inline-flex h-9 items-center gap-1.5 rounded-md bg-accent px-3 text-sm font-medium text-accent-foreground shadow-card hover:opacity-90 disabled:opacity-50"
          >
            {saving ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Save className="h-3.5 w-3.5" />
            )}
            Save
          </button>
        </div>
      ) : null}
    </div>
  );
}

function geometryShort(g?: string): string {
  if (!g) return 'table';
  const m = g.match(/esriGeometry(\w+)/);
  return (m?.[1] ?? g).toLowerCase();
}

/**
 * Stored-credentials editor for an arcgis_service item (#36).
 *
 * Two layers:
 *   - "Use proxied auth" toggle on the item itself (writes
 *     ArcgisServiceData.requiresAuth). When on, layer-source
 *     fetches go through /api/items/:id/proxy/... server-side
 *     instead of the upstream URL directly.
 *   - Credential editor: kind dropdown + per-kind fields (token,
 *     or username + password). Saves via PUT /credential. The
 *     plaintext NEVER round-trips back from the server -- once
 *     stored, the editor only knows whether a credential is
 *     configured ("hasSecret: true") and offers to overwrite or
 *     clear it.
 */
function CredentialsCard({
  itemId,
  canEdit,
  requiresAuth,
  onToggleRequiresAuth,
}: {
  itemId: string;
  canEdit: boolean;
  requiresAuth: boolean;
  onToggleRequiresAuth: (next: boolean) => void | Promise<void>;
}) {
  type Meta = {
    kind: 'bearer' | 'basic' | 'arcgis_token';
    hasSecret: true;
    updatedAt: string;
    updatedBy: string;
  } | { hasSecret: false };
  const [meta, setMeta] = useState<Meta | null>(null);
  const [loading, setLoading] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [kindDraft, setKindDraft] = useState<
    'bearer' | 'basic' | 'arcgis_token'
  >('bearer');
  const [tokenDraft, setTokenDraft] = useState('');
  const [usernameDraft, setUsernameDraft] = useState('');
  const [passwordDraft, setPasswordDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const res = await fetch(`/api/portal/items/${itemId}/credential`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setMeta((await res.json()) as Meta);
    } catch (e) {
      setErr(
        e instanceof Error ? e.message : 'Could not load credential state.',
      );
    } finally {
      setLoading(false);
    }
  }, [itemId]);

  // Load on mount + whenever the toggle flips on (the flip is a
  // signal that the user is actively configuring auth and the
  // metadata may have changed via another tab).
  if (canEdit && meta === null && !loading) {
    void refresh();
  }

  async function saveCredential() {
    setBusy(true);
    setErr(null);
    try {
      const body: Record<string, unknown> = { kind: kindDraft };
      if (kindDraft === 'bearer' || kindDraft === 'arcgis_token') {
        if (!tokenDraft) throw new Error('Token is required.');
        body.token = tokenDraft;
      } else {
        if (!usernameDraft || !passwordDraft) {
          throw new Error('Username and password are required.');
        }
        body.username = usernameDraft;
        body.password = passwordDraft;
      }
      const res = await fetch(`/api/portal/items/${itemId}/credential`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(text || `HTTP ${res.status}`);
      }
      // Clear drafts so a screenshot of the editor right after save
      // doesn't surface the secret. Server doesn't echo the plaintext
      // back, but the local state could.
      setTokenDraft('');
      setPasswordDraft('');
      setEditorOpen(false);
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Save failed.');
    } finally {
      setBusy(false);
    }
  }

  async function clearCredential() {
    if (!window.confirm('Remove the stored credential for this item?')) {
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(`/api/portal/items/${itemId}/credential`, {
        method: 'DELETE',
      });
      if (!res.ok && res.status !== 204) {
        throw new Error(`HTTP ${res.status}`);
      }
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Delete failed.');
    } finally {
      setBusy(false);
    }
  }

  const hasSecret = meta?.hasSecret === true;

  return (
    <div className="rounded-lg border border-border bg-surface-1 p-4">
      <h3 className="mb-1 text-sm font-semibold">Authentication</h3>
      <p className="mb-3 text-xs text-muted">
        Some ArcGIS services require a token or username/password. When
        enabled, the portal stores the credential server-side (encrypted
        at rest) and proxies layer requests through it -- the browser
        never sees the secret.
      </p>
      <label className="mb-3 flex items-center gap-2 text-xs">
        <input
          type="checkbox"
          checked={requiresAuth}
          disabled={!canEdit}
          onChange={(e) => void onToggleRequiresAuth(e.target.checked)}
          className="h-3.5 w-3.5 rounded border-border"
        />
        <span className="text-ink-1">Use proxied auth</span>
        <span className="text-muted">
          -- when on, layer fetches route through{' '}
          <code className="rounded bg-surface-2 px-1">
            /api/items/{itemId.slice(0, 8)}.../proxy
          </code>
          .
        </span>
      </label>
      {requiresAuth ? (
        <div className="space-y-2 rounded-md border border-border bg-surface-0 p-3 text-xs">
          {loading ? (
            <p className="text-muted">Loading credential status...</p>
          ) : hasSecret && meta && 'kind' in meta ? (
            <div className="flex items-center gap-2">
              <Check className="h-3.5 w-3.5 text-success" />
              <span className="text-ink-1">
                <strong>{meta.kind}</strong> credential set
              </span>
              <span className="text-muted">
                last updated {new Date(meta.updatedAt).toLocaleString()}
              </span>
              {canEdit ? (
                <div className="ml-auto flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => {
                      setKindDraft(meta.kind);
                      setEditorOpen(true);
                    }}
                    className="h-7 rounded border border-border bg-surface-1 px-2 text-[11px] text-ink-1 hover:bg-surface-2"
                  >
                    Replace
                  </button>
                  <button
                    type="button"
                    onClick={() => void clearCredential()}
                    disabled={busy}
                    className="h-7 rounded border border-danger/40 bg-surface-1 px-2 text-[11px] text-danger hover:bg-danger/5 disabled:opacity-50"
                  >
                    Clear
                  </button>
                </div>
              ) : null}
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <span className="text-muted">No credential configured.</span>
              {canEdit ? (
                <button
                  type="button"
                  onClick={() => setEditorOpen(true)}
                  className="ml-auto h-7 rounded border border-accent bg-accent px-2 text-[11px] font-medium text-white hover:bg-accent/90"
                >
                  Add credential
                </button>
              ) : null}
            </div>
          )}
          {editorOpen && canEdit ? (
            <div className="space-y-2 rounded border border-border bg-surface-1 p-3">
              <label className="flex flex-col gap-1">
                <span className="text-[10px] font-medium uppercase tracking-wide text-muted">
                  Kind
                </span>
                <select
                  value={kindDraft}
                  onChange={(e) =>
                    setKindDraft(e.target.value as typeof kindDraft)
                  }
                  className="h-7 rounded border border-border bg-surface-1 px-2 text-xs"
                >
                  <option value="bearer">
                    Bearer token (Authorization header)
                  </option>
                  <option value="arcgis_token">
                    ArcGIS token (?token= URL param)
                  </option>
                  <option value="basic">Basic auth (username + password)</option>
                </select>
              </label>
              {kindDraft === 'basic' ? (
                <>
                  <label className="flex flex-col gap-1">
                    <span className="text-[10px] font-medium uppercase tracking-wide text-muted">
                      Username
                    </span>
                    <input
                      type="text"
                      value={usernameDraft}
                      onChange={(e) => setUsernameDraft(e.target.value)}
                      autoComplete="off"
                      className="h-7 rounded border border-border bg-surface-1 px-2 text-xs"
                    />
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-[10px] font-medium uppercase tracking-wide text-muted">
                      Password
                    </span>
                    <input
                      type="password"
                      value={passwordDraft}
                      onChange={(e) => setPasswordDraft(e.target.value)}
                      autoComplete="new-password"
                      className="h-7 rounded border border-border bg-surface-1 px-2 text-xs"
                    />
                  </label>
                </>
              ) : (
                <label className="flex flex-col gap-1">
                  <span className="text-[10px] font-medium uppercase tracking-wide text-muted">
                    Token
                  </span>
                  <input
                    type="password"
                    value={tokenDraft}
                    onChange={(e) => setTokenDraft(e.target.value)}
                    autoComplete="off"
                    className="h-7 rounded border border-border bg-surface-1 px-2 font-mono text-xs"
                  />
                </label>
              )}
              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setEditorOpen(false);
                    setTokenDraft('');
                    setUsernameDraft('');
                    setPasswordDraft('');
                  }}
                  className="h-7 rounded border border-border bg-surface-1 px-2 text-[11px] text-ink-1 hover:bg-surface-2"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => void saveCredential()}
                  disabled={busy}
                  className="h-7 rounded border border-accent bg-accent px-2 text-[11px] font-medium text-white hover:bg-accent/90 disabled:opacity-50"
                >
                  {busy ? 'Saving...' : 'Save credential'}
                </button>
              </div>
            </div>
          ) : null}
          {err ? (
            <p role="alert" className="text-danger">
              {err}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  } catch {
    return iso;
  }
}

/**
 * Set-equality check for two id lists (strings or numbers), order
 * and duplicate insensitive. Used by the dirty check to decide
 * whether the selected-layer list differs from the saved state.
 */
function sameIdSet(
  a: Array<string | number>,
  b: Array<string | number>,
): boolean {
  if (a.length !== b.length) return false;
  const sa = new Set(a.map(String));
  for (const x of b) if (!sa.has(String(x))) return false;
  return true;
}
