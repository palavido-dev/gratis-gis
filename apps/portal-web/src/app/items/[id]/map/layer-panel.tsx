'use client';

import { useEffect, useRef, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  Filter,
  Focus,
  Folder,
  FolderMinus,
  FolderPlus,
  GripVertical,
  MoreVertical,
  MousePointerClick,
  Palette,
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
} from '@gratis-gis/shared-types';
import {
  DEFAULT_LAYER_SCALE,
  MAX_GROUP_DEPTH,
  ZOOM_MAX,
  ZOOM_MIN,
  groupDepth,
} from '@gratis-gis/shared-types';
import { StyleEditor } from './style-editor';
import { RendererEditor } from './renderer-editor';
import { FilterEditor } from './filter-editor';
import { PopupEditor } from './popup-editor';
import { LabelsEditor } from './labels-editor';
import { makeEmptyGroupLayer, uniqueGroupTitle } from './group-factory';
import type { LayerMetadata } from './layer-metadata';

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
  /** Open the attribute table panel (#72). Per-layer "Open
   *  attribute table" in the kebab menu calls this; the table
   *  lists every layer with feature data, focusing the first by
   *  default. */
  onOpenAttributeTable: () => void;
  /** Fly the camera to a layer's feature extent (#72). The
   *  bounding box is computed in the LayerPanel from cached
   *  metadata, then handed to MapCanvas via this callback. */
  onZoomToLayer: (layerId: string) => void;
  onChange: (next: MapLayer[]) => void;
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
  onChange,
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
  function moveLayer(from: number, to: number) {
    if (from === to || from < 0 || to < 0) return;
    const next = [...layers];
    const [moved] = next.splice(from, 1);
    if (!moved) return;
    next.splice(to, 0, moved);
    onChange(next);
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
        {canEdit ? (
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
                        depth > 0 ? 'border-l-2 border-amber-200/70' : ''
                      }
                    >
                      <GroupHeaderRow
                        layer={layer}
                        childCount={kids.length}
                        canEdit={canEdit}
                        currentZoom={currentZoom}
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
                      depth > 0 ? 'border-l-2 border-amber-200/70' : ''
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
                      onOpenAttributeTable={onOpenAttributeTable}
                      onZoomToExtent={() => onZoomToLayer(layer.id)}
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
  /** Open the attribute table panel (#72). */
  onOpenAttributeTable: () => void;
  /** Fly the camera to this layer's feature extent (#72). */
  onZoomToExtent: () => void;
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

type SectionKey =
  | 'symbology'
  | 'labels'
  | 'filters'
  | 'popups'
  | 'interactions'
  | 'scale';

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
  groupOptions,
  onMoveToGroup,
  onMoveToNewGroup,
}: RowProps) {
  const [expanded, setExpanded] = useState(false);
  const [openSections, setOpenSections] = useState<Record<SectionKey, boolean>>({
    symbology: true,
    labels: false,
    filters: false,
    popups: false,
    interactions: false,
    scale: false,
  });
  function toggle(k: SectionKey) {
    setOpenSections((s) => ({ ...s, [k]: !s[k] }));
  }
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
        <button
          type="button"
          onClick={canEdit ? onToggle : undefined}
          disabled={!canEdit}
          aria-label={layer.visible ? 'Hide layer' : 'Show layer'}
          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted hover:bg-surface-2 disabled:opacity-50"
        >
          {layer.visible ? (
            <Eye className="h-3.5 w-3.5" />
          ) : (
            <EyeOff className="h-3.5 w-3.5 text-muted" />
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

        {canEdit ? (
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
                <MenuItem
                  Icon={Pencil}
                  label="Rename"
                  onClick={() => {
                    setMenuOpen(false);
                    setTitleDraft(layer.title);
                    setEditingTitle(true);
                  }}
                />
                <MenuItem
                  Icon={TableIcon}
                  label="Open attribute table"
                  onClick={() => {
                    setMenuOpen(false);
                    onOpenAttributeTable();
                  }}
                />
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
                            <Folder className="h-3.5 w-3.5 text-amber-700" />
                            <span className="truncate">{g.title}</span>
                            {g.id === layer.groupId ? (
                              <span className="ml-auto text-[10px] uppercase tracking-wide text-muted">
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
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      {expanded ? (
        <div className="space-y-0 border-t border-border bg-surface-2">
          <div className="px-3 py-3">
            <label className="flex items-center justify-between text-[10px] uppercase tracking-wide text-muted">
              <span>Opacity</span>
              <span className="tabular-nums">{Math.round(layer.opacity * 100)}%</span>
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

          {canEdit ? (
            <>
              <Section
                Icon={Palette}
                label="Symbology"
                open={openSections.symbology}
                onToggle={() => toggle('symbology')}
              >
                <RendererEditor
                  value={layer.renderer}
                  metadata={metadata}
                  onChange={(renderer) => onPatch({ renderer })}
                />
                <div className="mt-3 border-t border-border pt-3">
                  <StyleEditor
                    value={layer.style}
                    onChange={(style) => onPatch({ style })}
                    {...(metadata.geometryTypes
                      ? { geometryTypes: metadata.geometryTypes }
                      : {})}
                  />
                </div>
              </Section>

              <Section
                Icon={Tag}
                label="Labels"
                open={openSections.labels}
                onToggle={() => toggle('labels')}
              >
                <LabelsEditor
                  value={layer.labels}
                  metadata={metadata}
                  onChange={(labels) => onPatch({ labels })}
                />
              </Section>

              <Section
                Icon={Filter}
                label="Filters"
                open={openSections.filters}
                onToggle={() => toggle('filters')}
              >
                <FilterEditor
                  value={layer.filter}
                  metadata={metadata}
                  onChange={(filter) => onPatch({ filter })}
                />
              </Section>

              <Section
                Icon={MousePointerClick}
                label="Popups"
                open={openSections.popups}
                onToggle={() => toggle('popups')}
              >
                <PopupEditor
                  value={layer.popup}
                  metadata={metadata}
                  onChange={(popup) => onPatch({ popup })}
                />
              </Section>

              <Section
                Icon={Sparkles}
                label="Interactions"
                open={openSections.interactions}
                onToggle={() => toggle('interactions')}
              >
                <div className="space-y-1.5 text-sm">
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
                </div>
                <SearchConfig
                  value={layer.search}
                  fields={metadata.fields}
                  onChange={(search) => onPatch({ search })}
                />
                <p className="mt-2 text-[11px] text-muted">
                  Feature editing unlocks when the layer&apos;s source
                  supports writes.
                </p>
              </Section>

              <Section
                Icon={Telescope}
                label="Scale"
                open={openSections.scale}
                onToggle={() => toggle('scale')}
              >
                <ScaleEditor
                  value={layer.scale ?? DEFAULT_LAYER_SCALE}
                  currentZoom={currentZoom}
                  onChange={(scale) => onPatch({ scale })}
                />
              </Section>
            </>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

function Section({
  Icon,
  label,
  open,
  onToggle,
  children,
}: {
  Icon: typeof Palette;
  label: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="border-t border-border">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 text-xs font-medium uppercase tracking-wide text-muted hover:bg-surface-1"
      >
        {open ? (
          <ChevronDown className="h-3.5 w-3.5" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5" />
        )}
        <Icon className="h-3.5 w-3.5" />
        {label}
      </button>
      {open ? <div className="px-3 pb-3">{children}</div> : null}
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
  fields,
  onChange,
}: {
  value: MapLayerSearch;
  fields: string[];
  onChange: (next: MapLayerSearch) => void;
}) {
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
            <div className="mb-1 text-[10px] uppercase tracking-wide text-muted">
              Fields to search
            </div>
            {value.fields.length === 0 ? (
              <p className="text-[11px] text-muted">
                Pick at least one field so the search bar knows what to
                match.
              </p>
            ) : (
              <ul className="flex flex-wrap gap-1">
                {value.fields.map((f) => (
                  <li
                    key={f}
                    className="inline-flex items-center gap-1 rounded-full border border-border bg-surface-2 px-2 py-0.5 text-[11px]"
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
                className="mt-2 h-7 w-full rounded border border-border bg-surface-1 px-2 text-[11px] focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30 disabled:opacity-50"
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
                className="mt-2 h-7 w-full rounded border border-border bg-surface-1 px-2 text-[11px] focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
              />
            )}
          </div>
          <div>
            <div className="mb-1 text-[10px] uppercase tracking-wide text-muted">
              Result label (optional)
            </div>
            <input
              type="text"
              value={value.labelTemplate}
              onChange={(e) => patch({ labelTemplate: e.target.value })}
              placeholder={`{{apn}}: {{situs}}`}
              className="h-7 w-full rounded border border-border bg-surface-1 px-2 font-mono text-[11px] focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
            />
            <p className="mt-1 text-[11px] text-muted">
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
      <p className="text-[11px] text-muted">
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
      <div className="mb-2 flex items-center justify-between text-[10px] uppercase tracking-wide text-muted">
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
      <div className="mt-1 flex items-center justify-between text-[11px] text-muted">
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
 * Rough zoom â†’ scale denominator conversion. Web Mercator ~1:500M at
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
  childCount: number;
  canEdit: boolean;
  /** Current camera zoom; mirrored from LayerRow so the group's
   *  scale slider can render the same "you are here" tick. (#69) */
  currentZoom: number;
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
  childCount,
  canEdit,
  currentZoom,
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
      className={`border-b border-border bg-amber-50/50 px-2 py-1.5 transition-colors ${
        dragOverHeader ? 'ring-1 ring-amber-500 ring-inset' : ''
      }`}
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
            className="flex flex-1 items-center gap-1.5 truncate text-left text-xs font-semibold uppercase tracking-wide text-amber-900 hover:text-amber-700"
            title={canEdit ? 'Click to rename' : layer.title}
          >
            <Folder className="h-3.5 w-3.5 shrink-0 text-amber-700" />
            <span className="truncate">{layer.title}</span>
            <span className="ml-1 shrink-0 rounded-full bg-amber-200/80 px-1.5 text-[10px] font-medium text-amber-900">
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
          <span className="text-[10px] uppercase tracking-wide text-muted">
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
          <span className="text-[10px] tabular-nums text-muted">
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
            className="flex w-full items-center gap-1.5 rounded px-1 py-1 text-[10px] font-medium uppercase tracking-wide text-muted hover:bg-amber-100/60 hover:text-amber-900"
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
            <div className="rounded border border-amber-200/70 bg-surface-1/70 px-2 py-2">
              <ScaleEditor
                value={layer.scale ?? DEFAULT_LAYER_SCALE}
                currentZoom={currentZoom}
                onChange={(scale) => onPatch({ scale })}
              />
              <p className="mt-2 text-[10px] text-muted">
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