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
import { useEffect, useRef } from 'react';
import maplibregl from 'maplibre-gl';
import type { BasemapData } from '@gratis-gis/shared-types';
import { basemapDataToStyle, ensureRasterProtocols } from '@/lib/custom-basemap';

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

  // Mount the instance once.  Don't include data in deps so we don't
  // tear the canvas down on every keystroke while the user types a
  // URL; setStyle below handles updates.
  useEffect(() => {
    if (!containerRef.current) return;
    const style = basemapDataToStyle(data);
    if (!style) return; // empty data: leave the placeholder visible
    ensureRasterProtocols(); // pmtiles/cog basemaps need the schemes registered (#209)
    const m = new maplibregl.Map({
      container: containerRef.current,
      style: style.kind === 'url' ? style.url : style.style,
      center,
      zoom,
      interactive,
      attributionControl: false,
      pitchWithRotate: false,
      dragRotate: false,
    });
    mapRef.current = m;
    return () => {
      m.remove();
      mapRef.current = null;
    };
    // We intentionally only mount once; updates flow through the
    // setStyle effect below.  Listing every prop here would tear the
    // instance down on every keystroke during URL editing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Apply style updates on data change.  Re-uses the same instance
  // so the canvas doesn't flicker.
  useEffect(() => {
    const m = mapRef.current;
    if (!m) return;
    const style = basemapDataToStyle(data);
    if (!style) return;
    try {
      m.setStyle(style.kind === 'url' ? style.url : style.style);
    } catch {
      /* swallow: malformed URL during typing, preview just stays
         on the previous valid style until the next keystroke that
         parses. */
    }
  }, [data]);

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
