// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, MapPin, Search, Tag, X } from 'lucide-react';
import type { MapLayer } from '@gratis-gis/shared-types';
import {
  geocode,
  geocodeViaItem,
  searchArcgisLayers,
  searchLayers,
  searchV3Layers,
  type SearchResult,
} from './search-sources';

interface Props {
  layers: MapLayer[];
  featuresByLayer: Record<string, GeoJSON.FeatureCollection | null>;
  geocodingEnabled: boolean;
  /**
   * #74: optional geocoding_service item id. When set, the search
   * bar queries that geocoder instead of Nominatim. The runtime
   * forwards the map's current viewport as the bbox so the
   * similarity scan stays scoped to what the user is looking at.
   */
  geocoderItemId?: string;
  /**
   * #74: current viewport bbox for the geocoder. Optional; when
   * missing the runtime falls back to the geocoder's configured
   * bbox filter.
   */
  viewportBbox?: [number, number, number, number] | null;
  /**
   * Called when the user picks a result. The canvas owns the flyTo +
   * highlight logic; we just hand off the target.
   */
  onPick: (result: SearchResult) => void;
  /**
   * #64: render without the map-canvas overlay chrome so the bar can
   * live inside a Custom Web App tool popover. Drops the absolute
   * positioning, fixed width, raised shadow, and backdrop blur, and
   * lets the parent control sizing. The search behavior (layer-attr +
   * Nominatim or item geocoder) is identical in either mode.
   */
  embedded?: boolean;
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
 * Keyboard support follows the WAI-ARIA combobox pattern: ↑ / ↓ move
 * the highlight, Enter picks, Escape closes.
 */
export function SearchBar({
  layers,
  featuresByLayer,
  geocodingEnabled,
  geocoderItemId,
  viewportBbox,
  onPick,
  embedded = false,
}: Props) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [geocodeResults, setGeocodeResults] = useState<SearchResult[]>([]);
  const [geocodeLoading, setGeocodeLoading] = useState(false);
  const [arcgisResults, setArcgisResults] = useState<SearchResult[]>([]);
  const [arcgisLoading, setArcgisLoading] = useState(false);
  const [v3Results, setV3Results] = useState<SearchResult[]>([]);
  const [v3Loading, setV3Loading] = useState(false);
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

  // Debounced geocoder. Don't run for super-short queries: every
  // keystroke triggers a network request. When the map has a
  // geocoderItemId picked (#74) the runtime uses that geocoder
  // instead of Nominatim, forwarding the current viewport so the
  // similarity scan stays scoped.
  useEffect(() => {
    if (!geocodingEnabled) {
      setGeocodeResults([]);
      return;
    }
    const q = query.trim();
    if (q.length < 2) {
      setGeocodeResults([]);
      return;
    }
    const controller = new AbortController();
    setGeocodeLoading(true);
    const handle = setTimeout(() => {
      const promise = geocoderItemId
        ? geocodeViaItem(q, geocoderItemId, viewportBbox ?? null, controller.signal)
        : q.length >= 3
          ? geocode(q, controller.signal)
          : Promise.resolve([] as SearchResult[]);
      promise
        .then((rows) => setGeocodeResults(rows))
        .finally(() => setGeocodeLoading(false));
    }, 350);
    return () => {
      controller.abort();
      clearTimeout(handle);
    };
  }, [query, geocodingEnabled, geocoderItemId, viewportBbox]);

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

  // Debounced v3 data-layer attribute search. Mirrors the ArcGIS
  // path: runs only when at least one visible layer is a v3
  // data_layer sublayer and searchable, hits the server so it can
  // find features outside the viewport (v3 layers stream as tiles and
  // are never fully cached client-side, so searchLayers can't see
  // them), and is debounced so a 1.4M-row layer isn't queried on
  // every keystroke.
  useEffect(() => {
    const q = query.trim();
    const v3Layers = layers.filter(
      (l) =>
        l.source.kind === 'data-layer' &&
        l.search?.enabled &&
        (l.search?.fields?.length ?? 0) > 0,
    );
    if (q.length < 2 || v3Layers.length === 0) {
      setV3Results([]);
      return;
    }
    const controller = new AbortController();
    setV3Loading(true);
    const handle = setTimeout(() => {
      searchV3Layers(q, v3Layers, controller.signal)
        .then((rows) => setV3Results(rows))
        .finally(() => setV3Loading(false));
    }, 300);
    return () => {
      controller.abort();
      clearTimeout(handle);
    };
  }, [query, layers]);

  const all: SearchResult[] = useMemo(
    () => [...layerResults, ...arcgisResults, ...v3Results, ...geocodeResults],
    [layerResults, arcgisResults, v3Results, geocodeResults],
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
      className={
        embedded
          ? 'overflow-hidden rounded-lg border border-border bg-surface-1'
          : 'absolute left-4 top-4 z-10 w-80 overflow-hidden rounded-lg border border-border bg-surface-1/95 shadow-raised backdrop-blur'
      }
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
        {geocodeLoading || arcgisLoading || v3Loading ? (
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
          {layerResults.length > 0 ||
          arcgisResults.length > 0 ||
          v3Results.length > 0 ? (
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
              {v3Results.map((r, i) => (
                <ResultRow
                  key={`v-${i}`}
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
                <div className="px-3 py-1 text-2xs text-muted">
                  Places via © OpenStreetMap contributors (Nominatim)
                </div>
              </Section>
            ) : query.trim().length >= 3 && !geocodeLoading ? (
              <div className="px-3 py-2 text-xs text-muted">
                No matches{anyLayerSearchable ? '' : ': try a longer query'}.
              </div>
            ) : null
          ) : null}

          {!geocodingEnabled &&
          layerResults.length === 0 &&
          arcgisResults.length === 0 &&
          v3Results.length === 0 ? (
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
      <div className="sticky top-0 bg-surface-2 px-3 py-1 text-2xs font-medium uppercase tracking-wide text-muted">
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
