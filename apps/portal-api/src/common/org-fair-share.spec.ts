// SPDX-License-Identifier: AGPL-3.0-or-later
import { fairShareBucket, orgShareOf, OrgSlotCounter } from './org-fair-share.js';
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

  it('one organization keeps the whole limit', () => {
    mode('single');
    expect(orgShareOf(1)).toBe(1);
    expect(orgShareOf(8)).toBe(8);
    const c = new OrgSlotCounter();
    for (let i = 0; i < 20; i++) c.take('org:a');
    expect(c.mayTake('org:a', 2)).toBe(true);
  });

  it('many organizations: half, rounded up, at least one', () => {
    mode('multi');
    expect(orgShareOf(1)).toBe(1);
    expect(orgShareOf(2)).toBe(1);
    expect(orgShareOf(3)).toBe(2);
    expect(orgShareOf(8)).toBe(4);
  });

  it('many organizations: counts each bucket on its own', () => {
    mode('multi');
    const c = new OrgSlotCounter();
    c.take('org:a');
    expect(c.mayTake('org:a', 2)).toBe(false);
    expect(c.mayTake('org:b', 2)).toBe(true);
    c.release('org:a');
    expect(c.mayTake('org:a', 2)).toBe(true);
    expect(c.heldBy('org:a')).toBe(0);
  });

  it('names the bucket from the tenant context', () => {
    expect(fairShareBucket()).toBe('none');
    expect(runAsOrg('o1', () => fairShareBucket())).toBe('org:o1');
    expect(runAsAnonymous(() => fairShareBucket())).toBe('anonymous');
    expect(runAsSystem('job-claim', () => fairShareBucket())).toBe('system');
  });
});
