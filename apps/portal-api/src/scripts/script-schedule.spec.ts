// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  buildScriptCron,
  normalizeScriptSchedule,
  summarizeScriptSchedule,
} from '@gratis-gis/shared-types';

import { ScriptScheduleService } from './script-schedule.service.js';

describe('script schedule expressions', () => {
  it('means "never" when off or absent', () => {
    expect(buildScriptCron(undefined)).toBeNull();
    expect(buildScriptCron({ mode: 'off' })).toBeNull();
  });

  it.each([
    [{ mode: 'hourly', minute: 15 }, '15 * * * *'],
    [{ mode: 'daily', hour: 4, minute: 30 }, '30 4 * * *'],
    [{ mode: 'weekly', hour: 9, minute: 0, dayOfWeek: 1 }, '0 9 * * 1'],
    [{ mode: 'monthly', hour: 2, minute: 5, dayOfMonth: 12 }, '5 2 12 * *'],
  ] as const)('builds %j', (schedule, expected) => {
    expect(buildScriptCron({ ...schedule })).toBe(expected);
  });

  it('caps the day of month at 28 so February still runs', () => {
    // 31 would produce a schedule that skips February entirely, which
    // looks like a broken script rather than a calendar.
    expect(buildScriptCron({ mode: 'monthly', dayOfMonth: 31 })).toBe(
      '0 3 28 * *',
    );
  });

  it('clamps nonsense rather than emitting an invalid expression', () => {
    // Whatever arrives on data_json is not necessarily what the UI
    // sent. An out-of-range hour must not become `0 99 * * *`, which
    // would throw inside CronJob and silently drop the schedule.
    const cron = buildScriptCron({
      mode: 'daily',
      hour: 99,
      minute: -4,
    } as never);
    expect(cron).toBe('0 23 * * *');
  });

  it('treats an unknown mode as off', () => {
    expect(normalizeScriptSchedule({ mode: 'fortnightly' })).toEqual({
      mode: 'off',
    });
    expect(normalizeScriptSchedule('every tuesday')).toBeUndefined();
  });

  it('says it in English', () => {
    expect(summarizeScriptSchedule({ mode: 'off' })).toBe(
      'Only when someone runs it',
    );
    expect(summarizeScriptSchedule({ mode: 'hourly', minute: 5 })).toBe(
      'Every hour at :05',
    );
    expect(
      summarizeScriptSchedule({ mode: 'daily', hour: 4, minute: 30 }),
    ).toBe('Every day at 04:30');
    expect(
      summarizeScriptSchedule({ mode: 'weekly', hour: 9, dayOfWeek: 1 }),
    ).toBe('Every Monday at 09:00');
    expect(
      summarizeScriptSchedule({ mode: 'monthly', hour: 1, dayOfMonth: 3 }),
    ).toBe('The 3rd of each month at 01:00');
  });
});

type Row = { id: string; title: string; schedule: unknown };

function makeService(rows: Row[], opts: { leader?: boolean } = {}) {
  const state = { rows };
  const enqueueScheduled = jest.fn(async () => 'run-1');
  const svc = new ScriptScheduleService(
    { $queryRaw: jest.fn(async () => state.rows) } as never,
    { enqueueScheduled } as never,
    { shouldRun: () => opts.leader !== false } as never,
  );
  const reconcile = () =>
    (svc as unknown as { reconcile(): Promise<void> }).reconcile();
  /** The jobs the service is actually holding, by script id. */
  const jobs = () =>
    (svc as unknown as { jobs: Map<string, unknown> }).jobs;
  return { svc, state, enqueueScheduled, reconcile, jobs };
}

