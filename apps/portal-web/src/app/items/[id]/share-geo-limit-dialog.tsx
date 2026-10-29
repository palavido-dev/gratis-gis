// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Check,
  Loader2,
  MapPin,
  Save,
  Shapes,
  Trash2,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/dialog';
import { useT } from '@/lib/i18n/locale-context';

/**
 * Per-share "Restrict to area" editor.
 *
 * Shown from the sharing panel's row action menu. Lets an admin
 * associate a geographic clip with a share. After save, the principal
 * only sees features whose geometry intersects the clip (and items
 * whose bbox does).
 *
 * Three input paths:
 *   - **Boundary**: pick an existing geo_boundary item from the org's
 *     library. The share stores the item id; the API resolves the
 *     polygon at request time. Best when the same region recurs
 *     across many shares (the curated boundary stays the source of
 *     truth, even when an admin edits its geometry later).
 *   - **GeoJSON**: paste a Polygon / MultiPolygon / Feature /
 *     FeatureCollection. The share stores the polygon inline.
 *   - **Bounding box**: enter west / south / east / north; we
 *     synthesize a rectangular polygon and store it inline.
 *
 * Inline geometry and the boundary reference are mutually exclusive
 * at the API layer; the dialog's Save sends both fields and the
 * service writes whichever is non-null while clearing the other.
 */
export interface ShareGeoLimitSave {
  geoLimit: unknown | null;
  geoBoundaryId: string | null;
}

export interface BoundaryOption {
  id: string;
  title: string;
}

interface Props {
  principalLabel: string;
  initialGeoLimit: unknown | null;
  initialGeoBoundaryId: string | null;
  /** Pulled by the sharing panel from /api/items?type=geo_boundary. */
  boundaries: BoundaryOption[];
  saving: boolean;
  onSave: (next: ShareGeoLimitSave) => Promise<void> | void;
  onClose: () => void;
}

type Mode = 'boundary' | 'geojson' | 'bbox';

