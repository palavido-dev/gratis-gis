// SPDX-License-Identifier: AGPL-3.0-or-later
// Widget-tree helpers for the custom app designer.
//
// These used to live inside the designer page. They moved here so the
// reorder and reparent arithmetic can be tested without a browser:
// the designer had an off-by-one in exactly this code that nobody
// could see without dragging tools around a dock by hand.
import type {
  ContainerWidgetConfig,
  CustomLayout,
  CustomWidget,
} from '@gratis-gis/shared-types';

/** How far the pointer has to travel before a mousedown on a canvas
 *  card counts as a drag. Below this it is a click (select only). */
export const DRAG_THRESHOLD_PX = 4;

/** True once the pointer has moved far enough on either axis for the
 *  gesture to count as a drag rather than a click. */
export function pastDragThreshold(dx: number, dy: number): boolean {
  return Math.abs(dx) >= DRAG_THRESHOLD_PX || Math.abs(dy) >= DRAG_THRESHOLD_PX;
}

/** True when the container places its children freely by col/row
 *  (FlowContainer). Dock, overlay and menu containers stack their
 *  children in a list instead. */
export function isFlowContainer(cfg: ContainerWidgetConfig): boolean {
  return (
    cfg.position === undefined ||
    cfg.position === 'inline' ||
    cfg.position === 'sticky-top' ||
    cfg.position === 'sticky-bottom'
  );
}

/** Direction the container's children run on screen. Dock, overlay
 *  and menu containers always stack top to bottom whatever `layout`
 *  says; flow containers follow `layout` with the documented
 *  defaults. Read from config, not from where the children happen to
 *  sit, because with one sibling there is no spread to measure. */
export function containerFlowsInRow(cfg: ContainerWidgetConfig): boolean {
  if (!isFlowContainer(cfg)) return false;
  const sticky = cfg.position === 'sticky-top' || cfg.position === 'sticky-bottom';
  return (cfg.layout ?? (sticky ? 'row' : 'column')) === 'row';
}

/** Insertion slot for a cursor against the sibling centers (along the
 *  container's axis). The centers must not include the dragged widget,
 *  so the result is an index into the list with that widget removed. */
export function insertionIndex(centers: number[], cursor: number): number {
  for (let i = 0; i < centers.length; i++) {
    if (cursor < centers[i]!) return i;
  }
  return centers.length;
}

/**
 * Locate a widget anywhere in the tree along with its parent
 * container's id (null = page-level) and its index in the parent's
 * children array. Recurses through container.config.widgets[] and
 * tabs.tabs[].widgets[].
 */
export function findWidgetWithParent(
  widgets: CustomWidget[],
  id: string,
  parentId: string | null = null,
): { widget: CustomWidget; parentId: string | null; index: number } | null {
  for (let i = 0; i < widgets.length; i++) {
    const w = widgets[i]!;
    if (w.id === id) return { widget: w, parentId, index: i };
    const cfg = w.config;
    if ('widgets' in cfg && Array.isArray(cfg.widgets)) {
      const inner = findWidgetWithParent(cfg.widgets, id, w.id);
      if (inner) return inner;
    }
    if (cfg.kind === 'tabs' && Array.isArray(cfg.tabs)) {
      for (const t of cfg.tabs) {
        const inner = findWidgetWithParent(t.widgets, id, w.id);
        if (inner) return inner;
      }
    }
  }
  return null;
}

/** Remove a widget by id anywhere in the tree. */
export function removeWidgetDeep(
  widgets: CustomWidget[],
  targetId: string,
): CustomWidget[] {
  const filtered = widgets.filter((w) => w.id !== targetId);
  if (filtered.length !== widgets.length) return filtered;
  return widgets.map((w) => {
    const cfg = w.config;
    if ('widgets' in cfg && Array.isArray(cfg.widgets)) {
      const nextChildren = removeWidgetDeep(cfg.widgets, targetId);
      if (nextChildren !== cfg.widgets) {
        return {
          ...w,
          config: { ...cfg, widgets: nextChildren },
        } as CustomWidget;
      }
    }
    if (cfg.kind === 'tabs' && Array.isArray(cfg.tabs)) {
      let touched = false;
      const nextTabs = cfg.tabs.map((t) => {
        const nextTabWidgets = removeWidgetDeep(t.widgets, targetId);
        if (nextTabWidgets !== t.widgets) {
          touched = true;
          return { ...t, widgets: nextTabWidgets };
        }
        return t;
      });
      if (touched) {
        return { ...w, config: { ...cfg, tabs: nextTabs } } as CustomWidget;
      }
    }
    return w;
  });
}

