// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import { useEffect, useRef, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Eye,
  EyeOff,
  Filter,
  Focus,
  Folder,
  FolderMinus,
  FolderPlus,
  GripVertical,
  Image as ImageIcon,
  MoreVertical,
  Mountain,
  MousePointerClick,
  Pencil,
  Plus,
  Search,
  Sparkles,
  Table as TableIcon,
  Tag,
  Telescope,
  Trash2,
  X,
} from 'lucide-react';
import type {
  MapLayer,
  MapLayerScale,
  MapLayerSearch,
  TerrainStackEntry,
} from '@gratis-gis/shared-types';
import {
  DEFAULT_LAYER_SCALE,
  MAX_GROUP_DEPTH,
  ZOOM_MAX,
  ZOOM_MIN,
  groupDepth,
} from '@gratis-gis/shared-types';
import { Color, Slider, StyleEditor } from './style-editor';
import { RendererEditor } from './renderer-editor';
import { FilterEditor } from './filter-editor';
import { PopupEditor } from './popup-editor';
import { LabelsEditor } from './labels-editor';
import { TemplateInput } from './template-input';
import { makeEmptyGroupLayer, uniqueGroupTitle } from './group-factory';
import {
  isTableLayer,
  type GeometryFamily,
  type LayerMetadata,
} from './layer-metadata';
import { LayerSwatch } from './layer-swatch';

interface Props {
  layers: MapLayer[];
  metadata: Record<string, LayerMetadata>;
  canEdit: boolean;
  /**
   * Current camera zoom. Rendered as a tick under each scale-range
   * slider so authors can see at a glance whether their thumbs bracket
   * the current view. Updates whenever the map camera changes.
   */
  currentZoom: number;
  onOpenAdd: () => void;
  /**
   * Create a new empty group at the top of the layer list (#70).
   * The factory lives in map-editor so all the MapLayer field
   * defaults stay co-located with the wizard's `makeLayer`. Auto-
   * rename is initiated here once the layer lands.
   */
  onAddGroup: () => void;
  /** Open the attribute table panel (#72). When called from the
   *  per-layer kebab the row passes its own id so the parent can
   *  focus that layer in the table. Called without an id from any
   *  global "open table" affordance (currently the toolbar
   *  toggle), which preserves the default-first-visible behavior.
   *  (#73) */
  onOpenAttributeTable: (focusLayerId?: string) => void;
  /** Fly the camera to a layer's feature extent (#72). The
   *  bounding box is computed in the LayerPanel from cached
   *  metadata, then handed to MapCanvas via this callback. */
  onZoomToLayer: (layerId: string) => void;
  /** #211: make sure the layer's preferred elevation layer is in
   *  the map's terrain stack. Only offered on rows whose source
   *  carries a stamped `preferredElevationItemId`; the handler
   *  lives in map-editor next to the rest of the terrain-stack
   *  mutators. Absent in runtimes that can't edit terrain. */
  onUseLayerElevation?: (layerId: string) => void;
  onChange: (next: MapLayer[]) => void;
  /**
   * Whether to render the "Add layer" / "Add group" split button at
   * the top of the panel. Defaults to true for the map editor's
   * normal authoring experience. Use cases like the Editor item
   * runtime, where the layer list is fixed by the editor's
   * configuration + referenced map, pass false to hide the
   * authoring affordance entirely.
   */
  showAddLayer?: boolean;
  /**
   * #211 (relocated per user feedback): the 3D terrain stack
   * editor, a collapsible section pinned under the layer list.
   * The stack affects how EVERY layer drapes, not just the
   * basemap, and its priority ordering shares the layer list's
   * top-wins mental model, so it lives with the layers rather
   * than in the basemap menu. Absent = section hidden (viewer
   * runtimes and read-only panels).
   */
  terrain?: {
    /** Effective stack, first entry wins. */
    stack: TerrainStackEntry[];
    /** 3D rendering on/off; the stack survives either way (user
     *  feedback: peeking at 2D must not wipe the ordering). */
    enabled: boolean;
    exaggeration?: number;
    /** Elevation layers available to add; null = not fetched
     *  yet (the section triggers onLoad lazily). */
    demLayers: Array<{
      id: string;
      title: string;
      tileUrl: string;
      maxZoom?: number;
    }> | null;
    onLoad: () => void;
    onAdd: (entry: TerrainStackEntry) => void;
    onRemove: (itemId: string) => void;
    onMove: (itemId: string, delta: -1 | 1) => void;
    onToggle: () => void;
    onExaggeration: (v: number) => void;
  };
}

const DRAG_MIME = 'application/x-gg-layer';

/**
 * Left-side layer panel.
 *
 * Per-row affordances:
 *   - Drag handle (HTML5 native drag-and-drop) for reorder.
 *   - Visibility toggle.
 *   - Remove.
 *   - Expand for Symbology / Filters / Popups / Interactions.
 *
 * Layer order mirrors render order (top of list draws on top).
 */
