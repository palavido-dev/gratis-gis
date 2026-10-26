// SPDX-License-Identifier: AGPL-3.0-or-later
import { ForbiddenException, NotFoundException } from '@nestjs/common';

import type { AuthUser } from '../auth/auth-sync.service.js';
import type { ItemsService } from '../items/items.service.js';
import type { SharingService } from '../items/sharing.service.js';

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
): Promise<void> {
  const item = await items.get(user, itemId);
  if (item.type !== 'data_layer') {
    throw new NotFoundException('Not a data_layer item');
  }
  const data = item.data as {
    version?: number;
    layers?: Array<{ id: string; attachmentsEnabled?: boolean }>;
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
    return;
  }
  // download: same tier as CSV / GeoParquet (#224).
  const shares = (
    item as { shares?: Parameters<SharingService['canDownload']>[2] }
  ).shares ?? [];
  if (!sharing.canDownload(user, item, shares)) {
    throw new ForbiddenException(
      'Download permission is required to access attachments',
    );
  }
}
