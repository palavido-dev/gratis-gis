// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

/**
 * Studio shell for full-screen builder surfaces (map editor, web app
 * builder, form builder, future dashboard builder). Covers the portal
 * chrome with a fixed full-viewport layout so the user has the whole
 * screen to design in.
 *
 * Layout:
 *
 *   +-- top bar ----------------------------------------------------+
 *   |  back   icon   title              toolbar right (save, etc.) |
 *   +---------------+-------------------------------+---------------+
 *   |               |                               |               |
 *   |  left panel   |        canvas (children)      |  right panel  |
 *   |  (palette,    |                               |  (config)     |
 *   |   layers,     |                               |               |
 *   |   ...)        |                               |               |
 *   |               |                               |               |
 *   +---------------+-------------------------------+---------------+
 *
 * Each side panel has a pin/unpin toggle. Pinned (the default) means
 * it sits in the layout flow and the canvas reflows around it.
 * Unpinned, the panel collapses to a narrow icon rail and clicking
 * the rail opens the panel as a floating overlay above the canvas;
 * clicking on the canvas dismisses. Either way, when the user needs
 * more canvas they get more canvas.
 *
 * State is persisted to localStorage per surface (e.g.
 * `builder-shell:map`, `builder-shell:web-app`, `builder-shell:form`)
 * so reopening the builder respects the user's last layout.
 *
 * Why an overlay layer rather than separate routes: each item type's
 * builder already lives at `/items/[id]` and shares state + data
 * fetches with the metadata view. Lifting them to dedicated
 * `/items/[id]/<kind>/edit` routes is a bigger refactor that we can do
 * later if it pays off. The overlay approach gives us the screen real
 * estate today without disturbing routing, breadcrumbs, or item-type
 * dispatch in the detail page.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import {
  ArrowLeft,
  PanelLeft,
  PanelLeftClose,
  PanelRight,
  PanelRightClose,
  Pin,
  PinOff,
  X,
} from 'lucide-react';

interface Props {
  /**
   * localStorage key prefix used to persist pin state + panel widths.
   * Each builder surface uses a unique key so opening the map editor
   * doesn't inherit the form builder's last layout. Convention:
   * `builder-shell:<surface>` (e.g. `builder-shell:map`).
   */
  storageKey: string;
  /**
   * Destination of the back arrow in the top bar.
   *
   * NOT `/items/<id>`. Every builder that uses this shell is mounted
   * BY `/items/[id]/page.tsx`, so the builder and the item detail
   * page are the same URL and that href renders a back arrow that
   * navigates to the page you are already on. It looks like a dead
   * button, which is exactly how it was reported. All six callers
   * pointed there until 2026-08-22.
   *
   * `/items` is the honest destination: leaving a builder means
   * leaving the item.
   */
  backHref: string;
  /** Title rendered next to the back arrow in the top bar. */
  title: string;
  /**
   * Optional icon shown left of the title (item type badge, etc.).
   * Pure ornament; can be any node.
   */
  icon?: ReactNode;
  /**
   * Right-hand toolbar contents. Typically Save button, dirty / saved
   * indicators, "Open" link to a runtime, share controls. Lives in
   * the top bar so it's always reachable regardless of canvas state.
   */
  toolbarRight?: ReactNode;
  /**
   * Left-panel content. The shell wraps it in a scroll container and
   * a header with optional title + pin toggle.
   */
  leftPanel: ReactNode;
  /** Right-panel content. Same wrapping as leftPanel. */
  rightPanel: ReactNode;
  /** Optional header label shown above the left panel content. */
  leftPanelTitle?: string;
  /** Optional header label shown above the right panel content. */
  rightPanelTitle?: string;
  /**
   * Icon shown on the left rail when the left panel is unpinned. Falls
   * back to PanelLeft. Customizable so map editor can use a Layers
   * icon, web app builder can use a Widgets icon, etc.
   */
  leftRailIcon?: ReactNode;
  /** Icon shown on the right rail when the right panel is unpinned. */
  rightRailIcon?: ReactNode;
  /** Canvas content. */
  children: ReactNode;
}

const DEFAULT_LEFT_WIDTH = 288;
const DEFAULT_RIGHT_WIDTH = 320;
const MIN_PANEL_WIDTH = 220;
const MAX_PANEL_WIDTH = 520;
const RAIL_WIDTH = 40;

