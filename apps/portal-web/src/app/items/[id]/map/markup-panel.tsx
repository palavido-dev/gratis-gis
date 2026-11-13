// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import { useFormat } from '@/lib/i18n/format';
import { useT } from '@/lib/i18n/locale-context';

/**
 * Markup panel (#154 Phase 1 + 1.5 + annotation kinds).
 *
 * A floating overlay on the map editor that lets viewers (not just
 * editors) add their own markup to a shared map: pins, lines,
 * polygons, text labels, arrows, and circles. The killer use case
 * is the manager-redline workflow: a non-GIS stakeholder opens a
 * shared map, sketches the wrong boundary, types a note, and ships
 * the URL back to the team.
 *
 * Also: download a set as GeoJSON, or promote it to a data_layer
 * the author owns.
 *
 * The panel manages its own server round-trips against
 * /api/portal/items/:mapId/drawings, so the parent map editor only
 * needs to know "the drawings on this map changed, refresh the
 * canvas overlay" and optionally add a promoted layer to the map.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowUpFromLine,
  Circle,
  Download,
  Eye,
  EyeOff,
  Hexagon,
  MapPin,
  MoveRight,
  PencilLine,
  Plus,
  Slash,
  Type,
  Trash2,
  X,
} from 'lucide-react';
import {
  DRAWING_SET_PALETTE,
  defaultDrawingSetTitle,
  type DrawingFeature,
  type DrawingSet,
} from '@gratis-gis/shared-types';
import type * as maplibregl from 'maplibre-gl';
import { readAnonDrawingDisplay } from '@/lib/anon-drawing-session';
import { clientUuid } from '@/lib/uuid';
import { downloadDrawingSetGeoJson } from '@/lib/drawings-geojson-export';
import {
  openDrawingsCollabSession,
  type DrawingsCollabSession,
} from '@/lib/drawings-collab-session';
import {
  drawModeFor,
  setDrawMode,
  startDraw,
  useCrosshairCursor,
  useTerraDraw,
  type MarkupDrawTool,
} from './use-terra-draw';
import { portalJson } from '@/lib/portal-json';

type MarkupTool = 'off' | MarkupDrawTool;

interface Props {
  /** UUID of the map item this panel is editing. */
  mapId: string;
  /** Live MapLibre instance for terra-draw. Null until the canvas is ready. */
  map: maplibregl.Map | null;
  /** Open / closed. Parent owns the toggle so the toolbar button
   *  can flip it. */
  open: boolean;
  onClose: () => void;
  /**
   * Current signed-in user. The panel uses this to figure out
   * which drawing sets the viewer can edit (their own, or any if
   * `canEditMap`). Pass null for a public anonymous viewer; when
   * `allowAnonymousDrawings` is also on, create/edit of the
   * visitor's own sets stays enabled via the anon cookie session.
   */
  currentUser: { id: string; displayName: string } | null;
  /**
   * Map opt-in for anonymous markup (#154). Off by default. When
   * true and `currentUser` is null, the panel enables Add markup
   * and edit/delete of sets authored in this browser session.
   * Promote stays hidden for anonymous visitors.
   */
  allowAnonymousDrawings?: boolean;
  /**
   * Whether the viewer can edit the parent map item. Editors can
   * touch any drawing set (clean up after a reviewer who left);
   * non-editors can only touch sets they authored.
   */
  canEditMap: boolean;
  /**
   * Current map center [lng, lat] used as a fallback for the
   * legacy "drop pin at center" quick action.
   */
  mapCenter: [number, number];
  /**
   * Fired whenever the panel mutates a drawing set on the server.
   * Parent uses this to bump the canvas state so the overlay
   * re-renders. Receives the full latest list.
   */
  onDrawingsChange: (drawings: DrawingSet[]) => void;
  /**
   * Fired after a successful promote. Parent may add the new
   * data_layer to the map when the viewer can edit it.
   */
  onPromoted?: (result: {
    itemId: string;
    title: string;
    inserted: number;
  }) => void;
  /**
   * Fired when a draw tool activates / deactivates so the parent
   * can stand down select / feature-edit tools that compete for
   * map clicks.
   */
  onDrawActiveChange?: (active: boolean) => void;
  /**
   * Initial drawings, server-fetched by the parent before
   * mounting. The panel uses these as its initial state and
   * re-fetches on focus to pick up other viewers' edits.
   */
  initialDrawings: DrawingSet[];
  /**
   * Bumped by the parent when another map tool (select, feature
   * editing) takes over the clicks; the armed markup tool stands down.
   */
  standDownSignal?: number;
}

