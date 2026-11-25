// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  fairShareBucket,
  fairShareOf,
  FAIR_SHARE_WAIT_MEMORY_MS,
  OrgSlotCounter,
  runServingOrg,
} from './org-fair-share.js';
import { runAsAnonymous, runAsOrg, runAsSystem } from './tenant-context.js';
import { resetTenancyModeForTests } from './tenancy.js';

describe('fair share of a process-wide limit', () => {
  const before = process.env.GRATIS_TENANCY;
  afterEach(() => {
    if (before === undefined) delete process.env.GRATIS_TENANCY;
    else process.env.GRATIS_TENANCY = before;
    resetTenancyModeForTests();
  });

  function mode(m: 'single' | 'multi'): void {
    if (m === 'multi') process.env.GRATIS_TENANCY = 'multi';
    else delete process.env.GRATIS_TENANCY;
    resetTenancyModeForTests();
  }

  /** A counter on a clock the test moves. */
  function counter(): { c: OrgSlotCounter; clock: { t: number } } {
    const clock = { t: 1_000_000 };
    return { c: new OrgSlotCounter(() => clock.t), clock };
  }

  it('shares are the limit split between the competing buckets, rounded up', () => {
    expect(fairShareOf(8, 1)).toBe(8);
    expect(fairShareOf(8, 2)).toBe(4);
    expect(fairShareOf(3, 2)).toBe(2);
    expect(fairShareOf(2, 3)).toBe(1);
    expect(fairShareOf(1, 4)).toBe(1);
  });

  it('one organization: only the overall limit, as before', () => {
    mode('single');
    const { c } = counter();
    for (let i = 0; i < 4; i++) expect(c.tryTake(i % 2 ? 'org:a' : 'anonymous', 4)).toBe(true);
    expect(c.tryTake('org:b', 4)).toBe(false);
    c.release('org:a');
    expect(c.tryTake('org:a', 4)).toBe(true);
    expect(c.total()).toBe(4);
  });

  it('many organizations: one bucket alone gets the whole limit', () => {
    mode('multi');
    const { c } = counter();
    for (let i = 0; i < 8; i++) expect(c.tryTake('org:a', 8)).toBe(true);
    expect(c.tryTake('org:a', 8)).toBe(false);
    expect(c.heldBy('org:a')).toBe(8);
  });

  it('many organizations: two buckets under contention converge to their shares', () => {
    mode('multi');
    const { c } = counter();
    for (let i = 0; i < 8; i++) c.tryTake('org:a', 8);
    // Each round B asks while everything is held (and so counts as
    // waiting), then A finishes one and asks again: A is refused while
    // it is over its share, and B's next try gets the slot.
    for (let round = 0; round < 6; round++) {
      expect(c.tryTake('org:b', 8)).toBe(false);
      c.release('org:a');
      const underShare = c.heldBy('org:a') < 4;
      expect(c.tryTake('org:a', 8)).toBe(underShare);
      if (c.total() < 8) expect(c.tryTake('org:b', 8)).toBe(true);
    }
    expect(c.heldBy('org:a')).toBe(4);
    expect(c.heldBy('org:b')).toBe(4);
  });

  it('many organizations: a waiting bucket is never starved', () => {
    mode('multi');
    const { c, clock } = counter();
    for (let i = 0; i < 2; i++) c.tryTake('org:a', 2);
    expect(c.tryTake('org:b', 2)).toBe(false);
    // A frees a slot and asks again at once: B is still waiting, so A,
    // which holds one, is at its share and the slot stays for B.
    c.release('org:a');
    expect(c.tryTake('org:a', 2)).toBe(false);
    clock.t += 1_000;
    expect(c.tryTake('org:b', 2)).toBe(true);
    expect(c.heldBy('org:b')).toBe(1);
  });

  it('many organizations: a bucket that stopped asking stops counting', () => {
    mode('multi');
    const { c, clock } = counter();
    c.tryTake('org:a', 2);
    c.tryTake('org:a', 2);
    expect(c.tryTake('org:b', 2)).toBe(false);
    c.release('org:a');
    clock.t += FAIR_SHARE_WAIT_MEMORY_MS + 1;
    // B gave up: A is alone again and may use the free slot.
    expect(c.tryTake('org:a', 2)).toBe(true);
  });

  it('many organizations: a caller line counts as waiting', () => {
    mode('multi');
    const { c } = counter();
    c.take('org:a');
    c.take('org:a');
    expect(c.mayTake('org:a', 4)).toBe(true);
    expect(c.mayTake('org:a', 4, ['org:b'])).toBe(false);
    expect(c.mayTake('org:b', 4, ['org:b'])).toBe(true);
  });

  it('names the bucket from the tenant context', () => {
    expect(fairShareBucket()).toBe('none');
    expect(runAsOrg('o1', () => fairShareBucket())).toBe('org:o1');
    expect(runAsAnonymous(() => fairShareBucket())).toBe('anonymous');
    expect(runAsSystem('job-claim', () => fairShareBucket())).toBe('system');
  });

  it('signed-out work counts against the organization of the item it serves', () => {
    expect(runAsAnonymous(() => runServingOrg('o2', () => fairShareBucket()))).toBe('org:o2');
    expect(runAsAnonymous(() => runServingOrg(undefined, () => fairShareBucket()))).toBe(
      'anonymous',
    );
    // A signed-in caller always counts as its own organization.
    expect(runAsOrg('o1', () => runServingOrg('o2', () => fairShareBucket()))).toBe('org:o1');
  });
});
