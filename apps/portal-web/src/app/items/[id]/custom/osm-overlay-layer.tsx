// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

/**
 * Transient OSM features overlay on a runtime MapLibre instance
 * (#OSM).  Mounts when a recipe tool with the
 * `osm-features-overlay` output sink finishes; unmounts when the
 * user dismisses the overlay or runs the tool again.
 *
 * Owns its own MapLibre source + three layers (circles for points,
 * lines for ways / boundaries, fill+outline for polygons).  Adds an
 * ODbL attribution chip at the bottom-right of the map while any
 * overlay is mounted.  Renders nothing in the React tree; all
 * visual output goes through the MapLibre canvas.
 *
 * Multiple overlays can stack on the same map (each gets a unique
 * id); the attribution chip de-dupes so the user never sees
 * "© OpenStreetMap contributors" twice.
 */

import { useEffect } from 'react';
import * as maplibregl from 'maplibre-gl';

export interface OsmOverlayFeature {
  type: 'Feature';
  id: string;
  properties: Record<string, unknown>;
  geometry: unknown;
}

interface Props {
  /** Unique id for this overlay (different overlays on the same
   *  map use unique ids so source + layer names don't collide). */
  id: string;
  map: maplibregl.Map;
  features: OsmOverlayFeature[];
  /** Tailwind-friendly color used for the fill / circle / line
   *  paint.  Defaults to a neutral accent so generic OSM results
   *  read as "not part of the user's own data." */
  color?: string;
}

export function OsmOverlayLayer({ id, map, features, color = '#7c3aed' }: Props) {
  useEffect(() => {
    const srcId = `osm-overlay/${id}`;
    const fillId = `osm-overlay-fill/${id}`;
    const lineId = `osm-overlay-line/${id}`;
    const pointId = `osm-overlay-point/${id}`;

    if (!map.getSource(srcId)) {
      map.addSource(srcId, {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: features as unknown as GeoJSON.Feature[] },
      });
    } else {
      (map.getSource(srcId) as maplibregl.GeoJSONSource).setData({
        type: 'FeatureCollection',
        features: features as unknown as GeoJSON.Feature[],
      });
    }
    if (!map.getLayer(fillId)) {
      map.addLayer({
        id: fillId,
        type: 'fill',
        source: srcId,
        filter: ['==', ['geometry-type'], 'Polygon'],
        paint: {
          'fill-color': color,
          'fill-opacity': 0.2,
          'fill-outline-color': color,
        },
      });
    }
    if (!map.getLayer(lineId)) {
      map.addLayer({
        id: lineId,
        type: 'line',
        source: srcId,
        filter: ['in', ['geometry-type'], ['literal', ['LineString', 'Polygon', 'MultiLineString', 'MultiPolygon']]],
        paint: {
          'line-color': color,
          'line-width': 2,
        },
      });
    }
    if (!map.getLayer(pointId)) {
      map.addLayer({
        id: pointId,
        type: 'circle',
        source: srcId,
        filter: ['==', ['geometry-type'], 'Point'],
        paint: {
          'circle-color': color,
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 1.5,
          'circle-radius': 6,
        },
      });
    }

    // #141 wave A: default click-to-popup binding.  Renders the
    // feature's `name` tag (the OSM-canonical primary identifier;
    // every named real-world feature carries it).  Falls back to a
    // small tag list when `name` is missing so an unnamed-but-tagged
    // feature still shows the user *something* useful instead of a
    // silent click.  Cursor turns into a pointer over interactive
    // features so users discover the affordance.
    const interactiveLayers = [fillId, lineId, pointId];
    let activePopup: maplibregl.Popup | null = null;
    const onClick = (e: maplibregl.MapMouseEvent & { features?: maplibregl.MapGeoJSONFeature[] }): void => {
      const f = e.features?.[0];
      if (!f) return;
      // Close any prior popup before opening a new one so successive
      // clicks don't leave a trail of popups behind on the map.
      activePopup?.remove();
      const html = renderOsmPopupHtml(f.properties ?? {});
      activePopup = new maplibregl.Popup({
        closeOnClick: true,
        maxWidth: '280px',
      })
        .setLngLat(e.lngLat)
        .setHTML(html)
        .addTo(map);
    };
    const onEnter = (): void => {
      map.getCanvas().style.cursor = 'pointer';
    };
    const onLeave = (): void => {
      map.getCanvas().style.cursor = '';
    };
    for (const layerId of interactiveLayers) {
      map.on('click', layerId, onClick);
      map.on('mouseenter', layerId, onEnter);
      map.on('mouseleave', layerId, onLeave);
    }

    return () => {
      // Tear down the click + cursor handlers before the layers
      // disappear so MapLibre doesn't fire onLeave with no target.
      for (const layerId of interactiveLayers) {
        try {
          map.off('click', layerId, onClick);
          map.off('mouseenter', layerId, onEnter);
          map.off('mouseleave', layerId, onLeave);
        } catch {
          /* layer may already be gone; ignore */
        }
      }
      activePopup?.remove();
      activePopup = null;
      for (const layerId of interactiveLayers) {
        try {
          if (map.getLayer(layerId)) map.removeLayer(layerId);
        } catch {
          /* mid-style-swap unmount; ignore */
        }
      }
      try {
        if (map.getSource(srcId)) map.removeSource(srcId);
      } catch {
        /* ignore */
      }
    };
  }, [id, map, features, color]);

  return null;
}

