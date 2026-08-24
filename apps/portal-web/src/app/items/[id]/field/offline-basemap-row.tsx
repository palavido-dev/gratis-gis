// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import { Check, Trash2 } from 'lucide-react';
import { formatBytes } from '@/lib/format-bytes';
import { useT } from '@/lib/i18n/locale-context';
import type { OfflineBasemapState } from './use-offline-basemap';

/**
 * What the prepared maps are, and whether they are on this device
 * (#71).
 *
 * Status only. It used to carry its own Download button, which was
 * a mistake: the runtime already has "Download for offline" in two
 * places (the overflow menu and this panel), and adding a third
 * control meant the obvious button still ran the old tile-by-tile
 * warm while the good path sat somewhere the user never looked.
 * Every ready area is part of that one download now, so "included
 * in the download above" is true of each row, not just the first.
 *
 * Renders nothing when the author has prepared no areas, rather than
 * an empty state explaining a feature nobody can act on.
 */

export function OfflineBasemapRow({ state }: { state: OfflineBasemapState }) {
  const t = useT();
  const ready = state.areas.filter((a) => a.current);
  // Not gated on `state.supported`. A device that cannot store an
  // archive should still be told the area exists; hiding it made a
  // capability check indistinguishable from the feature being
  // absent, which cost an afternoon.
  if (ready.length === 0) return null;

  return (
    <div className="mt-3 border-t border-border pt-3">
      <p className="mb-2 text-2xs font-medium uppercase tracking-wide text-muted">
        {ready.length === 1
          ? t('offlineBasemap.preparedMap')
          : t('offlineBasemap.preparedMaps')}
      </p>
      <ul className="space-y-1.5">
        {ready.map(({ area, current }) => {
          const stored = state.storedAreaIds.includes(area.id);
          return (
            <li
              key={area.id}
              className="flex items-center gap-2 rounded border border-border bg-surface-1 px-2.5 py-2"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-ink-0">{area.name}</p>
                <p className="text-2xs text-muted">
                  {stored ? (
                    <span className="text-success">
                      {t('offlineBasemap.onThisDevice')}
                    </span>
                  ) : current?.sizeBytes ? (
                    t('offlineBasemap.includedWithSize', {
                      size: formatBytes(current.sizeBytes),
                    })
                  ) : (
                    t('offlineBasemap.included')
                  )}
                </p>
              </div>
              {stored ? (
                <>
                  <Check className="h-4 w-4 shrink-0 text-success" />
                  <button
                    type="button"
                    onClick={() => void state.remove(area.id)}
                    title={t('offlineBasemap.removeFromDevice')}
                    aria-label={t('offlineBasemap.removeAria', {
                      name: area.name,
                    })}
                    className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded border border-border text-muted hover:bg-surface-2 hover:text-danger"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </>
              ) : null}
            </li>
          );
        })}
      </ul>
      <p className="mt-1.5 text-2xs text-muted">
        {state.supported
          ? t('offlineBasemap.explainer')
          : t('offlineBasemap.unsupported')}
      </p>
    </div>
  );
}
