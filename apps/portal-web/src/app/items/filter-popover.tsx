// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import { useEffect, useRef, useState } from 'react';
import { Crosshair, Globe, Lock, SlidersHorizontal, Users, X } from 'lucide-react';
import type {
  ItemAccess,
  ItemType,
  WebAppTemplate,
} from '@gratis-gis/shared-types';
import {
  getItemTypeAccent,
  getItemTypeIcon,
  getItemTypeLabel,
} from '@/lib/item-type-icon';
import { useT } from '@/lib/i18n/locale-context';

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
  /** #258: secondary facet for `web_app` items, surfaced as a
   *  Template chip strip below Type when at least one template
   *  shows up in the visible items. Today's only template is
   *  'editor'; viewer / custom join the union as they ship.
   *  Empty Set means "all templates". */
  templateFilter: Set<WebAppTemplate>;
  templateCounts: Array<[WebAppTemplate, number]>;
  onToggleTemplate: (t: WebAppTemplate) => void;
  onClearTypes: () => void;
  /** Geographic-area state. The popover surfaces a single button that
   *  opens the existing AreaSearchPanel; the panel itself is rendered
   *  by items-view, not the popover, so its map can take the full
   *  page width when expanded. */
  areaActive: boolean;
  areaPanelOpen: boolean;
  onToggleAreaPanel: () => void;
  onClearAreaSearch: () => void;
  /** #87: owner facet. Empty Set means "all owners"; multi-select
   *  unions ("show items owned by alice OR bob"). Only shown when
   *  more than one distinct owner appears in the visible item set
   *  (a single-owner list has nothing to narrow). Counts come from
   *  the visible items so a chip's number always matches a row in
   *  the grid. ownerLabels maps userId -> human label (fullName
   *  first, then username, then short uuid prefix); the popover
   *  doesn't fetch the user list itself. */
  ownerFilter?: Set<string>;
  ownerCounts?: Array<[string, number]>;
  ownerLabels?: Record<string, string>;
  onToggleOwner?: (userId: string) => void;
  /** Access facet. Empty Set means "all access levels". Multi-select
   *  unions (public OR org). Only rendered when more than one access
   *  level is present in the visible items -- a list that is all one
   *  level has nothing to narrow. Counts come from the visible set so
   *  a chip's number always matches rows in the grid. */
  accessFilter?: Set<ItemAccess>;
  accessCounts?: Array<[ItemAccess, number]>;
  onToggleAccess?: (a: ItemAccess) => void;
}

/** Per-access-level chip icon so the levels are scannable at a
 *  glance. Mirrors the visibility vocabulary used in the sharing
 *  panel: globe = anyone, people = the org, lock = just you. */
const ACCESS_ICON: Record<ItemAccess, typeof Globe> = {
  public: Globe,
  org: Users,
  private: Lock,
};