describe('ScriptScheduleService reconcile', () => {
  const daily = { mode: 'daily', hour: 4, minute: 30 };

  it('registers a job per scheduled script and ignores the rest', async () => {
    const { svc, reconcile, jobs } = makeService([
      { id: 'a', title: 'Nightly parcels', schedule: daily },
      { id: 'b', title: 'Ad hoc', schedule: { mode: 'off' } },
      { id: 'c', title: 'Never configured', schedule: null },
    ]);
    await reconcile();
    expect(svc.describe()).toEqual([{ scriptId: 'a', cron: '30 4 * * *' }]);
    expect([...jobs().keys()]).toEqual(['a']);
    svc.onModuleDestroy();
  });

  it('is idempotent: a second pass does not re-register', async () => {
    const { svc, reconcile, jobs } = makeService([
      { id: 'a', title: 'Nightly', schedule: daily },
    ]);
    await reconcile();
    const first = jobs().get('a');
    await reconcile();
    // A second registration would mean two jobs firing, i.e. every
    // scheduled run happening twice. Same object means untouched.
    expect(jobs().get('a')).toBe(first);
    svc.onModuleDestroy();
  });

  it('re-registers when the expression changes', async () => {
    const { svc, state, reconcile, jobs } = makeService([
      { id: 'a', title: 'Nightly', schedule: daily },
    ]);
    await reconcile();
    const first = jobs().get('a');
    state.rows = [
      { id: 'a', title: 'Nightly', schedule: { mode: 'hourly', minute: 0 } },
    ];
    await reconcile();
    expect(svc.describe()).toEqual([{ scriptId: 'a', cron: '0 * * * *' }]);
    expect(jobs().get('a')).not.toBe(first);
    svc.onModuleDestroy();
  });

  it('drops the job when the schedule is turned off', async () => {
    const { svc, state, reconcile, jobs } = makeService([
      { id: 'a', title: 'Nightly', schedule: daily },
    ]);
    await reconcile();
    state.rows = [{ id: 'a', title: 'Nightly', schedule: { mode: 'off' } }];
    await reconcile();
    expect(svc.describe()).toEqual([]);
    expect(jobs().size).toBe(0);
    svc.onModuleDestroy();
  });

  it('drops the job when the item disappears', async () => {
    // Trashed, deleted, retyped, or wiped by the nightly golden
    // restore. The query returns fewer rows and that is the only
    // signal we get, which is the whole reason this is a sweep.
    const { svc, state, reconcile } = makeService([
      { id: 'a', title: 'Nightly', schedule: daily },
    ]);
    await reconcile();
    state.rows = [];
    await reconcile();
    expect(svc.describe()).toEqual([]);
    svc.onModuleDestroy();
  });

  it('keeps the previous jobs when the database read fails', async () => {
    const { svc, reconcile } = makeService([
      { id: 'a', title: 'Nightly', schedule: daily },
    ]);
    await reconcile();
    const boom = new Error('connection reset');
    (svc as unknown as { prisma: { $queryRaw: jest.Mock } }).prisma.$queryRaw =
      jest.fn(async () => {
        throw boom;
      });
    await (
      svc as unknown as { reconcileSafely(): Promise<void> }
    ).reconcileSafely();
    // Tearing everything down on a transient blip would silently stop
    // every schedule until the next successful pass.
    expect(svc.describe()).toEqual([{ scriptId: 'a', cron: '30 4 * * *' }]);
    svc.onModuleDestroy();
  });

  it('enqueues on fire, and swallows a failure so the timer survives', async () => {
    const { svc, enqueueScheduled } = makeService([]);
    const fire = (svc as unknown as {
      fire(id: string, title: string): Promise<void>;
    }).fire.bind(svc);

    await fire('a', 'Nightly');
    expect(enqueueScheduled).toHaveBeenCalledWith('a');

    enqueueScheduled.mockRejectedValueOnce(new Error('database down'));
    // A throw escaping a cron tick kills that job's timer, turning one
    // bad night into a script that never runs again.
    await expect(fire('a', 'Nightly')).resolves.toBeUndefined();
  });

  it('does not fire on a replica that is not the leader', async () => {
    const { svc, enqueueScheduled } = makeService([], { leader: false });
    await (
      svc as unknown as { fire(id: string, title: string): Promise<void> }
    ).fire('a', 'Nightly');
    // Checked per tick, not only at registration: a replica that loses
    // the lock mid-life would otherwise double every scheduled run.
    expect(enqueueScheduled).not.toHaveBeenCalled();
  });
});
