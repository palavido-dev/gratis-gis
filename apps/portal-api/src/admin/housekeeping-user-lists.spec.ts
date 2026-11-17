// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ConfigService } from '@nestjs/config';

import type { PrismaService } from '../prisma/prisma.service.js';
import type { DataLayerTablesService } from '../data-layer/tables.service.js';
import type { DataLayerSearchIndexService } from '../data-layer/search-index.service.js';
import type { CredentialService } from '../items/credential.service.js';
import type { StorageService } from '../storage/storage.service.js';
import { HousekeepingService } from './housekeeping.service.js';

/**
 * The dashboard's quiet-user and auto-disable lists (and their
 * counts) must leave out accounts that are already disabled or gone
 * from Keycloak, as the scheduled pass does. Otherwise the rows come
 * back after "Disable sign-in" and actions on removed users 404.
 */
describe('housekeeping user lists skip disabled and removed accounts', () => {
  const wheres: Array<Record<string, unknown>> = [];
  const capture = jest.fn(async (args: { where: Record<string, unknown> }) => {
    wheres.push(args.where);
    return [];
  });
  const prisma = {
    user: { findMany: capture, count: jest.fn(async (args: { where: Record<string, unknown> }) => {
      wheres.push(args.where);
      return 0;
    }) },
  } as unknown as PrismaService;
  const hk = new HousekeepingService(
    prisma,
    { get: jest.fn(() => undefined) } as unknown as ConfigService,
    {} as DataLayerTablesService,
    {} as DataLayerSearchIndexService,
    {} as CredentialService,
    {} as StorageService,
  );
  const priv = hk as unknown as {
    countStaleUsers(orgId: string): Promise<number>;
    countExpiringUsers(orgId: string, days: number): Promise<number>;
  };

  it('filters all four queries', async () => {
    wheres.length = 0;
    await hk.staleUsers('org-1');
    await hk.expiringUsers('org-1', 14);
    await priv.countStaleUsers('org-1');
    await priv.countExpiringUsers('org-1', 14);
    expect(wheres).toHaveLength(4);
    for (const w of wheres) {
      expect(w).toMatchObject({ orgId: 'org-1', deletedAt: null, disabledAt: null });
    }
  });
});
