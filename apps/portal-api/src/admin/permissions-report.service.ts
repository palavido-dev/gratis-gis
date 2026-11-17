// SPDX-License-Identifier: AGPL-3.0-or-later
import { Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';
import { csvCell } from '@gratis-gis/shared-types';

/**
 * Current sharing snapshot for one org. It reads the live item,
 * owner, and share rows. It does not invent a history of changes
 * from before the admin audit existed.
 */

export interface PermissionRow {
  itemId: string;
  title: string;
  itemType: string;
  /** public, org, or private. This is the item's access tier. */
  access: string;
  ownerId: string;
  ownerUsername: string | null;
  ownerMissing: boolean;
  principalType: string;
  principalId: string;
  permission: string;
  principalMissing: boolean;
}

/** RFC 4180 plus a leading quote so a spreadsheet does not run the
 *  cell. One rule for every CSV the portal writes (shared-types). */
export { csvCell };

export function permissionsToCsv(rows: PermissionRow[]): string {
  const header = [
    'snapshot',
    'itemId',
    'title',
    'itemType',
    'access',
    'ownerId',
    'ownerUsername',
    'ownerMissing',
    'principalType',
    'principalId',
    'permission',
    'principalMissing',
  ];
  const lines = [header.join(',')];
  for (const row of rows) {
    lines.push(
      [
        'current',
        row.itemId,
        row.title,
        row.itemType,
        row.access,
        row.ownerId,
        row.ownerUsername ?? '',
        row.ownerMissing ? 'yes' : 'no',
        row.principalType,
        row.principalId,
        row.permission,
        row.principalMissing ? 'yes' : 'no',
      ]
        .map(csvCell)
        .join(','),
    );
  }
  return `${lines.join('\n')}\n`;
}

/** Items fetched per query, and the most one report covers. */
const REPORT_PAGE_SIZE = 2000;
const MAX_REPORT_ITEMS = 100_000;

@Injectable()
export class PermissionsReportService {
  constructor(private readonly prisma: PrismaService) {}

  async report(orgId: string): Promise<{
    kind: 'current-snapshot';
    generatedAt: string;
    rows: PermissionRow[];
    /** True when the org has more items than one report covers. */
    truncated: boolean;
  }> {
    // Paged by (title, id). A single take of 5000 dropped every item
    // after it, with nothing in the JSON or the CSV to say so, from an
    // export used for access audits.
    const items: Awaited<ReturnType<typeof this.itemPage>> = [];
    let truncated = false;
    for (;;) {
      const last = items[items.length - 1];
      const page = await this.itemPage(orgId, last?.id);
      items.push(...page);
      if (page.length < REPORT_PAGE_SIZE) break;
      if (items.length >= MAX_REPORT_ITEMS) {
        truncated = true;
        break;
      }
    }
    return this.buildReport(orgId, items, truncated);
  }

  private itemPage(orgId: string, afterId: string | undefined) {
    return this.prisma.item.findMany({
      where: { orgId, deletedAt: null },
      select: {
        id: true,
        title: true,
        type: true,
        access: true,
        ownerId: true,
        owner: { select: { id: true, username: true, orgId: true, deletedAt: true } },
        shares: {
          select: {
            principalType: true,
            principalId: true,
            permission: true,
          },
        },
      },
      orderBy: [{ title: 'asc' }, { id: 'asc' }],
      take: REPORT_PAGE_SIZE,
      ...(afterId ? { cursor: { id: afterId }, skip: 1 } : {}),
    });
  }

  private async buildReport(
    orgId: string,
    items: Awaited<ReturnType<PermissionsReportService['itemPage']>>,
    truncated: boolean,
  ) {
    const userIds = new Set<string>();
    const groupIds = new Set<string>();
    for (const item of items) {
      for (const share of item.shares) {
        if (share.principalType === 'user') userIds.add(share.principalId);
        else groupIds.add(share.principalId);
      }
    }
    const [users, groups] = await Promise.all([
      userIds.size === 0
        ? []
        : this.prisma.user.findMany({
            where: { id: { in: [...userIds] } },
            select: { id: true, orgId: true, deletedAt: true },
          }),
      groupIds.size === 0
        ? []
        : this.prisma.group.findMany({
            where: { id: { in: [...groupIds] } },
            select: { id: true, orgId: true, deletedAt: true },
          }),
    ]);
    const userOk = new Set(
      users.filter((u) => u.orgId === orgId && u.deletedAt === null).map((u) => u.id),
    );
    const groupOk = new Set(
      groups.filter((g) => g.orgId === orgId && g.deletedAt === null).map((g) => g.id),
    );
    const rows: PermissionRow[] = [];
    for (const item of items) {
      const ownerMissing =
        !item.owner || item.owner.orgId !== orgId || item.owner.deletedAt !== null;
      const base = {
        itemId: item.id,
        title: item.title,
        itemType: item.type,
        access: item.access,
        ownerId: item.ownerId,
        ownerUsername: ownerMissing ? null : item.owner.username,
        ownerMissing,
      };
      rows.push({
        ...base,
        principalType: '',
        principalId: '',
        permission: '',
        principalMissing: false,
      });
      for (const share of item.shares) {
        const known =
          share.principalType === 'user'
            ? userOk.has(share.principalId)
            : groupOk.has(share.principalId);
        rows.push({
          ...base,
          principalType: share.principalType,
          principalId: share.principalId,
          permission: share.permission,
          principalMissing: !known,
        });
      }
    }
    return {
      kind: 'current-snapshot' as const,
      generatedAt: new Date().toISOString(),
      rows,
      truncated,
    };
  }

  async csv(orgId: string): Promise<string> {
    const report = await this.report(orgId);
    const csv = permissionsToCsv(report.rows);
    if (!report.truncated) return csv;
    // Say so in the file itself; the CSV has no other channel.
    return (
      csv +
      [
        'truncated',
        '',
        `Report stops after ${MAX_REPORT_ITEMS} items; this org has more.`,
      ]
        .map(csvCell)
        .join(',') +
      '\n'
    );
  }
}
