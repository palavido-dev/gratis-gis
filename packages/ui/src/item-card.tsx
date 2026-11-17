// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ReactNode } from 'react';
import { getItemTypeLabel, type Item } from '@gratis-gis/shared-types';
import { EntityBadge } from './entity-badge';
import { cn } from './cn';

export interface ItemCardProps {
  item: Pick<
    Item,
    'id' | 'title' | 'description' | 'type' | 'thumbnailUrl' | 'updatedAt' | 'tags'
  >;
  /**
   * Where clicking the card should go. If omitted, the card renders as a
   * non-interactive block. An href is preferred over an onClick handler so
   * the card remains server-component-safe and accessible (right-click, open
   * in new tab, screen-reader announcement as "link" rather than "button").
   */
  href?: string;
  /**
   * Open in a new tab. Used by runnable items (web_app templates,
   * data_collection) so users keep their portal tab as a back-nav
   * anchor when they jump into the runtime. Pre-#314 the runtime
   * replaced the portal in the same tab; users had to use the
   * "Back to items" link in the runtime header to get back.
   */
  openInNewTab?: boolean;
  /**
   * Optional per-type icon rendered on the thumbnail tile when the item
   * has no custom thumbnailUrl. Callers supply this from a type-→icon
   * registry they own (keeps this package lucide-free). If omitted, the
   * card falls back to the legacy colored-initials EntityBadge tile.
   */
  fallbackIcon?: ReactNode;
  /** Classes for the coloured tile behind `fallbackIcon`. The palette
   *  for every item type lives with the icons in portal-web
   *  (getItemTypeTileClasses); this package keeps no second copy, which
   *  had drifted to 13 of the 29 types. */
  fallbackTileClassName?: string;
  /** Optional trailing slot rendered at the top of the card (above the
   *  thumbnail area): used for things like sharing indicators. */
  headerExtra?: ReactNode;
  /**
   * #91: optional click handler for the per-tag chip strip rendered
   * below the description. When supplied, each tag becomes an
   * interactive button that fires this callback with the clicked
   * tag value -- typically a parent state-setter that adds the
   * tag to a filter set. When omitted (or when item.tags is empty
   * / undefined), the chip strip is hidden.
   *
   * The card itself stays a link; the chip stops propagation on
   * click so a tag click doesn't navigate to the item detail.
   */
  onTagClick?: (tag: string) => void;
  /** #91: tags currently active in the filter, used to render the
   *  matching chips with an "active" highlight. Optional; absent
   *  set means none are highlighted. */
  activeTags?: ReadonlySet<string>;
  className?: string;
}

// Type badges are deliberately neutral (#173): the tile and
// thumbnail carry the type hue; a second colored chip per card
// added noise without adding information.
const typeBadgeColor: Record<string, string> = {};

// The card defers to `getItemTypeLabel` from shared-types so new
// item types pick up their friendly label automatically without
// a duplicated map in this package needing to be updated.  The
// previous local map drifted (missed geocoding_service, tile_layer,
// viewer, survey, theme, app_template) and the card was rendering
// the raw snake-case enum value when an item type wasn't in the
// map.  shared-types is the single source of truth.

