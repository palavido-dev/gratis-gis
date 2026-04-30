'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  ClipboardList,
  ExternalLink,
  Loader2,
  Map as MapIcon,
} from 'lucide-react';
import type { DataCollectionData, Item } from '@gratis-gis/shared-types';

/**
 * Detail body for a `data_collection` item (Slice 1, #141).
 *
 * Slice 1 surface is intentionally small: confirm the deployment
 * exists, show which map it deploys, and signpost the field-mode
 * runtime + form-binding UI as future slices. The data_collection's
 * actual value (collectors opening it on a phone) lands in Slice 2
 * (#25 follow-on) which adds the runtime route and the auto-form
 * generator wiring on top of the schema-to-form helper that ships
 * with this slice.
 *
 * Behaviour today:
 *   - Render the bound map's title and link to its detail page.
 *   - Show a stub "Open in field mode" affordance that links to the
 *     planned `/items/<id>/field` route. The route 404s until
 *     Slice 2; the link sits ghosted with a tooltip so authors see
 *     the planned destination without expecting it to work.
 *   - When form bindings exist (Slice 2+ feature), surface them
 *     as a list. Until then this section stays hidden.
 *
 * Form bindings, offline configuration, and field-mode UI presets
 * land in later slices and add their own sections to this body.
 */
export function DataCollectionDetail({
  itemId,
  initial,
}: {
  itemId: string;
  initial: DataCollectionData;
}) {
  const [mapItem, setMapItem] = useState<Item | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/portal/items/${initial.mapId}`);
        if (!res.ok) {
          if (!cancelled) setMapItem(null);
          return;
        }
        const item = (await res.json()) as Item;
        if (!cancelled) setMapItem(item);
      } catch {
        if (!cancelled) setMapItem(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [initial.mapId]);

  const bindings = Object.entries(initial.formBindings ?? {});

  return (
    <div className="space-y-4">
      <header className="flex items-start gap-3 rounded-md border border-border bg-surface-1 p-4">
        <span
          aria-hidden="true"
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-violet-700/90 text-white"
        >
          <ClipboardList className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-ink-0">
            Field deployment
          </h2>
          <p className="mt-0.5 text-xs text-muted">
            Field collectors open this on a phone or tablet to add and
            edit features. Forms come from each editable layer's schema
            by default; bind a custom form per layer below to override.
          </p>
        </div>
      </header>

      <section className="rounded-md border border-border bg-surface-1 p-4">
        <h3 className="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted">
          <MapIcon className="h-3.5 w-3.5" />
          Deployed map
        </h3>
        {mapItem === undefined ? (
          <div className="flex items-center gap-2 text-xs text-muted">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Loading map...
          </div>
        ) : mapItem === null ? (
          <p className="text-xs text-danger">
            The bound map is missing or you don&apos;t have access to it.
          </p>
        ) : (
          <Link
            href={`/items/${mapItem.id}`}
            className="inline-flex items-center gap-2 text-sm text-accent hover:underline"
          >
            {mapItem.title || 'Untitled map'}
            <ExternalLink className="h-3.5 w-3.5" />
          </Link>
        )}
      </section>

      {bindings.length > 0 ? (
        <section className="rounded-md border border-border bg-surface-1 p-4">
          <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">
            Custom form bindings
          </h3>
          <ul className="space-y-1 text-sm">
            {bindings.map(([layerKey, binding]) => (
              <li key={layerKey} className="text-ink-1">
                <span className="font-mono text-xs text-muted">{layerKey}</span>
                <span className="mx-2 text-muted">&rarr;</span>
                <Link
                  href={`/items/${binding.formItemId}`}
                  className="text-accent hover:underline"
                >
                  {binding.formItemId}
                </Link>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-[11px] text-muted">
            Layers without a binding fall through to a form drawn from
            the layer&apos;s field schema.
          </p>
        </section>
      ) : null}

      <section className="rounded-md border border-border bg-surface-1 p-4">
        <h3 className="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted">
          <ClipboardList className="h-3.5 w-3.5" />
          Open in the field
        </h3>
        <p className="mb-3 text-xs text-muted">
          Tap features to edit them, tap empty space to add new ones.
          Forms come from each editable layer&apos;s schema unless a
          custom form is bound above.
        </p>
        <Link
          href={`/items/${itemId}/field`}
          className="inline-flex h-9 items-center gap-2 rounded-md bg-accent px-3 text-sm font-medium text-accent-foreground hover:opacity-90"
        >
          Open field-mode runtime
        </Link>
        <p className="mt-2 text-[11px] text-muted">
          Offline collection (download an area, queue edits, sync) lands
          in a follow-up slice.
        </p>
      </section>
    </div>
  );
}