export function LayerPanel({
  layers,
  metadata,
  canEdit,
  currentZoom,
  onOpenAdd,
  onAddGroup,
  onOpenAttributeTable,
  onZoomToLayer,
  onUseLayerElevation,
  onChange,
  showAddLayer = true,
  terrain,
}: Props) {
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);
  // Split-button menu (#70). Open when the user clicks the chevron
  // half of the Add button; closes on outside click. The primary
  // half still does the most-common thing (Add layer) without
  // detouring through a menu.
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const addMenuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!addMenuOpen) return;
    function onDocClick(e: MouseEvent) {
      if (
        addMenuRef.current &&
        e.target instanceof Node &&
        !addMenuRef.current.contains(e.target)
      ) {
        setAddMenuOpen(false);
      }
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [addMenuOpen]);

  function updateLayer(id: string, patch: Partial<MapLayer>) {
    onChange(layers.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  }
  function removeLayer(id: string) {
    onChange(layers.filter((l) => l.id !== id));
  }
  // Collect every descendant id of a group (#71). Walks the tree
  // rooted at `groupId` so cascade helpers (toggle, opacity, remove,
  // ungroup) handle nested groups correctly: toggling a top-level
  // group flips every descendant's visibility, even those two levels
  // deep. Cycle-safe via the visited set; the editor disallows
  // cycles at edit time but defensive coding here is cheap.
  function collectDescendants(groupId: string): Set<string> {
    const found = new Set<string>([groupId]);
    const queue: string[] = [groupId];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      for (const l of layers) {
        if (l.groupId === cur && !found.has(l.id)) {
          found.add(l.id);
          // Continue past nested groups too, so their kids get
          // collected on subsequent passes.
          queue.push(l.id);
        }
      }
    }
    return found;
  }

  // Group operations cascade to children. Groups (#46, #71) live
  // flat in the data (a header row with source.kind='group' + N
  // siblings pointing at the header via groupId); the panel renders
  // them hierarchically and these helpers ensure the cascade matches
  // the visual mental model. Cascade is recursive after #71 so a
  // nested group toggle flips every descendant.
  function toggleGroup(groupId: string) {
    const header = layers.find((l) => l.id === groupId);
    if (!header) return;
    const nextVisible = !header.visible;
    const ids = collectDescendants(groupId);
    onChange(
      layers.map((l) => (ids.has(l.id) ? { ...l, visible: nextVisible } : l)),
    );
  }
  function setGroupOpacity(groupId: string, n: number) {
    const ids = collectDescendants(groupId);
    onChange(layers.map((l) => (ids.has(l.id) ? { ...l, opacity: n } : l)));
  }
  function removeGroup(groupId: string) {
    const ids = collectDescendants(groupId);
    onChange(layers.filter((l) => !ids.has(l.id)));
  }

  /**
   * Ungroup (#48, #71). Drops the group header but keeps its
   * direct children. Each child's `groupId` is reassigned to the
   * group's own parent (or cleared if the group was top-level), so
   * a nested-then-ungrouped subgroup's children rejoin the parent
   * group correctly instead of getting orphaned to the top.
   * Distinct from removeGroup, which deletes everything; ungroup
   * is the "I no longer want them collected" path.
   *
   * Under exactOptionalPropertyTypes the groupId field has to be
   * OMITTED rather than set to undefined; we use a destructure +
   * rest pattern when clearing.
   */
  function ungroup(groupId: string) {
    const header = layers.find((l) => l.id === groupId);
    const parentId = header?.groupId;
    onChange(
      layers
        .filter((l) => l.id !== groupId)
        .map((l) => {
          if (l.groupId !== groupId) return l;
          if (parentId) {
            return { ...l, groupId: parentId };
          }
          const { groupId: _drop, ...rest } = l;
          return rest as MapLayer;
        }),
    );
  }

  /**
   * Longest chain of nested groups starting at `g` (#71). 1 = group
   * with no nested subgroups; 2 = group containing one level of
   * sub-groups; and so on. Used together with groupDepth to gate
   * drop targets against MAX_GROUP_DEPTH.
   *
   * A leaf layer reports 0 because the depth cap is on group
   * nesting only; leaves can sit at any depth.
   */
  function subtreeGroupSpan(g: MapLayer): number {
    if (g.source.kind !== 'group') return 0;
    let max = 0;
    for (const l of layers) {
      if (l.groupId === g.id && l.source.kind === 'group') {
        const d = subtreeGroupSpan(l);
        if (d > max) max = d;
      }
    }
    return 1 + max;
  }

  /**
   * Whether `dragged` may be moved under `targetGroup` without
   * busting the MAX_GROUP_DEPTH cap (#71). Also rejects self-drops
   * and ancestor cycles (you can't park a parent group inside one
   * of its own descendants).
   *
   * - Leaves: allowed under any group.
   * - Groups: allowed when groupDepth(target) + subtreeGroupSpan(dragged) <= 3.
   *   So a leaf-only group can go under a depth-2 group, but a
   *   group-with-subgroups can only go under a top-level group.
   */
  function canMoveInto(dragged: MapLayer, targetGroup: MapLayer): boolean {
    if (targetGroup.source.kind !== 'group') return false;
    if (dragged.id === targetGroup.id) return false;
    // Cycle check: walk targetGroup's groupId chain; if dragged is
    // an ancestor we'd be creating a cycle.
    let cursor: string | undefined = targetGroup.groupId;
    const seen = new Set<string>([targetGroup.id]);
    while (cursor && !seen.has(cursor)) {
      if (cursor === dragged.id) return false;
      seen.add(cursor);
      const p = layers.find((l) => l.id === cursor);
      cursor = p?.groupId;
    }
    if (dragged.source.kind !== 'group') return true;
    const tgtDepth = groupDepth(targetGroup, layers);
    const span = subtreeGroupSpan(dragged);
    return tgtDepth + span <= MAX_GROUP_DEPTH;
  }

  /**
   * Reorder + (re)assign group membership in one operation (#48,
   * extended in #71 to support group-in-group). Used by drag-drop:
   *   - moveTo  : the row currently at this index becomes the
   *               position the dragged layer occupies post-move.
   *   - groupId : nullable. When set, the dragged layer joins
   *               that group; when null, the layer leaves any
   *               group it was in.
   *
   * Group headers can now ride into another group too, taking
   * their entire subtree along: every descendant has its groupId
   * left alone so the internal hierarchy is preserved. Drops that
   * would exceed MAX_GROUP_DEPTH or create a cycle are silently
   * rejected (the drop target's onDragOver guard already filters
   * these out, but defensive checks here keep us safe against
   * keyboard-driven moves we may add later).
   */
  function moveAndRegroup(
    from: number,
    to: number,
    groupId: string | null,
  ) {
    if (from < 0 || to < 0) return;
    const next = [...layers];
    const moved = next[from];
    if (!moved) return;
    if (groupId) {
      const target = layers.find((l) => l.id === groupId);
      if (!target || !canMoveInto(moved, target)) return;
    }
    next.splice(from, 1);
    // Adjust target index for the splice we just did.
    const adjustedTo = to > from ? to - 1 : to;
    let updated: MapLayer;
    if (groupId) {
      // Both leaves and group headers can take a new groupId now.
      // Descendants of a moved group keep their existing groupId
      // chain so the subtree relocates intact.
      updated = { ...moved, groupId };
    } else if (moved.groupId) {
      // Leave the group: omit groupId rather than set to undefined
      // (exactOptionalPropertyTypes rejects the latter).
      const { groupId: _drop, ...rest } = moved;
      updated = rest as MapLayer;
    } else {
      updated = moved;
    }
    next.splice(adjustedTo, 0, updated);
    onChange(next);
  }

  /**
   * Move a layer into an existing group (or to top level when
   * `targetGroupId` is null). Used by the per-layer kebab's
   * "Move to group" submenu (#72). Drops are silently no-op'd
   * when the target would exceed the depth cap or create a cycle.
   */
  function moveLayerToGroup(layerId: string, targetGroupId: string | null) {
    const idx = layers.findIndex((l) => l.id === layerId);
    if (idx < 0) return;
    if (targetGroupId === null) {
      // Move to top level. Park at index 0 so the freshly
      // promoted layer is easy to find.
      moveAndRegroup(idx, 0, null);
      return;
    }
    const tgtIdx = layers.findIndex((l) => l.id === targetGroupId);
    if (tgtIdx < 0) return;
    moveAndRegroup(idx, tgtIdx + 1, targetGroupId);
  }

  /**
   * Create a brand-new group at the top level and move this layer
   * into it as the only child (#72). Reuses the same factory + title
   * disambiguator the "Add group" menu item uses so the new row's
   * shape exactly matches an empty group created from scratch.
   */
  function createGroupAndMoveLayer(layerId: string) {
    const layer = layers.find((l) => l.id === layerId);
    if (!layer) return;
    const title = uniqueGroupTitle(layers, 'New group');
    const group = makeEmptyGroupLayer(title);
    const without = layers.filter((l) => l.id !== layerId);
    const child: MapLayer = { ...layer, groupId: group.id };
    onChange([group, child, ...without]);
  }

  /**
   * Compute the set of existing groups a leaf layer can be moved
   * into (#72). Filters by canMoveInto so the kebab menu hides
   * destinations that would break the depth cap or create a cycle.
   * The current parent (if any) is shown but disabled in the UI so
   * users see where the layer is today.
   */
  function groupOptionsFor(layer: MapLayer): MapLayer[] {
    return layers.filter(
      (l) => l.source.kind === 'group' && canMoveInto(layer, l),
    );
  }

  return (
    <div className="flex h-full flex-col border-r border-border bg-surface-1">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <h3 className="text-xs font-medium uppercase tracking-wide text-muted">
          Layers
        </h3>
        {canEdit && showAddLayer ? (
          <div ref={addMenuRef} className="relative inline-flex">
            {/* Split-button: primary half does the most-common
                action (Add layer); chevron half opens a tiny menu
                with the secondary actions (Add group, today). */}
            <button
              type="button"
              onClick={() => {
                setAddMenuOpen(false);
                onOpenAdd();
              }}
              className="inline-flex h-7 items-center gap-1 rounded-l-md border border-r-0 border-border bg-surface-1 px-2 text-xs font-medium text-ink-1 shadow-card hover:bg-surface-2"
            >
              <Plus className="h-3.5 w-3.5" />
              Add layer
            </button>
            <button
              type="button"
              onClick={() => setAddMenuOpen((o) => !o)}
              aria-haspopup="menu"
              aria-expanded={addMenuOpen}
              aria-label="More add options"
              className="inline-flex h-7 w-6 items-center justify-center rounded-r-md border border-border bg-surface-1 text-xs text-ink-1 shadow-card hover:bg-surface-2"
            >
              <ChevronDown className="h-3.5 w-3.5" />
            </button>
            {addMenuOpen ? (
              <div
                role="menu"
                className="absolute right-0 top-8 z-20 w-44 overflow-hidden rounded-md border border-border bg-surface-1 text-xs shadow-overlay"
              >
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setAddMenuOpen(false);
                    onOpenAdd();
                  }}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-ink-1 hover:bg-surface-2"
                >
                  <Plus className="h-3.5 w-3.5 text-muted" />
                  Add layer
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setAddMenuOpen(false);
                    onAddGroup();
                  }}
                  className="flex w-full items-center gap-2 border-t border-border px-3 py-2 text-left text-ink-1 hover:bg-surface-2"
                >
                  <FolderPlus className="h-3.5 w-3.5 text-muted" />
                  Add group
                </button>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      {layers.length === 0 ? (
        <div className="flex flex-1 items-center justify-center p-6 text-center">
          <div className="max-w-[18rem]">
            <Sparkles className="mx-auto mb-2 h-5 w-5 text-muted" />
            <p className="text-xs text-muted">
              No layers yet.{' '}
              {canEdit
                ? 'Add one from a URL, the portal, or the curated catalog.'
                : 'The owner has not added any layers.'}
            </p>
          </div>
        </div>
      ) : (
        <ul className="flex-1 overflow-y-auto">
          {(() => {
            // Recursive walker (#71). Groups can now contain other
            // groups, so we render the tree depth-first: each header
            // emits its row, then we descend into children that name
            // it as their groupId. Children are rendered in their
            // document order (the position they sit in `layers`).
            const headerIds = new Set<string>();
            for (const l of layers) {
              if (l.source.kind === 'group') headerIds.add(l.id);
            }
            const childrenByGroup = new Map<string, MapLayer[]>();
            for (const l of layers) {
              if (l.groupId && headerIds.has(l.groupId)) {
                const arr = childrenByGroup.get(l.groupId) ?? [];
                arr.push(l);
                childrenByGroup.set(l.groupId, arr);
              }
            }

            function renderRows(
              items: MapLayer[],
              depth: number,
            ): React.ReactElement[] {
              const out: React.ReactElement[] = [];
              for (const layer of items) {
                const i = layers.findIndex((l) => l.id === layer.id);
                if (layer.source.kind === 'group') {
                  const kids = childrenByGroup.get(layer.id) ?? [];
                  out.push(
                    <div
                      key={layer.id}
                      style={depth > 0 ? { paddingLeft: '14px' } : undefined}
                      className={
                        depth > 0 ? 'border-l-2 border-warn/25' : ''
                      }
                    >
                      <GroupHeaderRow
                        layer={layer}
                        index={i}
                        childCount={kids.length}
                        canEdit={canEdit}
                        currentZoom={currentZoom}
                        dragging={dragFrom === i}
                        onDragStart={() => setDragFrom(i)}
                        onDragEnd={() => {
                          setDragFrom(null);
                          setDragOver(null);
                        }}
                        onToggle={() => toggleGroup(layer.id)}
                        onOpacity={(n) => setGroupOpacity(layer.id, n)}
                        onRemove={() => removeGroup(layer.id)}
                        onRename={(title) =>
                          updateLayer(layer.id, { title })
                        }
                        onPatch={(p) => updateLayer(layer.id, p)}
                        onUngroup={() => ungroup(layer.id)}
                        onDropOnHeader={(sourceIdx) => {
                          if (sourceIdx === i) return;
                          moveAndRegroup(sourceIdx, i + 1, layer.id);
                        }}
                      />
                    </div>,
                  );
                  // Recurse into this group's children. Indent one
                  // more level by passing depth+1; the wrapper div
                  // adds the visual nesting cue.
                  const inner = renderRows(kids, depth + 1);
                  for (const node of inner) out.push(node);
                  continue;
                }
                const ki = i;
                out.push(
                  <div
                    key={layer.id}
                    style={depth > 0 ? { paddingLeft: '14px' } : undefined}
                    className={
                      depth > 0 ? 'border-l-2 border-warn/25' : ''
                    }
                  >
                    <LayerRow
                      layer={layer}
                      index={ki}
                      metadata={
                        metadata[layer.id] ?? {
                          fields: [],
                          valuesByField: {},
                          sampleProperties: null,
                          featureCollection: null,
                          geometryTypes: new Set(),
                          isTable: false,
                          error: null,
                          loading: true,
                        }
                      }
                      canEdit={canEdit}
                      currentZoom={currentZoom}
                      dragging={dragFrom === ki}
                      dropTarget={dragOver === ki}
                      onDragStart={() => setDragFrom(ki)}
                      onDragEnd={() => {
                        setDragFrom(null);
                        setDragOver(null);
                      }}
                      onDragEnter={() => setDragOver(ki)}
                      onDrop={(sourceIdx) =>
                        moveAndRegroup(sourceIdx, ki, layer.groupId ?? null)
                      }
                      onToggle={() =>
                        updateLayer(layer.id, { visible: !layer.visible })
                      }
                      onOpacity={(n) =>
                        updateLayer(layer.id, { opacity: n })
                      }
                      onRemove={() => removeLayer(layer.id)}
                      onPatch={(p) => updateLayer(layer.id, p)}
                      onOpenAttributeTable={() =>
                        onOpenAttributeTable(layer.id)
                      }
                      onZoomToExtent={() => onZoomToLayer(layer.id)}
                      {...(onUseLayerElevation
                        ? {
                            onUseLayerElevation: () =>
                              onUseLayerElevation(layer.id),
                          }
                        : {})}
                      groupOptions={groupOptionsFor(layer)}
                      onMoveToGroup={(gid) =>
                        moveLayerToGroup(layer.id, gid)
                      }
                      onMoveToNewGroup={() =>
                        createGroupAndMoveLayer(layer.id)
                      }
                    />
                  </div>,
                );
              }
              return out;
            }

            // Roots = layers with no parent group (or whose groupId
            // points at something we don't recognise as a header).
            const roots = layers.filter(
              (l) => !l.groupId || !headerIds.has(l.groupId),
            );
            return renderRows(roots, 0);
          })()}
        </ul>
      )}
      {terrain ? <TerrainSection terrain={terrain} /> : null}
    </div>
  );
}

