// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

/**
 * App template detail view.  Renders a read-only summary of the
 * stored CustomAppData blueprint (theme + page/widget counts) and
 * exposes a "Use this template" CTA that drops the user into the
 * new-item wizard with this template pre-selected.
 *
 * Editing the blueprint happens by stamping an app FROM the
 * template and editing that app, then optionally re-saving as a
 * template — keeps the surface area small and avoids a separate
 * "edit a template" designer for the v1 cut.  Admins can still
 * delete / rename / re-share the item like any other.
 */
import { useState } from 'react';
import Link from 'next/link';
import { Wand2 } from 'lucide-react';
import type { CustomAppData } from '@gratis-gis/shared-types';

interface Props {
  itemId: string;
  blueprint: CustomAppData;
  /** Hint marking this item as a built-in starter, if any. */
  seedKind: string | null;
}

export function AppTemplateDetail({ itemId, blueprint, seedKind }: Props) {
  const [busy, setBusy] = useState(false);

  const pageCount = blueprint.pages?.length ?? 0;
  const widgetCount =
    blueprint.pages?.reduce(
      (n, p) => n + countWidgetsDeep(p.widgets ?? []),
      0,
    ) ?? 0;
  const themeId = blueprint.themePresetId ?? 'default';

  return (
    <section className="mb-6 rounded-lg border border-border bg-surface-1 p-5 shadow-card">
      <header className="mb-4 flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-warn/10 text-warn">
          <Wand2 className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-xs text-muted">Web app template</p>
          <h2 className="text-base font-semibold text-ink-0">
            Reusable Custom Web App blueprint
          </h2>
          <p className="mt-0.5 text-sm text-muted">
            Pick this template in the new-item wizard to stamp a
            fresh Custom Web App from it; the new app gets its own
            widget ids so changes don&apos;t affect this template.
          </p>
        </div>
      </header>

      <dl className="mb-4 grid grid-cols-2 gap-x-6 gap-y-2 text-xs sm:grid-cols-4">
        <div>
          <dt className="text-muted">Theme</dt>
          <dd className="font-medium text-ink-0">{themeId}</dd>
        </div>
        <div>
          <dt className="text-muted">Pages</dt>
          <dd className="font-medium text-ink-0">{pageCount}</dd>
        </div>
        <div>
          <dt className="text-muted">Widgets</dt>
          <dd className="font-medium text-ink-0">{widgetCount}</dd>
        </div>
        <div>
          <dt className="text-muted">Origin</dt>
          <dd className="font-medium text-ink-0">
            {seedKind ? `built-in: ${seedKind}` : 'user-saved'}
          </dd>
        </div>
      </dl>

      <div className="flex flex-wrap gap-2">
        <Link
          href={`/items/new?type=custom&template=${itemId}`}
          onClick={() => setBusy(true)}
          className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-ink hover:bg-accent/90"
        >
          {busy ? 'Loading...' : 'Use this template'}
        </Link>
        <Link
          href={`/items/${itemId}/raw`}
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface-1 px-3 py-1.5 text-sm font-medium text-ink-1 hover:bg-surface-2"
        >
          View raw JSON
        </Link>
      </div>
    </section>
  );
}

/**
 * Count every widget across nested container children so the
 * summary number reflects the real fixture size (an app-bar
 * with five tool buttons inside reads as six widgets, not one).
 */
function countWidgetsDeep(
  widgets: ReadonlyArray<{ config?: unknown }>,
): number {
  let n = 0;
  for (const w of widgets) {
    n += 1;
    const cfg = w.config as { widgets?: ReadonlyArray<{ config?: unknown }> };
    if (Array.isArray(cfg?.widgets)) {
      n += countWidgetsDeep(cfg.widgets);
    }
  }
  return n;
}