export function FilterPopover({
  typeFilter,
  typeCounts,
  onToggleType,
  templateFilter,
  templateCounts,
  onToggleTemplate,
  onClearTypes,
  areaActive,
  areaPanelOpen,
  onToggleAreaPanel,
  onClearAreaSearch,
  ownerFilter,
  ownerCounts,
  ownerLabels,
  onToggleOwner,
  accessFilter,
  accessCounts,
  onToggleAccess,
}: Props) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  const activeCount =
    typeFilter.size +
    templateFilter.size +
    (areaActive ? 1 : 0) +
    (ownerFilter?.size ?? 0) +
    (accessFilter?.size ?? 0);

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
        title={t('filter.filterItems')}
        className={`inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-xs transition-colors ${
          activeCount > 0
            ? 'border-accent bg-accent/10 text-accent'
            : 'border-border bg-surface-1 text-ink-1 hover:bg-surface-2'
        }`}
      >
        <SlidersHorizontal className="h-3.5 w-3.5" />
        {t('filter.filter')}
        {activeCount > 0 ? (
          <span
            className="ml-0.5 inline-flex h-4 min-w-[16px] items-center justify-center rounded-full bg-accent px-1 text-2xs font-semibold leading-none text-accent-foreground"
            aria-label={t('filter.activeCount', { count: activeCount })}
          >
            {activeCount}
          </span>
        ) : null}
      </button>

      {open ? (
        <div
          role="dialog"
          aria-label={t('filter.filterItems')}
          // Anchored under the pill. On mobile we right-align so the
          // panel can't overflow off the right edge of the viewport
          // when the Filter button sits near the middle of the
          // header (Matt's iPhone screenshot showed type chips
          // clipped behind the right edge). Desktop keeps the
          // left-aligned anchor so the panel hugs the button as
          // before.
          className="absolute right-0 top-full z-30 mt-1 w-[min(28rem,calc(100vw-2rem))] rounded-md border border-border bg-surface-1 p-3 shadow-lg sm:left-0 sm:right-auto"
        >
          <div className="mb-2 flex items-center justify-between">
            <span className="text-2xs font-medium uppercase tracking-wide text-muted">
              {t('filter.type')}
            </span>
            {typeFilter.size > 0 ? (
              <button
                type="button"
                onClick={onClearTypes}
                className="text-2xs text-muted hover:text-ink-1 hover:underline"
              >
                {t('filter.clearTypes')}
              </button>
            ) : null}
          </div>

          {typeCounts.length === 0 ? (
            <p className="text-xs text-muted">
              {t('filter.noItemsToFilter')}
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
                    className={`inline-flex h-7 items-center gap-1 rounded-full border px-2 text-2xs transition-colors ${
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

          {/* #258: Template facet for web_app items.  Renders only
              when the visible set actually contains MULTIPLE
              templated web_apps so the popover stays quiet when
              there's nothing to narrow.  Since #58/#91 removed the
              Editor / Viewer / Survey template variants from the
              picker (folded into other item types or dropped),
              new orgs have only `custom` -- a one-option facet is
              noise, so we hide it.  Orgs with legacy data of mixed
              templates still see the facet to filter between them. */}
          {templateCounts.length > 1 ? (
            <>
              <div className="mt-3 flex items-center justify-between border-t border-border pt-3">
                <span className="text-2xs font-medium uppercase tracking-wide text-muted">
                  {t('filter.template')}
                </span>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                {templateCounts.map(([tpl, count]) => {
                  const active = templateFilter.has(tpl);
                  const Icon = getItemTypeIcon('web_app');
                  const accent = getItemTypeAccent('web_app');
                  return (
                    <button
                      key={tpl}
                      type="button"
                      onClick={() => onToggleTemplate(tpl)}
                      aria-pressed={active}
                      className={`inline-flex h-7 items-center gap-1 rounded-full border px-2 text-2xs transition-colors ${
                        active
                          ? 'border-accent bg-accent/10 text-accent'
                          : 'border-border bg-surface-1 text-ink-1 hover:bg-surface-2'
                      }`}
                    >
                      <Icon className={`h-3 w-3 ${active ? '' : accent}`} />
                      {t(`items.template.${tpl}`)}
                      <span className="text-muted">({count})</span>
                    </button>
                  );
                })}
              </div>
            </>
          ) : null}

          {/* #87: Owner facet. Renders only when more than one
              distinct owner appears in the visible items -- a
              single-owner list has nothing to narrow, so showing
              the section would be noise. The chip count comes from
              the visible items so a chip's number always matches a
              row in the grid. */}
          {ownerCounts && ownerCounts.length > 1 && onToggleOwner ? (
            <>
              <div className="mt-3 flex items-center justify-between border-t border-border pt-3">
                <span className="text-2xs font-medium uppercase tracking-wide text-muted">
                  {t('filter.owner')}
                </span>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                {ownerCounts.map(([userId, count]) => {
                  const active = ownerFilter?.has(userId) ?? false;
                  const label =
                    ownerLabels?.[userId] ?? `${userId.slice(0, 8)}...`;
                  return (
                    <button
                      key={userId}
                      type="button"
                      onClick={() => onToggleOwner(userId)}
                      aria-pressed={active}
                      className={`inline-flex h-7 items-center gap-1 rounded-full border px-2 text-2xs transition-colors ${
                        active
                          ? 'border-accent bg-accent/10 text-accent'
                          : 'border-border bg-surface-1 text-ink-1 hover:bg-surface-2'
                      }`}
                    >
                      {label}
                      <span className="text-muted">({count})</span>
                    </button>
                  );
                })}
              </div>
            </>
          ) : null}

          {/* Access facet. Renders only when more than one access
              level appears in the visible items -- a single-level
              list has nothing to narrow. Public first so the level
              users most often hunt for sits at the front. */}
          {accessCounts && accessCounts.length > 1 && onToggleAccess ? (
            <>
              <div className="mt-3 flex items-center justify-between border-t border-border pt-3">
                <span className="text-2xs font-medium uppercase tracking-wide text-muted">
                  {t('filter.access')}
                </span>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                {accessCounts.map(([level, count]) => {
                  const active = accessFilter?.has(level) ?? false;
                  const Icon = ACCESS_ICON[level];
                  return (
                    <button
                      key={level}
                      type="button"
                      onClick={() => onToggleAccess(level)}
                      aria-pressed={active}
                      className={`inline-flex h-7 items-center gap-1 rounded-full border px-2 text-2xs transition-colors ${
                        active
                          ? 'border-accent bg-accent/10 text-accent'
                          : 'border-border bg-surface-1 text-ink-1 hover:bg-surface-2'
                      }`}
                    >
                      <Icon className="h-3 w-3" />
                      {t(`sharing.access.${level}`)}
                      <span className="text-muted">({count})</span>
                    </button>
                  );
                })}
              </div>
            </>
          ) : null}

          <div className="mt-3 flex items-center justify-between border-t border-border pt-3">
            <span className="text-2xs font-medium uppercase tracking-wide text-muted">
              {t('filter.area')}
            </span>
            {areaActive ? (
              <button
                type="button"
                onClick={onClearAreaSearch}
                className="text-2xs text-muted hover:text-ink-1 hover:underline"
              >
                {t('filter.clearArea')}
              </button>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onToggleAreaPanel}
            aria-pressed={areaPanelOpen || areaActive}
            className={`mt-2 inline-flex h-7 items-center gap-1 rounded-full border px-2 text-2xs transition-colors ${
              areaPanelOpen || areaActive
                ? 'border-accent bg-accent/10 text-accent'
                : 'border-border bg-surface-1 text-ink-1 hover:bg-surface-2'
            }`}
          >
            <Crosshair className="h-3 w-3" />
            {areaActive ? t('filter.filteringByArea') : t('filter.filterByArea')}
          </button>

          {(typeFilter.size > 0 ||
            templateFilter.size > 0 ||
            (accessFilter?.size ?? 0) > 0 ||
            areaActive) ? (
            <button
              type="button"
              onClick={() => {
                // onClearTypes clears type, template, and access
                // together (the shared clearFilters in ItemsView), so
                // one call covers all three facets.
                if (
                  typeFilter.size > 0 ||
                  templateFilter.size > 0 ||
                  (accessFilter?.size ?? 0) > 0
                ) {
                  onClearTypes();
                }
                if (areaActive) onClearAreaSearch();
              }}
              className="mt-3 inline-flex h-7 w-full items-center justify-center gap-1 rounded-md border border-border bg-surface-1 text-2xs text-ink-1 hover:bg-surface-2"
            >
              <X className="h-3 w-3" />
              {t('filter.clearAll')}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