/**
 * #211 (relocated per user feedback): the map's 3D terrain stack,
 * pinned under the layer list. The ground sits beneath the layers
 * it lifts, and the stack's priority ordering reads exactly like
 * the layer list above it: nearer the top wins where elevation
 * layers overlap.
 */
function TerrainSection({
  terrain,
}: {
  terrain: NonNullable<Props['terrain']>;
}) {
  const {
    stack,
    enabled,
    exaggeration,
    demLayers,
    onLoad,
    onAdd,
    onRemove,
    onMove,
    onToggle,
    onExaggeration,
  } = terrain;
  const [expanded, setExpanded] = useState(stack.length > 0);
  // Resolve stack-entry titles (and the add list) lazily: on first
  // expand, or immediately when the map already has terrain so the
  // rows never render as placeholders.
  useEffect(() => {
    if (expanded || stack.length > 0) onLoad();
  }, [expanded, stack.length, onLoad]);

  // Nothing to offer and nothing applied: hide the section rather
  // than render a dead end (matches the old basemap-menu gating).
  if (demLayers !== null && demLayers.length === 0 && stack.length === 0) {
    return null;
  }
  const inStack = new Set(stack.map((e) => e.itemId));
  const available = (demLayers ?? []).filter((d) => !inStack.has(d.id));
  const titleOf = (itemId: string) =>
    (demLayers ?? []).find((d) => d.id === itemId)?.title ?? 'Elevation layer';

  return (
    <div className="border-t border-border">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-muted hover:bg-surface-2"
        aria-expanded={expanded}
      >
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5" />
        )}
        <Mountain className="h-3.5 w-3.5" />
        <span>3D terrain</span>
        <span className="ml-auto text-2xs font-normal normal-case tracking-normal">
          {stack.length === 0
            ? 'off'
            : enabled
              ? `${stack.length} surface${stack.length > 1 ? 's' : ''}`
              : `${stack.length} surface${stack.length > 1 ? 's' : ''}, off`}
        </span>
      </button>
      {expanded ? (
        <div className="space-y-2 px-3 pb-3">
          {stack.length > 0 ? (
            /* Dormant styling while 3D is off: the list stays fully
               editable (build the stack in 2D, then flip it on) but
               reads as inactive. */
            <ul className={`space-y-0.5 ${enabled ? '' : 'opacity-60'}`}>
              {stack.map((entry, i) => {
                const title = titleOf(entry.itemId);
                return (
                  <li
                    key={entry.itemId}
                    className="flex items-center gap-1 rounded px-1 py-0.5 text-xs text-ink-1"
                  >
                    <span className="min-w-0 flex-1 truncate">{title}</span>
                    {i === 0 && stack.length > 1 ? (
                      <span className="shrink-0 text-2xs uppercase tracking-wide text-muted">
                        on top
                      </span>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => onMove(entry.itemId, -1)}
                      disabled={i === 0}
                      className="shrink-0 rounded p-0.5 text-muted enabled:hover:bg-surface-2 enabled:hover:text-ink-1 disabled:opacity-30"
                      aria-label={`Move ${title} up`}
                      title="Move up (wins where surfaces overlap)"
                    >
                      <ChevronUp className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => onMove(entry.itemId, 1)}
                      disabled={i === stack.length - 1}
                      className="shrink-0 rounded p-0.5 text-muted enabled:hover:bg-surface-2 enabled:hover:text-ink-1 disabled:opacity-30"
                      aria-label={`Move ${title} down`}
                      title="Move down"
                    >
                      <ChevronDown className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => onRemove(entry.itemId)}
                      className="shrink-0 rounded p-0.5 text-muted hover:bg-surface-2 hover:text-ink-1"
                      aria-label={`Remove ${title} from terrain`}
                      title="Remove"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : null}
          {stack.length > 1 ? (
            <p className="text-2xs leading-snug text-muted">
              Where elevation layers overlap, the one nearer the top
              of this list wins, same as the layers above.
            </p>
          ) : null}
          {demLayers === null ? (
            <p className="text-2xs text-muted">
              Looking for elevation layers...
            </p>
          ) : available.length > 0 ? (
            <div>
              <p className="px-1 py-0.5 text-2xs uppercase tracking-wide text-muted">
                {stack.length > 0 ? 'Add elevation' : 'Turn on 3D with'}
              </p>
              <ul>
                {available.map((d) => (
                  <li key={d.id}>
                    <button
                      type="button"
                      onClick={() =>
                        onAdd({
                          itemId: d.id,
                          tileUrl: d.tileUrl,
                          ...(typeof d.maxZoom === 'number'
                            ? { maxZoom: d.maxZoom }
                            : {}),
                        })
                      }
                      className="flex w-full items-center gap-1.5 rounded px-1 py-1 text-left text-xs text-ink-1 hover:bg-surface-2"
                    >
                      <Plus className="h-3 w-3 shrink-0 text-muted" />
                      <span className="truncate">{d.title}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {stack.length > 0 ? (
            <>
              {enabled ? (
                <div>
                  <label className="flex items-center justify-between text-2xs text-muted">
                    <span>Height boost</span>
                    <span className="font-medium text-ink-1">
                      {(exaggeration ?? 1).toFixed(2).replace(/\.?0+$/, '')}x
                    </span>
                  </label>
                  <input
                    type="range"
                    min={0.5}
                    max={3}
                    step={0.25}
                    value={exaggeration ?? 1}
                    onChange={(e) => onExaggeration(Number(e.target.value))}
                    className="mt-1 w-full accent-accent"
                    aria-label="Terrain height boost"
                  />
                  <p className="mt-0.5 text-2xs leading-snug text-muted">
                    1x is true height. Boost it to make gentle hills
                    easier to read. Tilt the map (right-drag) to see
                    the 3D.
                  </p>
                </div>
              ) : (
                <p className="text-2xs leading-snug text-muted">
                  3D is off; the map renders flat. Your surfaces and
                  their order are kept for when you turn it back on.
                </p>
              )}
              {/* On/off toggle, NOT a clear (user feedback): peeking
                  at the map in 2D must never cost the stack. */}
              <button
                type="button"
                onClick={onToggle}
                className="rounded border border-border px-2 py-1 text-2xs font-medium text-ink-1 hover:bg-surface-2"
              >
                {enabled ? 'Turn off 3D' : 'Turn on 3D'}
              </button>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

interface RowProps {
  layer: MapLayer;
  index: number;
  metadata: LayerMetadata;
  canEdit: boolean;
  currentZoom: number;
  dragging: boolean;
  dropTarget: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDragEnter: () => void;
  onDrop: (sourceIdx: number) => void;
  onToggle: () => void;
  onOpacity: (n: number) => void;
  onRemove: () => void;
  onPatch: (patch: Partial<MapLayer>) => void;
  /** Open the attribute table panel, focused on this layer (#73). */
  onOpenAttributeTable: () => void;
  /** Fly the camera to this layer's feature extent (#72). */
  onZoomToExtent: () => void;
  /** #211: put this layer's preferred elevation into the terrain
   *  stack (see Props.onUseLayerElevation). */
  onUseLayerElevation?: () => void;
  /** Existing groups this layer can validly move into. The list
   *  is pre-filtered against MAX_GROUP_DEPTH and cycle rules so
   *  the kebab submenu only shows landing pads that will actually
   *  accept the drop. (#72) */
  groupOptions: MapLayer[];
  /** Move this layer into an existing group (or to top level when
   *  null). Pairs with `groupOptions` for the submenu. (#72) */
  onMoveToGroup: (targetGroupId: string | null) => void;
  /** Create a new group and move this layer into it as its sole
   *  child. Used by the "+ New group" submenu item. (#72) */
  onMoveToNewGroup: () => void;
}

/**
 * The groups of layer settings, as tabs.
 *
 * They were six stacked collapsible sections in one column, so
 * reaching Popups meant scrolling past the whole of Symbology, and
 * comparing a label setting against a filter meant opening two and
 * scrolling between them. Tabs make each group a fixed, shallow
 * surface. The cost is never seeing two groups at once, which is the
 * right trade here because they are genuinely independent: nobody
 * tunes a colour ramp and a popup template together.
 *
 * Six became four by folding the two smallest into the group they
 * belong to. Scale is when a style draws, so it lives under Style.
 * Interactions is mostly popup triggers and hover behaviour, so it
 * lives under Popup, which also repairs an older split that put the
 * popup on/off switch in a different section from the popup's own
 * content.
 */
type LayerTab = 'style' | 'labels' | 'filter' | 'popup';

const LAYER_TABS: ReadonlyArray<{ id: LayerTab; label: string }> = [
  { id: 'style', label: 'Style' },
  { id: 'labels', label: 'Labels' },
  { id: 'filter', label: 'Filter' },
  { id: 'popup', label: 'Popup' },
];

/**
 * Tab strip for the layer settings.
 *
 * Roving tabindex: only the selected tab is in the tab order and the
 * arrows move between them. That is the ARIA tablist pattern, and it
 * earns its keep here because the panel is dense with focusable
 * controls; without it, tabbing through the layer list costs three
 * extra presses per expanded layer.
 */
function LayerTabStrip({
  value,
  onChange,
}: {
  value: LayerTab;
  onChange: (next: LayerTab) => void;
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const move = (dir: 1 | -1 | 'first' | 'last') => {
    const i = LAYER_TABS.findIndex((t) => t.id === value);
    const next =
      dir === 'first'
        ? 0
        : dir === 'last'
          ? LAYER_TABS.length - 1
          : (i + dir + LAYER_TABS.length) % LAYER_TABS.length;
    onChange(LAYER_TABS[next]!.id);
    refs.current[next]?.focus();
  };
  return (
    <div
      role="tablist"
      aria-label="Layer settings"
      className="flex border-t border-border"
      onKeyDown={(e) => {
        if (e.key === 'ArrowRight') {
          e.preventDefault();
          move(1);
        } else if (e.key === 'ArrowLeft') {
          e.preventDefault();
          move(-1);
        } else if (e.key === 'Home') {
          e.preventDefault();
          move('first');
        } else if (e.key === 'End') {
          e.preventDefault();
          move('last');
        }
      }}
    >
      {LAYER_TABS.map((t, i) => {
        const active = t.id === value;
        return (
          <button
            key={t.id}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={`layer-tab-${t.id}`}
            aria-selected={active}
            aria-controls={`layer-tabpanel-${t.id}`}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(t.id)}
            className={`flex-1 border-b-2 px-2 py-2 text-xs font-medium transition ${
              active
                ? 'border-accent text-ink-0'
                : 'border-transparent text-muted hover:text-ink-1'
            }`}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

/** Content area for one tab. */
function LayerTabPanel({
  tab,
  active,
  children,
}: {
  tab: LayerTab;
  active: LayerTab;
  children: React.ReactNode;
}) {
  if (tab !== active) return null;
  return (
    <div
      role="tabpanel"
      id={`layer-tabpanel-${tab}`}
      aria-labelledby={`layer-tab-${tab}`}
      className="px-3 pb-3 pt-3"
    >
      {children}
    </div>
  );
}

function LayerRow({
  layer,
  index,
  metadata,
  canEdit,
  currentZoom,
  dragging,
  dropTarget,
  onDragStart,
  onDragEnd,
  onDragEnter,
  onDrop,
  onToggle,
  onOpacity,
  onRemove,
  onPatch,
  onOpenAttributeTable,
  onZoomToExtent,
  onUseLayerElevation,
  groupOptions,
  onMoveToGroup,
  onMoveToNewGroup,
}: RowProps) {
  const [expanded, setExpanded] = useState(false);
  // Table layers (non-spatial sublayers from arcgis services) carry
  // attribute data but no geometry, so the cartographic editors
  // (symbology, labels, filters, popups, interactions, scale) and
  // the legend's geometry swatches are not meaningful. We detect
  // them once metadata has loaded and suppress the irrelevant UI.
  // (#73)
  const isTable = isTableLayer(layer, metadata);
  // #179 unit 3: point-cloud layers render through the 3D overlay,
  // not the 2D pipeline, so the geometry-bound editors (symbology,
  // labels, popups, filters, attribute table) don't apply. They
  // get their own compact style options instead.
  const isPointCloud = layer.source.kind === 'point-cloud';
  // #185: tile layers are prerendered imagery; no attributes, no
  // geometry-bound editors. Opacity + zoom-to-coverage is the whole
  // control surface.
  const isTileOverlay = layer.source.kind === 'tile';
  // Narrowed alias: the JSX guard's narrowing doesn't survive into
  // onChange closures, so spreads there see the wide union without
  // this.
  const pcSource = layer.source.kind === 'point-cloud' ? layer.source : null;
  // Which group of layer settings is showing. Per row, and it
  // deliberately survives collapsing and re-expanding the row: an
  // author working through popups on several layers should not be
  // sent back to Style each time.
  const [tab, setTab] = useState<LayerTab>('style');
  // Inline rename (#72). Click the title or the kebab's Rename
  // item to start; commit on blur or Enter, cancel on Escape.
  // Same pattern as GroupHeaderRow so the two row types feel
  // identical to the user.
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(layer.title);
  // Kebab menu (#72). Opens on click of the three-dot button;
  // closes on outside click or Escape. Holds the move-to-group
  // submenu state too so we can toggle it inline without a
  // floating popover library.
  const [menuOpen, setMenuOpen] = useState(false);
  const [moveSubOpen, setMoveSubOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!menuOpen) return;
    function onDocClick(e: MouseEvent) {
      if (
        menuRef.current &&
        e.target instanceof Node &&
        !menuRef.current.contains(e.target)
      ) {
        setMenuOpen(false);
        setMoveSubOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setMenuOpen(false);
        setMoveSubOpen(false);
      }
    }
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  // Drag-and-drop: the row itself is the drag source and drop target.
  // We carry the source index in dataTransfer so cross-list drops would
  // also work if we ever add them; today the list is intra-panel.
  function handleDragStart(e: React.DragEvent) {
    e.dataTransfer.setData(DRAG_MIME, String(index));
    e.dataTransfer.effectAllowed = 'move';
    onDragStart();
  }
  function handleDragOver(e: React.DragEvent) {
    if (!e.dataTransfer.types.includes(DRAG_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  }
  function handleDragEnter() {
    onDragEnter();
  }
  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    const raw = e.dataTransfer.getData(DRAG_MIME);
    const from = Number(raw);
    if (!Number.isFinite(from)) return;
    onDrop(from);
    onDragEnd();
  }

  return (
    <li
      onDragOver={canEdit ? handleDragOver : undefined}
      onDragEnter={canEdit ? handleDragEnter : undefined}
      onDrop={canEdit ? handleDrop : undefined}
      className={`border-b border-border transition-colors last:border-0 ${
        dropTarget && !dragging ? 'bg-accent/5' : ''
      } ${dragging ? 'opacity-50' : ''}`}
    >
      <div className="flex items-center gap-1 px-1.5 py-2">
        {canEdit ? (
          <span
            draggable
            onDragStart={handleDragStart}
            onDragEnd={onDragEnd}
            aria-label="Drag to reorder"
            className="inline-flex h-6 w-5 shrink-0 cursor-grab items-center justify-center text-muted hover:text-ink-1 active:cursor-grabbing"
          >
            <GripVertical className="h-3.5 w-3.5" />
          </span>
        ) : (
          <span className="inline-block h-6 w-5 shrink-0" />
        )}
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-label={expanded ? 'Collapse' : 'Expand'}
          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted hover:bg-surface-2"
        >
          <ChevronRight
            className={`h-3.5 w-3.5 transition-transform ${expanded ? 'rotate-90' : ''}`}
          />
        </button>
        {/* Visibility eye is meaningless for table-mode sublayers
            (#77): tables don't render on the map, so hiding them
            does nothing visible. Render a non-interactive spacer
            so the row layout stays aligned with non-table siblings
            but the affordance doesn't lie about being a control.
            Symbology slot below also hides for tables, for the
            same reason. */}
        {isTable ? (
          <span
            aria-hidden
            className="inline-flex h-6 w-6 shrink-0"
          />
        ) : (
          <button
            type="button"
            onClick={onToggle}
            aria-label={layer.visible ? 'Hide layer' : 'Show layer'}
            // Visibility is a session-local view preference, not a
            // config edit: anyone viewing the map (including share-
            // viewers and editor-runtime users) can hide layers they
            // don't want to see in their own session. Persistence is
            // gated separately by the parent's autosave (markDirty
            // skips when canEdit is false), so toggling on a view-
            // only map updates local state without firing a PATCH.
            // Matches AGO / Esri behavior: viewers can change what
            // they see, only authors can save it back.
            className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted hover:bg-surface-2"
          >
            {layer.visible ? (
              <Eye className="h-3.5 w-3.5" />
            ) : (
              <EyeOff className="h-3.5 w-3.5 text-muted" />
            )}
          </button>
        )}

        {/* Symbology swatch (#311). Mirrors what MapCanvas paints
            on the map so users can scan the panel and know what
            color / shape each layer is at a glance. Hidden for
            tables since they have no rendered symbology. We pick
            the first geometry the metadata reports; categorical /
            class-break renderers handle their own multi-band visual
            inside LayerSwatch. */}
        {isPointCloud ? (
          /* Point clouds have no 2D symbology; a terrain glyph
             tells the user what kind of layer this is at a
             glance. */
          <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center">
            <Mountain
              className={`h-3.5 w-3.5 ${layer.visible ? 'text-accent' : 'text-muted'}`}
            />
          </span>
        ) : isTileOverlay ? (
          /* #185: imagery glyph for tile layers. */
          <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center">
            <ImageIcon
              className={`h-3.5 w-3.5 ${layer.visible ? 'text-accent' : 'text-muted'}`}
            />
          </span>
        ) : !isTable ? (
          <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center">
            <LayerSwatch
              layer={layer}
              dimmed={!layer.visible}
              geometryType={
                metadata.geometryTypes && metadata.geometryTypes.size > 0
                  ? (Array.from(metadata.geometryTypes)[0] as
                      | 'point'
                      | 'line'
                      | 'polygon')
                  : undefined
              }
            />
          </span>
        ) : null}

        {editingTitle && canEdit ? (
          <input
            autoFocus
            type="text"
            value={titleDraft}
            onChange={(e) => setTitleDraft(e.target.value)}
            onBlur={() => {
              const t = titleDraft.trim();
              if (t && t !== layer.title) onPatch({ title: t });
              else setTitleDraft(layer.title);
              setEditingTitle(false);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              if (e.key === 'Escape') {
                setTitleDraft(layer.title);
                setEditingTitle(false);
              }
            }}
            // Stop the click from bubbling to the row's expand
            // toggle so typing doesn't accidentally collapse.
            onClick={(e) => e.stopPropagation()}
            className="h-6 min-w-0 flex-1 rounded border border-border bg-surface-1 px-1.5 text-sm"
          />
        ) : (
          <div
            className="min-w-0 flex-1 cursor-pointer truncate text-sm"
            onClick={() => setExpanded((v) => !v)}
            onDoubleClick={() => canEdit && setEditingTitle(true)}
            title={
              canEdit ? `${layer.title} (double-click to rename)` : layer.title
            }
          >
            <span className={layer.visible ? 'text-ink-0' : 'text-muted'}>
              {layer.title}
            </span>
          </div>
        )}

        <div ref={menuRef} className="relative">
          <button
            type="button"
            onClick={() => {
              setMenuOpen((o) => !o);
              setMoveSubOpen(false);
            }}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label="Layer actions"
            className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted hover:bg-surface-2 hover:text-ink-1"
          >
            <MoreVertical className="h-3.5 w-3.5" />
          </button>
          {menuOpen ? (
            <div
              role="menu"
              className="absolute right-0 top-7 z-30 w-56 overflow-visible rounded-md border border-border bg-surface-1 text-xs shadow-overlay"
            >
              {/* Read-side actions: available to viewers AND
                  authors. (#311) */}
              {!isPointCloud && !isTileOverlay ? (
                <MenuItem
                  Icon={TableIcon}
                  label="Open attribute table"
                  onClick={() => {
                    setMenuOpen(false);
                    onOpenAttributeTable();
                  }}
                />
              ) : null}
              {/* Labels and zoom-to-extent are geometry-bound:
                  suppress them on table layers since they would
                  have no effect. (#73) Point clouds zoom via their
                  stamped WGS84 bbox instead of walking features. */}
              {!isTable && !isPointCloud && !isTileOverlay ? (
                <>
                  <MenuItem
                    Icon={Tag}
                    label={
                      layer.labels.enabled ? 'Hide labels' : 'Show labels'
                    }
                    onClick={() => {
                      setMenuOpen(false);
                      onPatch({
                        labels: {
                          ...layer.labels,
                          enabled: !layer.labels.enabled,
                        },
                      });
                    }}
                  />
                  <MenuItem
                    Icon={Focus}
                    label="Zoom to layer extent"
                    onClick={() => {
                      setMenuOpen(false);
                      onZoomToExtent();
                    }}
                    disabled={
                      !metadata.featureCollection ||
                      metadata.featureCollection.features.length === 0
                    }
                  />
                </>
              ) : null}
              {isPointCloud || isTileOverlay ? (
                /* Point clouds and tile layers zoom via their
                   stamped WGS84 coverage box instead of walking
                   features. */
                <>
                  <MenuItem
                    Icon={Focus}
                    label="Zoom to layer extent"
                    onClick={() => {
                      setMenuOpen(false);
                      onZoomToExtent();
                    }}
                    disabled={
                      !(
                        (layer.source.kind === 'point-cloud' ||
                          layer.source.kind === 'tile') &&
                        layer.source.bboxWgs84
                      )
                    }
                  />
                  {/* #211: only offered when the item stamped a
                      preferred elevation layer at add time. The
                      wording is honest about what happens: one
                      terrain mesh per map, so this ensures the
                      layer's DEM is in the map's elevation stack
                      rather than pretending at per-layer terrain. */}
                  {canEdit &&
                  onUseLayerElevation &&
                  (layer.source.kind === 'point-cloud' ||
                    layer.source.kind === 'tile') &&
                  layer.source.preferredElevationItemId ? (
                    <MenuItem
                      Icon={Mountain}
                      label="Use this layer's elevation"
                      onClick={() => {
                        setMenuOpen(false);
                        onUseLayerElevation();
                      }}
                    />
                  ) : null}
                </>
              ) : null}
              {/* Author-only actions: rename, move-to-group, remove.
                  Hidden for viewers since they can't persist
                  changes anyway. (#311) */}
              {canEdit ? (
                <>
                  <div className="border-t border-border" />
                  <MenuItem
                    Icon={Pencil}
                    label="Rename"
                    onClick={() => {
                      setMenuOpen(false);
                      setTitleDraft(layer.title);
                      setEditingTitle(true);
                    }}
                  />
                {/* Move to group: nested submenu, opened inline so
                    we don't need a floating-element library. List
                    the layer's existing parent at the top so the
                    user knows where they are; selecting a different
                    group calls the parent's reparent helper. */}
                <div className="border-t border-border">
                  <button
                    type="button"
                    role="menuitem"
                    aria-haspopup="menu"
                    aria-expanded={moveSubOpen}
                    onClick={() => setMoveSubOpen((v) => !v)}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-surface-2"
                  >
                    <FolderPlus className="h-3.5 w-3.5 text-muted" />
                    <span className="flex-1">Move to group</span>
                    <ChevronRight
                      className={`h-3.5 w-3.5 text-muted transition-transform ${
                        moveSubOpen ? 'rotate-90' : ''
                      }`}
                    />
                  </button>
                  {moveSubOpen ? (
                    <ul className="border-t border-border bg-surface-2/40">
                      {layer.groupId ? (
                        <li>
                          <button
                            type="button"
                            role="menuitem"
                            onClick={() => {
                              setMenuOpen(false);
                              setMoveSubOpen(false);
                              onMoveToGroup(null);
                            }}
                            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-ink-1 hover:bg-surface-2"
                          >
                            <FolderMinus className="h-3.5 w-3.5 text-muted" />
                            Top level
                          </button>
                        </li>
                      ) : null}
                      <li>
                        <button
                          type="button"
                          role="menuitem"
                          onClick={() => {
                            setMenuOpen(false);
                            setMoveSubOpen(false);
                            onMoveToNewGroup();
                          }}
                          className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-ink-1 hover:bg-surface-2"
                        >
                          <Plus className="h-3.5 w-3.5 text-muted" />
                          New group
                        </button>
                      </li>
                      {groupOptions.length > 0 ? (
                        <li className="border-t border-border" />
                      ) : null}
                      {groupOptions.map((g) => (
                        <li key={g.id}>
                          <button
                            type="button"
                            role="menuitem"
                            disabled={g.id === layer.groupId}
                            onClick={() => {
                              setMenuOpen(false);
                              setMoveSubOpen(false);
                              onMoveToGroup(g.id);
                            }}
                            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-ink-1 hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            <Folder className="h-3.5 w-3.5 text-warn" />
                            <span className="truncate">{g.title}</span>
                            {g.id === layer.groupId ? (
                              <span className="ml-auto text-2xs uppercase tracking-wide text-muted">
                                current
                              </span>
                            ) : null}
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
                <MenuItem
                  Icon={Trash2}
                  label="Remove"
                  destructive
                  onClick={() => {
                    setMenuOpen(false);
                    onRemove();
                  }}
                />
                </>
              ) : null}
              </div>
            ) : null}
          </div>
      </div>

      {expanded ? (
        <div className="space-y-0 border-t border-border bg-surface-2">
          {/* Tables (no geometry) skip the cartographic editors:
              opacity / symbology / labels / filters / popups /
              interactions / scale all manipulate something visual,
              and a table never renders. Show an unobtrusive hint
              instead so the user knows where to look. (#73) */}
          {pcSource ? (
            /* #179 unit 3: compact 3D style options. Persisted on
               the layer source. Each point-cloud layer drives its
               own overlay control, so these are honestly per-layer
               (user feedback). */
            <div className="space-y-2 px-3 py-3">
              <label className="flex items-center justify-between gap-2 text-2xs uppercase tracking-wide text-muted">
                <span>Color by</span>
                <select
                  value={
                    pcSource.colorScheme ??
                    (pcSource.hasRgb ? 'rgb' : 'elevation')
                  }
                  disabled={!canEdit}
                  onChange={(e) =>
                    onPatch({
                      source: {
                        ...pcSource,
                        colorScheme: e.target.value as
                          | 'elevation'
                          | 'intensity'
                          | 'classification'
                          | 'rgb',
                      },
                    })
                  }
                  className="rounded border border-border bg-surface-0 px-1.5 py-1 text-xs normal-case text-ink-0 disabled:opacity-50"
                >
                  <option value="elevation">Elevation</option>
                  <option value="intensity">Intensity</option>
                  <option value="classification">Classification</option>
                  <option value="rgb" disabled={!pcSource.hasRgb}>
                    RGB {pcSource.hasRgb ? '' : '(not in file)'}
                  </option>
                </select>
              </label>
              {/* Colormap only shapes elevation / intensity ramps;
                  classification and RGB bring their own colors. */}
              {(pcSource.colorScheme ?? 'elevation') === 'elevation' ||
              pcSource.colorScheme === 'intensity' ? (
                <label className="flex items-center justify-between gap-2 text-2xs uppercase tracking-wide text-muted">
                  <span>Color ramp</span>
                  <select
                    value={pcSource.colormap ?? 'viridis'}
                    disabled={!canEdit}
                    onChange={(e) =>
                      onPatch({
                        source: {
                          ...pcSource,
                          colormap: e.target
                            .value as NonNullable<typeof pcSource.colormap>,
                        },
                      })
                    }
                    className="rounded border border-border bg-surface-0 px-1.5 py-1 text-xs normal-case text-ink-0 disabled:opacity-50"
                  >
                    <option value="viridis">Viridis</option>
                    <option value="plasma">Plasma</option>
                    <option value="inferno">Inferno</option>
                    <option value="magma">Magma</option>
                    <option value="cividis">Cividis</option>
                    <option value="turbo">Turbo</option>
                    <option value="terrain">Terrain</option>
                    <option value="coolwarm">Cool-warm</option>
                    <option value="gray">Grayscale</option>
                  </select>
                </label>
              ) : null}
              <label className="flex items-center justify-between text-2xs uppercase tracking-wide text-muted">
                <span>Point size</span>
                <span className="tabular-nums">
                  {(pcSource.pointSize ?? 2).toFixed(1)}
                </span>
              </label>
              <input
                type="range"
                min={0.5}
                max={6}
                step={0.5}
                value={pcSource.pointSize ?? 2}
                disabled={!canEdit}
                onChange={(e) =>
                  onPatch({
                    source: {
                      ...pcSource,
                      pointSize: Number(e.target.value),
                    },
                  })
                }
                className="w-full accent-accent disabled:opacity-50"
              />
              <label className="flex items-center justify-between text-2xs uppercase tracking-wide text-muted">
                <span>Opacity</span>
                <span className="tabular-nums">
                  {Math.round(layer.opacity * 100)}%
                </span>
              </label>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={layer.opacity}
                disabled={!canEdit}
                onChange={(e) => onOpacity(Number(e.target.value))}
                className="w-full accent-accent disabled:opacity-50"
              />
              <p className="text-2xs leading-relaxed text-muted">
                Streams by viewport in 3D. Tilt the map to look
                across the terrain.
              </p>
            </div>
          ) : isTable ? (
            <div className="px-3 py-3 text-xs text-muted">
              This is a non-spatial table. Open the attribute table
              from the kebab menu to view its records.
            </div>
          ) : (
            <div className="px-3 py-3">
              <label className="flex items-center justify-between text-2xs uppercase tracking-wide text-muted">
                <span>Opacity</span>
                <span className="tabular-nums">
                  {Math.round(layer.opacity * 100)}%
                </span>
              </label>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={layer.opacity}
                disabled={!canEdit}
                onChange={(e) => onOpacity(Number(e.target.value))}
                className="mt-1 w-full accent-accent disabled:opacity-50"
              />
            </div>
          )}

          {canEdit && !isTable && !isPointCloud && !isTileOverlay ? (
            <>
              <LayerTabStrip value={tab} onChange={setTab} />

              <LayerTabPanel tab="style" active={tab}>
                <RendererEditor
                  value={layer.renderer}
                  metadata={metadata}
                  layer={layer}
                  onChange={(renderer) => onPatch({ renderer })}
                />
                <div className="mt-3 border-t border-border pt-3">
                  <StyleEditor
                    value={layer.style}
                    onChange={(style) => onPatch({ style })}
                    {...(metadata.geometryTypes
                      ? { geometryTypes: metadata.geometryTypes }
                      : {})}
                    fields={metadata.fields}
                  />
                </div>
                <div className="mt-3 border-t border-border pt-3">
                  <ScaledSymbologyEditor
                    layer={layer}
                    onPatch={onPatch}
                    currentZoom={currentZoom}
                    {...(metadata.geometryTypes
                      ? { geometryTypes: metadata.geometryTypes }
                      : {})}
                  />
                </div>
                <div className="mt-3 border-t border-border pt-3">
                  <p className="mb-1.5 text-2xs font-medium uppercase tracking-wide text-muted">
                    Visible zoom range
                  </p>
                <ScaleEditor
                  value={layer.scale ?? DEFAULT_LAYER_SCALE}
                  currentZoom={currentZoom}
                  onChange={(scale) => onPatch({ scale })}
                />
                </div>
              </LayerTabPanel>

              <LayerTabPanel tab="labels" active={tab}>
                <LabelsEditor
                  value={layer.labels}
                  metadata={metadata}
                  onChange={(labels) => onPatch({ labels })}
                />
              </LayerTabPanel>

              <LayerTabPanel tab="filter" active={tab}>
                <FilterEditor
                  value={layer.filter}
                  metadata={metadata}
                  onChange={(filter) => onPatch({ filter })}
                />
              </LayerTabPanel>

              <LayerTabPanel tab="popup" active={tab}>
                <PopupEditor
                  value={layer.popup}
                  metadata={metadata}
                  onChange={(popup) => onPatch({ popup })}
                />
                <div className="mt-3 border-t border-border pt-3">
                <div className="space-y-1.5 text-sm">
                  {/* Popup triggers (#74 follow-up): moved here from
                      the POPUPS section so all per-layer behavior
                      toggles live together. The POPUPS section
                      stays for content configuration (title /
                      body templates) but the on/off live here. */}
                  <Toggle
                    Icon={MousePointerClick}
                    label="Click shows popup"
                    checked={layer.popup.enabled}
                    onChange={(v) =>
                      onPatch({
                        popup: { ...layer.popup, enabled: v },
                      })
                    }
                  />
                  <Toggle
                    Icon={Sparkles}
                    label="Popup on hover"
                    checked={layer.popup.showOnHover === true}
                    onChange={(v) =>
                      onPatch({
                        popup: { ...layer.popup, showOnHover: v },
                      })
                    }
                  />
                  <Toggle
                    Icon={Sparkles}
                    label="Highlight on hover"
                    checked={layer.interactions.hoverHighlight}
                    onChange={(v) =>
                      onPatch({
                        interactions: {
                          ...layer.interactions,
                          hoverHighlight: v,
                        },
                      })
                    }
                  />
                  <Toggle
                    Icon={MousePointerClick}
                    label="Selectable"
                    checked={layer.interactions.selectable !== false}
                    onChange={(v) =>
                      onPatch({
                        interactions: {
                          ...layer.interactions,
                          selectable: v,
                        },
                      })
                    }
                  />
                  {/* Per-map editability override for the field PWA.
                      The underlying data_layer's `editingEnabled`
                      flag still governs whether the layer is
                      editable at all; this toggle narrows further
                      so a single map can include a layer for
                      reference without offering it in the field
                      Add picker. Only shown for data-layer
                      sources where field editing is possible. */}
                  {layer.source.kind === 'data-layer' ? (
                    <Toggle
                      Icon={Pencil}
                      label="Editable in field deployments"
                      checked={layer.interactions.editingEnabled !== false}
                      onChange={(v) =>
                        onPatch({
                          interactions: {
                            ...layer.interactions,
                            editingEnabled: v,
                          },
                        })
                      }
                    />
                  ) : null}
                </div>
                <SearchConfig
                  value={layer.search}
                  metadata={metadata}
                  onChange={(search) => onPatch({ search })}
                />
                <p className="mt-2 text-2xs text-muted">
                  Feature editing unlocks when the layer&apos;s source
                  supports writes.
                </p>
                </div>
              </LayerTabPanel>
            </>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

/**
 * #114: Scaled-symbology editor.  Lives below the base StyleEditor.
 * Each class carries its own MapLayerStyle + a zoom range; the
 * runtime composes a step expression so the right look paints at
 * the right zoom without forking the layer.
 *
 * Editor model is intentionally compact: list of classes, each
 * with label / min / max / colors (fill, stroke, line, point).
 * Authors who need more (icon swaps, widths, opacities) fall back
 * to the base style; expanding the per-class editor surface is a
 * future slice.
 */
function ScaledSymbologyEditor({
  layer,
  onPatch,
  currentZoom,
  geometryTypes,
}: {
  layer: MapLayer;
  onPatch: (patch: Partial<MapLayer>) => void;
  currentZoom: number;
  geometryTypes?: Set<GeometryFamily>;
}) {
  const classes = layer.scaledSymbology ?? [];
  function update(next: typeof classes): void {
    onPatch({
      scaledSymbology: next.length > 0 ? next : ([] as typeof classes),
    });
  }
  function addClass(): void {
    update([
      ...classes,
      {
        // Default new class to "above this zoom".  Author refines.
        minZoom: 14,
        style: structuredClone(layer.style),
        renderer: layer.renderer,
        label: `Class ${classes.length + 1}`,
      },
    ]);
  }
  function patchClass(
    idx: number,
    patch: Partial<NonNullable<typeof classes>[number]>,
  ): void {
    const next = classes.map((c, i) =>
      i === idx ? ({ ...c, ...patch } as typeof c) : c,
    );
    update(next);
  }
  function removeClass(idx: number): void {
    update(classes.filter((_, i) => i !== idx));
  }
  const hasPolygon = !geometryTypes || geometryTypes.has('polygon');
  const hasLine = !geometryTypes || geometryTypes.has('line');
  const hasPoint = !geometryTypes || geometryTypes.has('point');
  return (
    <div className="space-y-2 text-xs">
      <div className="flex items-center justify-between">
        <h3 className="text-2xs font-medium uppercase tracking-wide text-muted">
          Scale classes
          {classes.length > 0 ? (
            <span className="ml-1 normal-case text-muted">
              ({classes.length})
            </span>
          ) : null}
        </h3>
        <button
          type="button"
          onClick={addClass}
          data-help="scaled-symbology-add-button"
          className="inline-flex h-6 items-center gap-1 rounded border border-border bg-surface-1 px-2 text-2xs font-medium text-ink-1 hover:bg-surface-2"
        >
          + Add class
        </button>
      </div>
      {classes.length === 0 ? (
        <p className="text-2xs text-muted">
          Optional.  Add classes when you want this layer to look
          different at different zoom levels (e.g. semi-transparent
          fill at country scale, outline-only at parcel scale)
          without forking the layer.
        </p>
      ) : (
        <ul className="space-y-3">
          {classes.map((c, i) => {
            const label = c.label ?? `Class ${i + 1}`;
            return (
              <li
                key={i}
                className="space-y-2 rounded-md border border-border bg-surface-1 p-2"
              >
                <div className="flex items-start gap-1">
                  <input
                    type="text"
                    value={label}
                    onChange={(e) => patchClass(i, { label: e.target.value })}
                    className="flex-1 rounded border border-border bg-surface-0 px-1.5 py-0.5 text-2xs focus:border-accent focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => removeClass(i)}
                    title="Remove class"
                    className="inline-flex h-6 w-6 items-center justify-center rounded text-muted hover:bg-surface-2"
                  >
                    ×
                  </button>
                </div>
                {/* Zoom range uses the same dual-handle slider as
                    "Layer visible" / "Labels visible" above so the
                    author works with one consistent control across
                    every zoom-bounded surface. */}
                <ZoomRange
                  label="Visible at"
                  minZoom={c.minZoom ?? null}
                  maxZoom={c.maxZoom ?? null}
                  currentZoom={currentZoom}
                  onMin={(z) => {
                    const next = { ...c };
                    if (z === null) delete next.minZoom;
                    else next.minZoom = z;
                    update(classes.map((x, j) => (j === i ? next : x)));
                  }}
                  onMax={(z) => {
                    const next = { ...c };
                    if (z === null) delete next.maxZoom;
                    else next.maxZoom = z;
                    update(classes.map((x, j) => (j === i ? next : x)));
                  }}
                />
                {/* Per-class symbology uses the SAME Color / Slider
                    controls as the main StyleEditor above so fill /
                    stroke / opacity / width pickers look identical
                    inside and outside a scale class. */}
                {hasPolygon ? (
                  <div className="grid grid-cols-2 gap-2">
                    <Color
                      label="Fill"
                      value={c.style.polygon.fillColor}
                      onChange={(v) =>
                        patchClass(i, {
                          style: {
                            ...c.style,
                            polygon: { ...c.style.polygon, fillColor: v },
                          },
                        })
                      }
                    />
                    <Slider
                      label="Fill opacity"
                      min={0}
                      max={1}
                      step={0.05}
                      value={c.style.polygon.fillOpacity}
                      onChange={(n) =>
                        patchClass(i, {
                          style: {
                            ...c.style,
                            polygon: { ...c.style.polygon, fillOpacity: n },
                          },
                        })
                      }
                    />
                    <Color
                      label="Outline"
                      value={c.style.polygon.strokeColor}
                      onChange={(v) =>
                        patchClass(i, {
                          style: {
                            ...c.style,
                            polygon: { ...c.style.polygon, strokeColor: v },
                          },
                        })
                      }
                    />
                    <Slider
                      label="Outline width"
                      min={0}
                      max={8}
                      step={0.5}
                      value={c.style.polygon.strokeWidth}
                      onChange={(n) =>
                        patchClass(i, {
                          style: {
                            ...c.style,
                            polygon: { ...c.style.polygon, strokeWidth: n },
                          },
                        })
                      }
                    />
                  </div>
                ) : null}
                {hasLine ? (
                  <div className="grid grid-cols-2 gap-2">
                    <Color
                      label="Color"
                      value={c.style.line.color}
                      onChange={(v) =>
                        patchClass(i, {
                          style: {
                            ...c.style,
                            line: { ...c.style.line, color: v },
                          },
                        })
                      }
                    />
                    <Slider
                      label="Width"
                      min={0.5}
                      max={12}
                      step={0.5}
                      value={c.style.line.width}
                      onChange={(n) =>
                        patchClass(i, {
                          style: {
                            ...c.style,
                            line: { ...c.style.line, width: n },
                          },
                        })
                      }
                    />
                  </div>
                ) : null}
                {hasPoint ? (
                  <div className="grid grid-cols-2 gap-2">
                    <Color
                      label="Fill"
                      value={c.style.point.color}
                      onChange={(v) =>
                        patchClass(i, {
                          style: {
                            ...c.style,
                            point: { ...c.style.point, color: v },
                          },
                        })
                      }
                    />
                    <Slider
                      label="Radius"
                      min={2}
                      max={24}
                      step={1}
                      value={c.style.point.radius}
                      onChange={(n) =>
                        patchClass(i, {
                          style: {
                            ...c.style,
                            point: { ...c.style.point, radius: n },
                          },
                        })
                      }
                    />
                    <Color
                      label="Outline"
                      value={c.style.point.strokeColor}
                      onChange={(v) =>
                        patchClass(i, {
                          style: {
                            ...c.style,
                            point: { ...c.style.point, strokeColor: v },
                          },
                        })
                      }
                    />
                    <Slider
                      label="Outline width"
                      min={0}
                      max={6}
                      step={0.5}
                      value={c.style.point.strokeWidth}
                      onChange={(n) =>
                        patchClass(i, {
                          style: {
                            ...c.style,
                            point: { ...c.style.point, strokeWidth: n },
                          },
                        })
                      }
                    />
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}


/**
 * Single item inside the per-layer kebab menu (#72). Thin wrapper
 * over a button so each menu row stays consistent on icon spacing,
 * hover state, and the destructive (red) variant for "Remove".
 */
function MenuItem({
  Icon,
  label,
  onClick,
  destructive,
  disabled,
}: {
  Icon: typeof Pencil;
  label: string;
  onClick: () => void;
  destructive?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      disabled={disabled}
      className={`flex w-full items-center gap-2 px-3 py-2 text-left first:rounded-t-md last:rounded-b-md hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-50 ${
        destructive
          ? 'text-danger hover:bg-danger/5 hover:text-danger'
          : 'text-ink-1'
      }`}
    >
      <Icon
        className={`h-3.5 w-3.5 shrink-0 ${
          destructive ? 'text-danger' : 'text-muted'
        }`}
      />
      <span className="flex-1 truncate">{label}</span>
    </button>
  );
}

/**
 * Per-layer search config. A layer is searchable once the owner ticks
 * the box and adds one or more fields; the map-level search bar then
 * walks this layer's cached feature collection for substring matches
 * against those fields.
 */
function SearchConfig({
  value,
  metadata,
  onChange,
}: {
  value: MapLayerSearch;
  metadata: LayerMetadata;
  onChange: (next: MapLayerSearch) => void;
}) {
  const fields = metadata.fields;
  function patch(p: Partial<MapLayerSearch>) {
    onChange({ ...value, ...p });
  }
  function addField(name: string) {
    if (!name || value.fields.includes(name)) return;
    patch({ fields: [...value.fields, name] });
  }
  function removeField(name: string) {
    patch({ fields: value.fields.filter((f) => f !== name) });
  }
  const unpicked = fields.filter((f) => !value.fields.includes(f));

  // Result-label preview uses the same synthesized sample row the
  // popup editor does so the author sees what the search-results
  // dropdown will show at runtime.  Falling back to a <field>
  // placeholder per column when no real feature is loaded yet
  // keeps the preview readable while typing.
  const sample = metadata.sampleProperties ?? (() => {
    const out: Record<string, unknown> = {};
    for (const f of fields) {
      out[f] = metadata.valuesByField[f]?.[0] ?? `<${f}>`;
    }
    return out;
  })();

  return (
    <div className="mt-3 border-t border-border pt-3">
      <label className="mb-2 flex cursor-pointer items-center gap-2 text-xs">
        <input
          type="checkbox"
          checked={value.enabled}
          onChange={(e) => patch({ enabled: e.target.checked })}
          className="h-3.5 w-3.5 rounded border-border text-accent focus:ring-accent/30"
        />
        <Search className="h-3.5 w-3.5 text-muted" />
        <span className="text-ink-1">Searchable</span>
      </label>
      {value.enabled ? (
        <div className="space-y-2 rounded-md border border-border bg-surface-1 p-2">
          <div>
            <div className="mb-1 text-2xs uppercase tracking-wide text-muted">
              Fields to search
            </div>
            {value.fields.length === 0 ? (
              <p className="text-2xs text-muted">
                Pick at least one field so the search bar knows what to
                match.
              </p>
            ) : (
              <ul className="flex flex-wrap gap-1">
                {value.fields.map((f) => (
                  <li
                    key={f}
                    className="inline-flex items-center gap-1 rounded-full border border-border bg-surface-2 px-2 py-0.5 text-2xs"
                  >
                    <span className="font-medium">{f}</span>
                    <button
                      type="button"
                      onClick={() => removeField(f)}
                      aria-label={`Remove ${f}`}
                      className="inline-flex h-4 w-4 items-center justify-center rounded-full text-muted hover:text-danger"
                    >
                      <X className="h-2.5 w-2.5" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {fields.length > 0 ? (
              <select
                value=""
                onChange={(e) => {
                  addField(e.target.value);
                  e.target.value = '';
                }}
                disabled={unpicked.length === 0}
                className="mt-2 h-7 w-full rounded border border-border bg-surface-1 px-2 text-2xs focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30 disabled:opacity-50"
              >
                <option value="">
                  {unpicked.length === 0 ? 'All fields added' : 'Add a field...'}
                </option>
                {unpicked.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
            ) : (
              <input
                type="text"
                placeholder="field name"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    addField((e.target as HTMLInputElement).value.trim());
                    (e.target as HTMLInputElement).value = '';
                  }
                }}
                className="mt-2 h-7 w-full rounded border border-border bg-surface-1 px-2 text-2xs focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
              />
            )}
          </div>
          <div>
            <div className="mb-1 text-2xs uppercase tracking-wide text-muted">
              Result label (optional)
            </div>
            <TemplateInput
              value={value.labelTemplate}
              onChange={(next) => patch({ labelTemplate: next })}
              fields={fields}
              sampleProperties={sample}
              placeholder={`{{apn}}: {{situs}}`}
            />
            <p className="mt-1 text-2xs text-muted">
              Same{' '}
              <code className="rounded bg-surface-2 px-1">{`{{field}}`}</code>{' '}
              grammar as popups. Empty falls back to the first matching
              field&apos;s value.
            </p>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Toggle({
  Icon,
  label,
  checked,
  onChange,
}: {
  Icon: typeof Eye;
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-xs">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-3.5 w-3.5 rounded border-border text-accent focus:ring-accent/30"
      />
      <Icon className="h-3.5 w-3.5 text-muted" />
      <span className="text-ink-1">{label}</span>
    </label>
  );
}

/**
 * Scale controls: per-layer zoom-range visibility for features and
 * labels, plus an opt-out for the default icon/circle auto-scaling.
 * Ranges are inclusive and expressed in MapLibre zoom units (0 = world,
 * 22 = street). The slider reads cartographically from large scale on
 * the left (zoomed-in / building) to small scale on the right (zoomed-
 * out / world), mirroring how scale ranges are typically written
 * ("1:500 – 1:500,000"). A small tick tracks the current camera zoom
 * so authors can see whether their bounds bracket the live view.
 */
function ScaleEditor({
  value,
  currentZoom,
  onChange,
}: {
  value: MapLayerScale;
  currentZoom: number;
  onChange: (next: MapLayerScale) => void;
}) {
  function patch(p: Partial<MapLayerScale>) {
    onChange({ ...value, ...p });
  }

  return (
    <div className="space-y-3 text-sm">
      <ZoomRange
        label="Layer visible"
        minZoom={value.minZoom}
        maxZoom={value.maxZoom}
        currentZoom={currentZoom}
        onMin={(z) => patch({ minZoom: z })}
        onMax={(z) => patch({ maxZoom: z })}
      />
      <ZoomRange
        label="Labels visible"
        minZoom={value.labelsMinZoom}
        maxZoom={value.labelsMaxZoom}
        currentZoom={currentZoom}
        onMin={(z) => patch({ labelsMinZoom: z })}
        onMax={(z) => patch({ labelsMaxZoom: z })}
      />
      <label className="flex cursor-pointer items-center gap-2 text-xs">
        <input
          type="checkbox"
          checked={value.scaleWithZoom !== false}
          onChange={(e) => patch({ scaleWithZoom: e.target.checked })}
          className="h-3.5 w-3.5 rounded border-border text-accent focus:ring-accent/30"
        />
        <span className="text-ink-1">Scale icons &amp; points with zoom</span>
      </label>
      <p className="text-2xs text-muted">
        Off keeps the exact size you set; on shrinks markers at low zooms
        so the map isn&apos;t overwhelmed and nudges them up at close
        range.
      </p>
    </div>
  );
}

function ZoomRange({
  label,
  minZoom,
  maxZoom,
  currentZoom,
  onMin,
  onMax,
}: {
  label: string;
  minZoom: number | null;
  maxZoom: number | null;
  currentZoom: number;
  onMin: (z: number | null) => void;
  onMax: (z: number | null) => void;
}) {
  // Clamp nullable bounds to the slider range for positioning. Storing
  // null when a thumb rests on the extreme keeps the persisted map's
  // intent clear: "no minimum" vs. "minimum happens to be zero".
  const minV = minZoom ?? ZOOM_MIN;
  const maxV = maxZoom ?? ZOOM_MAX;
  const span = ZOOM_MAX - ZOOM_MIN;
  // The slider reads right-to-left in zoom terms (left = zoomed-in =
  // large scale, right = zoomed-out = small scale). We reverse the
  // position math so a higher zoom value sits further to the left.
  const posOf = (z: number) => ((ZOOM_MAX - z) / span) * 100;
  const pctCurrent = Math.max(0, Math.min(100, posOf(currentZoom)));
  const leftEdge = posOf(maxV); // zoomed-in thumb: on the left
  const rightEdge = posOf(minV); // zoomed-out thumb: on the right
  // Mirror MapLibre exactly: minzoom is inclusive, maxzoom is
  // exclusive (the layer is hidden *at* maxzoom and above). Using the
  // same comparison the renderer uses keeps the tick's color honest
  // even near the thumbs, where raw position alone can mislead.
  const inRange =
    (minZoom == null || currentZoom >= minZoom) &&
    (maxZoom == null || currentZoom < maxZoom);

  return (
    <div className="rounded-md border border-border bg-surface-1 p-2">
      <div className="mb-2 flex items-center justify-between text-2xs uppercase tracking-wide text-muted">
        <span>{label}</span>
        <span className="tabular-nums normal-case tracking-normal text-muted">
          {maxZoom == null ? 'any' : `z${maxZoom}`}
          {'  –  '}
          {minZoom == null ? 'any' : `z${minZoom}`}
        </span>
      </div>
      <div className="gg-dual-range">
        <div className="gg-dual-range__track" />
        <div
          className="gg-dual-range__fill"
          style={{ left: `${leftEdge}%`, right: `${100 - rightEdge}%` }}
        />
        {/* Current camera-zoom indicator. Sits above the track so both
            thumbs still overlap it. Colored by real in-range status so
            a tick nudged just past a thumb doesn't fool the eye into
            thinking the layer is drawn when it isn't. */}
        <div
          className={
            'gg-dual-range__now ' +
            (inRange
              ? 'gg-dual-range__now--in'
              : 'gg-dual-range__now--out')
          }
          style={{ left: `${pctCurrent}%` }}
          aria-hidden="true"
          title={
            `Current zoom: z${currentZoom.toFixed(1)} (${zoomToScaleLabel(currentZoom)})` +
            `: ${inRange ? 'in range' : 'outside range'}`
          }
        />
        {/* Left thumb controls the zoomed-in (max) side. RTL on the
            input flips its native direction so dragging right lowers
            the max zoom. We also clamp against the other bound. */}
        <input
          type="range"
          dir="rtl"
          min={ZOOM_MIN}
          max={ZOOM_MAX}
          step={1}
          value={maxV}
          onChange={(e) => {
            let n = Number(e.target.value);
            if (n < minV) n = minV;
            onMax(n === ZOOM_MAX ? null : n);
          }}
          aria-label={`${label} maximum zoom (zoomed-in limit)`}
          className="gg-dual-range__input"
        />
        {/* Right thumb controls the zoomed-out (min) side. Same RTL
            trick so its drag direction matches the reversed axis. */}
        <input
          type="range"
          dir="rtl"
          min={ZOOM_MIN}
          max={ZOOM_MAX}
          step={1}
          value={minV}
          onChange={(e) => {
            let n = Number(e.target.value);
            if (n > maxV) n = maxV;
            onMin(n === ZOOM_MIN ? null : n);
          }}
          aria-label={`${label} minimum zoom (zoomed-out limit)`}
          className="gg-dual-range__input"
        />
      </div>
      <div className="mt-1 flex items-center justify-between text-2xs text-muted">
        {/* Left label describes the zoomed-in end: large scale.
            Right label the zoomed-out end: small scale. */}
        <span className="tabular-nums">
          {maxZoom == null ? 'building' : zoomToScaleLabel(maxZoom)}
        </span>
        <span className="tabular-nums">
          {minZoom == null ? 'world' : zoomToScaleLabel(minZoom)}
        </span>
      </div>
    </div>
  );
}

/**
 * Rough zoom → scale denominator conversion. Web Mercator ~1:500M at
 * zoom 0, halving per zoom level. Just a hint so users familiar with
 * scale-denominator thinking can orient: not a precise projection.
 */
function zoomToScaleLabel(zoom: number): string {
  const base = 500_000_000;
  const denom = base / Math.pow(2, zoom);
  if (denom >= 1_000_000) return `1:${Math.round(denom / 1_000_000)}M`;
  if (denom >= 1_000) return `1:${Math.round(denom / 1_000)}k`;
  return `1:${Math.round(denom)}`;
}

// ---------------------------------------------------------------------------
// GroupHeaderRow: tiny row used for group-layer headers in the panel (#46).
// Plain title + visibility toggle + opacity slider + remove. Cascades
// through the layer-panel's group helpers so toggling the header
// flips every child's visible/opacity, and remove drops the header
// + every child in one shot.
// ---------------------------------------------------------------------------

interface GroupHeaderRowProps {
  layer: MapLayer;
  /** Index in the layers array. Sets the drag-payload value so the
   *  parent panel can move the group + descendants on drop. */
  index: number;
  childCount: number;
  canEdit: boolean;
  /** Current camera zoom; mirrored from LayerRow so the group's
   *  scale slider can render the same "you are here" tick. (#69) */
  currentZoom: number;
  /** True when the user is mid-drag on this group header. The row
   *  goes opacity-50 to telegraph the dragged state, matching the
   *  visual treatment LayerRow uses. */
  dragging: boolean;
  /** Set on dragstart so the parent's dragFrom state tracks which
   *  row is being moved. Pairs with the existing onDrop on sibling
   *  rows + onDropOnHeader on group headers. */
  onDragStart: () => void;
  /** Clear the parent's dragFrom / dragOver state. */
  onDragEnd: () => void;
  onToggle: () => void;
  onOpacity: (n: number) => void;
  onRemove: () => void;
  onRename: (title: string) => void;
  /** Generic patch the way LayerRow has it. Used today for the scale
   *  field; future per-group settings ride on the same channel
   *  without the parent component growing more callbacks. (#69) */
  onPatch: (patch: Partial<MapLayer>) => void;
  /** Ungroup (#48): drop the header, keep children as top-level. */
  onUngroup: () => void;
  /** Drop a dragged layer onto the header to park it as the first
   *  child of this group (#48). Receives the source row index;
   *  payload is the same DRAG_MIME the row drag uses. */
  onDropOnHeader: (sourceIdx: number) => void;
}

function GroupHeaderRow({
  layer,
  index,
  childCount,
  canEdit,
  currentZoom,
  dragging,
  onDragStart,
  onDragEnd,
  onToggle,
  onOpacity,
  onRemove,
  onRename,
  onPatch,
  onUngroup,
  onDropOnHeader,
}: GroupHeaderRowProps) {
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(layer.title);
  const [dragOverHeader, setDragOverHeader] = useState(false);
  // Group rows are collapsed by default to keep the panel scannable.
  // Click the chevron to expand the inline scale-range editor (#69).
  const [scaleOpen, setScaleOpen] = useState(false);
  return (
    <li
      className={`border-b border-border bg-warn/5 px-2 py-1.5 transition-colors ${
        dragOverHeader ? 'ring-1 ring-warn ring-inset' : ''
      } ${dragging ? 'opacity-50' : ''}`}
      onDragOver={
        canEdit
          ? (e) => {
              const types = Array.from(e.dataTransfer.types);
              if (!types.includes(DRAG_MIME)) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = 'move';
              if (!dragOverHeader) setDragOverHeader(true);
            }
          : undefined
      }
      onDragLeave={canEdit ? () => setDragOverHeader(false) : undefined}
      onDrop={
        canEdit
          ? (e) => {
              const raw = e.dataTransfer.getData(DRAG_MIME);
              if (!raw) return;
              const sourceIdx = Number(raw);
              if (Number.isNaN(sourceIdx)) return;
              e.preventDefault();
              setDragOverHeader(false);
              onDropOnHeader(sourceIdx);
            }
          : undefined
      }
    >
      <div className="flex items-center gap-2">
        {/* Drag-source handle. Mirrors LayerRow's pattern: a tiny
            GripVertical span with draggable, onDragStart that sets
            DRAG_MIME with this group's index. The same drop targets
            (other rows + other group headers) handle a group as
            source -- moveAndRegroup splices the header alone, and
            the children's groupId keeps them rendered under the
            header in its new position. */}
        {canEdit ? (
          <span
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData(DRAG_MIME, String(index));
              e.dataTransfer.effectAllowed = 'move';
              onDragStart();
            }}
            onDragEnd={onDragEnd}
            aria-label="Drag group to reorder"
            className="inline-flex h-6 w-5 shrink-0 cursor-grab items-center justify-center text-warn hover:text-warn active:cursor-grabbing"
            title="Drag group to reorder"
          >
            <GripVertical className="h-3.5 w-3.5" />
          </span>
        ) : (
          <span className="inline-block h-6 w-5 shrink-0" />
        )}
        <button
          type="button"
          onClick={onToggle}
          aria-label={layer.visible ? 'Hide group' : 'Show group'}
          className="inline-flex h-6 w-6 items-center justify-center rounded text-muted hover:bg-surface-2 hover:text-ink-1"
          title="Toggles every layer in this group"
        >
          {layer.visible ? (
            <Eye className="h-3.5 w-3.5" />
          ) : (
            <EyeOff className="h-3.5 w-3.5" />
          )}
        </button>
        {editingTitle && canEdit ? (
          <input
            autoFocus
            type="text"
            value={titleDraft}
            onChange={(e) => setTitleDraft(e.target.value)}
            onBlur={() => {
              const t = titleDraft.trim();
              if (t && t !== layer.title) onRename(t);
              setEditingTitle(false);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              if (e.key === 'Escape') {
                setTitleDraft(layer.title);
                setEditingTitle(false);
              }
            }}
            className="h-6 flex-1 rounded border border-border bg-surface-1 px-1.5 text-xs"
          />
        ) : (
          <button
            type="button"
            onClick={() => canEdit && setEditingTitle(true)}
            className="flex flex-1 items-center gap-1.5 truncate text-left text-xs font-semibold uppercase tracking-wide text-warn hover:text-warn"
            title={canEdit ? 'Click to rename' : layer.title}
          >
            <Folder className="h-3.5 w-3.5 shrink-0 text-warn" />
            <span className="truncate">{layer.title}</span>
            <span className="ml-1 shrink-0 rounded-full bg-warn/20 px-1.5 text-2xs font-medium text-warn">
              {childCount}
            </span>
          </button>
        )}
        {canEdit ? (
          <>
            <button
              type="button"
              onClick={onUngroup}
              aria-label="Ungroup"
              title="Drop the group header but keep the layers inside"
              className="inline-flex h-6 w-6 items-center justify-center rounded text-muted hover:bg-surface-2 hover:text-ink-1"
            >
              <FolderMinus className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={onRemove}
              aria-label="Remove group and its layers"
              title="Remove this group and every layer inside"
              className="inline-flex h-6 w-6 items-center justify-center rounded text-muted hover:bg-danger/5 hover:text-danger"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </>
        ) : null}
      </div>
      {canEdit ? (
        <div className="mt-1 flex items-center gap-2 px-1">
          <span className="text-2xs uppercase tracking-wide text-muted">
            Opacity
          </span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={layer.opacity}
            onChange={(e) => onOpacity(Number(e.target.value))}
            className="h-1 flex-1"
          />
          <span className="text-2xs tabular-nums text-muted">
            {Math.round(layer.opacity * 100)}%
          </span>
        </div>
      ) : null}
      {/* Group-level scale range (#69). Same editor as a leaf, but
          parented to the group header. The canvas intersects this
          range with each child layer's own range at render time, so
          a group acts as a soft floor and ceiling for everything
          inside. Collapsed by default to keep the row tidy. */}
      {canEdit ? (
        <div className="mt-1">
          <button
            type="button"
            onClick={() => setScaleOpen((v) => !v)}
            aria-expanded={scaleOpen}
            className="flex w-full items-center gap-1.5 rounded px-1 py-1 text-2xs font-medium uppercase tracking-wide text-muted hover:bg-warn/15 hover:text-warn"
          >
            {scaleOpen ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )}
            <Telescope className="h-3 w-3" />
            Scale
          </button>
          {scaleOpen ? (
            <div className="rounded border border-warn/25 bg-surface-1/70 px-2 py-2">
              <ScaleEditor
                value={layer.scale ?? DEFAULT_LAYER_SCALE}
                currentZoom={currentZoom}
                onChange={(scale) => onPatch({ scale })}
              />
              <p className="mt-2 text-2xs text-muted">
                Applies to every layer in this group. A child layer
                with a tighter range stays tighter; a wider one is
                clipped to this group&apos;s range.
              </p>
            </div>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}