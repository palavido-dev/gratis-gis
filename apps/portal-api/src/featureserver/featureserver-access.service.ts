// SPDX-License-Identifier: AGPL-3.0-or-later
import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { ItemShare, Prisma } from '@prisma/client';

import type { AuthUser } from '../auth/auth-sync.service.js';
import { publicListScope, scopedWhere } from '../common/list-scope.js';
import { ItemsService } from '../items/items.service.js';
import { SharingService, featureScopeFilter } from '../items/sharing.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { PUBLIC_TIER_SELECT, publicTierGeoLimit } from '../public/public-geo-limit.js';
import { esriSchema } from './esri-fields.js';
import { esriGeometryType } from './esri-geometry.js';
import type { QueryLayer } from './featureserver-query.service.js';

/** A sublayer as stored in a v3 data layer item. */
export interface StoredLayer {
  id: string;
  label?: string;
  name?: string;
  geometryType?: string | null;
  fields?: unknown;
  editingPolicy?: 'all-rows' | 'own-rows-only';
  editingEnabled?: unknown;
  bbox?: unknown;
}

export interface ResolvedService {
  itemId: string;
  title: string;
  description: string;
  /** Sublayers with their FeatureServer numbers, in number order. */
  layers: Array<{ index: number; layer: StoredLayer }>;
  user: AuthUser | null;
  item: Prisma.ItemGetPayload<{ include: { shares: true } }> | null;
  shares: ItemShare[];
  publicGeoBoundaryId: string | null;
}

const UUID_TAIL = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/**
 * The service name in a FeatureServer URL: the item's title made safe
 * for a URL, then its id, so Pro's catalog shows something readable
 * while the id alone decides which item is meant.
 */
export function serviceName(itemId: string, title: string): string {
  const slug = title
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60);
  return slug.length > 0 ? `${slug}_${itemId}` : itemId;
}

/** The item id inside a service name, or null. */
export function itemIdFromServiceName(name: string): string | null {
  const m = UUID_TAIL.exec(name);
  if (!m) return null;
  const rest = name.slice(0, name.length - m[1]!.length);
  if (rest !== '' && !rest.endsWith('_')) return null;
  return m[1]!.toLowerCase();
}

function storedLayers(data: unknown): StoredLayer[] {
  const d = data as { version?: unknown; layers?: unknown } | null;
  if (!d || d.version !== 3 || !Array.isArray(d.layers)) return [];
  return (d.layers as StoredLayer[]).filter((l) => typeof l?.id === 'string' && l.id.length > 0);
}

/** Most services the service list names. */
const MAX_LISTED = 5000;

/**
 * Who may read what through the FeatureServer interface. Nothing new
 * is decided here: a signed-in caller goes through ItemsService.get
 * and SharingService.featureScopeFor, the same checks as every other
 * feature read, and an anonymous caller sees public items only, under
 * the public-tier boundary, the same as the public OGC API.
 */
