// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

/**
 * Feature editing inside the map builder (#82): move a feature's
 * vertices, add a feature, delete a feature, on any data layer the
 * viewer may write to. The steward's tools, not the editor item's:
 * no templates, no per-field allowlists, no snapping profiles, no
 * undo stack. Someone who needs those builds an editor item, which is
 * what it is for.
 *
 * Why this exists at all: a person who created a layer could not fix
 * one wrong vertex without first standing up a dedicated editing app
 * on top of it. #81 covered attributes through the attribute table;
 * this covers the shape.
 *
 * Shape of the integration:
 *
 *  - `useFeatureEditing` owns the tool state and every server call,
 *    and hands back three things: props the canvas needs (which
 *    layers' clicks to route here, and whether to suppress popups),
 *    the overlays to render inside the canvas container, and whether
 *    a tool is active so the select toolbar can stand down. The two
 *    tools cannot coexist: both want the click.
 *
 *  - terra-draw comes from the shared hooks in use-terra-draw.ts, the
 *    same instance shape the editor runtime uses.
 *
 *  - Geometry for an edit is fetched from the server, never taken off
 *    the rendered tile. The builder draws data layers as MVT, and a
 *    polygon that crosses a tile edge comes back from
 *    queryRenderedFeatures clipped to that edge; saving it would
 *    truncate the feature. `/features?entity=` returns the whole
 *    thing.
 *
 *  - Permission is the layer's, resolved server-side once per page
 *    load (`editableLayerIds`), and re-checked by the server on every
 *    write. The tools here are a convenience gate only.
 */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import type maplibregl from 'maplibre-gl';
import {
  Check,
  Loader2,
  Magnet,
  MousePointerSquareDashed,
  Plus,
  Trash2,
  X,
} from 'lucide-react';
import type { FeatureField, MapLayer, PickListData } from '@gratis-gis/shared-types';
import { toast } from '@/lib/toast';
import { parseApiError } from '@/lib/api-error';
import { useT } from '@/lib/i18n/locale-context';
import { useConfirm } from '@/components/dialog-provider';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { AttributeForm } from '../editor/attribute-form';
import {
  drawModeFor,
  roundCoordsToPrecision,
  setDrawMode,
  startDraw,
  useCrosshairCursor,
  useGeometryEdit,
  useTerraDraw,
  type DrawGeometryType,
  type GeometryEditRequest,
} from './use-terra-draw';
import type { MapCanvasHandle } from './map-canvas';

export type FeatureEditTool = 'off' | 'edit' | 'add' | 'delete';

/** What the builder already knows per editable map layer (#81). */
export interface EditableLayerInfo {
  fields: FeatureField[];
  geometryType: DrawGeometryType | null;
}

interface Args {
  map: maplibregl.Map | null;
  layers: MapLayer[];
  /** Map-layer ids whose underlying data_layer the viewer may write to. */
  editableLayerIds: ReadonlySet<string>;
  /** Declared schema and geometry per editable map layer, keyed by map-layer id. */
  layerInfo: Record<string, EditableLayerInfo>;
  pickLists: Record<string, PickListData>;
  canvasRef: React.RefObject<MapCanvasHandle | null>;
}

interface CanvasProps {
  editClaimedLayerIds: ReadonlySet<string>;
  onEditClaimedClick: (info: {
    layerId: string;
    featureId: string | number;
    properties: Record<string, unknown>;
  }) => void;
  suppressPopup: boolean;
}

export interface FeatureEditing {
  tool: FeatureEditTool;
  /** True while any tool is active; the select toolbar should be off. */
  active: boolean;
  /** Leave whatever tool is active, discarding an unsaved sketch or edit. */
  deactivate: () => void;
  canvasProps: CanvasProps;
  overlay: ReactNode;
}

interface PendingGeometryEdit extends GeometryEditRequest {
  properties: Record<string, unknown>;
  layerTitle: string;
}

interface PendingCreate {
  layerId: string;
  geometry: GeoJSON.Geometry;
  /** terra-draw's id for the sketch, so it can be removed after submit or cancel. */
  sketchId: string | number;
  layerTitle: string;
}

function dataLayerSource(layer: MapLayer | undefined) {
  if (!layer || layer.source.kind !== 'data-layer') return null;
  const { itemId, layerKey } = layer.source;
  if (typeof layerKey !== 'string' || !layerKey) return null;
  return { itemId, layerKey };
}

