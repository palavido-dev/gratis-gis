// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import 'maplibre-gl/dist/maplibre-gl.css';
import 'maplibre-gl-lidar/style.css';
import { useEffect, useRef, useState } from 'react';
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
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (!containerRef.current || !data.dataUrl) return;
    setLoadError(null);

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

    // Start the camera AT the data when finalize derived a WGS84
    // bbox. Ordering matters, not just polish: the streaming
    // loader's first LOD pass is viewport-driven, and a world view
    // intersects every octree node, which allocates proportionally
    // to the whole cloud and OOMs the tab on hundreds of millions
    // of points. A bounded start keeps that first pass to the
    // handful of nodes actually in view.
    const bbox = data.bboxWgs84;
    const startView = bbox
      ? {
          center: [
            (bbox[0] + bbox[2]) / 2,
            (bbox[1] + bbox[3]) / 2,
          ] as [number, number],
          zoom: 13,
        }
      : { center: [0, 0] as [number, number], zoom: 2 };
    const map = new maplibregl.Map({
      container: containerRef.current,
      style,
      center: startView.center,
      zoom: startView.zoom,
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

    // Size-aware tuning. Every stream-update batch rebuilds the
    // deck.gl layer data on the main thread, and on a ~200M-point
    // cloud that measured as multi-second stalls (worst observed:
    // 1.9s) during pan/zoom. Until the renderer appends nodes
    // incrementally (tracked in the perf issue), the honest levers
    // are: fewer points per rebuild, fewer rebuilds while the
    // camera moves, and no picking buffers by default on huge
    // clouds (the panel still exposes the toggle). Small clouds
    // keep the snappier settings.
    const isHuge = (data.pointCount ?? 0) > 20_000_000;
    const control = new LidarControl({
      title: 'Point cloud',
      collapsed: true,
      theme,
      pointSize: 2,
      // RGB when the file carries it; elevation ramp otherwise.
      colorScheme: data.hasRgb ? 'rgb' : 'elevation',
      pickable: !isHuge,
      autoZoom: true,
      streamingPointBudget: isHuge ? 1_500_000 : 4_000_000,
      streamingViewportDebounceMs: isHuge ? 400 : 150,
      // The share-URL affordance encodes the control's own state
      // into the address bar; inside the portal that fights the
      // Next router, so it stays off.
      shareUrl: false,
      restoreFromUrl: false,
    });
    map.addControl(control, 'top-right');

    // Surface load failures next to the map. The control shows
    // them in its own panel too, but the panel starts collapsed,
    // so without this a failed load reads as "map never moved".
    control.on('loaderror', (event) => {
      const err = (event as { error?: unknown }).error;
      setLoadError(
        err instanceof Error ? err.message : 'Point cloud failed to load.',
      );
    });

    let cancelled = false;
    map.on('load', () => {
      if (cancelled || !data.dataUrl) return;
      // Absolute URL: the loader fetches from a worker context
      // where a relative path has no document base.
      const url = `${window.location.origin}${data.dataUrl}`;
      void control.loadPointCloud(url).catch((err: unknown) => {
        setLoadError(
          err instanceof Error ? err.message : 'Point cloud failed to load.',
        );
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
    <div>
      <div
        ref={containerRef}
        className="h-[480px] w-full overflow-hidden rounded-md border border-border"
      />
      {loadError ? (
        <p className="mt-2 rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-xs text-danger">
          {loadError}
        </p>
      ) : null}
    </div>
  );
}
