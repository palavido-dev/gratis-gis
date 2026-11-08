// SPDX-License-Identifier: AGPL-3.0-or-later
import { FormsService } from './forms.service.js';
import type { LeaderElectionService } from '../cron/leader-election.service.js';

function service(leader?: { shouldRun: () => boolean }, prisma?: object) {
  return new FormsService(
    (prisma ?? { $queryRaw: jest.fn() }) as never,
    {} as never,
    {} as never,
    {} as never,
    leader as LeaderElectionService,
  );
}

describe('form mirror reconciliation', () => {
  it('does not scan when this process is not the leader', async () => {
    const prisma = { $queryRaw: jest.fn() };
    const svc = service({ shouldRun: () => false }, prisma);
    await expect(svc.reconcileFormMirrors()).resolves.toBe(0);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('does not scan when no leader service is wired', async () => {
    const prisma = { $queryRaw: jest.fn() };
    const svc = service(undefined, prisma);
    await expect(svc.reconcileFormMirrors()).resolves.toBe(0);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('repairs nothing when the leader finds no gap', async () => {
    const prisma = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      formSubmission: { findUnique: jest.fn() },
    };
    const svc = service({ shouldRun: () => true }, prisma);
    await expect(svc.reconcileFormMirrors()).resolves.toBe(0);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(prisma.formSubmission.findUnique).not.toHaveBeenCalled();
  });
});
