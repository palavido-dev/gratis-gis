// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import type {
  AppThemeTokens,
  BasemapData,
  CustomAppData,
  DataLayerData,
  DataLayerSublayer,
  Item,
  MapData,
  MapLayer,
  ThemeItemData,
} from '@gratis-gis/shared-types';
import {
  APP_THEMES,
  DEFAULT_LAYER_ACCESS,
  DEFAULT_LAYER_INTERACTIONS,
  DEFAULT_LAYER_LABELS,
  DEFAULT_LAYER_POPUP,
  DEFAULT_LAYER_RENDERER,
  DEFAULT_LAYER_SCALE,
  DEFAULT_LAYER_SEARCH,
  DEFAULT_LAYER_STYLE,
  DEFAULT_MAP,
  DEFAULT_CUSTOM_APP,
  isCustomAppItem,
  migrateCustomAppData,
  readCustomAppData,
  THEME_STARTERS,
} from '@gratis-gis/shared-types';
import type { CustomBasemap } from '@/lib/custom-basemap';
import { apiFetch, hasSession, publicApiFetch } from '@/lib/api';
import { CustomRuntimeClient } from '../runtime-client';

interface Props {
  params: Promise<{ id: string }>;
}

/**
 * Per-app page title so the runtime tab shows the app's name in
 * the browser tab strip + window title. Mirrors the form-respond
 * page's metadata pattern (#345). Falls back to GratisGIS if the
 * lookup fails.
 */
export async function generateMetadata(props: Props): Promise<Metadata> {
  const params = await props.params;
  try {
    const isAnonymous = !(await hasSession());
    const item = isAnonymous
      ? await publicApiFetch<{ title: string }>(
          `/api/public/items/${params.id}`,
        )
      : await apiFetch<{ title: string }>(`/api/items/${params.id}`);
    return { title: item.title };
  } catch {
    return {};
  }
}

/**
 * Map a basemap item into the CustomBasemap shape MapCanvas
 * consumes. Same helper survey/run + viewer/run inline; extract
 * to a shared util when a fifth caller appears.
 */
function basemapItemToCustomBasemap(
  it: Item<BasemapData>,
): CustomBasemap | null {
  const d = it.data ?? ({} as BasemapData);
  let url: string | undefined;
  let sourceKind: CustomBasemap['sourceKind'];
  let config: Record<string, unknown> | null = null;
  switch (d.kind) {
    case 'style-url':
      if (!d.styleUrl) return null;
      url = d.styleUrl;
      sourceKind = 'vector-style';
      break;
    case 'tile-url':
      if (!d.tileUrl) return null;
      url = d.tileUrl;
      sourceKind = 'xyz';
      break;
    case 'wms':
      if (!d.wmsUrl) return null;
      url = d.wmsUrl;
      sourceKind = 'wms';
      config = (d.wmsConfig ?? null) as Record<string, unknown> | null;
      break;
    default:
      return null;
  }
  return {
    id: it.id,
    orgId: it.orgId,
    label: it.title,
    description: it.description ?? '',
    url,
    sourceKind,
    attribution: d.attribution ?? '',
    thumbnailUrl: d.thumbnailUrl ?? it.thumbnailUrl ?? null,
    config,
    isDefault: false,
  };
}

/**
 * Custom Web App runtime (#261 / #341).
 *
 * Server entry: resolve the app's targets to MapLayer descriptors,
 * fetch basemaps, and hydrate the client runtime. The client
 * component does the actual widget rendering against bound map
 * state (CustomRuntimeClient).
 */
