// SPDX-License-Identifier: AGPL-3.0-or-later
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
import { FieldHandoff } from '@/components/field-handoff';
import { OfflineAreasPanel } from './offline-areas-panel';

/**
 * Detail body for a `data_collection` item (#141).
 *
 * Sections, in the order an author reads them: which map is
 * deployed, which layers have custom forms bound, how to get the
 * runtime onto a phone, and which areas are prepared for offline
 * use.
 *
 * This docstring used to describe a Slice 1 surface where the field
 * route "404s until Slice 2" and the link "sits ghosted". Both the
 * runtime and offline collection have shipped since; the note
 * outlived them and was describing a page nobody had seen for
 * months.
 */
export function DataCollectionDetail({
  itemId,
  initial,
  canEdit,
}: {
  itemId: string;
  initial: DataCollectionData;
  canEdit: boolean;
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
          <p className="mt-2 text-2xs text-muted">
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
        {/* The button above only helps on the device you are already
            on, and field collection is the one thing nobody wants on
            a desktop. */}
        <div className="mt-4 border-t border-border pt-4">
          <FieldHandoff path={`/items/${itemId}/field`} />
        </div>
      </section>

      <OfflineAreasPanel itemId={itemId} data={initial} canEdit={canEdit} />
    </div>
  );
}
