// SPDX-License-Identifier: AGPL-3.0-or-later
import { ScriptsService } from './scripts.service.js';

/**
 * The run list built summaries from rows that carried every run's
 * log, source snapshot and notebook. It selects summary columns only.
 */
describe('ScriptsService.listRuns', () => {
  it('never loads the log, source or notebook', async () => {
    const findMany = jest.fn(async () => [
      {
        id: 'r1',
        scriptId: 's1',
        state: 'succeeded',
        trigger: 'manual',
        exitCode: 0,
        error: null,
        createdAt: new Date(),
        startedAt: null,
        finishedAt: null,
      },
    ]);
    const svc = new ScriptsService(
      { scriptRun: { findMany } } as never,
      { get: async () => ({ type: 'script' }) } as never,
      {} as never,
    );
    const out = await svc.listRuns({ id: 'u' } as never, 's1');
    expect(out).toHaveLength(1);
    const select = (findMany.mock.calls[0] as unknown as [{ select: Record<string, boolean> }])[0]
      .select;
    expect(select).toBeDefined();
    expect(select).not.toHaveProperty('log');
    expect(select).not.toHaveProperty('sourceSnapshot');
    expect(select).not.toHaveProperty('notebook');
  });
});