export function ShareGeoLimitDialog({
  principalLabel,
  initialGeoLimit,
  initialGeoBoundaryId,
  boundaries,
  saving,
  onSave,
  onClose,
}: Props) {
  const t = useT();
  // Default mode: 'boundary' if the share already references one,
  // else 'geojson' (covers both fresh shares and shares with an
  // inline polygon, because paste is the more familiar entry point).
  const [mode, setMode] = useState<Mode>(
    initialGeoBoundaryId ? 'boundary' : 'geojson',
  );
  const [text, setText] = useState(() =>
    initialGeoLimit ? JSON.stringify(initialGeoLimit, null, 2) : '',
  );
  const [minLng, setMinLng] = useState('');
  const [minLat, setMinLat] = useState('');
  const [maxLng, setMaxLng] = useState('');
  const [maxLat, setMaxLat] = useState('');
  const [boundaryId, setBoundaryId] = useState<string>(
    initialGeoBoundaryId ?? '',
  );
  const [error, setError] = useState<string | null>(null);

  // If the parent passes a fresh list and the current pick isn't in it
  // (boundary deleted, etc.), reset to the empty selection so the
  // Save button correctly disables until the admin picks something.
  useEffect(() => {
    if (
      boundaryId &&
      !boundaries.some((b) => b.id === boundaryId)
    ) {
      setBoundaryId('');
    }
  }, [boundaries, boundaryId]);

  const hasExisting =
    (initialGeoLimit !== null && initialGeoLimit !== undefined) ||
    !!initialGeoBoundaryId;

  // Parse and validate whatever the user has in the active input.
  // The dialog produces either an inline geometry or a boundary id;
  // the discriminator on the result tells `save` which API field to
  // populate. `null` here means "nothing entered yet" and disables
  // the Save button.
  const validated = useMemo<
    | { ok: true; kind: 'inline'; geometry: unknown; summary: string }
    | { ok: true; kind: 'boundary'; boundaryId: string; summary: string }
    | { ok: false; error: string }
    | null
  >(() => {
    if (mode === 'boundary') {
      if (!boundaryId) return null;
      const picked = boundaries.find((b) => b.id === boundaryId);
      if (!picked) {
        return {
          ok: false,
          error: t('sharing.geoLimit.boundaryMissing'),
        };
      }
      return {
        ok: true,
        kind: 'boundary',
        boundaryId,
        summary: t('sharing.geoLimit.summaryBoundary', { title: picked.title }),
      };
    }
    if (mode === 'geojson') {
      if (!text.trim()) return null;
      try {
        const parsed = JSON.parse(text) as unknown;
        const geom = toGeometry(parsed);
        if (!geom) {
          return {
            ok: false,
            error: t('sharing.geoLimit.expectedGeojson'),
          };
        }
        return {
          ok: true,
          kind: 'inline',
          geometry: geom,
          summary: describeGeometry(geom),
        };
      } catch (err) {
        return {
          ok: false,
          error: t('sharing.geoLimit.invalidJson', {
            detail: (err as Error).message,
          }),
        };
      }
    }
    // bbox mode
    const parts = [minLng, minLat, maxLng, maxLat].map(Number);
    if (parts.some((n) => Number.isNaN(n))) return null;
    const [w, s, e, n] = parts as [number, number, number, number];
    if (w >= e || s >= n) {
      return {
        ok: false,
        error: t('sharing.geoLimit.minLessThanMax'),
      };
    }
    if (w < -180 || e > 180 || s < -90 || n > 90) {
      return {
        ok: false,
        error: t('sharing.geoLimit.invalidWgs84'),
      };
    }
    const polygon = {
      type: 'Polygon' as const,
      coordinates: [
        [
          [w, s],
          [e, s],
          [e, n],
          [w, n],
          [w, s],
        ],
      ],
    };
    return {
      ok: true,
      kind: 'inline',
      geometry: polygon,
      summary: t('sharing.geoLimit.summaryRectangle', {
        width: (e - w).toFixed(3),
        height: (n - s).toFixed(3),
      }),
    };
  }, [mode, text, minLng, minLat, maxLng, maxLat, boundaryId, boundaries, t]);

  async function save() {
    setError(null);
    if (!validated) {
      setError(t('sharing.geoLimit.needInput'));
      return;
    }
    if (!validated.ok) {
      setError(validated.error);
      return;
    }
    if (validated.kind === 'boundary') {
      await onSave({ geoLimit: null, geoBoundaryId: validated.boundaryId });
    } else {
      await onSave({ geoLimit: validated.geometry, geoBoundaryId: null });
    }
  }

  async function clear() {
    setError(null);
    await onSave({ geoLimit: null, geoBoundaryId: null });
  }

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && !saving) onClose();
      }}
    >
      <DialogContent hideCloseButton size="lg">
        <div className="flex items-center gap-2 px-5 pt-5">
          <MapPin className="h-5 w-5 text-accent" aria-hidden="true" />
          <DialogTitle>{t('sharing.geoLimit.title')}</DialogTitle>
        </div>
        <DialogDescription className="px-5 pt-1">
          {t('sharing.geoLimit.description', {
            principal: principalLabel,
          })}
        </DialogDescription>

        <div className="space-y-3 px-5 pt-3">

        <div className="inline-flex rounded border border-border bg-surface-2 p-0.5 text-xs">
          <button
            type="button"
            onClick={() => setMode('boundary')}
            className={`inline-flex items-center gap-1 rounded px-2 py-0.5 ${
              mode === 'boundary'
                ? 'bg-accent text-accent-foreground'
                : 'text-muted hover:text-ink-1'
            }`}
          >
            <Shapes className="h-3 w-3" />
            {t('sharing.geoLimit.modeBoundary')}
          </button>
          <button
            type="button"
            onClick={() => setMode('geojson')}
            className={`rounded px-2 py-0.5 ${
              mode === 'geojson'
                ? 'bg-accent text-accent-foreground'
                : 'text-muted hover:text-ink-1'
            }`}
          >
            {t('sharing.geoLimit.modeGeojson')}
          </button>
          <button
            type="button"
            onClick={() => setMode('bbox')}
            className={`rounded px-2 py-0.5 ${
              mode === 'bbox'
                ? 'bg-accent text-accent-foreground'
                : 'text-muted hover:text-ink-1'
            }`}
          >
            {t('sharing.geoLimit.modeBbox')}
          </button>
        </div>

        {mode === 'boundary' ? (
          <div>
            <label className="block text-xs">
              <span className="mb-1 block uppercase tracking-wide text-muted">
                {t('sharing.geoLimit.boundaryLabel')}
              </span>
              <select
                value={boundaryId}
                onChange={(e) => setBoundaryId(e.target.value)}
                disabled={boundaries.length === 0}
                className="h-9 w-full rounded-md border border-border bg-surface-1 px-2 text-xs focus:border-accent focus:outline-hidden focus:ring-2 focus:ring-accent/30 disabled:opacity-50"
              >
                <option value="">
                  {boundaries.length === 0
                    ? t('sharing.geoLimit.noBoundaries')
                    : t('sharing.geoLimit.pickBoundary')}
                </option>
                {boundaries.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.title}
                  </option>
                ))}
              </select>
            </label>
            <p className="mt-1 text-2xs text-muted">
              {t('sharing.geoLimit.boundaryHint')}
            </p>
            {boundaries.length === 0 ? (
              <p className="mt-2 rounded-md border border-dashed border-border bg-surface-0 px-2 py-1.5 text-2xs text-muted">
                {t('sharing.geoLimit.createBoundaryLead')}{' '}
                <a
                  href="/items/new"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-medium text-accent hover:underline"
                >
                  {t('sharing.geoLimit.createBoundaryLink')}
                </a>
                {t('sharing.geoLimit.createBoundaryTail')}
              </p>
            ) : null}
          </div>
        ) : mode === 'geojson' ? (
          <div>
            <label className="block text-xs">
              <span className="mb-1 block uppercase tracking-wide text-muted">
                {t('sharing.geoLimit.pasteGeojson')}
              </span>
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={10}
                placeholder={`{\n  "type": "Polygon",\n  "coordinates": [[[lng,lat], ...]]\n}`}
                className="w-full rounded-md border border-border bg-surface-1 px-2 py-1 font-mono text-xs focus:border-accent focus:outline-hidden focus:ring-2 focus:ring-accent/30"
              />
            </label>
            <p className="mt-1 text-2xs text-muted">
              {t('sharing.geoLimit.geojsonHint')}
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-2 text-xs">
            <BBoxField
              label={t('sharing.geoLimit.minLng')}
              value={minLng}
              onChange={setMinLng}
            />
            <BBoxField
              label={t('sharing.geoLimit.minLat')}
              value={minLat}
              onChange={setMinLat}
            />
            <BBoxField
              label={t('sharing.geoLimit.maxLng')}
              value={maxLng}
              onChange={setMaxLng}
            />
            <BBoxField
              label={t('sharing.geoLimit.maxLat')}
              value={maxLat}
              onChange={setMaxLat}
            />
          </div>
        )}

        {validated?.ok ? (
          <div className="rounded border border-success/30 bg-success/5 px-2 py-1 text-2xs text-success">
            <Check className="mr-1 inline h-3 w-3" />
            {validated.summary}
          </div>
        ) : null}

        {error || (validated && !validated.ok) ? (
          <div
            role="alert"
            className="flex items-start gap-1.5 rounded border border-danger/30 bg-danger/5 px-2 py-1 text-2xs text-danger"
          >
            <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
            <span>{error ?? (validated && !validated.ok ? validated.error : '')}</span>
          </div>
        ) : null}

        </div>

        <DialogFooter className="mt-5 justify-between border-t-0 bg-transparent pb-5">
          {hasExisting ? (
            <button
              type="button"
              onClick={() => void clear()}
              disabled={saving}
              className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border bg-surface-1 px-3 text-xs font-medium text-danger hover:bg-danger/5 disabled:opacity-50"
            >
              <Trash2 className="h-3.5 w-3.5" />
              {t('sharing.geoLimit.clearRestriction')}
            </button>
          ) : (
            <span />
          )}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className="h-9 rounded-md border border-border bg-surface-1 px-3 text-xs font-medium text-ink-1 hover:bg-surface-2 disabled:opacity-50"
            >
              {t('common.cancel')}
            </button>
            <button
              type="button"
              onClick={() => void save()}
              disabled={saving || !validated || !validated.ok}
              className="inline-flex h-9 items-center gap-1.5 rounded-md bg-accent px-3 text-xs font-medium text-accent-foreground hover:opacity-90 disabled:opacity-50"
            >
              {saving ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Save className="h-3.5 w-3.5" />
              )}
              {t('common.save')}
            </button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function BBoxField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="block">
      <span className="mb-1 block uppercase tracking-wide text-muted">
        {label}
      </span>
      <input
        type="text"
        inputMode="decimal"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-8 w-full rounded-md border border-border bg-surface-1 px-2 font-mono text-xs focus:border-accent focus:outline-hidden focus:ring-2 focus:ring-accent/30"
      />
    </label>
  );
}

