// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

/**
 * Inline MapLibre preview for a basemap (#67).  Two consumer contexts:
 *
 *   1. Basemap item config page: a wide live preview pane next to the
 *      source form so the author can confirm the URL renders before
 *      saving.
 *   2. Custom Web App basemap-gallery widget: a tile-sized thumbnail
 *      so users pick basemaps by appearance, not just name.
 *
 * Both consumers pass `data` (BasemapData) and a target size; the
 * component mounts a single read-only MapLibre instance against the
 * computed style.  Re-styling on `data` changes calls map.setStyle()
 * rather than tearing the instance down, so editing a URL on the
 * config page repaints smoothly without flicker.
 *
 * Disabled interaction by default for the tile use case so users
 * don't accidentally pan/zoom a small preview; passing
 * `interactive` flips MapLibre's nav handlers back on for the
 * config-page case.
 */
import { useEffect, useMemo, useRef } from 'react';
import * as maplibregl from 'maplibre-gl';
import type { BasemapData } from '@gratis-gis/shared-types';
import { basemapDataToStyle, ensureRasterProtocols } from '@/lib/custom-basemap';
import { ensureMapLibreWorker } from '@/lib/maplibre-runtime';

interface Props {
  data: BasemapData;
  /** Override the initial center; default is roughly the contiguous US. */
  center?: [number, number];
  /** Override the initial zoom; default is z=3 (world overview). */
  zoom?: number;
  /** Allow pan/zoom interactions. Default false (tile-thumbnail mode). */
  interactive?: boolean;
  className?: string;
  /** Optional aria label; falls back to "Basemap preview". */
  ariaLabel?: string;
}

// Default preview center + zoom.  Tuned to a place with mixed
// features (water, dense roads, labels, terrain) so different
// basemaps render visually distinct at thumbnail size -- a world-
// overview crop is too zoomed-out to tell satellite from streets
// from dark.  San Francisco's bay + hills + grid gives every
// raster / vector style something to show.  Callers can override
// via the `center` / `zoom` props for the basemap config page's
// larger preview pane.
const DEFAULT_CENTER: [number, number] = [-122.4194, 37.7749];
const DEFAULT_ZOOM = 11;

export function BasemapPreview({
  data,
  center = DEFAULT_CENTER,
  zoom = DEFAULT_ZOOM,
  interactive = false,
  className,
  ariaLabel,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);

  // Camera and interactivity for the map we create. Read through a
  // ref so the create path below always sees the current props
  // without listing them as deps.
  const initRef = useRef({ center, zoom, interactive });
  initRef.current = { center, zoom, interactive };

  // Callers often pass a fresh `data` object every render (the custom
  // app gallery builds it inline). Keying on its content stops each
  // render from calling setStyle, which refetches a style URL.
  const styleKey = useMemo(() => JSON.stringify(data ?? null), [data]);

  // Tear the instance down on unmount only.
  useEffect(() => {
    return () => {
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, []);

  // Create the map the first time there is a usable style, and after
  // that apply style changes to the same instance so the canvas does
  // not flicker or get torn down on every keystroke while the user
  // types a URL. Creating it here, rather than in a mount-only effect,
  // matters when the component first renders with an empty source:
  // the map then appears as soon as a valid URL is typed.
  useEffect(() => {
    const style = basemapDataToStyle(data);
    if (!style) return; // empty data: leave the placeholder visible
    const m = mapRef.current;
    if (m) {
      try {
        m.setStyle(style.kind === 'url' ? style.url : style.style);
      } catch {
        /* swallow: malformed URL during typing, preview just stays
           on the previous valid style until the next keystroke that
           parses. */
      }
      return;
    }
    if (!containerRef.current) return;
    ensureRasterProtocols(); // pmtiles/cog basemaps need the schemes registered (#209)
    ensureMapLibreWorker();
    const init = initRef.current;
    mapRef.current = new maplibregl.Map({
      container: containerRef.current,
      style: style.kind === 'url' ? style.url : style.style,
      center: init.center,
      zoom: init.zoom,
      interactive: init.interactive,
      attributionControl: false,
      pitchWithRotate: false,
      dragRotate: false,
    });
    // `data` is read through styleKey, which changes exactly when its
    // content does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [styleKey]);

  // Recenter / rezoom on prop change (rare; preview pane keeps its
  // own camera once mounted).
  useEffect(() => {
    const m = mapRef.current;
    if (!m) return;
    m.setCenter(center);
    m.setZoom(zoom);
  }, [center, zoom]);

  const ready = basemapDataToStyle(data) !== null;

  return (
    <div
      ref={containerRef}
      role="img"
      aria-label={ariaLabel ?? 'Basemap preview'}
      className={
        className ??
        'h-full w-full overflow-hidden rounded-md border border-border bg-surface-2'
      }
    >
      {!ready ? (
        <div className="flex h-full w-full items-center justify-center text-2xs text-muted">
          Configure a source to see the preview.
        </div>
      ) : null}
    </div>
  );
}
