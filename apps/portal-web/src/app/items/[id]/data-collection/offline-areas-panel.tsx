// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  Loader2,
  Plus,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import type {
  DataCollectionData,
  Item,
  OfflineArea,
  OfflineAreaWithPackage,
} from '@gratis-gis/shared-types';
import {
  OFFLINE_PACKAGE_DEFAULT_MAX_ZOOM,
  estimateTileCount,
  validateOfflineArea,
} from '@gratis-gis/shared-types';
import { toast } from '@/lib/toast';
import { useConfirm } from '@/components/dialog-provider';

/**
 * Offline areas on a field deployment (#70).
 *
 * The portal cuts one map file per area and every collector
 * downloads that file. Before this, each collector's device fetched
 * map tiles one at a time, which for a county-sized deployment was
 * over a million requests and tens of gigabytes, aimed at map
 * servers that do not allow it.
 *
 * The author is never asked for coordinates. The extent comes from
 * the deployed map, which is the answer they would have typed
 * anyway, and the only real choice is how much detail to keep, so
 * that is the one control with plain-language options and a live
 * size estimate beside it.
 */

interface Props {
  itemId: string;
  data: DataCollectionData;
  canEdit: boolean;
}

/**
 * Detail levels, labelled by what you can make out at each. The
 * numbers are zoom levels; nobody outside GIS thinks in those, and
 * the size difference between them is what the author actually
 * cares about.
 */
const DETAIL_LEVELS: ReadonlyArray<{
  zoom: number;
  label: string;
  hint: string;
}> = [
  { zoom: 12, label: 'Roads and towns', hint: 'Smallest download' },
  { zoom: 13, label: 'Local streets', hint: '' },
  {
    zoom: 14,
    label: 'Street names and paths',
    hint: 'Recommended for field work',
  },
  { zoom: 15, label: 'Building outlines', hint: 'Largest download' },
];

const REFRESH_OPTIONS: ReadonlyArray<{ days: number | undefined; label: string }> =
  [
    { days: undefined, label: 'Only when I ask' },
    { days: 7, label: 'Weekly' },
    { days: 30, label: 'Monthly' },
    { days: 90, label: 'Every three months' },
  ];

