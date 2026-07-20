// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import 'maplibre-gl/dist/maplibre-gl.css';
import 'maplibre-gl-lidar/style.css';
import { useEffect, useRef } from 'react';
import maplibregl from 'maplibre-gl';
import { LidarControl } from 'maplibre-gl-lidar';
import type { PointCloudData } from '@gratis-gis/shared-types';

/**
 * In-browser COPC viewer (#179, unit 2). Wraps maplibre-gl-lidar,
 * which renders the point cloud through deck.gl and streams octree
 * nodes by viewport from our range proxy, so an 8 GB cloud costs
 * only the nodes in view.
 *
 * This module is intentionally heavy (deck.gl + copc.js + laz-perf
 * wasm + proj4 ride in with maplibre-gl-lidar) and must ONLY be
 * imported through next/dynamic with ssr disabled -- see the
 * PointCloudPanel. Importing it statically anywhere would put the
 * whole 3D stack into the shared bundle every page pays for.
 *
 * The default export is the component (next/dynamic convention).
 */
export default function PointCloudViewer({
  data,
}: {
  data: PointCloudData;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!containerRef.current || !data.dataUrl) return;

    // OSM raster backdrop, same reasoning as the tile-layer
    // preview: lidar tiles are geographically tiny, and points
    // floating over a black void read as "nothing loaded".
    const style: maplibregl.StyleSpecification = {
      version: 8,
      sources: {
        backdrop: {
          type: 'raster',
          tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
          tileSize: 256,
          attribution: '(c) OpenStreetMap contributors',
        },
      },
      layers: [
        { id: 'backdrop', type: 'raster', source: 'backdrop' },
      ],
    };

    const map = new maplibregl.Map({
      container: containerRef.current,
      style,
      center: [0, 0],
      zoom: 2,
      pitch: 60,
      maxPitch: 85,
      attributionControl: { compact: true },
    });
    map.addControl(
      new maplibregl.NavigationControl({ visualizePitch: true }),
    );

    // Portal dark mode is a class on <html>, not the OS setting,
    // so resolve the control theme from the class rather than
    // letting the control's 'auto' follow prefers-color-scheme.
    const theme = document.documentElement.classList.contains('dark')
      ? ('dark' as const)
      : ('light' as const);

    const control = new LidarControl({
      title: 'Point cloud',
      collapsed: true,
      theme,
      pointSize: 2,
      // RGB when the file carries it; elevation ramp otherwise.
      colorScheme: data.hasRgb ? 'rgb' : 'elevation',
      pickable: true,
      autoZoom: true,
      // The share-URL affordance encodes the control's own state
      // into the address bar; inside the portal that fights the
      // Next router, so it stays off.
      shareUrl: false,
      restoreFromUrl: false,
    });
    map.addControl(control, 'top-right');

    let cancelled = false;
    map.on('load', () => {
      if (cancelled || !data.dataUrl) return;
      // Absolute URL: the loader fetches from a worker context
      // where a relative path has no document base.
      const url = `${window.location.origin}${data.dataUrl}`;
      void control.loadPointCloud(url).catch(() => {
        /* the control surfaces load errors in its own panel */
      });
    });

    return () => {
      cancelled = true;
      try {
        control.stopStreaming();
      } catch {
        /* not streaming */
      }
      map.remove();
    };
    // Re-create the whole viewer when the underlying file changes;
    // storageKey is the identity of the uploaded bytes.
  }, [data.storageKey, data.dataUrl, data.hasRgb]);

  return (
    <div
      ref={containerRef}
      className="h-[480px] w-full overflow-hidden rounded-md border border-border"
    />
  );
}
