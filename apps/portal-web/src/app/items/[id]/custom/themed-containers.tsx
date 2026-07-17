// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

/**
 * Generic container widget renderer.  ONE component handles every
 * container behavior (sticky top/bottom bar, side dock, overlay
 * drawer, inline region) by reading the container's `position`,
 * `variant`, `layout`, and `collapsible` props.  Replaces the
 * earlier AppBar / DockPanel / Slideout / FoldableGroup family
 * (#92) which baked slot-style chrome into separate widget kinds.
 *
 * The container holds an array of full CustomWidget children and
 * passes each to the caller-supplied `renderChild` function.  The
 * container's own `layout` prop controls how children flow (row vs
 * column) inside the body; everything else (background, sticky
 * anchoring, collapse affordance, trigger button) is chrome
 * provided by this component.
 *
 * Theme tokens (--app-surface-*, --app-header-*, --app-accent,
 * --app-radius, --app-shadow-card, etc.) drive the visual treatment
 * so the same container looks coherent across the theme presets.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { CSSProperties } from 'react';
import {
  ChevronDown as ChevronDownIcon,
  ChevronRight as ChevronRightIcon,
  Filter as FilterIcon,
  Layers as LayersIcon,
  Menu as MenuIcon,
  X as XIcon,
  Wrench as WrenchIcon,
} from 'lucide-react';
import type {
  ContainerWidgetConfig,
  CustomWidget,
} from '@gratis-gis/shared-types';

/**
 * The runtime + designer pass the renderer a `RenderChild` function
 * so the container doesn't have to import the full widget renderer
 * registry directly (and so the designer can swap in a design-time
 * preview for children without touching this file).
 */
export type RenderChild = (child: CustomWidget) => React.ReactNode;

/**
 * Signals to descendant widgets that they're being rendered inside
 * a container with branded-header chrome (variant='elevated' on a
 * sticky-top / sticky-bottom container).  Tool widgets check this
 * so they can swap their raised white-pill treatment for a flat,
 * header-colored treatment: the difference between a "button that
 * floats on a page" and an "icon link in a navy nav bar".  Renamed
 * from AppBarContext (#92); kept as a single boolean so existing
 * consumers don't need a new shape.
 */
export const AppBarContext = createContext<boolean>(false);

interface ContainerRenderProps {
  config: ContainerWidgetConfig;
  renderChild: RenderChild;
}

/**
 * Resolve the effective defaults for a container's chrome props.
 * Centralizes the "what does position X imply" rules so the renderer
 * branches stay tight.
 */
function resolveChrome(config: ContainerWidgetConfig) {
  const position = config.position ?? 'inline';
  const variant =
    config.variant ??
    (position === 'sticky-top' ||
    position === 'sticky-bottom' ||
    position === 'dock-left' ||
    position === 'dock-right' ||
    position === 'overlay-trigger'
      ? 'elevated'
      : 'flat');
  const layout =
    config.layout ??
    (position === 'sticky-top' || position === 'sticky-bottom'
      ? 'row'
      : 'column');
  return { position, variant, layout };
}

/**
 * Map a container's `variant` to its chrome class set.  Same
 * vocabulary across every position so an 'elevated' sticky top bar
 * and an 'elevated' overlay drawer share the same header surface
 * tokens.
 */
function variantClasses(variant: ContainerWidgetConfig['variant']): string {
  if (variant === 'glass') {
    return 'bg-[hsl(var(--app-surface-1)/0.7)] backdrop-blur supports-[backdrop-filter]:bg-[hsl(var(--app-surface-1)/0.6)] border-b border-[hsl(var(--app-border)/0.6)] text-[hsl(var(--app-ink-0))]';
  }
  if (variant === 'flat') {
    return 'bg-[hsl(var(--app-surface-1))] text-[hsl(var(--app-ink-0))]';
  }
  if (variant === 'none') {
    return 'bg-transparent text-[hsl(var(--app-ink-0))]';
  }
  // 'elevated' (default).  Branded header surface.
  return 'bg-[hsl(var(--app-header-bg))] text-[hsl(var(--app-header-ink))] border-b border-[hsl(var(--app-header-border))] shadow-[var(--app-shadow-card)]';
}