/**
 * Insert a child widget at a specific index inside a container.
 * `containerId === null` inserts at the page level. index clamped
 * to [0, parent.length]. Returns a fresh widgets array.
 */
export function insertWidgetAt(
  widgets: CustomWidget[],
  containerId: string | null,
  index: number,
  child: CustomWidget,
): CustomWidget[] {
  if (containerId === null) {
    const i = Math.max(0, Math.min(index, widgets.length));
    return [...widgets.slice(0, i), child, ...widgets.slice(i)];
  }
  return widgets.map((w) => {
    if (w.id === containerId) {
      const cfg = w.config;
      if ('widgets' in cfg && Array.isArray(cfg.widgets)) {
        const i = Math.max(0, Math.min(index, cfg.widgets.length));
        const nextChildren = [
          ...cfg.widgets.slice(0, i),
          child,
          ...cfg.widgets.slice(i),
        ];
        return { ...w, config: { ...cfg, widgets: nextChildren } } as CustomWidget;
      }
      return w;
    }
    const cfg = w.config;
    if ('widgets' in cfg && Array.isArray(cfg.widgets)) {
      const nextChildren = insertWidgetAt(cfg.widgets, containerId, index, child);
      if (nextChildren !== cfg.widgets) {
        return { ...w, config: { ...cfg, widgets: nextChildren } } as CustomWidget;
      }
    }
    return w;
  });
}

/**
 * Move a widget from wherever it lives in the tree to a new parent +
 * index. Performs the remove + insert in one pass so the page-level
 * widgets array updates atomically.
 *
 * `targetIndex` is an index into the target's children AFTER the
 * moving widget has been taken out. That is what the designer's hit
 * test computes (it skips the dragged widget when it measures the
 * siblings), so no further shift is applied here. Shifting again made
 * every forward move land one slot early and the last slot
 * unreachable.
 *
 * When the source widget is rooted at page-level and moves into a
 * container without a `pageLayout`, its grid layout is reset to a
 * (1,1,1,1) placeholder because children inside containers ignore
 * grid coords. When `pageLayout` is given it replaces the layout.
 */
export function moveWidgetInTree(
  widgets: CustomWidget[],
  sourceId: string,
  targetParentId: string | null,
  targetIndex: number,
  pageLayout: CustomLayout | null,
): CustomWidget[] {
  const found = findWidgetWithParent(widgets, sourceId);
  if (!found) return widgets;
  const withoutSource = removeWidgetDeep(widgets, sourceId);
  let widgetToInsert = found.widget;
  if (pageLayout) {
    widgetToInsert = { ...widgetToInsert, layout: pageLayout };
  } else if (targetParentId !== null && found.parentId === null) {
    widgetToInsert = {
      ...widgetToInsert,
      layout: { col: 1, row: 1, colSpan: 1, rowSpan: 1 },
    };
  }
  return insertWidgetAt(withoutSource, targetParentId, targetIndex, widgetToInsert);
}

/**
 * Every widget in a list, including the children of containers and
 * of each tab, depth first. Widgets nest through `config.widgets`
 * (containers) and `config.tabs[].widgets` (tabs); there is no
 * `children` property, so a walk over one found nothing nested.
 */
export function allWidgetsDeep(widgets: CustomWidget[]): CustomWidget[] {
  const out: CustomWidget[] = [];
  const walk = (list: CustomWidget[]) => {
    for (const w of list) {
      out.push(w);
      const cfg = w.config;
      if ('widgets' in cfg && Array.isArray(cfg.widgets)) walk(cfg.widgets);
      if (cfg.kind === 'tabs' && Array.isArray(cfg.tabs)) {
        for (const t of cfg.tabs) walk(t.widgets);
      }
    }
  };
  walk(widgets);
  return out;
}

/**
 * The map widget a new data source follows by default on a
 * dashboard: the first map on the page the author is on, else the
 * first map on any page. Both ways of adding a source use this, so a
 * source added from a map pick and one added by hand land on the
 * same map.
 */
export function defaultFollowMap(
  pages: Array<{ widgets?: CustomWidget[] }>,
  activePageIdx: number,
): CustomWidget | undefined {
  const isMap = (w: CustomWidget) => w.kind === 'map';
  const active = pages[activePageIdx];
  return (
    (active ? allWidgetsDeep(active.widgets ?? []).find(isMap) : undefined) ??
    pages.flatMap((p) => allWidgetsDeep(p.widgets ?? [])).find(isMap)
  );
}