@Injectable()
export class FeatureServerAccessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly items: ItemsService,
    private readonly sharing: SharingService,
  ) {}

  /** The services the caller can open. `?org=` lists that org's public ones. */
  async listServices(
    user: AuthUser | null,
    orgSlug: string | undefined,
  ): Promise<Array<{ name: string; type: 'FeatureServer' }>> {
    let where: Prisma.ItemWhereInput;
    if (orgSlug || !user) {
      const { scope } = await publicListScope(this.prisma, { slug: orgSlug });
      where = scopedWhere({ type: 'data_layer', access: 'public', deletedAt: null }, scope);
    } else {
      where = { AND: [{ type: 'data_layer', deletedAt: null }, this.sharing.listWhere(user)] };
    }
    const rows = await this.prisma.item.findMany({
      where,
      select: { id: true, title: true, data: true },
      orderBy: { title: 'asc' },
      take: MAX_LISTED,
    });
    return rows
      .filter((r) => storedLayers(r.data).length > 0)
      .map((r) => ({ name: serviceName(r.id, r.title), type: 'FeatureServer' as const }));
  }

  /** One service, or 404 when it does not exist or the caller may not read it. */
  async service(user: AuthUser | null, name: string): Promise<ResolvedService> {
    const itemId = itemIdFromServiceName(name);
    if (!itemId) throw new NotFoundException('Service not found.');
    if (user) {
      // ItemsService.get answers 404 for an item the caller must not
      // learn exists, which is what this answer must be too.
      let item;
      try {
        item = await this.items.get(user, itemId);
      } catch (err) {
        if (err instanceof NotFoundException) throw new NotFoundException('Service not found.');
        throw err;
      }
      if (item.type !== 'data_layer') throw new NotFoundException('Service not found.');
      const layers = storedLayers(item.data);
      if (layers.length === 0) throw new NotFoundException('Service not found.');
      const withShares = item as typeof item & { shares?: ItemShare[] };
      return {
        itemId: item.id,
        title: item.title,
        description: item.description ?? '',
        layers: await this.numbered(item.id, layers),
        user,
        item: item as ResolvedService['item'],
        shares: withShares.shares ?? [],
        publicGeoBoundaryId: null,
      };
    }
    const item = await this.prisma.item.findFirst({
      where: { id: itemId, type: 'data_layer', access: 'public', deletedAt: null },
      select: { id: true, title: true, description: true, data: true, ...PUBLIC_TIER_SELECT },
    });
    const layers = item ? storedLayers(item.data) : [];
    if (!item || layers.length === 0) throw new NotFoundException('Service not found.');
    return {
      itemId: item.id,
      title: item.title,
      description: item.description ?? '',
      layers: await this.numbered(item.id, layers),
      user: null,
      item: null,
      shares: [],
      publicGeoBoundaryId: item.publicGeoBoundaryId ?? null,
    };
  }

  /**
   * True when the caller may edit this layer through the
   * FeatureServer: signed in with a key that is not read-only, with
   * edit rights on the item, and the layer not frozen for them. The
   * write itself checks again; this only decides what the layer
   * document offers.
   */
  canEdit(svc: ResolvedService, stored: StoredLayer): boolean {
    const user = svc.user;
    if (!user || !svc.item || user.apiKeyReadOnly === true) return false;
    if (!this.sharing.canEdit(user, svc.item, svc.shares)) return false;
    try {
      this.items.assertLayerEditingEnabled(user, svc.item, stored);
    } catch {
      return false;
    }
    return true;
  }

  /**
   * A layer by its FeatureServer number, with the caller's clips.
   * `edit` resolves the write scope instead of the read scope, after
   * the same edit checks the portal's feature routes make.
   */
  async layer(
    svc: ResolvedService,
    indexParam: string,
    action: 'read' | 'edit' = 'read',
  ): Promise<{ index: number; stored: StoredLayer; query: QueryLayer }> {
    if (!/^\d{1,6}$/.test(indexParam)) throw new NotFoundException('Layer not found.');
    const index = Number(indexParam);
    const hit = svc.layers.find((l) => l.index === index);
    if (!hit) throw new NotFoundException('Layer not found.');
    const stored = hit.layer;
    const query: QueryLayer = {
      scope: `data_layer:${svc.itemId}:${stored.id}`,
      geometryType: esriGeometryType(stored.geometryType === undefined ? 'polygon' : stored.geometryType),
      schema: esriSchema(stored.fields),
    };
    if (action === 'edit') {
      if (!svc.user || !svc.item) throw new ForbiddenException('Sign in to edit this layer.');
      if (svc.user.apiKeyReadOnly === true) {
        throw new ForbiddenException('This API key is read-only. Sign in with a key that can make changes.');
      }
      await this.items.assertCanEdit(svc.user, svc.itemId);
      this.items.assertLayerEditingEnabled(svc.user, svc.item, stored);
    }
    if (svc.user && svc.item) {
      const scope = await this.sharing.featureScopeFor(svc.user, svc.item, svc.shares, {
        action,
        layerPolicy: stored.editingPolicy ?? 'all-rows',
      });
      const clips = featureScopeFilter(scope);
      if (clips.geoLimit) query.geoLimit = clips.geoLimit;
      if (clips.ownRowsOnly) query.ownRowsOnly = clips.ownRowsOnly;
    } else {
      const clip = await publicTierGeoLimit(this.prisma, svc.publicGeoBoundaryId);
      if (clip !== undefined) query.geoLimit = clip;
    }
    return { index, stored, query };
  }

  /**
   * FeatureServer numbers for an item's sublayers. A number is given
   * the first time a layer is seen and never changes, so a project
   * that points at layer 2 keeps pointing at the same layer after
   * other layers are added or removed.
   */
  private async numbered(
    itemId: string,
    layers: StoredLayer[],
  ): Promise<Array<{ index: number; layer: StoredLayer }>> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const rows = await this.prisma.featureServerLayer.findMany({
        where: { itemId },
        select: { layerId: true, layerIndex: true },
      });
      const byId = new Map(rows.map((r) => [r.layerId, r.layerIndex]));
      const missing = layers.filter((l) => !byId.has(l.id));
      if (missing.length === 0) {
        return layers
          .map((layer) => ({ index: byId.get(layer.id)!, layer }))
          .sort((a, b) => a.index - b.index);
      }
      let next = rows.reduce((m, r) => Math.max(m, r.layerIndex), -1) + 1;
      // Two first requests at once may pick the same number; the
      // unique index keeps one and the loop numbers the other again.
      await this.prisma.featureServerLayer.createMany({
        data: missing.map((l) => ({ itemId, layerId: l.id, layerIndex: next++ })),
        skipDuplicates: true,
      });
    }
    throw new Error(`Could not number the layers of item ${itemId}.`);
  }
}
