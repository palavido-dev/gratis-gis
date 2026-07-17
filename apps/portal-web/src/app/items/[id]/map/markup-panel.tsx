// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

/**
 * Markup panel (#154 Phase 1).
 *
 * A floating overlay on the map editor that lets viewers (not just
 * editors) add their own markup — colored pins with optional notes —
 * to a shared map. The killer use case is the manager-redline
 * workflow: a non-GIS stakeholder opens a shared map, drops a pin
 * on the wrong parcel, types "this is the wrong boundary," and
 * ships the URL back to the team.
 *
 * Phase 1 scope:
 *   - List existing drawing sets on the map
 *   - Add a new empty set with an auto-assigned color
 *   - Drop a pin into the active set (one pin at a time)
 *   - Rename / recolor / show-hide / delete a set
 *   - Per-set author label + timestamp
 *
 * Phase 1.5 follow-ups (not in this file):
 *   - Line / polygon / arrow / text drawing tools
 *   - Per-feature notes / labels
 *   - Anonymous markup (cookie-backed author token)
 *   - Promote a set to a real data layer
 *
 * The panel manages its own server round-trips against
 * /api/portal/items/:mapId/drawings, so the parent map editor only
 * needs to know "the drawings on this map changed, refresh the
 * canvas overlay."
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Eye,
  EyeOff,
  MapPin,
  PencilLine,
  Plus,
  Trash2,
  X,
} from 'lucide-react';
import {
  DRAWING_SET_PALETTE,
  defaultDrawingSetTitle,
  type DrawingFeature,
  type DrawingSet,
} from '@gratis-gis/shared-types';

interface Props {
  /** UUID of the map item this panel is editing. */
  mapId: string;
  /** Open / closed. Parent owns the toggle so the toolbar button
   *  can flip it. */
  open: boolean;
  onClose: () => void;
  /**
   * Current signed-in user. The panel uses this to figure out
   * which drawing sets the viewer can edit (their own, or any if
   * `canEditMap`). Pass null only on a public viewer; in that
   * case the create/edit actions disable.
   */
  currentUser: { id: string; displayName: string } | null;
  /**
   * Whether the viewer can edit the parent map item. Editors can
   * touch any drawing set (clean up after a reviewer who left);
   * non-editors can only touch sets they authored.
   */
  canEditMap: boolean;
  /**
   * Current map center [lng, lat] used as the default position
   * for newly-dropped pins. The parent map editor passes the
   * live camera center so a pin lands somewhere useful even when
   * the user hasn't clicked the map yet. Phase 1.5 will replace
   * this with a "click the map to place a pin" interaction.
   */
  mapCenter: [number, number];
  /**
   * Fired whenever the panel mutates a drawing set on the server.
   * Parent uses this to bump the canvas state so the overlay
   * re-renders. Receives the full latest list.
   */
  onDrawingsChange: (drawings: DrawingSet[]) => void;
  /**
   * Initial drawings, server-fetched by the parent before
   * mounting. The panel uses these as its initial state and
   * re-fetches on focus to pick up other viewers' edits.
   */
  initialDrawings: DrawingSet[];
}