/**
 * Single Container renderer.  Dispatches on `position` to the right
 * sub-renderer.  Inline / sticky-top / sticky-bottom render as the
 * same flow container with different anchoring; dock-left /
 * dock-right render as a side panel with collapse-to-rail;
 * overlay-trigger renders a hidden drawer with a trigger button.
 */
export function Container({ config, renderChild }: ContainerRenderProps) {
  const { position, variant, layout } = resolveChrome(config);

  if (position === 'dock-left' || position === 'dock-right') {
    return (
      <DockContainer
        config={config}
        renderChild={renderChild}
        variant={variant}
        layout={layout}
        side={position === 'dock-left' ? 'left' : 'right'}
      />
    );
  }
  if (position === 'overlay-trigger') {
    return (
      <OverlayContainer
        config={config}
        renderChild={renderChild}
        variant={variant}
        layout={layout}
      />
    );
  }
  if (position === 'menu') {
    return <MenuContainer config={config} renderChild={renderChild} />;
  }
  // sticky-top / sticky-bottom / inline.  Same flow region, just
  // different anchoring + (for inline) no anchoring at all.
  return (
    <FlowContainer
      config={config}
      renderChild={renderChild}
      variant={variant}
      layout={layout}
      position={position}
    />
  );
}

// ---- Flow container (inline / sticky-top / sticky-bottom) -------

interface FlowProps extends ContainerRenderProps {
  variant: NonNullable<ContainerWidgetConfig['variant']>;
  layout: NonNullable<ContainerWidgetConfig['layout']>;
  position: 'inline' | 'sticky-top' | 'sticky-bottom';
}

