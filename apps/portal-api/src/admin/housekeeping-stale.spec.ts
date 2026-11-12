// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ConfigService } from '@nestjs/config';

import type { PrismaService } from '../prisma/prisma.service.js';
import type { DataLayerTablesService } from '../data-layer/tables.service.js';
import type { DataLayerSearchIndexService } from '../data-layer/search-index.service.js';
import type { CredentialService } from '../items/credential.service.js';
import type { StorageService } from '../storage/storage.service.js';
import type { KeycloakAdminService } from './keycloak-admin.service.js';
import type { KeycloakSyncService } from './keycloak-sync.service.js';
import type { NotificationsService } from '../notifications/notifications.service.js';
import { HousekeepingService } from './housekeeping.service.js';
import { HousekeepingScheduleService } from './housekeeping-schedule.service.js';

/**
 * The stale-item heuristic used to exist in three copies. Only the
 * report skipped seeded builtins, so the scheduled auto-trash (the
 * destructive copy) trashed every org's untouched basemaps, themes
 * and templates. All three now share one candidate filter and one
 * refine step; auto-trash also skips non-private items and folders.
 */

type Row = {
  id: string;
  orgId: string;
  type: string;
  title: string;
  access: 'private' | 'org' | 'public';
  seedKind: string | null;
  data: unknown;
  updatedAt: Date;
  lastUsageAt: Date | null;
  deletedAt: Date | null;
  shares: number;
  publicGeoBoundaryId: null;
  orgGeoBoundaryId: null;
  ownerId: string;
};

const OLD = new Date(Date.now() - 200 * 86_400_000);

function row(id: string, over: Partial<Row> = {}): Row {
  return {
    id,
    orgId: 'org-1',
    type: 'web_map',
    title: id,
    access: 'private',
    seedKind: null,
    data: {},
    updatedAt: OLD,
    lastUsageAt: null,
    deletedAt: null,
    shares: 0,
    publicGeoBoundaryId: null,
    orgGeoBoundaryId: null,
    ownerId: 'owner-1',
    ...over,
  };
}

/** Just enough of Prisma's where semantics for the keys these
 *  queries use. */
function matches(r: Row, where: Record<string, unknown>): boolean {
  for (const [k, v] of Object.entries(where)) {
    if (k === 'OR') {
      if (!(v as Array<Record<string, unknown>>).some((w) => matches(r, w))) return false;
    } else if (k === 'shares') {
      if (r.shares !== 0) return false;
    } else if (v === null) {
      if ((r as Record<string, unknown>)[k] !== null) return false;
    } else if (typeof v === 'object' && v !== null && 'lt' in v) {
      const val = (r as Record<string, unknown>)[k] as Date | null;
      if (!val || !(val < (v as { lt: Date }).lt)) return false;
    } else if (typeof v === 'object' && v !== null && 'not' in v) {
      if ((r as Record<string, unknown>)[k] === (v as { not: unknown }).not) return false;
    } else if (typeof v === 'object' && v !== null && 'in' in v) {
      if (!(v as { in: unknown[] }).in.includes((r as Record<string, unknown>)[k])) return false;
    } else if ((r as Record<string, unknown>)[k] !== v) {
      return false;
    }
  }
  return true;
}

function build(rows: Row[]) {
  const trashed: string[] = [];
  const prisma = {
    item: {
      findMany: jest.fn(async (args: { where: Record<string, unknown> }) =>
        rows.filter((r) => matches(r, args.where)),
      ),
      updateMany: jest.fn(async (args: { where: { id: { in: string[] } } }) => {
        trashed.push(...args.where.id.in);
        return { count: args.where.id.in.length };
      }),
    },
  } as unknown as PrismaService;
  const cfg = { get: jest.fn(() => undefined) } as unknown as ConfigService;
  const hk = new HousekeepingService(
    prisma,
    cfg,
    {} as DataLayerTablesService,
    {} as DataLayerSearchIndexService,
    {} as CredentialService,
    {} as StorageService,
  );
  const sched = new HousekeepingScheduleService(
    prisma,
    cfg,
    {} as KeycloakAdminService,
    {} as KeycloakSyncService,
    {} as DataLayerTablesService,
    hk,
    {} as NotificationsService,
  );
  const autoTrash = (
    sched as unknown as { autoTrashStaleItems: (d: number) => Promise<number> }
  ).autoTrashStaleItems.bind(sched);
  const count = (
    hk as unknown as { countStaleItems: (o: string) => Promise<number> }
  ).countStaleItems.bind(hk);
  return { hk, autoTrash, count, trashed };
}

describe('stale items: report, count and auto-trash agree', () => {
  const rows = [
    row('seeded-basemap', { type: 'basemap', data: { seededKey: 'osm' } }),
    row('seeded-theme', { type: 'theme', seedKind: 'theme' }),
    row('public-map', { access: 'public' }),
    row('folder', { type: 'folder' }),
    row('private-map'),
    row('shared-map', { shares: 1 }),
  ];

  it('the report and the summary count skip seeded builtins', async () => {
    const { hk, count } = build(rows);
    const report = (await hk.staleItems('org-1')).map((r) => r.id).sort();
    expect(report).toEqual(['folder', 'private-map', 'public-map']);
    expect(await count('org-1')).toBe(report.length);
  });

  it('auto-trash takes only private, non-folder items the report lists', async () => {
    const { autoTrash, trashed } = build(rows);
    expect(await autoTrash(90)).toBe(1);
    expect(trashed).toEqual(['private-map']);
  });
});

describe('live item read is shared across one page load', () => {
  it('reads the org once for repeated dependency walks, and again when asked fresh', async () => {
    const { hk } = build([row('a'), row('b')]);
    const findMany = (hk as unknown as { prisma: { item: { findMany: jest.Mock } } }).prisma
      .item.findMany;
    const liveReads = () =>
      findMany.mock.calls.filter(
        ([args]) => !('updatedAt' in (args as { where: object }).where),
      ).length;
    await hk.buildReferencedItemSet('org-1');
    await hk.buildReferencedItemSet('org-1');
    expect(liveReads()).toBe(1);
    await hk.buildReferencedItemSet('org-1', { fresh: true });
    expect(liveReads()).toBe(2);
  });
});