export function MarkupPanel({
  mapId,
  map,
  open,
  onClose,
  currentUser,
  allowAnonymousDrawings = false,
  canEditMap,
  mapCenter,
  onDrawingsChange,
  onPromoted,
  onDrawActiveChange,
  initialDrawings,
  standDownSignal,
}: Props) {
  const t = useT();
  const fmt = useFormat();
  const [drawings, setDrawings] = useState<DrawingSet[]>(initialDrawings);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingTitleId, setEditingTitleId] = useState<string | null>(null);
  const [titleDraft, setTitleDraft] = useState('');
  const [activeSetId, setActiveSetId] = useState<string | null>(null);
  const [tool, setTool] = useState<MarkupTool>('off');
  const [promoteBusyId, setPromoteBusyId] = useState<string | null>(null);
  // Re-read after writes so a freshly-minted cookie unlocks edit
  // controls without a full page reload.
  const [anonDisplay, setAnonDisplay] = useState<string | null>(() =>
    readAnonDrawingDisplay(),
  );
  const canCreateMarkup =
    Boolean(currentUser) || (allowAnonymousDrawings && !currentUser);
  const mapCenterRef = useRef(mapCenter);
  mapCenterRef.current = mapCenter;
  const drawingsRef = useRef(drawings);
  drawingsRef.current = drawings;
  const activeSetIdRef = useRef(activeSetId);
  activeSetIdRef.current = activeSetId;
  const collabRef = useRef<DrawingsCollabSession | null>(null);

  // R1-presence-crdt: signed-in co-editors share a Yjs room for the
  // active markup set. Anonymous stays on REST LWW.
  useEffect(() => {
    if (!open || !currentUser || !activeSetId) {
      collabRef.current?.close();
      collabRef.current = null;
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const session = await openDrawingsCollabSession({
          mapId,
          drawingSetId: activeSetId,
          onFeatures: (features) => {
            if (cancelled) return;
            setDrawings((prev) => {
              const next = prev.map((s) =>
                s.id === activeSetId ? { ...s, features } : s,
              );
              onDrawingsChange(next);
              return next;
            });
          },
        });
        if (cancelled) {
          session?.close();
          return;
        }
        collabRef.current?.close();
        collabRef.current = session;
      } catch {
        /* collab is best-effort; REST path remains */
      }
    })();
    return () => {
      cancelled = true;
      collabRef.current?.close();
      collabRef.current = null;
    };
  }, [open, currentUser, activeSetId, mapId, onDrawingsChange]);
  const toolRef = useRef(tool);
  toolRef.current = tool;

  // Reset local state when the parent re-fetches from server.
  useEffect(() => {
    setDrawings(initialDrawings);
  }, [initialDrawings]);

  // Closing the panel cancels an in-progress draw so terra-draw
  // does not keep intercepting clicks after the pane is gone.
  useEffect(() => {
    if (!open && tool !== 'off') setTool('off');
  }, [open, tool]);

  // Another tool was chosen after this one: disarm. Skips the first
  // run so mounting does not count as a signal.
  const standDownSeen = useRef(standDownSignal);
  useEffect(() => {
    if (standDownSeen.current === standDownSignal) return;
    standDownSeen.current = standDownSignal;
    setTool('off');
  }, [standDownSignal]);

  const drawActive = open && tool !== 'off';
  useEffect(() => {
    onDrawActiveChange?.(drawActive);
  }, [drawActive, onDrawActiveChange]);

  // Mount terra-draw only while a markup tool is live so read-only
  // viewers who never draw do not pay the dynamic-import cost, and
  // so the instance does not contend with feature editing.
  const { draw, ready } = useTerraDraw(drawActive ? map : null, {
    snapping: true,
  });
  useCrosshairCursor(map, drawActive);

  useEffect(() => {
    if (!draw || !ready || tool === 'off') return;
    startDraw(draw);
    setDrawMode(draw, drawModeFor(tool));
  }, [draw, ready, tool]);

  // A finished sketch lands in the active drawing set.
  useEffect(() => {
    if (!draw || !ready || tool === 'off') return;
    const handleFinish = (id: string | number) => {
      const setId = activeSetIdRef.current;
      if (!setId) return;
      const f = draw.getSnapshot().find((x) => String(x.id) === String(id));
      if (!f || !f.geometry) return;
      const kind = kindForTool(toolRef.current);
      if (!kind) return;
      const now = new Date().toISOString();
      let label: string | undefined;
      if (kind === 'text') {
        // Guided: ask for the label right after place. Cancel still
        // saves a point so the reviewer can rename later via note.
        const typed =
          typeof window !== 'undefined'
            ? window.prompt(t('mapMarkup.textPrompt'), '')
            : '';
        if (typed === null) {
          try {
            if (draw.hasFeature(id)) draw.removeFeatures([id]);
          } catch {
            /* already gone */
          }
          return;
        }
        label = typed.trim() || undefined;
      }
      const feature: DrawingFeature = {
        id: clientUuid(),
        kind,
        geometry: f.geometry,
        ...(label !== undefined ? { label } : {}),
        createdAt: now,
        updatedAt: now,
      };
      void appendFeature(setId, feature).finally(() => {
        try {
          if (draw.hasFeature(id)) draw.removeFeatures([id]);
        } catch {
          /* already gone */
        }
        // Point mode finishes per click; keep the tool armed so the
        // reviewer can drop another pin without re-clicking the tool.
        // Line / polygon re-arm the same mode after finish.
        if (toolRef.current !== 'off') {
          setDrawMode(draw, drawModeFor(toolRef.current));
        }
      });
    };
    draw.on('finish', handleFinish);
    return () => {
      try {
        draw.off('finish', handleFinish);
      } catch {
        /* race on unmount */
      }
    };
    // appendFeature is stable enough via refs; listing it would
    // rebind the listener on every drawings change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draw, ready, tool]);

  const refresh = useCallback(async () => {
    try {
      const fresh = await portalJson<DrawingSet[]>(
        `/api/portal/items/${mapId}/drawings`,
      );
      setDrawings(fresh);
      onDrawingsChange(fresh);
    } catch (e) {
      setError(message(e, t('mapMarkup.somethingWrong')));
    }
  }, [mapId, onDrawingsChange, t]);

  const canEditSet = useCallback(
    (set: DrawingSet): boolean => {
      if (currentUser) {
        if (canEditMap) return true;
        return set.authorId === currentUser.id;
      }
      if (!allowAnonymousDrawings) return false;
      // Anon visitors only edit sets they authored in this browser
      // session (authorId null + display matches the cookie).
      return (
        set.authorId === null &&
        anonDisplay !== null &&
        set.authorDisplay === anonDisplay
      );
    },
    [currentUser, canEditMap, allowAnonymousDrawings, anonDisplay],
  );

  const appendFeature = useCallback(
    async (setId: string, feature: DrawingFeature) => {
      const set = drawingsRef.current.find((s) => s.id === setId);
      if (!set || !canEditSet(set)) return;
      setBusy(true);
      setError(null);
      try {
        // Ask the server to append to the set as it stands. Sending
        // the whole array built from this page's copy erased any pin
        // added since: a second quick pin from the same base, or
        // another reviewer's pins on a page loaded earlier.
        const updated = await portalJson<DrawingSet>(
          `/api/portal/items/${mapId}/drawings/${setId}`,
          {
            method: 'PATCH',
            body: JSON.stringify({ appendFeatures: [feature] }),
          },
        );
        // Responses can land out of order; keep the newer copy.
        const nextSets = drawingsRef.current.map((s) =>
          s.id === setId && !(s.updatedAt > updated.updatedAt) ? updated : s,
        );
        setDrawings(nextSets);
        onDrawingsChange(nextSets);
        collabRef.current?.upsertFeature(feature);
      } catch (e) {
        setError(message(e, t('mapMarkup.somethingWrong')));
      } finally {
        setBusy(false);
      }
    },
    [canEditSet, mapId, onDrawingsChange, t],
  );

  const addSet = useCallback(async () => {
    if (!canCreateMarkup) return;
    setBusy(true);
    setError(null);
    try {
      // Signed-in: stamp the title client-side. Anonymous: omit so
      // the API names the set from the freshly-minted cookie display
      // ("Anonymous ab12cd's markup …").
      const body = currentUser
        ? JSON.stringify({
            title: defaultDrawingSetTitle(currentUser.displayName),
          })
        : '{}';
      const created = await portalJson<DrawingSet>(
        `/api/portal/items/${mapId}/drawings`,
        {
          method: 'POST',
          body,
        },
      );
      // Cookie may have been minted on this response; refresh so
      // canEditSet recognizes the new set as ours.
      setAnonDisplay(readAnonDrawingDisplay());
      const next = [...drawings, created];
      setDrawings(next);
      onDrawingsChange(next);
      setActiveSetId(created.id);
      setTool('point');
    } catch (e) {
      setError(message(e, t('mapMarkup.somethingWrong')));
    } finally {
      setBusy(false);
    }
  }, [
    canCreateMarkup,
    currentUser,
    drawings,
    mapId,
    onDrawingsChange,
    t,
  ]);

  const dropPinAtCenter = useCallback(
    async (setId: string) => {
      const set = drawings.find((s) => s.id === setId);
      if (!set || !canEditSet(set)) return;
      const [lng, lat] = mapCenterRef.current;
      const now = new Date().toISOString();
      await appendFeature(setId, {
        id: clientUuid(),
        kind: 'pin',
        geometry: { type: 'Point', coordinates: [lng, lat] },
        createdAt: now,
        updatedAt: now,
      });
    },
    [drawings, canEditSet, appendFeature],
  );

  const armTool = useCallback(
    (setId: string, next: MarkupTool) => {
      const set = drawings.find((s) => s.id === setId);
      if (!set || !canEditSet(set)) return;
      setActiveSetId(setId);
      setTool((prev) => (prev === next && activeSetId === setId ? 'off' : next));
    },
    [drawings, canEditSet, activeSetId],
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
        setError(message(e, t('mapMarkup.somethingWrong')));
      }
    },
    [drawings, canEditSet, mapId, onDrawingsChange, t],
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
        setError(message(e, t('mapMarkup.somethingWrong')));
      } finally {
        setBusy(false);
      }
    },
    [drawings, mapId, onDrawingsChange, t],
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
        setError(message(e, t('mapMarkup.somethingWrong')));
      } finally {
        setBusy(false);
      }
    },
    [drawings, mapId, onDrawingsChange, t],
  );

  const removeSet = useCallback(
    async (setId: string) => {
      const set = drawings.find((s) => s.id === setId);
      if (!set || !canEditSet(set)) return;
      const ok = window.confirm(
        t('mapMarkup.deleteConfirm', { title: set.title }),
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
        if (activeSetId === setId) {
          setActiveSetId(null);
          setTool('off');
        }
      } catch (e) {
        setError(message(e, t('mapMarkup.somethingWrong')));
      } finally {
        setBusy(false);
      }
    },
    [drawings, canEditSet, mapId, onDrawingsChange, t, activeSetId],
  );

  const promoteSet = useCallback(
    async (setId: string) => {
      const set = drawings.find((s) => s.id === setId);
      if (!set || !canEditSet(set)) return;
      if (set.features.length === 0) {
        setError(t('mapMarkup.promoteEmpty'));
        return;
      }
      setPromoteBusyId(setId);
      setError(null);
      try {
        const result = await portalJson<{
          itemId: string;
          inserted: number;
        }>(`/api/portal/items/${mapId}/drawings/${setId}/promote`, {
          method: 'POST',
          body: JSON.stringify({ title: set.title }),
        });
        onPromoted?.({
          itemId: result.itemId,
          title: set.title,
          inserted: result.inserted,
        });
      } catch (e) {
        setError(message(e, t('mapMarkup.promoteFailed')));
      } finally {
        setPromoteBusyId(null);
      }
    },
    [drawings, canEditSet, mapId, onPromoted, t],
  );

  /** Client-side GeoJSON download from features already on the panel. */
  const exportSetGeoJson = useCallback(
    (setId: string) => {
      const set = drawings.find((s) => s.id === setId);
      if (!set) return;
      const result = downloadDrawingSetGeoJson(set);
      if (!result.downloaded) {
        setError(t('mapMarkup.exportEmpty'));
      } else {
        setError(null);
      }
    },
    [drawings, t],
  );

  const sorted = useMemo(
    () => [...drawings].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    [drawings],
  );

  // Keep activeSetId valid as sets come and go.
  useEffect(() => {
    if (activeSetId && drawings.some((s) => s.id === activeSetId)) return;
    const firstEditable = drawings.find((s) => canEditSet(s));
    setActiveSetId(firstEditable?.id ?? null);
    if (!firstEditable) setTool('off');
  }, [drawings, activeSetId, canEditSet]);

  // Pick up other viewers' markup when the tab regains focus, as the
  // prop doc above promises. Nothing called refresh before, so a page
  // open for an hour kept showing (and building on) its first copy.
  useEffect(() => {
    if (!open) return;
    const onFocus = () => {
      void refresh();
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [open, refresh]);

  if (!open) return null;
  return (
    <div
      role="dialog"
      aria-label={t('mapMarkup.panelAria')}
      className="absolute right-14 top-3 z-30 flex max-h-[70vh] w-80 flex-col rounded-md border border-border bg-surface-1 shadow-card max-md:left-3 max-md:right-3 max-md:top-16 max-md:w-auto"
    >
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <div className="flex items-center gap-2">
          <PencilLine className="h-4 w-4 text-muted" />
          <h2 className="text-sm font-semibold text-ink-1">
            {t('mapMarkup.title')}
          </h2>
        </div>
        <button
          type="button"
          onClick={() => {
            setTool('off');
            onClose();
          }}
          className="rounded p-1 text-muted hover:bg-surface-2 hover:text-ink-1"
          aria-label={t('mapMarkup.closeAria')}
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {tool !== 'off' ? (
        <p className="border-b border-border bg-surface-2 px-3 py-1.5 text-2xs text-muted">
          {hintForTool(tool, t)}
        </p>
      ) : null}

      <div className="overflow-y-auto px-2 py-2">
        {sorted.length === 0 ? (
          <p className="px-2 py-3 text-xs text-muted">
            {t('mapMarkup.empty')}
          </p>
        ) : (
          <ul className="space-y-1">
            {sorted.map((set) => {
              const editable = canEditSet(set);
              const isRenaming = editingTitleId === set.id;
              const isActive = activeSetId === set.id;
              return (
                <li
                  key={set.id}
                  className={`rounded border px-2 py-2 ${
                    isActive
                      ? 'border-accent/40 bg-accent/5'
                      : 'border-transparent hover:border-border hover:bg-surface-2'
                  }`}
                >
                  <div className="flex items-start gap-2">
                    <button
                      type="button"
                      onClick={() => toggleVisibility(set.id)}
                      className="mt-1 rounded text-muted hover:text-ink-1"
                      title={
                        set.visible ? t('mapMarkup.hide') : t('mapMarkup.show')
                      }
                      aria-label={
                        set.visible
                          ? t('mapMarkup.hideAria')
                          : t('mapMarkup.showAria')
                      }
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
                          title={
                            editable ? t('mapMarkup.renameTitle') : set.title
                          }
                        >
                          {set.title}
                        </button>
                      )}
                      <p className="truncate text-2xs text-muted">
                        {set.authorDisplay} - {fmt.relativeTime(set.updatedAt)}
                        {' - '}
                        {t('mapMarkup.features', {
                          count: set.features.length,
                        })}
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
                              aria-label={t('mapMarkup.setColorAria', {
                                color: c,
                              })}
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
                    <div className="mt-2 flex flex-wrap items-center gap-1">
                      <ToolButton
                        active={isActive && tool === 'point'}
                        disabled={busy}
                        label={t('mapMarkup.toolPin')}
                        onClick={() => armTool(set.id, 'point')}
                      >
                        <MapPin className="h-3 w-3" />
                      </ToolButton>
                      <ToolButton
                        active={isActive && tool === 'line'}
                        disabled={busy}
                        label={t('mapMarkup.toolLine')}
                        onClick={() => armTool(set.id, 'line')}
                      >
                        <Slash className="h-3 w-3" />
                      </ToolButton>
                      <ToolButton
                        active={isActive && tool === 'polygon'}
                        disabled={busy}
                        label={t('mapMarkup.toolPolygon')}
                        onClick={() => armTool(set.id, 'polygon')}
                      >
                        <Hexagon className="h-3 w-3" />
                      </ToolButton>
                      <ToolButton
                        active={isActive && tool === 'text'}
                        disabled={busy}
                        label={t('mapMarkup.toolText')}
                        onClick={() => armTool(set.id, 'text')}
                      >
                        <Type className="h-3 w-3" />
                      </ToolButton>
                      <ToolButton
                        active={isActive && tool === 'arrow'}
                        disabled={busy}
                        label={t('mapMarkup.toolArrow')}
                        onClick={() => armTool(set.id, 'arrow')}
                      >
                        <MoveRight className="h-3 w-3" />
                      </ToolButton>
                      <ToolButton
                        active={isActive && tool === 'circle'}
                        disabled={busy}
                        label={t('mapMarkup.toolCircle')}
                        onClick={() => armTool(set.id, 'circle')}
                      >
                        <Circle className="h-3 w-3" />
                      </ToolButton>
                      <button
                        type="button"
                        onClick={() => dropPinAtCenter(set.id)}
                        disabled={busy}
                        className="rounded border border-border bg-surface-1 px-1.5 py-1 text-2xs text-muted hover:bg-surface-2 hover:text-ink-1 disabled:opacity-50"
                        title={t('mapMarkup.dropPin')}
                      >
                        {t('mapMarkup.dropPinShort')}
                      </button>
                      <button
                        type="button"
                        onClick={() => exportSetGeoJson(set.id)}
                        disabled={busy || set.features.length === 0}
                        className="flex items-center gap-1 rounded border border-border bg-surface-1 px-1.5 py-1 text-2xs text-ink-1 hover:bg-surface-2 disabled:opacity-50"
                        title={t('mapMarkup.exportTitle')}
                      >
                        <Download className="h-3 w-3" />
                        {t('mapMarkup.export')}
                      </button>
                      {currentUser ? (
                        <button
                          type="button"
                          onClick={() => promoteSet(set.id)}
                          disabled={
                            busy ||
                            promoteBusyId === set.id ||
                            set.features.length === 0
                          }
                          className="flex items-center gap-1 rounded border border-border bg-surface-1 px-1.5 py-1 text-2xs text-ink-1 hover:bg-surface-2 disabled:opacity-50"
                          title={t('mapMarkup.promoteTitle')}
                        >
                          <ArrowUpFromLine className="h-3 w-3" />
                          {promoteBusyId === set.id
                            ? t('mapMarkup.promoting')
                            : t('mapMarkup.promote')}
                        </button>
                      ) : null}
                      <button
                        type="button"
                        onClick={() => removeSet(set.id)}
                        disabled={busy}
                        className="ml-auto rounded p-1 text-muted hover:bg-danger/10 hover:text-danger disabled:opacity-50"
                        aria-label={t('mapMarkup.deleteAria')}
                        title={t('mapMarkup.deleteAria')}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ) : set.features.length > 0 ? (
                    <div className="mt-2 flex flex-wrap items-center gap-1">
                      <button
                        type="button"
                        onClick={() => exportSetGeoJson(set.id)}
                        disabled={busy}
                        className="flex items-center gap-1 rounded border border-border bg-surface-1 px-1.5 py-1 text-2xs text-ink-1 hover:bg-surface-2 disabled:opacity-50"
                        title={t('mapMarkup.exportTitle')}
                      >
                        <Download className="h-3 w-3" />
                        {t('mapMarkup.export')}
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
        {canCreateMarkup ? (
          <>
            <button
              type="button"
              onClick={addSet}
              disabled={busy}
              className="flex w-full items-center justify-center gap-2 rounded border border-border bg-accent px-2 py-1.5 text-sm font-medium text-accent-foreground hover:opacity-90 disabled:opacity-50"
            >
              <Plus className="h-4 w-4" />
              {t('mapMarkup.addMarkup')}
            </button>
            {!currentUser && allowAnonymousDrawings ? (
              <p className="mt-2 text-2xs text-muted">
                {t('mapMarkup.anonymousHint')}
              </p>
            ) : null}
          </>
        ) : (
          <p className="text-xs text-muted">
            {t('mapMarkup.signInToMarkup')}
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

function ToolButton({
  active,
  disabled,
  label,
  onClick,
  children,
}: {
  active: boolean;
  disabled: boolean;
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      title={label}
      aria-label={label}
      className={`rounded border px-1.5 py-1 disabled:opacity-50 ${
        active
          ? 'border-accent bg-accent/15 text-ink-1'
          : 'border-border bg-surface-1 text-ink-1 hover:bg-surface-2'
      }`}
    >
      {children}
    </button>
  );
}

function kindForTool(
  tool: MarkupTool,
): DrawingFeature['kind'] | null {
  if (tool === 'point') return 'pin';
  if (tool === 'line') return 'line';
  if (tool === 'polygon') return 'polygon';
  if (tool === 'text') return 'text';
  if (tool === 'arrow') return 'arrow';
  if (tool === 'circle') return 'circle';
  return null;
}

function hintForTool(
  tool: MarkupTool,
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  switch (tool) {
    case 'point':
      return t('mapMarkup.hintPin');
    case 'line':
      return t('mapMarkup.hintLine');
    case 'polygon':
      return t('mapMarkup.hintPolygon');
    case 'text':
      return t('mapMarkup.hintText');
    case 'arrow':
      return t('mapMarkup.hintArrow');
    case 'circle':
      return t('mapMarkup.hintCircle');
    default:
      return '';
  }
}

function message(e: unknown, fallback: string): string {
  if (e instanceof Error) return e.message;
  return fallback;
}