/**
 * Unwrap a GeoJSON value into a bare geometry. Accepts:
 *   - Polygon / MultiPolygon geometry directly
 *   - Feature with such a geometry
 *   - FeatureCollection with one or more polygon features (unioned
 *     into a MultiPolygon at the call site: today we just pull the
 *     first feature's geometry if there's exactly one, otherwise
 *     reject with a clear message)
 */
function toGeometry(v: unknown): unknown | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as { type?: string; geometry?: unknown; features?: unknown[] };
  if (o.type === 'Polygon' || o.type === 'MultiPolygon') return o;
  if (o.type === 'Feature' && o.geometry) {
    return toGeometry(o.geometry);
  }
  if (o.type === 'FeatureCollection' && Array.isArray(o.features)) {
    const geoms = o.features
      .map((f) => (f && typeof f === 'object' ? (f as { geometry?: unknown }).geometry : null))
      .filter((g): g is object => !!g)
      .map((g) => toGeometry(g))
      .filter((g): g is object => !!g);
    if (geoms.length === 0) return null;
    if (geoms.length === 1) return geoms[0];
    return {
      type: 'GeometryCollection',
      geometries: geoms,
    };
  }
  return null;
}

function describeGeometry(g: unknown): string {
  if (!g || typeof g !== 'object') return '';
  const o = g as { type?: string; coordinates?: unknown; geometries?: unknown[] };
  if (o.type === 'Polygon' && Array.isArray(o.coordinates)) {
    const rings = o.coordinates.length;
    const first = (o.coordinates[0] as unknown[] | undefined)?.length ?? 0;
    return `Polygon · ${rings} ring${rings === 1 ? '' : 's'} · ${first} vertices`;
  }
  if (o.type === 'MultiPolygon' && Array.isArray(o.coordinates)) {
    return `MultiPolygon · ${o.coordinates.length} part${
      o.coordinates.length === 1 ? '' : 's'
    }`;
  }
  if (o.type === 'GeometryCollection' && Array.isArray(o.geometries)) {
    return `GeometryCollection · ${o.geometries.length} geometries`;
  }
  return o.type ?? 'geometry';
}