function FlowContainer({
  config,
  renderChild,
  variant,
  layout,
  position,
}: FlowProps) {
  const collapsible = config.collapsible === true;
  const [collapsed, setCollapsed] = useState(
    config.defaultCollapsed === true,
  );
  const inBrandedHeader =
    variant === 'elevated' &&
    (position === 'sticky-top' || position === 'sticky-bottom');
  const chromeClass = variantClasses(variant);
  const stickyClass =
    position === 'sticky-top'
      ? 'sticky top-0 z-10'
      : position === 'sticky-bottom'
        ? 'sticky bottom-0 z-10'
        : '';
  const heightStyle: CSSProperties =
    typeof config.heightPx === 'number' ? { height: config.heightPx } : {};

  // #99: free-position children.  Row-layout containers (sticky-top
  // toolbars, etc.) put each child at layout.col along the bar:
  // col 1 = left edge, col 192 = right edge, col 96 ~= center.
  // Column-layout containers do the same with layout.row.  This
  // lets the user drag a single tool to the right (or anywhere)
  // without having to flex-pack everything.
  //
  // Backwards compat: when every child has col=1 (the historical
  // placeholder default), we auto-spread them evenly so existing
  // apps render the same way they did under the old flex-pack
  // model.  The first drag persists explicit cols and from then
  // on positions are literal.  The migration step in shared-types
  // (migrateCustomAppData) writes spread cols on load so the data
  // and visuals match without relying on this fallback long-term.
  const isRow = layout === 'row';
  const axisKey: 'col' | 'row' = isRow ? 'col' : 'row';
  const children = config.widgets;
  const allAtOrigin =
    children.length > 0 &&
    children.every((c) => (c.layout[axisKey] ?? 1) === 1);

  // #100 / followup: no-overlap policy in PIXEL space, with measured
  // body + child sizes from ResizeObserver.  Previous cut enforced a
  // percentage-based MIN_SPACING (9%), which couldn't account for
  // variable tool widths -- a tool with a long label like "Attribute
  // Table" is wider than "Print", so any single-percent value either
  // left visible gaps for narrow tools or allowed overlap for wide
  // ones.  Now we measure each child's intrinsic width and the
  // container's body width, then sweep in pixel space: each tool's
  // ideal left = (col-1)/191 * (bodyW - childW), then bumped right
  // only as much as needed to clear the previous tool's right edge.
  // MIN_GAP_PX = 1 means tools can sit one pixel apart; the user can
  // pack them visually adjacent.
  const MIN_GAP_PX = 1;
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [bodyDim, setBodyDim] = useState<{ w: number; h: number } | null>(null);
  const childRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const [childDims, setChildDims] = useState<Map<string, { w: number; h: number }>>(
    new Map(),
  );

  // Stable ref-callback that also remeasures the child synchronously
  // when its DOM node mounts.  Stored in a Map so each child gets the
  // same callback identity across renders, and so the cleanup branch
  // can drop unmounted entries.
  const refCallbacks = useRef<Map<string, (el: HTMLDivElement | null) => void>>(
    new Map(),
  );
  const getRefCallback = useCallback(
    (childId: string) => {
      let cb = refCallbacks.current.get(childId);
      if (cb) return cb;
      cb = (el: HTMLDivElement | null) => {
        if (el) {
          childRefs.current.set(childId, el);
          // Measure synchronously so the first render computes
          // positions from real widths, not stale Map entries.
          const r = el.getBoundingClientRect();
          setChildDims((cur) => {
            const prev = cur.get(childId);
            if (prev && prev.w === r.width && prev.h === r.height) return cur;
            const next = new Map(cur);
            next.set(childId, { w: r.width, h: r.height });
            return next;
          });
        } else {
          childRefs.current.delete(childId);
          setChildDims((cur) => {
            if (!cur.has(childId)) return cur;
            const next = new Map(cur);
            next.delete(childId);
            return next;
          });
        }
      };
      refCallbacks.current.set(childId, cb);
      return cb;
    },
    [],
  );

  // Body-rect tracking via ResizeObserver so dragging the canvas /
  // resizing the window updates positions live.
  useLayoutEffect(() => {
    if (!bodyRef.current) return;
    const el = bodyRef.current;
    const measure = () => {
      const r = el.getBoundingClientRect();
      setBodyDim((cur) =>
        cur && cur.w === r.width && cur.h === r.height
          ? cur
          : { w: r.width, h: r.height },
      );
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Child-rect tracking via ResizeObserver, attached to each
  // currently-known child.  Re-runs when the children list changes
  // (a tool added / removed / reordered) and when childRefs gain new
  // entries from the ref-callback above.
  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      setChildDims((cur) => {
        let next = cur;
        for (const e of entries) {
          const id = (e.target as HTMLElement).getAttribute('data-flow-child-id');
          if (!id) continue;
          const r = e.contentRect;
          const prev = cur.get(id);
          if (prev && prev.w === r.width && prev.h === r.height) continue;
          if (next === cur) next = new Map(cur);
          next.set(id, { w: r.width, h: r.height });
        }
        return next;
      });
    });
    childRefs.current.forEach((el) => ro.observe(el));
    return () => ro.disconnect();
  }, [children]);

  // Compute placement.  Sort by stored axis value, sweep in pixel
  // space.  Each tool's anchor maps the col 1..192 range into the
  // travel available for the tool (container size minus tool size),
  // so col=1 flushes left edge to start and col=192 flushes right
  // edge to end -- same anchoring guarantee the previous translateX
  // trick gave, but width-aware.  Fallback child width = 80 px until
  // we have measurements (first render frame).
  function rawCol(child: { layout: { col: number; row: number } }, idx: number): number {
    if (allAtOrigin) {
      return children.length > 1 ? (idx / (children.length - 1)) * 191 + 1 : 1;
    }
    return child.layout[axisKey] ?? 1;
  }
  const positions = useMemo(() => {
    const result = new Map<string, number>();
    if (children.length === 0) return result;
    const containerSize = bodyDim ? (isRow ? bodyDim.w : bodyDim.h) : null;
    if (containerSize == null) return result;
    const indexed = children.map((c, i) => ({ c, i, col: rawCol(c, i) }));
    indexed.sort((a, b) => a.col - b.col);
    let prevEnd = 0;
    for (const { c, col } of indexed) {
      const dim = childDims.get(c.id);
      const childSize = (isRow ? dim?.w : dim?.h) ?? 80;
      const travel = Math.max(0, containerSize - childSize);
      const idealStart = ((col - 1) / 191) * travel;
      const actualStart = Math.max(
        idealStart,
        prevEnd > 0 ? prevEnd + MIN_GAP_PX : 0,
      );
      result.set(c.id, actualStart);
      prevEnd = actualStart + childSize;
    }
    // Shift-left if the last child overflows so everyone stays inside
    // the body.  Same semantics as the percent-based sweep before.
    if (prevEnd > containerSize) {
      const shift = prevEnd - containerSize;
      result.forEach((v, k) => result.set(k, Math.max(0, v - shift)));
    }
    return result;
  }, [bodyDim, childDims, children, isRow, allAtOrigin, axisKey]);

  function childPos(child: { id: string }): CSSProperties {
    const px = positions.get(child.id);
    if (px == null) {
      // Pre-measurement: render off-screen so the user doesn't see a
      // flash of all-children-at-0,0 before the first measurement
      // pass commits a real layout.  The next render frame has real
      // px values.
      return {
        position: 'absolute',
        left: -9999,
        top: -9999,
      };
    }
    return isRow
      ? {
          position: 'absolute',
          left: `${px}px`,
          top: 0,
          bottom: 0,
        }
      : {
          position: 'absolute',
          top: `${px}px`,
          left: 0,
          right: 0,
        };
  }

  // Collapsed inline / sticky containers fold their children behind
  // a chevron handle; the chrome region stays visible so the handle
  // is reachable.  For row-layout containers (toolbars), collapse
  // doesn't make much physical sense — the handle still works but
  // the practical use is column-layout accordion sections.
  return (
    <AppBarContext.Provider value={inBrandedHeader}>
      <div
        className={`flex h-full w-full ${chromeClass} ${stickyClass}`}
        style={heightStyle}
      >
        {collapsible ? (
          <header className="flex shrink-0 items-center self-start px-2 py-1">
            <button
              type="button"
              onClick={() => setCollapsed((v) => !v)}
              aria-label={collapsed ? 'Expand container' : 'Collapse container'}
              aria-expanded={!collapsed}
              className="inline-flex h-7 w-7 items-center justify-center rounded text-[hsl(var(--app-muted))] hover:bg-[hsl(var(--app-surface-2))] hover:text-[hsl(var(--app-ink-0))]"
            >
              {collapsed ? (
                <ChevronRightIcon className="h-3.5 w-3.5" />
              ) : (
                <ChevronDownIcon className="h-3.5 w-3.5" />
              )}
            </button>
          </header>
        ) : null}
        <div
          ref={bodyRef}
          className="relative min-h-0 min-w-0 flex-1 px-4 py-1"
          style={{
            // #99: absolute-positioned children are out of flow, so
            // they don't contribute to the body's intrinsic height.
            // Without an explicit minimum, the container collapses
            // to just its chrome (~10px) and the labels render as
            // tiny truncated text against the top edge.  56px is the
            // natural height of a tool widget (h-5 icon + 10px label
            // + py-1.5).  Column-layout containers don't run into
            // the same issue at runtime in practice (they're inline
            // content panels driven by the surrounding flex slot)
            // but the minWidth fallback keeps them sensible too.
            ...(isRow ? { minHeight: 56 } : { minWidth: 56 }),
            ...(collapsed ? { display: 'none' } : undefined),
          }}
          aria-hidden={collapsed}
        >
          {children.map((child) => (
            <div
              key={child.id}
              ref={getRefCallback(child.id)}
              className="flex items-stretch"
              style={childPos(child)}
              data-container-child
              data-flow-child-id={child.id}
            >
              {renderChild(child)}
            </div>
          ))}
        </div>
      </div>
    </AppBarContext.Provider>
  );
}

