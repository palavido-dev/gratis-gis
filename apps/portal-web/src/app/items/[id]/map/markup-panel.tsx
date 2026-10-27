// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import { formatDate } from '@/lib/i18n/format';
import { useT } from '@/lib/i18n/locale-context';
import { DEFAULT_LOCALE } from '@/lib/i18n/locales';

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
 * Also: promote a set to a real data_layer the author owns.
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
import {
  drawModeFor,
  setDrawMode,
  startDraw,
  useCrosshairCursor,
  useTerraDraw,
  type MarkupDrawTool,
} from './use-terra-draw';

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
}: Props) {
  const t = useT();
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
        id: cryptoRandomUuid(),
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
        const nextSets = drawingsRef.current.map((s) =>
          s.id === setId ? updated : s,
        );
        setDrawings(nextSets);
        onDrawingsChange(nextSets);
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
        id: cryptoRandomUuid(),
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

  // Silence unused refresh warning (kept for future focus refetch).
  void refresh;

  if (!open) return null;
  return (
    <div
      role="dialog"
      aria-label={t('mapMarkup.panelAria')}
      className="absolute right-3 top-16 z-30 flex max-h-[70vh] w-80 flex-col rounded-md border border-border bg-surface-1 shadow-card max-md:left-3 max-md:right-3 max-md:w-auto"
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
                        {set.authorDisplay} - {formatRelative(set.updatedAt)}
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
              className="flex w-full items-center justify-center gap-2 rounded border border-border bg-accent px-2 py-1.5 text-sm font-medium text-accent-on hover:opacity-90 disabled:opacity-50"
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
  return formatDate(iso, DEFAULT_LOCALE);
}
