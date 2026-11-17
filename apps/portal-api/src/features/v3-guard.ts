// SPDX-License-Identifier: AGPL-3.0-or-later
import { BadRequestException } from '@nestjs/common';

/**
 * Refuse a v3 (multi-layer) data_layer on a v1/v2 route.
 *
 * The legacy `/items/:id/features` routes and `POST /items/:id/ingest`
 * write a per-item `fs_<id>` table and stamp `item.data` with the v2
 * shape. Run against a v3 item they flipped it to `version: 2` (or
 * replaced `layers[]` outright), after which every v3 route 404ed and
 * field sync stopped. v3 items have their own per-layer routes.
 */
export function assertNotV3DataLayer(item: { data: unknown }): void {
  const version = (item.data as { version?: unknown } | null)?.version;
  if (version === 3) {
    throw new BadRequestException(
      'This data layer uses the multi-layer format. Use the /items/:id/layers/:layerId routes instead.',
    );
  }
}
