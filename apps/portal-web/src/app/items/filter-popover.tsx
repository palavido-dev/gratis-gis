'use client';

import { useEffect, useRef, useState } from 'react';
import { Crosshair, SlidersHorizontal, X } from 'lucide-react';
import type { ItemType } from '@gratis-gis/shared-types';
import {
  getItemTypeAccent,
  getItemTypeIcon,
  getItemTypeLabel,
} from '@/lib/item-type-icon';

/**
 * Single Filter pill that opens a popover containing the per-type
 * chip strip and the geographic-area toggle. Replaces the always-on
 * chip row that used to live below the toolbar.
 *
 * Why a popover rather than a drawer or modal: the chips are
 * lightweight toggles, the user wants to flip a couple, see the
 * grid update behind, and dismiss. A modal would force a heavier
 * commit-cancel mental model that doesn't match the action.
 *
 * The pill itself shows:
 *   - a count badge when one or more filters are active (sum of type
 *     filters + 1 if the area filter is on)
 *   - an "active" tinted style so the user can see at a glance
 *     whether anything is filtering the grid even when the popover
 *     is closed
 *
 * Clear-all sits inside the popover at the bottom rather than next
 * to the pill so the toolbar row stays visually quiet when no
 * filters are applied. If filters ARE applied, the items-view
 * surfaces an inline summary chip below the toolbar that also has a
 * one-click clear.
 */
interface Props {
  /** Currently-toggled type filters. Empty Set means "show all". */
  typeFilter: Set<ItemType>;
  /** Type+count pairs to render in the popover. Server provides the
   *  full present-in-data set; the popover renders them all. */
  typeCounts: Array<[ItemType, number]>;
  onToggleType: (t: ItemType) => void;
  onClearTypes: () => void;
  /** Geographic-area state. The popover surfaces a single button that
   *  opens the existing AreaSearchPanel; the panel itself is rendered
   *  by items-view, not the popover, so its map can take the full
   *  page width when expanded. */
  areaActive: boolean;
  areaPanelOpen: boolean;
  onToggleAreaPanel: () => void;
  onClearAreaSearch: () => void;
}

export function FilterPopover({
  typeFilter,
  typeCounts,
  onToggleType,
  onClearTypes,
  areaActive,
  areaPanelOpen,
  onToggleAreaPanel,
  onClearAreaSearch,
}: Props) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  const activeCount = typeFilter.size + (areaActive ? 1 : 0);

  // Close on outside click + Escape. Same pattern as folder-row-menu.
  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (
        wrapperRef.current &&
        e.target instanceof Node &&
        !wrapperRef.current.contains(e.target)
      ) {
        setOpen(false);
      }
    }
    function onEsc(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    window.addEventListener('mousedown', onDocClick);
    window.addEventListener('keydown', onEsc);
    return () => {
      window.removeEventListener('mousedown', onDocClick);
      window.removeEventListener('keydown', onEsc);
    };
  }, [open]);

  // Auto-close the popover when the area panel is opened: the area
  // panel takes the full content width below the toolbar, so leaving
  // the popover open would visually compete with it.
  useEffect(() => {
    if (areaPanelOpen) setOpen(false);
  }, [areaPanelOpen]);

  return (
    <div ref={wrapperRef} className="relative inline-flex">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="dialog"
        title="Filter items"
        className={`inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-xs transition-colors ${
          activeCount > 0
            ? 'border-accent bg-accent/10 text-accent'
            : 'border-border bg-surface-1 text-ink-1 hover:bg-surface-2'
        }`}
      >
        <SlidersHorizontal className="h-3.5 w-3.5" />
        Filter
        {activeCount > 0 ? (
          <span
            className="ml-0.5 inline-flex h-4 min-w-[16px] items-center justify-center rounded-full bg-accent px-1 text-[10px] font-semibold leading-none text-accent-foreground"
            aria-label={`${activeCount} filter${activeCount === 1 ? '' : 's'} active`}
          >
            {activeCount}
          </span>
        ) : null}
      </button>

      {open ? (
        <div
          role="dialog"
          aria-label="Filter items"
          // Anchored under the pill, left-aligned. max-w stops the
          // panel from running off the right edge on a narrow viewport;
          // the chip strip wraps inside if there are many types.
          className="absolute left-0 top-full z-30 mt-1 w-[min(28rem,calc(100vw-2rem))] rounded-md border border-border bg-surface-1 p-3 shadow-lg"
        >
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[11px] font-medium uppercase tracking-wide text-muted">
              Type
            </span>
            {typeFilter.size > 0 ? (
              <button
                type="button"
                onClick={onClearTypes}
                className="text-[11px] text-muted hover:text-ink-1 hover:underline"
              >
                Clear types
              </button>
            ) : null}
          </div>

          {typeCounts.length === 0 ? (
            <p className="text-xs text-muted">
              No items in the current view to filter.
            </p>
          ) : (
            <div className="flex flex-wrap items-center gap-1.5">
              {typeCounts.map(([t, count]) => {
                const active = typeFilter.has(t);
                const Icon = getItemTypeIcon(t);
                const accent = getItemTypeAccent(t);
                return (
                  <button
                    key={t}
                    type="button"
                    onClick={() => onToggleType(t)}
                    aria-pressed={active}
                    className={`inline-flex h-7 items-center gap-1 rounded-full border px-2 text-[11px] transition-colors ${
                      active
                        ? 'border-accent bg-accent/10 text-accent'
                        : 'border-border bg-surface-1 text-ink-1 hover:bg-surface-2'
                    }`}
                  >
                    <Icon className={`h-3 w-3 ${active ? '' : accent}`} />
                    {getItemTypeLabel(t)}
                    <span className="text-muted">({count})</span>
                  </button>
                );
              })}
            </div>
          )}

          <div className="mt-3 flex items-center justify-between border-t border-border pt-3">
            <span className="text-[11px] font-medium uppercase tracking-wide text-muted">
              Area
            </span>
            {areaActive ? (
              <button
                type="button"
                onClick={onClearAreaSearch}
                className="text-[11px] text-muted hover:text-ink-1 hover:underline"
              >
                Clear area
              </button>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onToggleAreaPanel}
            aria-pressed={areaPanelOpen || areaActive}
            className={`mt-2 inline-flex h-7 items-center gap-1 rounded-full border px-2 text-[11px] transition-colors ${
              areaPanelOpen || areaActive
                ? 'border-accent bg-accent/10 text-accent'
                : 'border-border bg-surface-1 text-ink-1 hover:bg-surface-2'
            }`}
          >
            <Crosshair className="h-3 w-3" />
            {areaActive ? 'Filtering by area' : 'Filter by area...'}
          </button>

          {(typeFilter.size > 0 || areaActive) ? (
            <button
              type="button"
              onClick={() => {
                if (typeFilter.size > 0) onClearTypes();
                if (areaActive) onClearAreaSearch();
              }}
              className="mt-3 inline-flex h-7 w-full items-center justify-center gap-1 rounded-md border border-border bg-surface-1 text-[11px] text-ink-1 hover:bg-surface-2"
            >
              <X className="h-3 w-3" />
              Clear all filters
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
