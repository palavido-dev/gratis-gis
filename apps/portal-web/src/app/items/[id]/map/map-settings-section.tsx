// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import { useState } from 'react';
import { ChevronDown, ChevronRight, SlidersHorizontal } from 'lucide-react';
import type { MapData } from '@gratis-gis/shared-types';

/**
 * Map-wide settings section (#74 follow-up). Consolidates pickers
 * that affect the map as a whole -- view scope, default extent,
 * geocoding source -- into one labeled section instead of leaving
 * them disjointed across the top-bar (view scope + default extent
 * inline) and the right-side toolbar (search-source icon).
 *
 * Always opens expanded so new users see the configuration knobs
 * without hunting; the header is collapsible because future
 * additions (embed config, print options, refresh interval, ...)
 * may eventually make this section tall enough to want a fold.
 *
 * Mirrors the "Related items" section pattern already in use on
 * the detail page so the visual rhythm stays consistent.
 *
 * Setters are wired through from the editor; this component
 * doesn't own dirty-state. The editor's existing dirty-tracking
 * (markDirty inside each setter) keeps Save behavior consistent
 * with the previous inline pickers.
 */
interface Props {
  canEdit: boolean;
  map: MapData;
  geoBoundaries: Array<{ id: string; title: string }>;
  availableGeocoders: Array<{
    id: string;
    title: string;
    kind: 'internal' | 'arcgis';
  }>;
  setClipBoundaryId: (id: string) => void;
  setDefaultExtentBoundaryId: (id: string) => void;
  setGeocoderId: (id: string | null) => void;
}

export function MapSettingsSection({
  canEdit,
  map,
  geoBoundaries,
  availableGeocoders,
  setClipBoundaryId,
  setDefaultExtentBoundaryId,
  setGeocoderId,
}: Props) {
  const [open, setOpen] = useState(true);

  const clipValue = map.clipBoundaryId ?? '';
  const extentValue = map.defaultExtentBoundaryId ?? '';
  const geocoderValue = map.search?.geocoderId ?? '';

  // Compose a one-line summary that shows next to the title when
  // the section is collapsed. Lets the author see the current
  // state without expanding.
  const summary = composeSummary({
    map,
    geoBoundaries,
    availableGeocoders,
  });

  return (
    <section className="rounded-lg border border-border bg-surface-1 shadow-card">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-surface-2"
      >
        <SlidersHorizontal className="h-4 w-4 shrink-0 text-muted" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <h3 className="text-sm font-semibold text-ink-0">Map settings</h3>
            <span className="text-xs text-muted">
              How this map presents itself and behaves when used.
            </span>
          </div>
          {!open ? (
            <p className="mt-0.5 truncate text-xs text-muted">{summary}</p>
          ) : null}
        </div>
        {open ? (
          <ChevronDown className="h-4 w-4 shrink-0 text-muted" />
        ) : (
          <ChevronRight className="h-4 w-4 shrink-0 text-muted" />
        )}
      </button>

      {open ? (
        <div className="flex flex-col gap-4 border-t border-border p-4">
          <SettingRow
            label="View scope"
            description={
              <>
                Clip every layer in this map to a boundary so only
                features inside it render.{' '}
                <strong>Not access control:</strong> the underlying
                layers still serve their full data.
              </>
            }
            footerHint={
              geoBoundaries.length === 0
                ? 'Create a boundary item to use it as a view scope.'
                : null
            }
          >
            <select
              value={clipValue}
              disabled={!canEdit || geoBoundaries.length === 0}
              onChange={(e) => setClipBoundaryId(e.target.value)}
              className="h-9 w-full rounded-md border border-border bg-surface-1 px-2 text-sm text-ink-1 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <option value="">(no clip)</option>
              {geoBoundaries.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.title}
                </option>
              ))}
            </select>
          </SettingRow>

          <SettingRow
            label="Default extent"
            description={
              <>
                The frame the map opens to on first load. Falls back
                to the map&rsquo;s saved camera when unset.
              </>
            }
          >
            <select
              value={extentValue}
              disabled={!canEdit || geoBoundaries.length === 0}
              onChange={(e) => setDefaultExtentBoundaryId(e.target.value)}
              className="h-9 w-full rounded-md border border-border bg-surface-1 px-2 text-sm text-ink-1 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <option value="">(use saved extent)</option>
              {geoBoundaries.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.title}
                </option>
              ))}
            </select>
          </SettingRow>

          <SettingRow
            label="Search source"
            description={
              <>
                Where the search bar looks up addresses and places.
                Default is Nominatim (OpenStreetMap). Internal
                geocoders search your own data.
              </>
            }
            footerHint={
              availableGeocoders.length === 0
                ? 'Create a Geocoding service item to search your own data here.'
                : null
            }
          >
            <select
              value={geocoderValue}
              disabled={!canEdit}
              onChange={(e) => setGeocoderId(e.target.value || null)}
              className="h-9 w-full rounded-md border border-border bg-surface-1 px-2 text-sm text-ink-1 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <option value="">Default (Nominatim)</option>
              {availableGeocoders.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.title} {g.kind === 'arcgis' ? '(ArcGIS)' : '(internal)'}
                </option>
              ))}
            </select>
          </SettingRow>
        </div>
      ) : null}
    </section>
  );
}

/**
 * One labeled row inside the settings grid. Title + short
 * explanation above the control + an optional footer hint below
 * for empty-list nudges.
 */
function SettingRow({
  label,
  description,
  children,
  footerHint,
}: {
  label: string;
  description: React.ReactNode;
  children: React.ReactNode;
  footerHint?: string | null;
}) {
  return (
    <div className="space-y-1.5">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-muted">
          {label}
        </p>
        <p className="mt-0.5 text-xs text-muted">{description}</p>
      </div>
      {children}
      {footerHint ? (
        <p className="text-2xs text-muted">{footerHint}</p>
      ) : null}
    </div>
  );
}

/**
 * One-line summary of current settings for the collapsed header.
 * Picks the chosen boundary / geocoder titles when present so the
 * user can see at a glance what's set without expanding.
 */
function composeSummary({
  map,
  geoBoundaries,
  availableGeocoders,
}: {
  map: MapData;
  geoBoundaries: Array<{ id: string; title: string }>;
  availableGeocoders: Array<{ id: string; title: string }>;
}): string {
  const parts: string[] = [];
  const clipId = map.clipBoundaryId;
  const clipTitle = clipId
    ? (geoBoundaries.find((g) => g.id === clipId)?.title ?? '(deleted)')
    : 'none';
  parts.push(`View scope: ${clipTitle}`);
  const extentId = map.defaultExtentBoundaryId;
  const extentTitle = extentId
    ? (geoBoundaries.find((g) => g.id === extentId)?.title ?? '(deleted)')
    : 'saved camera';
  parts.push(`Default extent: ${extentTitle}`);
  const geocoderId = map.search?.geocoderId;
  const geocoderTitle = geocoderId
    ? (availableGeocoders.find((g) => g.id === geocoderId)?.title ??
      '(deleted)')
    : 'Nominatim';
  parts.push(`Search: ${geocoderTitle}`);
  return parts.join(' · ');
}
