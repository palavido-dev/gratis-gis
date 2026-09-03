// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import type {
  BasemapData,
  GeoBoundaryData,
  Item,
  MapData,
} from '@gratis-gis/shared-types';
import { DEFAULT_MAP } from '@gratis-gis/shared-types';
import { apiFetch } from '@/lib/api';
import { basemapItemToCustomBasemap } from '@/lib/basemap-item';
import type { CustomBasemap } from '@/lib/custom-basemap';
import { MapEditor } from '../../items/[id]/map/map-editor';

/**
 * #187 scratch maps: a map you can just OPEN. No item is created
 * until the user hits Save and names it; until then everything is
 * in-browser state. Perfect for "throw a few layers on a map and
 * look at them" moments. ?add=<itemId> pre-adds a portal item's
 * layers on load, which is what the item pages' "Add to map ->
 * New map" action links to (#185).
 */
export const metadata: Metadata = {
  title: 'New map',
};

interface Props {
  searchParams?: Promise<{ add?: string; layer?: string }>;
}

export default async function NewScratchMapPage(props: Props) {
  const searchParams = await props.searchParams;
  const addItemId = searchParams?.add;
  const addLayerKey = searchParams?.layer;

  let me: {
    id: string;
    orgId: string;
    orgRole: string;
    fullName?: string | null;
    username?: string | null;
  };
  try {
    me = await apiFetch<typeof me>('/api/users/me');
  } catch {
    // Anonymous visitors have no portal items to put on a map and
    // no way to save one; the items route's auth flow handles the
    // sign-in redirect, so treat this as not-found rather than
    // building a broken editor.
    notFound();
  }

  const [basemaps, geoBoundaries] = await Promise.all([
    // full=1: basemapItemToCustomBasemap reads each row's tile /
    // style config out of data, which the list strips by default.
    // The geo_boundary list below stays lite: only id + title feed
    // the Default Extent picker.
    apiFetch<Array<Item<BasemapData>>>('/api/items?type=basemap&full=1')
      .then((items) =>
        items
          .map(basemapItemToCustomBasemap)
          .filter((b): b is CustomBasemap => b !== null),
      )
      .catch(() => [] as CustomBasemap[]),
    apiFetch<Array<Item<GeoBoundaryData>>>('/api/items?type=geo_boundary').catch(
      () => [] as Array<Item<GeoBoundaryData>>,
    ),
  ]);

  const initial: MapData = { ...DEFAULT_MAP };

  return (
    <MapEditor
      scratch
      itemId="scratch"
      itemTitle="Untitled map"
      initial={initial}
      canEdit
      basemaps={basemaps}
      geoBoundaries={geoBoundaries.map((g) => ({ id: g.id, title: g.title }))}
      currentUser={{
        id: me.id,
        displayName:
          (me.fullName && me.fullName.trim().length > 0
            ? me.fullName
            : me.username) ?? 'You',
      }}
      {...(addItemId ? { addItemId } : {})}
      {...(addItemId && addLayerKey ? { addLayerKey } : {})}
    />
  );
}
