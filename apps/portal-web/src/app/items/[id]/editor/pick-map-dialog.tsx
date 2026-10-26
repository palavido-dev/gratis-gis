// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, Map as MapIcon, Search } from 'lucide-react';
import type { Item } from '@gratis-gis/shared-types';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/dialog';

interface Props {
  open: boolean;
  onClose: () => void;
  onPick: (map: Item) => void;
  /** Title for the dialog. Lets reusing components customize. */
  title?: string;
  /** Optional helper text under the title. */
  subtitle?: string;
}

/**
 * Single-step picker for map items. Used by:
 *   - the Editor's "Reference map" picker (sets mapId for basemap +
 *     reference context)
 *   - the "Add from map" bulk-import dialog (which uses this as its
 *     first step before showing the sublayer multi-select)
 *
 * Same lite=1 + AbortController fetch pattern as add-target-dialog
 * and add-layer-dialog. Strips heavy data JSONB so the picker stays
 * snappy even with a hundred maps in the org.
 */
export function PickMapDialog({
  open,
  onClose,
  onPick,
  title = 'Pick a map',
  subtitle = 'The editor inherits this map\'s basemap, viewport, and reference layers.',
}: Props) {
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState('');
  const abortRef = useRef<AbortController | null>(null);

  const reset = useCallback(() => {
    setItems([]);
    setQ('');
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    const handle = setTimeout(async () => {
      try {
        const qs = new URLSearchParams({ type: 'map', lite: '1' });
        const trimmed = q.trim();
        if (trimmed) qs.set('q', trimmed);
        const res = await fetch(`/api/portal/items?${qs}`, {
          signal: controller.signal,
        });
        if (!res.ok) {
          if (!cancelled) setItems([]);
          return;
        }
        const list = (await res.json()) as Item[];
        if (cancelled) return;
        list.sort((a, b) => {
          const at = new Date(a.updatedAt ?? 0).getTime();
          const bt = new Date(b.updatedAt ?? 0).getTime();
          return bt - at;
        });
        setItems(list);
      } catch (err) {
        if ((err as Error)?.name === 'AbortError') return;
        // eslint-disable-next-line no-console
        console.warn('[editor:pick-map] fetch failed', err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 150);
    return () => {
      cancelled = true;
      controller.abort();
      clearTimeout(handle);
    };
  }, [open, q]);

  function handleClose() {
    reset();
    onClose();
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) handleClose();
      }}
    >
      <DialogContent
        size="lg"
        className="flex max-h-[80vh] flex-col overflow-hidden p-0"
        hideCloseButton={false}
      >
        <div className="border-b border-border px-5 py-4 pr-12">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className="mt-0.5">{subtitle}</DialogDescription>
        </div>
        <div className="border-b border-border px-5 py-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-2.5 h-3.5 w-3.5 text-muted" />
            <input
              type="text"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search maps..."
              className="h-9 w-full rounded-md border border-border bg-surface-1 pl-7 pr-2 text-sm focus:border-accent focus:outline-hidden focus:ring-2 focus:ring-accent/30"
            />
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          {loading && items.length === 0 ? (
            <div className="flex items-center justify-center px-4 py-8 text-sm text-muted">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Loading...
            </div>
          ) : items.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-muted">
              No maps match &quot;{q}&quot;.
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {items.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    onClick={() => {
                      onPick(item);
                      handleClose();
                    }}
                    className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-surface-2"
                  >
                    <MapIcon className="h-4 w-4 shrink-0 text-success" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-ink-0">
                        {item.title}
                      </div>
                      {item.description ? (
                        <div className="truncate text-xs text-muted">
                          {item.description}
                        </div>
                      ) : null}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <DialogFooter>
          <button
            type="button"
            onClick={handleClose}
            className="rounded-md border border-border bg-surface-1 px-3 py-1.5 text-sm hover:bg-surface-2"
          >
            Cancel
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
