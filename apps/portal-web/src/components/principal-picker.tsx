// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Search, Loader2 } from 'lucide-react';
import { EntityBadge } from '@gratis-gis/ui';
import { useT } from '@/lib/i18n/locale-context';

export interface PrincipalOption {
  id: string;
  title: string;
  /** Small secondary text, e.g. username for a user, description for a group. */
  subtitle?: string | null;
  imageUrl?: string | null;
  /** Optional flag so the consumer can grey-out already-shared rows. */
  disabled?: boolean;
  /** Reason shown in a tooltip when disabled. */
  disabledReason?: string;
}

interface Props {
  placeholder: string;
  /**
   * Called with each search query (including ''). May return sync or async.
   * Consumer controls filtering, fetching, debouncing of the underlying
   * data source; the picker only throttles user keystrokes.
   */
  search: (q: string) => Promise<PrincipalOption[]> | PrincipalOption[];
  onPick: (option: PrincipalOption) => void;
  /** Shown when there are zero matches and the query is non-empty. */
  emptyMessage?: string;
  /** Shown when there are zero options and the query is empty. */
  emptyInitialMessage?: string;
  className?: string;
}

/**
 * Searchable combobox for sharing targets. Designed to scale past a few
 * dozen rows (the plain <select> we had before hits a wall around there)
 * and to work identically for groups and users so the sharing UI stays
 * consistent.
 *
 * Debounce is deliberate rather than instant: 150ms keeps the API happy
 * on a fast typist and still feels live on a slow one. Keyboard nav
 * follows the combobox pattern from the WAI-ARIA authoring practices
 * (arrow up/down, Enter to pick, Escape to close).
 */
export function PrincipalPicker({
  placeholder,
  search,
  onPick,
  emptyMessage,
  emptyInitialMessage,
  className = '',
}: Props) {
  const t = useT();
  const resolvedEmptyMessage = emptyMessage ?? t('picker.noMatches');
  const resolvedEmptyInitialMessage =
    emptyInitialMessage ?? t('picker.startTyping');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<PrincipalOption[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Debounced search. Resets highlight to the top of the list on every
  // new result set so Enter always picks something sensible.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const handle = setTimeout(async () => {
      try {
        const out = await search(query);
        if (cancelled) return;
        setResults(out);
        setHighlight(0);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [query, search]);

  // Close on outside click and Escape.
  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  const activeResults = useMemo(
    () => results.filter((r) => !r.disabled),
    [results],
  );

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setHighlight((h) => Math.min(h + 1, activeResults.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const pick = activeResults[highlight];
      if (pick) {
        onPick(pick);
        setQuery('');
        setOpen(false);
      }
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  }

  return (
    <div ref={rootRef} className={`relative ${className}`}>
      <label className="relative block">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
        <input
          ref={inputRef}
          type="text"
          value={query}
          placeholder={placeholder}
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onKeyDown={onKeyDown}
          role="combobox"
          aria-expanded={open}
          aria-autocomplete="list"
          className="h-9 w-full rounded-md border border-border bg-surface-1 pl-9 pr-8 text-sm focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
        />
        {loading ? (
          <Loader2 className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-muted" />
        ) : null}
      </label>

      {open ? (
        <div
          role="listbox"
          className="absolute left-0 right-0 top-full z-20 mt-1 max-h-72 overflow-y-auto rounded-md border border-border bg-surface-1 shadow-raised"
        >
          {results.length === 0 ? (
            <div className="px-3 py-2 text-xs text-muted">
              {query.length === 0
                ? resolvedEmptyInitialMessage
                : resolvedEmptyMessage}
            </div>
          ) : (
            results.map((r, i) => {
              // Highlight index tracks activeResults only, but the list
              // renders every result (disabled included) so the user can
              // see why a row is unavailable. Compute the match.
              const activeIndex = activeResults.indexOf(r);
              const isHighlighted = activeIndex === highlight && !r.disabled;
              return (
                <button
                  key={`${r.id}-${i}`}
                  type="button"
                  role="option"
                  aria-selected={isHighlighted}
                  disabled={r.disabled}
                  title={r.disabled ? r.disabledReason : undefined}
                  onMouseEnter={() => !r.disabled && setHighlight(activeIndex)}
                  onClick={() => {
                    if (r.disabled) return;
                    onPick(r);
                    setQuery('');
                    setOpen(false);
                  }}
                  className={`flex w-full items-center gap-3 px-3 py-2 text-left text-sm transition-colors ${
                    isHighlighted ? 'bg-accent/10' : 'hover:bg-surface-2'
                  } ${r.disabled ? 'opacity-50' : ''}`}
                >
                  <EntityBadge
                    label={r.title}
                    seed={r.id}
                    imageUrl={r.imageUrl ?? null}
                    size="sm"
                    rounded="md"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-ink-1">{r.title}</div>
                    {r.subtitle ? (
                      <div className="truncate text-xs text-muted">
                        {r.subtitle}
                      </div>
                    ) : null}
                  </div>
                  {r.disabled ? (
                    <span className="text-xs text-muted">
                      {r.disabledReason ?? t('picker.unavailable')}
                    </span>
                  ) : null}
                </button>
              );
            })
          )}
        </div>
      ) : null}
    </div>
  );
}