/**
 * Build the popup body for an OSM feature.  Title is the feature's
 * `name` tag when present; otherwise a short de-namespaced label
 * derived from the primary OSM key (`amenity=school` -> "School").
 * Below the title, a small table of the most useful supporting tags
 * (operator, address, website, opening_hours) -- only the ones the
 * feature actually carries.  Long values truncate at 80 chars.
 *
 * No raw HTML interpolation: every value passes through
 * `escapeHtml` to keep the popup XSS-safe even if an OSM contributor
 * has stuck a `<script>` in a tag value somewhere.
 */
function renderOsmPopupHtml(props: Record<string, unknown>): string {
  const name = strOrNull(props.name);
  const title = name ?? primaryClassLabel(props) ?? 'OSM feature';
  const fields: Array<[string, string]> = [];
  const push = (label: string, key: string): void => {
    const v = strOrNull(props[key]);
    if (v) fields.push([label, v]);
  };
  push('Operator', 'operator');
  push('Address', 'addr:full');
  if (!props['addr:full']) {
    const street = strOrNull(props['addr:street']);
    const num = strOrNull(props['addr:housenumber']);
    if (street || num) {
      fields.push([
        'Address',
        [num, street].filter(Boolean).join(' '),
      ]);
    }
  }
  push('City', 'addr:city');
  push('Website', 'website');
  push('Phone', 'phone');
  push('Hours', 'opening_hours');
  // Show the OSM class (amenity=school, leisure=park, etc.) below the
  // name so the user knows what kind of feature they clicked when the
  // name alone is ambiguous.
  if (name) {
    const cls = primaryClassLabel(props);
    if (cls) fields.unshift(['Type', cls]);
  }
  const head = `<div style="font-weight:600;color:#111;margin-bottom:4px;">${escapeHtml(title)}</div>`;
  if (fields.length === 0) {
    return `<div style="padding:2px 0;font-size:12px;">${head}<div style="color:#666;">No additional tags.</div></div>`;
  }
  const rows = fields
    .map(
      ([label, value]) =>
        `<div style="display:flex;gap:8px;font-size:12px;line-height:1.4;"><span style="color:#666;min-width:60px;">${escapeHtml(label)}</span><span style="color:#111;">${escapeHtml(truncate(value, 80))}</span></div>`,
    )
    .join('');
  return `<div style="padding:2px 0;">${head}${rows}</div>`;
}

function strOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Best-effort plain-English label for the feature's class.  Walks
 * the standard OSM "primary feature" keys in priority order and
 * Title-Cases the underscore-separated value.  Returns null for a
 * feature with no recognised primary key (rare; unmapped tags-only).
 */
function primaryClassLabel(props: Record<string, unknown>): string | null {
  const PRIMARY_KEYS = [
    'amenity',
    'shop',
    'leisure',
    'tourism',
    'historic',
    'natural',
    'landuse',
    'building',
    'highway',
    'railway',
    'waterway',
    'place',
    'man_made',
    'office',
    'craft',
    'emergency',
    'healthcare',
    'public_transport',
  ];
  for (const k of PRIMARY_KEYS) {
    const v = strOrNull(props[k]);
    if (v) {
      return v
        .split('_')
        .map((p) => (p ? p[0]!.toUpperCase() + p.slice(1) : p))
        .join(' ');
    }
  }
  return null;
}
