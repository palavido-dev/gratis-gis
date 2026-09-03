// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ChevronDown, Loader2, Map as MapIcon, Plus } from 'lucide-react';

import { useT } from '@/lib/i18n/locale-context';

/**
 * #185 "Add to map" on layer-ish item pages. Two paths:
 *
 *   - New map: opens the scratch builder (#187) with this item
 *     pre-added via ?add=. Nothing is created until the user
 *     saves, so it doubles as "just look at this on a map".
 *   - An existing map: pick from the maps you can see; opens that
 *     map's builder with ?add= and the builder appends the layers
 *     (saving is still an explicit step there).
 *
 * The heavy lifting (turning an item into map layers) lives in
 * portal-item-layers.ts and runs inside the builder, so this
 * component is just navigation.
 *
 * `layerKey` narrows the add to one sublayer of a multi-layer
 * data_layer (the Data tab renders one of these per row, `compact`,
 * next to Browse and Analyze). The builder reads it as `&layer=`.
 */
export function AddToMapButton({
  itemId,
  layerKey,
  compact = false,
}: {
  itemId: string;
  layerKey?: string;
  compact?: boolean;
}) {
  const router = useRouter();
  const t = useT();
  const target = (path: string) =>
    `${path}${path.includes('?') ? '&' : '?'}add=${itemId}${
      layerKey !== undefined ? `&layer=${encodeURIComponent(layerKey)}` : ''
    }`;
  const [open, setOpen] = useState(false);
  const [maps, setMaps] = useState<Array<{ id: string; title: string }> | null>(
    null,
  );
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (ref.current && e.target instanceof Node && !ref.current.contains(e.target)) {
        setOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Lazy-load the map list the first time the menu opens.
  useEffect(() => {
    if (!open || maps !== null) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/portal/items?type=map&lite=1');
        if (!res.ok || cancelled) return;
        const rows = (await res.json()) as Array<{
          id: string;
          title: string;
          updatedAt?: string;
        }>;
        rows.sort(
          (a, b) =>
            new Date(b.updatedAt ?? 0).getTime() -
            new Date(a.updatedAt ?? 0).getTime(),
        );
        if (!cancelled) setMaps(rows.map((r) => ({ id: r.id, title: r.title })));
      } catch {
        if (!cancelled) setMaps([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, maps]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={layerKey !== undefined ? t('itemMenu.addLayerToMapTitle') : undefined}
        className={
          compact
            ? 'inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-surface-1 px-2 text-xs font-medium text-ink-1 hover:bg-surface-2'
            : 'inline-flex h-9 items-center gap-1.5 rounded-md border border-border bg-surface-1 px-3 text-sm font-medium text-ink-1 shadow-card hover:bg-surface-2'
        }
      >
        <MapIcon className={compact ? 'h-3.5 w-3.5' : 'h-4 w-4'} />
        {t('itemMenu.addToMap')}
        <ChevronDown className={compact ? 'h-3 w-3 text-muted' : 'h-3.5 w-3.5 text-muted'} />
      </button>
      {open ? (
        <div
          role="menu"
          className="absolute right-0 top-10 z-30 w-64 overflow-hidden rounded-md border border-border bg-surface-1 text-sm shadow-overlay"
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => router.push(target('/maps/new'))}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-ink-0 hover:bg-surface-2"
          >
            <Plus className="h-4 w-4 text-accent" />
            New map
          </button>
          <div className="border-t border-border bg-surface-2 px-3 py-1.5 text-2xs font-semibold uppercase tracking-wide text-muted">
            An existing map
          </div>
          {maps === null ? (
            <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Loading maps...
            </div>
          ) : maps.length === 0 ? (
            <div className="px-3 py-2 text-xs italic text-muted">
              No maps yet
            </div>
          ) : (
            <ul className="max-h-64 overflow-auto py-1">
              {maps.map((m) => (
                <li key={m.id}>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() =>
                      router.push(target(`/items/${m.id}?view=configure`))
                    }
                    className="w-full truncate px-3 py-1.5 text-left text-ink-1 hover:bg-surface-2"
                  >
                    {m.title}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
