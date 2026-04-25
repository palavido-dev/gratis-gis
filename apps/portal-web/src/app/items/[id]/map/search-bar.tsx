'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, MapPin, Search, Tag, X } from 'lucide-react';
import type { MapLayer } from '@gratis-gis/shared-types';
import {
  geocode,
  searchArcgisLayers,
  searchLayers,
  type SearchResult,
} from './search-sources';

interface Props {
  layers: MapLayer[];
  featuresByLayer: Record<string, GeoJSON.FeatureCollection | null>;
  geocodingEnabled: boolean;
  /**
   * Called when the user picks a result. The canvas owns the flyTo +
   * highlight logic; we just hand off the target.
   */
  onPick: (result: SearchResult) => void;
}

/**
 * Floating search bar pinned to the top-left of the map canvas.
 *
 * Two sources are queried on every keystroke (debounced for the
 * geocoder; local for layer attributes):
 *
 *   - Layer attribute search is synchronous, fast, and scoped to the
 *     fields each layer's owner flagged as searchable.
 *   - Geocoding hits Nominatim. Requests are cancelled with
 *     AbortController when the query changes so a slow network can't
 *     clobber the latest results.
 *
 * Keyboard support follows the WAI-ARIA combobox pattern: â†‘ / â†“ move
 * the highlight, Enter picks, Escape closes.
 */