// ---- Dock container (dock-left / dock-right) -------------------

interface DockProps extends ContainerRenderProps {
  variant: NonNullable<ContainerWidgetConfig['variant']>;
  layout: NonNullable<ContainerWidgetConfig['layout']>;
  side: 'left' | 'right';
}

function DockContainer({
  config,
  renderChild,
  variant,
  side,
}: DockProps) {
  const collapsible = config.collapsible !== false;
  const widthPx = config.widthPx ?? 280;
  const [collapsed, setCollapsed] = useState(
    config.defaultCollapsed === true,
  );

  // The dock controls its own width.  When collapsed, shrinks to a
  // 44px rail so the canvas grid takes the freed space automatically.
  const effectiveWidth = collapsed ? 44 : widthPx;
  const borderSide = side === 'left' ? 'border-r' : 'border-l';
  const chromeClass = variantClasses(variant);
  // Strip the bottom border the variantClasses adds (it's meant for
  // top bars); a side dock wants its border on the inner edge only.
  const dockChromeClass = chromeClass
    .replace('border-b', '')
    .replace('border-[hsl(var(--app-header-border))]', '');

  return (
    <aside
      className={`relative flex h-full shrink-0 flex-col overflow-hidden ${dockChromeClass} ${borderSide} border-[hsl(var(--app-border))]`}
      style={{ width: effectiveWidth, transition: 'width 160ms ease-out' }}
    >
      {collapsible ? (
        <header className="flex h-10 shrink-0 items-center gap-2 border-b border-[hsl(var(--app-border))] px-2">
          <button
            type="button"
            onClick={() => setCollapsed((v) => !v)}
            aria-label={collapsed ? 'Expand panel' : 'Collapse panel'}
            aria-expanded={!collapsed}
            className="ml-auto inline-flex h-7 w-7 items-center justify-center rounded text-[hsl(var(--app-muted))] hover:bg-[hsl(var(--app-surface-2))] hover:text-[hsl(var(--app-ink-0))]"
          >
            {side === 'left' ? (
              collapsed ? (
                <ChevronRightIcon className="h-3.5 w-3.5" />
              ) : (
                <ChevronDownIcon className="h-3.5 w-3.5 rotate-90" />
              )
            ) : collapsed ? (
              <ChevronRightIcon className="h-3.5 w-3.5 rotate-180" />
            ) : (
              <ChevronDownIcon className="h-3.5 w-3.5 -rotate-90" />
            )}
          </button>
        </header>
      ) : null}

      {/* Body: children stack vertically with a divider between
          siblings.  Stays mounted when collapsed so per-instance
          state survives collapse + re-expand; visibility hidden so
          the rail width is the only thing visible. */}
      <div
        className="min-h-0 flex-1 overflow-y-auto"
        style={collapsed ? { visibility: 'hidden' } : undefined}
        aria-hidden={collapsed}
      >
        <div className="divide-y divide-[hsl(var(--app-border)/0.6)]">
          {config.widgets.map((child) => (
            <div key={child.id} className="p-2" data-container-child>
              {renderChild(child)}
            </div>
          ))}
        </div>
      </div>
    </aside>
  );
}

