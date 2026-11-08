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

  it('backs off a submission that keeps failing so it does not starve newer ones', async () => {
    const ids = Array.from({ length: 20 }, (_, i) => `bad-${i}`);
    const prisma = {
      $queryRaw: jest.fn(),
      formSubmission: {
        findUnique: jest.fn(({ where }: { where: { id: string } }) => ({
          id: where.id,
          formId: 'form-1',
          orgId: 'org-1',
          clientId: where.id,
          schemaVersion: 1,
          response: {},
          submittedBy: null,
          capturedAt: new Date(0),
        })),
      },
      item: { findUnique: jest.fn(() => ({ id: 'form-1', data: {} })) },
    };
    const svc = service({ shouldRun: () => true }, prisma);
    const mirror = jest
      .spyOn(svc as unknown as { mirrorToPairedLayer: () => Promise<void> }, 'mirrorToPairedLayer')
      .mockImplementation(async (args?: unknown) => {
        const id = (args as { submissionId: string }).submissionId;
        if (id.startsWith('bad-')) throw new Error('cannot mirror');
      });
    jest.spyOn((svc as unknown as { log: { warn: () => void } }).log, 'warn').mockImplementation(() => undefined);

    // Tick 1: twenty failing rows fill the batch and all fail.
    prisma.$queryRaw.mockResolvedValueOnce(ids.map((id) => ({ id })));
    await expect(svc.reconcileFormMirrors(1_000)).resolves.toBe(0);

    // Tick 2, one minute later: a newer row arrives behind them. The
    // failing rows are backing off, so the newer row gets mirrored.
    mirror.mockClear();
    prisma.$queryRaw.mockResolvedValueOnce([...ids, 'good-1'].map((id) => ({ id })));
    await expect(svc.reconcileFormMirrors(61_000)).resolves.toBe(1);
    const tried = mirror.mock.calls.map(
      (c) => ((c as unknown[])[0] as { submissionId: string }).submissionId,
    );
    expect(new Set(tried)).toEqual(new Set(['good-1']));
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
