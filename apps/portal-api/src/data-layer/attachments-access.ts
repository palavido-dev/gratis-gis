// SPDX-License-Identifier: AGPL-3.0-or-later
import { ForbiddenException, NotFoundException } from '@nestjs/common';

import type { AuthUser } from '../auth/auth-sync.service.js';
import type { DataLayerEngine } from '../engine/data-layer.js';
import type { ItemsService } from '../items/items.service.js';
import {
  featureScopeFilter,
  isScopeLimited,
  type FeatureScopeFilter,
  type SharingService,
} from '../items/sharing.service.js';

/**
 * What a caller may reach on a layer's attachments: the same feature
 * scope (own rows, geo limit) the feature routes apply. An
 * attachment belongs to a feature, so it is visible exactly when its
 * feature is.
 */
export interface AttachmentAccess {
  shareScope: FeatureScopeFilter;
  /** True when shareScope narrows the caller at all. */
  limited: boolean;
  isTable: boolean;
}

/**
 * Verify the item exists, is a v3 data_layer with this layer in
 * its schema, and the caller has the right permission level.
 * #224: list/download uses canDownload (not mere canRead);
 * writes also honour attachmentsEnabled on the sublayer.
 */
export async function assertAttachmentAccess(
  items: ItemsService,
  sharing: SharingService,
  user: AuthUser,
  itemId: string,
  layerId: string,
  mode: 'download' | 'write',
): Promise<AttachmentAccess> {
  const item = await items.get(user, itemId);
  if (item.type !== 'data_layer') {
    throw new NotFoundException('Not a data_layer item');
  }
  const data = item.data as {
    version?: number;
    layers?: Array<{
      id: string;
      attachmentsEnabled?: boolean;
      editingEnabled?: boolean;
      editingPolicy?: 'all-rows' | 'own-rows-only';
      geometryType?: string | null;
    }>;
  } | null;
  if (data?.version !== 3) {
    throw new NotFoundException(
      'Attachments are supported on v3 feature-services only',
    );
  }
  const layer = (data.layers ?? []).find((l) => l.id === layerId);
  if (!layer) {
    throw new NotFoundException(
      `Layer ${layerId} is not part of this item's schema`,
    );
  }
  if (mode === 'write') {
    if (layer.attachmentsEnabled === false) {
      throw new ForbiddenException(
        'Attachments are disabled on this layer',
      );
    }
    await items.assertCanEdit(user, itemId);
    // A frozen layer takes no attachment changes from share holders.
    items.assertLayerEditingEnabled(user, item, layer);
  }
  const shares = (
    item as { shares?: Parameters<SharingService['canDownload']>[2] }
  ).shares ?? [];
  // download: same tier as CSV / GeoParquet (#224).
  if (mode === 'download' && !sharing.canDownload(user, item, shares)) {
    throw new ForbiddenException(
      'Download permission is required to access attachments',
    );
  }
  const scope = await sharing.featureScopeFor(user, item, shares, {
    action: mode === 'write' ? 'edit' : 'read',
    layerPolicy: layer.editingPolicy ?? 'all-rows',
  });
  return {
    shareScope: featureScopeFilter(scope),
    limited: isScopeLimited(scope),
    isTable: layer.geometryType === null,
  };
}

/** Batch size for the visibility lookup; keeps the ANY() list small. */
const VISIBLE_CHUNK = 500;

/**
 * The subset of `featureIds` the caller can reach under `access`.
 * Ids that are not uuids, do not exist, or fall outside the caller's
 * own-rows or geo limit are left out.
 */
export async function visibleFeatureIds(
  engine: DataLayerEngine,
  itemId: string,
  layerId: string,
  featureIds: readonly string[],
  access: Pick<AttachmentAccess, 'shareScope' | 'isTable'>,
): Promise<Set<string>> {
  const out = new Set<string>();
  const ids = Array.from(new Set(featureIds)).filter((id) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id),
  );
  for (let i = 0; i < ids.length; i += VISIBLE_CHUNK) {
    const chunk = ids.slice(i, i + VISIBLE_CHUNK);
    const res = await engine.listFeatures({
      itemId,
      layerId,
      entityIds: chunk,
      ...access.shareScope,
      ...(access.isTable ? { isTable: true } : {}),
    });
    for (const f of res.features) out.add(String(f.id));
  }
  return out;
}

/**
 * 404 unless the caller can reach `featureId` under `access`. Skips
 * the lookup for an unscoped caller, whose reach is the whole layer.
 */
export async function assertFeatureVisible(
  engine: DataLayerEngine,
  itemId: string,
  layerId: string,
  featureId: string,
  access: AttachmentAccess,
): Promise<void> {
  if (!access.limited) return;
  const visible = await visibleFeatureIds(engine, itemId, layerId, [featureId], access);
  if (!visible.has(featureId)) {
    throw new NotFoundException('Feature not found');
  }
}