// ---- Overlay container (overlay-trigger) -----------------------

interface OverlayProps extends ContainerRenderProps {
  variant: NonNullable<ContainerWidgetConfig['variant']>;
  layout: NonNullable<ContainerWidgetConfig['layout']>;
}

function OverlayContainer({ config, renderChild }: OverlayProps) {
  const [open, setOpen] = useState(false);
  const edge = config.edge ?? 'left';
  const sizePx =
    edge === 'left' || edge === 'right'
      ? config.widthPx ?? 320
      : config.heightPx ?? 320;
  const triggerLabel = config.triggerLabel ?? 'Tools';
  const Icon =
    config.triggerIcon === 'layers'
      ? LayersIcon
      : config.triggerIcon === 'filter'
        ? FilterIcon
        : config.triggerIcon === 'menu'
          ? MenuIcon
          : WrenchIcon;

  const triggerPositionClass =
    edge === 'left'
      ? 'left-2 top-1/2 -translate-y-1/2'
      : edge === 'right'
        ? 'right-2 top-1/2 -translate-y-1/2'
        : edge === 'top'
          ? 'top-2 left-1/2 -translate-x-1/2'
          : 'bottom-2 left-1/2 -translate-x-1/2';
  const drawerPositionClass =
    edge === 'left'
      ? 'left-0 top-0 h-full'
      : edge === 'right'
        ? 'right-0 top-0 h-full'
        : edge === 'top'
          ? 'top-0 left-0 w-full'
          : 'bottom-0 left-0 w-full';
  const drawerSizeStyle: CSSProperties =
    edge === 'left' || edge === 'right'
      ? { width: sizePx }
      : { height: sizePx };
  const drawerTransform =
    !open && edge === 'left'
      ? 'translate-x-[-100%]'
      : !open && edge === 'right'
        ? 'translate-x-[100%]'
        : !open && edge === 'top'
          ? 'translate-y-[-100%]'
          : !open && edge === 'bottom'
            ? 'translate-y-[100%]'
            : 'translate-x-0 translate-y-0';

  return (
    <div className="pointer-events-none absolute inset-0">
      {/* Trigger pill always visible. */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`pointer-events-auto absolute z-20 inline-flex items-center gap-1.5 rounded-full border border-[hsl(var(--app-border))] bg-[hsl(var(--app-surface-1))] px-3 py-1.5 text-xs font-medium text-[hsl(var(--app-ink-0))] shadow-[var(--app-shadow-card)] transition-colors hover:bg-[hsl(var(--app-surface-2))] ${triggerPositionClass}`}
        aria-expanded={open}
        aria-label={open ? `Close ${triggerLabel}` : `Open ${triggerLabel}`}
      >
        <Icon className="h-3.5 w-3.5 text-[hsl(var(--app-muted))]" />
        {triggerLabel}
      </button>

      {/* Drawer panel.  Stays mounted so per-instance state survives
          open/close; off-screen when closed via translate transform. */}
      <aside
        className={`pointer-events-auto absolute z-10 flex flex-col overflow-hidden border-[hsl(var(--app-border))] bg-[hsl(var(--app-surface-1))] shadow-[var(--app-shadow-overlay)] transition-transform duration-200 ease-out ${drawerPositionClass} ${drawerTransform} ${
          edge === 'left' || edge === 'right' ? 'border-l border-r' : 'border-t border-b'
        }`}
        style={drawerSizeStyle}
        aria-hidden={!open}
      >
        <header className="flex h-10 shrink-0 items-center gap-2 border-b border-[hsl(var(--app-border))] px-3">
          <Icon className="h-3.5 w-3.5 text-[hsl(var(--app-muted))]" />
          <span className="flex-1 truncate text-sm font-semibold text-[hsl(var(--app-ink-0))]">
            {triggerLabel}
          </span>
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="Close drawer"
            className="rounded p-1 text-[hsl(var(--app-muted))] hover:bg-[hsl(var(--app-surface-2))] hover:text-[hsl(var(--app-ink-0))]"
          >
            <XIcon className="h-3.5 w-3.5" />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="divide-y divide-[hsl(var(--app-border)/0.6)]">
            {config.widgets.map((child) => (
              <div key={child.id} className="p-2" data-container-child>
                {renderChild(child)}
              </div>
            ))}
          </div>
        </div>
      </aside>
    </div>
  );
}

