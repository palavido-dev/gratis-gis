// SPDX-License-Identifier: AGPL-3.0-or-later
import { ConflictException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';

import { HousekeepingScheduleService } from './housekeeping-schedule.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { KeycloakAdminService } from './keycloak-admin.service.js';
import type { KeycloakSyncService } from './keycloak-sync.service.js';
import type { DataLayerTablesService } from '../data-layer/tables.service.js';
import type { HousekeepingService } from './housekeeping.service.js';
import type { NotificationsService } from '../notifications/notifications.service.js';

interface Row {
  id: string;
  username: string;
  autoDisableAt: Date | null;
  disabledAt: Date | null;
  deletedAt: Date | null;
  orgRole: string;
}

function build(rows: Row[], kcEnabled: Record<string, boolean>) {
  const revoked: string[] = [];
  const txRef: { current: unknown } = { current: null };
  const prisma = {
    user: {
      findMany: jest.fn(async (args: { where: Record<string, unknown> }) =>
        rows.filter(
          (r) =>
            r.orgRole !== 'admin' &&
            (!('disabledAt' in args.where) || r.disabledAt === null) &&
            (!('deletedAt' in args.where) || r.deletedAt === null) &&
            r.autoDisableAt !== null &&
            r.autoDisableAt.getTime() <= Date.now(),
        ),
      ),
      updateMany: jest.fn(
        async (args: { where: { id: string }; data: { disabledAt: Date } }) => {
          const r = rows.find((x) => x.id === args.where.id && x.disabledAt === null);
          if (r) r.disabledAt = args.data.disabledAt;
          return { count: r ? 1 : 0 };
        },
      ),
    },
    apiKey: {
      updateMany: jest.fn(async (args: { where: { userId: string } }) => {
        revoked.push(args.where.userId);
        return { count: 1 };
      }),
    },
    $transaction: jest.fn(
      async (fn: (tx: unknown) => Promise<unknown>): Promise<unknown> => fn(txRef.current),
    ),
  };  txRef.current = prisma;

  const keycloak = {
    findUserIdByUsername: jest.fn(async (u: string) => `kc-${u}`),
    getUser: jest.fn(async (id: string) => ({ id, enabled: kcEnabled[id] ?? true })),
    updateUser: jest.fn(async (id: string) => {
      kcEnabled[id] = false;
      return {};
    }),
  };
  const notify = jest.fn(async () => undefined);
  const svc = new HousekeepingScheduleService(
    prisma as unknown as PrismaService,
    {} as ConfigService,
    keycloak as unknown as KeycloakAdminService,
    {} as KeycloakSyncService,
    {} as DataLayerTablesService,
    {} as HousekeepingService,
    { notify } as unknown as NotificationsService,
  );
  const run = (svc as unknown as { autoDisableExpiredUsers: () => Promise<number> })
    .autoDisableExpiredUsers.bind(svc);
  return { run, notify, revoked, keycloak };
}

const past = new Date(Date.now() - 60_000);

describe('housekeeping auto-disable', () => {
  it('disables, revokes keys and emails each expired user once', async () => {
    const rows: Row[] = [
      { id: 'u1', username: 'ana', autoDisableAt: past, disabledAt: null, deletedAt: null, orgRole: 'viewer' },
    ];
    const { run, notify, revoked } = build(rows, {});
    expect(await run()).toBe(1);
    expect(await run()).toBe(0);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(revoked).toEqual(['u1']);
    expect(rows[0]?.disabledAt).not.toBeNull();
  });

  it('skips soft-deleted users', async () => {
    const rows: Row[] = [
      { id: 'u2', username: 'bo', autoDisableAt: past, disabledAt: null, deletedAt: new Date(), orgRole: 'viewer' },
    ];
    const { run, notify } = build(rows, {});
    expect(await run()).toBe(0);
    expect(notify).not.toHaveBeenCalled();
  });

  it('marks an account already disabled in Keycloak without emailing again', async () => {
    const rows: Row[] = [
      { id: 'u3', username: 'cy', autoDisableAt: past, disabledAt: null, deletedAt: null, orgRole: 'viewer' },
    ];
    const { run, notify, keycloak, revoked } = build(rows, { 'kc-cy': false });
    await run();
    expect(keycloak.updateUser).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    expect(revoked).toEqual(['u3']);
  });
});

describe('housekeeping run lock', () => {
  it('refuses a second run while one is in progress', async () => {
    const tx = {
      $executeRaw: jest.fn(async () => 0),
      housekeepingRun: {
        findFirst: jest.fn(async () => ({ id: 'live' })),
        create: jest.fn(),
      },
    };
    const prisma = {
      $transaction: jest.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
    };
    const svc = new HousekeepingScheduleService(
      prisma as unknown as PrismaService,
      {} as ConfigService,
      {} as KeycloakAdminService,
      {} as KeycloakSyncService,
      {} as DataLayerTablesService,
      {} as HousekeepingService,
      {} as NotificationsService,
    );
    jest.spyOn(svc, 'getConfig').mockResolvedValue(
      {} as Awaited<ReturnType<HousekeepingScheduleService['getConfig']>>,
    );
    await expect(
      svc.runOnce({ trigger: 'manual', startedBy: null }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(tx.$executeRaw).toHaveBeenCalled();
    expect(tx.housekeepingRun.create).not.toHaveBeenCalled();
  });
});
