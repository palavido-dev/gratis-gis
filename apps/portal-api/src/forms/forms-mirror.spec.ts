// SPDX-License-Identifier: AGPL-3.0-or-later
import { DataLayerAttachmentsService } from '../data-layer/attachments.service.js';
import { FormsService } from './forms.service.js';
import type { LeaderElectionService } from '../cron/leader-election.service.js';

function service(leader?: { shouldRun: () => boolean }, prisma?: object) {
  return new FormsService(
    (prisma ?? { $queryRaw: jest.fn() }) as never,
    {} as never,
    {} as never,
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
    // The waiting rows are left out by the query itself, before its
    // LIMIT, so they cannot fill the scan.
    const params = prisma.$queryRaw.mock.calls[1].slice(1) as unknown[];
    expect(params).toContainEqual(ids);
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

// The mirror target must be a live data layer in the form's org that
// the form's owner can write to (#642).
const LAYER_ID = '00000000-0000-4000-8000-0000000000a1';
const FORM = { id: 'form-1', orgId: 'org-1', ownerId: 'owner-1' };

describe('form mirror repair re-registers photos after the presign grant expires', () => {
  // The repair pass runs up to seven days after a submission, but a
  // presign grant is pruned after two. The keys come from the saved
  // submission, so they must not need a grant.
  function setup() {
    const key = 'feature-attachment/photo-1';
    const response = {
      photo: [
        { name: 'p.jpg', mimeType: 'image/jpeg', sizeBytes: 10, url: 'u', key },
      ],
    };
    const created: unknown[] = [];
    const prisma = {
      $queryRaw: jest.fn().mockResolvedValueOnce([{ id: 'sub-1' }]),
      formSubmission: {
        findUnique: jest.fn(async () => ({
          id: 'sub-1',
          formId: 'form-1',
          orgId: 'org-1',
          clientId: 'c1',
          schemaVersion: 1,
          response,
          submittedBy: 'submitter',
          capturedAt: new Date(0),
        })),
      },
      item: {
        findUnique: jest.fn(async ({ where }: { where: { id: string } }) =>
          where.id === 'form-1'
            ? { ...FORM, data: { linkedLayerId: LAYER_ID } }
            : {
                id: LAYER_ID,
                type: 'data_layer',
                orgId: 'org-1',
                ownerId: 'owner-1',
                deletedAt: null,
                data: {},
              },
        ),
      },
      // Grant expired and pruned: nothing on file for anyone.
      storageUploadGrant: { findMany: jest.fn(async () => []) },
      featureAttachment: {
        create: jest.fn(async (a: unknown) => {
          created.push(a);
          return { id: 'a1', createdAt: new Date(0) };
        }),
      },
    };
    const attachments = new DataLayerAttachmentsService(
      prisma as never,
      { headObjectSize: jest.fn(async () => 10) } as never,
      { listFeatures: jest.fn(async () => ({ features: [{}] })) } as never,
    );
    const svc = new FormsService(
      prisma as never,
      {} as never,
      { insertFeatures: jest.fn(async () => undefined) } as never,
      attachments,
      {} as never, // sharing
      {} as never, // authSync
      { shouldRun: () => true } as unknown as LeaderElectionService,
    );
    jest
      .spyOn(svc as unknown as { mirrorRepeatGroupsToChildSublayers: () => Promise<void> }, 'mirrorRepeatGroupsToChildSublayers')
      .mockResolvedValue(undefined);
    const warn = jest
      .spyOn((svc as unknown as { log: { warn: () => void } }).log, 'warn')
      .mockImplementation(() => undefined);
    jest.spyOn((svc as unknown as { log: { log: () => void } }).log, 'log').mockImplementation(() => undefined);
    return { svc, created, warn, response };
  }

  it('the repair pass registers the saved submission photo', async () => {
    const t = setup();
    await expect(t.svc.reconcileFormMirrors()).resolves.toBe(1);
    expect(t.created).toHaveLength(1);
    expect(t.warn).not.toHaveBeenCalled();
  });

  it('a live submit still needs a grant for the key', async () => {
    const t = setup();
    await (t.svc as unknown as {
      mirrorToPairedLayer(a: unknown): Promise<void>;
    }).mirrorToPairedLayer({
      form: { ...FORM, data: { linkedLayerId: LAYER_ID } },
      clientId: 'c1',
      submissionId: 'sub-1',
      schemaVersion: 1,
      response: t.response,
      submittedBy: 'submitter',
      capturedAt: new Date(0),
      user: { id: 'submitter' },
    });
    expect(t.created).toHaveLength(0);
    expect(t.warn).toHaveBeenCalledWith(
      expect.stringContaining('attachment register failed'),
    );
  });
});
