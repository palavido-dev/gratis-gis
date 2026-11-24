// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BadRequestException,
  type CanActivate,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { isMultiTenant } from '../common/tenancy.js';

/**
 * Data layer versions 1 and 2 keep their features in one table per
 * item (`fs_<id>`), outside the shared observation table that every
 * newer layer uses. Those tables carry no organization column, so an
 * install that serves many organizations does not use them at all:
 * their routes answer 404 and no new layer may be created on them.
 * A one-organization install keeps them as before.
 */

/** Guard for the per-item table routes. 404 in multi mode. */
@Injectable()
export class LegacyFeatureTablesGuard implements CanActivate {
  canActivate(): boolean {
    if (isMultiTenant()) throw new NotFoundException();
    return true;
  }
}

/** The data layer version stored in item data (0 when absent). */
export function dataLayerVersion(data: unknown): number {
  if (!data || typeof data !== 'object') return 0;
  const v = (data as { version?: unknown }).version;
  return typeof v === 'number' ? v : 0;
}

/**
 * Refuse a data layer whose data is not version 3, in multi mode.
 * Called on create and on every write of a data layer's data, so an
 * update cannot turn a layer back into a per-item table layer.
 */
export function assertCurrentDataLayerVersion(type: string, data: unknown): void {
  if (!isMultiTenant() || type !== 'data_layer') return;
  if (dataLayerVersion(data) !== 3) {
    throw new BadRequestException('A data layer must use storage version 3 (data.version = 3).');
  }
}