export function useFeatureEditing({
  map,
  layers,
  editableLayerIds,
  layerInfo,
  pickLists,
  canvasRef,
}: Args): FeatureEditing {
  const t = useT();
  const confirm = useConfirm();
  const [tool, setTool] = useState<FeatureEditTool>('off');
  const [snapping, setSnapping] = useState(false);
  // The layer an Add draws into. Defaults to the first editable layer
  // that has a geometry; a table layer has nothing to draw.
  const [addLayerId, setAddLayerId] = useState<string | null>(null);
  const [pendingEdit, setPendingEdit] = useState<PendingGeometryEdit | null>(null);
  const [pendingCreate, setPendingCreate] = useState<PendingCreate | null>(null);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [loadingFeature, setLoadingFeature] = useState(false);

  const { draw, ready } = useTerraDraw(map, { snapping });
  const geometryEdit = useGeometryEdit(draw, pendingEdit);

  const drawableLayers = useMemo(
    () =>
      layers.filter(
        (l) => editableLayerIds.has(l.id) && layerInfo[l.id]?.geometryType,
      ),
    [layers, editableLayerIds, layerInfo],
  );

  // Keep the add target valid as layers come and go.
  useEffect(() => {
    if (addLayerId && drawableLayers.some((l) => l.id === addLayerId)) return;
    setAddLayerId(drawableLayers[0]?.id ?? null);
  }, [drawableLayers, addLayerId]);

  const active = tool !== 'off';
  useCrosshairCursor(map, active);

  // terra-draw mode follows the tool. It is only STARTED for a draw or
  // an edit session; an inert instance does not compete with the
  // canvas for clicks in edit/delete mode, where the canvas's own
  // click routing is what identifies the feature.
  useEffect(() => {
    if (!draw || !ready) return;
    if (tool === 'add' && addLayerId && !pendingCreate) {
      const gt = layerInfo[addLayerId]?.geometryType;
      if (!gt) return;
      startDraw(draw);
      setDrawMode(draw, drawModeFor(gt));
      return;
    }
    if (pendingEdit) return; // useGeometryEdit owns the mode
    setDrawMode(draw, 'select');
  }, [draw, ready, tool, addLayerId, pendingCreate, pendingEdit, layerInfo]);

  // A finished sketch becomes a pending create; the attribute form
  // collects what the layer requires. The sketch stays in the store,
  // painted, until the form resolves, so the person can see what they
  // are describing.
  useEffect(() => {
    if (!draw || !ready || tool !== 'add') return;
    const handleFinish = (id: string | number) => {
      if (!addLayerId) return;
      const f = draw.getSnapshot().find((x) => String(x.id) === String(id));
      if (!f || !f.geometry) return;
      const layer = layers.find((l) => l.id === addLayerId);
      setPendingCreate({
        layerId: addLayerId,
        geometry: f.geometry as GeoJSON.Geometry,
        sketchId: id,
        layerTitle: layer?.title ?? 'layer',
      });
      setDrawMode(draw, 'select');
    };
    draw.on('finish', handleFinish);
    return () => {
      try {
        draw.off('finish', handleFinish);
      } catch {
        /* race on unmount */
      }
    };
  }, [draw, ready, tool, addLayerId, layers]);

  const clearSketch = useCallback(
    (sketchId: string | number) => {
      if (!draw) return;
      try {
        if (draw.hasFeature(sketchId)) draw.removeFeatures([sketchId]);
      } catch {
        /* already gone */
      }
    },
    [draw],
  );

  const leaveTool = useCallback(() => {
    if (pendingCreate) clearSketch(pendingCreate.sketchId);
    setPendingCreate(null);
    setPendingEdit(null);
    setSaveError(null);
    setTool('off');
    if (draw) {
      try {
        draw.stop();
      } catch {
        /* never started */
      }
    }
  }, [draw, pendingCreate, clearSketch]);

  const selectTool = useCallback(
    (next: FeatureEditTool) => {
      if (next === tool || next === 'off') {
        leaveTool();
        return;
      }
      if (pendingCreate) clearSketch(pendingCreate.sketchId);
      setPendingCreate(null);
      setPendingEdit(null);
      setSaveError(null);
      setTool(next);
    },
    [tool, leaveTool, pendingCreate, clearSketch],
  );

  /** Full geometry and attributes from the server, never the tile. */
  const fetchFeature = useCallback(
    async (layer: MapLayer, featureId: string) => {
      const src = dataLayerSource(layer);
      if (!src) return null;
      const res = await fetch(
        `/api/portal/items/${src.itemId}/layers/${encodeURIComponent(src.layerKey)}/features?entity=${encodeURIComponent(featureId)}`,
      );
      if (!res.ok) throw new Error(await parseApiError(res, 'Could not load the feature'));
      const fc = (await res.json()) as GeoJSON.FeatureCollection;
      const f = fc.features?.[0];
      if (!f || !f.geometry) return null;
      return {
        geometry: f.geometry,
        properties: (f.properties ?? {}) as Record<string, unknown>,
      };
    },
    [],
  );

  const onEditClaimedClick = useCallback(
    (info: { layerId: string; featureId: string | number; properties: Record<string, unknown> }) => {
      if (tool !== 'edit' && tool !== 'delete') return;
      const layer = layers.find((l) => l.id === info.layerId);
      const src = dataLayerSource(layer);
      if (!layer || !src) return;
      // The tile carries _global_id; MapCanvas's generateId rewrite
      // means info.featureId may be a sequential number instead.
      const featureId =
        typeof info.properties._global_id === 'string'
          ? info.properties._global_id
          : typeof info.featureId === 'string'
            ? info.featureId
            : null;
      if (!featureId) {
        toast.error(t('featureEdit.noStableId'));
        return;
      }

      if (tool === 'delete') {
        void (async () => {
          const ok = await confirm({
            title: t('featureEdit.deleteConfirmTitle'),
            message: t('featureEdit.deleteConfirmMessage', { layer: layer.title }),
            confirmLabel: t('featureEdit.deleteAction'),
            variant: 'danger',
          });
          if (!ok) return;
          setBusy(true);
          try {
            const res = await fetch(
              `/api/portal/items/${src.itemId}/layers/${encodeURIComponent(src.layerKey)}/features/${encodeURIComponent(featureId)}`,
              { method: 'DELETE' },
            );
            if (!res.ok && res.status !== 204) {
              throw new Error(await parseApiError(res, 'Delete failed'));
            }
            canvasRef.current?.refreshLayerSource(layer.id);
            toast.success(t('featureEdit.featureDeleted'));
          } catch (err) {
            toast.error(err instanceof Error ? err.message : t('featureEdit.deleteFailed'));
          } finally {
            setBusy(false);
          }
        })();
        return;
      }

      // A click while a session is open is a handle drag or a
      // mis-click, not a request to switch features. Switching would
      // discard the unsaved edit without a word; Cancel is explicit.
      if (pendingEdit || loadingFeature) return;
      const gt = layerInfo[layer.id]?.geometryType;
      if (!gt) {
        toast.error(t('featureEdit.noGeometry'));
        return;
      }
      setLoadingFeature(true);
      setSaveError(null);
      void (async () => {
        try {
          const full = await fetchFeature(layer, featureId);
          if (!full) {
            toast.error(t('featureEdit.notFound'));
            return;
          }
          setPendingEdit({
            key: layer.id,
            featureId,
            geometryType: gt,
            geometry: roundCoordsToPrecision(full.geometry),
            properties: full.properties,
            layerTitle: layer.title,
          });
        } catch (err) {
          toast.error(err instanceof Error ? err.message : t('featureEdit.loadFailed'));
        } finally {
          setLoadingFeature(false);
        }
      })();
    },
    [tool, layers, layerInfo, confirm, canvasRef, fetchFeature, pendingEdit, loadingFeature],
  );

  const saveGeometry = useCallback(async () => {
    if (!pendingEdit || !geometryEdit.currentGeometry) return;
    const layer = layers.find((l) => l.id === pendingEdit.key);
    const src = dataLayerSource(layer);
    if (!layer || !src) return;
    setBusy(true);
    setSaveError(null);
    try {
      const res = await fetch(
        `/api/portal/items/${src.itemId}/layers/${encodeURIComponent(src.layerKey)}/features/${encodeURIComponent(pendingEdit.featureId)}`,
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ geometry: geometryEdit.currentGeometry }),
        },
      );
      if (!res.ok) {
        setSaveError(await parseApiError(res, 'Save failed'));
        return;
      }
      setPendingEdit(null);
      canvasRef.current?.refreshLayerSource(layer.id);
      toast.success(t('featureEdit.shapeSaved'));
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : t('featureEdit.saveFailed'));
    } finally {
      setBusy(false);
    }
  }, [pendingEdit, geometryEdit.currentGeometry, layers, canvasRef]);

  const submitCreate = useCallback(
    async (values: Record<string, unknown>) => {
      if (!pendingCreate) return;
      const layer = layers.find((l) => l.id === pendingCreate.layerId);
      const src = dataLayerSource(layer);
      if (!layer || !src) return;
      setBusy(true);
      setSaveError(null);
      try {
        const res = await fetch(
          `/api/portal/items/${src.itemId}/layers/${encodeURIComponent(src.layerKey)}/features`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              features: [
                {
                  globalId: crypto.randomUUID(),
                  geometry: roundCoordsToPrecision(pendingCreate.geometry),
                  properties: values,
                },
              ],
            }),
          },
        );
        if (!res.ok) {
          setSaveError(await parseApiError(res, 'Could not add the feature'));
          return;
        }
        clearSketch(pendingCreate.sketchId);
        setPendingCreate(null);
        canvasRef.current?.refreshLayerSource(layer.id);
        toast.success(t('featureEdit.featureAdded'));
        // Back into draw mode for the next one.
        const gt = layerInfo[layer.id]?.geometryType;
        if (draw && gt) setDrawMode(draw, drawModeFor(gt));
      } catch (err) {
        setSaveError(err instanceof Error ? err.message : t('featureEdit.addFailed'));
      } finally {
        setBusy(false);
      }
    },
    [pendingCreate, layers, canvasRef, clearSketch, draw, layerInfo],
  );

  const cancelCreate = useCallback(() => {
    if (pendingCreate) clearSketch(pendingCreate.sketchId);
    setPendingCreate(null);
    setSaveError(null);
    const gt = addLayerId ? layerInfo[addLayerId]?.geometryType : null;
    if (draw && gt) setDrawMode(draw, drawModeFor(gt));
  }, [pendingCreate, clearSketch, addLayerId, layerInfo, draw]);

  const canvasProps: CanvasProps = useMemo(
    () => ({
      editClaimedLayerIds: active ? editableLayerIds : EMPTY_SET,
      onEditClaimedClick,
      suppressPopup: active,
    }),
    [active, editableLayerIds, onEditClaimedClick],
  );

  const overlay =
    editableLayerIds.size === 0 ? null : (
      <>
        <EditToolbar
          tool={tool}
          onSelect={selectTool}
          snapping={snapping}
          onToggleSnapping={() => setSnapping((s) => !s)}
          drawableLayers={drawableLayers}
          addLayerId={addLayerId}
          onAddLayerChange={setAddLayerId}
          canAdd={drawableLayers.length > 0}
          busy={busy || loadingFeature}
        />
        {tool === 'edit' && !pendingEdit ? (
          <Hint>
            {loadingFeature
              ? t('featureEdit.hintLoading')
              : t('featureEdit.hintEdit')}
          </Hint>
        ) : null}
        {tool === 'delete' ? <Hint>{t('featureEdit.hintDelete')}</Hint> : null}
        {tool === 'add' && !pendingCreate && addLayerId ? (
          <Hint>
            {layerInfo[addLayerId]?.geometryType === 'point'
              ? t('featureEdit.hintAddPoint')
              : t('featureEdit.hintAddPath')}
          </Hint>
        ) : null}
        {pendingEdit ? (
          <div className="absolute bottom-4 left-1/2 z-20 flex -translate-x-1/2 items-center gap-2 rounded-lg border border-border bg-surface-1/95 px-3 py-2 shadow-raised backdrop-blur">
            <span className="text-xs text-ink-1">
              {t('featureEdit.editingIn', { layer: pendingEdit.layerTitle })}
            </span>
            {geometryEdit.loadError || saveError ? (
              <span className="text-xs text-danger" role="alert">
                {geometryEdit.loadError ?? saveError}
              </span>
            ) : null}
            <button
              type="button"
              onClick={() => {
                setPendingEdit(null);
                setSaveError(null);
              }}
              disabled={busy}
              className="inline-flex h-7 items-center gap-1 rounded border border-border bg-surface-1 px-2 text-xs text-ink-1 hover:bg-surface-2 disabled:opacity-50"
            >
              <X className="h-3.5 w-3.5" />
              {t('featureEdit.cancel')}
            </button>
            <button
              type="button"
              onClick={() => void saveGeometry()}
              disabled={busy || !geometryEdit.dirty || !!geometryEdit.loadError}
              className="inline-flex h-7 items-center gap-1 rounded bg-accent px-3 text-xs font-medium text-accent-foreground hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
              {t('featureEdit.saveShape')}
            </button>
          </div>
        ) : null}
        <Dialog
          open={pendingCreate !== null}
          onOpenChange={(open) => {
            if (!open) cancelCreate();
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t('featureEdit.newFeatureTitle')}</DialogTitle>
            </DialogHeader>
            {pendingCreate ? (
              <AttributeForm
                fields={layerInfo[pendingCreate.layerId]?.fields ?? []}
                editableFieldNames={null}
                pickLists={pickLists}
                layerTitle={pendingCreate.layerTitle}
                submitting={busy}
                errorMessage={saveError}
                onCancel={cancelCreate}
                onSubmit={(values) => void submitCreate(values)}
                submitLabel={t('featureEdit.addAction')}
                title={t('featureEdit.newFeatureAttributes')}
              />
            ) : null}
          </DialogContent>
        </Dialog>
      </>
    );

  return { tool, active, deactivate: leaveTool, canvasProps, overlay };
}

