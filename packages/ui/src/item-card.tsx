import type { ReactNode } from 'react';
import type { Item } from '@gratis-gis/shared-types';
import { EntityBadge } from './entity-badge';
import { cn } from './cn';

export interface ItemCardProps {
  item: Pick<Item, 'id' | 'title' | 'description' | 'type' | 'thumbnailUrl' | 'updatedAt'>;
  /**
   * Where clicking the card should go. If omitted, the card renders as a
   * non-interactive block. An href is preferred over an onClick handler so
   * the card remains server-component-safe and accessible (right-click, open
   * in new tab, screen-reader announcement as "link" rather than "button").
   */
  href?: string;
  /**
   * Optional per-type icon rendered on the thumbnail tile when the item
   * has no custom thumbnailUrl. Callers supply this from a type-â†’icon
   * registry they own (keeps this package lucide-free). If omitted, the
   * card falls back to the legacy colored-initials EntityBadge tile.
   */
  fallbackIcon?: ReactNode;
  /** Optional trailing slot rendered at the top of the card (above the
   *  thumbnail area): used for things like sharing indicators. */
  headerExtra?: ReactNode;
  className?: string;
}

/**
 * Per-type tile background colors. Kept in the ui package so every
 * render shares the same palette; the icon itself is injected by the
 * caller via `fallbackIcon` so this package stays free of lucide.
 */
const typeTileBg: Record<string, string> = {
  map: 'bg-emerald-500/90 text-white',
  data_layer: 'bg-sky-500/90 text-white',
  arcgis_service: 'bg-cyan-600/90 text-white',
  form: 'bg-violet-500/90 text-white',
  form_submission_collection: 'bg-violet-400/90 text-white',
  web_app: 'bg-amber-500/90 text-white',
  report_template: 'bg-rose-500/90 text-white',
  dashboard: 'bg-indigo-500/90 text-white',
  file: 'bg-slate-500/90 text-white',
  layer_package: 'bg-emerald-600/90 text-white',
  notebook: 'bg-fuchsia-500/90 text-white',
  tool: 'bg-teal-500/90 text-white',
  widget_package: 'bg-teal-600/90 text-white',
};

const typeBadgeColor: Record<string, string> = {
  map: 'bg-emerald-100 text-emerald-800',
  data_layer: 'bg-sky-100 text-sky-800',
  arcgis_service: 'bg-cyan-100 text-cyan-800',
  form: 'bg-violet-100 text-violet-800',
  form_submission_collection: 'bg-violet-100 text-violet-800',
  web_app: 'bg-amber-100 text-amber-800',
  report_template: 'bg-rose-100 text-rose-800',
  dashboard: 'bg-indigo-100 text-indigo-800',
  file: 'bg-slate-100 text-slate-800',
  layer_package: 'bg-emerald-100 text-emerald-800',
  notebook: 'bg-fuchsia-100 text-fuchsia-800',
  tool: 'bg-teal-100 text-teal-800',
  widget_package: 'bg-teal-100 text-teal-800',
};

export function ItemCard({
  item,
  href,
  fallbackIcon,
  headerExtra,
  className,
}: ItemCardProps) {
  const badgeClass = typeBadgeColor[item.type] ?? 'bg-slate-100 text-slate-800';
  const baseClass = cn(
    'flex w-full flex-col gap-2 rounded-lg border border-border bg-surface-1 p-4 text-left shadow-card transition-shadow',
    href ? 'hover:shadow-raised focus:outline-none focus:ring-2 focus:ring-accent/30' : '',
    className,
  );

  // Thumbnail slot priority:
  //   1. user-uploaded thumbnailUrl (full-bleed image)
  //   2. caller-supplied per-type fallbackIcon on a type-colored tile
  //   3. legacy initials badge (back-compat for callers that haven't
  //      opted into type icons yet)
  let thumbnail: ReactNode;
  if (item.thumbnailUrl) {
    thumbnail = (
      <img
        src={item.thumbnailUrl}
        alt=""
        className="h-32 w-full rounded-md object-cover"
      />
    );
  } else if (fallbackIcon) {
    const tileBg = typeTileBg[item.type] ?? 'bg-slate-500/90 text-white';
    thumbnail = (
      <div
        className={cn(
          'flex h-32 w-full items-center justify-center overflow-hidden rounded-md',
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
      <div className="h-32 w-full overflow-hidden rounded-md">
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
          {item.type}
        </span>
        {headerExtra ? <span className="shrink-0">{headerExtra}</span> : null}
      </div>
      <div className="font-medium text-ink-1">{item.title}</div>
      {item.description ? (
        <div className="line-clamp-2 text-sm text-muted">{item.description}</div>
      ) : null}
      <div className="text-xs text-muted">
        Updated {new Date(item.updatedAt).toLocaleDateString()}
      </div>
    </>
  );

  if (href) {
    return (
      <a href={href} className={baseClass}>
        {content}
      </a>
    );
  }
  return <div className={baseClass}>{content}</div>;
}
