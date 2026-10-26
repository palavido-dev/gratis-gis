// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import { useEffect, useMemo, useState } from 'react';
import { Check, Loader2, Map as MapIcon, Search } from 'lucide-react';
import type { Item } from '@gratis-gis/shared-types';
import { useT } from '@/lib/i18n/locale-context';

/**
 * Inline picker for the wizard's data_collection step.
 */
export function DataCollectionBuilder({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (mapId: string) => void;
}) {
  const t = useT();
  const [maps, setMaps] = useState<Item[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    void (async () => {
      try {
        const res = await fetch('/api/portal/items?type=map&lite=1', {
          signal: controller.signal,
        });
        if (!res.ok) {
          setError(
            t('dataCollectionBuilder.loadMapsFailed', {
              status: String(res.status),
            }),
          );
          return;
        }
        const rows = (await res.json()) as Item[];
        if (cancelled) return;
        rows.sort((a, b) => {
          const at = new Date(a.updatedAt ?? 0).getTime();
          const bt = new Date(b.updatedAt ?? 0).getTime();
          return bt - at;
        });
        setMaps(rows);
      } catch (err) {
        if ((err as Error)?.name === 'AbortError') return;
        setError(
          err instanceof Error
            ? err.message
            : t('dataCollectionBuilder.loadMapsFailedGeneric'),
        );
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [t]);

  const filtered = useMemo(() => {
    if (!maps) return null;
    const term = q.trim().toLowerCase();
    if (term.length === 0) return maps;
    return maps.filter((m) => {
      const title = (m.title ?? '').toLowerCase();
      const d = (m.description ?? '').toLowerCase();
      return title.includes(term) || d.includes(term);
    });
  }, [maps, q]);

  return (
    <section className="space-y-3 rounded-md border border-border bg-surface-1 p-4">
      <header className="flex items-center gap-2">
        <MapIcon className="h-4 w-4 text-accent" />
        <h2 className="text-sm font-semibold">
          {t('dataCollectionBuilder.title')}
        </h2>
      </header>
      <p className="text-xs text-muted">{t('dataCollectionBuilder.intro')}</p>

      <label className="flex items-center gap-2 rounded-md border border-border bg-surface-0 px-2 focus-within:border-accent">
        <Search className="h-4 w-4 text-muted" />
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t('dataCollectionBuilder.searchPlaceholder')}
          className="h-9 flex-1 bg-transparent text-sm text-ink-0 outline-hidden placeholder:text-muted"
        />
      </label>

      {error ? (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      ) : null}

      {!maps ? (
        <div className="flex items-center gap-2 text-xs text-muted">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          {t('dataCollectionBuilder.loadingMaps')}
        </div>
      ) : filtered && filtered.length === 0 ? (
        <p className="rounded-md border border-dashed border-border bg-surface-0 px-3 py-4 text-center text-xs text-muted">
          {q.trim().length > 0
            ? t('dataCollectionBuilder.noSearchMatch')
            : t('dataCollectionBuilder.noMapsYet')}
        </p>
      ) : (
        <ul className="max-h-72 divide-y divide-border overflow-y-auto rounded-md border border-border bg-surface-0">
          {(filtered ?? []).map((m) => {
            const picked = value === m.id;
            return (
              <li key={m.id}>
                <button
                  type="button"
                  onClick={() => onChange(m.id)}
                  className={`flex w-full items-start gap-3 px-3 py-2 text-left transition-colors hover:bg-surface-2 ${
                    picked ? 'bg-accent/10' : ''
                  }`}
                >
                  <span
                    className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded border ${
                      picked
                        ? 'border-accent bg-accent text-accent-foreground'
                        : 'border-border bg-surface-1'
                    }`}
                  >
                    {picked ? <Check className="h-3 w-3" /> : null}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-ink-0">
                      {m.title}
                    </span>
                    {m.description ? (
                      <span className="mt-0.5 block truncate text-xs text-muted">
                        {m.description}
                      </span>
                    ) : null}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
