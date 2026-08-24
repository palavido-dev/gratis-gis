// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import { useCallback, useEffect, useState } from 'react';
import type maplibregl from 'maplibre-gl';
import type { OfflineAreaWithPackage } from '@gratis-gis/shared-types';
import {
  canStoreOfflineBasemap,
  downloadOfflineBasemap,
  offlineBasemapStyle,
  removeOfflineBasemap,
  storedBasemapSize,
} from '@/lib/offline-basemap';

/**
 * The field runtime's side of the prepared offline basemap (#71).
 *
 * Everything here fails soft. A collector who cannot reach the
 * portal, whose browser has no Cache Storage, or whose deployment has
 * no prepared area, gets exactly the behaviour they had before: the
 * ordinary online basemap. Nothing in this hook is allowed to be the
 * reason a field map does not draw.
 */

export interface OfflineBasemapState {
  /** Areas the author has prepared, with their current build. */
  areas: OfflineAreaWithPackage[];
  /** Area id whose archive is on this device, if any. */
  storedAreaId: string | null;
  /** Size of the stored archive in bytes. */
  storedBytes: number | null;
  /** Style to hand MapCanvas, or null to leave the basemap alone. */
  styleOverride: {
    tag: string;
    style: maplibregl.StyleSpecification;
  } | null;
  /** Bytes received so far while a download is running. */
  downloading: { areaId: string; received: number; total: number | null } | null;
  error: string | null;
  supported: boolean;
  download: (areaId: string, packageId: string) => Promise<void>;
  remove: (areaId: string) => Promise<void>;
}

export function useOfflineBasemap(itemId: string): OfflineBasemapState {
  const [areas, setAreas] = useState<OfflineAreaWithPackage[]>([]);
  const [storedAreaId, setStoredAreaId] = useState<string | null>(null);
  const [storedBytes, setStoredBytes] = useState<number | null>(null);
  const [styleOverride, setStyleOverride] =
    useState<OfflineBasemapState['styleOverride']>(null);
  const [downloading, setDownloading] =
    useState<OfflineBasemapState['downloading']>(null);
  const [error, setError] = useState<string | null>(null);
  const supported = canStoreOfflineBasemap();

  /**
   * Adopt whichever archive is already on the device.
   *
   * Runs against the areas the server just described, so an archive
   * whose area the author has since deleted is not adopted: it would
   * render a basemap the deployment no longer claims, with no way for
   * the collector to tell why it looked different from a colleague's.
   */
  const adoptStored = useCallback(
    async (known: OfflineAreaWithPackage[]) => {
      for (const entry of known) {
        const size = await storedBasemapSize(itemId, entry.area.id);
        if (size === null) continue;
        try {
          const style = await offlineBasemapStyle(itemId, entry.area.id);
          if (!style) continue;
          setStoredAreaId(entry.area.id);
          setStoredBytes(size);
          setStyleOverride({ tag: `${itemId}:${entry.area.id}`, style });
        } catch {
          // A corrupt archive should not take the map down with it.
          // Drop it and fall through to the online basemap; the
          // collector can download again when they have signal.
          await removeOfflineBasemap(itemId, entry.area.id);
        }
        return;
      }
      setStoredAreaId(null);
      setStoredBytes(null);
      setStyleOverride(null);
    },
    [itemId],
  );

  useEffect(() => {
    if (!supported) return;
    let cancelled = false;
    void (async () => {
      let known: OfflineAreaWithPackage[] = [];
      try {
        const res = await fetch(`/api/portal/items/${itemId}/offline-areas`);
        if (res.ok) {
          const body = (await res.json()) as { areas: OfflineAreaWithPackage[] };
          known = body.areas;
        }
      } catch {
        // Offline, which is the normal case for a collector opening a
        // deployment they already downloaded. Fall through with an
        // empty list; adoptStored below has nothing to match against,
        // so try the one area we might have.
      }
      if (cancelled) return;
      setAreas(known);
      await adoptStored(known);
    })();
    return () => {
      cancelled = true;
    };
  }, [itemId, supported, adoptStored]);

  const download = useCallback(
    async (areaId: string, packageId: string) => {
      setError(null);
      setDownloading({ areaId, received: 0, total: null });
      try {
        await downloadOfflineBasemap(itemId, areaId, packageId, (p) =>
          setDownloading({
            areaId,
            received: p.receivedBytes,
            total: p.totalBytes,
          }),
        );
        const style = await offlineBasemapStyle(itemId, areaId);
        const size = await storedBasemapSize(itemId, areaId);
        if (style) {
          setStoredAreaId(areaId);
          setStoredBytes(size);
          setStyleOverride({ tag: `${itemId}:${areaId}`, style });
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'The download failed.');
        // Leave nothing half-stored: a partial archive that survives
        // reads as "downloaded" on the next open and then fails to
        // draw, in the field, with no network to fix it.
        await removeOfflineBasemap(itemId, areaId);
      } finally {
        setDownloading(null);
      }
    },
    [itemId],
  );

  const remove = useCallback(
    async (areaId: string) => {
      await removeOfflineBasemap(itemId, areaId);
      if (storedAreaId === areaId) {
        setStoredAreaId(null);
        setStoredBytes(null);
        setStyleOverride(null);
      }
    },
    [itemId, storedAreaId],
  );

  return {
    areas,
    storedAreaId,
    storedBytes,
    styleOverride,
    downloading,
    error,
    supported,
    download,
    remove,
  };
}