// ---- Menu container (#104) -------------------------------------

/**
 * Stack-style menu container.  Renders a single tool-sized button.
 * Click opens a small popover below the trigger showing the
 * container's children stacked vertically -- each child is a fully-
 * functioning tool button via the same renderChild path.  Use for
 * packing related actions like Add/Edit/Delete under a single
 * "Edit" icon, instead of taking three slots in the toolbar.
 *
 * Position semantics:
 *   - The trigger pretends to be a tool button.  In an AppBar
 *     context it uses the header-ink treatment; on the plain
 *     canvas it uses the standard raised-pill look.  Matches the
 *     ToolButton style in runtime-client.tsx so the menu trigger
 *     visually fits anywhere a regular tool would.
 *   - The popover is positioned absolutely below the trigger via
 *     a portal-free trick (relative wrapper + absolute popover at
 *     top:100%).  Closes on Escape or click outside.
 *   - Each child renders through renderChild, which preserves the
 *     child's own tool-button popover behavior.  If a child opens
 *     its popover from within the menu, the menu stays open --
 *     the child's popover layers on top.  Typing Escape closes
 *     the most recent popover first, then the menu.
 */
function MenuContainer({ config, renderChild }: ContainerRenderProps) {
  const [open, setOpen] = useState(false);
  const triggerLabel = config.triggerLabel ?? 'Menu';
  const Icon =
    config.triggerIcon === 'layers'
      ? LayersIcon
      : config.triggerIcon === 'filter'
        ? FilterIcon
        : config.triggerIcon === 'menu'
          ? MenuIcon
          : WrenchIcon;
  const inAppBar = useContext(AppBarContext);
  const ref = useRef<HTMLDivElement | null>(null);

  // Close on outside click + Escape.  Same pattern as the tool-
  // button popover so the menu disappears when the user navigates
  // away.
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (!ref.current) return;
      if (!ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative inline-flex">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title={triggerLabel}
        style={
          inAppBar && open
            ? {
                backgroundColor: 'hsl(var(--app-header-ink))',
                color: 'hsl(var(--app-header-bg))',
              }
            : undefined
        }
        className={
          inAppBar
            ? `flex h-full min-w-[64px] flex-col items-center justify-center gap-0.5 rounded-md px-2.5 py-1.5 transition-colors ${
                open
                  ? ''
                  : 'text-[hsl(var(--app-header-ink)/0.85)] hover:bg-[hsl(var(--app-header-ink)/0.12)] hover:text-[hsl(var(--app-header-ink))]'
              }`
            : `flex h-full w-full flex-col items-center justify-center gap-0.5 rounded-md border bg-surface-1 px-2.5 py-1.5 shadow-sm transition-all ${
                open
                  ? 'border-ink-0 text-ink-0 ring-2 ring-ink-0/10'
                  : 'border-border text-ink-1 hover:border-ink-1 hover:shadow-md'
              }`
        }
      >
        <Icon className="h-5 w-5" strokeWidth={1.75} />
        <span className="text-2xs font-medium leading-none">
          {triggerLabel}
        </span>
      </button>
      {open ? (
        <div
          className="absolute left-1/2 top-full z-30 mt-1 min-w-[180px] -translate-x-1/2 rounded-md border border-[hsl(var(--app-border))] bg-[hsl(var(--app-surface-1))] p-1 shadow-[var(--app-shadow-overlay)]"
          role="menu"
        >
          <div className="flex flex-col gap-0.5">
            {config.widgets.map((child) => (
              <div key={child.id} role="menuitem" className="flex">
                {renderChild(child)}
              </div>
            ))}
            {config.widgets.length === 0 ? (
              <div className="px-2 py-1 text-2xs italic text-[hsl(var(--app-muted))]">
                Empty menu -- drop tools into this stack in the
                designer.
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