export function ItemCard({
  item,
  href,
  openInNewTab,
  fallbackIcon,
  fallbackTileClassName,
  headerExtra,
  onTagClick,
  activeTags,
  className,
}: ItemCardProps) {
  const badgeClass = typeBadgeColor[item.type] ?? 'bg-surface-2 text-ink-1';
  // h-full lets the card fill its grid cell; consumers that use a
  // grid with `auto-rows-fr` (the items list does) then get
  // uniform-height cards regardless of how much description /
  // tag content each one carries. The footer pins to the bottom
  // via `mt-auto` inside the layout below.
  const baseClass = cn(
    'flex h-full w-full flex-col gap-2 rounded-lg border border-border bg-surface-1 p-4 text-left shadow-card transition-shadow',
    href ? 'hover:shadow-raised focus:outline-hidden focus:ring-2 focus:ring-accent/30' : '',
    className,
  );

  // Thumbnail slot priority:
  //   1. user-uploaded thumbnailUrl (full-bleed image)
  //   2. caller-supplied per-type fallbackIcon on a type-colored tile
  //   3. legacy initials badge (back-compat for callers that haven't
  //      opted into type icons yet)
  //
  // Slot is a fixed 3:2 aspect ratio (matches the auto-thumbnail
  // SVG's viewBox) so cards never crop the bottom of the title bar
  // when the column width changes.  Previous fixed-height h-32 slot
  // cropped aggressively on wider columns.
  let thumbnail: ReactNode;
  if (item.thumbnailUrl) {
    thumbnail = (
      <div className="aspect-3/2 w-full overflow-hidden rounded-md">
        <img
          src={item.thumbnailUrl}
          alt=""
          className="h-full w-full object-cover"
        />
      </div>
    );
  } else if (fallbackIcon) {
    const tileBg = fallbackTileClassName ?? 'bg-muted text-surface-0';
    thumbnail = (
      <div
        className={cn(
          'flex aspect-3/2 w-full items-center justify-center overflow-hidden rounded-md',
          tileBg,
        )}
      >
        <span className="[&_svg]:h-12 [&_svg]:w-12" aria-hidden="true">
          {fallbackIcon}
        </span>
      </div>
    );
  } else {
    thumbnail = (
      <div className="aspect-3/2 w-full overflow-hidden rounded-md">
        <EntityBadge
          label={item.title}
          seed={item.id}
          size="xl"
          rounded="md"
          className="h-full w-full text-4xl"
        />
      </div>
    );
  }

  const content = (
    <>
      {thumbnail}
      <div className="flex items-center justify-between gap-2">
        <span className={cn('rounded px-2 py-0.5 text-xs font-medium', badgeClass)}>
          {getItemTypeLabel(item.type)}
        </span>
        {headerExtra ? <span className="shrink-0">{headerExtra}</span> : null}
      </div>
      <div className="font-medium text-ink-1">{item.title}</div>
      {item.description ? (
        <div className="line-clamp-2 text-sm text-muted">{item.description}</div>
      ) : null}
      {/* #91: tag chips. Render as buttons when onTagClick is
          supplied so a click on a chip toggles the filter without
          following the card's link. Active chips render with the
          accent treatment so the user can see what's filtering.
          The chip's stopPropagation is critical -- without it the
          click bubbles to the card's <a> and navigates away. */}
      {Array.isArray(item.tags) && item.tags.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {item.tags.map((t) => {
            const active = activeTags?.has(t) ?? false;
            const chipClass = cn(
              'inline-flex h-5 items-center rounded-full border px-2 text-2xs font-medium transition-colors',
              active
                ? 'border-accent bg-accent/10 text-accent'
                : 'border-border bg-surface-2 text-muted',
              onTagClick ? 'cursor-pointer hover:bg-surface-0 hover:text-ink-1' : '',
            );
            if (!onTagClick) {
              return (
                <span key={t} className={chipClass}>
                  {t}
                </span>
              );
            }
            return (
              <button
                key={t}
                type="button"
                onClick={(e) => {
                  // Card is wrapped in an <a>; without stop+prevent
                  // the chip click would navigate before firing the
                  // tag filter.
                  e.preventDefault();
                  e.stopPropagation();
                  onTagClick(t);
                }}
                className={chipClass}
                aria-pressed={active}
              >
                {t}
              </button>
            );
          })}
        </div>
      ) : null}
      <div className="mt-auto text-xs text-muted">
        Updated {new Date(item.updatedAt).toLocaleDateString()}
      </div>
    </>
  );

  if (href) {
    return (
      <a
        href={href}
        className={baseClass}
        {...(openInNewTab
          ? { target: '_blank', rel: 'noopener noreferrer' }
          : {})}
      >
        {content}
      </a>
    );
  }
  return <div className={baseClass}>{content}</div>;
}
