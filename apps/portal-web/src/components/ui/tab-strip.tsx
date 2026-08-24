// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import { useRef } from 'react';

/**
 * Shared ARIA tablist primitives.
 *
 * Extracted from the map layer panel, which had the only correct
 * implementation in portal-web and kept it module-private. The
 * roving-tabindex behaviour below is the part worth sharing: it is
 * easy to render buttons that look like tabs and easy to forget that
 * a tablist puts exactly one tab in the tab order and moves between
 * them with the arrow keys. A second hand-rolled copy would almost
 * certainly have shipped without it.
 */

export interface TabDef<T extends string> {
  id: T;
  label: string;
  /**
   * Optional trailing count. Rendered muted after the label, so a
   * strip can say "Access 3" without the caller building its own
   * badge markup and getting the spacing subtly different.
   */
  count?: number;
}

interface TabStripProps<T extends string> {
  tabs: ReadonlyArray<TabDef<T>>;
  value: T;
  onChange: (next: T) => void;
  /** Accessible name for the tablist. */
  ariaLabel: string;
  /**
   * Namespace for the generated ids. Must match the `idPrefix` passed
   * to the matching TabPanel, and must be unique within the page:
   * two strips sharing a prefix emit duplicate ids and `aria-controls`
   * silently starts pointing at the other strip's panel.
   */
  idPrefix: string;
  /**
   * `fill` divides the width equally, for narrow rails where the tabs
   * have to share a fixed column. `inline` sizes each tab to its own
   * label, for full-width strips where equal division would leave a
   * short label floating in the middle of a wide cell.
   */
  variant?: 'fill' | 'inline';
  className?: string;
}

export function TabStrip<T extends string>({
  tabs,
  value,
  onChange,
  ariaLabel,
  idPrefix,
  variant = 'fill',
  className,
}: TabStripProps<T>) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  const move = (dir: 1 | -1 | 'first' | 'last') => {
    const i = tabs.findIndex((t) => t.id === value);
    const next =
      dir === 'first'
        ? 0
        : dir === 'last'
          ? tabs.length - 1
          : (i + dir + tabs.length) % tabs.length;
    const target = tabs[next];
    if (!target) return;
    onChange(target.id);
    refs.current[next]?.focus();
  };

  const list = (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={
        variant === 'fill'
          ? 'flex border-t border-border'
          : // -mb-px pulls the row down so an active tab's 2px accent
            // covers the wrapper's 1px rule instead of stacking above
            // it. overflow-y is pinned to hidden because that 1px is
            // vertical overflow, and CSS promotes the other axis to
            // auto whenever one axis scrolls, so `overflow-x-auto`
            // alone rendered a permanent vertical scrollbar over the
            // last tab.
            '-mb-px flex items-center gap-1 overflow-x-auto overflow-y-hidden'
      }
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
      {tabs.map((t, i) => {
        const active = t.id === value;
        return (
          <button
            key={t.id}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={`${idPrefix}-tab-${t.id}`}
            aria-selected={active}
            aria-controls={`${idPrefix}-tabpanel-${t.id}`}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(t.id)}
            className={
              variant === 'fill'
                ? `min-w-0 flex-1 truncate border-b-2 px-1 py-2 text-xs font-medium transition ${
                    active
                      ? 'border-accent text-ink-0'
                      : 'border-transparent text-muted hover:text-ink-1'
                  }`
                : `shrink-0 whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium transition ${
                    active
                      ? 'border-accent text-ink-0'
                      : 'border-transparent text-muted hover:text-ink-1'
                  }`
            }
          >
            {t.label}
            {typeof t.count === 'number' ? (
              <span className="ml-1.5 text-2xs tabular-nums text-muted">
                {t.count}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );

  // `fill` sits flush inside a rail that already draws its own edges,
  // so it stays a single element. `inline` needs a wrapper to own the
  // rule: the scrolling row cannot also draw it without clipping the
  // active tab's accent.
  if (variant === 'fill') return list;
  return <div className={className ?? 'border-b border-border'}>{list}</div>;
}

interface TabPanelProps<T extends string> {
  tab: T;
  active: T;
  idPrefix: string;
  /**
   * How an inactive panel is hidden.
   *
   * `unmount` removes it from the tree. Cheapest, and right when the
   * panels are independent views of the same object.
   *
   * `hidden` keeps it mounted behind `display: none`. Required when a
   * panel holds unsaved edits, because unmounting a form is
   * indistinguishable from discarding it, and the user who tabs to
   * Source to check a date does not expect to come back to an empty
   * schema builder. The cost is that anything measuring its own
   * container on mount measures zero, so a map inside a `hidden`
   * panel needs a ResizeObserver to recover when it is revealed.
   */
  mode?: 'unmount' | 'hidden';
  className?: string;
  children: React.ReactNode;
}

export function TabPanel<T extends string>({
  tab,
  active,
  idPrefix,
  mode = 'unmount',
  className,
  children,
}: TabPanelProps<T>) {
  const isActive = tab === active;
  if (!isActive && mode === 'unmount') return null;
  return (
    <div
      role="tabpanel"
      id={`${idPrefix}-tabpanel-${tab}`}
      aria-labelledby={`${idPrefix}-tab-${tab}`}
      hidden={!isActive}
      className={isActive ? className : 'hidden'}
    >
      {children}
    </div>
  );
}
