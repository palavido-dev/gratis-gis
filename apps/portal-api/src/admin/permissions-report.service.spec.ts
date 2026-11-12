// SPDX-License-Identifier: AGPL-3.0-or-later
import { PermissionsReportService } from './permissions-report.service.js';

function item(i: number) {
  return {
    id: `id-${String(i).padStart(6, '0')}`,
    title: `t${i}`,
    type: 'map',
    access: 'private',
    ownerId: 'o',
    owner: { id: 'o', username: 'own', orgId: 'org', deletedAt: null },
    shares: [],
  };
}

describe('PermissionsReportService', () => {
  it('pages past 5000 items instead of stopping silently', async () => {
    const all = Array.from({ length: 5500 }, (_, i) => item(i));
    const findMany = jest.fn(async (args: { take: number; cursor?: { id: string } }) => {
      const start = args.cursor ? all.findIndex((x) => x.id === args.cursor!.id) + 1 : 0;
      return all.slice(start, start + args.take);
    });
    const svc = new PermissionsReportService({
      item: { findMany },
      user: { findMany: jest.fn(async () => []) },
      group: { findMany: jest.fn(async () => []) },
    } as never);
    const report = await svc.report('org');
    expect(report.rows).toHaveLength(5500);
    expect(report.truncated).toBe(false);
    expect(findMany.mock.calls.length).toBeGreaterThan(1);
  });
});
