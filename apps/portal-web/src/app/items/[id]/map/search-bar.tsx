// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, MapPin, Search, Tag, X } from 'lucide-react';
import type { MapLayer } from '@gratis-gis/shared-types';
import { useT } from '@/lib/i18n/locale-context';
import { serverSublayerOf } from '@/lib/server-sublayer';
import { hiddenLayerIds } from '@/lib/search-hidden-layers';
import {
  GeocoderUnavailableError,
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
   * Search covers hidden layers too. When the user picks a result
   * from a hidden layer, this is called with that layer's id (before
   * onPick) so the host can turn it on. Hosts that cannot change
   * visibility leave it out; the result is still labelled hidden.
   */
  onShowLayer?: (layerId: string) => void;
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
  onShowLayer,
  embedded = false,
}: Props) {
  const t = useT();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [geocodeResults, setGeocodeResults] = useState<SearchResult[]>([]);
  const [geocodeLoading, setGeocodeLoading] = useState(false);
  /** Why the geocoder could not be asked, or null when it answered. */
  const [geocodeUnavailable, setGeocodeUnavailable] = useState<string | null>(
    null,
  );
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

  const hiddenIds = useMemo(() => hiddenLayerIds(layers), [layers]);
  const isHiddenResult = (r: SearchResult) =>
    r.kind === 'feature' && hiddenIds.has(r.layerId);
  // Every pick goes through here so a result from a hidden layer
  // turns that layer on first; otherwise the map would fly to a
  // feature it does not draw.
  function pick(r: SearchResult) {
    if (r.kind === 'feature' && hiddenIds.has(r.layerId)) {
      onShowLayer?.(r.layerId);
    }
    onPick(r);
    setOpen(false);
  }

  const anyLayerSearchable = layers.some(
    (l) => l.search?.enabled && l.search.fields.length > 0,
  );

  // Debounced geocoder. Don't run for super-short queries: every
  // keystroke triggers a network request. When the map has a
  // geocoderItemId picked (#74) the runtime uses that geocoder
  // instead of Nominatim, forwarding the current viewport so the
  // similarity scan stays scoped.
  //
  // Each of the three remote searches below follows the same rules:
  // only the newest run may touch state (an aborted request resolves
  // to an empty list, which used to wipe the results and stop the
  // spinner while the newer request was still pending), and every
  // early exit clears its loading flag (a timer cancelled before it
  // fired used to leave the spinner on).
  //
  // The viewport is read when the request goes out, not as a
  // dependency: it changes on every settled pan, and with text left
  // in the box each pan re-queried the geocoder.
  const viewportBboxRef = useRef(viewportBbox);
  viewportBboxRef.current = viewportBbox;
  useEffect(() => {
    if (!geocodingEnabled) {
      setGeocodeResults([]);
      setGeocodeLoading(false);
      return;
    }
    const q = query.trim();
    if (q.length < 2) {
      setGeocodeResults([]);
      setGeocodeLoading(false);
      return;
    }
    let active = true;
    const controller = new AbortController();
    setGeocodeLoading(true);
    setGeocodeUnavailable(null);
    const handle = setTimeout(() => {
      const promise = geocoderItemId
        ? geocodeViaItem(
            q,
            geocoderItemId,
            viewportBboxRef.current ?? null,
            controller.signal,
          )
        : q.length >= 3
          ? geocode(q, controller.signal)
          : Promise.resolve([] as SearchResult[]);
      promise
        .then((rows) => {
          if (!active) return;
          setGeocodeResults(rows);
          setGeocodeUnavailable(null);
        })
        .catch((err: unknown) => {
          if (!active) return;
          // Distinguish "the geocoder has nothing for that" from "the
          // geocoder could not be reached". Telling a user to reword
          // a query that was never actually asked wastes their time.
          setGeocodeResults([]);
          setGeocodeUnavailable(
            err instanceof GeocoderUnavailableError
              ? err.message
              : t('errorReason.unknown'),
          );
        })
        .finally(() => {
          if (active) setGeocodeLoading(false);
        });
    }, 350);
    return () => {
      active = false;
      controller.abort();
      clearTimeout(handle);
    };
  }, [query, geocodingEnabled, geocoderItemId, t]);

  // Debounced ArcGIS REST attribute search. Runs only when at least
  // one layer is arcgis-rest and searchable, hidden or not; otherwise
  // we fall through to the fast local-cache path alone. Short queries
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
      setArcgisLoading(false);
      return;
    }
    let active = true;
    const controller = new AbortController();
    setArcgisLoading(true);
    const handle = setTimeout(() => {
      searchArcgisLayers(q, arcgisLayers, controller.signal)
        .then((rows) => {
          if (active) setArcgisResults(rows);
        })
        .finally(() => {
          if (active) setArcgisLoading(false);
        });
    }, 300);
    return () => {
      active = false;
      controller.abort();
      clearTimeout(handle);
    };
  }, [query, layers]);

  // Debounced v3 data-layer attribute search. Mirrors the ArcGIS
  // path: runs only when at least one layer (hidden or not) is a v3
  // data_layer sublayer and searchable, hits the server so it can
  // find features outside the viewport (v3 layers stream as tiles and
  // are never fully cached client-side, so searchLayers can't see
  // them), and is debounced so a 1.4M-row layer isn't queried on
  // every keystroke.
  useEffect(() => {
    const q = query.trim();
    // Editor targets count too: they are v3 sublayers drawn from a
    // viewport read, so the browser never holds the whole layer.
    const v3Layers = layers.filter(
      (l) =>
        serverSublayerOf(l) !== null &&
        l.search?.enabled &&
        (l.search?.fields?.length ?? 0) > 0,
    );
    if (q.length < 2 || v3Layers.length === 0) {
      setV3Results([]);
      setV3Loading(false);
      return;
    }
    let active = true;
    const controller = new AbortController();
    setV3Loading(true);
    const handle = setTimeout(() => {
      searchV3Layers(q, v3Layers, controller.signal)
        .then((rows) => {
          if (active) setV3Results(rows);
        })
        .finally(() => {
          if (active) setV3Loading(false);
        });
    }, 300);
    return () => {
      active = false;
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
      const hit = all[highlight];
      if (hit) pick(hit);
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
          : 'absolute left-4 top-4 z-10 w-80 overflow-hidden rounded-lg border border-border bg-surface-1/95 shadow-raised backdrop-blur-xs max-md:left-3 max-md:right-3 max-md:w-auto'
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
                ? t('mapSearch.placeholderAddressOrAttributes')
                : t('mapSearch.placeholderAddress')
              : anyLayerSearchable
                ? t('mapSearch.placeholderAttributes')
                : t('mapSearch.placeholderUnconfigured')
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
          className="h-10 w-full bg-transparent pl-9 pr-9 text-sm focus:outline-hidden"
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
            aria-label={t('mapSearch.clearAria')}
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
            <Section title={t('mapSearch.inThisMap')}>
              {layerResults.map((r, i) => (
                <ResultRow
                  key={`l-${i}`}
                  result={r}
                  highlighted={all.indexOf(r) === highlight}
                  onHover={() => setHighlight(all.indexOf(r))}
                  hidden={isHiddenResult(r)}
                  onClick={() => pick(r)}
                />
              ))}
              {arcgisResults.map((r, i) => (
                <ResultRow
                  key={`a-${i}`}
                  result={r}
                  highlighted={all.indexOf(r) === highlight}
                  onHover={() => setHighlight(all.indexOf(r))}
                  hidden={isHiddenResult(r)}
                  onClick={() => pick(r)}
                />
              ))}
              {v3Results.map((r, i) => (
                <ResultRow
                  key={`v-${i}`}
                  result={r}
                  highlighted={all.indexOf(r) === highlight}
                  onHover={() => setHighlight(all.indexOf(r))}
                  hidden={isHiddenResult(r)}
                  onClick={() => pick(r)}
                />
              ))}
            </Section>
          ) : null}

          {geocodingEnabled ? (
            geocodeResults.length > 0 ? (
              <Section title={t('mapSearch.places')}>
                {geocodeResults.map((r, i) => (
                  <ResultRow
                    key={`g-${i}`}
                    result={r}
                    highlighted={all.indexOf(r) === highlight}
                    onHover={() => setHighlight(all.indexOf(r))}
                    onClick={() => pick(r)}
                  />
                ))}
                <div className="px-3 py-1 text-2xs text-muted">
                  {t('mapSearch.placesAttribution')}
                </div>
              </Section>
            ) : geocodeUnavailable && !geocodeLoading ? (
              /* The geocoder could not be asked. Say that, rather
                 than reporting a confident "no matches" for a
                 question nobody answered. On a self-hosted portal
                 the usual cause is a Nominatim container that is
                 down or still importing, so point at it. */
              <div className="px-3 py-2 text-xs text-muted">
                {t('mapSearch.geocoderUnavailable', { reason: geocodeUnavailable })}
              </div>
            ) : query.trim().length >= 3 && !geocodeLoading ? (
              /* A real zero-result answer. The old copy appended
                 "try a longer query" here, keyed on whether any
                 LAYER had attribute search configured, which has
                 nothing to do with the length of the query and was
                 shown for fully qualified 21-character place names.
                 Advice that cannot possibly help is worse than no
                 advice. If a self-hosted geocoder covers only part
                 of the world, that is the likely cause and it is
                 the thing worth naming. */
              <div className="px-3 py-2 text-xs text-muted">
                {t('mapSearch.noPlaces')}
              </div>
            ) : null
          ) : null}

          {!geocodingEnabled &&
          layerResults.length === 0 &&
          arcgisResults.length === 0 &&
          v3Results.length === 0 ? (
            <div className="px-3 py-2 text-xs text-muted">
              {anyLayerSearchable
                ? t('mapSearch.noAttributeMatches')
                : t('mapSearch.noSearchableLayers')}
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
  hidden = false,
  onHover,
  onClick,
}: {
  result: SearchResult;
  highlighted: boolean;
  /** The result's layer is turned off; picking it turns it on. */
  hidden?: boolean;
  onHover: () => void;
  onClick: () => void;
}) {
  const t = useT();
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
          <span className="flex items-center gap-1.5">
            <span className="min-w-0 truncate text-ink-0">{result.label}</span>
            {hidden ? (
              <span
                className="shrink-0 rounded bg-surface-2 px-1 text-2xs text-muted"
                title={t('mapSearch.hiddenLayerHint')}
              >
                {t('mapSearch.hiddenLayer')}
              </span>
            ) : null}
          </span>
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