export function SearchBar({
  layers,
  featuresByLayer,
  geocodingEnabled,
  onPick,
}: Props) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [geocodeResults, setGeocodeResults] = useState<SearchResult[]>([]);
  const [geocodeLoading, setGeocodeLoading] = useState(false);
  const [arcgisResults, setArcgisResults] = useState<SearchResult[]>([]);
  const [arcgisLoading, setArcgisLoading] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const layerResults = useMemo(
    () => (query.trim() ? searchLayers(query, layers, featuresByLayer) : []),
    [query, layers, featuresByLayer],
  );

  const anyLayerSearchable = layers.some(
    (l) => l.search?.enabled && l.search.fields.length > 0,
  );

  // Debounced geocoder. Don't run for super-short queries — every
  // keystroke triggers a network request and Nominatim asks nicely
  // that we keep volume low.
  useEffect(() => {
    if (!geocodingEnabled) {
      setGeocodeResults([]);
      return;
    }
    const q = query.trim();
    if (q.length < 3) {
      setGeocodeResults([]);
      return;
    }
    const controller = new AbortController();
    setGeocodeLoading(true);
    const handle = setTimeout(() => {
      geocode(q, controller.signal)
        .then((rows) => setGeocodeResults(rows))
        .finally(() => setGeocodeLoading(false));
    }, 350);
    return () => {
      controller.abort();
      clearTimeout(handle);
    };
  }, [query, geocodingEnabled]);

  // Debounced ArcGIS REST attribute search. Runs only when at least
  // one visible layer is arcgis-rest and searchable; otherwise we
  // fall through to the fast local-cache path alone. Short queries
  // are skipped so a parcels service with a million rows doesn't
  // get hammered by every keystroke.
  useEffect(() => {
    const q = query.trim();
    const arcgisLayers = layers.filter(
      (l) =>
        l.source.kind === 'arcgis-rest' &&
        l.search?.enabled &&
        (l.search?.fields?.length ?? 0) > 0,
    );
    if (q.length < 2 || arcgisLayers.length === 0) {
      setArcgisResults([]);
      return;
    }
    const controller = new AbortController();
    setArcgisLoading(true);
    const handle = setTimeout(() => {
      searchArcgisLayers(q, arcgisLayers, controller.signal)
        .then((rows) => setArcgisResults(rows))
        .finally(() => setArcgisLoading(false));
    }, 300);
    return () => {
      controller.abort();
      clearTimeout(handle);
    };
  }, [query, layers]);

  const all: SearchResult[] = useMemo(
    () => [...layerResults, ...arcgisResults, ...geocodeResults],
    [layerResults, arcgisResults, geocodeResults],
  );

  useEffect(() => {
    setHighlight(0);
  }, [all.length]);

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

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, all.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const pick = all[highlight];
      if (pick) {
        onPick(pick);
        setOpen(false);
      }
    } else if (e.key === 'Escape') {
      setOpen(false);
      inputRef.current?.blur();
    }
  }

  return (
    <div
      ref={rootRef}
      className="absolute left-4 top-4 z-10 w-80 overflow-hidden rounded-lg border border-border bg-surface-1/95 shadow-raised backdrop-blur"
    >
      <label className="relative block">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
        <input
          ref={inputRef}
          type="text"
          value={query}
          placeholder={
            geocodingEnabled
              ? anyLayerSearchable
                ? 'Search address or attributes...'
                : 'Search address...'
              : anyLayerSearchable
                ? 'Search layer attributes...'
                : 'Search is unconfigured for this map'
          }
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onKeyDown={onKeyDown}
          role="combobox"
          aria-expanded={open}
          aria-autocomplete="list"
          className="h-10 w-full bg-transparent pl-9 pr-9 text-sm focus:outline-none"
        />
        {geocodeLoading || arcgisLoading ? (
          <Loader2 className="pointer-events-none absolute right-8 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-muted" />
        ) : null}
        {query ? (
          <button
            type="button"
            onClick={() => {
              setQuery('');
              setGeocodeResults([]);
              inputRef.current?.focus();
            }}
            aria-label="Clear search"
            className="absolute right-2 top-1/2 inline-flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded text-muted hover:bg-surface-2"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </label>

      {open && query.trim() ? (
        <div
          role="listbox"
          className="max-h-80 overflow-y-auto border-t border-border"
        >
          {layerResults.length > 0 || arcgisResults.length > 0 ? (
            <Section title="In this map">
              {layerResults.map((r, i) => (
                <ResultRow
                  key={`l-${i}`}
                  result={r}
                  highlighted={all.indexOf(r) === highlight}
                  onHover={() => setHighlight(all.indexOf(r))}
                  onClick={() => {
                    onPick(r);
                    setOpen(false);
                  }}
                />
              ))}
              {arcgisResults.map((r, i) => (
                <ResultRow
                  key={`a-${i}`}
                  result={r}
                  highlighted={all.indexOf(r) === highlight}
                  onHover={() => setHighlight(all.indexOf(r))}
                  onClick={() => {
                    onPick(r);
                    setOpen(false);
                  }}
                />
              ))}
            </Section>
          ) : null}

          {geocodingEnabled ? (
            geocodeResults.length > 0 ? (
              <Section title="Places">
                {geocodeResults.map((r, i) => (
                  <ResultRow
                    key={`g-${i}`}
                    result={r}
                    highlighted={all.indexOf(r) === highlight}
                    onHover={() => setHighlight(all.indexOf(r))}
                    onClick={() => {
                      onPick(r);
                      setOpen(false);
                    }}
                  />
                ))}
                <div className="px-3 py-1 text-[10px] text-muted">
                  Places via © OpenStreetMap contributors (Nominatim)
                </div>
              </Section>
            ) : query.trim().length >= 3 && !geocodeLoading ? (
              <div className="px-3 py-2 text-xs text-muted">
                No matches{anyLayerSearchable ? '' : ' — try a longer query'}.
              </div>
            ) : null
          ) : null}

          {!geocodingEnabled && layerResults.length === 0 ? (
            <div className="px-3 py-2 text-xs text-muted">
              {anyLayerSearchable
                ? 'No attribute matches. Geocoding is turned off for this map.'
                : 'No layers in this map are searchable.'}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="sticky top-0 bg-surface-2 px-3 py-1 text-[10px] font-medium uppercase tracking-wide text-muted">
        {title}
      </div>
      <ul>{children}</ul>
    </div>
  );
}

function ResultRow({
  result,
  highlighted,
  onHover,
  onClick,
}: {
  result: SearchResult;
  highlighted: boolean;
  onHover: () => void;
  onClick: () => void;
}) {
  const Icon = result.kind === 'feature' ? Tag : MapPin;
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        onMouseEnter={onHover}
        className={`flex w-full items-start gap-2 px-3 py-2 text-left text-sm transition-colors ${
          highlighted ? 'bg-accent/10' : 'hover:bg-surface-2'
        }`}
      >
        <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-ink-0">{result.label}</span>
          <span className="block truncate text-xs text-muted">
            {result.kind === 'feature'
              ? result.layerTitle + (result.subtitle ? ` · ${result.subtitle}` : '')
              : result.subtitle}
          </span>
        </span>
      </button>
    </li>
  );
}