export default async function CustomAppRuntimePage(props: Props) {
  const params = await props.params;
  const isAnonymous = !(await hasSession());
  const fetchItem = <T,>(path: string): Promise<T> =>
    isAnonymous
      ? publicApiFetch<T>(path.replace('/api/items/', '/api/public/items/'))
      : apiFetch<T>(path);
  const fetchItemList = <T,>(path: string): Promise<T> =>
    isAnonymous
      ? publicApiFetch<T>(path.replace('/api/items', '/api/public/items'))
      : apiFetch<T>(path);

  let item: Item<unknown>;
  try {
    item = await fetchItem<Item<unknown>>(`/api/items/${params.id}`);
  } catch (err) {
    if (err instanceof Error && err.message.includes('404')) notFound();
    throw err;
  }
  if (!isCustomAppItem(item)) notFound();

  // Owner / org-admin gate. Anonymous visitors never see the in-app
  // "Back to items" or "Configure" chrome (they have no items list,
  // and no business reaching the designer). Authenticated viewers
  // who happen across a public-shared app also stay chrome-free
  // unless they own the item or are an org admin in its org.
  // Mirrors the canManage check on the item detail page.
  let canManage = false;
  if (!isAnonymous) {
    try {
      const me = await apiFetch<{
        id: string;
        orgId: string;
        orgRole: string;
      }>('/api/users/me');
      canManage =
        me.id === (item as Item<unknown>).ownerId || me.orgRole === 'admin';
    } catch {
      // /me failed (transient or expired token): default-closed. The
      // user can still see the app; they just won't see the manage
      // chrome. They can navigate to /items themselves if they need
      // it.
      canManage = false;
    }
  }

  // #357: migrate v1 (12-col / 48px-row) apps to v2 (24-col / 24px-
  // row) on load so the runtime sees v2 coordinates. Idempotent for
  // already-v2 apps; the migrator no-ops when version === 2.
  const app: CustomAppData = migrateCustomAppData({
    ...DEFAULT_CUSTOM_APP,
    ...((readCustomAppData(item) ?? {}) as Partial<CustomAppData>),
  });

  // Resolve targets to MapLayer descriptors. Each target points at a
  // v3 data_layer sublayer; we look up the layer item, find the
  // matching sublayer, and build a MapLayer that reads features via
  // the per-sublayer geojson endpoint. Targets pointing at deleted
  // / unreadable layers get silently dropped; the runtime renders
  // whatever survives.
  const resolvedTargets: Array<{
    dataLayerId: string;
    layerKey: string;
    title: string;
    mapLayer: MapLayer;
  }> = [];
  for (const t of app.targets) {
    let layerItem: Item<DataLayerData> | null = null;
    try {
      layerItem = await fetchItem<Item<DataLayerData>>(
        `/api/items/${t.dataLayerId}`,
      );
    } catch {
      continue;
    }
    if (!layerItem) continue;
    const dlData = layerItem.data as DataLayerData | undefined;
    if (!dlData || dlData.version !== 3) continue;
    const sub: DataLayerSublayer | undefined = dlData.layers.find(
      (l) => l.id === t.layerKey,
    );
    if (!sub || !sub.geometryType) continue;
    const id = `custom-target:${t.dataLayerId}:${t.layerKey}`;
    const url = `/api/portal/items/${t.dataLayerId}/layers/${t.layerKey}/geojson`;
    resolvedTargets.push({
      dataLayerId: t.dataLayerId,
      layerKey: t.layerKey,
      title: `${layerItem.title} / ${sub.label}`,
      mapLayer: {
        id,
        title: `${layerItem.title} / ${sub.label}`,
        visible: true,
        opacity: 1,
        source: { kind: 'geojson-url', url },
        style: DEFAULT_LAYER_STYLE,
        renderer: DEFAULT_LAYER_RENDERER,
        popup: DEFAULT_LAYER_POPUP,
        interactions: DEFAULT_LAYER_INTERACTIONS,
        labels: DEFAULT_LAYER_LABELS,
        search: DEFAULT_LAYER_SEARCH,
        filter: null,
        scale: DEFAULT_LAYER_SCALE,
        access: DEFAULT_LAYER_ACCESS,
      },
    });
  }

  // #363: collect every map item id we need to fetch. The set is
  // (optional) app default + every Map widget's per-widget mapId
  // override across every page. Unique-ifying with a Set keeps a
  // page with five Map widgets all bound to the same map from
  // re-fetching it five times. A Map widget without an override
  // inherits the app default, which is already in the set.
  const uniqueMapIds = new Set<string>();
  if (app.mapId) uniqueMapIds.add(app.mapId);
  for (const p of app.pages) {
    for (const w of p.widgets) {
      if (w.kind === 'map' && w.config.kind === 'map' && w.config.mapId) {
        uniqueMapIds.add(w.config.mapId);
      }
    }
  }

  // Fetch the org's basemaps (for MapCanvas's basemap library +
  // BasemapGallery), every needed map item, and every theme item
  // (for the themePresetId resolution below) in parallel.
  //
  // Anon list-query caveat: the BFF's anonymous-allowlist
  // (publicRewriteForAnonymousGet) covers /api/items/:id but NOT
  // /api/items?type=... list queries -- those 401 for anon visitors
  // of a public-shared app. The basemap + theme list queries both
  // .catch(() => []) so the page still renders, but the result is a
  // theme fallback to the default tokens and an empty basemap
  // gallery for anonymous viewers, which is wrong for a publicly
  // shared app that intentionally picks a theme.
  //
  // For the theme case we patch the gap below by fetching the
  // configured theme item directly by id (which IS in the anon
  // allowlist). For basemaps we still rely on the list path; anon
  // viewers see the map's own basemap rendered fine, they just
  // can't pop the BasemapGallery to swap. Promoting basemap
  // visibility for anon is a separate decision (we'd need an
  // explicit "include in public list" gate per basemap).
  const [basemapItems, themeItems, ...mapItems] = await Promise.all([
    fetchItemList<Array<Item<BasemapData>>>('/api/items?type=basemap').catch(
      () => [] as Array<Item<BasemapData>>,
    ),
    fetchItemList<Array<Item<ThemeItemData> & { seedKind?: string | null }>>(
      '/api/items?type=theme',
    ).catch(
      () => [] as Array<Item<ThemeItemData> & { seedKind?: string | null }>,
    ),
    ...Array.from(uniqueMapIds).map((id) =>
      fetchItem<Item<MapData>>(`/api/items/${id}`).catch(() => null),
    ),
  ]);

  // Anon-safe per-id theme fetch. When the app's themePresetId is a
  // UUID (a saved theme item ref, as opposed to a built-in starter
  // kind like 'forest') AND the list query came back empty (anon's
  // 401 -> caught -> []), fetch that specific theme item directly.
  // The per-id path goes through the public/items/:id rewrite for
  // anonymous callers, so a publicly-shared app whose theme item is
  // also public renders with the right tokens instead of falling
  // back to the default theme.
  //
  // Idempotent for the authed case: if the list already returned
  // the theme item, this is a no-op pre-check.
  const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (
    typeof app.themePresetId === 'string' &&
    UUID_RE.test(app.themePresetId) &&
    !themeItems.some((t) => t.id === app.themePresetId)
  ) {
    const direct = await fetchItem<
      Item<ThemeItemData> & { seedKind?: string | null }
    >(`/api/items/${app.themePresetId}`).catch(() => null);
    if (direct) themeItems.push(direct);
  }

  const mapDataById = new Map<string, MapData>();
  for (const it of mapItems) {
    if (it && it.data) mapDataById.set(it.id, it.data);
  }

  const basemaps: CustomBasemap[] = basemapItems
    .map(basemapItemToCustomBasemap)
    .filter((b): b is CustomBasemap => b !== null);

  // Build the base MapData every Map widget starts from when it has
  // no per-widget override. Inherits basemap + viewport + non-target
  // layers from the referenced map when app.mapId is set, falls
  // through to DEFAULT_MAP otherwise. Then prepends every resolved
  // target layer so a fresh app with one Map widget shows its
  // targets right away: MapData.layers index 0 is the TOP of the
  // render stack, so targets must come first or an opaque reference
  // layer draws over them.
  const referencedMapData = app.mapId
    ? mapDataById.get(app.mapId) ?? null
    : null;
  const baseLayers = referencedMapData?.layers ?? [];
  const baseMapData: MapData = {
    ...(referencedMapData ?? DEFAULT_MAP),
    layers: [...resolvedTargets.map((t) => t.mapLayer), ...baseLayers],
  };

  // #363: per-Map-widget MapData. When a Map widget has its own
  // config.mapId the runtime uses THAT, not the app default. Targets
  // are prepended (index 0 renders on top) so the per-widget map
  // still picks up the app's target layers above its own layers
  // (otherwise authors lose their feature data when overriding the
  // basemap+viewport host).
  const widgetMapData: Record<string, MapData> = {};
  for (const p of app.pages) {
    for (const w of p.widgets) {
      if (w.kind !== 'map' || w.config.kind !== 'map') continue;
      const overrideId = w.config.mapId;
      if (!overrideId) continue;
      const overrideData = mapDataById.get(overrideId);
      if (!overrideData) continue;
      const overrideLayers = overrideData.layers ?? [];
      widgetMapData[w.id] = {
        ...overrideData,
        layers: [
          ...resolvedTargets.map((t) => t.mapLayer),
          ...overrideLayers,
        ],
      };
    }
  }

  // #22: resolve themePresetId to a token bundle.  Themes are
  // items now; the saved id is either:
  //   - a starter kind ('default'|'slate'|'aurora'|'forest'|'paper')
  //     from apps created before the items refactor.  Match against
  //     the theme item with seedKind === starter kind so an admin
  //     who customized the starter sees their edits at runtime.
  //   - a UUID pointing at a saved theme item the user has access
  //     to (matched by id).
  //   - undefined or unresolvable.  Fall back to APP_THEMES.default
  //     baked into the bundle so the runtime always has tokens.
  const themeTokens = resolveThemeTokens(app.themePresetId, themeItems);

  return (
    <CustomRuntimeClient
      itemId={item.id}
      itemTitle={item.title}
      app={app}
      basemaps={basemaps}
      baseMapData={baseMapData}
      widgetMapData={widgetMapData}
      resolvedTargets={resolvedTargets}
      themeTokens={themeTokens}
      canManage={canManage}
    />
  );
}

/**
 * Resolve a themePresetId saved on a CustomAppData to a concrete
 * AppThemeTokens['tokens'] bundle.  Resolution order (#22):
 *
 *   1. Look up the user's accessible theme items.  Match by:
 *      - seedKind === presetId (legacy starter kind path)
 *      - id === presetId (user-saved theme path)
 *      If a match returns valid tokens, use those.
 *   2. Fall back to APP_THEMES[presetId] (the in-process starter
 *      registry) so an org with no theme items yet still renders.
 *   3. Final fallback: APP_THEMES.default tokens.
 */
function resolveThemeTokens(
  presetId: string | undefined,
  themeItems: Array<Item<ThemeItemData> & { seedKind?: string | null }>,
): AppThemeTokens['tokens'] {
  if (presetId) {
    const match = themeItems.find(
      (t) => t.seedKind === presetId || t.id === presetId,
    );
    const tokens = match?.data?.tokens;
    if (tokens && typeof tokens === 'object') {
      return tokens;
    }
    // Fallback to the in-process registry by starter kind name.
    const starter = THEME_STARTERS.find((s) => s.kind === presetId);
    if (starter) return starter.tokens;
  }
  return APP_THEMES.default.tokens;
}

export const dynamic = 'force-dynamic';
