// SPDX-License-Identifier: AGPL-3.0-or-later
import { NotFoundException } from '@nestjs/common';

import { ScriptsService } from './scripts.service.js';

describe('ScriptsService.getRun', () => {
  const full = {
    id: 'r1',
    scriptId: 's1',
    state: 'succeeded',
    trigger: 'manual',
    exitCode: 0,
    error: null,
    createdAt: new Date(0),
    startedAt: new Date(0),
    finishedAt: new Date(0),
    log: 'secret log',
    sourceSnapshot: 'print(1)',
    notebook: null,
  };

  function setup(canSee: boolean) {
    const findUnique = jest.fn(async (args: { select?: unknown }) =>
      args.select ? { scriptId: full.scriptId } : full,
    );
    const items = {
      get: jest.fn(async () => {
        if (!canSee) throw new NotFoundException('Item not found');
        return { id: 's1' };
      }),
    };
    const svc = new ScriptsService(
      { scriptRun: { findUnique } } as never,
      items as never,
      {} as never,
    );
    return { svc, findUnique };
  }

  it('reads only the script id until the caller is known to see the script', async () => {
    const { svc, findUnique } = setup(false);
    await expect(svc.getRun({ id: 'u1' } as never, 'r1')).rejects.toThrow('Run not found.');
    expect(findUnique).toHaveBeenCalledTimes(1);
    expect(findUnique.mock.calls[0]![0]).toEqual({
      where: { id: 'r1' },
      select: { scriptId: true },
    });
  });

  it('returns the whole run to a caller who sees the script', async () => {
    const { svc } = setup(true);
    const out = await svc.getRun({ id: 'u1' } as never, 'r1');
    expect(out.log).toBe('secret log');
  });
});
