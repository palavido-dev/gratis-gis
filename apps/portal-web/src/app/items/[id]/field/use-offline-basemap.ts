// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import { useCallback, useEffect, useState } from 'react';
import type * as maplibregl from 'maplibre-gl';
import type { OfflineAreaWithPackage } from '@gratis-gis/shared-types';
import {
  canStoreOfflineBasemap,
  offlineBasemapStyle,
  removeOfflineBasemap,
  storedBasemapSize,
} from '@/lib/offline-basemap';
import {
  chooseOfflineAreas,
  listStoredBasemapAreaIds,
  loadKnownAreas,
  saveKnownAreas,
} from '@/lib/offline-basemap-areas';

/**
 * The field runtime's side of the prepared offline basemap (#71).
 *
 * Everything here fails soft. A collector who cannot reach the
 * portal, whose browser has no Cache Storage, or whose deployment has
 * no prepared area, gets exactly the behaviour they had before: the
 * ordinary online basemap. Nothing in this hook is allowed to be the
 * reason a field map does not draw.
 *
 * All prepared areas are treated together: the download fetches every
 * ready archive and the style draws every stored one, so a
 * deployment split into north-crew and south-crew areas works from
 * either end. The archives are disjoint ground, so drawing them all
 * costs nothing where a device only ever visits one.
 *
 * The actual downloading happens in offline-download.ts as part of
 * the one "Download for offline" flow; this hook owns discovery,
 * adoption of whatever is already on the device, and removal.
 */

export interface OfflineBasemapState {
  /** Areas the author has prepared, with their current build. */
  areas: OfflineAreaWithPackage[];
  /** Area ids whose archives are on this device. */
  storedAreaIds: string[];
  /** Combined size of the stored archives, in bytes. */
  storedBytes: number | null;
  /** Style to hand MapCanvas, or null to leave the basemap alone. */
  styleOverride: {
    tag: string;
    style: maplibregl.StyleSpecification;
  } | null;
  supported: boolean;
  remove: (areaId: string) => Promise<void>;
  /** Re-read the areas and adopt whatever is now on the device. */
  reload: () => Promise<void>;
}

export function useOfflineBasemap(itemId: string): OfflineBasemapState {
  const [areas, setAreas] = useState<OfflineAreaWithPackage[]>([]);
  const [storedAreaIds, setStoredAreaIds] = useState<string[]>([]);
  const [storedBytes, setStoredBytes] = useState<number | null>(null);
  const [styleOverride, setStyleOverride] =
    useState<OfflineBasemapState['styleOverride']>(null);
  /**
   * Whether this device can hold an archive.
   *
   * Resolved in an effect rather than during render. Computing it
   * inline reads the `caches` global while the component is also
   * being rendered on the server, where it does not exist, and the
   * first version of this hook then used that value to gate its own
   * data fetch. The result was a panel that rendered nothing, with
   * no request in any log to explain it. The fetch below is
   * deliberately NOT gated on this: knowing what the author
   * prepared is useful even on a device that cannot store it.
   */
  const [supported, setSupported] = useState(false);
  useEffect(() => {
    setSupported(canStoreOfflineBasemap());
  }, []);

  /**
   * Adopt the given stored archives. Which ones is decided by
   * chooseOfflineAreas: the server's list when it answered, every
   * archive on the device when it did not.
   */
  const adoptStored = useCallback(
    async (candidateIds: string[]) => {
      const clear = () => {
        setStoredAreaIds([]);
        setStoredBytes(null);
        setStyleOverride(null);
      };
      const sizes = await Promise.all(
        candidateIds.map((id) => storedBasemapSize(itemId, id)),
      );
      const stored = candidateIds.filter((_, i) => sizes[i] !== null);
      if (stored.length === 0) {
        clear();
        return;
      }
      try {
        const built = await offlineBasemapStyle(itemId, stored);
        // Drop only the archives that are actually corrupt. The good
        // ones stay usable, and with no signal they cannot be fetched
        // again.
        if (built && built.corruptAreaIds.length > 0) {
          await Promise.all(
            built.corruptAreaIds.map((id) => removeOfflineBasemap(itemId, id)),
          );
        }
        if (!built || !built.style) {
          clear();
          return;
        }
        const included = new Set(built.includedAreaIds);
        setStoredAreaIds(built.includedAreaIds);
        setStoredBytes(
          candidateIds.reduce<number>(
            (sum, id, i) => sum + (included.has(id) ? (sizes[i] ?? 0) : 0),
            0,
          ) || null,
        );
        const style = built.style;
        setStyleOverride({
          // Joined ids so adding or removing an area changes the tag
          // and MapCanvas knows to swap styles.
          tag: `${itemId}:${built.includedAreaIds.join('+')}`,
          style,
        });
      } catch {
        // Not a corrupt archive (those are handled above) but some
        // other failure. Keep the archives and fall through to the
        // online basemap for now.
        clear();
      }
    },
    [itemId],
  );

  const load = useCallback(async () => {
    let server: OfflineAreaWithPackage[] | null = null;
    try {
      const res = await fetch(
        `/api/portal/items/${encodeURIComponent(itemId)}/offline-areas`,
      );
      if (res.ok) {
        const body = (await res.json()) as { areas: OfflineAreaWithPackage[] };
        server = body.areas;
        void saveKnownAreas(itemId, server);
      }
    } catch {
      // Offline, which is the normal case for a collector opening a
      // deployment they already downloaded.
    }
    const [saved, storedIds] = await Promise.all([
      server ? Promise.resolve(null) : loadKnownAreas(itemId),
      listStoredBasemapAreaIds(itemId),
    ]);
    const chosen = chooseOfflineAreas({ server, saved, storedIds });
    setAreas(chosen.areas);
    await adoptStored(chosen.adoptIds);
  }, [itemId, adoptStored]);

  useEffect(() => {
    void load();
  }, [load]);

  const remove = useCallback(
    async (areaId: string) => {
      await removeOfflineBasemap(itemId, areaId);
      await load();
    },
    [itemId, load],
  );

  return {
    areas,
    storedAreaIds,
    storedBytes,
    styleOverride,
    supported,
    remove,
    reload: load,
  };
}
