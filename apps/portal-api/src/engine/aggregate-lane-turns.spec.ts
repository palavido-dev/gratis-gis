// SPDX-License-Identifier: AGPL-3.0-or-later
import { runAsAnonymous, runAsOrg, runAsSystem } from '../common/tenant-context.js';
import { LaneTurnCounter, laneBucket, runServingOrg } from './aggregate-lane-turns.js';

describe('aggregate lane turns', () => {
  it('one bucket alone may use the whole lane', () => {
    const c = new LaneTurnCounter();
    for (let i = 0; i < 3; i++) {
      expect(c.mayTake('org:a', 3, [])).toBe(true);
      c.take('org:a');
    }
    expect(c.mayTake('org:a', 3, ['org:a'])).toBe(false);
    expect(c.total()).toBe(3);
  });

  it('a bucket in the line that runs less goes before a busier asker', () => {
    const c = new LaneTurnCounter();
    c.take('org:a');
    c.take('org:a');
    expect(c.mayTake('org:a', 4, [])).toBe(true);
    expect(c.mayTake('org:a', 4, ['org:b'])).toBe(false);
    expect(c.mayTake('org:b', 4, ['org:b'])).toBe(true);
  });

  it('a bucket running no more than a waiting one may take a free slot', () => {
    const c = new LaneTurnCounter();
    c.take('org:a');
    c.take('org:b');
    expect(c.mayTake('org:a', 4, ['org:b'])).toBe(true);
  });

  it('release gives the slot back', () => {
    const c = new LaneTurnCounter();
    c.take('org:a');
    c.release('org:a');
    expect(c.heldBy('org:a')).toBe(0);
    expect(c.total()).toBe(0);
  });

  it('random asks: never above the limit, and a refusal with a free slot only for a strict leader', () => {
    let seed = 12345;
    const rand = (): number => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    for (const limit of [1, 2, 3, 5]) {
      const c = new LaneTurnCounter();
      const names = ['org:0', 'org:1', 'org:2', 'org:3'];
      for (let step = 0; step < 2000; step++) {
        const b = names[Math.floor(rand() * names.length)]!;
        if (rand() < 0.4) {
          if (c.heldBy(b) > 0) c.release(b);
          continue;
        }
        const line = names.filter(() => rand() < 0.4);
        if (c.mayTake(b, limit, line)) {
          expect(c.total()).toBeLessThan(limit);
          c.take(b);
        } else if (c.total() < limit) {
          for (const o of line) {
            if (o !== b) expect(c.heldBy(b)).toBeGreaterThan(c.heldBy(o));
          }
        }
        expect(c.total()).toBeLessThanOrEqual(limit);
      }
    }
  });

  it('names the bucket from the tenant context', () => {
    expect(laneBucket()).toBe('none');
    expect(runAsOrg('o1', () => laneBucket())).toBe('org:o1');
    expect(runAsAnonymous(() => laneBucket())).toBe('anonymous');
    expect(runAsSystem('job-claim', () => laneBucket())).toBe('system');
  });

  it('signed-out work counts against the organization of the item it serves', () => {
    expect(runAsAnonymous(() => runServingOrg('o2', () => laneBucket()))).toBe('org:o2');
    expect(runAsAnonymous(() => runServingOrg(undefined, () => laneBucket()))).toBe('anonymous');
    // A signed-in caller always counts as its own organization.
    expect(runAsOrg('o1', () => runServingOrg('o2', () => laneBucket()))).toBe('org:o1');
  });
});
