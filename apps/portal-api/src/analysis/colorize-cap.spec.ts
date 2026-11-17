// SPDX-License-Identifier: AGPL-3.0-or-later
import { BadRequestException } from '@nestjs/common';

import type { AuthUser } from '../auth/auth-sync.service.js';
import { AnalysisService, COLORIZE_MAX_POINTS } from './analysis.service.js';

/** A cloud the worker cannot hold in memory is refused before any work. */
describe('createColorizeJob size cap', () => {
  it('refuses a point cloud over the cap', async () => {
    const items = {
      get: jest.fn(async () => ({
        type: 'point_cloud',
        data: {
          version: 1,
          format: 'copc',
          storageKey: 'point-cloud/x.copc.laz',
          pointCount: COLORIZE_MAX_POINTS + 1,
        },
      })),
    };
    const svc = new AnalysisService(
      {} as never,
      items as never,
      {} as never,
      {} as never,
      { get: () => 'server-heavy' } as never,
    );
    const user = {
      id: 'u',
      orgId: 'o',
      orgRole: 'admin',
      capabilities: new Set(['can_publish_items']),
    } as unknown as AuthUser;
    await expect(
      svc.createColorizeJob(user, 'pc', { rasterItemId: 'r' }),
    ).rejects.toThrow(/colorize handles up to/);
    await expect(
      svc.createColorizeJob(user, 'pc', { rasterItemId: 'r' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