const EMPTY_SET: ReadonlySet<string> = new Set();

function Hint({ children }: { children: ReactNode }) {
  return (
    <div className="pointer-events-none absolute left-1/2 top-4 z-20 -translate-x-1/2 rounded-md border border-border bg-surface-1/95 px-3 py-1.5 text-xs text-ink-1 shadow-card backdrop-blur">
      {children}
    </div>
  );
}

function EditToolbar({
  tool,
  onSelect,
  snapping,
  onToggleSnapping,
  drawableLayers,
  addLayerId,
  onAddLayerChange,
  canAdd,
  busy,
}: {
  tool: FeatureEditTool;
  onSelect: (t: FeatureEditTool) => void;
  snapping: boolean;
  onToggleSnapping: () => void;
  drawableLayers: MapLayer[];
  addLayerId: string | null;
  onAddLayerChange: (id: string) => void;
  canAdd: boolean;
  busy: boolean;
}) {
  const t = useT();
  return (
    <div className="absolute left-4 top-[6.25rem] z-10 flex items-center gap-1 rounded-lg border border-border bg-surface-1/95 p-1 shadow-raised backdrop-blur">
      <span className="px-1 text-2xs uppercase tracking-wide text-muted">{t('featureEdit.groupLabel')}</span>
      <ToolButton
        icon={MousePointerSquareDashed}
        label={t('featureEdit.editShape')}
        active={tool === 'edit'}
        onClick={() => onSelect('edit')}
      />
      <ToolButton
        icon={Plus}
        label={t('featureEdit.addFeature')}
        active={tool === 'add'}
        onClick={() => onSelect('add')}
        disabled={!canAdd}
      />
      <ToolButton
        icon={Trash2}
        label={t('featureEdit.deleteFeature')}
        active={tool === 'delete'}
        onClick={() => onSelect('delete')}
      />
      {tool === 'add' && drawableLayers.length > 1 ? (
        <select
          value={addLayerId ?? ''}
          onChange={(e) => onAddLayerChange(e.target.value)}
          className="ml-1 h-7 max-w-[12rem] rounded border border-border bg-surface-1 px-1 text-2xs text-ink-1 focus:border-accent focus:outline-none"
          aria-label={t('featureEdit.layerToAddTo')}
        >
          {drawableLayers.map((l) => (
            <option key={l.id} value={l.id}>
              {l.title}
            </option>
          ))}
        </select>
      ) : null}
      {tool !== 'off' ? (
        <>
          <div className="mx-1 h-5 w-px bg-border" />
          <ToolButton
            icon={Magnet}
            label={snapping ? t('featureEdit.snappingOn') : t('featureEdit.snappingOff')}
            active={snapping}
            onClick={onToggleSnapping}
          />
        </>
      ) : null}
      {busy ? <Loader2 className="ml-1 h-3.5 w-3.5 animate-spin text-muted" /> : null}
    </div>
  );
}

function ToolButton({
  icon: Icon,
  label,
  active,
  onClick,
  disabled = false,
}: {
  icon: typeof Plus;
  label: string;
  active: boolean;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      className={`inline-flex h-7 w-7 items-center justify-center rounded transition-colors disabled:opacity-40 ${
        active
          ? 'bg-accent text-accent-foreground'
          : 'text-muted hover:bg-surface-2 hover:text-ink-0'
      }`}
    >
      <Icon className="h-3.5 w-3.5" />
    </button>
  );
}