interface ShellState {
  leftPinned: boolean;
  rightPinned: boolean;
  leftWidth: number;
  rightWidth: number;
}

function defaultState(): ShellState {
  return {
    leftPinned: true,
    rightPinned: true,
    leftWidth: DEFAULT_LEFT_WIDTH,
    rightWidth: DEFAULT_RIGHT_WIDTH,
  };
}

function clampWidth(n: unknown, fallback: number): number {
  const num = typeof n === 'number' && Number.isFinite(n) ? n : fallback;
  return Math.max(MIN_PANEL_WIDTH, Math.min(MAX_PANEL_WIDTH, num));
}

function loadState(key: string): ShellState {
  if (typeof window === 'undefined') return defaultState();
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return defaultState();
    const parsed = JSON.parse(raw) as Partial<ShellState>;
    return {
      leftPinned:
        typeof parsed.leftPinned === 'boolean' ? parsed.leftPinned : true,
      rightPinned:
        typeof parsed.rightPinned === 'boolean' ? parsed.rightPinned : true,
      leftWidth: clampWidth(parsed.leftWidth, DEFAULT_LEFT_WIDTH),
      rightWidth: clampWidth(parsed.rightWidth, DEFAULT_RIGHT_WIDTH),
    };
  } catch {
    return defaultState();
  }
}

