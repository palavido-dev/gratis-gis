// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import { Check, Download, Loader2, Trash2 } from 'lucide-react';
import type { OfflineBasemapState } from './use-offline-basemap';

/**
 * The offline-map control in the field runtime's layer panel (#71).
 *
 * Deliberately one row. A collector standing in a parking lot about
 * to lose signal wants a size, a button, and a tick, and every extra
 * control is one more thing to get wrong with gloves on.
 *
 * Renders nothing at all when the author has prepared no areas,
 * rather than an empty state explaining a feature the collector
 * cannot act on.
 */

function formatBytes(n: number): string {
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function OfflineBasemapRow({ state }: { state: OfflineBasemapState }) {
  const ready = state.areas.filter((a) => a.current);
  if (!state.supported || ready.length === 0) return null;

  return (
    <div className="border-t border-border pt-3">
      <p className="mb-2 text-2xs font-medium uppercase tracking-wide text-muted">
        Map for offline use
      </p>
      <ul className="space-y-1.5">
        {ready.map(({ area, current }) => {
          const stored = state.storedAreaId === area.id;
          const busy = state.downloading?.areaId === area.id;
          const pct =
            busy && state.downloading?.total
              ? Math.round(
                  (state.downloading.received / state.downloading.total) * 100,
                )
              : null;
          return (
            <li
              key={area.id}
              className="flex items-center gap-2 rounded border border-border bg-surface-1 px-2.5 py-2"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-ink-0">{area.name}</p>
                <p className="text-2xs text-muted">
                  {busy ? (
                    pct === null ? (
                      `Downloading, ${formatBytes(state.downloading?.received ?? 0)} so far`
                    ) : (
                      `Downloading, ${pct}%`
                    )
                  ) : stored ? (
                    <span className="text-success">
                      On this device
                      {state.storedBytes
                        ? `, ${formatBytes(state.storedBytes)}`
                        : ''}
                    </span>
                  ) : current?.sizeBytes ? (
                    formatBytes(current.sizeBytes)
                  ) : (
                    'Ready to download'
                  )}
                </p>
              </div>
              {busy ? (
                <Loader2 className="h-4 w-4 shrink-0 animate-spin text-accent" />
              ) : stored ? (
                <>
                  <Check className="h-4 w-4 shrink-0 text-success" />
                  <button
                    type="button"
                    onClick={() => void state.remove(area.id)}
                    title="Remove from this device"
                    aria-label={`Remove ${area.name} from this device`}
                    className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded border border-border text-muted hover:bg-surface-2 hover:text-danger"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() =>
                    current && void state.download(area.id, current.id)
                  }
                  disabled={!!state.downloading}
                  className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md bg-accent px-2.5 text-xs font-medium text-accent-foreground hover:opacity-90 disabled:opacity-50"
                >
                  <Download className="h-3.5 w-3.5" />
                  Download
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {state.error ? (
        <p className="mt-1.5 text-2xs text-danger">{state.error}</p>
      ) : null}
      <p className="mt-1.5 text-2xs text-muted">
        Downloading the map once means it draws with no signal at all,
        and it is the same file for everyone on the crew.
      </p>
    </div>
  );
}