/** ~5 KB per tile, measured against real extracts. */
function estimateBytes(tiles: number): number {
  return tiles * 5_200;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** Rough width and height of an extent, for a human sanity check. */
function describeExtent(bbox: [number, number, number, number]): string {
  const [w, s, e, n] = bbox;
  const midLat = ((s + n) / 2) * (Math.PI / 180);
  const kmPerDegLat = 111.32;
  const widthKm = (e - w) * kmPerDegLat * Math.cos(midLat);
  const heightKm = (n - s) * kmPerDegLat;
  const mi = (km: number) => Math.round(km * 0.621371);
  return `about ${mi(widthKm)} by ${mi(heightKm)} miles`;
}

export function OfflineAreasPanel({ itemId, data, canEdit }: Props) {
  const confirm = useConfirm();
  const [areas, setAreas] = useState<OfflineAreaWithPackage[]>([]);
  const [loading, setLoading] = useState(true);
  const [mapBbox, setMapBbox] = useState<
    [number, number, number, number] | null | undefined
  >(undefined);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [maxZoom, setMaxZoom] = useState(OFFLINE_PACKAGE_DEFAULT_MAX_ZOOM);
  const [refreshDays, setRefreshDays] = useState<number | undefined>(undefined);
  const [maxTiles, setMaxTiles] = useState(25_000);
  // Held in a ref so the poll effect can read the current areas
  // without re-subscribing every render and restarting its timer.
  const areasRef = useRef<OfflineAreaWithPackage[]>([]);
  areasRef.current = areas;

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/portal/items/${itemId}/offline-areas`);
      if (!res.ok) return;
      const body = (await res.json()) as {
        areas: OfflineAreaWithPackage[];
        maxTiles: number;
      };
      setAreas(body.areas);
      setMaxTiles(body.maxTiles);
    } finally {
      setLoading(false);
    }
  }, [itemId]);

  useEffect(() => {
    void load();
  }, [load]);

  // The deployed map's extent is the area extent. Reading it from
  // the map rather than asking the author for numbers is the whole
  // reason this panel has no coordinate fields.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/portal/items/${data.mapId}`);
        if (!res.ok) {
          if (!cancelled) setMapBbox(null);
          return;
        }
        const item = (await res.json()) as Item & { bbox?: number[] };
        const b = item.bbox;
        if (!cancelled) {
          setMapBbox(
            Array.isArray(b) && b.length === 4
              ? [b[0]!, b[1]!, b[2]!, b[3]!]
              : null,
          );
        }
      } catch {
        if (!cancelled) setMapBbox(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [data.mapId]);

  // Poll only while something is actually building. A panel that
  // polls forever is a request every few seconds per open tab, for
  // the whole time an author leaves the page sitting open.
  useEffect(() => {
    const anyPending = areas.some((a) => a.pending);
    if (!anyPending) return;
    const timer = setInterval(() => void load(), 4000);
    return () => clearInterval(timer);
  }, [areas, load]);

  async function saveAreas(next: OfflineArea[]): Promise<boolean> {
    const res = await fetch(`/api/portal/items/${itemId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: { ...data, offlineAreas: next } }),
    });
    if (!res.ok) {
      toast.error(`Could not save the area: ${res.status}`);
      return false;
    }
    return true;
  }

  async function addArea() {
    if (!mapBbox) return;
    const area: OfflineArea = {
      id: crypto.randomUUID(),
      name: name.trim(),
      bbox: mapBbox,
      minZoom: 0,
      maxZoom,
      ...(refreshDays === undefined ? {} : { refreshDays }),
    };
    const problem = validateOfflineArea(area);
    if (problem) {
      toast.error(problem);
      return;
    }
    setBusy(area.id);
    try {
      const existing = areas.map((a) => a.area);
      if (!(await saveAreas([...existing, area]))) return;
      // Build straight away. An area with no package is not a thing
      // anyone wanted; making the author press a second button just
      // adds a state where the feature looks broken.
      await fetch(
        `/api/portal/items/${itemId}/offline-areas/${area.id}/build`,
        { method: 'POST' },
      );
      setAdding(false);
      setName('');
      await load();
    } finally {
      setBusy(null);
    }
  }

  async function rebuild(areaId: string) {
    setBusy(areaId);
    try {
      const res = await fetch(
        `/api/portal/items/${itemId}/offline-areas/${areaId}/build`,
        { method: 'POST' },
      );
      if (!res.ok) {
        const text = await res.text();
        toast.error(text || `Could not start the build: ${res.status}`);
        return;
      }
      await load();
    } finally {
      setBusy(null);
    }
  }

  async function remove(areaId: string, areaName: string) {
    const ok = await confirm({
      title: 'Delete this area?',
      message: `Collectors will no longer be able to download "${areaName}". Anything already on a device stays there.`,
      confirmLabel: 'Delete',
      variant: 'danger',
    });
    if (!ok) return;
    setBusy(areaId);
    try {
      const next = areas.map((a) => a.area).filter((a) => a.id !== areaId);
      if (await saveAreas(next)) await load();
    } finally {
      setBusy(null);
    }
  }

  const estimate = mapBbox ? estimateTileCount(mapBbox, 0, maxZoom) : 0;
  const overCap = estimate > maxTiles;

  return (
    <section className="rounded-md border border-border bg-surface-1 p-4">
      <div className="mb-2 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted">
            <Download className="h-3.5 w-3.5" />
            Offline areas
          </h3>
          <p className="mt-1 text-xs text-muted">
            The portal prepares one map file per area. Collectors
            download it once instead of pulling the map in piece by
            piece, which is far faster and works where there is no
            signal at all.
          </p>
        </div>
        {canEdit && !adding && mapBbox ? (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-border bg-surface-1 px-2.5 text-xs font-medium text-ink-1 hover:bg-surface-2"
          >
            <Plus className="h-3.5 w-3.5" />
            Add area
          </button>
        ) : null}
      </div>

      {loading ? (
        <div className="flex items-center gap-2 py-2 text-xs text-muted">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Loading areas...
        </div>
      ) : null}

      {!loading && areas.length === 0 && !adding ? (
        <p className="py-2 text-xs text-muted">
          No areas yet.{' '}
          {mapBbox === null
            ? 'Add some data to the deployed map first, so there is an extent to prepare.'
            : 'Add one and collectors will be able to take this deployment offline.'}
        </p>
      ) : null}

      {areas.length > 0 ? (
        <ul className="divide-y divide-border rounded-md border border-border">
          {areas.map(({ area, current, pending, lastFailure }) => (
            <li key={area.id} className="flex items-start gap-3 px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-ink-0">
                  {area.name}
                </p>
                <p className="mt-0.5 text-2xs text-muted">
                  {describeExtent(area.bbox)} &middot;{' '}
                  {DETAIL_LEVELS.find((d) => d.zoom === area.maxZoom)?.label ??
                    `detail level ${area.maxZoom}`}
                  {area.refreshDays
                    ? ` · rebuilds every ${area.refreshDays} days`
                    : ''}
                </p>
                <p className="mt-1 flex items-center gap-1.5 text-2xs">
                  {pending ? (
                    <>
                      <Loader2 className="h-3 w-3 animate-spin text-accent" />
                      <span className="text-muted">
                        {pending.status === 'queued'
                          ? 'Waiting to start...'
                          : pending.tileCount
                            ? `Preparing ${pending.tileCount.toLocaleString()} tiles...`
                            : 'Preparing...'}
                      </span>
                    </>
                  ) : current ? (
                    <>
                      <CheckCircle2 className="h-3 w-3 text-success" />
                      <span className="text-muted">
                        Ready
                        {current.sizeBytes
                          ? `, ${formatBytes(current.sizeBytes)}`
                          : ''}
                        {current.finishedAt
                          ? ` · built ${new Date(current.finishedAt).toLocaleDateString()}`
                          : ''}
                      </span>
                    </>
                  ) : lastFailure ? (
                    <>
                      <AlertTriangle className="h-3 w-3 text-danger" />
                      <span className="text-danger">
                        {lastFailure.error ?? 'Could not be prepared.'}
                      </span>
                    </>
                  ) : (
                    <span className="text-muted">Not prepared yet.</span>
                  )}
                </p>
              </div>
              {canEdit ? (
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    onClick={() => void rebuild(area.id)}
                    disabled={!!pending || busy === area.id}
                    title={current ? 'Prepare again' : 'Prepare now'}
                    className="inline-flex h-7 w-7 items-center justify-center rounded border border-border bg-surface-1 text-muted transition-colors hover:bg-surface-2 hover:text-ink-1 disabled:opacity-40"
                  >
                    <RefreshCw className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => void remove(area.id, area.name)}
                    disabled={busy === area.id}
                    title="Delete area"
                    className="inline-flex h-7 w-7 items-center justify-center rounded border border-border bg-surface-1 text-muted transition-colors hover:bg-surface-2 hover:text-danger disabled:opacity-40"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {adding && mapBbox ? (
        <div className="mt-3 space-y-3 rounded-md border border-border bg-surface-2 p-3">
          <div>
            <label
              htmlFor="offline-area-name"
              className="mb-1 block text-2xs font-medium uppercase tracking-wide text-muted"
            >
              Name
            </label>
            <input
              id="offline-area-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Summer survey, north crew..."
              maxLength={120}
              className="h-9 w-full rounded-md border border-border bg-surface-1 px-3 text-sm focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
            />
          </div>
          <div>
            <label
              htmlFor="offline-area-detail"
              className="mb-1 block text-2xs font-medium uppercase tracking-wide text-muted"
            >
              How much detail
            </label>
            <select
              id="offline-area-detail"
              value={maxZoom}
              onChange={(e) => setMaxZoom(Number(e.target.value))}
              className="h-9 w-full rounded-md border border-border bg-surface-1 px-2 text-sm focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
            >
              {DETAIL_LEVELS.map((d) => (
                <option key={d.zoom} value={d.zoom}>
                  {d.label}
                  {d.hint ? ` (${d.hint})` : ''}
                </option>
              ))}
            </select>
            <p className="mt-1 text-2xs text-muted">
              Collectors can always zoom in further than this. Past a
              point the map just stops adding new labels.
            </p>
          </div>
          <div>
            <label
              htmlFor="offline-area-refresh"
              className="mb-1 block text-2xs font-medium uppercase tracking-wide text-muted"
            >
              Keep it up to date
            </label>
            <select
              id="offline-area-refresh"
              value={refreshDays ?? ''}
              onChange={(e) =>
                setRefreshDays(
                  e.target.value === '' ? undefined : Number(e.target.value),
                )
              }
              className="h-9 w-full rounded-md border border-border bg-surface-1 px-2 text-sm focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
            >
              {REFRESH_OPTIONS.map((o) => (
                <option key={o.label} value={o.days ?? ''}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          <div
            className={`rounded border px-2 py-1.5 text-2xs ${
              overCap
                ? 'border-danger/40 bg-danger/10 text-danger'
                : 'border-border bg-surface-1 text-muted'
            }`}
          >
            {overCap ? (
              <>
                This area is too big at that detail level. Choose less
                detail, or split the deployment into more than one area.
              </>
            ) : (
              <>
                Covers {describeExtent(mapBbox)}. Roughly{' '}
                {formatBytes(estimateBytes(estimate))} to download. The
                exact figure is measured before anything is prepared.
              </>
            )}
          </div>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => {
                setAdding(false);
                setName('');
              }}
              className="inline-flex h-8 items-center rounded-md border border-border bg-surface-1 px-3 text-xs font-medium text-ink-1 hover:bg-surface-2"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void addArea()}
              disabled={!name.trim() || overCap || busy !== null}
              className="inline-flex h-8 items-center gap-1 rounded-md bg-accent px-3 text-xs font-medium text-accent-foreground hover:opacity-90 disabled:opacity-50"
            >
              {busy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Plus className="h-3.5 w-3.5" />
              )}
              Add and prepare
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