export function BuilderShell({
  storageKey,
  backHref,
  title,
  icon,
  toolbarRight,
  leftPanel,
  rightPanel,
  leftPanelTitle,
  rightPanelTitle,
  leftRailIcon,
  rightRailIcon,
  children,
}: Props) {
  const [state, setState] = useState<ShellState>(defaultState);
  // Floating-panel open state (only relevant when unpinned). Not
  // persisted: a panel opened as a floating overlay closes on the next
  // page load and on canvas clicks, the same way a popover does.
  const [leftFloatOpen, setLeftFloatOpen] = useState(false);
  const [rightFloatOpen, setRightFloatOpen] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  // Load persisted state on mount. The default-state render covers
  // the SSR pass; the localStorage read happens client-side only.
  useEffect(() => {
    setState(loadState(storageKey));
    setHydrated(true);
  }, [storageKey]);

  // Persist whenever state changes (after hydration).
  useEffect(() => {
    if (!hydrated) return;
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(state));
    } catch {
      /* localStorage unavailable / quota -- non-fatal */
    }
  }, [state, storageKey, hydrated]);

  // Lock body scroll while the shell is mounted. The shell is a
  // fixed-position overlay, so any wheel input that lands on a
  // non-scrollable region would otherwise bubble up to the document
  // and shift the page content underneath. We restore the previous
  // value on unmount rather than blindly setting `''` so a nested
  // overlay (e.g. AddLayerDialog) doesn't surprise the user with a
  // free scrollbar when it closes.
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  // Esc closes any open floating panel. Doesn't unmount the shell;
  // the back arrow is the documented exit.
  useEffect(() => {
    if (!leftFloatOpen && !rightFloatOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setLeftFloatOpen(false);
        setRightFloatOpen(false);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [leftFloatOpen, rightFloatOpen]);

  // Drag-to-resize for pinned panels. Mouse-down on the resizer
  // captures the pointer; mouse-move updates width; mouse-up commits.
  // We intentionally use document listeners rather than per-element
  // pointer events so a fast drag that exits the resizer doesn't
  // strand the resize state.
  const dragRef = useRef<{
    side: 'left' | 'right';
    startX: number;
    startWidth: number;
  } | null>(null);

  const onResizerDown = useCallback(
    (side: 'left' | 'right') => (e: React.MouseEvent) => {
      e.preventDefault();
      const startWidth = side === 'left' ? state.leftWidth : state.rightWidth;
      dragRef.current = { side, startX: e.clientX, startWidth };
      document.body.style.cursor = 'col-resize';
      // Prevent text selection while dragging.
      document.body.style.userSelect = 'none';
    },
    [state.leftWidth, state.rightWidth],
  );

  useEffect(() => {
    function onMove(e: MouseEvent) {
      const drag = dragRef.current;
      if (!drag) return;
      const delta = e.clientX - drag.startX;
      const raw =
        drag.side === 'left' ? drag.startWidth + delta : drag.startWidth - delta;
      const next = clampWidth(raw, drag.startWidth);
      setState((s) =>
        drag.side === 'left' ? { ...s, leftWidth: next } : { ...s, rightWidth: next },
      );
    }
    function onUp() {
      if (!dragRef.current) return;
      dragRef.current = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
  }, []);

  function toggleLeftPin() {
    setState((s) => ({ ...s, leftPinned: !s.leftPinned }));
    setLeftFloatOpen(false);
  }

  function toggleRightPin() {
    setState((s) => ({ ...s, rightPinned: !s.rightPinned }));
    setRightFloatOpen(false);
  }

  return (
    <div className="fixed inset-0 z-20 flex flex-col bg-surface-0 text-ink-0">
      {/* Top bar. Keeps roughly the same height as the portal chrome's
          top bar so the visual context shift between portal and
          builder feels intentional rather than abrupt. */}
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border bg-surface-1 px-3">
        <Link
          href={backHref}
          className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-2 hover:text-ink-0"
          title="Back to item"
          aria-label="Back to item"
        >
          <ArrowLeft className="h-4 w-4" />
        </Link>
        {icon ? <span className="shrink-0">{icon}</span> : null}
        <h1 className="min-w-0 truncate text-sm font-medium">{title}</h1>
        {toolbarRight ? (
          <div className="ml-auto flex shrink-0 items-center gap-2">
            {toolbarRight}
          </div>
        ) : null}
      </header>

      <div className="relative flex min-h-0 flex-1">
        {/* Left side: either a pinned panel (in-flow) or a collapsed
            rail (button-only). The floating-overlay variant is rendered
            below as an absolutely-positioned sibling so it sits above
            the canvas. */}
        {state.leftPinned ? (
          <>
            <aside
              className="flex shrink-0 flex-col overflow-hidden border-r border-border bg-surface-1"
              style={{ width: state.leftWidth }}
            >
              <PanelHeader
                title={leftPanelTitle}
                pinned
                onTogglePin={toggleLeftPin}
                side="left"
              />
              <div className="min-h-0 flex-1 overflow-y-auto">{leftPanel}</div>
            </aside>
            <Resizer onMouseDown={onResizerDown('left')} side="left" />
          </>
        ) : (
          <aside
            className="flex shrink-0 flex-col items-center gap-1 border-r border-border bg-surface-1 py-2"
            style={{ width: RAIL_WIDTH }}
          >
            <button
              type="button"
              onClick={() => setLeftFloatOpen((v) => !v)}
              className={`inline-flex h-8 w-8 items-center justify-center rounded-md transition-colors ${
                leftFloatOpen
                  ? 'bg-accent text-accent-foreground'
                  : 'text-muted hover:bg-surface-2 hover:text-ink-0'
              }`}
              title={leftPanelTitle ?? 'Open left panel'}
              aria-label={leftPanelTitle ?? 'Open left panel'}
              aria-expanded={leftFloatOpen}
            >
              {leftRailIcon ?? <PanelLeft className="h-4 w-4" />}
            </button>
          </aside>
        )}

        {/* Canvas. Owns whatever overlay UI a specific builder wants to
            stack on top (legend, attribute table, basemap menu, etc.). */}
        <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
          {children}
          {/* Floating left panel overlay (when unpinned + open). Sits
              above the canvas; backdrop catches click-away. */}
          {!state.leftPinned && leftFloatOpen ? (
            <FloatingPanelOverlay
              side="left"
              width={state.leftWidth}
              title={leftPanelTitle}
              onClose={() => setLeftFloatOpen(false)}
              onTogglePin={toggleLeftPin}
              pinned={false}
            >
              {leftPanel}
            </FloatingPanelOverlay>
          ) : null}
          {!state.rightPinned && rightFloatOpen ? (
            <FloatingPanelOverlay
              side="right"
              width={state.rightWidth}
              title={rightPanelTitle}
              onClose={() => setRightFloatOpen(false)}
              onTogglePin={toggleRightPin}
              pinned={false}
            >
              {rightPanel}
            </FloatingPanelOverlay>
          ) : null}
        </main>

        {state.rightPinned ? (
          <>
            <Resizer onMouseDown={onResizerDown('right')} side="right" />
            <aside
              className="flex shrink-0 flex-col overflow-hidden border-l border-border bg-surface-1"
              style={{ width: state.rightWidth }}
            >
              <PanelHeader
                title={rightPanelTitle}
                pinned
                onTogglePin={toggleRightPin}
                side="right"
              />
              <div className="min-h-0 flex-1 overflow-y-auto">{rightPanel}</div>
            </aside>
          </>
        ) : (
          <aside
            className="flex shrink-0 flex-col items-center gap-1 border-l border-border bg-surface-1 py-2"
            style={{ width: RAIL_WIDTH }}
          >
            <button
              type="button"
              onClick={() => setRightFloatOpen((v) => !v)}
              className={`inline-flex h-8 w-8 items-center justify-center rounded-md transition-colors ${
                rightFloatOpen
                  ? 'bg-accent text-accent-foreground'
                  : 'text-muted hover:bg-surface-2 hover:text-ink-0'
              }`}
              title={rightPanelTitle ?? 'Open right panel'}
              aria-label={rightPanelTitle ?? 'Open right panel'}
              aria-expanded={rightFloatOpen}
            >
              {rightRailIcon ?? <PanelRight className="h-4 w-4" />}
            </button>
          </aside>
        )}
      </div>
    </div>
  );
}

interface PanelHeaderProps {
  title: string | undefined;
  pinned: boolean;
  onTogglePin: () => void;
  side: 'left' | 'right';
  onClose?: () => void;
}

function PanelHeader({ title, pinned, onTogglePin, side, onClose }: PanelHeaderProps) {
  const PinIcon = pinned ? Pin : PinOff;
  const CloseIcon = side === 'left' ? PanelLeftClose : PanelRightClose;
  return (
    <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border bg-surface-2 px-2">
      {title ? (
        <span className="min-w-0 truncate text-2xs font-semibold uppercase tracking-wide text-muted">
          {title}
        </span>
      ) : null}
      <div className="ml-auto flex items-center gap-0.5">
        <button
          type="button"
          onClick={onTogglePin}
          className="inline-flex h-6 w-6 items-center justify-center rounded text-muted transition-colors hover:bg-surface-1 hover:text-ink-0"
          title={pinned ? 'Unpin (collapse to icon)' : 'Pin panel open'}
          aria-label={pinned ? 'Unpin panel' : 'Pin panel'}
        >
          <PinIcon className="h-3.5 w-3.5" />
        </button>
        {onClose ? (
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-6 w-6 items-center justify-center rounded text-muted transition-colors hover:bg-surface-1 hover:text-ink-0"
            title="Close panel"
            aria-label="Close panel"
          >
            <CloseIcon className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </div>
    </div>
  );
}

interface FloatingPanelOverlayProps {
  side: 'left' | 'right';
  width: number;
  title: string | undefined;
  pinned: boolean;
  onClose: () => void;
  onTogglePin: () => void;
  children: ReactNode;
}

function FloatingPanelOverlay({
  side,
  width,
  title,
  pinned,
  onClose,
  onTogglePin,
  children,
}: FloatingPanelOverlayProps) {
  // Backdrop catches click-away. We deliberately don't render a
  // visible dim (the canvas stays fully readable behind the panel);
  // the backdrop is just an invisible click target outside the panel
  // bounds.
  return (
    <>
      <div
        className="absolute inset-0 z-10"
        onClick={onClose}
        aria-hidden="true"
      />
      <aside
        className={`absolute top-2 z-20 flex max-h-[calc(100%-1rem)] flex-col overflow-hidden rounded-lg border border-border bg-surface-1 shadow-overlay ${
          side === 'left' ? 'left-2' : 'right-2'
        }`}
        style={{ width }}
        onClick={(e) => e.stopPropagation()}
      >
        <PanelHeader
          title={title}
          pinned={pinned}
          onTogglePin={onTogglePin}
          side={side}
          onClose={onClose}
        />
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
      </aside>
    </>
  );
}

interface ResizerProps {
  onMouseDown: (e: React.MouseEvent) => void;
  side: 'left' | 'right';
}

function Resizer({ onMouseDown, side }: ResizerProps) {
  // 4px wide hit area with a 1px visible divider in the middle.
  // Hovering / dragging shows the accent color.
  return (
    <div
      onMouseDown={onMouseDown}
      className="group relative w-1 shrink-0 cursor-col-resize bg-transparent"
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize ${side} panel`}
    >
      <div className="absolute inset-y-0 left-0 w-px bg-border transition-colors group-hover:bg-accent group-active:bg-accent" />
    </div>
  );
}

// Re-exported so callers don't need a second import for the X icon
// when they want to add their own header bits inside the panels.
export { X as BuilderShellCloseIcon };
