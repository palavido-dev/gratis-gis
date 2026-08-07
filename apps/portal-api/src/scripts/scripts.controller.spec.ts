// SPDX-License-Identifier: AGPL-3.0-or-later
import { ForbiddenException, NotFoundException } from '@nestjs/common';

import { ScriptsController } from './scripts.controller.js';
import type { ScriptsService } from './scripts.service.js';
import type { AuthUser } from '../auth/auth-sync.service.js';

/**
 * The flag gate on the run endpoints was missing on first write, and
 * the gap was not visible from anywhere: the runner checked the flag,
 * the web app checked the flag, so the feature looked off while
 * POST /scripts/:id/run queued work regardless. Found by curling the
 * endpoint on a portal where portal-info said scripts were disabled
 * and getting a 202.
 */
function makeController(over: Partial<ScriptsService> = {}) {
  const svc = {
    enqueue: jest.fn().mockResolvedValue({ id: 'r1', state: 'queued' }),
    cancelRun: jest.fn().mockResolvedValue({ state: 'cancelled' }),
    listRuns: jest.fn().mockResolvedValue([]),
    getRun: jest.fn().mockResolvedValue({ id: 'r1' }),
    ...over,
  } as unknown as ScriptsService;
  return { controller: new ScriptsController(svc), svc };
}

const session = { id: 'u1', orgId: 'o1' } as AuthUser;
const viaKey = { id: 'u1', orgId: 'o1', authKind: 'api_key' } as AuthUser;

describe('ScriptsController', () => {
  const saved = process.env.PORTAL_SCRIPTS_ENABLED;
  afterAll(() => {
    if (saved === undefined) delete process.env.PORTAL_SCRIPTS_ENABLED;
    else process.env.PORTAL_SCRIPTS_ENABLED = saved;
  });

  describe('with scripts disabled', () => {
    beforeEach(() => {
      delete process.env.PORTAL_SCRIPTS_ENABLED;
    });

    it('will not start a run', async () => {
      const { controller, svc } = makeController();
      await expect(controller.run(session, 'a')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(svc.enqueue).not.toHaveBeenCalled();
    });

    it('still serves run history', async () => {
      // Turning the feature off must not strand the logs of whatever
      // ran while it was on.
      const { controller } = makeController();
      await expect(controller.runs(session, 'a')).resolves.toEqual([]);
      await expect(controller.run_(session, 'r1')).resolves.toBeDefined();
    });
  });

  describe('with scripts enabled', () => {
    beforeEach(() => {
      process.env.PORTAL_SCRIPTS_ENABLED = '1';
    });

    it('starts a run for a signed-in person', async () => {
      const { controller } = makeController();
      await expect(controller.run(session, 'a')).resolves.toEqual({
        id: 'r1',
        state: 'queued',
      });
    });

    it('refuses an API key on run', async () => {
      // A key that can start a run can cause more code to run under
      // that same authority, which is a short walk to a script that
      // keeps itself alive.
      const { controller, svc } = makeController();
      await expect(controller.run(viaKey, 'a')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(svc.enqueue).not.toHaveBeenCalled();
    });

    it('refuses an API key on cancel', async () => {
      const { controller, svc } = makeController();
      await expect(
        controller.cancel(viaKey, 'r1'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(svc.cancelRun).not.toHaveBeenCalled();
    });

    it('lets an API key READ history', async () => {
      // Reading is not executing; a monitoring script watching for
      // failures is a reasonable thing to want.
      const { controller } = makeController();
      await expect(controller.runs(viaKey, 'a')).resolves.toEqual([]);
    });
  });
});