export function MarkupPanel({
  mapId,
  open,
  onClose,
  currentUser,
  canEditMap,
  mapCenter,
  onDrawingsChange,
  initialDrawings,
}: Props) {
  const [drawings, setDrawings] = useState<DrawingSet[]>(initialDrawings);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingTitleId, setEditingTitleId] = useState<string | null>(null);
  const [titleDraft, setTitleDraft] = useState('');
  const mapCenterRef = useRef(mapCenter);
  mapCenterRef.current = mapCenter;

  // Reset local state when the parent re-fetches from server.
  useEffect(() => {
    setDrawings(initialDrawings);
  }, [initialDrawings]);

  const refresh = useCallback(async () => {
    try {
      const fresh = await portalJson<DrawingSet[]>(
        `/api/portal/items/${mapId}/drawings`,
      );
      setDrawings(fresh);
      onDrawingsChange(fresh);
    } catch (e) {
      setError(message(e));
    }
  }, [mapId, onDrawingsChange]);

  const canEditSet = useCallback(
    (set: DrawingSet): boolean => {
      if (!currentUser) return false;
      if (canEditMap) return true;
      return set.authorId === currentUser.id;
    },
    [currentUser, canEditMap],
  );

  const addSet = useCallback(async () => {
    if (!currentUser) return;
    setBusy(true);
    setError(null);
    try {
      const title = defaultDrawingSetTitle(currentUser.displayName);
      const created = await portalJson<DrawingSet>(
        `/api/portal/items/${mapId}/drawings`,
        {
          method: 'POST',
          body: JSON.stringify({ title }),
        },
      );
      const next = [...drawings, created];
      setDrawings(next);
      onDrawingsChange(next);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }, [currentUser, drawings, mapId, onDrawingsChange]);

  const dropPin = useCallback(
    async (setId: string) => {
      const set = drawings.find((s) => s.id === setId);
      if (!set || !canEditSet(set)) return;
      const [lng, lat] = mapCenterRef.current;
      const now = new Date().toISOString();
      const feature: DrawingFeature = {
        id: cryptoRandomUuid(),
        kind: 'pin',
        geometry: { type: 'Point', coordinates: [lng, lat] },
        createdAt: now,
        updatedAt: now,
      };
      const nextFeatures = [...set.features, feature];
      setBusy(true);
      setError(null);
      try {
        const updated = await portalJson<DrawingSet>(
          `/api/portal/items/${mapId}/drawings/${setId}`,
          {
            method: 'PATCH',
            body: JSON.stringify({ features: nextFeatures }),
          },
        );
        const nextSets = drawings.map((s) => (s.id === setId ? updated : s));
        setDrawings(nextSets);
        onDrawingsChange(nextSets);
      } catch (e) {
        setError(message(e));
      } finally {
        setBusy(false);
      }
    },
    [drawings, canEditSet, mapId, onDrawingsChange],
  );

  const toggleVisibility = useCallback(
    async (setId: string) => {
      const set = drawings.find((s) => s.id === setId);
      if (!set) return;
      // Local-only toggle: visibility is a per-viewer affordance,
      // not a per-set author preference. We still persist it so the
      // author's choice survives a refresh, but we don't wait for
      // the server to flip the UI.
      const optimistic = drawings.map((s) =>
        s.id === setId ? { ...s, visible: !s.visible } : s,
      );
      setDrawings(optimistic);
      onDrawingsChange(optimistic);
      if (!canEditSet(set)) return; // viewer-only: keep client-side only
      try {
        const updated = await portalJson<DrawingSet>(
          `/api/portal/items/${mapId}/drawings/${setId}`,
          {
            method: 'PATCH',
            body: JSON.stringify({ visible: !set.visible }),
          },
        );
        const next = drawings.map((s) => (s.id === setId ? updated : s));
        setDrawings(next);
        onDrawingsChange(next);
      } catch (e) {
        // Roll back optimistic flip on failure.
        setDrawings(drawings);
        onDrawingsChange(drawings);
        setError(message(e));
      }
    },
    [drawings, canEditSet, mapId, onDrawingsChange],
  );

  const renameSet = useCallback(
    async (setId: string, title: string) => {
      setBusy(true);
      setError(null);
      try {
        const updated = await portalJson<DrawingSet>(
          `/api/portal/items/${mapId}/drawings/${setId}`,
          {
            method: 'PATCH',
            body: JSON.stringify({ title }),
          },
        );
        const next = drawings.map((s) => (s.id === setId ? updated : s));
        setDrawings(next);
        onDrawingsChange(next);
        setEditingTitleId(null);
      } catch (e) {
        setError(message(e));
      } finally {
        setBusy(false);
      }
    },
    [drawings, mapId, onDrawingsChange],
  );

  const recolorSet = useCallback(
    async (setId: string, color: string) => {
      setBusy(true);
      setError(null);
      try {
        const updated = await portalJson<DrawingSet>(
          `/api/portal/items/${mapId}/drawings/${setId}`,
          {
            method: 'PATCH',
            body: JSON.stringify({ color }),
          },
        );
        const next = drawings.map((s) => (s.id === setId ? updated : s));
        setDrawings(next);
        onDrawingsChange(next);
      } catch (e) {
        setError(message(e));
      } finally {
        setBusy(false);
      }
    },
    [drawings, mapId, onDrawingsChange],
  );

  const removeSet = useCallback(
    async (setId: string) => {
      const set = drawings.find((s) => s.id === setId);
      if (!set || !canEditSet(set)) return;
      const ok = window.confirm(
        `Delete the "${set.title}" markup? This can't be undone.`,
      );
      if (!ok) return;
      setBusy(true);
      setError(null);
      try {
        await portalJson(`/api/portal/items/${mapId}/drawings/${setId}`, {
          method: 'DELETE',
        });
        const next = drawings.filter((s) => s.id !== setId);
        setDrawings(next);
        onDrawingsChange(next);
      } catch (e) {
        setError(message(e));
      } finally {
        setBusy(false);
      }
    },
    [drawings, canEditSet, mapId, onDrawingsChange],
  );

  const sorted = useMemo(
    () => [...drawings].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    [drawings],
  );

  if (!open) return null;
  return (
    <div
      role="dialog"
      aria-label="Map markup"
      className="absolute right-3 top-16 z-30 flex w-80 max-h-[70vh] flex-col rounded-md border border-border bg-surface-1 shadow-card"
    >
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <div className="flex items-center gap-2">
          <PencilLine className="h-4 w-4 text-muted" />
          <h2 className="text-sm font-semibold text-ink-1">Markup</h2>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded p-1 text-muted hover:bg-surface-2 hover:text-ink-1"
          aria-label="Close markup panel"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="overflow-y-auto px-2 py-2">
        {sorted.length === 0 ? (
          <p className="px-2 py-3 text-xs text-muted">
            No markup yet. Add a set, then drop pins to mark up the map.
          </p>
        ) : (
          <ul className="space-y-1">
            {sorted.map((set) => {
              const editable = canEditSet(set);
              const isRenaming = editingTitleId === set.id;
              return (
                <li
                  key={set.id}
                  className="rounded border border-transparent px-2 py-2 hover:border-border hover:bg-surface-2"
                >
                  <div className="flex items-start gap-2">
                    <button
                      type="button"
                      onClick={() => toggleVisibility(set.id)}
                      className="mt-1 rounded text-muted hover:text-ink-1"
                      title={set.visible ? 'Hide' : 'Show'}
                      aria-label={set.visible ? 'Hide markup' : 'Show markup'}
                    >
                      {set.visible ? (
                        <Eye className="h-4 w-4" />
                      ) : (
                        <EyeOff className="h-4 w-4" />
                      )}
                    </button>
                    <div className="min-w-0 flex-1">
                      {isRenaming ? (
                        <input
                          autoFocus
                          value={titleDraft}
                          onChange={(e) => setTitleDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              renameSet(set.id, titleDraft.trim() || set.title);
                            } else if (e.key === 'Escape') {
                              setEditingTitleId(null);
                            }
                          }}
                          onBlur={() => {
                            if (titleDraft.trim().length > 0) {
                              renameSet(set.id, titleDraft.trim());
                            } else {
                              setEditingTitleId(null);
                            }
                          }}
                          className="w-full rounded border border-border bg-surface-1 px-1 py-0.5 text-sm text-ink-1"
                        />
                      ) : (
                        <button
                          type="button"
                          disabled={!editable}
                          onClick={() => {
                            if (!editable) return;
                            setEditingTitleId(set.id);
                            setTitleDraft(set.title);
                          }}
                          className="block w-full truncate text-left text-sm font-medium text-ink-1 disabled:cursor-default"
                          title={editable ? 'Click to rename' : set.title}
                        >
                          {set.title}
                        </button>
                      )}
                      <p className="truncate text-2xs text-muted">
                        {set.authorDisplay} — {formatRelative(set.updatedAt)}
                        {' — '}
                        {set.features.length}{' '}
                        {set.features.length === 1 ? 'pin' : 'pins'}
                      </p>
                      {editable ? (
                        <div className="mt-1 flex flex-wrap items-center gap-1">
                          {DRAWING_SET_PALETTE.map((c) => (
                            <button
                              key={c}
                              type="button"
                              onClick={() => recolorSet(set.id, c)}
                              className={`h-3.5 w-3.5 rounded-full border ${
                                c.toLowerCase() === set.color.toLowerCase()
                                  ? 'border-ink-1 ring-1 ring-ink-1'
                                  : 'border-border'
                              }`}
                              style={{ backgroundColor: c }}
                              aria-label={`Set color ${c}`}
                            />
                          ))}
                        </div>
                      ) : (
                        <div
                          className="mt-1 inline-block h-3.5 w-3.5 rounded-full border border-border"
                          style={{ backgroundColor: set.color }}
                          aria-hidden
                        />
                      )}
                    </div>
                  </div>
                  {editable ? (
                    <div className="mt-2 flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => dropPin(set.id)}
                        disabled={busy}
                        className="flex items-center gap-1 rounded border border-border bg-surface-1 px-2 py-1 text-xs text-ink-1 hover:bg-surface-2 disabled:opacity-50"
                      >
                        <MapPin className="h-3 w-3" />
                        Drop pin at center
                      </button>
                      <button
                        type="button"
                        onClick={() => removeSet(set.id)}
                        disabled={busy}
                        className="ml-auto rounded p-1 text-muted hover:bg-danger/10 hover:text-danger disabled:opacity-50"
                        aria-label="Delete markup"
                        title="Delete markup"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="border-t border-border px-3 py-2">
        {currentUser ? (
          <button
            type="button"
            onClick={addSet}
            disabled={busy}
            className="flex w-full items-center justify-center gap-2 rounded border border-border bg-accent px-2 py-1.5 text-sm font-medium text-accent-on hover:opacity-90 disabled:opacity-50"
          >
            <Plus className="h-4 w-4" />
            Add markup
          </button>
        ) : (
          <p className="text-xs text-muted">
            Sign in to add markup to this map.
          </p>
        )}
        {error ? (
          <p role="alert" className="mt-2 text-xs text-danger">
            {error}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function message(e: unknown): string {
  if (e instanceof Error) return e.message;
  return 'Something went wrong';
}

/**
 * Tiny client-side wrapper around fetch for the BFF surface. Lives
 * here rather than in a shared lib because most other map editor
 * panels inline their fetches and we don't want to pull them all
 * into a refactor right now. Returns parsed JSON on success or
 * undefined for empty responses (e.g. 204 on DELETE).
 */
async function portalJson<T = unknown>(
  url: string,
  init: RequestInit = {},
): Promise<T> {
  const headers: Record<string, string> = {
    ...((init.headers as Record<string, string>) ?? {}),
  };
  if (init.body && !headers['content-type'] && !headers['Content-Type']) {
    headers['content-type'] = 'application/json';
  }
  const res = await fetch(url, { ...init, headers });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${res.status}: ${body || res.statusText}`);
  }
  const text = await res.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

/**
 * UUID v4 generator. Browser crypto.randomUUID is available in
 * every modern browser; the polyfill handles the (vanishingly
 * rare) older environment without throwing.
 */
function cryptoRandomUuid(): string {
  if (
    typeof crypto !== 'undefined' &&
    typeof (crypto as Crypto & { randomUUID?: () => string }).randomUUID ===
      'function'
  ) {
    return (crypto as Crypto & { randomUUID: () => string }).randomUUID();
  }
  // Fallback: timestamp + random bits. Not RFC 4122 compliant
  // but unique enough for our short-lived client-side ids; the
  // server will replace any malformed id on next persist anyway.
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Render a UTC ISO timestamp as a human-readable relative time
 * ("3 min ago", "yesterday"). Falls back to the date for anything
 * older than a week so the panel doesn't drift into useless
 * "47 days ago" text.
 */
function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return iso;
  const diff = Date.now() - then;
  if (diff < 0) return 'just now';
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} d ago`;
  return new Date(iso).toLocaleDateString();
}
